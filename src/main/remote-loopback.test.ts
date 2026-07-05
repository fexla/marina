/**
 * @file src/main/remote-loopback.test.ts
 * @purpose 端到端 loopback:RemoteTransport(client) ↔ WsServer+RemoteDaemon(daemon),
 *   真实 WS 连接(localhost)。验证完整帧往返闭环 —— 这是阶段1 "本地 loopback 自测"
 *   的自动化核心(RemoteTransport 在 preload 侧,WsServer/RemoteDaemon 在 main 侧,
 *   两者用同一套帧格式,此测试证明它们对得上)。
 *
 * @覆盖:
 * - 握手:RemoteTransport 发 auth → RemoteDaemon __auth-ok__ → ready + clientId
 * - invoke 闭环:client invoke → daemon dispatch(用 mock)→ response 回 → resolve
 * - event 推送:daemon broadcast → client on 收到
 * - 自动 release:client 断开 → daemon sessionManager.handleWindowClosed 调用
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { ClientRegistry } from './client-registry';
import { WsServer } from './transport-ws';
import { RemoteDaemon, type DispatchFn } from './remote-daemon';
import { RemoteTransport, type WsFactory } from '../preload/remote-transport';
import type { SessionManager } from './session-manager';

const TOKEN = 'loopback-token';

function mockSessionManager() {
  return {
    handleWindowClosed: vi.fn(),
  } as unknown as SessionManager & { handleWindowClosed: ReturnType<typeof vi.fn> };
}

interface Loopback {
  server: WsServer;
  registry: ClientRegistry;
  sm: ReturnType<typeof mockSessionManager>;
  daemon: RemoteDaemon;
  dispatch: ReturnType<typeof vi.fn> | ((...args: never[]) => unknown);
  port: number;
}
const lbs: Loopback[] = [];

async function startLoopback(dispatchImpl?: DispatchFn): Promise<Loopback> {
  const server = new WsServer();
  const registry = new ClientRegistry();
  const sm = mockSessionManager();
  const dispatch = vi.fn(dispatchImpl ?? (async () => ({ ok: true as const, result: { pong: true } })));
  const daemon = new RemoteDaemon({
    wsServer: server,
    registry,
    sessionManager: sm,
    token: TOKEN,
    dispatch: dispatch as unknown as DispatchFn,
  });
  daemon.install();
  const port = await server.start(0);
  const lb = { server, registry, sm, daemon, dispatch, port };
  lbs.push(lb);
  return lb;
}

afterEach(async () => {
  while (lbs.length) await lbs.pop()!.server.stop();
});

// 浏览器 WebSocket 的 node 版本(ws 包),供 RemoteTransport 用
const nodeWsFactory: WsFactory = (url) => {
  const ws = new WebSocket(url);
  // 适配 WSLike:onmessage/onclose/onerror/onopen + send + close + readyState/OPEN
  return {
    get readyState() {
      return ws.readyState;
    },
    OPEN: WebSocket.OPEN,
    send: (d: string) => ws.send(d),
    close: () => ws.close(),
    set onopen(fn: (() => void) | null) {
      if (fn) ws.on('open', fn);
    },
    set onmessage(fn: ((ev: { data: unknown }) => void) | null) {
      if (fn) ws.on('message', (data) => fn({ data }));
    },
    set onclose(fn: (() => void) | null) {
      if (fn) ws.on('close', fn);
    },
    set onerror(fn: ((err: unknown) => void) | null) {
      if (fn) ws.on('error', fn);
    },
  } as any;
};

async function connectTransport(port: number): Promise<RemoteTransport> {
  const t = new RemoteTransport({
    url: `ws://127.0.0.1:${port}`,
    token: TOKEN,
    wsFactory: nodeWsFactory,
    authTimeoutMs: 3000,
  });
  await t.ready;
  return t;
}

describe('loopback: RemoteTransport ↔ RemoteDaemon(真实 WS)', () => {
  it('握手通过 + clientId 双方一致', async () => {
    const lb = await startLoopback();
    const t = await connectTransport(lb.port);
    const clientCid = t.getClientId();
    expect(clientCid).toBeTruthy();
    // daemon 端 registry 也注册了这个 clientId
    expect(lb.registry.has(clientCid!)).toBe(true);
    t.close();
  });

  it('invoke 闭环:client invoke → daemon dispatch(windowId=clientId)→ response → resolve', async () => {
    const lb = await startLoopback(async (_ch, env) => ({
      ok: true as const,
      result: { echoedWindowId: env.windowId },
    }));
    const t = await connectTransport(lb.port);
    const result = await t.invoke('cmd:app:get-snapshot', {});
    expect(result).toEqual({ echoedWindowId: t.getClientId() });
    expect(lb.dispatch).toHaveBeenCalledTimes(1);
    t.close();
  });

  it('event 推送:daemon registry.broadcast → client on 收到 payload', async () => {
    const lb = await startLoopback();
    const t = await connectTransport(lb.port);
    const got = new Promise((resolve) => t.on('evt:session:created', resolve));
    // daemon 端广播(daemon 内部事件触发时调 registry.broadcast)
    lb.registry.broadcast('evt:session:created', { session: { id: 's-loopback' } });
    expect(await got).toEqual({ session: { id: 's-loopback' } });
    t.close();
  });

  it('自动 release:client 断开 → daemon sessionManager.handleWindowClosed(clientId)', async () => {
    const lb = await startLoopback();
    const t = await connectTransport(lb.port);
    const cid = t.getClientId()!;
    t.close();
    await vi.waitFor(() => expect(lb.sm.handleWindowClosed).toHaveBeenCalledTimes(1));
    expect(lb.sm.handleWindowClosed.mock.calls[0]![0]).toBe(cid);
    expect(lb.registry.has(cid)).toBe(false);
  });

  it('错误 token → 握手失败(client ready reject)', async () => {
    const lb = await startLoopback();
    const t = new RemoteTransport({
      url: `ws://127.0.0.1:${lb.port}`,
      token: 'WRONG',
      wsFactory: nodeWsFactory,
      authTimeoutMs: 2000,
    });
    await expect(t.ready).rejects.toThrow();
  });
});
