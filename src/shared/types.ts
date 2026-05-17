/**
 * @file types.ts
 * @purpose 跨进程共享的领域类型 (Bookmark / Session / PathNode / Settings 等)。
 *   这些类型对应 软件定义书.md 第 11 章 (数据模型) 的 schema。
 *
 * @关键设计:
 * - 类型按"持久化数据"和"内存数据"分组,与磁盘 JSON 文件一一对应
 * - 持久化结构带 version 字段用于版本迁移 (软件定义书 11.3)
 * - SessionState/PathCategory 是受限字符串字面量,与状态机定义对齐
 * - 不在这里定义任何带方法的 class,纯数据 (要 JSON 可序列化)
 *
 * @对应文档章节: 软件定义书.md 第 8 章 (状态机)、第 11 章 (数据模型)
 */

// ──────────────────────────────────────────────────────────────────
// 枚举 / 字面量
// ──────────────────────────────────────────────────────────────────

/**
 * Path 在侧栏中的归属分类 (软件定义书 4 节)。
 *
 * 注:BETA-011 一度引入的 'system' 分类已在 2026-05-16 移除 — 桌面/主目录
 * 改为干净安装时种入收藏(见 PathManager.initialize + PlatformAdapter
 * .getDefaultBookmarkSeeds),不再是独立分组。
 */
export type PathCategory = 'bookmarked' | 'temporary' | 'recent';

/**
 * Session 的运行时状态 (软件定义书 8.3 节状态机)。
 *
 * v1.2 起 (ADR-008):状态机砍掉了 tombstoned (5 分钟自动过期 + 重启)。
 * PTY 进程退出后直接进入 'exited',无时限等待用户主动关闭。
 *
 * - active:近 N 秒有 PTY 字节输出
 * - idle:活着但 N 秒无输出 (默认 N=2,见 settings.advanced.activeIdleThresholdSeconds)
 * - exited:PTY 进程已结束 (正常或异常),scrollback 仍持有,等待用户右键关闭
 */
export type SessionState = 'active' | 'idle' | 'exited';

/**
 * 应用整体生命周期状态 (软件定义书 8.1 节)。
 */
export type AppLifecycleState =
  | 'starting'
  | 'running-with-window'
  | 'running-tray-only'
  | 'exiting';

/**
 * 启动模板的退出后行为。
 */
export type PostExitAction = 'close_session' | 'keep_shell' | 'hold';

/**
 * 主题 ID (软件定义书 5.1.9)。
 */
export type ThemeId =
  | 'rose-pine'
  | 'rose-pine-dawn'
  | 'rose-pine-moon'
  | 'cutie'
  | 'business'
  | 'ubuntu'
  | 'windows-terminal'
  // BETA-033 起新增的 4 个深色主题
  | 'one-dark-pro'
  | 'dracula'
  | 'tokyo-night'
  | 'catppuccin-mocha';

/**
 * 窗口外观风格 (M1-A 引入,Milestone 1)。
 *
 * - 'windows':传统 Windows 风格 — 控制按钮(最小化/最大化/关闭)在右,
 *   方形按钮 + lucide 图标。`titleBarOverlay` 由主题色驱动。
 * - 'macos':macOS 风格 — 三色 traffic light 按钮在左(红黄绿),圆形,
 *   悬浮渲染于内容之上;右侧让位给标题与窗口编号。整个 chrome 更紧凑。
 *
 * 该字段控制布局 + 控件位置,**不**控制配色(配色仍走 theme)。
 */
export type WindowStyle = 'windows' | 'macos';

/**
 * 终端右键行为 (软件定义书 6.6.2 行为)。
 */
export type TerminalRightClick = 'menu' | 'paste';

/**
 * 启动时行为。
 */
export type StartupBehavior = 'open-window' | 'tray-only';

/**
 * 新终端使用的 shell 策略。
 */
export type NewTerminalShellPolicy = 'default' | 'last-used';

// ──────────────────────────────────────────────────────────────────
// 内存数据 (Window / Session / Path)
// ──────────────────────────────────────────────────────────────────

