/**
 * @file src/main/performance-diagnostics.ts
 * @purpose 0.3.2 常驻性能飞行记录器：每次运行自动生成 JSON/Markdown，并支持按需 V8 CPU profile。
 *
 * @关键设计:
 * - 10 秒低开销采样 + 250ms main event-loop stall detector，0 窗口托盘态仍工作
 * - 报告每 5 分钟原子刷新；>=1s 严重 stall 至多每 60 秒额外落盘
 * - 所有数组/指标名有硬上限，长期运行不随时间无限增长
 * - 自动报告只含数值与固定标签；Inspector .cpuprofile 仅用户明确确认后生成
 *
 * @对应文档章节: docs/方案-性能诊断-20260722.md
 *
 * @不要在这里做的事:
 * - 不记录路径、sessionId、命令、终端内容、IPC payload 或自动 stack trace
 * - 不把 main event-loop stall 宣称为 renderer frame jank / Windows DPC 延迟
 * - 不自动启动 Inspector/trace profiler
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { release as osRelease } from 'node:os';
import { join } from 'node:path';
import { Session as InspectorSession } from 'node:inspector';
import {
  monitorEventLoopDelay,
  performance,
  type EventLoopUtilization,
  type IntervalHistogram,
} from 'node:perf_hooks';
import type {
  CaptureCpuProfileResponse,
  PerformanceElectronProcessMetric,
  PerformanceReport,
  PerformanceSample,
  PerformanceStallRecord,
  PerformanceStatus,
} from '@shared/performance-types';
import { logger } from './logger';
import { performanceMetrics, type PerformanceMetrics } from './performance-metrics';

const MODULE = 'PerformanceDiagnostics';
const DEFAULT_SAMPLE_INTERVAL_MS = 10_000;
const DEFAULT_STALL_INTERVAL_MS = 250;
const DEFAULT_FLUSH_INTERVAL_MS = 5 * 60_000;
const EVENT_LOOP_RESOLUTION_MS = 100;
const MAX_RECENT_SAMPLES = 180;
const MAX_RECENT_STALLS = 200;
const MAX_REPORT_RUNS = 30;
const MAX_CPU_PROFILES_PER_RUN = 5;
const REPORT_FILE_RE = /^run-(\d{8}T\d{6}Z)-([0-9a-f]{8})\.(json|md)$/;
const CPU_PROFILE_FILE_RE = /^run-(\d{8}T\d{6}Z)-([0-9a-f]{8})-cpu-\d{8}T\d{6}Z\.cpuprofile$/;
const TEMP_REPORT_FILE_RE =
  /^run-\d{8}T\d{6}Z-[0-9a-f]{8}(?:-cpu-\d{8}T\d{6}Z)?\.(json|md|cpuprofile)\.tmp\.\d+\.\d+$/;

export interface PerformanceRuntimeContext {
  windows: number;
  sessionsTotal: number;
  sessionsLive: number;
  sessionsExited: number;
}

interface InspectorSessionLike {
  connect(): void;
  disconnect(): void;
  post(
    method: string,
    paramsOrCallback?: Record<string, unknown> | ((error: Error | null, result?: object) => void),
    callback?: (error: Error | null, result?: object) => void,
  ): void;
}

interface HistogramLike {
  enable(): void;
  disable(): void;
  reset(): void;
  readonly count: number;
  readonly mean: number;
  readonly max: number;
  percentile(percentile: number): number;
}

export interface PerformanceDiagnosticsOptions {
  reportDir: string;
  appVersion: string;
  getAppMetrics: () => Electron.ProcessMetric[];
  getRuntimeContext: () => PerformanceRuntimeContext;
  metrics?: PerformanceMetrics;
  sampleIntervalMs?: number;
  stallIntervalMs?: number;
  flushIntervalMs?: number;
  now?: () => number;
  monotonicNow?: () => number;
  histogram?: HistogramLike;
  createInspectorSession?: () => InspectorSessionLike;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 每次 app run 一个实例。start/stop 幂等；所有 timer unref，不改变应用生命周期。
 */
