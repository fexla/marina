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
import * as nodeNet from 'node:net';

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
  /**
   * 端口监听自检:start 后主动 connect 127.0.0.1:port 验证监听真的生效。
   * undefined = 未启动 / 未自检;{ ok:false, reason } = 监听异常(极罕见:
   * ws.start 成功但实际接不了,比如被虚拟网卡/防火墙阻在本机)。
   * 用户看到“已开启但自检失败” → 快速定位“服务开了但连不上”。
   */
  listenCheck?: { ok: boolean; reason?: string };
}

/**
 * 远程服务端控制器。单例(index.ts 持有)。UI 按钮 → IPC → controller 方法。
 */
export class RemoteDaemonController {
  private wsServer: WsServer | null = null;
  private remoteDaemon: RemoteDaemon | null = null;
  private currentPort: number | null = null;
  private listenCheck: { ok: boolean; reason?: string } | undefined = undefined;
  /**
   * 额外的状态监听器(index.ts 注入 tray 更新等)。onStatusChange 字段(ipc broadcast)
   * 也会调,两者并存不覆盖 —— 历史教训:曾因 index 赋值 onStatusChange 覆盖了 ipc 的
   * broadcast,导致 start 后 UI 永远不更新。
   */
  private statusListeners: Array<(status: DaemonStatus) => void> = [];
  /**
   * 状态广播器(index.ts 在 installIpcLayer 后赋值:接 ipc 的 broadcastEvent)。
   * 用 public 字段而非构造参数,避免 controller↔ipc 循环依赖。
   * 注意:不要在外部再赋值覆盖它(会吞掉 broadcast);额外副作用用 addStatusListener。
   */
  onStatusChange: ((status: DaemonStatus) => void) | null = null;

  /**
   * 加一个状态监听器(不覆盖 onStatusChange)。index.ts 用它接 tray 端口同步等副作用。
   * 返回取消订阅函数。
   */
  addStatusListener(fn: (status: DaemonStatus) => void): () => void {
    this.statusListeners.push(fn);
    return () => {
      const i = this.statusListeners.indexOf(fn);
      if (i >= 0) this.statusListeners.splice(i, 1);
    };
  }

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
    this.listenCheck = undefined; // 重置;自检后填
    this.emitStatus();
    // 异步自检:不等 start 返回(避免阻塞 UI)。自检完再 emit 一次带 listenCheck。
    void this.selfCheckListen(actualPort);
    return { port: actualPort };
  }

  /**
   * 端口监听自检:start 后主动 connect 127.0.0.1:port 验证 ws.start 成功 ≠ 真能接。
   * 极罕见场景:ws.start 未抛错但实际接不了(虚拟网卡/防火墙阻本机回环)。
   * 检测到异常 → listenCheck.ok=false,UI 显示警告 + renderer 错误页能据 LISTEN_FAILED 诊断。
   */
  private selfCheckListen(port: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok: boolean, reason?: string): void => {
        if (settled) return;
        settled = true;
        // 只在仍是当前会话(未被 stop/restart)时记录
        if (this.currentPort === port) {
          this.listenCheck = reason ? { ok, reason } : { ok };
          this.emitStatus();
        }
        resolve();
      };
      try {
        const socket = nodeNet.connect({ host: '127.0.0.1', port, timeout: 1500 });
        socket.once('connect', () => {
          socket.destroy();
          done(true);
        });
        socket.once('timeout', () => {
          socket.destroy();
          done(false, '本机回环连接超时(监听可能未真正生效)');
        });
        socket.once('error', (err) => {
          socket.destroy();
          done(false, `本机回环连接失败:${err.message}`);
        });
      } catch (err) {
        done(false, err instanceof Error ? err.message : String(err));
      }
    });
  }

  /** 停止服务端:terminate 所有 client + close server。幂等(未运行时 no-op)。 */
  async stop(): Promise<void> {
    if (!this.wsServer) return;
    await this.wsServer.stop();
    this.wsServer = null;
    this.remoteDaemon = null;
    this.currentPort = null;
    this.listenCheck = undefined;
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
    const status: DaemonStatus = {
      running: this.wsServer !== null,
      port: this.currentPort,
      clientCount: this.remoteDaemon?.authenticatedCount() ?? 0,
      hasPassword: this.deps.getCredentialsToken() !== null,
    };
    if (this.listenCheck !== undefined) {
      status.listenCheck = this.listenCheck;
    }
    return status;
  }

  private emitStatus(): void {
    const status = this.getStatus();
    this.onStatusChange?.(status);
    for (const fn of this.statusListeners) {
      try {
        fn(status);
      } catch {
        /* 单个监听器出错不影响其他 */
      }
    }
  }
}
