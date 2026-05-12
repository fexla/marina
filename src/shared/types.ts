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
 * Path 在三栏侧栏中的归属分类 (软件定义书 4 节)。
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
  | 'windows-terminal';

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
    terminalFontFamily: string;
    terminalFontSize: number;
    terminalLineHeight: number;
    uiFontFamily: string;
    uiZoom: number;
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
  };

  systemIntegration: {
    explorerContextMenu: boolean;
  };

  advanced: {
    logLevel: 'INFO' | 'DEBUG';
    activeIdleThresholdSeconds: number;
    // 注:v1.2 起 sessionTombstoneMinutes 已删除 (砍墓地,见 ADR-008)
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
