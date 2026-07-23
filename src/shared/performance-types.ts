/**
 * @file src/shared/performance-types.ts
 * @purpose 定义 0.3.2 性能飞行记录器的隐私安全报告与 IPC 类型。
 *
 * @关键设计:
 * - 自动报告只存固定操作名、进程类型和数值指标,不存路径/命令/终端内容/IPC payload
 * - main event-loop stall 与 renderer frame jank / Windows DPC 明确区分
 * - 所有 timeline 都是有界数组,长期运行不会让报告与内存无限增长
 *
 * @对应文档章节: docs/方案-性能诊断-20260722.md
 *
 * @不要在这里做的事:
 * - 不加入 sessionId/windowId/文件路径等用户数据
 * - 不把 .cpuprofile 的敏感源码路径混入自动报告
 */

export type PerformanceDurationBucket =
  | 'lt1'
  | 'lt5'
  | 'lt10'
  | 'lt50'
  | 'lt100'
  | 'lt250'
  | 'lt500'
  | 'lt1000'
  | 'lt5000'
  | 'gte5000';

export interface PerformanceOperationMetric {
  name: string;
  count: number;
  errors: number;
  inFlight: number;
  totalMs: number;
  averageMs: number;
  approximateP95Ms: number;
  maxMs: number;
  buckets: Record<PerformanceDurationBucket, number>;
}

export interface PerformanceElectronProcessMetric {
  type: string;
  processCount: number;
  cpuPercent: number;
  workingSetKb: number;
  peakWorkingSetKb: number;
  privateBytesKb: number;
}

export interface PerformanceSample {
  atMs: number;
  mainCpuPercent: number;
  mainCpuUserMs: number;
  mainCpuSystemMs: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  eventLoopUtilization: number;
  eventLoopDelayMs: {
    mean: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
  };
  resourceCounts: Record<string, number>;
  electronProcesses: PerformanceElectronProcessMetric[];
  gauges: Record<string, number>;
}

export interface PerformanceStallRecord {
  atMs: number;
  driftMs: number;
  mainCpuPercent: number;
  rssBytes: number;
  eventLoopUtilization: number;
  activeOperations: string[];
  gauges: Record<string, number>;
}

export interface PerformanceReport {
  schemaVersion: 1;
  runId: string;
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  osRelease: string;
  startedAt: string;
  generatedAt: string;
  endedAt?: string;
  finalized: boolean;
  durationMs: number;
  limitations: string[];
  summary: {
    sampleCount: number;
    stallCount100Ms: number;
    stallCount250Ms: number;
    stallCount1000Ms: number;
    maxStallMs: number;
    peakMainCpuPercent: number;
    peakRssBytes: number;
    peakElectronWorkingSetKb: number;
  };
  latestSample: PerformanceSample | null;
  firstSample: PerformanceSample | null;
  recentSamples: PerformanceSample[];
  recentStalls: PerformanceStallRecord[];
  operationHeatmap: PerformanceOperationMetric[];
  counters: Record<string, number>;
  gauges: Record<string, number>;
}

export interface PerformanceStatus {
  runId: string;
  startedAt: string;
  enabled: boolean;
  finalized: boolean;
  sampleCount: number;
  stallCount100Ms: number;
  stallCount250Ms: number;
  stallCount1000Ms: number;
  maxStallMs: number;
  latestMainCpuPercent: number;
  latestRssBytes: number;
  reportFileName: string;
  cpuProfileRunning: boolean;
}

export interface CaptureCpuProfilePayload {
  /** 服务端会 clamp 到 5-30 秒；UI 默认 15。 */
  durationSeconds?: number;
}

export interface CaptureCpuProfileResponse {
  path: string;
  durationSeconds: number;
}
