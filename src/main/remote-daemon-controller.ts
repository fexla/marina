/**
 * @file src/main/remote-daemon-controller.ts
 * @purpose 远程后端服务端的运行时生命周期管理(启停 WS server + RemoteDaemon)。
 *
 * @关键设计:
 * - 用户在 UI 点"启动服务端" → start(port);点"停止" → stop()。
 *   取代旧的"只在启动时 if(--daemon) 静态起 server"。
 * - 持有 WsServer + RemoteDaemon 实例。start 时 new + install + listen;
 *   stop 时 wsServer.stop(terminate 所有 client)+ 清空引用。
 * - 端口改了 → restart(stop + start 新端口,踢所有 client 重连)。
 * - 密码改了 → onPasswordChanged(remoteDaemon.resetToken 热换 + 踢 client,
 *   不重启 server)。
 * - token 来源:外部注入 getCredentialsToken()(读 daemon-credentials 文件),
 *   controller 不持有 credentials 持久化。
 *
 * @对应文档:软件定义书 §14.9 / ADR-014;用户需求"设置里按钮启停 + 端口/密码可配置"
 *
 * @不要在这里做的事:
 * - 不要管密码持久化(daemon-credentials.ts)
 * - 不要管 client profile(remote-profile-manager.ts)
 * - 不要管 settings(settings-manager.ts;controller 只接 port 参数)
 */

import { WsServer } from './transport-ws';
import { RemoteDaemon, type DispatchFn } from './remote-daemon';
import type { ClientRegistry } from './client-registry';
import type { SessionManager } from './session-manager';

/** controller 依赖(由 index.ts 注入)。 */
export interface RemoteDaemonControllerDeps {
  registry: ClientRegistry;
  sessionManager: SessionManager;
  dispatch: DispatchFn;
  /** 拿当前 daemon 密码明文(从 daemon-credentials 解密)。null = 未设密码。 */
  getCredentialsToken: () => string | null;
  /** 持久化新密码(index 注入:setDaemonPassword 落盘)。空字符串拒。 */
  persistPassword: (plaintext: string) => Promise<void>;
}

/** 服务端运行状态(推给 renderer UI 展示)。 */
export interface DaemonStatus {
  /** WS server 是否在监听。 */
  running: boolean;
  /** 实际监听端口(running=false 时 null)。 */
  port: number | null;
  /** 当前已认证连接的 client 数。 */
  clientCount: number;
  /** 是否已设密码(没设不能启动)。 */
  hasPassword: boolean;
}

/**
 * 远程服务端控制器。单例(index.ts 持有)。UI 按钮 → IPC → controller 方法。
 */
export class RemoteDaemonController {
  private wsServer: WsServer | null = null;
  private remoteDaemon: RemoteDaemon | null = null;
  private currentPort: number | null = null;
  /**
   * 状态广播器(index.ts 在 installIpcLayer 后赋值:接 ipc 的 broadcastEvent)。
   * 用 public 字段而非构造参数,避免 controller↔ipc 循环依赖。
   */
  onStatusChange: ((status: DaemonStatus) => void) | null = null;

  constructor(private readonly deps: RemoteDaemonControllerDeps) {}

  /**
   * 启动服务端:监听 port,接受远程 client。
   * @throws 'already running' 重复启动
   * @throws 'no password set' 未设密码(用户须先在 UI 设密码)
   * @throws WsServer.start 的错误(端口占用等)
   */
  async start(port: number): Promise<{ port: number }> {
    if (this.wsServer) {
      throw new Error('[remote-daemon-controller] 服务端已在运行,先停止再启动');
    }
    const token = this.deps.getCredentialsToken();
    if (!token) {
      throw new Error('[remote-daemon-controller] 未设密码,请先在设置里配置服务端密码');
    }
    const wsServer = new WsServer();
    const remoteDaemon = new RemoteDaemon({
      wsServer,
      registry: this.deps.registry,
      sessionManager: this.deps.sessionManager,
      token,
      dispatch: this.deps.dispatch,
      onClientAuthenticated: () => this.emitStatus(),
      onClientGone: () => this.emitStatus(),
    });
    remoteDaemon.install();
    // start 可能抛端口占用;抛前不提交状态(保持 wsServer=null)
    const actualPort = await wsServer.start(port);
    this.wsServer = wsServer;
    this.remoteDaemon = remoteDaemon;
    this.currentPort = actualPort;
    this.emitStatus();
    return { port: actualPort };
  }

  /** 停止服务端:terminate 所有 client + close server。幂等(未运行时 no-op)。 */
  async stop(): Promise<void> {
    if (!this.wsServer) return;
    await this.wsServer.stop();
    this.wsServer = null;
    this.remoteDaemon = null;
    this.currentPort = null;
    this.emitStatus();
  }

  /**
   * 重启服务端用新端口(stop + start)。若未运行,仅记录不启动(等用户点启动)。
   * @returns 新端口(若重启了);null = 未运行未重启
   */
  async restartIfRunning(newPort: number): Promise<{ port: number } | null> {
    if (!this.wsServer) return null;
    await this.stop();
    return this.start(newPort);
  }

  /**
   * 密码改了调(热换,不重启 server)。remoteDaemon.resetToken 更新握手校验值 +
   * closeAllClients 踢当前 client(它们须用新密码重连)。未运行时只更新(下次 start 用)。
   */
  onPasswordChanged(newToken: string): void {
    if (!newToken) return;
    this.remoteDaemon?.resetToken(newToken);
  }

  /**
   * 设置/改密码(用户在 UI 输入)。持久化 + 热换运行中的 server。
   * @throws 密码为空 / 持久化失败
   */
  async setPassword(plaintext: string): Promise<void> {
    if (!plaintext) throw new Error('[remote-daemon-controller] 密码不能为空');
    await this.deps.persistPassword(plaintext);
    this.onPasswordChanged(plaintext);
    this.emitStatus(); // hasPassword 可能变 true
  }

  isRunning(): boolean {
    return this.wsServer !== null;
  }

  getStatus(): DaemonStatus {
    return {
      running: this.wsServer !== null,
      port: this.currentPort,
      clientCount: this.remoteDaemon?.authenticatedCount() ?? 0,
      hasPassword: this.deps.getCredentialsToken() !== null,
    };
  }

  private emitStatus(): void {
    this.onStatusChange?.(this.getStatus());
  }
}
