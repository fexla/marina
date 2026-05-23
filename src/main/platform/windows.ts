/**
 * @file src/main/platform/windows.ts
 * @purpose Windows 平台适配器实现。V1 唯一完整实现的平台。
 *
 * @关键设计:
 * - detectShells: 探测 pwsh.exe (PowerShell 7+) > powershell.exe (Windows PowerShell 5.1)
 *   > cmd.exe > Git Bash。优先级靠前的同名 shell 排在结果数组靠前
 * - buildShellLaunchParams: 给定 shell + hook 文件路径,返回 spawn 时的
 *   args 与 env,把 OSC 1337 cwd 报告 hook 注入到 shell 启动流程
 *   - PowerShell 系: 用 -NoExit -NoLogo -Command ". 'hook.ps1'"
 *   - cmd.exe: 通过 PROMPT 环境变量内嵌 OSC 1337 序列
 *   - Git Bash: 用 --rcfile bash.sh 启动
 * - getProcessCwd: NTAPI NtQueryInformationProcess 路线需要 ffi-napi
 *   原生模块,目前不依赖原生 deps (AGENTS.md 1.2 边界 2),返回 null。
 *   OSC 1337 hook 是 V1 唯一可靠的 cwd 跟踪机制
 * - Explorer 右键集成: V1.2 启用,V1 留 stub
 * - 开机启动: app.setLoginItemSettings (CP-4 接入)
 *
 * @对应文档章节: 软件定义书.md 5.1.8、12.2、ADR-003、ADR-008
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { logger } from '../logger';
import type { DefaultBookmarkSeed, PlatformAdapter, ShellInfo } from './index';
import {
  expandWindowsEnvPlaceholders,
  normalizeWindowsSpawnEnv,
} from './windows-env';

const execFileAsync = promisify(execFile);

/**
 * 解析 reg query 的输出,提取 Path 值。
 *
 * reg query 标准输出形如:
 *   <空行>
 *   HKEY_CURRENT_USER\Environment
 *       Path    REG_EXPAND_SZ    C:\foo;C:\bar
 *
 * 字段类型可能是 REG_SZ / REG_EXPAND_SZ;\t 分隔。
 */
function parseRegPathOutput(stdout: string): string | null {
  const match = stdout.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.+?)(?:\r?\n|$)/);
  return match?.[1]?.trim() || null;
}

/**
 * Explorer 右键集成的注册表 key 列表(HKCU 用户级,无需 admin)。
 * Directory\shell  = 右键文件夹本身; %1 = 被点击文件夹的全路径
 * Directory\Background\shell = 右键文件夹空白处; %V = 当前打开的目录全路径
 *
 * 选用 Marina 这个固定 key 名(不带版本/平台后缀);设置开关 off 时 unregister 同名 key。
 * 改名前 EasyTerm 时代的旧 key 在 main/index.ts 启动期单独清理。
 */
const EXPLORER_INTEGRATION_KEYS = [
  { hive: 'HKCU\\Software\\Classes\\Directory\\shell\\Marina', argToken: '%1' },
  { hive: 'HKCU\\Software\\Classes\\Directory\\Background\\shell\\Marina', argToken: '%V' },
] as const;

const EXPLORER_INTEGRATION_MENU_TEXT = '在 Marina 终端中打开';

/**
 * 旧 EasyTerm 注册表 key (v1.5 改名前可能残留)。
 * 启动期静默 unregister 一次,避免用户看到两条菜单项。
 */
export const LEGACY_EXPLORER_INTEGRATION_KEYS = [
  'HKCU\\Software\\Classes\\Directory\\shell\\EasyTerm',
  'HKCU\\Software\\Classes\\Directory\\Background\\shell\\EasyTerm',
] as const;

/**
 * 候选 shell 路径列表。同 id 的多个候选按数组顺序探测,首次命中即用。
 *
 * 这些路径覆盖 Windows 默认安装位置 + PATH 兜底。Pwsh 7 优先于 Win PS 5.1。
 */
interface ShellCandidate {
  id: string;
  displayName: string;
  paths: string[];
}

interface WslShellIdParts {
  /** 是否 WSL shell id (wsl 或 wsl:<distro>) */
  isWsl: boolean;
  /** 可选发行版名 */
  distro?: string;
}

