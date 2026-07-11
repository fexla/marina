/**
 * @file src/main/remote-daemon.ts
 * @purpose daemon 侧的远程后端协调器。把 WsServer(传输)、ClientRegistry(广播
 *   目标表)、SessionManager(session 生命周期)三者串起来,实现:
 *   1. 握手:client 连上 → 发首帧 token → 校验 → 分配 clientId → 注册 registry
 *   2. 自动 release:WS 断开 → 该 client 持有的 session 全部 release(owner 置 null)
 *
 * @关键设计:
 * - token 校验由 setAuthHandler 完成;RemoteDaemon 提供握手首帧的解析
 *   (期望 { type:'auth', token } JSON)。
 * - clientId 分配:阶段1 loopback 用随机 id;阶段2 token→clientId 映射(凭 token
 *   认主、断线重连复用 clientId)见软件定义书 §14.9.4。
 * - 自动 release 复用 SessionManager.handleWindowClosed(clientId):语义上
 *   "client 消失(窗口关/WS 断)→ 其 session release"完全一致。注意:本阶段
 *   SessionManager 的 owner 字段仍叫 ownerWindowId(v1 名),WS client 的 owner
 *   暂存其 clientId(字段语义扩展,完整 ownerWindowId→ownerClientId 重命名留
 *   阶段1.5/1.7 与 dispatcher 升级时一并做)。
 * - dispatcher(WS command → handleCommand)在阶段1.5 接入;本文件只管握手 + 注册 +
 *   自动 release,不处理 command。
 *
 * @对应文档:ipc-protocol.md §2.6 Transport-Ws + §4 Handshake;软件定义书 §14.9
 *
 * @不要在这里做的事:
 * - 不要实现具体 command handler(统一委托 ipc.ts dispatcher)
 * - 不要把 local-control 命令转发给 dispatcher:窗口/剪贴板/客户端连接凭据
 *   属于客户端本机，且 REMOTE_PROFILE_GET_CONNECTION 会返回解密后的密码
 * - 不要做 TLS/配对 UI(阶段2)
 */
import { randomUUID } from 'node:crypto';
import type { ClientRegistry, ClientTransport } from './client-registry';
import type { SessionManager } from './session-manager';
import type { WsServer, AuthHandler, AuthResult, WsCommandFrame } from './transport-ws';
import { getCommandRouting, type CommandEnvelope } from '../shared/protocol';

/** 握手首帧的期望 JSON 结构(client → daemon)。 */
export interface AuthFrame {
  type: 'auth';
  token: string;
  /** 可选:重连时带上原 clientId,daemon 校验 token 后复用(阶段2)。 */
  resumeClientId?: string;
}

/** 解析握手首帧。非合法 auth 帧 → null(调用方据此拒绝连接)。 */
export function parseAuthFrame(data: unknown): AuthFrame | null {
  let obj: unknown;
  try {
    obj = typeof data === 'string' ? JSON.parse(data) : JSON.parse(String(data));
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const f = obj as { type?: unknown; token?: unknown };
  if (f.type === 'auth' && typeof f.token === 'string') {
    return obj as AuthFrame;
  }
  return null;
}

/**
 * dispatcher 入口签名(通常传 ipc.ts 的 dispatchCommand)。
 * 用依赖注入而非直接 import ipc.ts,避免 remote-daemon 测试拉入 electron 全链。
 */
export type DispatchFn = (
  channel: string,
  envelope: CommandEnvelope,
) => Promise<
  { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } }
>;

export interface RemoteDaemonDeps {
  wsServer: WsServer;
  registry: ClientRegistry;
  sessionManager: SessionManager;
  /** daemon 启动时持久化生成的 token;client 必须带它握手。 */
  token: string;
  /** dispatcher 入口:收到 command 帧后调它,把结果包成 response 帧发回 client。 */
  dispatch: DispatchFn;
  /** 可选:握手通过的回调(注册完 registry 后触发),daemon UI 可据此更新"当前连接"。 */
  onClientAuthenticated?: (clientId: string) => void;
  /** 可选:断开回调,daemon UI 更新 + 日志。 */
  onClientGone?: (clientId: string) => void;
  /**
   * 断线后保留 client 身份/Session owner 的重连宽限期。生产默认 10 秒；
   * 测试可传较小值。宽限期内同 clientId 重连会取消 release。
   */
  reconnectGraceMs?: number;
}

