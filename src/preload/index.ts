/**
 * @file src/preload/index.ts
 * @purpose Preload 脚本,运行在每个 BrowserWindow 的隔离上下文中。
 *   通过 contextBridge 把白名单的 IPC 能力暴露给 renderer (window.api)。
 *
 * @关键设计:
 * - contextIsolation 启用,sandbox 关闭 (因 main 用 node-pty 等原生模块)
 * - 不直接暴露 ipcRenderer 给 renderer,只暴露包装好的 invoke / on
 * - 暴露 windowId 与 windowNumber (从 URL query 解析,见 ipc-protocol.md 2.2)
 * - 这里不写业务逻辑,只是一座最薄的桥
 *
 * @对应文档章节: docs/ipc-protocol.md 全部;软件定义书.md 9.2.2
 *
 * @AGENTS.md 5.1: preload 不需要单测 (简单转发)。
 *
 * @CP-1 阶段:
 * 暴露 windowId / windowNumber / invoke / on / getProtocolVersion。
 * 完整业务方法 (session/bookmark/template) 在 CP-2/3/4 加入。
 */
import { contextBridge, ipcRenderer } from 'electron';
import { COMMAND_CHANNELS, type CommandEnvelope } from '@shared/protocol';

/**
 * 从 URL query string 提取窗口元数据。
 * Main 创建 BrowserWindow 时附加 ?windowId=...&windowNumber=...
 */
function readWindowParams(): { windowId: string; windowNumber: number } {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('windowId') ?? 'bootstrap';
  const numStr = params.get('windowNumber');
  const num = numStr ? Number.parseInt(numStr, 10) : 0;
  return {
    windowId: id,
    windowNumber: Number.isFinite(num) && num > 0 ? num : 0,
  };
}

const { windowId, windowNumber } = readWindowParams();

/**
 * 包装 ipcRenderer.invoke,自动附加 windowId / requestId / payload 信封。
 */
async function invoke<P, R>(channel: string, payload: P): Promise<R> {
  const envelope: CommandEnvelope<P> = {
    windowId,
    requestId: crypto.randomUUID(),
    payload,
  };
  return ipcRenderer.invoke(channel, envelope);
}

/**
 * 订阅 main 推送的事件,返回取消订阅函数。
 * handler 收到的是事件信封的 payload 部分,信封外壳在此处剥离。
 */
function on<P>(channel: string, handler: (payload: P) => void): () => void {
  const wrapped = (_event: unknown, envelope: { payload: P } | undefined): void => {
    if (envelope && typeof envelope === 'object' && 'payload' in envelope) {
      handler(envelope.payload);
    }
  };
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.off(channel, wrapped);
}

/**
 * 暴露给 renderer 的 API。renderer 通过 window.api 访问。
 * 类型在 src/renderer/global.d.ts 中声明。
 */
const api = {
  /** 当前窗口 UUID (CP-1 占位 'bootstrap',WindowManager 创建时为真实 UUID) */
  windowId,
  /** 当前窗口编号 (Window N),0 表示未由 WindowManager 分配 */
  windowNumber,

  /** 协议版本握手 — handshake 第一步 (ipc-protocol.md 第 4 章) */
  getProtocolVersion: (): Promise<{ protocolVersion: number; buildVersion: string }> =>
    invoke(COMMAND_CHANNELS.APP_GET_PROTOCOL_VERSION, undefined),

  /** 通用命令调用,channel 名从 @shared/protocol 取常量 */
  invoke,

  /** 订阅事件 */
  on,
} as const;

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
