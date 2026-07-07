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
