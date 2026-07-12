/**
 * @file src/main/remote-daemon.test.ts
 * @purpose RemoteDaemon 协调器测试:握手成功/失败、注册 registry、
 *   自动 release(WS 断开 → handleWindowClosed 调用)。WsServer 用真实实例,
 *   SessionManager 用 mock(只验调用),ClientRegistry 用真实实例。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { ClientRegistry } from './client-registry';
import { WsServer, serializeFrame, parseFrame, type WsFrame } from './transport-ws';
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
  dispatch: RemoteDaemonDeps['dispatch'];
}
const harnesses: Harness[] = [];

async function setup(
  opts: {
    onAuthenticated?: RemoteDaemonDeps['onClientAuthenticated'];
    dispatch?: RemoteDaemonDeps['dispatch'];
    reconnectGraceMs?: number;
  } = {},
): Promise<Harness> {
  const server = new WsServer();
  const registry = new ClientRegistry();
  const sm = makeMockSessionManager();
  const dispatch =
    opts.dispatch ?? vi.fn(async () => ({ ok: true as const, result: { default: true } }));
  const daemon = new RemoteDaemon({
    wsServer: server,
    registry,
    sessionManager: sm,
    token: TOKEN,
    dispatch,
    reconnectGraceMs: opts.reconnectGraceMs ?? 200,
    ...(opts.onAuthenticated ? { onClientAuthenticated: opts.onAuthenticated } : {}),
  });
  daemon.install();
  const port = await server.start(0);
  const h = { server, registry, sm, daemon, port, dispatch };
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

/** 等收一条 message(解析为 WsFrame)。超时 fail。 */
function waitForFrame(ws: WebSocket, timeoutMs = 1000): Promise<WsFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('waitForFrame 超时')), timeoutMs);
    ws.on('message', (data) => {
      const f = parseFrame(data);
      if (f) {
        clearTimeout(timer);
        resolve(f);
      }
    });
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
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    ws.send(JSON.stringify({ type: 'auth', token: 'wrong' }));
    const code = await closed;
    expect(code).toBe(4003); // token mismatch
    expect(authed).not.toHaveBeenCalled();
    expect(h.registry.count()).toBe(0);
  });

  it('非 auth 帧首消息 → 握手失败(4003)', async () => {
    const h = await setup();
    const ws = await connect(h.port);
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    ws.send(JSON.stringify({ type: 'command', channel: 'cmd:x', envelope: {} }));
    const code = await closed;
    expect(code).toBe(4003);
  });
});

