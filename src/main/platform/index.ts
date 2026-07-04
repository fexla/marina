/**
 * @file src/main/platform/index.ts
 * @purpose 平台适配层接口定义 + 平台分发。所有平台特定 API 必须通过此处
 *   暴露的 PlatformAdapter 接口调用,核心代码不允许写 process.platform 判断。
 *
 * @关键设计:
 * - V1 只完整实现 Windows,macOS / Linux 抛 "Not implemented",留给社区
 *   贡献 (软件定义书 12.1、12.2)
 * - 接口故意小,每个方法对应一个具体的系统能力,便于 mock 测试
 * - 用 top-level import 而非动态 require:整个项目是 ESM,
 *   require() 在 ESM 模块里不可用
 *
 * @对应文档章节: 软件定义书.md 第 12 章 (跨平台策略);AGENTS.md 第 8 章
 *
 * @AGENTS.md 8.1: V1 只测 Windows,但代码必须 platform-aware。
 *   不许在 windows.ts 之外的地方写 process.platform === 'win32' 判断。
 */
import { WindowsAdapter } from './windows';
import { LinuxAdapter } from './linux';

/**
 * 一个被检测到的 shell 的元数据。
 */
export interface ShellInfo {
  /** 内部 id,如 'pwsh' / 'powershell' / 'cmd' */
  id: string;
  /** 显示名,如 'PowerShell 7' / 'Windows PowerShell' / 'Command Prompt' */
  displayName: string;
  /** 可执行文件绝对路径 */
  executablePath: string;
}

/**
 * 平台适配器接口 (软件定义书 12.2)。
 * Windows / Linux 现已实现;macOS 仍占位。
 */
export interface PlatformAdapter {
  /**
   * 平台生命周期模型 (软件定义书 12.2 v1.6,ADR-013)。
   *
   * - 'tray-resident' (Windows):关掉所有窗口后,app 仍跑在系统托盘,
   *   session 由托盘里的主进程持有。完全退出走托盘菜单"完全退出"按钮
   *   (带二次确认 modal)。
   * - 'dock-resident' (macOS):关掉所有窗口后,app 仍在 Dock
   *   (Electron `window-all-closed` darwin 分支默认不退出 = macOS HIG)。
   *   完全退出走 Cmd+Q / App Menu Quit (带二次确认 modal)。
   * - 'no-persistence' (Linux):无托盘 / 无 Dock,关掉最后一个窗口 = 应用退出。
   *   当最后一个窗口关闭且仍有 state !== 'exited' 的 session 时,弹同一 modal
   *   二次确认;全 exited 则静默退出。
   *
   * 三平台共享同一个 <LastSessionConfirm /> 组件,仅触发位置不同。
   */
  readonly lifecycleModel: 'tray-resident' | 'dock-resident' | 'no-persistence';

  /** 检测系统中可用的 shell */
  detectShells(): Promise<ShellInfo[]>;

  /**
   * 解析一个命令名对应的可执行文件路径。
   *
   * 主要服务于 SSH 这类"不是登录 shell,但需要由 PTY 直接 spawn"的本机工具。
   * Windows 上 CreateProcess / node-pty 对 PATH、PATHEXT 和 SystemRoot casing
   * 很敏感,由平台层统一解析能避免核心 SessionManager 写平台分支。
   *
   * @param commandName 命令名或路径,如 "ssh" / "ssh.exe" / "/usr/bin/ssh"
   * @param env 即将传给 spawn 的环境变量;平台层可用它读取 PATH / PATHEXT
   * @returns 可直接传给 node-pty spawn 的路径;找不到时返回 null
   */
  resolveExecutable(commandName: string, env: Record<string, string>): string | null;

  /**
   * 给定一个 shell,返回启动它时注入 OSC 1337 hook 所需的额外参数和环境变量。
   *
   * 当 `commandToRun` 提供时,hook 注入完成后还要 exec 该命令。具体如何
   * 串接由各 shell 决定:
   *   - PowerShell: 把 command 追加到 -Command 字符串末尾
   *   - cmd: 用 /K 起 shell + 命令
   *   - bash: 在 rcfile 后追加 -c "..."
   * 命令不存在 / 报错由 shell 自然吐到 PTY 字节流 (不弹对话框)。
   */
  buildShellLaunchParams(
    shell: ShellInfo,
    hookFilePath: string,
    commandToRun?: { command: string; args: string[] },
  ): { args: string[]; env: Record<string, string> };

  /** 注册 / 注销文件管理器右键集成 (V1.2 启用) */
  registerFileManagerIntegration(appExePath: string): Promise<void>;
  unregisterFileManagerIntegration(): Promise<void>;

  /** 查询进程当前工作目录 (OSC 1337 hook 失败时的兜底) */
  getProcessCwd(pid: number): Promise<string | null>;

  /** 设置 / 查询开机启动 */
  setAutoStart(enabled: boolean): Promise<void>;
  isAutoStartEnabled(): Promise<boolean>;

