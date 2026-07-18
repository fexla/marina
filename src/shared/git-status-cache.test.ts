/**
 * @file src/renderer/state/git-status-cache.test.ts
 * @purpose 验证组件外缓存的基础语义:命中/未命中/覆盖/清除。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearAllCachedStatus,
  clearCachedStatus,
  getCachedStatus,
  setCachedStatus,
} from './git-status-cache';

afterEach(() => {
  clearAllCachedStatus();
});

describe('git-status-cache', () => {
  it('未命中返回 undefined', () => {
    expect(getCachedStatus('s1')).toBeUndefined();
  });

  it('写入 snapshot 后可读回(含 at 时间戳)', () => {
    const before = Date.now();
    setCachedStatus('s1', { groups: [], truncated: false, at: before });
    const entry = getCachedStatus('s1');
    expect(entry).toBeDefined();
    expect(entry?.groups).toEqual([]);
    expect(entry?.truncated).toBe(false);
    expect(entry?.at).toBe(before);
  });

  it('写入 unavailable 后可读回', () => {
    setCachedStatus('s1', { unavailable: 'not-a-repo', at: Date.now() });
    const entry = getCachedStatus('s1');
    expect(entry?.unavailable).toBe('not-a-repo');
    expect(entry?.groups).toBeUndefined();
  });

  it('覆盖:snapshot → unavailable 同 key 覆盖', () => {
    setCachedStatus('s1', { groups: [], truncated: false, at: 1 });
    setCachedStatus('s1', { unavailable: 'disabled', at: 2 });
    const entry = getCachedStatus('s1');
    expect(entry?.unavailable).toBe('disabled');
    expect(entry?.groups).toBeUndefined();
    expect(entry?.at).toBe(2);
  });

  it('清除单个 session 不影响其他', () => {
    setCachedStatus('s1', { groups: [], truncated: false, at: 1 });
    setCachedStatus('s2', { groups: [], truncated: false, at: 2 });
    clearCachedStatus('s1');
    expect(getCachedStatus('s1')).toBeUndefined();
    expect(getCachedStatus('s2')).toBeDefined();
  });

  it('多 session 隔离', () => {
    setCachedStatus('s1', { groups: [{ tone: 'modified', entries: [] }], truncated: false, at: 1 });
    setCachedStatus('s2', { groups: [], truncated: true, at: 2 });
    expect(getCachedStatus('s1')?.groups).toHaveLength(1);
    expect(getCachedStatus('s2')?.truncated).toBe(true);
  });
});