/**
 * Window 信息 — 由 Main 维护,广播给所有 Renderer 用于显示窗口列表。
 * Renderer 不直接持有 BrowserWindow 引用,只通过 windowId 引用。
 */
export interface WindowInfo {
  /** UUID,持久且不复用 */
  id: string;
  /**
   * 显示给用户的编号,从 1 开始单调递增,关闭后不复用。
   * 应用每次启动时从 1 重新开始 (软件定义书 6.7 节)。
   */
  number: number;
  /** Electron BrowserWindow 的内部 ID,Main 用它定位 webContents */
  electronWindowId: number;
}

/**
 * Session 的可序列化外观 (用于 IPC 与 snapshot)。
 * 实际的 PTY 实例 / scrollback buffer 留在 Main,不传到 renderer。
 */
export interface SessionInfo {
  id: string;
  /**
   * Session 创建时确定的 path id,**生命周期内永不变** (ADR-008)。
   * cd 等 cwd 变化不会让 session 在 UI 上换 path,只触发 currentCwd ⚠️ 提示。
   */
  pathId: string;
  templateId: string;
  /**
   * Session 创建时的 cwd,等于该 session 所属 path 的 path 字段,
   * 生命周期内永不变 (ADR-008)。
   */
  originalCwd: string;
  /**
   * Session 内 OSC 1337 实时报告的工作目录。
   * 启动时初值 = originalCwd;之后随 OSC 1337 序列更新。
   * 仅用于 UI:currentCwd ≠ originalCwd 时 tab 显示 ⚠️ + tooltip。
   */
  currentCwd: string;
  /** 终端尺寸,renderer fit 后通过 cmd:session:resize 同步 */
  cols: number;
  rows: number;
  /** PTY 子进程 PID,用于诊断;-1 表示尚未 spawn 或已退出 */
  pid: number;
  /** 显示名,默认 templateId 对应模板的 name */
  displayName: string;
  /** 当前持有该 session 的 owner window;null 表示无主 */
  ownerWindowId: string | null;
  state: SessionState;
  /** 退出码 (state === 'exited' 时有值) */
  exitCode?: number;
  /** PTY 进程退出时间 (Unix ms,state === 'exited' 时有值) */
  exitedAt?: number;
  /** 创建时间 (Unix ms) */
  createdAt: number;
}

/**
 * 路径节点,用于侧栏渲染。
 */
export interface PathNode {
  /** UUID 内部 id */
  id: string;
  /** 文件系统绝对路径 */
  path: string;
  /** 用户自定义显示名,无则取路径最后一段 */
  displayName?: string;
  category: PathCategory;
  /** 该 path 下的所有 session id */
  sessionIds: string[];
  /** 收藏路径才有: 双击新建终端的默认模板 */
  defaultTemplateId?: string;
  /**
   * BETA-043:启动期扫描发现该路径已不可访问(被外部删除 / 权限变化等)。
   * 仅做 UI 标记(置灰 + ⚠️ icon),不自动从列表里清除,留给用户决定。
   */
  invalid?: boolean;
}

/**
 * 完整路径树 (snapshot / 广播用)。
 */
export interface PathTree {
  bookmarks: PathNode[];
  temporary: PathNode[];
  recent: PathNode[];
}

// ──────────────────────────────────────────────────────────────────
// 持久化数据 schema (与磁盘 JSON 文件一一对应)
// ──────────────────────────────────────────────────────────────────

/**
 * settings.json 顶级结构 (软件定义书 11.1 settings.json)。
 *
 * CP-2 阶段所有字段都已定义,但只有 appearance.theme 真正在 UI 生效;
 * 其它字段在 CP-4 设置完整化时接通。
 */
export interface Settings {
  version: 1;

