/**
 * @file src/preload/remote-transport.test.ts
 * @purpose RemoteTransport 单测:握手(open→auth→__auth-ok__)、invoke→response、
 *   on→event、握手失败/超时、close 清理 pending。用 fake WSLike 驱动,不依赖
 *   浏览器 WebSocket / 真实 ws server。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RemoteTransport, type WSLike, type WsFactory } from './remote-transport';

/** 造一个 fake WSLike:记录 send 的帧,可手动触发 onopen/onmessage/onclose。 */
function makeFakeWs(): WSLike & {
  sent: string[];
  fireOpen(): void;
  fireMessage(data: unknown): void;
  fireClose(): void;
  isOpen: boolean;
} {
  const sent: string[] = [];
  let isOpen = false;
  const ws: WSLike & { sent: string[]; isOpen: boolean } = {
    readyState: 0,
    OPEN: 1,
    send(d: string) {
      sent.push(d);
    },
    close() {
      isOpen = false;
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    sent,
    isOpen,
  };
  return Object.assign(ws, {
    fireOpen() {
      isOpen = true;
      ws.readyState = 1;
      ws.onopen?.();
    },
    fireMessage(data: unknown) {
      const d = typeof data === 'string' ? data : JSON.stringify(data);
      ws.onmessage?.({ data: d });
    },
    fireClose() {
      ws.readyState = 3;
      ws.onclose?.();
    },
  });
}

function setup(opts?: { token?: string; authTimeoutMs?: number }) {
  const fake = makeFakeWs();
  const wsFactory: WsFactory = () => fake;
  const transport = new RemoteTransport({
    url: 'ws://fake',
    token: opts?.token ?? 'tok',
    wsFactory,
    authTimeoutMs: opts?.authTimeoutMs ?? 10000,
  });
  return { fake, transport };
}

describe('RemoteTransport — 握手', () => {
  it('open → 发 auth 帧(token) → 收 __auth-ok__ → ready resolve + clientId', async () => {
    const { fake, transport } = setup({ token: 'abc' });
    fake.fireOpen();
    // 应已发 auth 帧
    expect(fake.sent).toHaveLength(1);
    expect(JSON.parse(fake.sent[0]!)).toEqual({ type: 'auth', token: 'abc' });
    // 模拟 daemon 回 __auth-ok__
    fake.fireMessage({
      type: 'event',
      channel: '__auth-ok__',
      envelope: { eventId: 'e1', timestamp: 1, payload: { clientId: 'CID-1' } },
    });
    await transport.ready;
    expect(transport.getClientId()).toBe('CID-1');
    transport.close();
  });

  it('握手超时 → ready reject', async () => {
    const { transport } = setup({ authTimeoutMs: 30 });
    // open 但不回 __auth-ok__
    await expect(transport.ready).rejects.toThrow(/握手超时/);
  });

  it('连接在握手前关闭 → ready reject', async () => {
    const { fake, transport } = setup();
    fake.fireOpen();
    fake.fireClose();
    await expect(transport.ready).rejects.toThrow(/连接在握手前关闭/);
  });
});

describe('RemoteTransport — invoke', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function readyTransport() {
    const { fake, transport } = setup();
    fake.fireOpen();
    fake.fireMessage({
      type: 'event', channel: '__auth-ok__',
      envelope: { eventId: 'e', timestamp: 0, payload: { clientId: 'C1' } },
    });
    await transport.ready;
    return { fake, transport };
  }

  it('invoke 发 command 帧(envelope 含 clientId + requestId);收匹配 response → resolve', async () => {
    const { fake, transport } = await readyTransport();
    const p = transport.invoke('cmd:app:get-snapshot', { hi: 1 });
    await Promise.resolve();
    expect(fake.sent).toHaveLength(2); // auth + command
    const cmd = JSON.parse(fake.sent[1]!);
    expect(cmd.type).toBe('command');
    expect(cmd.channel).toBe('cmd:app:get-snapshot');
    expect(cmd.envelope.windowId).toBe('C1');
    const reqId = cmd.envelope.requestId;
    // 模拟 daemon 回 response
    fake.fireMessage({ type: 'response', requestId: reqId, ok: true, result: { snapshot: true } });
    await expect(p).resolves.toEqual({ snapshot: true });
    transport.close();
  });

  it('invoke 收 ok:false response → reject 带 code', async () => {
    const { fake, transport } = await readyTransport();
    const p = transport.invoke('cmd:x', {});
    await Promise.resolve();
    const reqId = JSON.parse(fake.sent[1]!).envelope.requestId;
    fake.fireMessage({
      type: 'response', requestId: reqId, ok: false,
      error: { code: 'SessionNotFound', message: 'no' },
    });
    await expect(p).rejects.toThrow(/no/);
    transport.close();
  });

  it('invoke 超时 → reject', async () => {
    const { transport } = await readyTransport();
    const p = transport.invoke('cmd:slow', {});
    vi.advanceTimersByTime(31000);
    await expect(p).rejects.toThrow(/超时/);
    transport.close();
  });
});

