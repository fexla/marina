/**
 * @file src/main/file-tree-polling-service.ts
 * @purpose 文件树目录列表的后台轮询失效源(ADR-021 demand-aware task,与 Git 同构)。
 *
 * @关键设计:
 * - 目录列表快照此前缓存在 renderer 的 L1 缓存且**没有任何失效源**:无 watcher、
 *   无轮询,收起再展开也不重拉,远程文件系统(inotify 不可靠)上删除的文件
 *   几小时不消失。本服务是失效源:按 demand 轮询已展开目录,变化时广播事件。
 * - 按 **session** 注册 task(consumerId=windowId):展开目录集合是每个窗口文件
 *   面板的私有态,两个窗口看同一 session 时轮询它们的并集,demand 取最高。
 * - 与 Git 的三级 demand 不同,文件树只允许 HOT/NONE:只有前台窗口可见的
 *   文件面板才需要刷新(需求:后台窗口不刷),所以 renderer 从不报 WARM。
 * - 每次 poll 都走 FileTreeService.listDirectory(requesterId=该目录所属的
 *   consumer 窗口),owner 校验天然在每个请求上重新执行 —— 窗口失去 owner 后
 *   其目录轮询立刻失败并被跳过,不会跨 session 读文件。
 * - 与 lastSnapshots 基线做 JSON diff:内容没变不广播,避免每 3 秒向所有窗口
 *   推全量列表;首次 poll(基线缺失)视为变化,用于面板挂载时填缓存。
 * - exited session 只保留静态快照(ADR-008),不再后台扫描,与 GitService 一致。
 *
 * @对应文档章节:docs/standards/background-tasks.md(ADR-021);
 *   docs/standards/panel-ui-state.md(ADR-019,L1 缓存必须自带失效源)。
 *
 * @不要在这里做的事:
 * - 不直接碰 fs / 不解析路径:所有列举委托 FileTreeService,安全校验不重复。
 * - 不记录 task key/sessionId 到性能指标(可能含敏感标识,附录 H)。
 * - 不在本模块加 setInterval(调度器统一管理递归 setTimeout)。
 */
import { EventEmitter } from 'node:events';
import type { FileTreePollingDir, ListFileTreeDirectoryResponse } from '@shared/protocol';
import type { BackgroundDemandLevel } from '@shared/protocol';
import type { FileTreeService, FileTreeSessionLookup } from './file-tree-service';
import { BackgroundWorkScheduler } from './background-work-scheduler';
import { logger } from './logger';
import { performanceMetrics } from './performance-metrics';

const MODULE = 'FileTreePollingService';

/** HOT 轮询间隔(与 Git 相同):前台面板可见期间,完成一轮后 3 秒再扫。 */
const FILE_TREE_HOT_POLL_MS = 3000;
/** WARM 间隔(保留满足调度器校验;renderer 从不报 WARM,实际不会使用)。 */
const FILE_TREE_WARM_POLL_MS = 60_000;

/** 与 GitError 同构的错误:code 供日志/诊断,message 给 renderer 展示。 */
export class FileTreePollingError extends Error {
  constructor(
    public readonly code: 'SessionMissing' | 'SessionExited' | 'NotOwner',
    message: string,
  ) {
    super(message);
    this.name = 'FileTreePollingError';
  }
}

/** 一个 session 的轮询状态。 */
interface SessionPollState {
  /** windowId → 该窗口上报的展开目录集合(并集 = 轮询目标)。 */
  consumers: Map<string, { dirs: FileTreePollingDir[] }>;
  /** dirKey → 上次成功列举的基线,用于 diff;首次 poll 基线缺失视为变化。 */
  lastSnapshots: Map<string, ListFileTreeDirectoryResponse>;
  /** scheduler task key = `file-tree:${sessionId}`(main 端生成,不接受 renderer 自造)。 */
  taskKey: string;
}

/** dirKey 只用于 Map 键:由结构化 dir 构造,永不解析,路径含 ':' 也安全。 */
function dirKey(dir: FileTreePollingDir): string {
  return `${dir.rootId}:${dir.relativePath}`;
}

