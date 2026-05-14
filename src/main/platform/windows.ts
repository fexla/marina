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
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { PlatformAdapter, ShellInfo } from './index';

const execFileAsync = promisify(execFile);

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

function getShellCandidates(): ShellCandidate[] {
  const env = process.env;
  const programFiles = env['ProgramFiles'] ?? 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const systemRoot = env['SystemRoot'] ?? env['windir'] ?? 'C:\\Windows';
  return [
    {
      id: 'pwsh',
      displayName: 'PowerShell 7',
      paths: [
        join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
        join(programFilesX86, 'PowerShell', '7', 'pwsh.exe'),
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
        join(programFiles, 'Git', 'bin', 'bash.exe'),
        join(programFilesX86, 'Git', 'bin', 'bash.exe'),
      ],
    },
  ];
}

export class WindowsAdapter implements PlatformAdapter {
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
    return result;
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
      default: {
        // bash --rcfile <file> 让 bash 加载我们的 hook;
        // 有命令时先跑命令再 exec bash (postExitAction=keep_shell)。
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
