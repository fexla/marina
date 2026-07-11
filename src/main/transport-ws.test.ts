/**
 * @file src/main/transport-ws.test.ts
 * @purpose Transport-Ws 测试:WsServer 启动/监听、连接生命周期(connected/
 *   disconnected)、命令帧 client→server、事件帧 server→client、parseFrame
 *   容错(非法 JSON/结构)、多 handler 隔离。
 *
 * @测试策略:用真实 ws.WebSocketServer(端口 0 随机)+ ws.WebSocket client,
 *   本地 TCP 回环,快且贴近真实(比 mock 更能暴露 readyState/帧时序问题)。
 *   每个测试用独立端口(新建 WsServer),结束 stop()。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import type { ClientTransport } from './client-registry';
import {
  WsServer,
  parseFrame,
  serializeFrame,
  type WsFrame,
} from './transport-ws';

const servers: WsServer[] = [];
async function startServer(): Promise<{ server: WsServer; port: number }> {
  const server = new WsServer();
  servers.push(server);
  const port = await server.start(0);
  return { server, port };
}
afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()!;
    await s.stop();
  }
});

/** 造一个 ws client 连到 server,等 open。 */
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
    const timer = setTimeout(
      () => reject(new Error('waitForFrame 超时')),
      timeoutMs,
    );
    ws.on('message', (data) => {
      const f = parseFrame(data);
      if (f) {
        clearTimeout(timer);
        resolve(f);
      }
    });
  });
}

describe('parseFrame — 容错', () => {
  it('合法 command 帧解析成功', () => {
    const f = parseFrame(
      JSON.stringify({
        type: 'command',
        channel: 'cmd:app:get-snapshot',
        envelope: { clientId: 'c1', requestId: 'r1', payload: {} },
      }),
    );
    expect(f?.type).toBe('command');
  });

  it('合法 response 帧(ok:false 带 error)解析成功', () => {
    const f = parseFrame(
      JSON.stringify({
        type: 'response',
        requestId: 'r1',
        ok: false,
        error: { code: 'SessionNotFound', message: 'nope' },
      }),
    );
    expect(f?.type).toBe('response');
    if (f?.type === 'response') expect(f.ok).toBe(false);
  });

  it('非法 JSON 返回 null(不抛)', () => {
    expect(parseFrame('not json{')).toBeNull();
  });

  it('结构不全(缺 channel)返回 null', () => {
    expect(parseFrame(JSON.stringify({ type: 'command', envelope: {} }))).toBeNull();
  });

  it('未知 type 返回 null', () => {
    expect(parseFrame(JSON.stringify({ type: 'mystery' }))).toBeNull();
  });

  it('非对象(数字)返回 null', () => {
    expect(parseFrame('42')).toBeNull();
  });
});

describe('WsServer — 连接生命周期', () => {
  it('start(0) 返回 OS 分配的实际端口(非 0)', async () => {
    const { port } = await startServer();
    expect(port).toBeGreaterThan(0);
  });

  it('client 连接 → onClientConnected 触发,transport.clientId 非空', async () => {
    const { server, port } = await startServer();
    const connected = new Promise<{ clientId: string }>((resolve) => {
      server.onClientConnected((t) => resolve({ clientId: t.clientId }));
    });
    await connect(port);
    const { clientId } = await connected;
    expect(typeof clientId).toBe('string');
    expect(clientId.length).toBeGreaterThan(0);
  });

  it('client 断开 → onClientDisconnected 触发,带正确 clientId', async () => {
    const { server, port } = await startServer();
    let seenClientId = '';
    server.onClientConnected((t) => {
      seenClientId = t.clientId;
    });
    const disconnected = new Promise<string>((resolve) => {
      server.onClientDisconnected((id) => resolve(id));
    });
    const ws = await connect(port);
    ws.close();
    const disconnectedId = await disconnected;
    expect(disconnectedId).toBe(seenClientId);
  });

  it('clientCount 随连接/断开增减', async () => {
    const { server, port } = await startServer();
    expect(server.clientCount()).toBe(0);
    const connected = new Promise<void>((resolve) =>
      server.onClientConnected(() => resolve()),
    );
    const ws = await connect(port);
    await connected;
    expect(server.clientCount()).toBe(1);
    const disconnected = new Promise<void>((resolve) =>
      server.onClientDisconnected(() => resolve()),
    );
    ws.close();
    await disconnected;
    expect(server.clientCount()).toBe(0);
  });
});