/**
 * 文件树目录列表的 demand-aware 后台轮询。
 *
 * 生命周期接线(ipc.ts / index.ts 调):
 * - 窗口关闭/远程断线 → removePollingConsumer(windowId)
 * - owner 切换 → onSessionOwnerChanged(sessionId)(新 owner 会重新绝对上报)
 * - PTY 退出 → onSessionExited(sessionId)(exited 快照保留但不后台扫描)
 * - session 销毁 → onSessionDestroyed(sessionId)
 */
export class FileTreePollingService extends EventEmitter {
  /** sessionId → 轮询状态(task + consumer 展开集 + diff 基线)。 */
  private readonly sessions = new Map<string, SessionPollState>();
  /** 已退出的 session:拒绝新 demand,跑中的 poll 直接放弃。 */
  private readonly exitedSessions = new Set<string>();

  constructor(
    private readonly sessionLookup: FileTreeSessionLookup,
    private readonly fileTreeService: FileTreeService,
    private readonly scheduler: BackgroundWorkScheduler = new BackgroundWorkScheduler(),
  ) {
    super();
  }

  /**
   * renderer 上报文件树轮询的绝对需求。HOT 只能由当前 owner 注册;NONE 在
   * session 已消失/已退出后仍幂等允许(React cleanup 必须永远能执行)。
   */
  setPollingDemand(sessionId: string, consumerId: string, level: BackgroundDemandLevel): void {
    if (level === 'none') {
      const state = this.sessions.get(sessionId);
      if (state) this.scheduler.setDemand(state.taskKey, consumerId, 'none');
      return;
    }
    this.requireActiveSession(sessionId, consumerId);
    const state = this.ensureSession(sessionId);
    this.scheduler.setDemand(state.taskKey, consumerId, level);
  }

  /**
   * FileTreePanel 上报当前已展开目录集合(即轮询目标)。
   *
   * 空数组 = 面板卸载/无展开目录,幂等清除该窗口的 consumer(owner 切换后
   * 旧 renderer 的 cleanup 也可能执行,所以不校验 owner)。
   */
  setWatchedDirs(sessionId: string, consumerId: string, dirs: FileTreePollingDir[]): void {
    const state = this.sessions.get(sessionId);
    if (dirs.length === 0) {
      if (state) state.consumers.delete(consumerId);
      return;
    }
    this.requireActiveSession(sessionId, consumerId);
    const target = this.ensureSession(sessionId);
    target.consumers.set(consumerId, { dirs });
  }

  /** 窗口关闭/远程断线:撤销该窗口在全部 session 上的 demand + 展开集。 */
  removePollingConsumer(consumerId: string): void {
    for (const [sessionId, state] of this.sessions) {
      if (!state.consumers.delete(consumerId)) continue;
      this.scheduler.setDemand(state.taskKey, consumerId, 'none');
      if (state.consumers.size === 0) this.disposeSession(sessionId);
    }
  }

  /** owner 切换:旧窗口的 demand/展开集全部作废,新 owner 收到事件后重新绝对上报。 */
  onSessionOwnerChanged(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    for (const windowId of [...state.consumers.keys()]) {
      this.scheduler.setDemand(state.taskKey, windowId, 'none');
    }
    state.consumers.clear();
    this.disposeSession(sessionId);
  }

  /** PTY 自然退出:exited 快照保留(ADR-008),但立即停掉后台轮询。 */
  onSessionExited(sessionId: string): void {
    this.exitedSessions.add(sessionId);
    this.disposeSession(sessionId);
  }

  /** session 销毁:清 task/demand/基线,并从 exited 记录移除(生命周期终结)。 */
  onSessionDestroyed(sessionId: string): void {
    this.exitedSessions.delete(sessionId);
    this.disposeSession(sessionId);
  }

  /** 应用退出/服务卸载:注销本服务全部 task;共享 scheduler 由装配层最终 shutdown。 */
  shutdown(): void {
    for (const sessionId of [...this.sessions.keys()]) this.disposeSession(sessionId);
    this.sessions.clear();
    this.exitedSessions.clear();
  }

  /** scheduler task key(main 端生成;renderer 协议只有固定业务枚举,不能自造 key)。 */
  private pollingTaskKey(sessionId: string): string {
    return `file-tree:${sessionId}`;
  }

