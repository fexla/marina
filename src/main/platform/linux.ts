/**
 * @file src/main/platform/linux.ts
 * @purpose Linux 平台适配器,BETA-003 (ADR-013 方案 A) 落地。
 *
 * @关键设计:
 * - lifecycleModel = 'no-persistence' — Linux 上 Marina 作为普通桌面 app,
 *   关掉最后一个窗口 = 应用退出,session 全销毁。配套阻塞 modal 在
 *   "最后窗口 + 仍有非 exited session" 时弹二次确认(ADR-013)。
 * - detectShells:读 /etc/shells,过滤伪 shell(nologin / false / halt 等)。
 *   优先级 zsh > fish > bash > 其他。
 * - buildShellLaunchParams:bash 走 --rcfile,zsh 走 ZDOTDIR,fish 走
 *   XDG_CONFIG_HOME,分别注入对应 hook 文件。
 * - getProcessCwd:readlink /proc/<pid>/cwd(对自己起的子进程,同 UID 可读)
 * - setAutoStart:写 ~/.config/autostart/marina.desktop(XDG 标准)
 * - registerFileManagerIntegration:走 freedesktop 标准 —— gsettings +
 *   update-alternatives / alternatives 双分支(Debian / RHEL 系),
 *   **不写 Nautilus 扩展**(ADR-013 明确克制)。
 *
 * @对应文档章节: 软件定义书.md 12.2 + ADR-013;BETA-003a / 003c
 */
