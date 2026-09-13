/**
 * @file src/shared/remote-connect.ts
 * @purpose 远程 daemon 的「建连」流程:profile 校验 + 端口扫描(32780-32789)
 *   + 错误分类。从 preload/index.ts 的 ensureTransport 抽取(v0.3.4,ADR-042),
 *   让 Electron 远程窗口与 Android WebView 壳(apps/mobile 的 window.api shim)
 *   共用同一份逻辑 —— 帧协议在 preload/remote-transport.ts,两端也已共用。
 *
 * @关键设计:
 * - 连接信息(host/token)由调用方注入:Electron 端经本地 IPC 从 main 的
 *   profile 存储拉取;mobile 端从 localStorage 读。本模块不关心存储。
 * - 端口扫描:从 REMOTE_DAEMON_PORT_MIN 起串行尝试到 MAX。端口关闭 TCP RST
 *   快速失败,遇开放的错误端口才等握手超时。设计动机(用户需求):client 只需
 *   IP,不用输端口。
 * - 失败错误按诊断价值分类(AUTH_REJECTED > WS_HANDSHAKE > AUTH_TIMEOUT >
 *   TCP_UNREACHABLE):AUTH_REJECTED 说明某端口是 Marina daemon 但密码错
 *   (用户改密码即可);全部 TCP_UNREACHABLE → server 没起/网络不通。
 *
 * @不要在这里做的事:
 * - 不做 transport 生命周期管理(transportInit 缓存 / 懒加载 gate 留在调用方)
 * - 不做重连后的 UI 决策(reload 画面 vs 提示,由调用方回调处理)
 */

import {
  ConnectError,
  ConnectErrorCode,
  RemoteTransport,
  type WSLike,
  type WsFactory,
} from '../preload/remote-transport';
import { REMOTE_DAEMON_PORT_MAX, REMOTE_DAEMON_PORT_MIN } from './protocol';

/**
 * 浏览器原生 WebSocket 适配成 WSLike(RemoteTransport 期望的接口)。
 * Electron preload 与 Android WebView 的全局 WebSocket 行为一致,两个客户端
 * 共用这一份适配(从 preload/index.ts 移入,单一真相源)。
 * close code/reason 必须透传(daemon 认证失败用 4003/4001,client 端错误分析依赖它)。
 */
export const browserWsFactory: WsFactory = (url: string): WSLike => {
  const ws = new WebSocket(url);
  const adapter: WSLike = {
    get readyState() {
      return ws.readyState;
    },
    OPEN: WebSocket.OPEN,
    send: (d: string) => ws.send(d),
    close: () => ws.close(),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  ws.onopen = () => adapter.onopen?.();
  ws.onmessage = (ev: MessageEvent) => adapter.onmessage?.({ data: ev.data });
  ws.onclose = (ev: CloseEvent) => adapter.onclose?.({ code: ev.code, reason: ev.reason });
  ws.onerror = (e) => adapter.onerror?.(e);
  return adapter;
};

/** 连接一个远程 daemon 所需的最小信息(与 main 端 GetRemoteConnectionResponse.connection 同形)。 */
export interface RemoteDaemonConnection {
  host: string;
  token: string;
}

/** connectRemoteDaemon 的可注入回调:重连生命周期与 ws 实现都归调用方。 */
export interface ConnectRemoteDaemonOptions {
  connection: RemoteDaemonConnection;
  wsFactory: WsFactory;
  /** 断线自动重连成功(调用方通常 reload / 重拉 snapshot)。 */
  onReconnectSuccess?: () => void;
  onReconnectStart?: () => void;
  onReconnectFail?: (reason: unknown) => void;
}

/** profile 数据不全的明确报错(本地数据问题,非网络)。导出给调用方在拉取后自检。 */
export function incompleteProfileError(missing: 'host' | 'token'): ConnectError {
  return new ConnectError(
    ConnectErrorCode.PROFILE_INCOMPLETE,
    `[remote-connect] 该远程电脑配置不完整(缺 ${missing === 'host' ? 'IP' : '密码'}),请在设置里补全。`,
  );
}

/**
 * 端口扫描 + 建立带自动重连的 transport。
 *
 * @returns 已完成认证握手的 RemoteTransport(await .ready 已包含)
 * @throws ConnectError 所有候选端口都连不上时,按诊断价值挑最有价值的错误码,
 *   message 里含 host/端口范围/各端口尝试详情。
 */
export async function connectRemoteDaemon(
  opts: ConnectRemoteDaemonOptions,
): Promise<RemoteTransport> {
  const { host, token } = opts.connection;
  if (!host || !token) {
    throw incompleteProfileError(!host ? 'host' : 'token');
  }

  const PORT_FROM = REMOTE_DAEMON_PORT_MIN;
  const PORT_COUNT = REMOTE_DAEMON_PORT_MAX - REMOTE_DAEMON_PORT_MIN + 1;
  let portFound: number | null = null;
  // 收集各端口尝试的错误码,全失败时选最有价值的报告给用户。
  const tried: Array<{ port: number; code: string; message: string }> = [];
  for (let i = 0; i < PORT_COUNT; i++) {
    const port = PORT_FROM + i;
    const probe = new RemoteTransport({
      url: `ws://${host}:${port}`,
      token,
      wsFactory: opts.wsFactory,
      authTimeoutMs: 3000,
      autoReconnect: false,
    });
    try {
      await probe.ready;
      probe.close();
      portFound = port;
      break;
    } catch (err) {
      probe.close();
      const code = err instanceof ConnectError ? err.code : 'UNKNOWN';
      const message = err instanceof Error ? err.message : String(err);
      tried.push({ port, code, message });
    }
  }
  if (portFound === null) {
    // 选最有价值的错误码(优先级:AUTH_REJECTED > WS_HANDSHAKE > AUTH_TIMEOUT > TCP_UNREACHABLE)。
    const priority: Record<string, number> = {
      AUTH_REJECTED: 0,
      WS_HANDSHAKE: 1,
      AUTH_TIMEOUT: 2,
      TCP_UNREACHABLE: 3,
      UNKNOWN: 4,
    };
    const best = [...tried].sort(
      (a, b) => (priority[a.code] ?? 9) - (priority[b.code] ?? 9),
    )[0];
    const bestCode = best?.code ?? 'TCP_UNREACHABLE';
    const triedCodes = tried.map((t) => t.code);
    throw new ConnectError(
      bestCode as ConnectErrorCode,
      `[remote-connect] 连接 ${host}:${PORT_FROM}-${PORT_FROM + PORT_COUNT - 1} 全部失败。` +
        `最有价值原因:${best?.message ?? '无响应'}。` +
        `尝试详情:${tried.map((t) => `${t.port}=${t.code}`).join(', ')}。` +
        `triedCodes=${triedCodes.join(',')}`,
    );
  }

  // 重建带重连回调的 transport 连找到的端口(扫描用的 probe 已 close)。
  // exactOptionalPropertyTypes 下可选回调不显式传 undefined,有才展开。
  const t = new RemoteTransport({
    url: `ws://${host}:${portFound}`,
    token,
    wsFactory: opts.wsFactory,
    ...(opts.onReconnectSuccess ? { onReconnectSuccess: opts.onReconnectSuccess } : {}),
    ...(opts.onReconnectStart ? { onReconnectStart: opts.onReconnectStart } : {}),
    ...(opts.onReconnectFail ? { onReconnectFail: opts.onReconnectFail } : {}),
  });
  await t.ready;
  return t;
}