  /**
   * 拉取一份最新的 PATH 环境变量(BETA-001)。
   *
   * Windows 上 Marina 启动时 Node 把 process.env.PATH 快照固定,之后用户安装
   * 新软件改写注册表里的 PATH,已运行进程不会收到广播。每次 spawn 前从注册表
   * 重新读 HKLM + HKCU 合并后的 PATH,确保新装的 python.exe / node.exe 立刻
   * 可见。失败时回退 process.env.PATH 并写 log.warn。
   *
   * Windows 上还要保证返回值不含 `%SystemRoot%` 等未展开占位符(BETA-ENV-1)—
   * 注册表 REG_EXPAND_SZ 原值含占位符,实现里必须自己调
   * ExpandEnvironmentStrings(或等价的 TS 实现)展开后再返回。
   *
   * macOS / Linux 平台一般不需要(标准 fork/exec 已继承 shell 完整 env),
   * 直接返回 process.env.PATH 即可。
   */
  getRefreshedPath(): string;

  /**
   * spawn 前对完整 env 字典做最后一道规整(BETA-ENV-1)。
   *
   * Windows 上必须保证:
   * (1) `SystemRoot` / `windir` / `SYSTEMROOT` 三个 casing 都存在且值一致
   *     —— Win32 内部展开 `%SystemRoot%` 按字面 key 找,casing 错就替换成空
   * (2) PATH / Path / PATHEXT / PSModulePath / ComSpec 等 PATH-like 字段
   *     里不残留未展开占位符
   * 这两条任意一条挂了,所有 system32 系原生工具(powershell / cmd / reg /
   * wmic / ssh / tasklist 等)都会从子进程的 PATH 上消失。
   *
   * macOS / Linux:子进程从 login shell 继承已展开的 env,本方法返回原对象
   * 即可。接口保留是为了让 session-manager 不依赖 process.platform 判断。
   *
   * 实现允许**原地修改** env 并返回同一引用(便于调用方链式)。
   */
  normalizeSpawnEnv(env: Record<string, string>): Record<string, string>;

  /**
   * 返回干净安装时种入收藏栏的"默认收藏"条目。
   *
   * 历史:BETA-011 曾把这些路径放在 Sidebar 第 4 栏"系统",2026-05-16
   * 决定取消独立分组 — 桌面/主目录直接作为安装默认收藏,用户可重命名 /
   * 移除,行为与普通收藏完全一致。
   *
   * Windows:%USERPROFILE%\Desktop("桌面") / %USERPROFILE%("主目录")
   * Linux / macOS:接口保留,实现见各平台 adapter(目前 throw)
   *
   * 返回数组顺序 = 种子顺序。每次启动都会被调用,但只有 bookmarks.json
   * 不存在(JsonStore source==='default')时才生效一次,后续启动不会重播。
   */
  getDefaultBookmarkSeeds(): DefaultBookmarkSeed[];

  /**
   * SSH 方案 v2.1 §阶段 3.5:OpenSSH ControlPath socket 文件路径模板。
   *
   * - Linux/macOS:返回 `~/.ssh/cm-%r@%h:%p`(OpenSSH 自动展开 %r/%h/%p,
   *   ~ 由 OpenSSH 而非 shell 展开 — OpenSSH 文档明示)。
   * - Windows:返回固定模板字符串即可。Windows OpenSSH 8.x+ 走 named pipe,
   *   ControlPath 值被忽略,实际不读;传它只是为了 args 一致。
   *
   * 可选 — 旧 PlatformAdapter 实现不提供则 SessionManager 用默认值。
   */
  getSshControlPath?(): string;
}

/**
 * 干净安装时种入收藏栏的默认条目。
 * 落到 PathManager 后会被分配 UUID,加入 bookmarks.json 持久化,
 * 与用户手动添加的收藏一视同仁。
 */
export interface DefaultBookmarkSeed {
  /** 显示名,如 "桌面" / "主目录" */
  label: string;
  /** 文件系统绝对路径(平台决定具体值) */
  path: string;
}

/**
 * 当前平台的 adapter 单例。延迟到首次访问时初始化,避免在测试中误触发副作用。
 *
 * @throws 在 macOS / Linux 上 throw "Not implemented yet. Contributions welcome!"
 */
let cachedAdapter: PlatformAdapter | null = null;

export function getPlatformAdapter(): PlatformAdapter {
  if (cachedAdapter) return cachedAdapter;

  // 仅此处允许检查 process.platform。其他模块必须通过 getPlatformAdapter()。
  const platform = process.platform;
  switch (platform) {
    case 'win32':
      cachedAdapter = new WindowsAdapter();
      return cachedAdapter;
    case 'darwin':
      throw new Error(
        '[platform] macOS support not implemented yet. Contributions welcome! ' +
          'See CONTRIBUTING.md and src/main/platform/macos.ts.',
      );
    case 'linux':
      cachedAdapter = new LinuxAdapter();
      return cachedAdapter;
    default:
      throw new Error(`[platform] Unsupported process.platform: "${platform}"`);
  }
}

/**
 * 仅供测试使用,允许把 adapter 替换成 mock 或重置缓存。
 * 生产代码不许调用。
 */
export function __setPlatformAdapterForTest(adapter: PlatformAdapter | null): void {
  cachedAdapter = adapter;
}
