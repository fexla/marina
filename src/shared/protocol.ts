/**
 * @file protocol.ts
 * @purpose IPC 协议的共享类型定义。Main 与 Renderer 都从这里 import,
 *   确保两端对消息 schema 的理解完全一致。
 *
 * @关键设计:
 * - Channel 命名严格遵守 docs/ipc-protocol.md 第 2.1 节的 `<kind>:<domain>:<action>` 格式
 * - 每个命令的 payload 类型与返回值类型成对定义,便于在 ipc-client.ts 中泛型推导
 * - 所有 payload 必须 JSON 可序列化 (ipc-protocol.md 1.3 节)
 * - 这个文件不引入任何运行时代码,纯类型 + 常量
 *
 * @对应文档章节: docs/ipc-protocol.md 全部
 *
 * @CP-1 范围:
 * - app:get-protocol-version (handshake)
 * - session:create / send-input / resize / close (一窗一 PowerShell PTY 简化模型)
 * - evt:session:output / exited
 * 其余 channel (snapshot / bookmark / template / settings) 在 CP-2/3/4 加入。
 */

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

  // Session 域 (CP-1 一窗一 PTY 简化版,CP-3 完整 SessionManager 接管)
  SESSION_CREATE: 'cmd:session:create',
  SESSION_SEND_INPUT: 'cmd:session:send-input',
  SESSION_RESIZE: 'cmd:session:resize',
  SESSION_CLOSE: 'cmd:session:close',
} as const;

export type CommandChannel = (typeof COMMAND_CHANNELS)[keyof typeof COMMAND_CHANNELS];

/**
 * 所有事件通道的命名常量。
 */
export const EVENT_CHANNELS = {
  WINDOW_LIST_UPDATED: 'evt:window:list-updated',

  // Session 字节流与生命周期 (CP-1 子集,CP-3 扩展)
  SESSION_OUTPUT: 'evt:session:output',
  SESSION_EXITED: 'evt:session:exited',
} as const;

export type EventChannel = (typeof EVENT_CHANNELS)[keyof typeof EVENT_CHANNELS];

/**
 * 命令信封 (ipc-protocol.md 2.3 节)。
 * Renderer 端 invoke 时会自动包装,Main 端 handle 时会自动解包。
 */
export interface CommandEnvelope<P = unknown> {
  windowId: string;
  requestId: string;
  payload: P;
}

/**
 * 事件信封 (ipc-protocol.md 2.4 节)。
 */
export interface EventEnvelope<P = unknown> {
  eventId: string;
  timestamp: number;
  payload: P;
}

// ──────────────────────────────────────────────────────────────────
// App 域 payload / response
// ──────────────────────────────────────────────────────────────────

/**
 * cmd:app:get-protocol-version 的返回类型。
 */
export interface GetProtocolVersionResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  /** 应用版本号,从 package.json 读 */
  buildVersion: string;
}

// ──────────────────────────────────────────────────────────────────
// Session 域 payload / response (CP-1 简化版)
// ──────────────────────────────────────────────────────────────────

/**
 * cmd:session:create payload。CP-1 一窗一 PTY 简化:
 * - 不传 pathId / templateId,自动用默认 shell 与用户主目录
 * - 创建后该 session 的 owner 即为发起的 window
 *
 * CP-3 引入 SessionManager 后会扩展此 payload 兼容多 session/path/template。
 */
export interface CreateSessionPayload {
  /** 终端尺寸初始值 (cols * rows),来自 xterm fit 后的实际值 */
  cols: number;
  rows: number;
}

export interface CreateSessionResponse {
  sessionId: string;
  /** PTY 子进程的 PID,用于诊断 */
  pid: number;
  /** 启动用的 shell 可执行文件绝对路径 */
  shellPath: string;
  /** 启动时的工作目录 */
  cwd: string;
}

export interface SendInputPayload {
  sessionId: string;
  /** 字节流,base64 编码 (避免控制字符在 JSON 中失真) */
  data: string;
}

export interface ResizeSessionPayload {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface CloseSessionPayload {
  sessionId: string;
}

// ──────────────────────────────────────────────────────────────────
// Session 域 event payload
// ──────────────────────────────────────────────────────────────────

/**
 * evt:session:output — PTY 输出字节流。
 * 仅推送给 owner window (CP-1 即创建该 session 的 window)。
 */
export interface SessionOutputPayload {
  sessionId: string;
  /** base64 编码的字节流 */
  data: string;
  /** 自该 session 创建以来的事件序号,单调递增,从 0 开始 */
  seq: number;
}

/**
 * evt:session:exited — PTY 进程退出。
 *
 * 注:node-pty 给的 signal 是数字 (POSIX signal number),Windows 上通常没有
 * 真正的 signal 概念,exitCode 才是主要信息。CP-3 会把数字翻译成 'SIGTERM' 等
 * 字符串名称以便日志可读。
 */
export interface SessionExitedPayload {
  sessionId: string;
  exitCode: number;
  signal?: number;
}
