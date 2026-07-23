/**
 * @file src/main/performance-metrics.ts
 * @purpose 提供低开销、有界、隐私安全的业务操作热力图与 counter/gauge registry。
 *
 * @关键设计:
 * - operation name 必须是固定短标签,拒绝路径/sessionId 等动态高基数字符串
 * - duration 只进固定桶,不保留每次调用的 raw timeline
 * - begin/finish 支持同步/异步操作,并维护 inFlight 供 stall 现场关联
 * - registry 不依赖 Electron,可在单元测试和 main 各模块复用
 *
 * @对应文档章节: docs/方案-性能诊断-20260722.md §6
 *
 * @不要在这里做的事:
 * - 不记录参数、返回值、stack trace 或文件路径
 * - 不对极热的逐字节函数做 timerify
 */
import { performance } from 'node:perf_hooks';
import type {
  PerformanceDurationBucket,
  PerformanceOperationMetric,
} from '@shared/performance-types';

const MAX_OPERATION_NAMES = 200;
const MAX_COUNTER_NAMES = 200;
const MAX_GAUGE_NAMES = 200;
const COUNTER_OVERFLOW_NAME = 'performance.counterOverflow';
const GAUGE_OVERFLOW_NAME = 'performance.gaugeOverflow';
const DROPPED_NAMES_COUNTER = 'performance.metricNamesDropped';
const MAX_METRIC_NAME_LENGTH = 96;
const SAFE_METRIC_NAME = /^[a-zA-Z0-9_.:-]+$/;

const BUCKETS: Array<{ label: PerformanceDurationBucket; upperExclusive: number }> = [
  { label: 'lt1', upperExclusive: 1 },
  { label: 'lt5', upperExclusive: 5 },
  { label: 'lt10', upperExclusive: 10 },
  { label: 'lt50', upperExclusive: 50 },
  { label: 'lt100', upperExclusive: 100 },
  { label: 'lt250', upperExclusive: 250 },
  { label: 'lt500', upperExclusive: 500 },
  { label: 'lt1000', upperExclusive: 1000 },
  { label: 'lt5000', upperExclusive: 5000 },
  { label: 'gte5000', upperExclusive: Number.POSITIVE_INFINITY },
];

interface MutableOperationMetric {
  count: number;
  errors: number;
  inFlight: number;
  totalMs: number;
  maxMs: number;
  buckets: Record<PerformanceDurationBucket, number>;
}

function emptyBuckets(): Record<PerformanceDurationBucket, number> {
  return {
    lt1: 0,
    lt5: 0,
    lt10: 0,
    lt50: 0,
    lt100: 0,
    lt250: 0,
    lt500: 0,
    lt1000: 0,
    lt5000: 0,
    gte5000: 0,
  };
}

function validateName(name: string): void {
  if (
    !name ||
    name.length > MAX_METRIC_NAME_LENGTH ||
    !SAFE_METRIC_NAME.test(name) ||
    name.includes('\\') ||
    name.includes('/')
  ) {
    throw new Error(
      `[PerformanceMetrics] Invalid metric name="${name.slice(0, 120)}". ` +
        `Use a fixed ${MAX_METRIC_NAME_LENGTH}-char max label containing only letters, digits, dot, colon, underscore or dash; never pass paths or IDs.`,
    );
  }
}

/**
 * 有界性能指标 registry。每个实例独立；生产使用模块底部 singleton。
 */
export class PerformanceMetrics {
  private readonly operations = new Map<string, MutableOperationMetric>();
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();

  /**
   * 开始计时一个固定名称操作。
   *
   * @returns 幂等 finish(error?)；重复调用只记第一次。
   */
  begin(name: string): (error?: unknown) => void {
    const metric = this.getOrCreateOperation(name);
    metric.inFlight += 1;
    const startedAt = performance.now();
    let finished = false;
    return (error?: unknown): void => {
      if (finished) return;
      finished = true;
      metric.inFlight = Math.max(0, metric.inFlight - 1);
      this.recordInto(metric, performance.now() - startedAt, error !== undefined && error !== null);
    };
  }

