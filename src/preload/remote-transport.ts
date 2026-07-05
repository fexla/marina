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
 * - 不要做业务逻辑(本文件只管帧编解码 + invoke/on 语义 + 重连/backoff)
 *
 * @重连(阶段3):握手成功后断线 → 指数 backoff 重连(1s→2s→...→30s max),
 *   重连时 auth 帧带 resumeClientId,daemon 校验后复用同 clientId → 上层
 *   onReconnectSuccess reload/重拉 snapshot。握手前断线不重连(算初始化失败)。
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
  /** 握手超时(ms),默认 10000。仅首次握手用(超时 failReady);重连靠 ws 自身 close 重试。 */
  authTimeoutMs?: number;
  /** 自动重连开关(默认 true)。仅在握手成功后断线才重连;握手前失败不重连(算初始化失败)。 */
  autoReconnect?: boolean;
  /** 最大重连尝试次数(默认 10)。达上限后放弃,fire onReconnectFail,transport 进终态 closed。 */
  maxReconnectAttempts?: number;
  /** 重连 backoff 基底 ms(默认 1000)。实际延迟 = min(base * 2^attempt, 30000)。测试用小值加速。 */
  reconnectBaseMs?: number;
  /** 重连开始(首次断线 → 进入重连循环)。 */
  onReconnectStart?: () => void;
  /** 重连成功(重新握手通过,clientId 复用)。上层通常据此 reload 或重拉 snapshot。 */
  onReconnectSuccess?: () => void;
  /** 重连彻底失败(达上限)。transport 进终态 closed,不再重试。 */
  onReconnectFail?: (reason: string) => void;
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
  private ws!: WSLike;
  private clientId: string | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  private readonly readyResolvers: Array<() => void> = [];
  private readonly readyRejecters: Array<(e: Error) => void> = [];
  /** 终态:用户主动 close() 或 重连彻底失败。此后 invoke 全 reject,不复活。 */
  private closed = false;
  /** 用户主动 close() → 终态。handleClose 据此不启动重连。 */
  private manuallyClosed = false;
  /** 处于重连循环(曾握手成功后断线 → 正在 backoff 重试)。此期间 invoke reject('重连中')。 */
  private reconnecting = false;
  /** 当前重连尝试次数(0=首次断,成功后清 0)。 */
  private reconnectAttempt = 0;
  /** 重连 backoff 定时器。 */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** 首次握手超时定时器(超时 failReady)。 */
  private authTimer: ReturnType<typeof setTimeout> | null = null;

  readonly ready: Promise<void>;

  constructor(private readonly opts: RemoteTransportOptions) {
    this.ready = new Promise((resolve, reject) => {
      this.readyResolvers.push(resolve);
      this.readyRejecters.push(reject);
    });
    this.connectWs(true);
  }

  /**
   * 建立/重建 ws 连接 + 挂 handlers + 发 auth 帧(handleOpen)。
   * @param isFirst true=首次连接(设握手超时);false=重连(靠 ws 自身 close 重试,不设超时)。
   */
  private connectWs(isFirst: boolean): void {
    this.ws = this.opts.wsFactory(this.opts.url);
    this.ws.onopen = () => this.handleOpen();
    this.ws.onmessage = (ev) => this.handleMessage(ev.data);
    this.ws.onclose = () => this.handleClose();
    this.ws.onerror = (e) => this.handleError(e);
    if (isFirst) {
      // 仅首次握手设超时(初始化卡住要明确失败)。重连不设:靠 ws close 触发重试。
      if (this.authTimer) clearTimeout(this.authTimer);
      const to = this.opts.authTimeoutMs ?? 10000;
      this.authTimer = setTimeout(() => {
        if (this.clientId === null && !this.closed && !this.manuallyClosed) {
          this.failReady(new Error('[remote-transport] 握手超时(未收到 __auth-ok__)'));
        }
      }, to);
    }
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
    if (this.reconnecting) return Promise.reject(new Error('[remote-transport] 重连中'));
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
    this.manuallyClosed = true;
    this.closed = true;
    this.reconnecting = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.authTimer) { clearTimeout(this.authTimer); this.authTimer = null; }
    try {
      this.ws.close();
    } catch {
      /* 忽略 */
    }
    this.rejectPending('连接关闭');
  }

  /** reject 所有 pending invoke 并清空(断线/重连/主动关共用)。 */
  private rejectPending(reason: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`[remote-transport] ${reason}`));
    }
    this.pending.clear();
  }

  // ── 内部 ──

  private handleOpen(): void {
    // 发 auth 帧。daemon authHandler 校验 token,通过后回 __auth-ok__ event。
    // 阶段3:重连时带 resumeClientId,daemon 校验后复用同 clientId(ADR-014)。
    const authFrame: { type: 'auth'; token: string; resumeClientId?: string } = {
      type: 'auth',
      token: this.opts.token,
    };
    if (this.clientId !== null) authFrame.resumeClientId = this.clientId;
    try {
      this.ws.send(JSON.stringify(authFrame));
    } catch (err) {
      if (this.reconnecting) {
        // 重连中发 auth 失败 → 关 ws 触发 handleClose 再试
        try { this.ws.close(); } catch { /* 忽略 */ }
      } else {
        this.failReady(err instanceof Error ? err : new Error(String(err)));
      }
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
        if (typeof payload?.clientId === 'string') {
          const wasReconnecting = this.reconnecting;
          this.clientId = payload.clientId;
          if (wasReconnecting) {
            // 重连成功:退出重连循环,清 attempt/timer,通知上层(通常 reload)。
            // 阶段3 ADR-014:daemon 复用同 clientId → client 身份连续。
            this.reconnecting = false;
            this.reconnectAttempt = 0;
            if (this.authTimer) { clearTimeout(this.authTimer); this.authTimer = null; }
            this.opts.onReconnectSuccess?.();
          } else if (this.readyResolvers.length > 0) {
            // 首次握手:resolve ready(仅一次,重复 auth-ok 无害)
            for (const r of this.readyResolvers) r();
          }
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
    if (this.closed || this.manuallyClosed) return;
    // 清理握手超时定时器(无论哪条路径都不再需要)
    if (this.authTimer) { clearTimeout(this.authTimer); this.authTimer = null; }
    // 握手前断(clientId 还没拿到 + 不在重连)= 初始化失败,不重连
    if (this.clientId === null && !this.reconnecting) {
      this.closed = true;
      this.failReady(new Error('[remote-transport] 连接在握手前关闭'));
      this.rejectPending('连接在握手前关闭');
      return;
    }
    // 已认证或重连中断 → 清 pending,进入/继续重连循环
    this.rejectPending('连接关闭(将重连)');
    if (this.reconnecting) {
      // 重连中的 ws 又断了 → 增 attempt 再试
      this.reconnectAttempt += 1;
    } else {
      // 首次断 → 启动重连循环
      this.reconnecting = true;
      this.opts.onReconnectStart?.();
    }
    this.scheduleReconnect();
  }

  /**
   * 安排下一次重连(指数 backoff:1s→2s→4s→…→30s max)。
   * 超过 maxReconnectAttempts → 放弃,进终态 closed,fire onReconnectFail。
   */
  private scheduleReconnect(): void {
    const max = this.opts.maxReconnectAttempts ?? 10;
    if (this.reconnectAttempt >= max) {
      this.reconnecting = false;
      this.closed = true;
      this.opts.onReconnectFail?.(`重连达上限(${max} 次)`);
      return;
    }
    const base = this.opts.reconnectBaseMs ?? 1000;
    const delay = Math.min(base * 2 ** this.reconnectAttempt, 30000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed || this.manuallyClosed) return;
      this.connectWs(false);
    }, delay);
  }

  private handleError(e: unknown): void {
    // ws error 通常伴随 close;这里只在首次握手前失败时 failReady,
    // 重连中/已认证的错误由 handleClose 处理(避免重复触发)。
    if (this.clientId === null && !this.reconnecting) {
      this.failReady(e instanceof Error ? e : new Error('[remote-transport] ws error'));
    }
  }

  private failReady(err: Error): void {
    for (const r of this.readyRejecters) r(err);
  }
}