import { execFile } from 'node:child_process';
import { promises as fs, constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { logger } from '../logger';
import type { DefaultBookmarkSeed, PlatformAdapter, ShellInfo } from './index';

const execFileAsync = promisify(execFile);

/**
 * 过滤掉的伪 shell basename。/etc/shells 里某些发行版会列入 nologin / false 等
 * 不是给人交互用的条目。
 */
const PSEUDO_SHELLS = new Set([
  'nologin',
  'false',
  'halt',
  'sync',
  'shutdown',
  'reboot',
  'poweroff',
]);

const SHELL_DISPLAY_NAMES: Record<string, string> = {
  bash: 'Bash',
  zsh: 'Zsh',
  fish: 'Fish',
  dash: 'Dash',
  ksh: 'KornShell',
  tcsh: 'TCSH',
  csh: 'C Shell',
};

/**
 * shell 排序优先级。bash 排第一 — Ubuntu / Debian / Fedora 默认装,且 OSC 1337
 * hook(bash.sh)已完整测试。zsh / fish 优先级靠后,作为可选项呈现给用户;hook
 * 文件 zsh.sh / fish.fish 已存在,但需要调用方在临时目录铺设正确的文件名
 * (.zshrc / fish/config.fish),目前 SessionManager 还没做这一步 — 后续 patch 补。
 */
function priorityOf(id: string): number {
  const map: Record<string, number> = { bash: 0, zsh: 1, fish: 2 };
  return map[id] ?? 10;
}

/**
 * POSIX shell quote — 用单引号包裹,内部 ' 用 '\''  转义。
 * 用于把命令 args 拼成 `-c "..."` 内的字符串。
 */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function shellJoin(parts: string[]): string {
  return parts.map(shellQuote).join(' ');
}

export class LinuxAdapter implements PlatformAdapter {
  /** ADR-013 方案 A:Linux 不做托盘,关最后窗口 = 退出 */
  readonly lifecycleModel = 'no-persistence' as const;

  /** XDG autostart 文件路径(单实例懒计算,homedir 不会变) */
  private readonly autostartPath = join(
    process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'),
    'autostart',
    'marina.desktop',
  );

  async detectShells(): Promise<ShellInfo[]> {
    try {
      const content = await fs.readFile('/etc/shells', 'utf8');
      const lines = content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'));

      const seen = new Set<string>();
      const results: ShellInfo[] = [];
      for (const path of lines) {
        const base = basename(path);
        if (PSEUDO_SHELLS.has(base)) continue;
        if (seen.has(base)) continue; // 同名 shell 只取第一个(/bin/bash vs /usr/bin/bash)
        try {
          await fs.access(path, fsConstants.X_OK);
        } catch {
          continue; // 不可执行,跳过
        }
        seen.add(base);
        results.push({
          id: base,
          displayName: SHELL_DISPLAY_NAMES[base] ?? base,
          executablePath: path,
        });
      }

      results.sort((a, b) => priorityOf(a.id) - priorityOf(b.id));

      if (results.length === 0) {
        // /etc/shells 存在但全是伪 shell,极罕见。兜底 /bin/bash
        return [{ id: 'bash', displayName: 'Bash', executablePath: '/bin/bash' }];
      }
      return results;
    } catch (err) {
      logger.warn('linux-adapter', 'detectShells failed, fallback to /bin/bash', err);
      return [{ id: 'bash', displayName: 'Bash', executablePath: '/bin/bash' }];
    }
  }

  resolveExecutable(commandName: string, _env: Record<string, string>): string | null {
    if (!commandName.trim()) return null;
    if (commandName.startsWith('/')) return commandName;
    return commandName;
  }

  /**
   * 给定 shell + hook 文件路径,返回 spawn 时的 args 与额外 env。
   *
   * @关键设计:
   * - bash:走 `--rcfile <hook>` 让 bash 加载我们的 hook(hook 内部 source ~/.bashrc)
   * - zsh:走 ZDOTDIR 环境变量,zsh 启动时读 ZDOTDIR/.zshrc;**调用方需保证 hookFilePath
   *   的目录里有一份命名为 .zshrc 的 hook 文件**(由 session-manager 选 zsh 时拷贝)
   * - fish:走 XDG_CONFIG_HOME 环境变量,fish 启动时读 XDG_CONFIG_HOME/fish/config.fish;
   *   **调用方需保证 hookFilePath 的目录结构是 <prefix>/fish/config.fish**
   */
  buildShellLaunchParams(
    shell: ShellInfo,
    hookFilePath: string,
    commandToRun?: { command: string; args: string[] },
  ): { args: string[]; env: Record<string, string> } {
    const env: Record<string, string> = {};
    let args: string[] = [];

    switch (shell.id) {
      case 'bash': {
        // bash 系:--rcfile 指向 hook,hook 自身 source 用户 .bashrc
        if (commandToRun) {
          const cmdLine = shellJoin([commandToRun.command, ...commandToRun.args]);
          args = ['--rcfile', hookFilePath, '-i', '-c', `${cmdLine}; exec bash -i`];
        } else {
          args = ['--rcfile', hookFilePath, '-i'];
        }
        break;
      }
      case 'zsh': {
        // zsh 读 ZDOTDIR/.zshrc;hook 文件名必须是 .zshrc
        env['ZDOTDIR'] = dirname(hookFilePath);
        if (commandToRun) {
          const cmdLine = shellJoin([commandToRun.command, ...commandToRun.args]);
          args = ['-i', '-c', `${cmdLine}; exec zsh -i`];
        } else {
          args = ['-i'];
        }
        break;
      }
      case 'fish': {
        // fish 读 XDG_CONFIG_HOME/fish/config.fish
        // 调用方需把 hook 放在 <tmpdir>/fish/config.fish,XDG_CONFIG_HOME 指 <tmpdir>
        env['XDG_CONFIG_HOME'] = dirname(dirname(hookFilePath));
        if (commandToRun) {
          const cmdLine = shellJoin([commandToRun.command, ...commandToRun.args]);
          args = ['-i', '-c', `${cmdLine}; exec fish -i`];
        } else {
          args = ['-i'];
        }
        break;
      }
      default: {
        // 未知 shell:无 hook,直接交互模式
        if (commandToRun) {
          const cmdLine = shellJoin([commandToRun.command, ...commandToRun.args]);
          args = ['-c', cmdLine];
        } else {
          args = [];
        }
      }
    }

    return { args, env };
  }

  /**
   * 注册"Marina 为系统默认终端"。走 freedesktop 标准两条腿:
   *
   * 1. gsettings:GNOME 22.04 / Cinnamon / MATE 都用此设置默认终端 exec
   *    (新版 GNOME 44+ 走 xdg-terminal-exec spec,gsettings 不再生效,
   *    但 .desktop Categories=TerminalEmulator 会被读到)
   * 2. update-alternatives / alternatives:让所有走 x-terminal-emulator 的
   *    GTK 程序找到 marina。Debian 系叫 update-alternatives,RHEL 系叫
   *    alternatives,语义一致
   *
   * 全部失败也只写 warn,不抛 —— 用户机器上没装 gsettings(纯 XFCE/i3)
   * 不阻塞 install 流程。
   */
  async registerFileManagerIntegration(_appExePath: string): Promise<void> {
    let oneSucceeded = false;
    try {
      await execFileAsync('gsettings', [
        'set',
        'org.gnome.desktop.default-applications.terminal',
        'exec',
        'marina',
      ]);
      oneSucceeded = true;
    } catch (err) {
      logger.warn(
        'linux-adapter',
        'gsettings set failed (non-GNOME / non-Cinnamon?)',
        err,
      );
    }

    try {
      await execFileAsync('update-alternatives', [
        '--set',
        'x-terminal-emulator',
        '/usr/bin/marina',
      ]);
      oneSucceeded = true;
    } catch {
      try {
        await execFileAsync('alternatives', [
          '--set',
          'x-terminal-emulator',
          '/usr/bin/marina',
        ]);
        oneSucceeded = true;
      } catch (err2) {
        logger.warn(
          'linux-adapter',
          'update-alternatives / alternatives both failed',
          err2,
        );
      }
    }

    if (!oneSucceeded) {
      logger.warn(
        'linux-adapter',
        'registerFileManagerIntegration: no mechanism succeeded (gsettings + alternatives both failed)',
      );
    }
  }

  async unregisterFileManagerIntegration(): Promise<void> {
    try {
      await execFileAsync('gsettings', [
        'reset',
        'org.gnome.desktop.default-applications.terminal',
        'exec',
      ]);
    } catch (err) {
      logger.warn('linux-adapter', 'gsettings reset failed', err);
    }
    try {
      await execFileAsync('update-alternatives', ['--auto', 'x-terminal-emulator']);
    } catch {
      try {
        await execFileAsync('alternatives', ['--auto', 'x-terminal-emulator']);
      } catch (err2) {
        logger.warn(
          'linux-adapter',
          'update-alternatives / alternatives auto-reset both failed',
          err2,
        );
      }
    }
  }

  async getProcessCwd(pid: number): Promise<string | null> {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
      // readlink /proc/<pid>/cwd 对同 UID 的子进程总是可读;
      // 进程已退出 → ENOENT;不同 UID → EACCES。
      return await fs.readlink(`/proc/${pid}/cwd`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'EACCES') {
        logger.debug('linux-adapter', `getProcessCwd(${pid}) unexpected error`, err);
      }
      return null;
    }
  }

  async setAutoStart(enabled: boolean): Promise<void> {
    if (enabled) {
      const exePath = process.execPath;
      // AppImage 跑起来后 process.execPath 指向 squashfs 内部的临时挂载;
      // 用 APPIMAGE 环境变量(AppImage runtime 注入)替代,稳定
      const realExec = process.env['APPIMAGE'] ?? exePath;
      const content =
        [
          '[Desktop Entry]',
          'Type=Application',
          'Name=Marina',
          `Exec=${realExec}`,
          'Hidden=false',
          'NoDisplay=false',
          'X-GNOME-Autostart-enabled=true',
        ].join('\n') + '\n';
      await fs.mkdir(dirname(this.autostartPath), { recursive: true });
      await fs.writeFile(this.autostartPath, content, { mode: 0o644 });
    } else {
      try {
        await fs.unlink(this.autostartPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
  }

  async isAutoStartEnabled(): Promise<boolean> {
    try {
      await fs.access(this.autostartPath, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  getRefreshedPath(): string {
    // Linux 子进程从 login shell 继承完整 env;BETA-001 描述的 Windows
    // 注册表 PATH 不广播痛点不存在,直接返回 process.env.PATH。
    return process.env['PATH'] ?? '';
  }

  normalizeSpawnEnv(env: Record<string, string>): Record<string, string> {
    // BETA-ENV-1:Linux 上 env 由 login shell / display manager 提供,
    // %SystemRoot% 这种 Win32 占位符不存在,接口纯走 no-op。
    return env;
  }

  getDefaultBookmarkSeeds(): DefaultBookmarkSeed[] {
    const home = homedir();
    return [
      { label: '桌面', path: join(home, 'Desktop') },
      { label: '主目录', path: home },
    ];
  }

  getSshControlPath(): string {
    return '~/.ssh/cm-%r@%h:%p';
  }
}
