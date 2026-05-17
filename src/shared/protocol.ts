/**
 * @file protocol.ts
 * @purpose IPC 协议的共享类型定义。Main 与 Renderer 都从这里 import,
 *   确保两端对消息 schema 的理解完全一致。
 *
 * @关键设计:
 * - Channel 命名严格遵守 docs/ipc-protocol.md 第 2.1 节的
 *   `<kind>:<domain>:<action>` 格式
 * - 每个命令的 payload 类型与返回值类型成对定义
 * - 所有 payload 必须 JSON 可序列化 (ipc-protocol.md 1.3 节)
 * - 这个文件不引入任何运行时代码,纯类型 + 常量
 *
 * @对应文档章节: docs/ipc-protocol.md 全部
 */
import type {
  AppSnapshot,
  Bookmark,
  PathTree,
  SessionInfo,
  Settings,
  Template,
  WindowInfo,
} from './types';
import type { DeepPartial } from './types-helpers';

/**
 * 协议版本号。Main 与 Renderer 不匹配时拒绝 handshake。
 * Bump 规则:破坏性变更 +1;新增 channel 或扩展 payload 不需要 bump。
 */
export const PROTOCOL_VERSION = 1 as const;

/**
 * 所有命令通道的命名常量。集中管理避免硬编码字符串散落各处。
 */
