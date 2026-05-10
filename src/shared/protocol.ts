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

  // Session 域
  SESSION_CREATE: 'cmd:session:create',
  SESSION_CLOSE: 'cmd:session:close',
  SESSION_CLAIM: 'cmd:session:claim',
  SESSION_RELEASE: 'cmd:session:release',
  SESSION_FOCUS_OWNER: 'cmd:session:focus-owner',
  SESSION_SEND_INPUT: 'cmd:session:send-input',
  SESSION_RESIZE: 'cmd:session:resize',
  SESSION_GET_SCROLLBACK: 'cmd:session:get-scrollback',

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

  // System 域
  SYSTEM_SHOW_IN_EXPLORER: 'cmd:system:show-in-explorer',
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
  /** Base64 编码的整段 scrollback ring buffer 内容 (UTF-8 字节流) */
  data: string;
  /** 取此 scrollback 时刻 PTY 已 emit 的最后一条 output 的 seq;
   *  渲染端用 seq > lastSeq 去重 evt:session:output。 */
  lastSeq: number;
}

export interface ReleaseSessionPayload {
  sessionId: string;
}

export interface FocusSessionOwnerPayload {
  sessionId: string;
}

export interface SendInputPayload {
  sessionId: string;
  /** 字节流,base64 编码 */
  data: string;
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
// System 域
// ──────────────────────────────────────────────────────────────────

export interface ShowInExplorerPayload {
  path: string;
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
  reason: 'session-click' | 'tray-click' | 'manual';
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