/**
 * 远程后端协调器。start() 后开始服务;stop() 交给调用方(通常停 WsServer)。
 *
 * 生命周期:daemon 启动 → RemoteDaemon.install() 挂回调 → WsServer.start(port)。
 * 每个 WS client:连接 → 握手(authHandler) → 通过则 registry.add →
 * command 走 dispatcher → WS 断开后进入短暂重连宽限期 → 超时才 release owner。
 */
export class RemoteDaemon {
  /** daemon 已签发且仍可 resume 的 client 身份。每个远程窗口各有一个。 */
  private readonly issuedClientIds = new Set<string>();

  /** 断线宽限期计时器；同 id 重连时取消，超时才把 Session 转为无主。 */
  private readonly releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private readonly reconnectGraceMs: number;

  constructor(private readonly deps: RemoteDaemonDeps) {
    this.reconnectGraceMs = deps.reconnectGraceMs ?? 10_000;
  }

  /**
   * 挂载握手/连接/断开回调到 WsServer。应在 WsServer.start 前调用。
   * 内部:
   *  - setAuthHandler:解析 auth 帧 + 校验 token + 分配 clientId
   *  - onClientConnected:已由 authHandler 路径注册(此处仅触发 onClientAuthenticated)
   *  - onClientDisconnected:registry.remove + 延迟 handleWindowClosed(允许短线 resume)
   */
  install(): void {
    const { wsServer, registry, sessionManager } = this.deps;

    wsServer.setAuthHandler(this.makeAuthHandler());
    wsServer.onClientConnected((transport) => {
      // authHandler 通过 → registerClient 已在 WsServer 内部把 transport 加入?
      // 不:WsServer 的 registerClient 只挂消息/关闭处理 + emit connected,
      // 它不知道 ClientRegistry。registry.add 在这里做。
      this.registerAuthenticated(transport);
    });
    wsServer.onClientDisconnected((clientId) => {
      registry.remove(clientId);
      this.deps.onClientGone?.(clientId);

      // 网络闪断不能立即清 owner:client 会带 resumeClientId 重连；若此处立刻
      // handleWindowClosed，即使重用了同一 id，owner 也已经被擦掉。宽限期内
      // Session 仍归该 id，输出继续进 scrollback；重连后 reload 会补拉。
      if (!this.issuedClientIds.has(clientId)) return;
      const oldTimer = this.releaseTimers.get(clientId);
      if (oldTimer) clearTimeout(oldTimer);
      const timer = setTimeout(() => {
        this.releaseTimers.delete(clientId);
        if (!this.issuedClientIds.delete(clientId)) return;
        sessionManager.handleWindowClosed(clientId);
      }, this.reconnectGraceMs);
      // 宽限计时器不应单独阻止 headless daemon / test process 退出。
      timer.unref?.();
      this.releaseTimers.set(clientId, timer);
    });
    // command 帧 → dispatcher → response 帧发回。其他类型(response/event 从
    // client 发来)忽略:client 只该发 command。
    wsServer.onMessage((clientId, frame) => {
      if (frame.type !== 'command') return;
      void this.handleCommand(clientId, frame);
    });
  }

  /** 当前已认证连接数(多个远程窗口各自是独立 client)。 */
  authenticatedCount(): number {
    return this.deps.wsServer.clientCount();
  }

  /**
   * 重置 daemon token(吊销所有已配对 client)。
   * - 更新 authHandler 校验用的 token(后续握手读新值)
   * - 强制断开所有已连 client(它们需用新 token 重新握手)
   * 已连 client 的 session 走 onClientDisconnected → handleWindowClosed(自动 release)。
   */
  resetToken(newToken: string): void {
    this.deps.token = newToken;

    // 密码重置是显式吊销，不等重连宽限期。先让所有已签发身份的 Session
    // 立即转无主，再清身份；随后 socket close 回调看到 id 已失效，不会重复 release。
    for (const timer of this.releaseTimers.values()) clearTimeout(timer);
    this.releaseTimers.clear();
    for (const clientId of this.issuedClientIds) {
      this.deps.sessionManager.handleWindowClosed(clientId);
    }
    this.issuedClientIds.clear();
    this.deps.wsServer.closeAllClients();
  }