  appearance: {
    theme: ThemeId;
    windowStyle: WindowStyle;             // M1-A:窗口风格 (windows / macos)
    /**
     * BETA-004 UI 语言。'system' 表示跟随系统 locale(app.getLocale()):
     * zh-* 默认中文,其他默认英文。固定 'zh-CN' / 'en-US' 强制使用对应语言。
     */
    language: 'system' | 'zh-CN' | 'en-US';
    terminalFontFamily: string;
    terminalFontSize: number;
    terminalLineHeight: number;
    uiFontFamily: string;
    uiZoom: number;
    /**
     * BETA-023:macOS 风格红绿灯按钮在 hover 时是否显示 ×/−/+ 悬浮符号。
     * 默认 false(保持 Marina 极简风,与 CP-4 勘误第二轮的决策一致);
     * 设为 true 可恢复原生 macOS 观感。
     */
    macOSTrafficLightHoverSymbols: boolean;
  };

  /**
   * 窗口位置/尺寸记忆 (M1-G)。
   * V1 全局单一组,不区分 windowId — 新窗口都按这组开,关窗时把"最后一个"窗口的 bounds 写回。
   * 不存在 = 第一次启动 / 上次窗口都被外部干掉,fallback 1200x800 居中。
   */
  windowDefaults?: {
    width: number;
    height: number;
    x?: number;
    y?: number;
    maximized?: boolean;
  };

  shell: {
    /** 启动检测到的某个 shell id;空字符串表示用 PlatformAdapter 默认 */
    defaultShellId: string;
    newTerminalShellPolicy: NewTerminalShellPolicy;
  };

  behavior: {
    startupBehavior: StartupBehavior;
    autoStart: boolean;
    confirmOnQuit: boolean;
    selectOnCopy: boolean;
    terminalRightClick: TerminalRightClick;
    /**
     * bracketed paste 协议 (fix/robustness-pass-20260513, CPB-P8)。
     * 启用时 handlePaste 包裹 \x1b[200~ ... \x1b[201~,支持的 shell
     * (PowerShell 7+, bash 5+, zsh, fish, Claude Code REPL)把粘贴
     * 内容当 literal,用户可编辑后再 Enter;不再被 shell 立即执行。
     *
     * 不支持的 shell(cmd.exe 无 readline / 老版 bash)会把 marker
     * 显示成 ^[[200~ 字面乱码。建议用 cmd 的用户关闭此项。
     *
     * 默认 true 因为 Marina 默认 shell 是 PowerShell,大多数用户用 pwsh。
     */
    bracketedPaste: boolean;
  };

  systemIntegration: {
    /**
     * 从 Explorer 右键菜单触发 "在 Marina 终端中打开" 时,新 session 起在哪里。
     * - 'new-window': 始终开新窗口承载(默认,符合"右键 = 干净环境"直觉)
     * - 'recent-window-tab': 在最近活动窗口里新开 tab
     * 冷启动一律走 new-window 行为(没有可复用窗口),设置只在已开应用时生效。
     *
     * 注:**Explorer 右键集成是否已注册** 是系统状态,不是用户偏好,因此不在 settings 里。
     * 通过 IPC `cmd:explorer-integration:get-status` 现场查 HKCU 注册表 + MSIX 包获得,
     * 通过 `cmd:explorer-integration:set-{classic,modern}` 修改。导入导出归档时
     * 不携带注册状态,跨机器导入只复用 explorerOpenIn 等纯偏好。
     */
    explorerOpenIn: 'new-window' | 'recent-window-tab';
  };

  advanced: {
    logLevel: 'INFO' | 'DEBUG';
    activeIdleThresholdSeconds: number;
    // 注:v1.2 起 sessionTombstoneMinutes 已删除 (砍墓地,见 ADR-008)
  };