describe('RemoteDaemon — 断线重连复用 clientId(阶段3)', () => {
  it('首次握手分配 clientId;重连带 resumeClientId → 复用同一 clientId', async () => {
    const authed = vi.fn();
    const h = await setup({ onAuthenticated: authed });
    // 首次握手
    const ws1 = await connect(h.port);
    ws1.send(JSON.stringify({ type: 'auth', token: TOKEN }));
    await vi.waitFor(() => expect(authed).toHaveBeenCalledTimes(1));
    const cid1 = authed.mock.calls[0]![0] as string;
    ws1.close();
    // 等 daemon 感知断开(onClientDisconnected → registry.remove)
    await vi.waitFor(() => expect(h.registry.count()).toBe(0));
    // 重连:带 resumeClientId。daemon 在已签发身份集合中校验 → 复用。
    const ws2 = await connect(h.port);
    ws2.send(JSON.stringify({ type: 'auth', token: TOKEN, resumeClientId: cid1 }));
    await vi.waitFor(() => expect(authed).toHaveBeenCalledTimes(2));
    const cid2 = authed.mock.calls[1]![0] as string;
    expect(cid2).toBe(cid1); // 复用同一 clientId(身份连续)
    ws2.close();
  });

  it('旧 socket 尚未 close 时 resume 会替换 transport,registry 保持单一身份', async () => {
    const authed = vi.fn();
    const h = await setup({ onAuthenticated: authed });
    const ws1 = await connect(h.port);
    ws1.send(JSON.stringify({ type: 'auth', token: TOKEN }));
    await vi.waitFor(() => expect(authed).toHaveBeenCalledTimes(1));
    const clientId = authed.mock.calls[0]![0] as string;
    const oldClosed = new Promise<void>((resolve) => ws1.on('close', () => resolve()));

    const ws2 = await connect(h.port);
    ws2.send(JSON.stringify({ type: 'auth', token: TOKEN, resumeClientId: clientId }));
    await vi.waitFor(() => expect(authed).toHaveBeenCalledTimes(2));
    await oldClosed;

    expect(authed.mock.calls[1]![0]).toBe(clientId);
    expect(h.registry.count()).toBe(1);
    expect(h.registry.has(clientId)).toBe(true);
    ws2.close();
  });

  it('宽限期内重连保持 Session owner,不会调用 handleWindowClosed', async () => {
    const authed = vi.fn();
    const h = await setup({ onAuthenticated: authed, reconnectGraceMs: 80 });
    const ws1 = await connect(h.port);
    ws1.send(JSON.stringify({ type: 'auth', token: TOKEN }));
    await vi.waitFor(() => expect(authed).toHaveBeenCalledTimes(1));
    const clientId = authed.mock.calls[0]![0] as string;

    ws1.close();
    await vi.waitFor(() => expect(h.registry.count()).toBe(0));
    const ws2 = await connect(h.port);
    ws2.send(JSON.stringify({ type: 'auth', token: TOKEN, resumeClientId: clientId }));
    await vi.waitFor(() => expect(authed).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(authed.mock.calls[1]![0]).toBe(clientId);
    expect(h.sm.handleWindowClosed).not.toHaveBeenCalled();
    ws2.close();
  });

  it('多个远程窗口能各自独立 resume,不会被后连接窗口覆盖身份', async () => {
    const authed = vi.fn();
    const h = await setup({ onAuthenticated: authed, reconnectGraceMs: 200 });
    const ws1 = await connect(h.port);
    ws1.send(JSON.stringify({ type: 'auth', token: TOKEN }));
    const ws2 = await connect(h.port);
    ws2.send(JSON.stringify({ type: 'auth', token: TOKEN }));
    await vi.waitFor(() => expect(authed).toHaveBeenCalledTimes(2));
    const firstId = authed.mock.calls[0]![0] as string;
    const secondId = authed.mock.calls[1]![0] as string;
    expect(firstId).not.toBe(secondId);

    ws1.close();
    await vi.waitFor(() => expect(h.registry.has(firstId)).toBe(false));
    const resumed = await connect(h.port);
    resumed.send(JSON.stringify({ type: 'auth', token: TOKEN, resumeClientId: firstId }));
    await vi.waitFor(() => expect(authed).toHaveBeenCalledTimes(3));
    expect(authed.mock.calls[2]![0]).toBe(firstId);
    expect(h.registry.has(secondId)).toBe(true);

    ws2.close();
    resumed.close();
  });

  it('重连带错误 resumeClientId → 当作新连接(分配新 clientId)', async () => {
    const authed = vi.fn();
    const h = await setup({ onAuthenticated: authed });
    const ws = await connect(h.port);
    // resumeClientId 不在 daemon 已签发身份集合中 → 分配新 id
    ws.send(JSON.stringify({ type: 'auth', token: TOKEN, resumeClientId: 'never-issued' }));
    await vi.waitFor(() => expect(authed).toHaveBeenCalledTimes(1));
    const cid = authed.mock.calls[0]![0] as string;
    expect(cid).not.toBe('never-issued');
    expect(typeof cid).toBe('string');
    ws.close();
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

describe('RemoteDaemon — command → response', () => {
  it('拒绝 local-control 命令,不能绕过 preload 读取凭据或退出 daemon', async () => {
    const dispatch = vi.fn(async () => ({ ok: true as const, result: {} }));
    const h = await setup({ dispatch });
    const ws = await connect(h.port);
    ws.send(JSON.stringify({ type: 'auth', token: TOKEN }));
    await vi.waitFor(() => expect(h.registry.count()).toBe(1));

    const responseP = waitForFrame(ws);
    ws.send(
      serializeFrame({
        type: 'command',
        // REMOTE_PROFILE_GET_CONNECTION 会返回解密后的密码,必须在 daemon 边界拒绝。
        channel: 'cmd:remote-profile:get-connection',
        envelope: { windowId: 'forged', requestId: 'r-local', payload: { profileId: 'p1' } },
      }),
    );
    const frame = await responseP;
    expect(frame.type).toBe('response');
    if (frame.type === 'response') {
      expect(frame.requestId).toBe('r-local');
      expect(frame.ok).toBe(false);
      expect(frame.error?.code).toBe('RemoteCommandNotAllowed');
    }
    expect(dispatch).not.toHaveBeenCalled();
    ws.close();
  });

  it('client 发 command → dispatcher 调用(envelope.windowId=clientId)→ response 帧发回', async () => {
    const dispatch = vi.fn(async (_ch: string, env: { windowId: string }) => ({
      ok: true as const,
      result: { echo: env.windowId },
    }));
    const h = await setup({ dispatch });
    const ws = await connect(h.port);
    ws.send(JSON.stringify({ type: 'auth', token: TOKEN }));
    await vi.waitFor(() => expect(h.registry.count()).toBe(1));
    const clientId = h.registry.list()[0]!.clientId;

    const responseP = waitForFrame(ws);
    ws.send(
      serializeFrame({
        type: 'command',
        channel: 'cmd:app:get-snapshot',
        envelope: { windowId: 'whatever', requestId: 'r-9', payload: {} },
      }),
    );
    const frame = await responseP;
    expect(frame.type).toBe('response');
    if (frame.type === 'response') {
      expect(frame.requestId).toBe('r-9');
      expect(frame.ok).toBe(true);
      // dispatcher 收到的 windowId = clientId(remote-daemon 覆盖了 client 发的 'whatever')
      expect(frame.result).toEqual({ echo: clientId });
    }
    expect(dispatch).toHaveBeenCalledTimes(1);
    ws.close();
  });

  it('dispatcher 返回 error → response ok:false 带 error.code', async () => {
    const dispatch = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'SessionNotFound', message: 'no' },
    }));
    const h = await setup({ dispatch });
    const ws = await connect(h.port);
    ws.send(JSON.stringify({ type: 'auth', token: TOKEN }));
    await vi.waitFor(() => expect(h.registry.count()).toBe(1));
    const frameP = waitForFrame(ws);
    ws.send(
      serializeFrame({
        type: 'command',
        channel: 'cmd:session:close',
        envelope: { windowId: '', requestId: 'r-err', payload: {} },
      }),
    );
    const frame = await frameP;
    if (frame.type === 'response') {
      expect(frame.ok).toBe(false);
      expect(frame.error?.code).toBe('SessionNotFound');
    }
    ws.close();
  });
});
