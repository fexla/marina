/**
 * @file src/main/file-tree-polling-service.test.ts
 * @purpose 验证 FileTreePollingService(demand-aware 文件树轮询)的行为契约:
 *   - demand 注册/注销 task;HOT 立即跑,间隔 3s 续排,无 demand 不跑
 *   - 展开目录并集轮询 + JSON diff 基线:无变化不 emit,变化才广播
 *   - owner/exited 校验(与 GitService 同构的准入规则)
 *   - removePollingConsumer / onSessionOwnerChanged / onSessionExited /
 *     onSessionDestroyed 生命周期清理
 *
 * @关键策略:
 * - fileTreeService 用 mock(不碰真 fs):listDirectory 按 requesterId 做 owner
 *   校验,返回可变的 listings 快照,模拟文件系统变化。
 * - 调度用真 BackgroundWorkScheduler + vi.useFakeTimers(同 git-service.test.ts)。
 * - 不测 FileTreeService 本身(那是 file-tree-service.test.ts 的职责)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundWorkScheduler } from './background-work-scheduler';
import { FileTreePollingService } from './file-tree-polling-service';
import type { FileTreeService } from './file-tree-service';
import { PerformanceMetrics } from './performance-metrics';
import type {
  FileTreeChangedPayload,
  FileTreePollingDir,
  ListFileTreeDirectoryResponse,
} from '@shared/protocol';
import type { Mock } from 'vitest';

interface SessionEntry {
  pathId: string;
  currentCwd: string;
  ownerWindowId: string | null;
  state: 'active' | 'idle' | 'exited';
}

/** 与 file-tree-service 返回同形的快照。 */
function snapshot(
  rootId: 'session-cwd' | 'managed-workspace',
  relativePath: string,
  names: string[],
): ListFileTreeDirectoryResponse {
  return {
    rootId,
    relativePath,
    entries: names.map((name, i) => ({
      relativePath: relativePath ? `${relativePath}/${name}` : name,
      name,
      kind: 'file' as const,
      size: i + 1,
      mtimeMs: i + 1,
    })),
    truncated: false,
  };
}