describe('WsServer — 命令帧 client → server', () => {
  it('client 发 command 帧 → server onMessage 收到,clientId + channel + envelope 正确', async () => {
    const { server, port } = await startServer();
    const got = new Promise<{ clientId: string; frame: WsFrame }>((resolve) => {
      server.onMessage((clientId, frame) => resolve({ clientId, frame }));
    });
    const ws = await connect(port);
    ws.send(
      serializeFrame({
        type: 'command',
        channel: 'cmd:app:get-snapshot',
        envelope: { windowId: 'c-x', requestId: 'r-1', payload: { hi: 1 } },
      }),
    );
    const { clientId, frame } = await got;
    expect(frame.type).toBe('command');
    if (frame.type === 'command') {
      expect(frame.channel).toBe('cmd:app:get-snapshot');
      expect(frame.envelope.requestId).toBe('r-1');
    }
    // clientId 是 server 分配的(非 client 发的 'c-x');阶段1.4 握手后 server 会覆盖。
    expect(clientId).not.toBe('c-x');
  });

  it('client 发非法 JSON → server 静默丢弃(不触发 onMessage)', async () => {
    const { server, port } = await startServer();
    let msgCount = 0;
    server.onMessage(() => {
      msgCount++;
    });
    const ws = await connect(port);
    ws.send('totally not json');
    await new Promise((r) => setTimeout(r, 100));
    expect(msgCount).toBe(0);
  });
});

describe('WsServer — 事件帧 server → client', () => {
  it('createWsClientTransport.send → client 收到 event 帧 JSON', async () => {
    const { server, port } = await startServer();
    const transportP = new Promise<ClientTransport>((resolve) =>
      server.onClientConnected((t) => resolve(t)),
    );
    const ws = await connect(port);
    const t = await transportP;

    const frameP = waitForFrame(ws);
    // 模拟 ClientRegistry.broadcast/sendTo 调 transport.send(channel, envelope)
    t.send('evt:session:created', {
      eventId: 'e-1',
      timestamp: 123,
      payload: { session: { id: 's-1' } },
    });
    const frame = await frameP;
    expect(frame.type).toBe('event');
    if (frame.type === 'event') {
      expect(frame.channel).toBe('evt:session:created');
      expect(frame.envelope.eventId).toBe('e-1');
    }
  });

  it('send 在 ws 非 OPEN 状态静默丢弃(不抛 InvalidStateError)', async () => {
    const { server, port } = await startServer();
    const transportP = new Promise<ClientTransport>((resolve) =>
      server.onClientConnected((t) => resolve(t)),
    );
    const ws = await connect(port);
    const t = await transportP;
    // 主动 close 让 ws 进入 CLOSING/CLOSED
    const closed = new Promise<void>((r) => ws.on('close', () => r()));
    ws.close();
    await closed;
    // ws 已 CLOSED,send 应静默返回(不抛)
    expect(() =>
      t.send('evt:x', { eventId: 'e', timestamp: 0, payload: {} }),
    ).not.toThrow();
  });
});

describe('WsServer — handler 隔离', () => {
  it('一个 message handler 抛错不影响其他 handler', async () => {
    const { server, port } = await startServer();
    let secondCalled = false;
    server.onMessage(() => {
      throw new Error('boom in handler 1');
    });
    server.onMessage(() => {
      secondCalled = true;
    });
    const ws = await connect(port);
    ws.send(
      serializeFrame({
        type: 'command',
        channel: 'cmd:x',
        envelope: { windowId: '', requestId: 'r', payload: {} },
      }),
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(secondCalled).toBe(true);
  });
});

describe('WsServer — 重连竞态', () => {
  it('同一 clientId 重连后,旧 ws 的 close 事件不删除新 ws 的 registry 条目', async () => {
    // 场景:client A 连上(分配 id='recon-1'),然后重连(复用 id='recon-1'),
    // 旧 ws 的 close 事件晚于新 ws 注册才触发。修复前:close 会错误删除新 ws 条目,
    // 导致新连接从 registry 丢失。
    const { server, port } = await startServer();

    // 用 auth handler 固定 clientId,模拟 resume 重连。
    server.setAuthHandler(() => ({ clientId: 'recon-1' }));

    // onClientConnected 在每次 registerClient 后触发,用来等待握手完成。
    let connectCount = 0;
    const connectedAll = new Promise<void>((resolve) => {
      server.onClientConnected(() => {
        connectCount++;
        if (connectCount >= 2) resolve();
      });
    });

    // client 必须发 auth 帧才能完成握手。
    function connectWithAuth(): WebSocket {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token: 'test-token' }));
      });
      ws.on('error', () => {
        // 旧 ws 会被关闭,错误事件正常,忽略
      });
      return ws;
    }

    const ws1 = connectWithAuth();
    // 等首次连接握手完成
    const firstConnected = new Promise<void>((r) =>
      server.onClientConnected(() => r()),
    );
    await firstConnected;
    expect(server.clientCount()).toBe(1);

    // 重连:新 ws 复用同一 clientId
    const ws2 = connectWithAuth();
    await connectedAll;
    expect(server.clientCount()).toBe(1);

    // 现在关掉旧 ws1。旧 close 事件触发,但 registry 里已是 ws2。
    // 修复前:close 会错误删除条目 → clientCount 变 0,新连接丢失。
    const ws1Closed = new Promise<void>((r) => ws1.on('close', () => r()));
    ws1.close();
    await ws1Closed;
    await new Promise((r) => setTimeout(r, 200));

    // 新 ws2 应该仍在 registry
    expect(server.clientCount()).toBe(1);

    ws2.close();
    await new Promise((r) => setTimeout(r, 200));
  }, 10000);
});
