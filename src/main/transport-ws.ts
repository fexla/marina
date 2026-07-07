/**
 * @file src/main/transport-ws.ts
 * @purpose Transport-Ws 实现:WS server + WS ClientTransport。
 *   daemon 侧用 WsServer 监听;每个远程 WS 连接包成 ClientTransport 注册进
 *   ClientRegistry(与 local client 同构)。client 侧(Transport-Ws client,阶段1.7)
 *   用对称的帧编解码连远程 daemon。
 *
 * @关键设计:
 * - 帧格式:命令 / 响应 / 事件 三种 JSON 帧(见 WsFrame),字段对齐
 *   ipc-protocol §2.3/2.4 信封。client→daemon 发 command;daemon→client 发
 *   response(对应某 requestId)和 event(广播/定向)。
 * - PTY 字节流(evt:session:output):本阶段先走 JSON event 帧(简单、loopback
 *   自测够用);binary frame 优化(对齐 ipc-protocol §2.6 "走 WS binary frame")
 *   标 TODO,性能压测阶段再换。
 * - WsClientTransport: ClientTransport 的 WS 实现,send 把 EventEnvelope 包成
 *   事件帧 JSON 发出。
 * - WsServer: 事件驱动(start/stop + onClientConnected/onMessage/onClientDisconnected)。
 *   阶段1.3 骨架:接受连接立即分配随机 clientId(裸 ws://,loopback 自测用)。
 *   握手(token 认证 + clientId 复用)与 TLS(wss:// + 自签)在阶段1.4 / 阶段2 加入,
 *   届时 connection 处理替换为先握手再 emit connected。
 *
 * @对应文档:ipc-protocol.md §2.6 Transport-Ws + §4 Handshake;软件定义书 §14.9
 *
 * @不要在这里做的事:
 * - 不要做 token 认证(上层/阶段1.4 在 onClientConnected 回调里做)
 * - 不要做 dispatcher(handleCommand 在 ipc.ts,本文件只管传输 + 帧编解码)
 * - 不要做业务逻辑(本文件是传输层,与 ClientRegistry 同层)
 */

import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { ClientTransport } from './client-registry';
import type { CommandEnvelope, EventEnvelope } from '../shared/protocol';
import { logger } from './logger';

// ──────────────────────────────────────────────────────────────────
// 帧格式(WS 上跑的 JSON 帧)
// ──────────────────────────────────────────────────────────────────

/**
 * client → daemon:发起一个命令(对应 ipcMain.handle 的 WS 版)。
 * envelope.clientId 在握手后由 daemon 填(阶段1.4);握手前 client 可留空,
 * daemon 用连接绑定的 clientId 覆盖。
 */
export interface WsCommandFrame {
  type: 'command';
  channel: string;
  envelope: CommandEnvelope;
}

/**
 * daemon → client:命令的响应。requestId 对应 WsCommandFrame.envelope.requestId,
 * 让 client 端的 invoke() promise resolve/reject。
 */
