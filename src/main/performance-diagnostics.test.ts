/**
 * @file src/main/performance-diagnostics.test.ts
 * @purpose 验证 0.3.2 每次运行报告、stall 计数、有界 retention、隐私和按需 CPU profile。
 *
 * @关键策略:
 * - 所有文件写临时目录,绝不碰真实 %APPDATA%/Marina
 * - 注入 clock/histogram/Inspector,避免测试真实等待和启动调试器
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PerformanceDiagnostics,
  aggregateElectronMetrics,
  renderPerformanceMarkdown,
} from './performance-diagnostics';
import { PerformanceMetrics } from './performance-metrics';

class FakeHistogram {
  enabled = false;
  count = 1;
  mean = 20_000_000;
  max = 90_000_000;
  enable(): void {
    this.enabled = true;
  }
  disable(): void {
    this.enabled = false;
  }
  reset(): void {
    // 保持固定数据,让后续 sample 仍可断言单位换算。
  }
  percentile(percentile: number): number {
    return percentile * 1_000_000;
  }
}

function fakeAppMetrics(): Electron.ProcessMetric[] {
  return [
    {
      pid: 1,
      type: 'Browser',
      cpu: { percentCPUUsage: 2, cumulativeCPUUsage: 1, idleWakeupsPerSecond: 0 },
      memory: { workingSetSize: 100, peakWorkingSetSize: 120, privateBytes: 80 },
      creationTime: 0,
      sandboxed: false,
      integrityLevel: 'medium',
    },
    {
      pid: 2,
      type: 'GPU',
      cpu: { percentCPUUsage: 3, cumulativeCPUUsage: 1, idleWakeupsPerSecond: 0 },
      memory: { workingSetSize: 200, peakWorkingSetSize: 220, privateBytes: 180 },
      creationTime: 0,
      sandboxed: true,
      integrityLevel: 'medium',
    },
  ] as unknown as Electron.ProcessMetric[];
}

describe('PerformanceDiagnostics', () => {
  let reportDir: string;
  let mono: number;
  let metrics: PerformanceMetrics;
  let histogram: FakeHistogram;

  beforeEach(async () => {
    reportDir = await mkdtemp(join(tmpdir(), 'marina-performance-'));
    mono = 0;
    metrics = new PerformanceMetrics();
    histogram = new FakeHistogram();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(reportDir, { recursive: true, force: true });
  });

  function createDiagnostics(): PerformanceDiagnostics {
    return new PerformanceDiagnostics({
      reportDir,
      appVersion: '0.3.2-test',
      getAppMetrics: fakeAppMetrics,
      getRuntimeContext: () => ({
        windows: 0,
        sessionsTotal: 3,
        sessionsLive: 1,
        sessionsExited: 2,
      }),
      metrics,
      histogram,
      monotonicNow: () => mono,
      sampleIntervalMs: 60_000,
      stallIntervalMs: 250,
      flushIntervalMs: 60_000,
    });
  }

  it('start 立即生成 JSON/Markdown skeleton，stop 标记 finalized', async () => {
    const diagnostics = createDiagnostics();
    await diagnostics.start();
    const status = diagnostics.getStatus();
    const names = await readdir(reportDir);
    expect(names).toContain(status.reportFileName);
    expect(names).toContain(status.reportFileName.replace(/\.md$/, '.json'));

    const before = JSON.parse(
      await readFile(join(reportDir, status.reportFileName.replace(/\.md$/, '.json')), 'utf8'),
    ) as { finalized: boolean; latestSample: { eventLoopDelayMs: { p95: number } } };
    expect(before.finalized).toBe(false);
    expect(before.latestSample.eventLoopDelayMs.p95).toBe(95);

    await diagnostics.stop();
    const after = JSON.parse(
      await readFile(join(reportDir, status.reportFileName.replace(/\.md$/, '.json')), 'utf8'),
    ) as { finalized: boolean; endedAt?: string };
    expect(after.finalized).toBe(true);
    expect(after.endedAt).toBeTruthy();
  });

  it('并发 start/stop 串行化且只启停 histogram 一次', async () => {
    const diagnostics = createDiagnostics();
    const enable = vi.spyOn(histogram, 'enable');
    const disable = vi.spyOn(histogram, 'disable');

    await Promise.all([diagnostics.start(), diagnostics.start()]);
    expect(enable).toHaveBeenCalledOnce();
    expect(diagnostics.getStatus().sampleCount).toBe(1);

    await Promise.all([diagnostics.stop(), diagnostics.stop()]);
    expect(disable).toHaveBeenCalledOnce();
    expect(diagnostics.getStatus().finalized).toBe(true);
  });

  it('按 100/250/1000ms 阈值统计 main event-loop stall', async () => {
    const diagnostics = createDiagnostics();
    await diagnostics.start();
    const detect = (diagnostics as unknown as { detectStall: () => void }).detectStall.bind(
      diagnostics,
    );

    mono = 400; // deadline 250 → drift 150
    detect();
    mono = 1000; // deadline 650 → drift 350
    detect();
    mono = 2300; // deadline 1250 → drift 1050
    detect();

    const report = diagnostics.snapshot();
    expect(report.summary.stallCount100Ms).toBe(3);
    expect(report.summary.stallCount250Ms).toBe(2);
    expect(report.summary.stallCount1000Ms).toBe(1);
    expect(report.summary.maxStallMs).toBe(1050);
    expect(report.recentStalls).toHaveLength(3);
    await diagnostics.stop();
  });

  it('sample timeline 与序列化报告体积有硬上限', async () => {
    const diagnostics = createDiagnostics();
    await diagnostics.start();
    const sample = (diagnostics as unknown as { sample: () => Promise<void> }).sample.bind(
      diagnostics,
    );
    for (let index = 0; index < 220; index += 1) {
      mono += 10_000;
      await sample();
    }

    const report = diagnostics.snapshot();
    expect(report.recentSamples).toHaveLength(180);
    expect(Buffer.byteLength(JSON.stringify(report), 'utf8')).toBeLessThan(2_000_000);
    await diagnostics.stop();
  });

  it('stall timeline 有 200 条硬上限但 lifetime count 不丢', async () => {
    const diagnostics = createDiagnostics();
    await diagnostics.start();
    const detect = (diagnostics as unknown as { detectStall: () => void }).detectStall.bind(
      diagnostics,
    );
    for (let i = 0; i < 230; i += 1) {
      mono += 400;
      detect();
    }
    const report = diagnostics.snapshot();
    expect(report.recentStalls).toHaveLength(200);
    expect(report.summary.stallCount100Ms).toBe(230);
    await diagnostics.stop();
  });

  it('Markdown 含子进程、active resources、counter/gauge 与操作热力图', async () => {
    const diagnostics = createDiagnostics();
    metrics.recordDuration('git.status', 12);
    metrics.increment('pty.outputChunks');
    metrics.setGauge('git.watchers', 2);
    await diagnostics.start();

    const markdown = renderPerformanceMarkdown(diagnostics.snapshot());
    expect(markdown).toContain('## Electron 子进程');
    expect(markdown).toContain('| Browser | 1 | 2 |');
    expect(markdown).toContain('## Active resources');
    expect(markdown).toContain('| counter | pty.outputChunks | 1 |');
    expect(markdown).toContain('| gauge | git.watchers | 2 |');
    expect(markdown).toContain('| git.status | 1 |');
    await diagnostics.stop();
  });

  it('自动报告不泄露 reportDir/路径/终端内容', async () => {
    const diagnostics = createDiagnostics();
    metrics.recordDuration('git.status', 12);
    await diagnostics.start();
    const serialized = JSON.stringify(diagnostics.snapshot());
    expect(serialized).not.toContain(reportDir);
    expect(serialized).not.toContain('sessionId');
    expect(serialized).not.toContain('terminalContent');
    expect(serialized).toContain('git.status');
    await diagnostics.stop();
  });

  it('retention 只删识别出的旧 run，保留最近 29 个历史 + 当前和无关文件', async () => {
    for (let i = 0; i < 31; i += 1) {
      const id = i.toString(16).padStart(8, '0');
      const stem = `run-20260101T0000${String(i % 60).padStart(2, '0')}Z-${id}`;
      await writeFile(join(reportDir, `${stem}.json`), '{}');
      await writeFile(join(reportDir, `${stem}.md`), '# old');
    }
    await writeFile(join(reportDir, 'do-not-delete.txt'), 'user file');
    await writeFile(join(reportDir, 'run-20250101T000000Z-deadbeef.json.tmp.123.456'), 'partial');
    await writeFile(
      join(reportDir, 'run-20240101T000000Z-deadbeef-cpu-20240101T000001Z.cpuprofile'),
      '{}',
    );
    const diagnostics = createDiagnostics();
    await diagnostics.start();
    const names = await readdir(reportDir);
    expect(names.filter((name) => name.endsWith('.json'))).toHaveLength(30);
    expect(names).toContain('do-not-delete.txt');
    expect(names.some((name) => name.includes('.tmp.'))).toBe(false);
    expect(names.some((name) => name.includes('20240101T000000Z'))).toBe(false);
    await diagnostics.stop();
  });

  it('手动写报告在目录不可写/无效时向 UI 传播失败', async () => {
    const fileInsteadOfDir = join(reportDir, 'not-a-directory');
    await writeFile(fileInsteadOfDir, 'x');
    const diagnostics = new PerformanceDiagnostics({
      reportDir: fileInsteadOfDir,
      appVersion: '0.3.2-test',
      getAppMetrics: () => [],
      getRuntimeContext: () => ({
        windows: 0,
        sessionsTotal: 0,
        sessionsLive: 0,
        sessionsExited: 0,
      }),
      metrics,
      histogram,
    });

    await expect(diagnostics.writeReportNow()).rejects.toThrow();
    expect(diagnostics.getStatus().enabled).toBe(false);
  });

  it('CPU profile clamp 时长、写文件并拒绝并发 capture', async () => {
    let releaseSleep!: () => void;
    const methods: string[] = [];
    const fakeInspector = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      post: vi.fn(
        (
          method: string,
          paramsOrCallback?: Record<string, unknown> | ((e: Error | null, r?: object) => void),
          callback?: (e: Error | null, r?: object) => void,
        ) => {
          methods.push(method);
          const cb = typeof paramsOrCallback === 'function' ? paramsOrCallback : callback;
          cb?.(null, method === 'Profiler.stop' ? { profile: { nodes: [], samples: [] } } : {});
        },
      ),
    };
    const diagnostics = new PerformanceDiagnostics({
      reportDir,
      appVersion: '0.3.2-test',
      getAppMetrics: () => [],
      getRuntimeContext: () => ({
        windows: 0,
        sessionsTotal: 0,
        sessionsLive: 0,
        sessionsExited: 0,
      }),
      metrics,
      histogram,
      createInspectorSession: () => fakeInspector,
      sleep: () =>
        new Promise<void>((resolve) => {
          releaseSleep = resolve;
        }),
    });

    const first = diagnostics.captureCpuProfile(1); // clamp 到 5 秒
    await expect(diagnostics.captureCpuProfile(15)).rejects.toThrow('already running');
    await vi.waitFor(() => expect(releaseSleep).toBeTypeOf('function'));
    releaseSleep();
    const result = await first;
    expect(result.durationSeconds).toBe(5);
    expect(result.path).toMatch(/\.cpuprofile$/);
    expect(JSON.parse(await readFile(result.path, 'utf8'))).toEqual({ nodes: [], samples: [] });
    expect(methods).toEqual([
      'Profiler.enable',
      'Profiler.setSamplingInterval',
      'Profiler.start',
      'Profiler.stop',
      'Profiler.disable',
    ]);
    expect(fakeInspector.disconnect).toHaveBeenCalledOnce();
    releaseSleep = undefined as unknown as () => void;
    const nanCapture = diagnostics.captureCpuProfile(Number.NaN);
    await vi.waitFor(() => expect(releaseSleep).toBeTypeOf('function'));
    releaseSleep();
    await expect(nanCapture).resolves.toMatchObject({ durationSeconds: 15 });
  });

  it('Inspector factory 失败也会复位状态并允许下一次 capture', async () => {
    let factoryCalls = 0;
    const fakeInspector = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      post: vi.fn(
        (
          method: string,
          paramsOrCallback?: Record<string, unknown> | ((e: Error | null, r?: object) => void),
          callback?: (e: Error | null, r?: object) => void,
        ) => {
          const cb = typeof paramsOrCallback === 'function' ? paramsOrCallback : callback;
          cb?.(null, method === 'Profiler.stop' ? { profile: { nodes: [] } } : {});
        },
      ),
    };
    const diagnostics = new PerformanceDiagnostics({
      reportDir,
      appVersion: '0.3.2-test',
      getAppMetrics: () => [],
      getRuntimeContext: () => ({
        windows: 0,
        sessionsTotal: 0,
        sessionsLive: 0,
        sessionsExited: 0,
      }),
      metrics,
      histogram,
      createInspectorSession: () => {
        factoryCalls += 1;
        if (factoryCalls === 1) throw new Error('factory boom');
        return fakeInspector;
      },
      sleep: async () => {},
    });

    await expect(diagnostics.captureCpuProfile()).rejects.toThrow('factory boom');
    expect(diagnostics.getStatus().cpuProfileRunning).toBe(false);
    await expect(diagnostics.captureCpuProfile()).resolves.toMatchObject({ durationSeconds: 15 });
    expect(fakeInspector.disconnect).toHaveBeenCalledOnce();
  });

  it('同一 run 的 CPU profile 最多保留 5 份', async () => {
    let wall = Date.parse('2026-01-01T00:00:00Z');
    const fakeInspector = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      post: vi.fn(
        (
          method: string,
          paramsOrCallback?: Record<string, unknown> | ((e: Error | null, r?: object) => void),
          callback?: (e: Error | null, r?: object) => void,
        ) => {
          const cb = typeof paramsOrCallback === 'function' ? paramsOrCallback : callback;
          cb?.(null, method === 'Profiler.stop' ? { profile: { nodes: [] } } : {});
        },
      ),
    };
    const diagnostics = new PerformanceDiagnostics({
      reportDir,
      appVersion: '0.3.2-test',
      getAppMetrics: () => [],
      getRuntimeContext: () => ({
        windows: 0,
        sessionsTotal: 0,
        sessionsLive: 0,
        sessionsExited: 0,
      }),
      metrics,
      histogram,
      now: () => {
        wall += 10_000;
        return wall;
      },
      createInspectorSession: () => fakeInspector,
      sleep: async () => {},
    });

    for (let index = 0; index < 6; index += 1) await diagnostics.captureCpuProfile(5);
    const profiles = (await readdir(reportDir)).filter((name) => name.endsWith('.cpuprofile'));
    expect(profiles).toHaveLength(5);
  });

  it('sample 从 pty counter delta 推导吞吐速率并更新 peak/burst', async () => {
    const diagnostics = createDiagnostics();
    await diagnostics.start(); // 首次 sample（无流量）
    const sample = (diagnostics as unknown as { sample: () => Promise<void> }).sample.bind(
      diagnostics,
    );
    // 模拟采样窗口内进入 2 MiB → 远超 1 MiB/s 突发阈值
    metrics.increment('pty.outputBytes', 2 * 1024 * 1024);
    metrics.increment('pty.outputChunks', 200);
    mono += 10_000; // 窗口 10s → 速率 = 2 MiB / 10s = ~209 KiB/s
    await sample();
    const report = diagnostics.snapshot();
    expect(report.latestSample?.ptyBytesPerSecond).toBeGreaterThan(0);
    expect(report.latestSample?.ptyChunksPerSecond).toBeGreaterThan(0);
    // 2 MiB / 10s ≈ 209715 B/s，远低于 1 MiB/s 突发阈值 → 本窗口不算突发
    expect(report.summary.ptyBurstWindows).toBe(0);
    expect(report.summary.peakPtyBytesPerSecond).toBeCloseTo((2 * 1024 * 1024 * 1000) / 10_000, 1);
    // 暴露给 stall 关联的 gauge
    expect(report.gauges['pty.recentBytesPerSecond']).toBeGreaterThan(0);
    await diagnostics.stop();
  });

  it('突窗口（速率 >= 1 MiB/s）计入 burstWindows，peak 取最大', async () => {
    const diagnostics = createDiagnostics();
    await diagnostics.start();
    const sample = (diagnostics as unknown as { sample: () => Promise<void> }).sample.bind(
      diagnostics,
    );
    // 窗口 1：1s 内 5 MiB → 5 MiB/s 突发
    metrics.increment('pty.outputBytes', 5 * 1024 * 1024);
    mono += 1000;
    await sample();
    // 窗口 2：1s 内 1 MiB → 1 MiB/s 也算突发
    metrics.increment('pty.outputBytes', 1024 * 1024);
    mono += 1000;
    await sample();
    const report = diagnostics.snapshot();
    expect(report.summary.ptyBurstWindows).toBe(2);
    expect(report.summary.peakPtyBytesPerSecond).toBeCloseTo((5 * 1024 * 1024 * 1000) / 1000, 1);
    await diagnostics.stop();
  });

  it('stall 记录携带近窗口 PTY 速率用于相关性诊断', async () => {
    const diagnostics = createDiagnostics();
    await diagnostics.start();
    const sample = (diagnostics as unknown as { sample: () => Promise<void> }).sample.bind(
      diagnostics,
    );
    metrics.increment('pty.outputBytes', 3 * 1024 * 1024);
    mono += 1000;
    await sample(); // 3 MiB/s 窗口
    const detect = (diagnostics as unknown as { detectStall: () => void }).detectStall.bind(
      diagnostics,
    );
    mono += 500; // drift >100ms 触发 stall
    detect();
    const report = diagnostics.snapshot();
    expect(report.recentStalls).toHaveLength(1);
    expect(report.recentStalls[0]!.ptyBytesPerSecond).toBeGreaterThan(0);
    await diagnostics.stop();
  });

  it('Markdown 含 PTY 吞吐与背压段及 stall 近 PTY 速率列', async () => {
    const diagnostics = createDiagnostics();
    await diagnostics.start();
    const sample = (diagnostics as unknown as { sample: () => Promise<void> }).sample.bind(
      diagnostics,
    );
    metrics.increment('pty.outputBytes', 2 * 1024 * 1024);
    metrics.recordDuration('pty.sessionOutputDispatch', 0.3);
    mono += 1000;
    await sample();
    const markdown = renderPerformanceMarkdown(diagnostics.snapshot());
    expect(markdown).toContain('## PTY 数据吞吐与背压');
    expect(markdown).toContain('总输出：');
    expect(markdown).toContain('平均速率');
    expect(markdown).toContain('sessionOutput IPC 发送');
    expect(markdown).toContain('8ms 聚合窗口吸收字节峰值');
    await diagnostics.stop();
  });
});

describe('aggregateElectronMetrics', () => {
  it('按 process type 汇总并容忍缺失字段', () => {
    const metrics = aggregateElectronMetrics([
      ...fakeAppMetrics(),
      { pid: 3, type: 'GPU', cpu: {}, memory: {} } as unknown as Electron.ProcessMetric,
    ]);
    expect(metrics.find((item) => item.type === 'GPU')).toMatchObject({
      processCount: 2,
      cpuPercent: 3,
      workingSetKb: 200,
    });
  });
});
