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
 * - 不要做 command 分发(阶段1.5 dispatcher)
 * - 不要做 TLS/配对 UI(阶段2)
 */
import { randomUUID } from 'node:crypto';
import type { ClientRegistry, ClientTransport } from './client-registry';
import type { SessionManager } from './session-manager';
import type { WsServer, AuthHandler, AuthResult } from './transport-ws';

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

export interface RemoteDaemonDeps {
  wsServer: WsServer;
  registry: ClientRegistry;
  sessionManager: SessionManager;
  /** daemon 启动时持久化生成的 token;client 必须带它握手。 */
  token: string;
  /** 可选:握手通过的回调(注册完 registry 后触发),daemon UI 可据此更新"当前连接"。 */
  onClientAuthenticated?: (clientId: string) => void;
  /** 可选:断开回调,daemon UI 更新 + 日志。 */
  onClientGone?: (clientId: string) => void;
}

/**
 * 远程后端协调器。start() 后开始服务;stop() 交给调用方(通常停 WsServer)。
 *
 * 生命周期:daemon 启动 → RemoteDaemon.install() 挂回调 → WsServer.start(port)。
 * 每个 WS client:连接 → 握手(authHandler) → 通过则 registry.add →
 * (command 走 dispatcher,阶段1.5) → WS 断开 → registry.remove + 自动 release。
 */
export class RemoteDaemon {
  constructor(private readonly deps: RemoteDaemonDeps) {}

  /**
   * 挂载握手/连接/断开回调到 WsServer。应在 WsServer.start 前调用。
   * 内部:
   *  - setAuthHandler:解析 auth 帧 + 校验 token + 分配 clientId
   *  - onClientConnected:已由 authHandler 路径注册(此处仅触发 onClientAuthenticated)
   *  - onClientDisconnected:registry.remove + sessionManager.handleWindowClosed
   */
  install(): void {
    const { wsServer, registry, sessionManager, token } = this.deps;

    wsServer.setAuthHandler(this.makeAuthHandler(token));
    wsServer.onClientConnected((transport) => {
      // authHandler 通过 → registerClient 已在 WsServer 内部把 transport 加入?
      // 不:WsServer 的 registerClient 只挂消息/关闭处理 + emit connected,
      // 它不知道 ClientRegistry。registry.add 在这里做。
      this.registerAuthenticated(transport);
    });
    wsServer.onClientDisconnected((clientId) => {
      registry.remove(clientId);
      // 自动 release:client 消失 → 其持有的 session 全部 release。
      // handleWindowClosed 语义 = "该 client 的 session 转无主",WS 断开完全适用。
      sessionManager.handleWindowClosed(clientId);
      this.deps.onClientGone?.(clientId);
    });
  }

  /** 当前已认证连接数(供上限检查:V1 最多 1 个远程 client)。 */
  authenticatedCount(): number {
    return this.deps.wsServer.clientCount();
  }

  private makeAuthHandler(expectedToken: string): AuthHandler {
    return (firstMessage: unknown): AuthResult => {
      const frame = parseAuthFrame(firstMessage);
      if (!frame) {
        return { error: 'invalid auth frame (expected {type:"auth",token})' };
      }
      if (frame.token !== expectedToken) {
        return { error: 'token mismatch' };
      }
      // 阶段1 loopback:每次握手分配新 clientId。
      // 阶段2:frame.resumeClientId + token→clientId 映射,断线重连复用。
      return { clientId: randomUUID() };
    };
  }

  private registerAuthenticated(transport: ClientTransport): void {
    this.deps.registry.add(transport);
    this.deps.onClientAuthenticated?.(transport.clientId);
  }
}