export class PerformanceDiagnostics {
  private readonly metrics: PerformanceMetrics;
  private readonly sampleIntervalMs: number;
  private readonly stallIntervalMs: number;
  private readonly flushIntervalMs: number;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly histogram: HistogramLike;
  private readonly createInspectorSession: () => InspectorSessionLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly runId = randomUUID();
  private readonly startedWallMs: number;
  private readonly startedMonoMs: number;
  private readonly reportStem: string;
  private readonly jsonPath: string;
  private readonly markdownPath: string;
  private sampleTimer: NodeJS.Timeout | null = null;
  private stallTimer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private nextStallDeadlineMs = 0;
  private previousCpuUsage = process.cpuUsage();
  private previousElu: EventLoopUtilization = performance.eventLoopUtilization();
  private previousSampleMonoMs: number;
  private lastFlushMonoMs: number;
  private latestSample: PerformanceSample | null = null;
  private firstSample: PerformanceSample | null = null;
  private readonly recentSamples: PerformanceSample[] = [];
  private readonly recentStalls: PerformanceStallRecord[] = [];
  private sampleCount = 0;
  private stallCount100Ms = 0;
  private stallCount250Ms = 0;
  private stallCount1000Ms = 0;
  private maxStallMs = 0;
  private peakMainCpuPercent = 0;
  private peakRssBytes = 0;
  private peakElectronWorkingSetKb = 0;
  private started = false;
  private finalized = false;
  private endedWallMs: number | null = null;
  private flushInFlight: Promise<void> | null = null;
  private lastFlushError: unknown = null;
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private cpuProfileRunning = false;