  /**
   * BETA-031 AI 助手 — 第一个 LLM 集成点。默认全 disabled,用户在设置页主动
   * 开启并填 API key 才生效。当前唯一 consumer 是 BETA-006(active→idle 跃迁
   * LLM 复核,避免 Vite 等长输出工具被误判 idle)。
   *
   * API key 走 settings.json 持久化;不做加密(与其它持久化字段一致)。
   * 备份导出导入会带这个字段,跨机器复制时需要小心 — README 已提示。
   */
  ai: {
    /** null = 未启用;选 anthropic / openai 后激活 ai-client */
    provider: 'anthropic' | 'openai' | null;
    /** 任意明文,UI 显示时遮罩;空串视为未填 */
    apiKey: string;
    /**
     * F6(beta 勘误2):自定义 Base URL。空串 = 走 SDK 默认 endpoint
     * (api.anthropic.com / api.openai.com);填写后透传给 SDK constructor 的
     * `baseURL` 字段。覆盖场景:代理网关、Azure OpenAI、自托管 LLM、企业
     * 内网镜像。Anthropic 与 OpenAI 两个官方 SDK 都接受 `baseURL` 字段,
     * 透传逻辑统一。
     */
    baseURL: string;
    /** 例如 'claude-haiku-4-5-20251001' / 'gpt-4o-mini',空串走 provider 默认 */
    model: string;
    /** BETA-006:active→idle 跃迁前调 LLM 复核,默认关。开启需 apiKey 非空。 */
    statusRecheckEnabled: boolean;
    /**
     * BETA-006 v2:喂给 LLM 的输入源。
     * - 'headless' = main 端 @xterm/headless 维护的"已渲染"字符矩阵尾部 N 行,
     *                无 ANSI / 无重绘残影,唯一可用选项
     * - 'screenshot' = 多模态视觉,枚举值预留,UI 暂不暴露
     *
     * CURSOR-1 后:原 'raw'(裸字节 ring 末 2KB)选项已删除,裸字节 scrollback
     * 存储被 state-replay 架构(SerializeAddon)取代,不再保留。settings.json
     * 里残留的 'raw' 值在 SettingsManager 读取时会被 coerce 到 'headless'。
     */
    statusRecheckSource: 'headless' | 'screenshot';
  };
}

/**
 * bookmarks.json
 */
export interface BookmarksFile {
  version: 1;
  paths: Bookmark[];
}

export interface Bookmark {
  id: string;
  path: string;
  displayName?: string;
  defaultTemplateId?: string;
  /** Unix ms */
  addedAt: number;
}

/**
 * recent.json
 */
export interface RecentFile {
  version: 1;
  paths: RecentEntry[];
}

export interface RecentEntry {
  path: string;
  /** Unix ms,降序排序的依据 */
  lastUsedAt: number;
  useCount: number;
}

/**
 * templates.json (CP-3 完整化,CP-2 不持久化模板)
 */
export interface TemplatesFile {
  version: 1;
  defaultTemplateId: string;
  templates: Template[];
}

export interface Template {
  /** 内置模板 id 固定 (shell / claude-code / codex / opencode),自定义为 UUID */
  id: string;
  name: string;
  /** emoji 或简单图标 */
  icon: string;
  isBuiltin: boolean;
  command: string;
  args: string[];
  env: Record<string, string>;
  shellFirst: boolean;
  postExitAction: PostExitAction;
}

// ──────────────────────────────────────────────────────────────────
// IPC snapshot
// ──────────────────────────────────────────────────────────────────

/**
 * cmd:app:get-snapshot 的返回结构 (ipc-protocol 4.3)。
 */
export interface AppSnapshot {
  windows: WindowInfo[];
  sessions: SessionInfo[];
  pathTree: PathTree;
  templates: Template[];
  defaultTemplateId: string;
  settings: Settings;
  /** 回显发起方的 windowId,renderer 用来校验 */
  myWindowId: string;
}

// ──────────────────────────────────────────────────────────────────
// 内存中的 Session 句柄 (Main 内部用,不导出到 renderer)
// 这里只声明类型作为参考,真实定义在 src/main/session-manager.ts
// ──────────────────────────────────────────────────────────────────

/**
 * Session 与 PTY 的内存结构 (Main 内部使用,不通过 IPC 传)。
 * 真实定义在 SessionManager,这里只为文档化暴露 schema。
 */
export interface SessionRuntimeShape {
  info: SessionInfo;
  /** 环形 scrollback buffer,2MB 上限,CP-3 接入 (CP-2 留空) */
  scrollback: Buffer | null;
}