export const COMMAND_CHANNELS = {
  // App 域
  APP_GET_PROTOCOL_VERSION: 'cmd:app:get-protocol-version',
  APP_GET_SNAPSHOT: 'cmd:app:get-snapshot',
  APP_QUIT: 'cmd:app:quit',

  // Window 域
  WINDOW_CREATE: 'cmd:window:create',
  WINDOW_CLOSE_SELF: 'cmd:window:close-self',
  WINDOW_CLOSE_ALL: 'cmd:window:close-all',
  WINDOW_FOCUS: 'cmd:window:focus',
  /** M1-A:最小化自身窗口 */
  WINDOW_MINIMIZE: 'cmd:window:minimize',
  /** M1-A:切换最大化/还原 */
  WINDOW_TOGGLE_MAXIMIZE: 'cmd:window:toggle-maximize',
  /** M1-A:查询当前是否最大化 */
  WINDOW_GET_MAX_STATE: 'cmd:window:get-max-state',

  // Session 域
  SESSION_CREATE: 'cmd:session:create',
  SESSION_CLOSE: 'cmd:session:close',
  SESSION_CLAIM: 'cmd:session:claim',
  SESSION_RELEASE: 'cmd:session:release',
  SESSION_FOCUS_OWNER: 'cmd:session:focus-owner',
  SESSION_SEND_INPUT: 'cmd:session:send-input',
  SESSION_RESIZE: 'cmd:session:resize',
  SESSION_GET_SCROLLBACK: 'cmd:session:get-scrollback',
  /** BETA-028:导出 scrollback 为 UTF-8 字符串,供终端工具栏"复制全部"按钮 */
  SESSION_EXPORT_SCROLLBACK: 'cmd:session:export-scrollback',
  /** BETA-028:清空 main 端的 scrollback ring buffer(配合 term.clear() 使用) */
  SESSION_CLEAR_SCROLLBACK: 'cmd:session:clear-scrollback',
  /** M1-C:重命名 session(只改 displayName,内部仍由 sessionId 标识) */
  SESSION_RENAME: 'cmd:session:rename',
  /**
   * STM-3:清除手动重命名标记,让 OSC 0/1/2 标题事件重新覆盖 displayName。
   * 用户右键"恢复自动标题"调,典型场景是用户希望 Claude Code 持续刷新
   * 的任务进度标题重新生效。
   */
  SESSION_CLEAR_MANUAL_RENAME: 'cmd:session:clear-manual-rename',
  /**
   * 右键 Tab → "在新窗口中打开"。原子地把 session 从调用方窗口释放,
   * 创建新窗口并把所有权直接转给新窗口,新窗口启动时从 URL ?selectSessionId
   * 读到目标后 dispatch select-session 自动切到该 session。
   */
  SESSION_OPEN_IN_NEW_WINDOW: 'cmd:session:open-in-new-window',

  // Bookmark / Path 域
  BOOKMARK_ADD: 'cmd:bookmark:add',
  BOOKMARK_REMOVE: 'cmd:bookmark:remove',
  BOOKMARK_RENAME: 'cmd:bookmark:rename',
  BOOKMARK_REORDER: 'cmd:bookmark:reorder',
  BOOKMARK_SET_DEFAULT_TEMPLATE: 'cmd:bookmark:set-default-template',
  BOOKMARK_PICK_FOLDER: 'cmd:bookmark:pick-folder',
  PATH_REMOVE_FROM_RECENT: 'cmd:path:remove-from-recent',

  // Settings 域
  SETTINGS_GET: 'cmd:settings:get',
  SETTINGS_UPDATE: 'cmd:settings:update',
  SETTINGS_RESET: 'cmd:settings:reset',
  SETTINGS_LIST_SHELLS: 'cmd:settings:list-shells',
  SETTINGS_GET_AUTO_START: 'cmd:settings:get-auto-start',
  SETTINGS_EXPORT: 'cmd:settings:export',
  SETTINGS_IMPORT: 'cmd:settings:import',

  // Templates 域 (CP-4 chunk 4 起 CRUD 暴露给 renderer)
  TEMPLATE_ADD: 'cmd:template:add',
  TEMPLATE_UPDATE: 'cmd:template:update',
  TEMPLATE_DELETE: 'cmd:template:delete',
  TEMPLATE_SET_DEFAULT: 'cmd:template:set-default',

  // System 域
  SYSTEM_SHOW_IN_EXPLORER: 'cmd:system:show-in-explorer',
  SYSTEM_OPEN_DATA_DIR: 'cmd:system:open-data-dir',
  SYSTEM_OPEN_LOGS_DIR: 'cmd:system:open-logs-dir',
  SYSTEM_OPEN_EXTERNAL: 'cmd:system:open-external',
  /** 当前构建形态 dev / portable / installed,供渲染端决定是否禁用系统集成 UI */
  SYSTEM_GET_BUILD_TYPE: 'cmd:system:get-build-type',
  /** BETA-039:返回 app.getPath('userData'),让设置页显示真实数据目录而非硬编码 */
  SYSTEM_GET_DATA_DIR: 'cmd:system:get-data-dir',

  // Explorer 集成域 —— 不进 settings.json,现场查 + 操作系统状态
  /** 综合查询:buildType + Win 版本 + 经典菜单 + Win11 新菜单 + 证书 + MSIX 包 */
  EXPLORER_INTEGRATION_GET_STATUS: 'cmd:explorer-integration:get-status',
  /** 经典右键菜单(HKCU 注册表)开/关 */
  EXPLORER_INTEGRATION_SET_CLASSIC: 'cmd:explorer-integration:set-classic',
  /** Win11 新菜单(MSIX + 证书)安装/卸载 */
  EXPLORER_INTEGRATION_SET_MODERN: 'cmd:explorer-integration:set-modern',
  /** 取出当前会执行的 PowerShell 命令字符串(供「复制 PS 命令」按钮) */
  EXPLORER_INTEGRATION_GET_PS_COMMANDS: 'cmd:explorer-integration:get-ps-commands',
  /**
   * 勘误第二轮:剪贴板 IPC。
   * navigator.clipboard.* 在 Electron file:// 上下文需 web 权限,我们的
   * permission handler 拒掉了 clipboard-write 导致写永远静默失败。走 IPC
   * 调主进程的 Electron clipboard 模块,绕开所有 web 权限层 + dev/prod 行为
   * 一致。preload 的 invoke 桥已经存在,这里只是新增 channel。
   */
  SYSTEM_CLIPBOARD_READ_TEXT: 'cmd:system:clipboard-read-text',
  SYSTEM_CLIPBOARD_WRITE_TEXT: 'cmd:system:clipboard-write-text',

  /** BETA-031:AI 助手测试连接 — 主进程用 SDK 跑一次 ping,返回成功 / 错误描述 */
  AI_TEST_CONNECTION: 'cmd:ai:test-connection',
} as const;

