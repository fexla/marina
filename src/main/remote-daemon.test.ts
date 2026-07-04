/**
 * @file src/main/remote-daemon.test.ts
 * @purpose RemoteDaemon 协调器测试:握手成功/失败、注册 registry、
 *   自动 release(WS 断开 → handleWindowClosed 调用)。WsServer 用真实实例,
 *   SessionManager 用 mock(只验调用),ClientRegistry 用真实实例。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { ClientRegistry } from './client-registry';
import { WsServer } from './transport-ws';
import { RemoteDaemon, parseAuthFrame, type RemoteDaemonDeps } from './remote-daemon';
import type { SessionManager } from './session-manager';

const TOKEN = 'test-token-xyz';

function makeMockSessionManager() {
  return {
    handleWindowClosed: vi.fn(),
    // RemoteDaemon 当前只用到 handleWindowClosed;其余方法按需补。
  } as unknown as SessionManager & { handleWindowClosed: ReturnType<typeof vi.fn> };
}

interface Harness {
  server: WsServer;
  registry: ClientRegistry;
  sm: ReturnType<typeof makeMockSessionManager>;
  daemon: RemoteDaemon;
  port: number;
}
const harnesses: Harness[] = [];

async function setup(opts: { onAuthenticated?: RemoteDaemonDeps['onClientAuthenticated'] } = {}): Promise<Harness> {
  const server = new WsServer();
  const registry = new ClientRegistry();
  const sm = makeMockSessionManager();
  const daemon = new RemoteDaemon({
    wsServer: server,
    registry,
    sessionManager: sm,
    token: TOKEN,
    ...(opts.onAuthenticated ? { onClientAuthenticated: opts.onAuthenticated } : {}),
  });
  daemon.install();
  const port = await server.start(0);
  const h = { server, registry, sm, daemon, port };
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  while (harnesses.length) {
    const h = harnesses.pop()!;
    await h.server.stop();
  }
});

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

describe('parseAuthFrame', () => {
  it('合法 auth 帧解析成功', () => {
    expect(parseAuthFrame(JSON.stringify({ type: 'auth', token: 't' }))).toEqual({
      type: 'auth',
      token: 't',
    });
  });
  it('缺 token → null', () => {
    expect(parseAuthFrame(JSON.stringify({ type: 'auth' }))).toBeNull();
  });
  it('非 auth type → null', () => {
    expect(parseAuthFrame(JSON.stringify({ type: 'command', token: 't' }))).toBeNull();
  });
  it('非 JSON → null', () => {
    expect(parseAuthFrame('nope')).toBeNull();
  });
});

describe('RemoteDaemon — 握手', () => {
  it('正确 token → 通过握手,registry 注册,onClientAuthenticated 触发', async () => {
    const authed = vi.fn();
    const h = await setup({ onAuthenticated: authed });
    const ws = await connect(h.port);
    ws.send(JSON.stringify({ type: 'auth', token: TOKEN }));
    // 等握手通过(authed 被调 = 注册完成)
    await vi.waitFor(() => expect(authed).toHaveBeenCalledTimes(1));
    const clientId = authed.mock.calls[0][0];
    expect(h.registry.has(clientId)).toBe(true);
    expect(h.registry.count()).toBe(1);
    ws.close();
  });

  it('错误 token → 握手失败,连接被关闭,registry 不注册', async () => {
    const authed = vi.fn();
    const h = await setup({ onAuthenticated: authed });
    const ws = await connect(h.port);
    const closed = new Promise<number>((resolve) =>
      ws.on('close', (code) => resolve(code)),
    );
    ws.send(JSON.stringify({ type: 'auth', token: 'wrong' }));
    const code = await closed;
    expect(code).toBe(4003); // token mismatch
    expect(authed).not.toHaveBeenCalled();
    expect(h.registry.count()).toBe(0);
  });

  it('非 auth 帧首消息 → 握手失败(4003)', async () => {
    const h = await setup();
    const ws = await connect(h.port);
    const closed = new Promise<number>((resolve) =>
      ws.on('close', (code) => resolve(code)),
    );
    ws.send(JSON.stringify({ type: 'command', channel: 'cmd:x', envelope: {} }));
    const code = await closed;
    expect(code).toBe(4003);
  });
});

describe('RemoteDaemon — 自动 release', () => {
  it('client 断开 → registry.remove + sessionManager.handleWindowClosed 调用,clientId 正确', async () => {
    const authed = vi.fn();
    const h = await setup({ onAuthenticated: authed });
    const ws = await connect(h.port);
    ws.send(JSON.stringify({ type: 'auth', token: TOKEN }));
    await vi.waitFor(() => expect(authed).toHaveBeenCalledTimes(1));
    const clientId = authed.mock.calls[0][0];

    // 断开 → daemon 应自动 release(复用 handleWindowClosed)
    ws.close();
    await vi.waitFor(() => expect(h.sm.handleWindowClosed).toHaveBeenCalledTimes(1));
    expect(h.sm.handleWindowClosed.mock.calls[0]![0]).toBe(clientId);
    expect(h.registry.has(clientId)).toBe(false);
  });
});

describe('RemoteDaemon — authenticatedCount', () => {
  it('连接并认证后 +1,断开后 -1', async () => {
    const h = await setup();
    expect(h.daemon.authenticatedCount()).toBe(0);
    const ws = await connect(h.port);
    ws.send(JSON.stringify({ type: 'auth', token: TOKEN }));
    await vi.waitFor(() => expect(h.registry.count()).toBe(1));
    expect(h.daemon.authenticatedCount()).toBe(1);
    ws.close();
    await vi.waitFor(() => expect(h.daemon.authenticatedCount()).toBe(0));
  });
});
