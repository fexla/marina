/**
 * @file src/main/background-work-scheduler.ts
 * @purpose 按 UI demand 调度昂贵周期后台工作，统一动态间隔、串行执行与生命周期清理。
 *
 * @关键设计:
 * - 只承载会 spawn 子进程/做重 I/O 的周期任务；语义 timer/debounce 不进这里
 * - HOT 立即入队并按短间隔续排，WARM 按长间隔续排，NONE 完全停
 * - 用 recursive setTimeout，不用 setInterval；完成后才计算下一次，天然不重叠
 * - 全局 FIFO 有并发上限；queue 保存 TaskRecord identity，旧 generation 不能污染重注册
 * - demand 可以早于 task 注册到达，pending demand 有硬上限且在 register 时吸收
 *
 * @对应文档:docs/方案-需求感知后台任务调度-20260722.md；软件定义书 ADR-021
 *
 * @不要在这里做的事:
 * - 不记录 task key/consumerId（可能含 session/client 标识）到性能报告
 * - 不取消已经开始的外部进程；调用方负责 timeout，scheduler 只阻止下一轮
 * - 不允许 renderer 直接构造任意 task key；renderer 协议必须是固定业务枚举
 */
import type { BackgroundDemandLevel } from '@shared/protocol';
import { performanceMetrics, type PerformanceMetrics } from './performance-metrics';

export type { BackgroundDemandLevel } from '@shared/protocol';

export interface BackgroundTaskDefinition {
  /** 单次工作；reject 会被隔离并在下一周期继续。 */
  run: () => Promise<void>;
  /** HOT 下，本次完成到下一次开始之间的最小间隔。 */
  hotIntervalMs: number;
  /** WARM 下，本次完成到下一次开始之间的最小间隔。 */
  warmIntervalMs: number;
  /** 固定上下文的错误回调；不要把动态路径/参数拼进自动指标。 */
  onError?: (error: unknown) => void;
}

export interface BackgroundWorkSchedulerOptions {
  maxConcurrent?: number;
  metrics?: Pick<PerformanceMetrics, 'begin' | 'increment' | 'setGauge'>;
}

interface TaskRecord {
  readonly key: string;
  readonly definition: BackgroundTaskDefinition;
  readonly demands: Map<string, Exclude<BackgroundDemandLevel, 'none'>>;
  effectiveLevel: BackgroundDemandLevel;
  timer: NodeJS.Timeout | null;
  queued: boolean;
  running: boolean;
  disposed: boolean;
}

export interface BackgroundWorkSchedulerSnapshot {
  tasks: number;
  pendingDemandTasks: number;
  hotTasks: number;
  warmTasks: number;
  running: number;
  queued: number;
}

const MAX_TASKS = 500;
const MAX_PENDING_DEMAND_TASKS = 500;
const MAX_CONSUMERS_PER_TASK = 50;
const MAX_KEY_LENGTH = 160;
const MAX_CONSUMER_LENGTH = 160;
const MIN_INTERVAL_MS = 10;

/**
 * Demand-aware 昂贵后台任务调度器。
 *
 * Node 单线程保证 Map/queue 更新原子；所有 async 边界后的续排都用 record identity
 * 检查当前 task，解决 unregister→同 key register 与旧 completion 的 ABA 竞态。
 */
export class BackgroundWorkScheduler {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly pendingDemands = new Map<
    string,
    Map<string, Exclude<BackgroundDemandLevel, 'none'>>
  >();
  // Set 同时提供 FIFO insertion order 与物理去重/删除；降级不会留下 tombstone 数组。
  private readonly queue = new Set<TaskRecord>();
  private readonly maxConcurrent: number;
  private readonly metrics: Pick<PerformanceMetrics, 'begin' | 'increment' | 'setGauge'>;
  private activeRuns = 0;
  private shuttingDown = false;