export type CommandChannel = (typeof COMMAND_CHANNELS)[keyof typeof COMMAND_CHANNELS];

/**
 * 所有事件通道的命名常量。
 */
export const EVENT_CHANNELS = {
  // App / Window
  APP_STATE_CHANGED: 'evt:app:state-changed',
  WINDOW_ASSIGNED_ID: 'evt:window:assigned-id',
  WINDOW_LIST_UPDATED: 'evt:window:list-updated',
  WINDOW_FOCUS_REQUESTED: 'evt:window:focus-requested',
  /** M1-A:本窗口的 maximize / unmaximize 状态变化(供 renderer 切按钮图标 + 圆角) */
  WINDOW_MAX_STATE_CHANGED: 'evt:window:max-state-changed',

  // Session
  SESSION_CREATED: 'evt:session:created',
  SESSION_STATE_CHANGED: 'evt:session:state-changed',
  SESSION_OUTPUT: 'evt:session:output',
  SESSION_EXITED: 'evt:session:exited',
  SESSION_OWNER_CHANGED: 'evt:session:owner-changed',
  SESSION_DESTROYED: 'evt:session:destroyed',

  // Path / Bookmark / Settings
  PATH_TREE_UPDATED: 'evt:path:tree-updated',
  BOOKMARKS_UPDATED: 'evt:bookmarks:updated',
  SETTINGS_CHANGED: 'evt:settings:changed',
  TEMPLATES_UPDATED: 'evt:templates:updated',

  /**
   * BETA-003b · ADR-013:Linux 上最后窗口关闭 + 仍有 alive session 时,
   * 主进程拦截 close 事件后给本窗口 renderer 发此事件,弹 LastSessionConfirm
   * modal。Payload:{ sessionCount: number }。
   *
   * Windows / macOS 也复用同一 modal,触发位置分别是托盘菜单"完全退出"和
   * Cmd+Q / App Menu Quit。
   */
  UI_SHOW_LAST_SESSION_CONFIRM: 'evt:ui:show-last-session-confirm',
} as const;

export type EventChannel = (typeof EVENT_CHANNELS)[keyof typeof EVENT_CHANNELS];

// ──────────────────────────────────────────────────────────────────
// Envelope
// ──────────────────────────────────────────────────────────────────

export interface CommandEnvelope<P = unknown> {
  windowId: string;
  requestId: string;
  payload: P;
}

export interface EventEnvelope<P = unknown> {
  eventId: string;
  timestamp: number;
  payload: P;
}

// ──────────────────────────────────────────────────────────────────
// App 域
// ──────────────────────────────────────────────────────────────────

export interface GetProtocolVersionResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  buildVersion: string;
  /**
   * DEV-COEXIST(2026-05-16):构建形态。renderer 据此在标题栏后缀显示
   * "(dev)" / "(portable)",避免 dev 实例与打包版同时跑时误认。
   * 与 SYSTEM_GET_BUILD_TYPE 同源,只是放进握手响应里,首次握手就拿到。
   */
  buildType: 'dev' | 'portable' | 'installed';
}

export interface GetSnapshotPayload {
  /** 发起方窗口 ID,用于校验 */
  myWindowId: string;
}

export type GetSnapshotResponse = AppSnapshot;

export interface QuitPayload {
  /** CP-2 暂未使用,CP-3 加入 session 在跑时的二次确认时启用 */
  skipConfirmation?: boolean;
}

export interface QuitResponse {
  cancelled: boolean;
}

// ──────────────────────────────────────────────────────────────────
// Window 域
// ──────────────────────────────────────────────────────────────────

