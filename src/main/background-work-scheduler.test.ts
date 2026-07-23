/**
 * @file src/main/background-work-scheduler.test.ts
 * @purpose 验证 HOT/WARM/COLD 动态周期、全局串行、pre-demand 与 generation 竞态。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundWorkScheduler } from './background-work-scheduler';
import { PerformanceMetrics } from './performance-metrics';

async function flushMicrotasks(): Promise<void> {
  // scheduler 的 run → then(error isolation) → finally(drain next task) 有多层 microtask。
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('BackgroundWorkScheduler', () => {
  let scheduler: BackgroundWorkScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    scheduler = new BackgroundWorkScheduler({ metrics: new PerformanceMetrics() });
  });

  afterEach(() => {
    scheduler.shutdown();
    vi.useRealTimers();
  });

  it('保留 register 前到达的 HOT demand，注册后立即跑并按 3s 续排', async () => {
    const run = vi.fn(async () => {});
    scheduler.setDemand('git-status:s1', 'window-1', 'hot');
    expect(scheduler.getSnapshot().pendingDemandTasks).toBe(1);

    scheduler.registerTask('git-status:s1', {
      run,
      hotIntervalMs: 3000,
      warmIntervalMs: 60_000,
    });
    await flushMicrotasks();
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('WARM 首次等待 60s；切 HOT 取消长 timer 并立即跑', async () => {
    const run = vi.fn(async () => {});
    scheduler.registerTask('git-status:s1', {
      run,
      hotIntervalMs: 3000,
      warmIntervalMs: 60_000,
    });
    scheduler.setDemand('git-status:s1', 'window-1', 'warm');
    await vi.advanceTimersByTimeAsync(59_999);
    expect(run).not.toHaveBeenCalled();

    scheduler.setDemand('git-status:s1', 'window-1', 'hot');
    await flushMicrotasks();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('HOT→WARM 取消旧 3s timer，从切换时刻等待完整 60s', async () => {
    const run = vi.fn(async () => {});
    scheduler.registerTask('git-status:s1', {
      run,
      hotIntervalMs: 3000,
      warmIntervalMs: 60_000,
    });
    scheduler.setDemand('git-status:s1', 'window-1', 'hot');
    await flushMicrotasks();
    expect(run).toHaveBeenCalledTimes(1);

    scheduler.setDemand('git-status:s1', 'window-1', 'warm');
    await vi.advanceTimersByTimeAsync(3000);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(57_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('同 task 运行期间不重叠，降为 NONE 后 completion 不续排', async () => {
    const gate = deferred();
    let running = 0;
    let maxRunning = 0;
    const run = vi.fn(async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await gate.promise;
      running -= 1;
    });
    scheduler.registerTask('git-status:s1', {
      run,
      hotIntervalMs: 3000,
      warmIntervalMs: 60_000,
    });
    scheduler.setDemand('git-status:s1', 'window-1', 'hot');
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(maxRunning).toBe(1);

    scheduler.setDemand('git-status:s1', 'window-1', 'none');
    gate.resolve();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('全局 maxConcurrent=1，两个 HOT task 串行', async () => {
    const firstGate = deferred();
    const order: string[] = [];
    scheduler.registerTask('git-status:s1', {
      run: async () => {
        order.push('s1:start');
        await firstGate.promise;
        order.push('s1:end');
      },
      hotIntervalMs: 3000,
      warmIntervalMs: 60_000,
    });
    scheduler.registerTask('git-status:s2', {
      run: async () => {
        order.push('s2:start');
      },
      hotIntervalMs: 3000,
      warmIntervalMs: 60_000,
    });

    scheduler.setDemand('git-status:s1', 'window-1', 'hot');
    scheduler.setDemand('git-status:s2', 'window-2', 'hot');
    await flushMicrotasks();
    expect(order).toEqual(['s1:start']);
    expect(scheduler.getSnapshot().queued).toBe(1);

    firstGate.resolve();
    await flushMicrotasks();
    expect(order).toEqual(['s1:start', 's1:end', 's2:start']);
  });

  it('多 consumer 取最高需求，移除 HOT consumer 后降为 WARM', async () => {
    const run = vi.fn(async () => {});
    scheduler.registerTask('git-status:s1', {
      run,
      hotIntervalMs: 3000,
      warmIntervalMs: 60_000,
    });
    scheduler.setDemand('git-status:s1', 'window-warm', 'warm');
    scheduler.setDemand('git-status:s1', 'window-hot', 'hot');
    await flushMicrotasks();
    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduler.getSnapshot()).toMatchObject({ hotTasks: 1, warmTasks: 0 });

    scheduler.removeConsumer('window-hot');
    expect(scheduler.getSnapshot()).toMatchObject({ hotTasks: 0, warmTasks: 1 });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('被全局 slot 阻塞时反复 HOT↔WARM 不累积物理 queue tombstone', async () => {
    const gate = deferred();
    scheduler.registerTask('git-status:blocker', {
      run: () => gate.promise,
      hotIntervalMs: 3000,
      warmIntervalMs: 60_000,
    });
    scheduler.registerTask('git-status:toggled', {
      run: async () => {},
      hotIntervalMs: 3000,
      warmIntervalMs: 60_000,
    });
    scheduler.setDemand('git-status:blocker', 'window-1', 'hot');
    await flushMicrotasks();

    for (let index = 0; index < 500; index += 1) {
      scheduler.setDemand('git-status:toggled', 'window-2', 'hot');
      scheduler.setDemand('git-status:toggled', 'window-2', 'warm');
    }
    scheduler.setDemand('git-status:toggled', 'window-2', 'hot');
    const physicalQueue = (scheduler as unknown as { queue: Set<unknown> }).queue;
    expect(physicalQueue.size).toBe(1);
    expect(scheduler.getSnapshot().queued).toBe(1);
    gate.resolve();
  });

  it('排队后降 NONE 会使旧 queue entry 失效', async () => {
    const firstGate = deferred();
    const second = vi.fn(async () => {});
    scheduler.registerTask('git-status:s1', {
      run: () => firstGate.promise,
      hotIntervalMs: 3000,
      warmIntervalMs: 60_000,
    });
    scheduler.registerTask('git-status:s2', {
      run: second,
      hotIntervalMs: 3000,
      warmIntervalMs: 60_000,
    });
    scheduler.setDemand('git-status:s1', 'window-1', 'hot');
    scheduler.setDemand('git-status:s2', 'window-2', 'hot');
    await flushMicrotasks();
    expect(scheduler.getSnapshot().queued).toBe(1);

    scheduler.setDemand('git-status:s2', 'window-2', 'none');
    firstGate.resolve();
    await flushMicrotasks();
    expect(second).not.toHaveBeenCalled();
  });

  it('同 key unregister→register 后旧 completion 不给新 record 续排', async () => {
    const oldGate = deferred();
    const oldRun = vi.fn(() => oldGate.promise);
    const newRun = vi.fn(async () => {});
    scheduler.registerTask('git-status:s1', {
      run: oldRun,
      hotIntervalMs: 3000,
      warmIntervalMs: 60_000,
    });
    scheduler.setDemand('git-status:s1', 'window-1', 'hot');
    await flushMicrotasks();

    scheduler.unregisterTask('git-status:s1');
    scheduler.setDemand('git-status:s1', 'window-1', 'hot');
    scheduler.registerTask('git-status:s1', {
      run: newRun,
      hotIntervalMs: 3000,
      warmIntervalMs: 60_000,
    });
    oldGate.resolve();
    await flushMicrotasks();
    expect(oldRun).toHaveBeenCalledTimes(1);
    expect(newRun).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3000);
    expect(newRun).toHaveBeenCalledTimes(2);
  });

  it('task reject 被隔离且下一周期继续', async () => {
    const onError = vi.fn();
    const run = vi
      .fn<[], Promise<void>>()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue(undefined);
    scheduler.registerTask('git-status:s1', {
      run,
      hotIntervalMs: 3000,
      warmIntervalMs: 60_000,
      onError,
    });
    scheduler.setDemand('git-status:s1', 'window-1', 'hot');
    await flushMicrotasks();
    expect(onError).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(3000);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
