/**
 * @file src/main/performance-metrics.test.ts
 * @purpose 验证 0.3.2 固定名称操作热力图的聚合、上限、错误与 in-flight 语义。
 */
import { describe, expect, it } from 'vitest';
import { PerformanceMetrics } from './performance-metrics';

describe('PerformanceMetrics', () => {
  it('按固定桶聚合 duration/error 并计算热力图', () => {
    const metrics = new PerformanceMetrics();
    metrics.recordDuration('git.status', 2);
    metrics.recordDuration('git.status', 40);
    metrics.recordDuration('git.status', 300, true);

    const item = metrics.snapshot().operations[0]!;
    expect(item.name).toBe('git.status');
    expect(item.count).toBe(3);
    expect(item.errors).toBe(1);
    expect(item.totalMs).toBe(342);
    expect(item.averageMs).toBe(114);
    expect(item.approximateP95Ms).toBe(500);
    expect(item.maxMs).toBe(300);
    expect(item.buckets.lt5).toBe(1);
    expect(item.buckets.lt50).toBe(1);
    expect(item.buckets.lt500).toBe(1);
  });

  it('begin/finish 维护 inFlight 且 finish 幂等', () => {
    const metrics = new PerformanceMetrics();
    const finish = metrics.begin('ipc.cmd:session:create');
    expect(metrics.snapshot().activeOperations).toEqual(['ipc.cmd:session:create']);
    finish();
    finish(new Error('late duplicate'));
    const item = metrics.snapshot().operations[0]!;
    expect(item.inFlight).toBe(0);
    expect(item.count).toBe(1);
    expect(item.errors).toBe(0);
  });

  it('measure 保留返回值并统计 rejection', async () => {
    const metrics = new PerformanceMetrics();
    await expect(metrics.measure('git.diff', async () => 42)).resolves.toBe(42);
    await expect(
      metrics.measure('git.diff', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const item = metrics.snapshot().operations[0]!;
    expect(item.count).toBe(2);
    expect(item.errors).toBe(1);
  });

  it('operation names 有硬上限,高基数标签并入 overflow', () => {
    const metrics = new PerformanceMetrics();
    for (let i = 0; i < 260; i += 1) metrics.recordDuration(`operation.${i}`, i);
    const snapshot = metrics.snapshot();
    expect(snapshot.operations.length).toBeLessThanOrEqual(200);
    expect(snapshot.operations.some((item) => item.name === 'performance.operationOverflow')).toBe(
      true,
    );
    expect(snapshot.counters['performance.metricNamesDropped']).toBeGreaterThan(0);
  });

  it('counter/gauge names 同样有硬上限并汇入固定 overflow', () => {
    const metrics = new PerformanceMetrics();
    for (let i = 0; i < 260; i += 1) {
      metrics.increment(`counter.${i}`);
      metrics.setGauge(`gauge.${i}`, i);
    }

    const snapshot = metrics.snapshot();
    expect(Object.keys(snapshot.counters).length).toBeLessThanOrEqual(200);
    expect(Object.keys(snapshot.gauges).length).toBeLessThanOrEqual(200);
    expect(snapshot.counters['performance.counterOverflow']).toBeGreaterThan(0);
    expect(snapshot.gauges['performance.gaugeOverflow']).toBe(259);
    expect(snapshot.counters['performance.metricNamesDropped']).toBeGreaterThan(0);
  });

  it('拒绝路径和非法动态名称,防自动报告泄露', () => {
    const metrics = new PerformanceMetrics();
    expect(() => metrics.increment('C:\\Users\\me\\repo')).toThrow('Invalid metric name');
    expect(() => metrics.setGauge('repo/foo', 1)).toThrow('Invalid metric name');
  });
});