export interface CreateWindowPayload {
  /** 可选:新窗口启动时聚焦的 sessionId (CP-3 加入,CP-2 忽略) */
  selectSessionId?: string;
}

export interface CreateWindowResponse {
  windowId: string;
  windowNumber: number;
}

/**
 * M1-A:WINDOW_MINIMIZE / WINDOW_TOGGLE_MAXIMIZE 没有 payload(目标窗口
 * 直接由 envelope.windowId 决定);WINDOW_GET_MAX_STATE 返回值。
 */
export interface GetWindowMaxStateResponse {
  maximized: boolean;
}

/**
 * M1-A:evt:window:max-state-changed payload。
 */
export interface WindowMaxStateChangedPayload {
  maximized: boolean;
}

export interface FocusWindowPayload {
  windowId: string;
}

// ──────────────────────────────────────────────────────────────────
// Session 域
// ──────────────────────────────────────────────────────────────────

export interface CreateSessionPayload {
  /** 启动 session 的 path id (= 该 path 的 normalize 后绝对路径)。
   *  缺省时 SessionManager 会用 homedir,主要用于 CP-1 兼容期。 */
  pathId?: string;
  /** 启动模板 id。CP-2 仅 'shell',CP-3 起接 TemplateManager */
  templateId?: string;
  /**
   * 勘误第二轮 #3:可选 shell 覆盖。缺省走 settings.shell.defaultShellId,
   * 给定时强制用该 shell 启动 (但仍走模板的 command/args)。EmptyPathState
   * 的"检测到的 Shell"按钮通过它实现"用 Git Bash 起一个 shell"。
   */
  shellId?: string;
  /** 是否本窗口接管 ownership。默认 true */
  takeOwnership?: boolean;
  /** 终端尺寸初始值 */
  cols: number;
  rows: number;
}

export interface CreateSessionResponse {
  session: SessionInfo;
  /** 是否触发了 path 树变化 (临时分类等) */
  pathTreeChanged: boolean;
}

export interface RenameSessionPayload {
  sessionId: string;
  newDisplayName: string;
}

export interface CloseSessionPayload {
  sessionId: string;
  /** 强制 kill (默认 false 即 SIGTERM) */
  force?: boolean;
}

export interface ClaimSessionPayload {
  sessionId: string;
}

export interface ClaimSessionResponse {
  /** Base64 编码的 scrollback 历史 (CP-2 修订:已实现 ring buffer)。
   *  Renderer 通常通过 cmd:session:get-scrollback 单独拉取以避免与 claim
   *  动作时序耦合,此返回值仍带数据保留协议自洽。 */
  scrollback: string;
  /** 与 scrollback 同时刻的 lastSeq,用于 renderer 去重。 */
  lastSeq: number;
}

export interface GetScrollbackPayload {
  sessionId: string;
}

export interface GetScrollbackResponse {
  /**
   * Base64 编码的 ANSI 重建流(UTF-8 字节)。
   *
   * CURSOR-1 后(state-replay 架构):main 端从 session 各自的 @xterm/headless
   * 状态机通过 SerializeAddon 序列化"当前完整终端状态"(buffer + 当前在哪个
   * buffer + 模式 + cursor + SGR)。Renderer 把 data 直接 term.write(),xterm
   * 按 ANSI parse 即恢复到字节级等价状态 — 包括 alt-buffer (?1049h)、
   * cursor 隐藏 (?25l)、滚动区 (DECSTBM) 等。
   *
   * 旧字段名 `data` 保留(不破坏 IPC 协议),但语义已从"原始 PTY 字节流"
   * 升级为"状态机重建 ANSI 流"。详见 SessionManager.getScrollbackForReplay
   * 与 docs/issues/cursor-1-alt-buffer-blink-policy-broke-codex.md。
   */
  data: string;
  /** 取此 scrollback 时刻 PTY 已 emit 的最后一条 output 的 seq;
   *  渲染端用 seq > lastSeq 去重 evt:session:output。 */
  lastSeq: number;
}