export interface WsResponseFrame {
  type: 'response';
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

/**
 * daemon → client:推一个事件(广播或定向)。对应 webContents.send 的 WS 版。
 * envelope 已是 EventEnvelope(由 ClientRegistry.broadcast/sendTo 构造)。
 */
export interface WsEventFrame {
  type: 'event';
  channel: string;
  envelope: EventEnvelope;
}

export type WsFrame = WsCommandFrame | WsResponseFrame | WsEventFrame;

/**
 * 解析一帧。非法 JSON / 结构不全 → 返回 null(调用方静默丢弃,
 * 与"单个 client 发垃圾帧不应拖垮 daemon"语义一致)。
 */
export function parseFrame(data: unknown): WsFrame | null {
  let obj: unknown;
  try {
    obj = typeof data === 'string' ? JSON.parse(data) : JSON.parse(String(data));
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const f = obj as { type?: unknown };
  if (f.type === 'command') {
    const c = obj as WsCommandFrame;
    if (typeof c.channel === 'string' && c.envelope && typeof c.envelope === 'object') {
      return c;
    }
    return null;
  }
  if (f.type === 'response') {
    const r = obj as WsResponseFrame;
    if (typeof r.requestId === 'string' && typeof r.ok === 'boolean') {
      return r;
    }
    return null;
  }
  if (f.type === 'event') {
    const e = obj as WsEventFrame;
    if (typeof e.channel === 'string' && e.envelope && typeof e.envelope === 'object') {
      return e;
    }
    return null;
  }
  return null;
}

/** 序列化一帧为 WS 字符串(ws.send 接受 string)。 */
export function serializeFrame(frame: WsFrame): string {
  return JSON.stringify(frame);
}

// ──────────────────────────────────────────────────────────────────
// WS ClientTransport
// ──────────────────────────────────────────────────────────────────

/**
 * 把一个已打开的 ws WebSocket 包成 ClientTransport。
 * send 把 (channel, EventEnvelope) 包成事件帧 JSON 发出。
 * readyState 非 OPEN 时静默丢弃(连接正在关闭,registry.safeSend 会兜底吞错,
 * 但这里提前 guard 避免 ws.send 抛 InvalidStateError)。
 */
export function createWsClientTransport(
  ws: WebSocket,
  clientId: string,
): ClientTransport {
  return {
    clientId,
    send(channel, envelope) {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(serializeFrame({ type: 'event', channel, envelope }));
    },
  };
}

// ──────────────────────────────────────────────────────────────────
// WsServer(daemon 侧)
// ──────────────────────────────────────────────────────────────────

export type ClientConnectedHandler = (transport: ClientTransport) => void;
export type ClientMessageHandler = (clientId: string, frame: WsFrame) => void;
export type ClientDisconnectedHandler = (clientId: string) => void;

/** 握手结果:通过则返回分配/复用的 clientId;失败返回 error(连接被关闭)。 */
export type AuthResult = { clientId: string } | { error: string };
/** 认证处理器:接收 client 首帧原始数据,自行解析+校验 token。 */
export type AuthHandler = (firstMessage: unknown) => AuthResult;

/**
 * daemon 侧的 WS server。事件驱动:上层(daemon 入口)注册三个回调,
 * 把 connected → 注册进 ClientRegistry、message → 走 dispatcher、
 * disconnected → registry.remove + session 自动 release。
 *
 * 端口 0 = 让 OS 分配随机端口(loopback 自测 / 测试用),start() 返回实际端口。
 */
export class WsServer {
  private wss: WebSocketServer | null = null;
  private readonly connectedHandlers: ClientConnectedHandler[] = [];
  private readonly messageHandlers: ClientMessageHandler[] = [];
  private readonly disconnectedHandlers: ClientDisconnectedHandler[] = [];
  /** clientId → ws,用于定向 send(由 ClientTransport 持有 ws,这里仅记映射供上层查询)。 */
  private readonly wsByClient = new Map<string, WebSocket>();
  /** 可选认证处理器;设置后新连接必须先握手通过才注册。 */
  private authHandler?: AuthHandler;

  /**
   * 启动 WS server。
   * @param port 监听端口;0 = OS 随机分配(loopback 自测/测试)。
   * @returns 实际监听端口(端口 0 时为 OS 分配值)。
   * @throws Error 端口被占用 / 已启动。
   */
  start(port: number): Promise<number> {
    if (this.wss) throw new Error('[transport-ws] WsServer 已启动');
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ port });
      this.wss = wss;
      wss.on('error', reject);
      wss.on('listening', () => {
        const addr = wss.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : port;
        resolve(actualPort);
      });
      wss.on('connection', (ws) => this.handleConnection(ws));
    });
  }

  /** 停止 server,关闭所有连接。幂等。 */
  /**
   * 强制断开所有已连 client(不关 server)。
   * 用于 token 重置:已连 client 被踢,重连时需用新 token 握手(旧 token 会被拒)。
   */
  closeAllClients(): void {
    const wss = this.wss;
    if (!wss) return;
    wss.clients.forEach((c) => {
      try {
        c.terminate();
      } catch {
        /* 忽略单个 terminate 失败 */
      }
    });
  }

  stop(): Promise<void> {
    const wss = this.wss;
    if (!wss) return Promise.resolve();
    this.wss = null;
    this.wsByClient.clear();
    return new Promise((resolve) => {
      // 先强制断开所有现有连接(避免 wss.close 等待它们而挂起;测试/daemon
      // 关闭时不应被僵死 client 拖住),再关 server。
      wss.clients.forEach((c) => {
        try {
          c.terminate();
        } catch {
          /* 忽略单个 terminate 失败 */
        }
      });
      wss.close(() => resolve());
    });
  }

  onClientConnected(cb: ClientConnectedHandler): void {
    this.connectedHandlers.push(cb);
  }
  onMessage(cb: ClientMessageHandler): void {
    this.messageHandlers.push(cb);
  }
  onClientDisconnected(cb: ClientDisconnectedHandler): void {
    this.disconnectedHandlers.push(cb);
  }

  /** 当前已连接的 client 数(供 daemon UI / 上限检查)。 */
  clientCount(): number {
    return this.wsByClient.size;
  }

  /**
   * 定向发任意帧给指定 client(供 daemon 发 response / 下行 command)。
   * 找不到 client 或连接已关 → 返回 false(调用方可据此知道 response 丢失)。
   */
  sendFrame(clientId: string, frame: WsFrame): boolean {
    const ws = this.wsByClient.get(clientId);
    if (!ws || ws.readyState !== ws.OPEN) return false;
    ws.send(serializeFrame(frame));
    return true;
  }

  /**
   * 设置认证处理器。设置后,新连接必须先通过握手:发首帧 → authHandler 校验 →
   * 返回 { clientId } 才注册并 emit connected;返回 { error } 关闭连接(4003)。
   * 未设置时,连接立即分配随机 clientId(1.3 行为,loopback 自测/测试用)。
   * 首帧 10s 超时未发 → 关闭(4001)。
   */
  setAuthHandler(fn: AuthHandler): void {
    this.authHandler = fn;
  }

  private handleConnection(ws: WebSocket): void {
    if (this.authHandler) {
      this.handleAuthenticatingConnection(ws);
    } else {
      // 无 authHandler:1.3 行为,立即注册(随机 clientId)。
      this.registerClient(ws, randomUUID());
    }
  }

  /** 已通过认证(或无需认证):注册进 registry + 挂消息/关闭处理 + emit connected。 */
  private registerClient(ws: WebSocket, clientId: string): void {
    this.wsByClient.set(clientId, ws);
    const transport = createWsClientTransport(ws, clientId);

    ws.on('message', (data) => {
      const frame = parseFrame(data);
      if (!frame) return; // 非法帧静默丢弃
      for (const h of this.messageHandlers) {
        try {
          h(clientId, frame);
        } catch (err) {
          // 单个 handler 抛错不影响其他 handler / 其他 client。
          console.warn(
            `[transport-ws] message handler 抛错 clientId="${clientId}"(已忽略):`,
            err,
          );
        }
      }
    });

    ws.on('close', () => {
      this.wsByClient.delete(clientId);
      for (const h of this.disconnectedHandlers) {
        try {
          h(clientId);
        } catch (err) {
          console.warn(
            `[transport-ws] disconnected handler 抛错 clientId="${clientId}"(已忽略):`,
            err,
          );
        }
      }
    });

    ws.on('error', (err) => {
      // ws 错误通常伴随 close,这里只记录,不单独处理(避免重复 disconnected)。
      console.warn(`[transport-ws] ws error clientId="${clientId}":`, err);
    });

    for (const h of this.connectedHandlers) {
      h(transport);
    }
  }

  /**
   * 握手流程:等首帧 → authHandler 校验。
   *  - 通过 → registerClient(返回的 clientId)
   *  - 失败 → 关闭(4003 + error)
   *  - 10s 超时未发首帧 → 关闭(4001)
   * 握手期间的首帧被消费,不进 messageHandlers;通过后后续消息才走 dispatcher(阶段1.5)。
   */
  private handleAuthenticatingConnection(ws: WebSocket): void {
    let settled = false;
    // 用结构化 logger 落 main.log(不是 console.info):错误页 AUTH_TIMEOUT 诊断
    // 明确要求用户“搜 main.log transport-ws”,console 输出不会进 main.log
    // (打包 / 独立 daemon 模式下进程无可见 stdout),用 logger 才能真正写到磁盘。
    logger.info('transport-ws', 'new client connection, waiting for auth frame');
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      logger.warn('transport-ws', 'auth timeout (no first frame in 10s), closing 4001');
      try {
        ws.close(4001, 'auth timeout');
      } catch {
        /* 已关闭 */
      }
    }, 10000);

    const onFirst = (data: unknown): void => {
      if (settled) return;
      logger.info('transport-ws', 'received first frame, running auth handler');
      const result = this.authHandler!(data);
      if ('error' in result) {
        settled = true;
        clearTimeout(timer);
        logger.warn('transport-ws', `auth rejected: ${result.error}, closing 4003`);
        try {
          ws.close(4003, result.error);
        } catch {
          /* 已关闭 */
        }
        return;
      }
      settled = true;
      clearTimeout(timer);
      ws.off('message', onFirst);
      logger.info('transport-ws', `auth ok, clientId=${result.clientId}`);
      this.registerClient(ws, result.clientId);
    };
    ws.on('message', onFirst);
  }
}
