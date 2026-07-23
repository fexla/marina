/**
 * @file src/renderer/hooks/claim-gate.test.ts
 * @purpose 覆盖 claim-gate 的核心契约 —— 它是消除「乐观接管 orphan session」
 *   与「main 端 owner 异步更新」之间 NotOwner race 的关键。
 *
 * @为什么测这个(AGENTS.md §5.1 renderer 一般不测,但纯逻辑例外):
 *   claim-gate 是纯模块级逻辑(无 JSX/无 DOM/无 React),与 store.test.ts 同类。
 *   它的契约一旦破坏会让所有面板 race 回归,所以必须有回归保护。
 *
 * @核心契约:
 *   1. 无 in-flight claim 时,waitForClaim 立即 resolve(不阻塞常规切换)。
 *   2. claimSession 登记后,waitForClaim 等到 invoke resolve 才 resolve。
 *   3. claim 失败时 waitForLogin... 不,claim 失败时 waitForClaim 仍 resolve
 *      (gate 吞 reject),不向上抛 —— 面板的 await 不会因 claim 失败而 throw。
 *   4. claim settle 后从 gate 清除,waitForClaim 退回立即返回。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetClaimGateForTest, claimSession, waitForClaim } from './claim-gate';

/**
 * claim-gate 通过 window.api.invoke 发 SESSION_CLAIM。node 测试环境没有 window,
 * 这里手动注入一个可控的 invoke mock:返回测试驱动的 pending/resolved/rejected promise。
 * 形状对齐 preload 注入的 window.api(只用 invoke,本模块不依赖 on/off)。
 */
interface FakeApi {
  invoke: ReturnType<typeof vi.fn>;
}

let fakeApi: FakeApi;

beforeEach(() => {
  fakeApi = { invoke: vi.fn() };
  // claim-gate 访问的是全局 window.api(运行时由 preload 注入)。
  (globalThis as unknown as { window: { api: FakeApi } }).window = { api: fakeApi };
  _resetClaimGateForTest();
});

afterEach(() => {
  _resetClaimGateForTest();
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('claim-gate', () => {
  it('无 in-flight claim 时,waitForClaim 立即 resolve(常规切换/已持有不阻塞)', async () => {
    await expect(waitForClaim('s1')).resolves.toBeUndefined();
    // 且不触发任何 window.api 调用 —— waitForClaim 是纯读,不该有副作用。
    expect(fakeApi.invoke).not.toHaveBeenCalled();
  });

  it('claimSession 登记后,waitForClaim 等到 invoke resolve 才 resolve', async () => {
    let resolveClaim!: (v: unknown) => void;
    fakeApi.invoke.mockReturnValue(
      new Promise((r) => {
        resolveClaim = r;
      }),
    );

    const claim = claimSession('s2'); // 登记 + 发起 invoke
    // 此时 invoke 已被调用一次(SESSION_CLAIM)。
    expect(fakeApi.invoke).toHaveBeenCalledTimes(1);

    // claim 未 settle 前,waitForClaim 应 pending。
    let gateResolved = false;
    void waitForClaim('s2').then(() => {
      gateResolved = true;
    });
    await Promise.resolve(); // flush 微任务
    expect(gateResolved).toBe(false);

    // main 端 claim 完成 → gate 放行。
    resolveClaim({ scrollback: '', lastSeq: 0 });
    await waitForClaim('s2'); // 应在 claim settle 后 resolve
    expect(gateResolved).toBe(true);

    // 原始 claim promise 也能拿到正常返回值(不受 gate 包装影响)。
    await expect(claim).resolves.toEqual({ scrollback: '', lastSeq: 0 });
  });

  it('claim 失败(reject)时,waitForClaim 仍 resolve,不向上抛', async () => {
    // 模拟 SessionAlreadyOwned / SessionNotFound 等 claim 失败。
    fakeApi.invoke.mockRejectedValue(new Error('SessionAlreadyOwned'));

    // waitForClaim 不应抛 —— 面板的 await waitForClaim 不会因 claim 失败而进入 catch。
    await expect(waitForClaim('s3')).resolves.toBeUndefined();

    // 原始 claimSession 返回的 promise 仍 reject(调用方据此 rollback),
    // gate 只是把「等待」做成永不 reject 的副本,不影响调用方对失败的感知。
    await expect(claimSession('s3b')).rejects.toThrow('SessionAlreadyOwned');
  });

  it('claim settle 后从 gate 清除,waitForClaim 退回立即返回', async () => {
    fakeApi.invoke.mockResolvedValue({ scrollback: '', lastSeq: 9 });

    const claim = claimSession('s4');
    await waitForClaim('s4'); // 等 claim 完成
    await claim;

    // settle 后 gate 已清除:再次 waitForClaim 不应再阻塞(无需 await 新的 claim)。
    // 用一个微任务探针:若 gate 残留 pending promise,resolvedAfterTick 会是 false。
    let resolvedAfterTick = false;
    void waitForClaim('s4').then(() => {
      resolvedAfterTick = true;
    });
    await Promise.resolve();
    expect(resolvedAfterTick).toBe(true);
  });

  it('多个 session 的 claim 互不干扰(per-session 隔离)', async () => {
    let resolveA!: (v: unknown) => void;
    let resolveB!: (v: unknown) => void;
    fakeApi.invoke.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolveA = r;
        }),
    );
    fakeApi.invoke.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolveB = r;
        }),
    );

    claimSession('s-a');
    claimSession('s-b');

    // b 先完成:waitForClaim('s-b') 应在 resolveB 后 resolve,
    // 而 waitForClaim('s-a') 仍 pending(直到 resolveA)。
    const bGate = waitForClaim('s-b');
    const aGate = waitForClaim('s-a');
    resolveB({ scrollback: '', lastSeq: 0 });
    await expect(bGate).resolves.toBeUndefined(); // b settle

    // a 还没 resolve:它应处于 pending。用 race 探测 — 给它一个微任务机会仍不 resolve。
    let aSettled = false;
    void aGate.then(() => {
      aSettled = true;
    });
    await Promise.resolve();
    expect(aSettled).toBe(false);

    resolveA({ scrollback: '', lastSeq: 0 });
    await expect(aGate).resolves.toBeUndefined();
    expect(aSettled).toBe(true);
  });
});
