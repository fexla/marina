/**
 * @file remote-daemon-controller.test.ts
 * @purpose 测 RemoteDaemonController 的端口监听自检(selfCheckListen)+ getStatus。
 *
 * 重点验证:start 成功后,controller 主动 connect 127.0.0.1:port 验证监听生效,
 * listenCheck.ok=true 写进 getStatus。这是"服务开了但连不上"诊断的关键信号。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ClientRegistry } from './client-registry';
import type { SessionManager } from './session-manager';
import { RemoteDaemonController } from './remote-daemon-controller';

const TOKEN = 'selfcheck-token';

function makeMockSessionManager() {
  return {
    handleWindowClosed: vi.fn(),
  } as unknown as SessionManager;
}

interface CtrlHarness {
  controller: RemoteDaemonController;
  registry: ClientRegistry;
}
const harnesses: CtrlHarness[] = [];

function makeController(): CtrlHarness {
  const registry = new ClientRegistry();
  const controller = new RemoteDaemonController({
    registry,
    sessionManager: makeMockSessionManager(),
    dispatch: vi.fn(async () => ({ ok: true as const, result: { default: true } })),
    getCredentialsToken: () => TOKEN,
    persistPassword: vi.fn(async () => {}),
  });
  const h = { controller, registry };
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  while (harnesses.length) {
    const h = harnesses.pop()!;
    try {
      await h.controller.stop();
    } catch {
      /* 忽略 */
    }
  }
});

describe('RemoteDaemonController — addStatusListener 不覆盖 onStatusChange', () => {
  // 回归(cp3 勘误 / 用户报告 start 后 UI 永远显示“未启动”):
  // 历史上 index.ts 用 controller.onStatusChange = 赋值覆盖了 ipc.ts 设的
  // broadcast 回调 → start 后 status 不 broadcast → UI 不更新。修复:
  // 加 addStatusListener(多监听器),emitStatus 同时调 onStatusChange 和
  // 所有 listener。这条测试锁住“两者都被调,互不覆盖”。
  it('emitStatus 同时调 onStatusChange(broadcast)和 addStatusListener 加的监听器', async () => {
    const { controller } = makeController();
    const broadcastCalls: unknown[] = [];
    const listenerCalls: unknown[] = [];
    // 模拟 ipc.ts 设的 broadcast 回调(wireEventBroadcasts 里设)
    controller.onStatusChange = (s) => broadcastCalls.push(s);
    // 模拟 index.ts 加的 tray 同步监听器
    const unsub = controller.addStatusListener((s) => listenerCalls.push(s));
    // setPassword 会触发 emitStatus(每调一次状态可能变)
    await controller.setPassword('new-pass-1');
    expect(broadcastCalls.length).toBeGreaterThanOrEqual(1);
    expect(listenerCalls.length).toBeGreaterThanOrEqual(1);
    // 关键:加了 listener 后,broadcast 回调依然被调(没被覆盖)
    expect(broadcastCalls[broadcastCalls.length - 1]).toEqual(
      listenerCalls[listenerCalls.length - 1],
    );
    // 取消订阅后不再调
    const broadcastBefore = broadcastCalls.length;
    const listenerBefore = listenerCalls.length;
    unsub();
    await controller.setPassword('new-pass-2');
    expect(listenerCalls.length).toBe(listenerBefore); // listener 不再调
    expect(broadcastCalls.length).toBeGreaterThan(broadcastBefore); // broadcast 仍调
  });

  it('单个 listener throw 不影响 broadcast 和其他 listener', async () => {
    const { controller } = makeController();
    let broadcastCount = 0;
    let goodListenerCount = 0;
    controller.onStatusChange = () => { broadcastCount += 1; };
    controller.addStatusListener(() => {
      throw new Error('listener boom');
    });
    controller.addStatusListener(() => { goodListenerCount += 1; });
    await controller.setPassword('pass-x');
    expect(broadcastCount).toBeGreaterThanOrEqual(1);
    expect(goodListenerCount).toBeGreaterThanOrEqual(1); // 坏 listener 不影响好的
  });
});

describe('RemoteDaemonController — 端口监听自检', () => {
  it('start 后 listenCheck 最终变 ok(自检 connect 127.0.0.1:port 成功)', async () => {
    const { controller } = makeController();
    const { port } = await controller.start(0); // 随机端口
    // start 立即返回时 listenCheck 可能还没填(自检异步)
    expect(controller.getStatus().running).toBe(true);
    expect(controller.getStatus().port).toBe(port);
    // 等自检完成(轮询 listenCheck 出现,最多 ~2s)
    for (let i = 0; i < 40; i++) {
      if (controller.getStatus().listenCheck !== undefined) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const status = controller.getStatus();
    expect(status.listenCheck).toBeDefined();
    expect(status.listenCheck!.ok).toBe(true);
  });

  it('未启动时 getStatus.listenCheck 为 undefined', () => {
    const { controller } = makeController();
    const status = controller.getStatus();
    expect(status.running).toBe(false);
    expect(status.listenCheck).toBeUndefined();
  });

  it('stop 后 listenCheck 清空', async () => {
    const { controller } = makeController();
    await controller.start(0);
    // 等自检
    for (let i = 0; i < 40; i++) {
      if (controller.getStatus().listenCheck !== undefined) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(controller.getStatus().listenCheck).toBeDefined();
    await controller.stop();
    expect(controller.getStatus().listenCheck).toBeUndefined();
    expect(controller.getStatus().running).toBe(false);
  });

  it('未设密码不能启动', async () => {
    const registry = new ClientRegistry();
    const controller = new RemoteDaemonController({
      registry,
      sessionManager: makeMockSessionManager(),
      dispatch: vi.fn(async () => ({ ok: true as const, result: { default: true } })),
      getCredentialsToken: () => null, // 无密码
      persistPassword: vi.fn(async () => {}),
    });
    await expect(controller.start(0)).rejects.toThrow(/密码/);
  });
});
