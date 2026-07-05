/**
 * @file src/preload/remote-transport.ts
 * @purpose Transport-Ws 的 client 端实现。当 Marina 作为远程 client 连接另一台
 *   机器上的 Marina daemon 时,preload 的 invoke/on 不走 Electron IPC,而走这个
 *   RemoteTransport(WebSocket 连 daemon)。
 *
 * @关键设计:
 * - 与 src/main/transport-ws.ts 的帧格式对称:command(client→daemon)/
 *   response(daemon→client)/ event(daemon→client)。
 * - invoke(channel, payload):发 command 帧(带 requestId),返回 Promise;
 *   收到匹配 requestId 的 response 帧 resolve/reject。
 * - on(channel, cb):订阅 event 帧;cb 收到 envelope.payload。
 * - 握手:connect 后立即发 auth 帧;daemon 通过后回 __auth-ok__ event(含 clientId);
 *   ready Promise resolve。client 拿到 clientId 后,后续 command 的 envelope
 *   填它(虽然 daemon 端会覆盖,但显式填更清晰)。
 * - WebSocket 实现通过依赖注入(WSLike 接口):生产用浏览器 WebSocket,
 *   测试用 fake。避免 preload 代码强耦合浏览器 API,便于单测。
 *
 * @对应文档:ipc-protocol.md §2.6 Transport-Ws + §4 Handshake;软件定义书 §14.9
 *
 * @不要在这里做的事:
 * - 不要做重连/backoff(阶段1.3 / 阶段3)
 * - 不要做业务逻辑(本文件只管帧编解码 + invoke/on 语义)
 */

import { randomUUID } from 'node:crypto';

/** 帧类型,与 transport-ws.ts 对称(import 会拉 main 依赖链,这里重声明)。 */
interface ClientCommandFrame {
  type: 'command';
  channel: string;
  envelope: { windowId: string; requestId: string; payload: unknown };
}
interface ClientResponseFrame {
  type: 'response';
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}
interface ClientEventFrame {
  type: 'event';
  channel: string;
  envelope: { eventId: string; timestamp: number; payload: unknown };
}
type ClientFrame = ClientCommandFrame | ClientResponseFrame | ClientEventFrame;

/** WebSocket-like 接口(浏览器 WebSocket 满足;测试用 fake)。 */
export interface WSLike {
  readyState: number;
  OPEN: number;
  send(data: string): void;
  close(): void;
  // 事件钩子(调用方挂):
  onopen?: (() => void) | null;
  onmessage?: ((ev: { data: unknown }) => void) | null;
  onclose?: (() => void) | null;
  onerror?: ((err: unknown) => void) | null;
}

/** WSLike 工厂(生产 = () => new WebSocket(url))。 */
export type WsFactory = (url: string) => WSLike;

export interface RemoteTransportOptions {
  url: string;
  token: string;
  wsFactory: WsFactory;
  /** 握手超时(ms),默认 10000。 */
  authTimeoutMs?: number;
  /** 可选:连接断开回调(阶段3 重连用)。 */
  onDisconnect?: () => void;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 远程 client 的 invoke/on 实现。
 * 生命周期:new RemoteTransport(opts) → 自动 connect + auth → ready Promise →
 * invoke/on 可用 → close()。
 */
export class RemoteTransport {
  private ws: WSLike;
  private clientId: string | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  private readonly readyResolvers: Array<() => void> = [];
  private readonly readyRejecters: Array<(e: Error) => void> = [];
  private closed = false;

  readonly ready: Promise<void>;

  constructor(private readonly opts: RemoteTransportOptions) {
    this.ws = opts.wsFactory(opts.url);
    this.ws.onopen = () => this.handleOpen();
    this.ws.onmessage = (ev) => this.handleMessage(ev.data);
    this.ws.onclose = () => this.handleClose();
    this.ws.onerror = (e) => this.handleError(e);
    this.ready = new Promise((resolve, reject) => {
      this.readyResolvers.push(resolve);
      this.readyRejecters.push(reject);
    });
    // 握手超时:超时未收到 __auth-ok__ 则失败。
    const to = opts.authTimeoutMs ?? 10000;
    setTimeout(() => {
      if (this.clientId === null && !this.closed) {
        this.failReady(new Error('[remote-transport] 握手超时(未收到 __auth-ok__)'));
      }
    }, to);
  }

  /** 握手成功后的 clientId(daemon 分配)。握手前为 null。 */
  getClientId(): string | null {
    return this.clientId;
  }

  /**
   * 发起一个命令,返回 Promise。
   * 与 preload 本地 invoke 签名一致:invoke(channel, payload) → result。
   */
  invoke<P = unknown>(channel: string, payload: unknown): Promise<P> {
    if (this.closed) return Promise.reject(new Error('[remote-transport] 已关闭'));
    const requestId = randomUUID();
    const envelope = { windowId: this.clientId ?? '', requestId, payload };
    const frame: ClientCommandFrame = { type: 'command', channel, envelope };
    return new Promise<P>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(requestId)) {
          this.pending.delete(requestId);
          reject(new Error(`[remote-transport] invoke 超时 channel="${channel}"`));
        }
      }, 30000);
      this.pending.set(requestId, {
        resolve: (r) => resolve(r as P),
        reject,
        timer,
      });
      this.ws.send(JSON.stringify(frame));
    });
  }

  /** 订阅一个 event channel。返回取消订阅函数。 */
  on(channel: string, cb: (payload: unknown) => void): () => void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(cb);
    return () => set!.delete(cb);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      /* 忽略 */
    }
    // reject 所有 pending invoke
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('[remote-transport] 连接关闭'));
    }
    this.pending.clear();
  }

  // ── 内部 ──

  private handleOpen(): void {
    // 发 auth 帧。daemon authHandler 校验 token,通过后回 __auth-ok__ event。
    const authFrame = { type: 'auth', token: this.opts.token };
    try {
      this.ws.send(JSON.stringify(authFrame));
    } catch (err) {
      this.failReady(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private handleMessage(data: unknown): void {
    let frame: ClientFrame;
    try {
      frame = typeof data === 'string' ? JSON.parse(data) : JSON.parse(String(data));
    } catch {
      return; // 非法帧静默丢弃
    }
    if (frame.type === 'response') {
      const p = this.pending.get(frame.requestId);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(frame.requestId);
        if (frame.ok) p.resolve(frame.result);
        else p.reject(Object.assign(new Error(frame.error?.message ?? 'remote error'), { code: frame.error?.code }));
      }
      return;
    }
    if (frame.type === 'event') {
      // __auth-ok__:握手完成,拿 clientId
      if (frame.channel === '__auth-ok__') {
        const payload = frame.envelope.payload as { clientId?: string };
        if (typeof payload?.clientId === 'string' && this.clientId === null) {
          this.clientId = payload.clientId;
          for (const r of this.readyResolvers) r();
        }
        return;
      }
      const set = this.listeners.get(frame.channel);
      if (set) for (const cb of set) cb(frame.envelope.payload);
      return;
    }
    // command 帧从 daemon 发来?daemon 不发 command 给 client,忽略。
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.failReady(new Error('[remote-transport] 连接在握手前关闭'));
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('[remote-transport] 连接关闭'));
    }
    this.pending.clear();
    this.opts.onDisconnect?.();
  }

  private handleError(e: unknown): void {
    if (this.clientId === null) {
      this.failReady(e instanceof Error ? e : new Error('[remote-transport] ws error'));
    }
  }

  private failReady(err: Error): void {
    for (const r of this.readyRejecters) r(err);
  }
}