describe('RemoteTransport — on', () => {
  it('on 订阅 event;收帧触发 cb(payload);取消订阅后不再触发', async () => {
    const { fake, transport } = setup();
    fake.fireOpen();
    fake.fireMessage({
      type: 'event', channel: '__auth-ok__',
      envelope: { eventId: 'e', timestamp: 0, payload: { clientId: 'C' } },
    });
    await transport.ready;
    const cb = vi.fn();
    const unsub = transport.on('evt:session:created', cb);
    fake.fireMessage({
      type: 'event', channel: 'evt:session:created',
      envelope: { eventId: 'e2', timestamp: 2, payload: { session: { id: 's1' } } },
    });
    expect(cb).toHaveBeenCalledWith({ session: { id: 's1' } });
    unsub();
    fake.fireMessage({
      type: 'event', channel: 'evt:session:created',
      envelope: { eventId: 'e3', timestamp: 3, payload: { session: { id: 's2' } } },
    });
    expect(cb).toHaveBeenCalledTimes(1); // 取消后不再触发
    transport.close();
  });
});

describe('RemoteTransport — close', () => {
  it('close → pending invoke 被 reject', async () => {
    const { fake, transport } = setup();
    fake.fireOpen();
    fake.fireMessage({
      type: 'event', channel: '__auth-ok__',
      envelope: { eventId: 'e', timestamp: 0, payload: { clientId: 'C' } },
    });
    await transport.ready;
    const p = transport.invoke('cmd:x', {});
    transport.close();
    await expect(p).rejects.toThrow(/关闭/);
  });
});

describe('RemoteTransport — 断线重连(阶段3)', () => {
  type FakeWs = ReturnType<typeof makeFakeWs>;
  function setupReconnect(opts?: { reconnectBaseMs?: number; maxReconnectAttempts?: number }) {
    const fakes: FakeWs[] = [];
    const wsFactory: WsFactory = () => {
      const f = makeFakeWs();
      fakes.push(f);
      return f;
    };
    const events: string[] = [];
    const transport = new RemoteTransport({
      url: 'ws://fake',
      token: 'tok',
      wsFactory,
      reconnectBaseMs: opts?.reconnectBaseMs ?? 10,
      ...(opts?.maxReconnectAttempts !== undefined
        ? { maxReconnectAttempts: opts.maxReconnectAttempts }
        : {}),
      onReconnectStart: () => events.push('start'),
      onReconnectSuccess: () => events.push('success'),
      onReconnectFail: (r) => events.push('fail:' + r),
    });
    return { fakes, transport, events };
  }

  async function authOk(fake: FakeWs, clientId: string): Promise<void> {
    fake.fireOpen();
    fake.fireMessage({
      type: 'event',
      channel: '__auth-ok__',
      envelope: { eventId: 'e', timestamp: 1, payload: { clientId } },
    });
  }

  it('握手成功后断线 → backoff 重连 → auth 带 resumeClientId → 复用 clientId + onReconnectSuccess', async () => {
    const { fakes, transport, events } = setupReconnect({ reconnectBaseMs: 10 });
    await authOk(fakes[0]!, 'CID-7');
    expect(transport.getClientId()).toBe('CID-7');
    // 模拟网络断开
    fakes[0]!.fireClose();
    expect(events).toEqual(['start']);
    // 重连期间 invoke 应被拒
    await expect(transport.invoke('cmd:x', null)).rejects.toThrow(/重连中/);
    // 等 backoff 过 → wsFactory 已被再次调用(fakes[1] 存在)
    await new Promise((r) => setTimeout(r, 30));
    expect(fakes.length).toBe(2);
    // 新连接 open → 应发 auth 帧(带 resumeClientId=原 clientId)
    fakes[1]!.fireOpen();
    expect(JSON.parse(fakes[1]!.sent[0]!)).toEqual({
      type: 'auth',
      token: 'tok',
      resumeClientId: 'CID-7',
    });
    // daemon 复用同 clientId 回 auth-ok
    fakes[1]!.fireMessage({
      type: 'event',
      channel: '__auth-ok__',
      envelope: { eventId: 'e2', timestamp: 2, payload: { clientId: 'CID-7' } },
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(events).toContain('success');
    expect(transport.getClientId()).toBe('CID-7');
    transport.close();
  });

  it('重连期间 invoke reject("重连中")', async () => {
    const { fakes, transport } = setupReconnect({ reconnectBaseMs: 50 });
    await authOk(fakes[0]!, 'CID');
    fakes[0]!.fireClose();
    // 此时处于 backoff,reconnecting=true
    await expect(transport.invoke('cmd:y', null)).rejects.toThrow(/重连中/);
    transport.close();
  });

  it('主动 close → 不触发重连(manuallyClosed 终态)', async () => {
    const { fakes, transport, events } = setupReconnect();
    await authOk(fakes[0]!, 'CID');
    transport.close();
    // 等一个 backoff 周期,确认没建新 ws、没 start
    await new Promise((r) => setTimeout(r, 30));
    expect(fakes.length).toBe(1);
    expect(events).toEqual([]);
  });
});