  constructor(private readonly options: PerformanceDiagnosticsOptions) {
    this.metrics = options.metrics ?? performanceMetrics;
    this.sampleIntervalMs = options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
    this.stallIntervalMs = options.stallIntervalMs ?? DEFAULT_STALL_INTERVAL_MS;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? performance.now.bind(performance);
    this.histogram =
      options.histogram ??
      (monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS }) as IntervalHistogram);
    this.createInspectorSession = options.createInspectorSession ?? (() => new InspectorSession());
    this.sleep = options.sleep ?? delay;
    this.startedWallMs = this.now();
    this.startedMonoMs = this.monotonicNow();
    this.previousSampleMonoMs = this.startedMonoMs;
    this.lastFlushMonoMs = this.startedMonoMs;
    const stamp = compactTimestamp(new Date(this.startedWallMs));
    const shortId = this.runId.replaceAll('-', '').slice(0, 8);
    this.reportStem = `run-${stamp}-${shortId}`;
    this.jsonPath = join(options.reportDir, `${this.reportStem}.json`);
    this.markdownPath = join(options.reportDir, `${this.reportStem}.md`);
  }

  /** 启动采样并立即写 skeleton；重复/并发调用无副作用。 */
  start(): Promise<void> {
    return this.enqueueLifecycle(() => this.startInternal());
  }

  /**
   * 停止采样并写 finalized=true。调用方应把返回 Promise 纳入退出 flush budget。
   * 与 start 共用串行队列，stop 若撞上尚未完成的 start，不会漏清 timer。
   */
  stop(): Promise<void> {
    return this.enqueueLifecycle(() => this.stopInternal());
  }

  private async startInternal(): Promise<void> {
    if (this.started || this.finalized) return;
    // 目录创建失败时保持 started=false，设置页手动刷新仍可重试；诊断工具失败不能
    // 留下“enabled=true 但实际上没有报告”的假状态。
    await fs.mkdir(this.options.reportDir, { recursive: true });
    await this.cleanupOldReports();
    this.histogram.enable();
    this.started = true;
    try {
      await this.sample();
      await this.flushNow(true);
      // skeleton 写盘属于诊断器启动成本,不应被第一轮 timer 误报为应用 stall。
      this.nextStallDeadlineMs = this.monotonicNow() + this.stallIntervalMs;

      this.sampleTimer = setInterval(() => void this.sample(), this.sampleIntervalMs);
      this.sampleTimer.unref?.();
      this.stallTimer = setInterval(() => this.detectStall(), this.stallIntervalMs);
      this.stallTimer.unref?.();
      this.flushTimer = setInterval(() => void this.flush(), this.flushIntervalMs);
      this.flushTimer.unref?.();
      logger.info(MODULE, `started runId=${this.runId} report=${this.reportStem}.json`);
    } catch (error) {
      this.clearTimers();
      this.histogram.disable();
      this.started = false;
      throw error;
    }
  }

  private async stopInternal(): Promise<void> {
    if (!this.started || this.finalized) return;
    this.clearTimers();
    this.histogram.disable();
    await this.sample();
    this.finalized = true;
    this.endedWallMs = this.now();
    await this.flushNow();
    logger.info(MODULE, `finalized runId=${this.runId}`);
  }

  private enqueueLifecycle(operation: () => Promise<void>): Promise<void> {
    const queued = this.lifecycleQueue.then(operation, operation);
    // 队列本身吞掉 rejection 以允许显式重试；当前调用者仍收到 queued 的原错误。
    this.lifecycleQueue = queued.catch(() => {});
    return queued;
  }

  /** 立即采样并刷新当前 run 报告，供设置页手动操作/测试。 */
  async writeReportNow(): Promise<PerformanceStatus> {
    if (!this.started) await this.start();
    await this.sample();
    await this.flushNow(true);
    return this.getStatus();
  }

  getStatus(): PerformanceStatus {
    return {
      runId: this.runId,
      startedAt: new Date(this.startedWallMs).toISOString(),
      enabled: this.started,
      finalized: this.finalized,
      sampleCount: this.sampleCount,
      stallCount100Ms: this.stallCount100Ms,
      stallCount250Ms: this.stallCount250Ms,
      stallCount1000Ms: this.stallCount1000Ms,
      maxStallMs: round(this.maxStallMs),
      latestMainCpuPercent: this.latestSample?.mainCpuPercent ?? 0,
      latestRssBytes: this.latestSample?.rssBytes ?? 0,
      reportFileName: `${this.reportStem}.md`,
      cpuProfileRunning: this.cpuProfileRunning,
    };
  }

  getReportDir(): string {
    return this.options.reportDir;
  }

  /**
   * 用户显式触发一个 5-30 秒 main V8 CPU profile。
   *
   * @throws 已有 capture 在跑、Inspector 不可用或写盘失败时抛详细错误。
   */
  async captureCpuProfile(durationSeconds = 15): Promise<CaptureCpuProfileResponse> {
    if (this.cpuProfileRunning) {
      throw new Error(
        '[PerformanceDiagnostics] CPU profile already running. Wait for the current 5-30 second capture to finish before starting another.',
      );
    }
    const requestedDuration = Number.isFinite(durationSeconds) ? durationSeconds : 15;
    const duration = Math.max(5, Math.min(30, Math.round(requestedDuration)));
    this.cpuProfileRunning = true;
    const finishMetric = this.metrics.begin('performance.cpuProfile');
    let session: InspectorSessionLike | null = null;
    const profilePath = join(
      this.options.reportDir,
      `${this.reportStem}-cpu-${compactTimestamp(new Date(this.now()))}.cpuprofile`,
    );
    try {
      await fs.mkdir(this.options.reportDir, { recursive: true });
      session = this.createInspectorSession();
      session.connect();
      await inspectorPost(session, 'Profiler.enable');
      await inspectorPost(session, 'Profiler.setSamplingInterval', { interval: 1000 });
      await inspectorPost(session, 'Profiler.start');
      await this.sleep(duration * 1000);
      const result = await inspectorPost<{ profile: unknown }>(session, 'Profiler.stop');
      await atomicWrite(profilePath, JSON.stringify(result.profile));
      await this.cleanupCpuProfiles();
      finishMetric();
      return { path: profilePath, durationSeconds: duration };
    } catch (error) {
      finishMetric(error);
      throw new Error(
        `[PerformanceDiagnostics] Failed to capture ${duration}s CPU profile at "${profilePath}". ` +
          `Possible causes: DevTools profiler already active, Inspector unavailable in this build, ` +
          `or report directory not writable. ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (session) {
        try {
          await inspectorPost(session, 'Profiler.disable');
        } catch {
          /* Inspector may not have connected/enabled; disconnect still releases resources. */
        }
        try {
          session.disconnect();
        } catch {
          /* disconnect is best effort */
        }
      }
      this.cpuProfileRunning = false;
    }
  }

  /** 测试/状态页用：返回脱敏后的当前报告对象。 */
  snapshot(): PerformanceReport {
    const metricSnapshot = this.metrics.snapshot();
    const generatedWallMs = this.now();
    return {
      schemaVersion: 1,
      runId: this.runId,
      appVersion: this.options.appVersion,
      electronVersion: process.versions.electron ?? 'unknown',
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      osRelease: osRelease(),
      startedAt: new Date(this.startedWallMs).toISOString(),
      generatedAt: new Date(generatedWallMs).toISOString(),
      ...(this.endedWallMs !== null ? { endedAt: new Date(this.endedWallMs).toISOString() } : {}),
      finalized: this.finalized,
      durationMs: Math.max(0, generatedWallMs - this.startedWallMs),
      limitations: [
        'Stall counts describe the Electron main event loop, not renderer frame jank or Windows DPC/ISR latency.',
        'Electron GPU process metrics include CPU and memory, not GPU engine utilization.',
        'Automatic reports contain numeric aggregates only; deep .cpuprofile files are separate and may contain local source paths.',
      ],
      summary: {
        sampleCount: this.sampleCount,
        stallCount100Ms: this.stallCount100Ms,
        stallCount250Ms: this.stallCount250Ms,
        stallCount1000Ms: this.stallCount1000Ms,
        maxStallMs: round(this.maxStallMs),
        peakMainCpuPercent: round(this.peakMainCpuPercent),
        peakRssBytes: this.peakRssBytes,
        peakElectronWorkingSetKb: this.peakElectronWorkingSetKb,
      },
      latestSample: this.latestSample ? clone(this.latestSample) : null,
      firstSample: this.firstSample ? clone(this.firstSample) : null,
      recentSamples: this.recentSamples.map(clone),
      recentStalls: this.recentStalls.map(clone),
      operationHeatmap: metricSnapshot.operations,
      counters: metricSnapshot.counters,
      gauges: { ...metricSnapshot.gauges, ...this.safeRuntimeGauges() },
    };
  }

  private async sample(): Promise<void> {
    if (!this.started) return;
    const monoNow = this.monotonicNow();
    const elapsedMs = Math.max(1, monoNow - this.previousSampleMonoMs);
    this.previousSampleMonoMs = monoNow;
    const currentCpuUsage = process.cpuUsage();
    const cpuDelta = {
      user: Math.max(0, currentCpuUsage.user - this.previousCpuUsage.user),
      system: Math.max(0, currentCpuUsage.system - this.previousCpuUsage.system),
    };
    this.previousCpuUsage = currentCpuUsage;
    const cpuTotalMs = (cpuDelta.user + cpuDelta.system) / 1000;
    const mainCpuPercent = (cpuTotalMs / elapsedMs) * 100;
    const memory = process.memoryUsage();
    const currentElu = performance.eventLoopUtilization();
    const elu = performance.eventLoopUtilization(currentElu, this.previousElu);
    this.previousElu = currentElu;
    const metricSnapshot = this.metrics.snapshot();
    const eventLoopDelayMs = histogramSnapshot(this.histogram);
    this.histogram.reset();
    const electronProcesses = aggregateElectronMetrics(this.safeGetAppMetrics());
    const gauges = { ...metricSnapshot.gauges, ...this.safeRuntimeGauges() };
    const sample: PerformanceSample = {
      atMs: round(monoNow - this.startedMonoMs),
      mainCpuPercent: round(mainCpuPercent),
      mainCpuUserMs: round(cpuDelta.user / 1000),
      mainCpuSystemMs: round(cpuDelta.system / 1000),
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
      eventLoopUtilization: round(elu.utilization),
      eventLoopDelayMs,
      resourceCounts: activeResourceCounts(),
      electronProcesses,
      gauges,
    };
    this.sampleCount += 1;
    this.latestSample = sample;
    if (!this.firstSample) this.firstSample = sample;
    pushBounded(this.recentSamples, sample, MAX_RECENT_SAMPLES);
    this.peakMainCpuPercent = Math.max(this.peakMainCpuPercent, mainCpuPercent);
    this.peakRssBytes = Math.max(this.peakRssBytes, memory.rss);
    this.peakElectronWorkingSetKb = Math.max(
      this.peakElectronWorkingSetKb,
      electronProcesses.reduce((sum, item) => sum + item.workingSetKb, 0),
    );
  }

  private detectStall(): void {
    if (!this.started || this.finalized) return;
    const monoNow = this.monotonicNow();
    const driftMs = monoNow - this.nextStallDeadlineMs;
    this.nextStallDeadlineMs = monoNow + this.stallIntervalMs;
    if (driftMs < 100) return;
    this.stallCount100Ms += 1;
    if (driftMs >= 250) this.stallCount250Ms += 1;
    if (driftMs >= 1000) this.stallCount1000Ms += 1;
    this.maxStallMs = Math.max(this.maxStallMs, driftMs);
    const metricSnapshot = this.metrics.snapshot();
    const latest = this.latestSample;
    pushBounded(
      this.recentStalls,
      {
        atMs: round(monoNow - this.startedMonoMs),
        driftMs: round(driftMs),
        mainCpuPercent: latest?.mainCpuPercent ?? 0,
        rssBytes: latest?.rssBytes ?? process.memoryUsage.rss(),
        eventLoopUtilization: latest?.eventLoopUtilization ?? 0,
        activeOperations: metricSnapshot.activeOperations.slice(0, 20),
        gauges: { ...metricSnapshot.gauges, ...this.safeRuntimeGauges() },
      },
      MAX_RECENT_STALLS,
    );
    this.metrics.increment('performance.mainEventLoopStalls');
    // 平时 5 分钟写一次以控制长期 SSD 写放大；>=1s 严重 stall 至多每 60 秒
    // 额外落一份现场，让异常退出前仍有近实时证据。
    if (driftMs >= 1000 && monoNow - this.lastFlushMonoMs >= 60_000) {
      void this.flush();
    }
  }

  private async flush(throwOnError = false): Promise<void> {
    if (!this.flushInFlight) {
      const finishMetric = this.metrics.begin('performance.reportFlush');
      const report = this.snapshot();
      this.lastFlushError = null;
      this.flushInFlight = Promise.all([
        atomicWrite(this.jsonPath, JSON.stringify(report, null, 2) + '\n'),
        atomicWrite(this.markdownPath, renderPerformanceMarkdown(report)),
      ])
        .then(() => {
          this.lastFlushMonoMs = this.monotonicNow();
          finishMetric();
        })
        .catch((error) => {
          this.lastFlushError = error;
          finishMetric(error);
          logger.warn(MODULE, `report flush failed runId=${this.runId}`, error);
        })
        .finally(() => {
          this.flushInFlight = null;
        });
    }
    await this.flushInFlight;
    if (throwOnError && this.lastFlushError) {
      const error = this.lastFlushError;
      throw new Error(
        `[PerformanceDiagnostics] Failed to write report runId=${this.runId}. ` +
          `Possible causes: report directory is read-only, disk is full, or antivirus blocked atomic rename. ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async flushNow(throwOnError = false): Promise<void> {
    if (this.flushInFlight) await this.flush(throwOnError);
    await this.flush(throwOnError);
  }

  private clearTimers(): void {
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    if (this.stallTimer) clearInterval(this.stallTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.sampleTimer = null;
    this.stallTimer = null;
    this.flushTimer = null;
  }

  private safeGetAppMetrics(): Electron.ProcessMetric[] {
    try {
      return this.options.getAppMetrics();
    } catch (error) {
      this.metrics.increment('performance.appMetricsErrors');
      logger.debug(MODULE, `app.getAppMetrics failed: ${String(error)}`);
      return [];
    }
  }

  private safeRuntimeGauges(): Record<string, number> {
    try {
      const context = this.options.getRuntimeContext();
      return {
        'runtime.windows': context.windows,
        'runtime.sessionsTotal': context.sessionsTotal,
        'runtime.sessionsLive': context.sessionsLive,
        'runtime.sessionsExited': context.sessionsExited,
      };
    } catch {
      this.metrics.increment('performance.runtimeContextErrors');
      return {};
    }
  }

  private async cleanupOldReports(): Promise<void> {
    let names: string[];
    try {
      names = await fs.readdir(this.options.reportDir);
    } catch {
      return;
    }
    const runStems = new Set<string>();
    for (const name of names) {
      const match = REPORT_FILE_RE.exec(name);
      if (match) runStems.add(`run-${match[1]}-${match[2]}`);
    }
    // start() 在当前 run skeleton 落盘前清理；只保留 29 个历史 run，当前写入后总数=30。
    const sortedStems = [...runStems].sort().reverse();
    const retainedStems = new Set(sortedStems.slice(0, Math.max(0, MAX_REPORT_RUNS - 1)));
    const staleSet = new Set(sortedStems.filter((stem) => !retainedStems.has(stem)));
    await Promise.all(
      names.map(async (name) => {
        const reportMatch = REPORT_FILE_RE.exec(name);
        const stem = reportMatch ? `run-${reportMatch[1]}-${reportMatch[2]}` : null;
        const staleReport = stem && staleSet.has(stem) && stem !== this.reportStem;
        const staleTemp = TEMP_REPORT_FILE_RE.test(name);
        if (!staleReport && !staleTemp) return;
        try {
          await fs.rm(join(this.options.reportDir, name), { force: true });
        } catch (error) {
          logger.debug(MODULE, `retention remove failed file=${name}: ${String(error)}`);
        }
      }),
    );
    retainedStems.add(this.reportStem);
    await this.cleanupCpuProfiles(retainedStems);
  }

  /**
   * CPU profile 是显式用户产物但仍属于诊断目录：每 run 最多保留 5 份；启动时
   * 同时删除已无保留 report 的 orphan profile，避免长期运行/手删报告后无界增长。
   */
  private async cleanupCpuProfiles(validRunStems?: Set<string>): Promise<void> {
    let names: string[];
    try {
      names = await fs.readdir(this.options.reportDir);
    } catch {
      return;
    }
    const byRun = new Map<string, string[]>();
    for (const name of names) {
      const match = CPU_PROFILE_FILE_RE.exec(name);
      if (!match) continue;
      const stem = `run-${match[1]}-${match[2]}`;
      const list = byRun.get(stem) ?? [];
      list.push(name);
      byRun.set(stem, list);
    }
    const toRemove: string[] = [];
    for (const [stem, profiles] of byRun) {
      const sorted = profiles.sort().reverse();
      if (validRunStems && !validRunStems.has(stem)) toRemove.push(...sorted);
      else toRemove.push(...sorted.slice(MAX_CPU_PROFILES_PER_RUN));
    }
    await Promise.all(
      toRemove.map(async (name) => {
        try {
          await fs.rm(join(this.options.reportDir, name), { force: true });
        } catch (error) {
          logger.debug(MODULE, `profile retention remove failed file=${name}: ${String(error)}`);
        }
      }),
    );
  }
}

export function aggregateElectronMetrics(
  metrics: Electron.ProcessMetric[],
): PerformanceElectronProcessMetric[] {
  const byType = new Map<string, PerformanceElectronProcessMetric>();
  for (const metric of metrics) {
    const type = String(metric.type || 'Unknown');
    const current = byType.get(type) ?? {
      type,
      processCount: 0,
      cpuPercent: 0,
      workingSetKb: 0,
      peakWorkingSetKb: 0,
      privateBytesKb: 0,
    };
    current.processCount += 1;
    current.cpuPercent += finite(metric.cpu?.percentCPUUsage);
    current.workingSetKb += finite(metric.memory?.workingSetSize);
    current.peakWorkingSetKb += finite(metric.memory?.peakWorkingSetSize);
    current.privateBytesKb += finite(metric.memory?.privateBytes);
    byType.set(type, current);
  }
  return [...byType.values()]
    .map((item) => ({
      ...item,
      cpuPercent: round(item.cpuPercent),
      workingSetKb: round(item.workingSetKb),
      peakWorkingSetKb: round(item.peakWorkingSetKb),
      privateBytesKb: round(item.privateBytesKb),
    }))
    .sort((a, b) => a.type.localeCompare(b.type));
}

export function renderPerformanceMarkdown(report: PerformanceReport): string {
  const lines: string[] = [
    `# Marina 性能报告 ${report.runId.slice(0, 8)}`,
    '',
    `- 版本：${report.appVersion}`,
    `- 开始：${report.startedAt}`,
    `- 生成：${report.generatedAt}`,
    `- 状态：${report.finalized ? '正常结束' : '运行中 / 可能异常退出'}`,
    `- 持续：${formatDuration(report.durationMs)}`,
    `- 平台：${report.platform} ${report.arch} / Node ${report.nodeVersion} / Electron ${report.electronVersion}`,
    '',
    '## 健康摘要',
    '',
    `- main event-loop stall：>=100ms ${report.summary.stallCount100Ms} 次；>=250ms ${report.summary.stallCount250Ms} 次；>=1000ms ${report.summary.stallCount1000Ms} 次`,
    `- 最大 stall：${report.summary.maxStallMs.toFixed(2)} ms`,
    `- main CPU 峰值：${report.summary.peakMainCpuPercent.toFixed(2)}%`,
    `- main RSS 峰值：${formatBytes(report.summary.peakRssBytes)}`,
    `- Electron 进程 working set 峰值：${formatBytes(report.summary.peakElectronWorkingSetKb * 1024)}`,
    `- 采样数：${report.summary.sampleCount}`,
    '',
  ];
  if (report.latestSample) {
    const delay = report.latestSample.eventLoopDelayMs;
    lines.push(
      '## 最近一次采样',
      '',
      `- main CPU：${report.latestSample.mainCpuPercent.toFixed(2)}%`,
      `- RSS / heap：${formatBytes(report.latestSample.rssBytes)} / ${formatBytes(report.latestSample.heapUsedBytes)}`,
      `- event-loop utilization：${(report.latestSample.eventLoopUtilization * 100).toFixed(2)}%`,
      `- event-loop delay p50/p95/p99/max：${delay.p50}/${delay.p95}/${delay.p99}/${delay.max} ms`,
      '',
    );
  }
  if (report.latestSample) {
    lines.push(
      '## Electron 子进程（最近采样）',
      '',
      '| 类型 | 进程数 | CPU % | Working set | Private bytes |',
      '|---|---:|---:|---:|---:|',
    );
    for (const item of report.latestSample.electronProcesses) {
      lines.push(
        `| ${item.type} | ${item.processCount} | ${item.cpuPercent} | ${formatBytes(item.workingSetKb * 1024)} | ${formatBytes(item.privateBytesKb * 1024)} |`,
      );
    }
    if (report.latestSample.electronProcesses.length === 0) {
      lines.push('| （暂无） | 0 | 0 | 0 B | 0 B |');
    }
    lines.push('', '## Active resources（最近采样）', '');
    const resources = Object.entries(report.latestSample.resourceCounts);
    if (resources.length === 0) lines.push('- 暂无。');
    else for (const [name, value] of resources) lines.push(`- ${name}：${value}`);
  }
  lines.push('', '## 业务计数与当前值', '');
  const counters = Object.entries(report.counters);
  const gauges = Object.entries(report.gauges);
  if (counters.length === 0 && gauges.length === 0) {
    lines.push('- 暂无。');
  } else {
    lines.push('| 类型 | 名称 | 值 |', '|---|---|---:|');
    for (const [name, value] of counters) lines.push(`| counter | ${name} | ${value} |`);
    for (const [name, value] of gauges) lines.push(`| gauge | ${name} | ${value} |`);
  }
  lines.push(
    '',
    '## 操作热力图（固定业务函数/操作）',
    '',
    '| 操作 | 次数 | 错误 | 总耗时 ms | 平均 ms | 近似 p95 ms | 最大 ms | in-flight |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
  );
  for (const item of report.operationHeatmap.slice(0, 40)) {
    lines.push(
      `| ${item.name} | ${item.count} | ${item.errors} | ${item.totalMs} | ${item.averageMs} | ${item.approximateP95Ms} | ${item.maxMs} | ${item.inFlight} |`,
    );
  }
  if (report.operationHeatmap.length === 0) lines.push('| （暂无） | 0 | 0 | 0 | 0 | 0 | 0 | 0 |');
  lines.push('', '## 最近 main event-loop stall', '');
  if (report.recentStalls.length === 0) {
    lines.push('- 无 >=100ms stall。');
  } else {
    lines.push(
      '| 启动后 ms | drift ms | main CPU % | RSS | 活跃操作 |',
      '|---:|---:|---:|---:|---|',
    );
    for (const stall of report.recentStalls.slice(-50)) {
      lines.push(
        `| ${stall.atMs} | ${stall.driftMs} | ${stall.mainCpuPercent} | ${formatBytes(stall.rssBytes)} | ${stall.activeOperations.join(', ') || '无'} |`,
      );
    }
  }
  lines.push('', '## 指标限制', '');
  for (const limitation of report.limitations) lines.push(`- ${limitation}`);
  lines.push('', '> 自动报告不记录路径、命令、终端内容或 IPC payload。', '');
  return lines.join('\n');
}

function histogramSnapshot(histogram: HistogramLike): PerformanceSample['eventLoopDelayMs'] {
  if (histogram.count <= 0) return { mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  return {
    mean: nsToMs(histogram.mean),
    p50: nsToMs(histogram.percentile(50)),
    p95: nsToMs(histogram.percentile(95)),
    p99: nsToMs(histogram.percentile(99)),
    max: nsToMs(histogram.max),
  };
}

function activeResourceCounts(): Record<string, number> {
  const getter = (process as typeof process & { getActiveResourcesInfo?: () => string[] })
    .getActiveResourcesInfo;
  if (!getter) return {};
  try {
    const counts: Record<string, number> = {};
    for (const name of getter.call(process)) counts[name] = (counts[name] ?? 0) + 1;
    return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  } catch {
    return {};
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temp = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    const handle = await fs.open(temp, 'w');
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    // 与 JsonStore 同一契约：Node 18+ Windows rename 可覆盖目标；失败时旧报告
    // 保持不动，只清临时文件，绝不先删现场再冒险写新文件。
    await fs.rename(temp, path);
  } catch (error) {
    // write/fsync/rename 任一失败都清本次唯一 temp，单个长 run 也不会累积残片。
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

function inspectorPost<T = Record<string, never>>(
  session: InspectorSessionLike,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const callback = (error: Error | null, result?: object): void => {
      if (error) reject(error);
      else resolve((result ?? {}) as T);
    };
    if (params) session.post(method, params, callback);
    else session.post(method, callback);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pushBounded<T>(array: T[], item: T, max: number): void {
  array.push(item);
  if (array.length > max) array.splice(0, array.length - max);
}

function compactTimestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

function nsToMs(ns: number): number {
  return Number.isFinite(ns) ? round(ns / 1_000_000) : 0;
}

function finite(value: number | undefined): number {
  return Number.isFinite(value) ? (value ?? 0) : 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}