  /** session 存在 + 未退出 + consumer 是当前 owner,否则抛错(NONE 路径不经过这里)。 */
  private requireActiveSession(sessionId: string, consumerId: string): void {
    const session = this.sessionLookup.get(sessionId);
    if (!session) {
      throw new FileTreePollingError(
        'SessionMissing',
        '会话不存在或已关闭,无法注册文件树刷新需求。请切换到仍在运行的终端。',
      );
    }
    if (this.exitedSessions.has(sessionId)) {
      throw new FileTreePollingError(
        'SessionExited',
        '已退出会话只保留静态文件快照,不再后台刷新。',
      );
    }
    if (!consumerId || session.ownerWindowId !== consumerId) {
      throw new FileTreePollingError(
        'NotOwner',
        '只有当前持有该会话的窗口才能注册文件树刷新需求。请先接管会话。',
      );
    }
  }

  /** 幂等注册 session 轮询状态 + scheduler task。 */
  private ensureSession(sessionId: string): SessionPollState {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const taskKey = this.pollingTaskKey(sessionId);
    const state: SessionPollState = {
      consumers: new Map(),
      lastSnapshots: new Map(),
      taskKey,
    };
    this.sessions.set(sessionId, state);
    this.scheduler.registerTask(taskKey, {
      hotIntervalMs: FILE_TREE_HOT_POLL_MS,
      warmIntervalMs: FILE_TREE_WARM_POLL_MS,
      run: () => this.pollSession(sessionId),
      onError: (error) => {
        logger.warn(
          MODULE,
          `scheduled file-tree refresh failed sessionId=${sessionId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      },
    });
    performanceMetrics.setGauge('fileTree.sessions', this.sessions.size);
    logger.debug(
      MODULE,
      `file-tree polling task registered ${taskKey} hot=${FILE_TREE_HOT_POLL_MS}ms warm=${FILE_TREE_WARM_POLL_MS}ms`,
    );
    return state;
  }

  /** 注销 session 的 task 并删除状态(所有清理路径的唯一出口)。 */
  private disposeSession(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    this.sessions.delete(sessionId);
    this.scheduler.unregisterTask(state.taskKey);
    performanceMetrics.setGauge('fileTree.sessions', this.sessions.size);
    logger.debug(MODULE, `file-tree polling task unregistered ${state.taskKey}`);
  }

  /** 一次轮询:列举全部展开目录并集,diff 基线,变化时广播一次事件。 */
  private async pollSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state || state.consumers.size === 0) return;
    // 纵深防御:onSessionExited 已清理任务;跑中时被标记 exited 则放弃本轮。
    if (this.exitedSessions.has(sessionId)) return;

    // 每个目录归属它自己的 consumer 窗口(作 listDirectory 的 requesterId)。
    // 多窗口同时展开同一目录时只轮询一次(首见窗口作 requester)。
    const targets = new Map<string, { dir: FileTreePollingDir; requesterId: string }>();
    for (const [windowId, consumer] of state.consumers) {
      for (const dir of consumer.dirs) {
        const key = dirKey(dir);
        if (!targets.has(key)) targets.set(key, { dir, requesterId: windowId });
      }
    }
    if (targets.size === 0) return;
    performanceMetrics.increment('fileTree.pollRuns');

    const changes: Array<{
      rootId: FileTreePollingDir['rootId'];
      relativePath: string;
      snapshot: ListFileTreeDirectoryResponse;
    }> = [];
    for (const { dir, requesterId } of targets.values()) {
      const key = dirKey(dir);
      try {
        const snapshot = await this.fileTreeService.listDirectory(
          sessionId,
          requesterId,
          dir.rootId,
          dir.relativePath,
        );
        const previous = state.lastSnapshots.get(key);
        if (!previous || JSON.stringify(previous) !== JSON.stringify(snapshot)) {
          state.lastSnapshots.set(key, snapshot);
          changes.push({ rootId: dir.rootId, relativePath: dir.relativePath, snapshot });
        }
      } catch (err) {
        // 目录被删 / 窗口失去 owner / 瞬时网络错误:跳过本轮,保留旧基线,
        // 下一轮自然重试;不把错误广播给面板(面板保留现有快照即可)。
        logger.debug(
          MODULE,
          `file-tree poll skipped sessionId=${sessionId} root=${dir.rootId} path=${dir.relativePath} reason=${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    if (changes.length > 0) {
      this.emit('fileTreeChanged', { sessionId, changes });
    }
  }
}