  constructor(options: BackgroundWorkSchedulerOptions = {}) {
    this.maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent ?? 1));
    this.metrics = options.metrics ?? performanceMetrics;
    this.updateGauges();
  }

  /**
   * 注册/替换一个 main 内部 task。HOT pre-demand 立即跑，WARM pre-demand 等长周期。
   *
   * 同 key 已存在时先使旧 record 失效；旧运行完成后通过 identity guard 不会给新
   * record 安排 timer。正常业务应幂等检查后注册，替换语义主要用于竞态安全。
   */
  registerTask(key: string, definition: BackgroundTaskDefinition): void {
    this.validateTaskInput(key, definition);
    if (this.shuttingDown) return;
    const previous = this.tasks.get(key);
    if (previous) this.disposeRecord(previous, false);
    if (!previous && this.tasks.size >= MAX_TASKS) {
      throw new Error(
        `[BackgroundWorkScheduler] Task limit ${MAX_TASKS} reached. ` +
          'Possible causes: task lifecycle cleanup missing or a dynamic high-cardinality key. ' +
          'Unregister exited/destroyed sessions before registering more work.',
      );
    }

    const demands = this.pendingDemands.get(key) ?? new Map();
    this.pendingDemands.delete(key);
    const record: TaskRecord = {
      key,
      definition,
      demands,
      effectiveLevel: effectiveDemand(demands),
      timer: null,
      queued: false,
      running: false,
      disposed: false,
    };
    this.tasks.set(key, record);
    this.metrics.increment('background.tasksRegistered');
    this.applyLevel(record, 'none', record.effectiveLevel);
    this.updateGauges();
  }

  /** 注销 task + 它的全部 demand；运行中的本轮可完成，但 completion 不再续排。 */
  unregisterTask(key: string): void {
    const record = this.tasks.get(key);
    if (record) {
      this.disposeRecord(record, true);
      this.metrics.increment('background.tasksUnregistered');
    }
    this.pendingDemands.delete(key);
    this.updateGauges();
    this.drainQueue();
  }

  /**
   * 设置 consumer 对 task 的绝对需求。未注册 task 的 demand 暂存，解决 renderer
   * 先看到 LayoutNode、main prefetch 尚未完成的正常竞态。
   */
  setDemand(key: string, consumerId: string, level: BackgroundDemandLevel): void {
    validateIdentifier('task key', key, MAX_KEY_LENGTH);
    validateIdentifier('consumerId', consumerId, MAX_CONSUMER_LENGTH);
    if (this.shuttingDown) return;

    const record = this.tasks.get(key);
    if (record) {
      const oldLevel = record.effectiveLevel;
      updateDemandMap(record.demands, consumerId, level);
      record.effectiveLevel = effectiveDemand(record.demands);
      this.metrics.increment('background.demandChanges');
      this.applyLevel(record, oldLevel, record.effectiveLevel);
      this.updateGauges();
      return;
    }

    let demands = this.pendingDemands.get(key);
    if (!demands) {
      if (level === 'none') return;
      if (this.pendingDemands.size >= MAX_PENDING_DEMAND_TASKS) {
        throw new Error(
          `[BackgroundWorkScheduler] Pending-demand task limit ${MAX_PENDING_DEMAND_TASKS} reached. ` +
            'Possible causes: renderer is sending demand for stale sessions or lifecycle cleanup is missing.',
        );
      }
      demands = new Map();
      this.pendingDemands.set(key, demands);
    }
    updateDemandMap(demands, consumerId, level);
    if (demands.size === 0) this.pendingDemands.delete(key);
    this.metrics.increment('background.demandChanges');
    this.updateGauges();
  }

  /** 清一个 task 的全部 consumer demand；task 保留为 COLD。 */
  clearTaskDemands(key: string): void {
    this.pendingDemands.delete(key);
    const record = this.tasks.get(key);
    if (!record || record.demands.size === 0) return;
    const oldLevel = record.effectiveLevel;
    record.demands.clear();
    record.effectiveLevel = 'none';
    this.applyLevel(record, oldLevel, 'none');
    this.metrics.increment('background.demandChanges');
    this.updateGauges();
  }

  /** 窗口关闭/远程断线时从全部 task 与 placeholder 移除该 consumer。 */
  removeConsumer(consumerId: string): void {
    validateIdentifier('consumerId', consumerId, MAX_CONSUMER_LENGTH);
    for (const record of this.tasks.values()) {
      if (!record.demands.delete(consumerId)) continue;
      const oldLevel = record.effectiveLevel;
      record.effectiveLevel = effectiveDemand(record.demands);
      this.applyLevel(record, oldLevel, record.effectiveLevel);
    }
    for (const [key, demands] of this.pendingDemands) {
      demands.delete(consumerId);
      if (demands.size === 0) this.pendingDemands.delete(key);
    }
    this.metrics.increment('background.consumersRemoved');
    this.updateGauges();
  }

  /** 应用退出：清 timer/queue/demand。运行中的 Promise 自行结束但不能再续排。 */
  shutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const record of this.tasks.values()) this.disposeRecord(record, false);
    this.tasks.clear();
    this.pendingDemands.clear();
    for (const record of this.queue) record.queued = false;
    this.queue.clear();
    this.metrics.increment('background.schedulerShutdown');
    this.updateGauges();
  }

  getSnapshot(): BackgroundWorkSchedulerSnapshot {
    let hotTasks = 0;
    let warmTasks = 0;
    let running = 0;
    let queued = 0;
    for (const record of this.tasks.values()) {
      if (record.effectiveLevel === 'hot') hotTasks += 1;
      if (record.effectiveLevel === 'warm') warmTasks += 1;
      if (record.running) running += 1;
      if (record.queued) queued += 1;
    }
    return {
      tasks: this.tasks.size,
      pendingDemandTasks: this.pendingDemands.size,
      hotTasks,
      warmTasks,
      running,
      queued,
    };
  }

  private applyLevel(
    record: TaskRecord,
    oldLevel: BackgroundDemandLevel,
    newLevel: BackgroundDemandLevel,
  ): void {
    if (!this.isCurrent(record)) return;
    if (oldLevel === newLevel) return;
    this.clearTimer(record);

    // 物理删除 queued record；反复 HOT↔WARM 不得在容器里积累 tombstone。
    if (record.queued) {
      record.queued = false;
      this.queue.delete(record);
    }
    if (newLevel === 'none') {
      this.drainQueue();
      return;
    }
    if (newLevel === 'hot') {
      // 当前已经 running 等价于“立即刷新正在发生”；完成后按 HOT 间隔续排即可。
      if (!record.running) this.enqueue(record);
      return;
    }
    // NONE/HOT → WARM 都从切换时刻等待完整 warm interval，避免隐藏面板仍吃旧 3s timer。
    this.schedule(record, record.definition.warmIntervalMs);
  }

  private schedule(record: TaskRecord, delayMs: number): void {
    if (!this.isCurrent(record) || record.effectiveLevel === 'none' || record.running) return;
    this.clearTimer(record);
    record.timer = setTimeout(() => {
      record.timer = null;
      this.enqueue(record);
    }, delayMs);
    record.timer.unref?.();
  }

  private enqueue(record: TaskRecord): void {
    if (!this.isCurrent(record) || record.effectiveLevel === 'none') return;
    if (record.queued || record.running) {
      this.metrics.increment('background.queueDeduplicated');
      return;
    }
    record.queued = true;
    this.queue.add(record);
    this.updateGauges();
    this.drainQueue();
  }

  private drainQueue(): void {
    while (!this.shuttingDown && this.activeRuns < this.maxConcurrent && this.queue.size > 0) {
      const record = this.queue.values().next().value as TaskRecord;
      this.queue.delete(record);
      // identity 防同 key unregister→register 的 ABA；Set 中不保留降级 tombstone。
      if (!record.queued || !this.isCurrent(record) || record.effectiveLevel === 'none') continue;
      record.queued = false;
      this.startRun(record);
    }
    this.updateGauges();
  }

  private startRun(record: TaskRecord): void {
    if (!this.isCurrent(record) || record.running || record.effectiveLevel === 'none') return;
    record.running = true;
    this.activeRuns += 1;
    this.metrics.increment('background.runs');
    const finishMetric = this.metrics.begin('background.taskRun');
    this.updateGauges();

    void Promise.resolve()
      .then(() => record.definition.run())
      .then(
        () => finishMetric(),
        (error) => {
          this.metrics.increment('background.runErrors');
          finishMetric(error);
          try {
            record.definition.onError?.(error);
          } catch {
            // 错误观察者不能破坏 scheduler 队列。
          }
        },
      )
      .finally(() => {
        record.running = false;
        this.activeRuns = Math.max(0, this.activeRuns - 1);
        // record 仍是同 key 当前 generation 才可续排；旧 completion 到这里即终止。
        if (this.isCurrent(record) && record.effectiveLevel !== 'none') {
          const interval =
            record.effectiveLevel === 'hot'
              ? record.definition.hotIntervalMs
              : record.definition.warmIntervalMs;
          this.schedule(record, interval);
        }
        this.updateGauges();
        this.drainQueue();
      });
  }

  private disposeRecord(record: TaskRecord, removeFromMap: boolean): void {
    record.disposed = true;
    this.clearTimer(record);
    record.queued = false;
    this.queue.delete(record);
    record.demands.clear();
    record.effectiveLevel = 'none';
    if (removeFromMap && this.tasks.get(record.key) === record) this.tasks.delete(record.key);
  }

  private clearTimer(record: TaskRecord): void {
    if (!record.timer) return;
    clearTimeout(record.timer);
    record.timer = null;
  }

  private isCurrent(record: TaskRecord): boolean {
    return !record.disposed && this.tasks.get(record.key) === record;
  }

  private validateTaskInput(key: string, definition: BackgroundTaskDefinition): void {
    validateIdentifier('task key', key, MAX_KEY_LENGTH);
    for (const [name, value] of [
      ['hotIntervalMs', definition.hotIntervalMs],
      ['warmIntervalMs', definition.warmIntervalMs],
    ] as const) {
      if (!Number.isFinite(value) || value < MIN_INTERVAL_MS) {
        throw new Error(
          `[BackgroundWorkScheduler] Invalid ${name}=${value}. ` +
            `Use a finite interval >= ${MIN_INTERVAL_MS}ms; zero/tight loops are forbidden.`,
        );
      }
    }
    if (definition.warmIntervalMs < definition.hotIntervalMs) {
      throw new Error(
        `[BackgroundWorkScheduler] warmIntervalMs=${definition.warmIntervalMs} must be >= ` +
          `hotIntervalMs=${definition.hotIntervalMs}; WARM work cannot be more aggressive than HOT.`,
      );
    }
  }

  private updateGauges(): void {
    const snapshot = this.getSnapshot();
    this.metrics.setGauge('background.tasks', snapshot.tasks);
    this.metrics.setGauge('background.pendingDemandTasks', snapshot.pendingDemandTasks);
    this.metrics.setGauge('background.hotTasks', snapshot.hotTasks);
    this.metrics.setGauge('background.warmTasks', snapshot.warmTasks);
    this.metrics.setGauge('background.running', this.activeRuns);
    this.metrics.setGauge('background.queued', snapshot.queued);
  }
}