function getShellCandidates(): ShellCandidate[] {
  const env = process.env;
  const programFiles = uniqueStrings([
    'C:\\Program Files',
    env['ProgramFiles'],
  ]);
  const programFilesX86 = uniqueStrings([
    'C:\\Program Files (x86)',
    env['ProgramFiles(x86)'],
  ]);
  const systemRoot = env['SystemRoot'] ?? env['windir'] ?? 'C:\\Windows';
  return [
    {
      id: 'pwsh',
      displayName: 'PowerShell 7',
      paths: [
        ...programFiles.map((root) => join(root, 'PowerShell', '7', 'pwsh.exe')),
        ...programFilesX86.map((root) => join(root, 'PowerShell', '7', 'pwsh.exe')),
        // PATH 兜底:用纯文件名让 spawn 走 PATH 解析。
        // existsSync 对纯文件名总是 false,所以这条只在前面所有绝对路径都
        // 不存在时,才作为 ShellInfo.executablePath 返回 (但下面 detectShells
        // 会跳过 existsSync 失败的纯文件名,改为只接受能实测命中的路径)。
      ],
    },
    {
      id: 'powershell',
      displayName: 'Windows PowerShell',
      paths: [
        join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        join(systemRoot, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ],
    },
    {
      id: 'cmd',
      displayName: 'Command Prompt',
      paths: [join(systemRoot, 'System32', 'cmd.exe')],
    },
    {
      id: 'git-bash',
      displayName: 'Git Bash',
      paths: [
        ...programFiles.map((root) => join(root, 'Git', 'bin', 'bash.exe')),
        ...programFilesX86.map((root) => join(root, 'Git', 'bin', 'bash.exe')),
      ],
    },
    {
      // WSL 可执行入口。Windows 10/11 默认位于 System32。
      id: 'wsl',
      displayName: 'WSL',
      paths: [join(systemRoot, 'System32', 'wsl.exe')],
    },
  ];
}

/**
 * 仅供测试:读取当前 Windows shell 候选清单。
 * 生产代码不要依赖此函数。
 */
export function __getShellCandidatesForTest(): Array<{
  id: string;
  displayName: string;
  paths: string[];
}> {
  return getShellCandidates().map((item) => ({
    id: item.id,
    displayName: item.displayName,
    paths: [...item.paths],
  }));
}

export class WindowsAdapter implements PlatformAdapter {
  /** 软件定义书 12.2 (v1.6) — Windows 走托盘心智 */
  readonly lifecycleModel = 'tray-resident' as const;

  /**
   * 探测系统中可用的 shell。
   *
   * 实现是同步 fs.existsSync — 对几个固定路径做存在性检查,远比 child_process
   * spawn 检测便宜,且本方法启动期只调一次。
   */
  async detectShells(): Promise<ShellInfo[]> {
    const result: ShellInfo[] = [];
    for (const candidate of getShellCandidates()) {
      for (const p of candidate.paths) {
        if (existsSync(p)) {
          result.push({
            id: candidate.id,
            displayName: candidate.displayName,
            executablePath: p,
          });
          break; // 同 id 只取第一个命中的路径
        }
      }
    }
    // WSL:若可执行存在,进一步枚举发行版,让用户在 shell 列表中显式选择目标 distro。
    // 若枚举到至少 1 个 distro,移除通用 "WSL" 条目,避免 UI 出现重复/歧义入口。
    // 只有枚举失败或结果为空时才保留通用 "WSL" 作为兜底入口(默认发行版)。
    const wslBase = result.find((s) => s.id === 'wsl');
    if (wslBase) {
      try {
        const distros = await listWslDistrosImpl();
        if (distros.length > 0) {
          const baseIndex = result.findIndex((s) => s.id === 'wsl');
          if (baseIndex >= 0) result.splice(baseIndex, 1);
          for (const distro of distros) {
            result.push({
              id: `wsl:${distro}`,
              displayName: `WSL (${distro})`,
              executablePath: wslBase.executablePath,
            });
          }
        }
      } catch (err) {
        logger.warn(
          'WindowsAdapter',
          'WSL distro enumeration failed; fallback to default distro only',
          err,
        );
      }
    }
    return result;
  }

  /**
   * 解析 Windows 可执行文件路径。
   *
   * 为什么不直接把 "ssh" 交给 node-pty:
   * - 远程 session 需要直接 spawn ssh.exe,不经过 cmd / PowerShell shell 搜索。
   * - 用户机器上的 PATH 可能来自 REG_EXPAND_SZ,含 `%SystemRoot%` 占位符;
   *   Marina 已在 spawn env 里规整,这里复用规整后的 env 做搜索。
   * - OpenSSH 是 Windows 10/11 的系统组件,标准位置在
   *   `%SystemRoot%\System32\OpenSSH\ssh.exe`;显式优先检查这个位置能绕开
   *   node-pty / CreateProcess 对 PATH casing 的差异。
   */
  resolveExecutable(commandName: string, env: Record<string, string>): string | null {
    if (!commandName.trim()) return null;
    if (isAbsolute(commandName) || /[\\/]/.test(commandName)) {
      return existsSync(commandName) ? commandName : null;
    }

    const pathExt = getEnvCaseInsensitive(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD';
    const extensions = pathExt
      .split(';')
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean);
    const baseNames = /\.[^.\\/]+$/.test(commandName)
      ? [commandName]
      : extensions.map((ext) => `${commandName}${ext}`);

    const systemRoot = getEnvCaseInsensitive(env, 'SystemRoot') || 'C:\\Windows';
    const searchDirs = uniqueStrings([
      join(systemRoot, 'System32', 'OpenSSH'),
      join(systemRoot, 'System32'),
      ...(getEnvCaseInsensitive(env, 'PATH') || '')
        .split(delimiter)
        .map((part) => part.trim())
        .filter(Boolean),
    ]);

    for (const dir of searchDirs) {
      for (const base of baseNames) {
        const candidate = join(dir, base);
        if (existsSync(candidate)) return candidate;
      }
    }

    return null;
  }

  /**
   * 根据 shell 类型构造启动参数与环境变量,用于注入 OSC 1337 hook。
   *
   * @param shell 由 detectShells 返回的 shell 信息
   * @param hookFilePath OSC 1337 hook 脚本绝对路径 (pwsh.ps1 / cmd.bat / bash.sh)
   *
   * 关键设计:
   * - PowerShell 系用 -NoLogo + -NoExit + 单次 dot-source,避免重复 banner
   *   (CP-2 errata 见过 "Windows PowerShell" 横幅出现 8 次的现象)
   * - cmd.exe 通过 PROMPT 环境变量内嵌 OSC,无需外部 hook 文件
   *   $E = ESC, $P = cwd, $G = '>'。最终 PROMPT:
   *   `$E]1337;CurrentDir=$P$E\\$P$G` → `\x1b]1337;CurrentDir=<cwd>\x1b\\<cwd>>`
   *   (用 ESC \\ 即 ST 而非 BEL 终止 OSC,Windows 控制台对此更宽容)
   * - bash 系用 --rcfile,该文件先 source 用户原 ~/.bashrc 再 install hook
   */
  buildShellLaunchParams(
    shell: ShellInfo,
    hookFilePath: string,
    commandToRun?: { command: string; args: string[] },
  ): { args: string[]; env: Record<string, string> } {
    switch (shell.id) {
      case 'pwsh':
      case 'powershell': {
        // 关键:**不要用 -NoLogo** — 用户报告砍掉 banner 影响原生感受 (cp3 勘误 #1)。
        // 让 PowerShell 自然出 "Windows PowerShell\n版权..." 横幅,跟原生体验一致。
        //
        // -NoExit: hook + command 跑完后保持交互 (postExitAction=keep_shell)
        // -Command: dot-source hook 文件,可选追加用户 command
        // 单次 dot-source 是关键:CP-2 errata #2 报告的 banner 重复 8 次 是因为
        // 历史代码用了 `-NoExit -Command "..." -NoExit -Command "..."` 链式注入。
        // 现在只 -Command 一次,banner 只会出现一次 (PowerShell 标准行为)。
        // 转义路径:PowerShell 单引号内只有 ' 需要转义为 ''
        const escapedHook = hookFilePath.replace(/'/g, "''");
        let scriptBlock = `. '${escapedHook}'`;
        if (commandToRun) {
          // 用 & 调用,自动按 token 切分,避免和 hook 命令冲突
          // 命令本身用单引号 (假设无单引号);args 也单引号包
          const cmd = quotePwshSingle(commandToRun.command);
          const a = commandToRun.args.map(quotePwshSingle).join(' ');
          scriptBlock += `; & ${cmd}${a ? ' ' + a : ''}`;
        }
        return {
          args: ['-NoExit', '-Command', scriptBlock],
          env: {},
        };
      }
      case 'cmd': {
        // cmd.exe 没有 prompt function,用 PROMPT 环境变量内嵌 OSC 1337。
        // ESC \\ (即 1B 5C) 是 ST (String Terminator),OSC 序列的标准结尾;
        // BEL (07) 也行但部分 Windows 解析器更喜欢 ST。
        const PROMPT = '$E]1337;CurrentDir=$P$E\\$P$G ';
        const env: Record<string, string> = {
          PROMPT,
          EASYTERM_HOOK: hookFilePath,
        };
        if (commandToRun) {
          // /K 让 cmd 跑完命令后保持开启;命令直接用引号包
          const quoted = [commandToRun.command, ...commandToRun.args]
            .map(quoteCmd)
            .join(' ');
          return { args: ['/K', quoted], env };
        }
        return { args: [], env };
      }
      case 'git-bash':
      case 'wsl':
      default: {
        // bash --rcfile <file> 让 bash 加载我们的 hook;
        // 有命令时先跑命令再 exec bash (postExitAction=keep_shell)。
        const wsl = parseWslShellId(shell.id);
        if (wsl.isWsl) {
          // WSL 模板必须经由用户默认 shell 的交互启动路径。
          //
          // 不能直接 `wsl.exe -e sh -lc <cmd>`:sh 是非交互 shell,不会加载
          // ~/.bashrc / ~/.zshrc / nvm 等用户 PATH 初始化。Claude/Codex/OpenCode
          // 常装在这些初始化脚本追加的目录里,结果就会误报 command not found。
          //
          // 这里让 WSL 先用发行版默认 shell 解析 `exec "$SHELL" -i -c ...`,
          // 由用户默认交互 shell 加载 rc 文件后再执行模板命令。
          const distroArgs = wsl.distro ? ['-d', wsl.distro] : [];
          if (commandToRun) {
            const cmdLine = [commandToRun.command, ...commandToRun.args]
              .map(quoteBash)
              .join(' ');
            return {
              args: [...distroArgs, '--exec', 'sh', '-lc', buildWslInteractiveCommand(cmdLine)],
              env: {},
            };
          }
          return {
            args: distroArgs,
            env: {},
          };
        }
        if (commandToRun) {
          const cmdLine = [commandToRun.command, ...commandToRun.args]
            .map(quoteBash)
            .join(' ');
          return {
            args: [
              '--rcfile',
              hookFilePath,
              '-i',
              '-c',
              `${cmdLine}; exec bash -i`,
            ],
            env: {},
          };
        }
        return {
          args: ['--rcfile', hookFilePath, '-i'],
          env: {},
        };
      }
    }
  }

  /**
   * 注册 Explorer 右键菜单"在 Marina 终端中打开"。
   *
   * 写 HKCU(用户级,无需提升权限)下 3 类键值,共 6 条 reg add:
   *   Directory\shell\Marina            (default) = 菜单文案
   *   Directory\shell\Marina            Icon       = "<exe>,0"      ← ICN-3
   *   Directory\shell\Marina\command    (default) = "<exe>" --open-here "%1"
   *   Directory\Background\shell\Marina (default) = 菜单文案
   *   Directory\Background\shell\Marina Icon       = "<exe>,0"      ← ICN-3
   *   Directory\Background\shell\Marina\command   = "<exe>" --open-here "%V"
   *
   * Icon 字段引用 exe 内嵌图标资源 ",0"(electron-builder 已经把 build/icon.ico
   * 嵌进 Marina.exe)。Explorer 显示经典右键菜单时会在条目左侧渲染该图标,
   * 与 Win11 新菜单(MSIX 的 menu-icon.ico)观感一致。
   *
   * 调 reg.exe 走 execFile(数组参数),由 Node 处理 Windows quoting,避免
   * cmd.exe 注入风险。每次 register 前先 unregister 一次,清掉可能残留的
   * 旧 command(例如 exe 路径变了)。
   */
  async registerFileManagerIntegration(appExePath: string): Promise<void> {
    // 先清一遍,确保不会因为旧 command 字段(路径变化)导致脏数据
    await this.unregisterFileManagerIntegration();

    // exe 内嵌图标资源引用:",0" = 第一个 ICON resource(electron-builder
    // 把 build/icon.ico 编入 PE 资源段),Explorer 自动按需缩放到 16×16。
    const iconValue = `${appExePath},0`;

    for (const { hive, argToken } of EXPLORER_INTEGRATION_KEYS) {
      // 菜单文案写到根 key 的默认值
      await runReg([
        'add',
        hive,
        '/ve',
        '/d',
        EXPLORER_INTEGRATION_MENU_TEXT,
        '/f',
      ]);
      // Icon 值 — Explorer 经典菜单条目左侧图标
      await runReg([
        'add',
        hive,
        '/v',
        'Icon',
        '/d',
        iconValue,
        '/f',
      ]);
      // command 子 key 的默认值 = `"<exe>" --open-here "<%1|%V>"`
      // 注意:reg.exe 接受的 /d 值字符串里的双引号会原样存入注册表,
      // execFile 数组参数让 Node 在调用 CreateProcess 时给整段加外层引号。
      const commandValue = `"${appExePath}" --open-here "${argToken}"`;
      await runReg([
        'add',
        `${hive}\\command`,
        '/ve',
        '/d',
        commandValue,
        '/f',
      ]);
    }
  }

  /**
   * 启动期清理改名前(EasyTerm)残留的右键菜单注册表项。
   * 静默失败(不存在视为成功),失败也只是日志,不阻塞启动。
   * v1.5 改名后保留一两个版本周期即可移除该方法。
   */
  async cleanupLegacyExplorerIntegration(): Promise<void> {
    for (const hive of LEGACY_EXPLORER_INTEGRATION_KEYS) {
      await runReg(['delete', hive, '/f'], { allowNotFound: true });
    }
  }

  /**
   * 删除 Explorer 右键集成注册表项。
   *
   * 不存在(reg.exe exit code 1)视为成功 — 反复 unregister 不应抛错。
   * 其他错误向上抛,由调用方决定是 warn 还是 toast。
   */
  async unregisterFileManagerIntegration(): Promise<void> {
    for (const { hive } of EXPLORER_INTEGRATION_KEYS) {
      await runReg(['delete', hive, '/f'], { allowNotFound: true });
    }
  }

  /**
   * 仅在 HKCU 已经存在 Marina 经典右键菜单 key 时,把 command 字段刷成当前 exe 路径。
   *
   * 启动期幂等修复:用户卸载后重装、installer 把 Marina 装到新路径,旧 command
   * 仍指向已删 exe → Explorer 右键弹"unable to find electron app at ...";我们
   * 静默改 command 字段为当前 exe 即可。
   *
   * 与 registerFileManagerIntegration 的区别:这里不创建 key,只修复已存在的 key。
   * 不存在 key = 用户没启用过 / 已主动关闭,不应被启动自动重新写回。
   */
  async syncFileManagerIntegrationIfPresent(appExePath: string): Promise<void> {
    const iconValue = `${appExePath},0`;
    for (const { hive, argToken } of EXPLORER_INTEGRATION_KEYS) {
      // reg query 不存在的 key:code=1 → runReg 抛错。捕获后跳过该 hive。
      let exists = true;
      try {
        await runReg(['query', hive]);
      } catch {
        exists = false;
      }
      if (!exists) continue;
      const commandValue = `"${appExePath}" --open-here "${argToken}"`;
      await runReg([
        'add',
        `${hive}\\command`,
        '/ve',
        '/d',
        commandValue,
        '/f',
      ]);
      // ICN-3 backfill:老用户(register 时还没写 Icon)启动期补上。
      await runReg([
        'add',
        hive,
        '/v',
        'Icon',
        '/d',
        iconValue,
        '/f',
      ]);
    }
  }

  /**
   * 现场查 HKCU 经典菜单是否已注册。两个 hive 都存在才算 enabled。
   */
  async isFileManagerIntegrationEnabled(): Promise<boolean> {
    for (const { hive } of EXPLORER_INTEGRATION_KEYS) {
      try {
        await runReg(['query', hive]);
      } catch {
        return false;
      }
    }
    return true;
  }

  /**
   * 查询进程 cwd 的兜底接口。
   *
   * Windows 上唯一可靠的方式是 NtQueryInformationProcess + 读 PEB 的
   * ProcessParameters.CurrentDirectory.DosPath。这要求:
   *   (1) 通过 ffi-napi (heavy native dep) 调 ntdll.dll
   *   (2) 或自己写 .node 原生扩展
   * 都需要新增依赖 (AGENTS.md 1.2 边界 2 禁止未询问就引入新包),且实测
   * NtQueryInformationProcess 在跨权限边界读 PEB 时失败率不低。
   *
   * V1 的取舍:**OSC 1337 hook 是唯一可靠机制**。本函数始终返回 null,
   * SessionManager 在 5 秒兜底轮询时会得到 null → 仅记录 warn 而不更新
   * currentCwd。这意味着 hook 注入失败的 session 无法在 UI 上跟踪 cd。
   * 用户可见现象:tab 上不出现 ⚠️,但 path 归属不变(ADR-008 解耦后无害)。
   *
   * 留接口为未来加入原生绑定铺路。
   */
  async getProcessCwd(_pid: number): Promise<string | null> {
    return null;
  }

  /**
   * 开机启动 — 用 Electron 的 setLoginItemSettings,Windows 上等价于
   * 写 HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run
   * 一个名为应用 productName 的 REG_SZ 项。
   *
   * args 里加 --hidden,让随系统启动的进程进入"纯托盘模式"
   * (软件定义书 7.4.2 + behavior.startupBehavior=tray-only 场景)。
   * 实际是否直接进托盘由 settings.behavior.startupBehavior 决定,这里
   * 只负责注册到 Run 表;如果 startupBehavior=open-window,启动后会自动
   * 创建第一个窗口。
   */
  async setAutoStart(enabled: boolean): Promise<void> {
    const { app } = await import('electron');
    app.setLoginItemSettings({
      openAtLogin: enabled,
      args: ['--auto-start'],
    });
  }

  async isAutoStartEnabled(): Promise<boolean> {
    const { app } = await import('electron');
    return app.getLoginItemSettings().openAtLogin;
  }

  /**
   * BETA-001:每次 spawn 前从注册表重读最新 PATH。
   *
   * Windows 安装新软件向 HKLM/HKCU\Environment\Path 写新值,会发 WM_SETTINGCHANGE
   * 广播,但 Node 进程不响应该消息,process.env.PATH 仍是启动时的快照。直接 reg
   * query 两个 hive 拿最新值,按 Windows 系统 PATH 解析顺序合并(HKLM 在前,
   * HKCU 在后)。
   *
   * BETA-ENV-1:HKLM\…\Environment 下的 Path 在注册表里类型是 REG_EXPAND_SZ,
   *   原值含 `%SystemRoot%\System32` 等占位符;reg.exe query 拿到的是字面字符
   *   串,**没有展开**。直接塞进子进程 env 会导致所有 system32 系命令(powershell /
   *   cmd / reg / wmic / tasklist / ssh 等)从 PATH 上消失。本方法返回前调
   *   `expandWindowsEnvPlaceholders` 展开,name 大小写不敏感、未命中保留原样。
   *
   * 失败回退 process.env.PATH(不阻塞 spawn),写 log.warn 留痕。
   *
   * 用 execFileSync 是因为本方法在每次 spawn 前同步调用,异步化的传染面太大。
   * 实测一次 reg query 在 Windows 11 上 ~10-30ms,两次合并 < 60ms,在用户感
   * 知阈值内(软件定义书 V1 性能底线第 2 条:< 1s)。
   */
  getRefreshedPath(): string {
    const fallback = process.env.PATH ?? '';
    try {
      const hklm = readRegistryPath(
        'HKLM\\System\\CurrentControlSet\\Control\\Session Manager\\Environment',
        { onError: (e) => logger.warn('WindowsAdapter', 'reg query HKLM Path failed', e) },
      );
      const hkcu = readRegistryPath('HKCU\\Environment', {
        // HKCU\Environment\Path 在干净系统上可能不存在,正常现象
        onError: (e) => logger.debug('WindowsAdapter', 'reg query HKCU Path miss', e),
      });

      const parts = [hklm, hkcu].filter((s): s is string => !!s);
      if (parts.length === 0) {
        logger.warn(
          'WindowsAdapter',
          'getRefreshedPath: both hives empty, fallback to process.env.PATH',
        );
        return fallback;
      }
      const merged = parts.join(';');
      // BETA-ENV-1:展开 %SystemRoot% 等占位符 — 用 process.env 做查找源,
      // 这是当前进程实际可见的 env(已含 Windows 自动展开的 SystemRoot 等)。
      // 即便这一步遗漏,session-manager 还会过 normalizeSpawnEnv 第二道防线。
      const expanded = expandWindowsEnvPlaceholders(
        merged,
        process.env as Record<string, string>,
      );
      return expanded;
    } catch (e) {
      logger.warn(
        'WindowsAdapter',
        'getRefreshedPath fatal, fallback to process.env.PATH',
        e,
      );
      return fallback;
    }
  }

  /**
   * BETA-ENV-1 兜底层:spawn 前对完整 env 字典做规整。
   *
   * 逻辑见 src/main/platform/windows-env.ts 的 normalizeWindowsSpawnEnv 文件头。
   * 残留占位符通过 logger.warn 上报,但不阻塞 spawn(尽量让用户能跑起来再说)。
   */
  normalizeSpawnEnv(env: Record<string, string>): Record<string, string> {
    return normalizeWindowsSpawnEnv(env, {
      onWarn: (message) => logger.warn('WindowsAdapter', message),
    });
  }

  /**
   * Windows 上干净安装时种入收藏栏的默认条目:
   * - 桌面(%USERPROFILE%\Desktop)
   * - 主目录(%USERPROFILE%)
   *
   * 历史上还含临时目录,2026-05-16 移除独立"系统"分组的同时去掉 — 临时目录
   * 日常打开终端的频次不足以占用一个默认收藏槽位。USERPROFILE 兜底用
   * homedir(),Windows 上正常存在。
   */
  getDefaultBookmarkSeeds(): DefaultBookmarkSeed[] {
    const userProfile = process.env.USERPROFILE || homedir();
    return [
      { label: '桌面', path: join(userProfile, 'Desktop') },
      { label: '主目录', path: userProfile },
    ];
  }
}

/**
 * PowerShell 单引号 quoting: 'foo' → 'foo';带 ' 的字符串内 ' 转义为 ''。
 * 命令含空格也用单引号统一包,无需考虑 PowerShell 解析逻辑。
 */
function quotePwshSingle(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * cmd.exe quoting: 用 " 包,内部 " 用 ^ 转义。
 * cmd quoting 名声很差 (命令注入风险),用户 template 是受控数据,先用最简版。
 */
function quoteCmd(s: string): string {
  if (!/[\s"&|<>^]/.test(s)) return s;
  return `"${s.replace(/"/g, '^"')}"`;
}

/**
 * bash quoting: 单引号包,内部 ' → '\\''。
 */
function quoteBash(s: string): string {
  if (!/[\s"'$`\\&|<>()*?#!]/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function getEnvCaseInsensitive(
  env: Record<string, string>,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === wanted && value) return value;
  }
  return undefined;
}

/**
 * 解析 shell id 是否为 WSL 目标。
 *
 * 支持:
 * - wsl            -> 默认发行版
 * - wsl:Ubuntu-24.04 -> 指定发行版
 */
function parseWslShellId(id: string): WslShellIdParts {
  if (id === 'wsl') return { isWsl: true };
  if (id.startsWith('wsl:') && id.length > 4) {
    return { isWsl: true, distro: id.slice(4) };
  }
  return { isWsl: false };
}

function buildWslInteractiveCommand(cmdLine: string): string {
  return `exec "\${SHELL:-/bin/sh}" -i -c ${quoteBash(cmdLine)}`;
}

/**
 * 列举 WSL 发行版名。
 *
 * 来源: `wsl.exe -l -q` 的逐行输出。过滤空行和 docker-desktop 内部发行版。
 * 保持输出顺序,但做大小写去重。
 */
let listWslDistrosImpl: () => Promise<string[]> = defaultListWslDistros;

async function defaultListWslDistros(): Promise<string[]> {
  const systemRoot = process.env['SystemRoot'] ?? process.env['windir'] ?? 'C:\\Windows';
  const wslExe = join(systemRoot, 'System32', 'wsl.exe');
  const { stdout } = await execFileAsync(wslExe, ['-l', '-q'], {
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    encoding: 'buffer',
  });
  return parseWslDistroListOutput(stdout);
}

/**
 * 解析 `wsl -l -q` 输出为发行版列表。
 *
 * WSL 在 Windows 上可能输出 UTF-16LE(常见)或 UTF-8。这里按字节特征自动判定:
 * - 若包含大量 NUL 字节,按 UTF-16LE 解码
 * - 否则按 UTF-8 解码
 */
function parseWslDistroListOutput(stdout: Buffer): string[] {
  const text = decodePossiblyUtf16Le(stdout);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const name = rawLine.trim();
    if (!name) continue;
    const normalized = name.toLowerCase();
    if (normalized === 'docker-desktop' || normalized === 'docker-desktop-data') continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(name);
  }
  return result;
}

function decodePossiblyUtf16Le(input: Buffer): string {
  // UTF-16LE 文本里偶数字节位置常出现大量 0x00。
  const sample = input.subarray(0, Math.min(input.length, 2048));
  let nulCount = 0;
  for (const b of sample) {
    if (b === 0) nulCount++;
  }
  const looksUtf16Le = sample.length > 0 && nulCount / sample.length > 0.15;
  const text = looksUtf16Le ? input.toString('utf16le') : input.toString('utf8');
  // 去除可能的 BOM 与残留 NUL
  return text.replace(/^\uFEFF/, '').replace(/\u0000/g, '');
}

/**
 * 调 reg.exe,等待退出。
 *
 * 测试 hook:由 `__setRunRegImpl` 注入 mock,生产代码总是真实 execFile。
 *
 * @param args reg.exe 参数数组,Node 自己处理 Windows quoting
 * @param options.allowNotFound true 时把 reg.exe exit code 1(key 不存在)
 *   视为成功 — unregister 时反复调用不该抛错
 */
let runRegImpl: (args: string[]) => Promise<{ stderr: string; code: number }> =
  defaultRunReg;

async function defaultRunReg(
  args: string[],
): Promise<{ stderr: string; code: number }> {
  try {
    const { stderr } = await execFileAsync('reg', args, {
      windowsHide: true,
      // reg.exe 输出很短,1MB buffer 远远够
      maxBuffer: 1024 * 1024,
    });
    return { stderr, code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: number; stderr?: string };
    return {
      stderr: e.stderr ?? e.message,
      code: typeof e.code === 'number' ? e.code : -1,
    };
  }
}

async function runReg(
  args: string[],
  options: { allowNotFound?: boolean } = {},
): Promise<void> {
  const { stderr, code } = await runRegImpl(args);
  if (code === 0) return;
  // reg.exe delete 不存在的 key:code=1 + stderr 含 "找不到" / "cannot find"
  if (options.allowNotFound && code === 1) return;
  throw new Error(
    `[WindowsAdapter] reg.exe ${args.join(' ')} exited code=${code} stderr=${stderr.trim()}`,
  );
}

/**
 * 仅供测试用,生产代码不调。
 * 传 null 恢复真实 execFile 实现。
 */
export function __setRunRegImplForTest(
  impl: ((args: string[]) => Promise<{ stderr: string; code: number }>) | null,
): void {
  runRegImpl = impl ?? defaultRunReg;
}

/**
 * 同步 `reg query <hive> /v Path` 并解析出 Path 值。
 *
 * 抽出独立函数主要为可测性 —— `getRefreshedPath` 真的去 spawn reg.exe 在单测里
 * 不仅慢、还把测试和宿主机的 PATH 耦合在一起。`__setReadRegistryPathImplForTest`
 * 注入 mock 后,可断言 BETA-ENV-1 的占位符展开链路。
 */
let readRegistryPathImpl: (hive: string) => string | null = defaultReadRegistryPath;

function defaultReadRegistryPath(hive: string): string | null {
  const out = execFileSync('reg.exe', ['query', hive, '/v', 'Path'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 2000,
  });
  return parseRegPathOutput(out);
}

function readRegistryPath(
  hive: string,
  options: { onError?: (err: unknown) => void } = {},
): string | null {
  try {
    return readRegistryPathImpl(hive);
  } catch (e) {
    options.onError?.(e);
    return null;
  }
}

/**
 * 仅供测试用,生产代码不调。
 * 传 null 恢复真实 reg.exe 调用。
 */
export function __setReadRegistryPathImplForTest(
  impl: ((hive: string) => string | null) | null,
): void {
  readRegistryPathImpl = impl ?? defaultReadRegistryPath;
}

/**
 * 仅供测试用:注入 WSL 发行版枚举实现。
 * 传 null 恢复真实 `wsl.exe -l -q` 调用。
 */
export function __setListWslDistrosImplForTest(
  impl: (() => Promise<string[]>) | null,
): void {
  listWslDistrosImpl = impl ?? defaultListWslDistros;
}

/**
 * 仅供测试用:解析 wsl -l -q 原始输出。
 */
export function __parseWslDistroListOutputForTest(stdout: Buffer): string[] {
  return parseWslDistroListOutput(stdout);
}