  /** 包装 Promise 操作,保留原返回值/错误。 */
  async measure<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const finish = this.begin(name);
    try {
      const result = await operation();
      finish();
      return result;
    } catch (error) {
      finish(error);
      throw error;
    }
  }

  /** 直接记录外部已测得的 duration。 */
  recordDuration(name: string, durationMs: number, error = false): void {
    const metric = this.getOrCreateOperation(name);
    this.recordInto(metric, durationMs, error);
  }

  increment(name: string, delta = 1): void {
    // 热路径(PTY chunk)只在首次注册固定名称时做 regex 校验，后续是单次 Map get/set。
    if (this.counters.has(name)) {
      this.counters.set(name, this.counters.get(name)! + delta);
      return;
    }
    validateName(name);
    // 预留 dropped + overflow 两个 slot；误传动态高基数名称时仍保持硬上限。
    if (this.counters.size >= MAX_COUNTER_NAMES - 2) {
      this.counters.set(DROPPED_NAMES_COUNTER, (this.counters.get(DROPPED_NAMES_COUNTER) ?? 0) + 1);
      this.counters.set(
        COUNTER_OVERFLOW_NAME,
        (this.counters.get(COUNTER_OVERFLOW_NAME) ?? 0) + delta,
      );
      return;
    }
    this.counters.set(name, delta);
  }

  setGauge(name: string, value: number): void {
    const safeValue = Number.isFinite(value) ? value : 0;
    if (this.gauges.has(name)) {
      this.gauges.set(name, safeValue);
      return;
    }
    validateName(name);
    // gauge 只需一个 overflow slot；dropped 计数走上面同样有界的 counter registry。
    if (this.gauges.size >= MAX_GAUGE_NAMES - 1) {
      this.increment(DROPPED_NAMES_COUNTER);
      this.gauges.set(GAUGE_OVERFLOW_NAME, safeValue);
      return;
    }
    this.gauges.set(name, safeValue);
  }

  snapshot(): {
    operations: PerformanceOperationMetric[];
    counters: Record<string, number>;
    gauges: Record<string, number>;
    activeOperations: string[];
  } {
    const operations = [...this.operations.entries()]
      .map(
        ([name, metric]): PerformanceOperationMetric => ({
          name,
          count: metric.count,
          errors: metric.errors,
          inFlight: metric.inFlight,
          totalMs: round(metric.totalMs),
          averageMs: round(metric.count > 0 ? metric.totalMs / metric.count : 0),
          approximateP95Ms: approximatePercentile(metric, 0.95),
          maxMs: round(metric.maxMs),
          buckets: { ...metric.buckets },
        }),
      )
      .sort((a, b) => b.totalMs - a.totalMs || b.maxMs - a.maxMs || a.name.localeCompare(b.name));
    return {
      operations,
      counters: Object.fromEntries(
        [...this.counters.entries()].sort(([a], [b]) => a.localeCompare(b)),
      ),
      gauges: Object.fromEntries([...this.gauges.entries()].sort(([a], [b]) => a.localeCompare(b))),
      activeOperations: operations.filter((item) => item.inFlight > 0).map((item) => item.name),
    };
  }

  /** 测试专用:清空同一实例,不替换 singleton 引用。 */
  reset(): void {
    this.operations.clear();
    this.counters.clear();
    this.gauges.clear();
  }

  private getOrCreateOperation(name: string): MutableOperationMetric {
    const existing = this.operations.get(name);
    if (existing) return existing;
    validateName(name);
    // 预留最后一个 slot 给 overflow，确保即使现有操作都 in-flight 也绝不超过上限。
    if (this.operations.size >= MAX_OPERATION_NAMES - 1) {
      this.increment(DROPPED_NAMES_COUNTER);
      // 高基数来源不能扩 Map；统一并入固定 overflow 标签。
      return this.getOverflowOperation();
    }
    const metric: MutableOperationMetric = {
      count: 0,
      errors: 0,
      inFlight: 0,
      totalMs: 0,
      maxMs: 0,
      buckets: emptyBuckets(),
    };
    this.operations.set(name, metric);
    return metric;
  }

  private getOverflowOperation(): MutableOperationMetric {
    const name = 'performance.operationOverflow';
    const existing = this.operations.get(name);
    if (existing) return existing;
    // 若第 200 个 slot 已被占满,替换排序最后一个从未 in-flight 的条目；正常固定
    // 标签集合远小于上限,这里只有误传动态 name 时才触发。
    for (const [key, value] of [...this.operations.entries()].reverse()) {
      if (value.inFlight === 0) {
        this.operations.delete(key);
        break;
      }
    }
    const metric: MutableOperationMetric = {
      count: 0,
      errors: 0,
      inFlight: 0,
      totalMs: 0,
      maxMs: 0,
      buckets: emptyBuckets(),
    };
    this.operations.set(name, metric);
    return metric;
  }

  private recordInto(metric: MutableOperationMetric, rawDurationMs: number, error: boolean): void {
    const durationMs = Number.isFinite(rawDurationMs) ? Math.max(0, rawDurationMs) : 0;
    metric.count += 1;
    if (error) metric.errors += 1;
    metric.totalMs += durationMs;
    metric.maxMs = Math.max(metric.maxMs, durationMs);
    const bucket = BUCKETS.find((item) => durationMs < item.upperExclusive) ?? BUCKETS.at(-1)!;
    metric.buckets[bucket.label] += 1;
  }
}

function approximatePercentile(metric: MutableOperationMetric, percentile: number): number {
  if (metric.count === 0) return 0;
  const target = Math.max(1, Math.ceil(metric.count * percentile));
  let seen = 0;
  for (const bucket of BUCKETS) {
    seen += metric.buckets[bucket.label];
    if (seen >= target) {
      return Number.isFinite(bucket.upperExclusive)
        ? bucket.upperExclusive
        : Math.max(5000, metric.maxMs);
    }
  }
  return round(metric.maxMs);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 生产 singleton；模块只记录固定聚合值,不会持有业务对象。 */
export const performanceMetrics = new PerformanceMetrics();