export interface ReleaseSessionPayload {
  sessionId: string;
}

export interface OpenSessionInNewWindowPayload {
  sessionId: string;
  /** true → 新窗口以简易模式启动(隐藏 Sidebar/Tab bar)。默认 false。 */
  simpleMode?: boolean;
}

export interface OpenSessionInNewWindowResponse {
  windowId: string;
  windowNumber: number;
}

export interface FocusSessionOwnerPayload {
  sessionId: string;
}

export interface SendInputPayload {
  sessionId: string;
  /** 字节流,base64 编码 */
  data: string;
}

/**
 * sendInput/resize 的反馈。
 *
 * 历史:CP-1/2/3 期间这两条 IPC 都是 void(成功 / 失败都静默,renderer
 * 永远不知道键被丢了)。fix/robustness-pass(2026-05-13)起改为返回
 * accepted + reason,renderer 据此 toast / 视觉降级。
 *
 * reason 取值:
 *   - 'session-not-found' · sessionId 不在 SessionManager.sessions Map(已 destroy / 不存在)
 *   - 'pty-exited'        · session 在 'exited' 状态,managed.pty===null
 *   - 'not-owner'         · 调用方不是 session 的 ownerWindowId(只用于 sendInput)
 *   - 'pty-write-failed'  · pty.write() 抛错(ConPTY pipe half-closed 等)
 *   - 'invalid-dimensions'· cols/rows 不合规(只用于 resize)
 *
 * accepted=true 时 reason 一定不存在。
 */
export interface SendInputResponse {
  accepted: boolean;
  reason?:
    | 'session-not-found'
    | 'pty-exited'
    | 'not-owner'
    | 'pty-write-failed';
}

export interface ResizeSessionResponse {
  accepted: boolean;
  reason?: 'session-not-found' | 'pty-exited' | 'invalid-dimensions';
}

export interface ResizeSessionPayload {
  sessionId: string;
  cols: number;
  rows: number;
}

// ──────────────────────────────────────────────────────────────────
// Bookmark / Path 域
// ──────────────────────────────────────────────────────────────────

export interface AddBookmarkPayload {
  path: string;
  displayName?: string;
  defaultTemplateId?: string;
}

export interface AddBookmarkResponse {
  bookmark: Bookmark;
}

export interface RemoveBookmarkPayload {
  pathId: string;
}

export interface RenameBookmarkPayload {
  pathId: string;
  newDisplayName: string;
}

export interface ReorderBookmarksPayload {
  orderedPathIds: string[];
}

export interface SetDefaultTemplateForBookmarkPayload {
  pathId: string;
  templateId: string | null;
}

export interface PickFolderPayload {
  defaultPath?: string;
}

export interface PickFolderResponse {
  /** 用户取消 → null */
  path: string | null;
}

export interface RemoveFromRecentPayload {
  path: string;
}

// ──────────────────────────────────────────────────────────────────
// Settings 域
// ──────────────────────────────────────────────────────────────────

export interface GetSettingsResponse {
  settings: Settings;
}

export interface UpdateSettingsPayload {
  partial: DeepPartial<Settings>;
}

// ──────────────────────────────────────────────────────────────────
// Templates 域
// ──────────────────────────────────────────────────────────────────

export interface AddTemplatePayload {
  name: string;
  icon: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  shellFirst: boolean;
  postExitAction: 'close_session' | 'keep_shell' | 'hold';
}

export interface AddTemplateResponse {
  template: Template;
}

export interface UpdateTemplatePayload {
  id: string;
  partial: Partial<{
    name: string;
    icon: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    shellFirst: boolean;
    postExitAction: 'close_session' | 'keep_shell' | 'hold';
  }>;
}

export interface UpdateTemplateResponse {
  template: Template;
}

export interface DeleteTemplatePayload {
  id: string;
}

export interface SetDefaultTemplatePayload {
  id: string;
}

// ──────────────────────────────────────────────────────────────────
// Settings export / import
// ──────────────────────────────────────────────────────────────────