function updateDemandMap(
  demands: Map<string, Exclude<BackgroundDemandLevel, 'none'>>,
  consumerId: string,
  level: BackgroundDemandLevel,
): void {
  if (level === 'none') {
    demands.delete(consumerId);
    return;
  }
  if (!demands.has(consumerId) && demands.size >= MAX_CONSUMERS_PER_TASK) {
    throw new Error(
      `[BackgroundWorkScheduler] Consumer limit ${MAX_CONSUMERS_PER_TASK} reached for one task. ` +
        'Possible causes: closed clients were not removed or a renderer is generating dynamic IDs.',
    );
  }
  demands.set(consumerId, level);
}

function effectiveDemand(
  demands: Map<string, Exclude<BackgroundDemandLevel, 'none'>>,
): BackgroundDemandLevel {
  let warm = false;
  for (const level of demands.values()) {
    if (level === 'hot') return 'hot';
    warm = true;
  }
  return warm ? 'warm' : 'none';
}

function validateIdentifier(label: string, value: string, maxLength: number): void {
  if (!value || value.length > maxLength || /[\r\n\0]/.test(value)) {
    throw new Error(
      `[BackgroundWorkScheduler] Invalid ${label}. ` +
        `Expected a non-empty value <= ${maxLength} characters without control separators.`,
    );
  }
}