describe('FileTreePollingService', () => {
  let sessions: Record<string, SessionEntry>;
  /** 可变目录快照源:测试通过改它模拟文件系统变化。 */
  let listings: Record<string, ListFileTreeDirectoryResponse>;
  let listDirectory: Mock;
  let scheduler: BackgroundWorkScheduler;
  let service: FileTreePollingService;
  let emitted: FileTreeChangedPayload[];

  const dir = (rootId: string, relativePath = ''): FileTreePollingDir => ({
    rootId: rootId as FileTreePollingDir['rootId'],
    relativePath,
  });

  beforeEach(() => {
    sessions = {
      s1: { pathId: '/work', currentCwd: '/work', ownerWindowId: 'w1', state: 'idle' },
      s2: { pathId: '/work', currentCwd: '/work', ownerWindowId: 'w2', state: 'idle' },
    };
    listings = {
      'session-cwd:': snapshot('session-cwd', '', ['a.txt', 'b.txt']),
      'session-cwd:src': snapshot('session-cwd', 'src', ['main.ts']),
    };
    listDirectory = vi.fn(
      async (
        sessionId: string,
        requesterId: string,
        rootId: string,
        relativePath = '',
      ): Promise<ListFileTreeDirectoryResponse> => {
        const session = sessions[sessionId];
        if (!session) throw new Error('SessionMissing');
        if (session.ownerWindowId !== requesterId) throw new Error('NotOwner');
        const snap = listings[`${rootId}:${relativePath}`];
        if (!snap) throw new Error('ReadFailed');
        return snap;
      },
    );
    scheduler = new BackgroundWorkScheduler({ metrics: new PerformanceMetrics() });
    service = new FileTreePollingService(
      { get: (id) => sessions[id] ?? null },
      { listDirectory } as unknown as FileTreeService,
      scheduler,
    );
    emitted = [];
    service.on('fileTreeChanged', (p: FileTreeChangedPayload) => emitted.push(p));
  });

  afterEach(() => {
    service.shutdown();
    scheduler.shutdown();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ── demand 注册 / 调度 ─────────────────────────────────────────────
  it('HOT demand 注册 task;无展开目录时轮询为空操作(不调 listDirectory)', async () => {
    vi.useFakeTimers();
    service.setPollingDemand('s1', 'w1', 'hot');
    expect(scheduler.getSnapshot()).toMatchObject({ tasks: 1, hotTasks: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(listDirectory).not.toHaveBeenCalled();
    // 3s 后续排;无目录仍不拉取。
    await vi.advanceTimersByTimeAsync(3000);
    expect(listDirectory).not.toHaveBeenCalled();
  });

  it('HOT + 展开目录:立即轮询并 emit(首次无基线视为变化)', async () => {
    vi.useFakeTimers();
    service.setWatchedDirs('s1', 'w1', [dir('session-cwd')]);
    service.setPollingDemand('s1', 'w1', 'hot');
    await vi.advanceTimersByTimeAsync(0);
    expect(listDirectory).toHaveBeenCalledTimes(1);
    expect(listDirectory).toHaveBeenCalledWith('s1', 'w1', 'session-cwd', '');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.sessionId).toBe('s1');
    expect(emitted[0]!.changes).toHaveLength(1);
    expect(emitted[0]!.changes[0]).toMatchObject({
      rootId: 'session-cwd',
      relativePath: '',
    });
  });

  it('内容未变不 emit;变化(文件被删)才 emit 新快照', async () => {
    vi.useFakeTimers();
    service.setWatchedDirs('s1', 'w1', [dir('session-cwd')]);
    service.setPollingDemand('s1', 'w1', 'hot');
    await vi.advanceTimersByTimeAsync(0);
    expect(emitted).toHaveLength(1); // 首次基线填充

    await vi.advanceTimersByTimeAsync(3000); // 无变化
    expect(listDirectory).toHaveBeenCalledTimes(2);
    expect(emitted).toHaveLength(1);

    // 删除 a.txt → 下一轮 diff 出变化
    listings['session-cwd:'] = snapshot('session-cwd', '', ['b.txt']);
    await vi.advanceTimersByTimeAsync(3000);
    expect(emitted).toHaveLength(2);
    expect(emitted[1]!.changes[0]!.snapshot.entries.map((e) => e.name)).toEqual(['b.txt']);
  });

  it('WARM 档不参与(renderer 只报 HOT/NONE):NONE 立即停轮询', async () => {
    vi.useFakeTimers();
    service.setWatchedDirs('s1', 'w1', [dir('session-cwd')]);
    service.setPollingDemand('s1', 'w1', 'hot');
    await vi.advanceTimersByTimeAsync(0);
    expect(listDirectory).toHaveBeenCalledTimes(1);

    service.setPollingDemand('s1', 'w1', 'none');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(listDirectory).toHaveBeenCalledTimes(1); // 不再续排
  });

  // ── 准入校验(与 GitService 同构)────────────────────────────────────
  it('非 owner 窗口报 HOT demand 被拒;NONE 幂等允许', async () => {
    expect(() => service.setPollingDemand('s1', 'other', 'hot')).toThrowError(
      expect.objectContaining({ code: 'NotOwner' }),
    );
    expect(() => service.setPollingDemand('s1', 'other', 'none')).not.toThrow();
    // 非 owner 的非空目录集同样拒绝;空数组(卸载 cleanup)允许。
    expect(() => service.setWatchedDirs('s1', 'other', [dir('session-cwd')])).toThrowError(
      expect.objectContaining({ code: 'NotOwner' }),
    );
    expect(() => service.setWatchedDirs('s1', 'other', [])).not.toThrow();
  });

  it('不存在的 session 报 HOT 被拒', async () => {
    expect(() => service.setPollingDemand('ghost', 'w1', 'hot')).toThrowError(
      expect.objectContaining({ code: 'SessionMissing' }),
    );
    expect(() => service.setWatchedDirs('ghost', 'w1', [dir('session-cwd')])).toThrowError(
      expect.objectContaining({ code: 'SessionMissing' }),
    );
  });

  it('exited session:拒绝新 demand 且任务被清理', async () => {
    vi.useFakeTimers();
    service.setWatchedDirs('s1', 'w1', [dir('session-cwd')]);
    service.setPollingDemand('s1', 'w1', 'hot');
    service.onSessionExited('s1');
    expect(scheduler.getSnapshot().tasks).toBe(0);
    expect(() => service.setPollingDemand('s1', 'w1', 'hot')).toThrowError(
      expect.objectContaining({ code: 'SessionExited' }),
    );
    // exited 后 NONE 仍幂等(React cleanup 保证)。
    expect(() => service.setPollingDemand('s1', 'w1', 'none')).not.toThrow();
    await vi.advanceTimersByTimeAsync(3000);
    expect(listDirectory).not.toHaveBeenCalled();
  });

  // ── 多 session 各自轮询(一个 session 只有一个 owner 窗口)─────────────
  it('两个窗口各持一个 session:各自 task、各自 requesterId、互不干扰', async () => {
    vi.useFakeTimers();
    service.setWatchedDirs('s1', 'w1', [dir('session-cwd')]);
    service.setWatchedDirs('s2', 'w2', [dir('session-cwd', 'src')]);
    service.setPollingDemand('s1', 'w1', 'hot');
    service.setPollingDemand('s2', 'w2', 'hot');
    expect(scheduler.getSnapshot().tasks).toBe(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(listDirectory).toHaveBeenCalledTimes(2);
    expect(listDirectory).toHaveBeenCalledWith('s1', 'w1', 'session-cwd', '');
    expect(listDirectory).toHaveBeenCalledWith('s2', 'w2', 'session-cwd', 'src');
  });

  // ── 生命周期清理 ───────────────────────────────────────────────────
  it('removePollingConsumer:清 demand;窗口全走后注销对应 task', async () => {
    vi.useFakeTimers();
    service.setWatchedDirs('s1', 'w1', [dir('session-cwd')]);
    service.setWatchedDirs('s2', 'w2', [dir('session-cwd', 'src')]);
    service.setPollingDemand('s1', 'w1', 'hot');
    service.setPollingDemand('s2', 'w2', 'hot');
    expect(scheduler.getSnapshot().tasks).toBe(2);

    service.removePollingConsumer('w1');
    expect(scheduler.getSnapshot().tasks).toBe(1); // s2 的 task 保留
    expect(scheduler.getSnapshot().hotTasks).toBe(1);
    service.removePollingConsumer('w2');
    expect(scheduler.getSnapshot().tasks).toBe(0); // 全部注销
    await vi.advanceTimersByTimeAsync(3000);
    expect(listDirectory).not.toHaveBeenCalled();
  });

  it('onSessionOwnerChanged:清全部 demand + consumer(task 注销)', async () => {
    vi.useFakeTimers();
    service.setWatchedDirs('s1', 'w1', [dir('session-cwd')]);
    service.setPollingDemand('s1', 'w1', 'hot');
    expect(scheduler.getSnapshot().hotTasks).toBe(1);
    service.onSessionOwnerChanged('s1');
    expect(scheduler.getSnapshot()).toMatchObject({ tasks: 0, hotTasks: 0 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(listDirectory).not.toHaveBeenCalled();
  });

  it('onSessionDestroyed:幂等清理,未知 session 不抛', async () => {
    service.setWatchedDirs('s1', 'w1', [dir('session-cwd')]);
    service.setPollingDemand('s1', 'w1', 'hot');
    expect(scheduler.getSnapshot().tasks).toBe(1);
    service.onSessionDestroyed('s1');
    expect(scheduler.getSnapshot().tasks).toBe(0);
    expect(() => service.onSessionDestroyed('never-existed')).not.toThrow();
  });

  it('窗口失去 owner 后轮询失败不 emit、不崩溃,任务保留待清理', async () => {
    vi.useFakeTimers();
    service.setWatchedDirs('s1', 'w1', [dir('session-cwd')]);
    service.setPollingDemand('s1', 'w1', 'hot');
    await vi.advanceTimersByTimeAsync(0);
    expect(emitted).toHaveLength(1);

    // w1 失去 owner(被别的窗口接管);下一轮 listDirectory 按 requester 校验拒绝。
    sessions.s1!.ownerWindowId = 'w3';
    await vi.advanceTimersByTimeAsync(3000);
    expect(emitted).toHaveLength(1); // 不广播错误
    // owner 变更事件正式清理。
    service.onSessionOwnerChanged('s1');
    expect(scheduler.getSnapshot().tasks).toBe(0);
  });
});