/**
 * 导出/导入用的归档 JSON schema (CP-4 chunk 4)。
 *
 * V1 用单 JSON 文件而非 zip:
 * - 4 类配置(settings/bookmarks/recent/templates)合体到一个 JSON
 * - 不含 logs / scrollback / 进程状态
 * - format 字段 + version 字段方便未来迁移
 *
 * 文档 6.6.2 描述为 zip,V1 折衷为 JSON 以避免引入 zip 库依赖
 * (AGENTS.md 1.2 边界 2)。未来加 archiver 包可平滑升级。
 */
export interface SettingsArchiveV1 {
  /**
   * 归档格式标签。v1.5 改名后新导出统一 'marina-archive';读侧也接受
   * 'easyterm-archive'(改名前的旧归档)。
   */
  format: 'marina-archive' | 'easyterm-archive';
  version: 1;
  exportedAt: number;
  exportedFrom: string;
  settings: Settings;
  bookmarks: { paths: Bookmark[] };
  recent: { paths: Array<{ path: string; lastUsedAt: number; useCount: number }> };
  templates: { defaultTemplateId: string; templates: Template[] };
}

export interface ExportSettingsResponse {
  /** 用户取消 → null */
  filePath: string | null;
}

export interface ImportSettingsResponse {
  /** 用户取消 → 'cancelled' / 错误 → 'error' / 成功 → 'imported' */
  status: 'imported' | 'cancelled' | 'error';
  errorMessage?: string;
}

export interface ShellListItem {
  /** shell id (pwsh / powershell / cmd / git-bash 等) */
  id: string;
  /** 用户友好显示名 (PowerShell 7 / Windows PowerShell / Command Prompt 等) */
  displayName: string;
  /** 实测命中的可执行文件绝对路径 */
  executablePath: string;
}

export interface ListShellsResponse {
  shells: ShellListItem[];
}

export interface GetAutoStartResponse {
  enabled: boolean;
}

// ──────────────────────────────────────────────────────────────────
// System 域
// ──────────────────────────────────────────────────────────────────

export interface ShowInExplorerPayload {
  path: string;
}

export interface OpenExternalPayload {
  /** http(s) URL — 文件 / file:// 协议拒绝 (安全) */
  url: string;
}

export interface ClipboardWriteTextPayload {
  text: string;
}

export interface ClipboardReadTextResponse {
  text: string;
}

export interface ClipboardWriteTextResponse {
  ok: boolean;
}

// ──────────────────────────────────────────────────────────────────
// Explorer 集成域
// ──────────────────────────────────────────────────────────────────

export type BuildType = 'dev' | 'portable' | 'installed';

export interface GetBuildTypeResponse {
  buildType: BuildType;
}

/**
 * 三个状态值的语义:
 * - `enabled`     当前系统状态已开启(经典 = HKCU key 存在;Win11 新菜单 = MSIX 已注册)
 * - `disabled`    支持但未开启
 * - `unsupported` 当前构建/系统不支持(dev / portable 一律 unsupported;经典菜单则在
 *                 非 Windows 上 unsupported;Win11 新菜单还要求 build >= 22000)
 */
export type ExplorerIntegrationState = 'enabled' | 'disabled' | 'unsupported';

export interface ExplorerIntegrationCertInfo {
  thumbprint: string;
  /** 证书 NotAfter,ISO 字符串 */
  notAfter: string;
  subject: string;
  /** Cert:\CurrentUser\TrustedPeople 是否存在该 thumbprint */
  trusted: boolean;
}

export interface ExplorerIntegrationPackageInfo {
  /** Marina.ContextMenu 等包名 */
  name: string;
  version: string;
  installLocation: string;
}

