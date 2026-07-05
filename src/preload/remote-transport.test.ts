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