  private makeAuthHandler(): AuthHandler {
    // 读 this.deps.token(非闭包参数),让 resetToken 能 hot-swap。每次握手读最新值。
    return (firstMessage: unknown): AuthResult => {
      const frame = parseAuthFrame(firstMessage);
      if (!frame) {
        return { error: 'invalid auth frame (expected {type:"auth",token[,resumeClientId]})' };
      }
      if (frame.token !== this.deps.token) {
        return { error: 'token mismatch' };
      }
      // 每个远程窗口各自持有 clientId。只要 id 仍在宽限期/活跃集合里，
      // 任意窗口都可独立 resume；不能用单一 boundClientId，否则第二个窗口或
      // 端口 probe 会覆盖第一个窗口的身份，导致其后续重连拿到新 id。
      if (frame.resumeClientId && this.issuedClientIds.has(frame.resumeClientId)) {
        return { clientId: frame.resumeClientId };
      }
      const newId = randomUUID();
      this.issuedClientIds.add(newId);
      return { clientId: newId };
    };
  }

  private registerAuthenticated(transport: ClientTransport): void {
    const pendingRelease = this.releaseTimers.get(transport.clientId);
    if (pendingRelease) {
      clearTimeout(pendingRelease);
      this.releaseTimers.delete(transport.clientId);
    }
    // 新 socket 可能在旧 socket close 事件到达前完成 resume。WsServer 已终止
    // 旧 socket并以实例 guard 防止旧 close 删除新映射；ClientRegistry 也必须
    // 先替换旧 transport，否则 add 会因重复 clientId 抛错。
    if (this.deps.registry.has(transport.clientId)) {
      this.deps.registry.remove(transport.clientId);
    }
    this.deps.registry.add(transport);
    // 告知 client 其 clientId(握手确认 + client 据此判断 session 归属)。
    // 用特殊 event channel __auth-ok__;client RemoteTransport 等 it 拿到 clientId 后才算连接就绪。
    this.deps.wsServer.sendFrame(transport.clientId, {
      type: 'event',
      channel: '__auth-ok__',
      envelope: {
        eventId: 'auth-ok-' + transport.clientId,
        timestamp: Date.now(),
        payload: { clientId: transport.clientId },
      },
    });
    this.deps.onClientAuthenticated?.(transport.clientId);
  }

  /**
   * 处理一个 WS command 帧:调 dispatcher,把结果包成 response 帧发回 client。
   * envelope.windowId 填 clientId(WS client 标识;字段名仍 v1 windowId,完整
   * 重命名留后续),handler 内部用它作 client 标识(createSession 设 owner 等)语义正确。
   */
  private async handleCommand(clientId: string, frame: WsCommandFrame): Promise<void> {
    const requestId = frame.envelope.requestId;

    // preload 的本地路由只是正常客户端的 UX 约束，不是安全边界。知道 daemon
    // 密码的自定义 WS client 可以绕过 preload 直接发任意 channel；若这里不拦，
    // 它可调用 APP_QUIT 让 daemon 退出，或调用 REMOTE_PROFILE_GET_CONNECTION
    // 读取 daemon 本机保存的其他远程 profile 明文密码。daemon 只接受明确属于
    // backend-data 的命令，local-control 必须在客户端 Electron main 内执行。
    if (getCommandRouting(frame.channel) === 'local-control') {
      this.deps.wsServer.sendFrame(clientId, {
        type: 'response',
        requestId,
        ok: false,
        error: {
          code: 'RemoteCommandNotAllowed',
          message: `Command "${frame.channel}" is client-local and cannot run on a remote daemon.`,
        },
      });
      return;
    }

    const envelope: CommandEnvelope = { ...frame.envelope, windowId: clientId };
    const result = await this.deps.dispatch(frame.channel, envelope);
    this.deps.wsServer.sendFrame(clientId, {
      type: 'response',
      requestId,
      ok: result.ok,
      ...(result.ok ? { result: result.result } : { error: result.error }),
    });
  }
}