export interface ExplorerIntegrationStatus {
  buildType: BuildType;
  /** 例如 "10.0.22621";非 Windows 时为空字符串 */
  windowsBuild: string;
  /** Win11 22000+ 才支持 Modern 菜单(IExplorerCommand) */
  win11ModernSupported: boolean;
  classic: ExplorerIntegrationState;
  modern: ExplorerIntegrationState;
  /** 证书信息(Modern 菜单依赖,Modern 不支持时为 null) */
  cert: ExplorerIntegrationCertInfo | null;
  /** MSIX 包信息(modern=enabled 时存在) */
  package: ExplorerIntegrationPackageInfo | null;
  /** Modern 不支持的原因(展示给用户)。null = 支持 */
  modernUnsupportedReason: string | null;
  /** Classic 不支持的原因。null = 支持 */
  classicUnsupportedReason: string | null;
}

export interface SetExplorerIntegrationPayload {
  enabled: boolean;
}

export interface SetExplorerIntegrationResponse {
  ok: boolean;
  /** 失败时的可读消息;ok=true 时为空 */
  message: string;
  /** 操作后的最新状态(渲染端无需再单独调 GET_STATUS) */
  status: ExplorerIntegrationStatus;
}

export interface GetPsCommandsResponse {
  /** 安装 Win11 新菜单等价的 PowerShell 命令(供"复制" 按钮) */
  installModern: string;
  /** 卸载 Win11 新菜单 */
  uninstallModern: string;
  /** 注册经典菜单 */
  installClassic: string;
  /** 卸载经典菜单 */
  uninstallClassic: string;
}

// ──────────────────────────────────────────────────────────────────
// 事件 payload
// ──────────────────────────────────────────────────────────────────

export interface AppStateChangedPayload {
  hasWindows: boolean;
  totalSessions: number;
  activeSessions: number;
}

export interface WindowAssignedIdPayload {
  windowId: string;
  windowNumber: number;
}

export interface WindowListUpdatedPayload {
  windows: WindowInfo[];
}

export interface WindowFocusRequestedPayload {
  reason:
    | 'session-click'
    | 'tray-click'
    | 'manual'
    | 'tray-session-click' // M1-H:托盘"正在运行的会话"子菜单点击
    | 'tray-open-settings'; // M1-H:托盘"设置…"菜单
  selectSessionId?: string;
}

export interface SessionCreatedPayload {
  session: SessionInfo;
}

export interface SessionStateChangedPayload {
  sessionId: string;
  changes: Partial<SessionInfo>;
  full: SessionInfo;
}

export interface SessionOutputPayload {
  sessionId: string;
  /** base64 编码的字节流 */
  data: string;
  /** 自该 session 创建以来的事件序号,单调递增,从 0 开始 */
  seq: number;
}

export interface SessionExitedPayload {
  sessionId: string;
  exitCode: number;
  /** node-pty 给的是 signal number,Windows 上通常没有 */
  signal?: number;
}

export interface SessionOwnerChangedPayload {
  sessionId: string;
  oldOwnerWindowId: string | null;
  newOwnerWindowId: string | null;
}

export interface SessionDestroyedPayload {
  sessionId: string;
  /**
   * 销毁触发源。v1.2 起没有 'tombstone-expired' (砍墓地,见 ADR-008);
   * 'pty-exited' 仅在应用启动 / 异常 race 中出现 — 正常 PTY 退出不再立即
   * destroy,而是进入 'exited' 状态 (sessionExited 事件已涵盖),由用户
   * 主动关闭触发 'user-closed' destroy。
   */
  reason: 'user-closed' | 'app-quit' | 'pty-exited';
}

export interface PathTreeUpdatedPayload {
  tree: PathTree;
}

export interface BookmarksUpdatedPayload {
  bookmarks: Bookmark[];
}

export interface SettingsChangedPayload {
  settings: Settings;
  /** 变化的字段路径,如 ["appearance.theme"];renderer 可基于此局部更新 */
  changedKeys: string[];
}

/**
 * 模板列表更新 (CP-2 阶段不发,因为模板未持久化;CP-3 起启用)。
 */
export interface TemplateListUpdatedPayload {
  templates: Template[];
  defaultTemplateId: string;
}
