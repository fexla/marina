/**
 * @file src/shared/panel-ui-cache.test.ts
 * @purpose 验证面板 UI 工作态缓存的读写、session/panel 隔离、清理语义。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllPanelUiState,
  clearPanelUiState,
  getPanelUiState,
  setPanelUiState,
} from './panel-ui-cache';

beforeEach(() => {
  clearAllPanelUiState();
});

describe('panel-ui-cache', () => {
  it('写入后可读回', () => {
    setPanelUiState('s1', 'file-tree', { expanded: ['a', 'b'] });
    expect(getPanelUiState<{ expanded: string[] }>('s1', 'file-tree')?.expanded).toEqual([
      'a',
      'b',
    ]);
  });

  it('未命中返回 undefined', () => {
    expect(getPanelUiState('s1', 'file-tree')).toBeUndefined();
  });

  it('覆盖写(同 key 后写胜出)', () => {
    setPanelUiState('s1', 'file-tree', { v: 1 });
    setPanelUiState('s1', 'file-tree', { v: 2 });
    expect(getPanelUiState<{ v: number }>('s1', 'file-tree')?.v).toBe(2);
  });

  it('不同 session 互不干扰', () => {
    setPanelUiState('s1', 'file-tree', 'A');
    setPanelUiState('s2', 'file-tree', 'B');
    expect(getPanelUiState<string>('s1', 'file-tree')).toBe('A');
    expect(getPanelUiState<string>('s2', 'file-tree')).toBe('B');
  });

  it('同一 session 不同 panel 互不干扰', () => {
    setPanelUiState('s1', 'file-tree', 'F');
    setPanelUiState('s1', 'git', 'G');
    expect(getPanelUiState<string>('s1', 'file-tree')).toBe('F');
    expect(getPanelUiState<string>('s1', 'git')).toBe('G');
  });

  it('clearPanelUiState(sessionId, panelId) 只清指定 panel', () => {
    setPanelUiState('s1', 'file-tree', 'F');
    setPanelUiState('s1', 'git', 'G');
    clearPanelUiState('s1', 'file-tree');
    expect(getPanelUiState('s1', 'file-tree')).toBeUndefined();
    expect(getPanelUiState<string>('s1', 'git')).toBe('G');
  });

  it('clearPanelUiState(sessionId) 清整个 session 的所有 panel', () => {
    setPanelUiState('s1', 'file-tree', 'F');
    setPanelUiState('s1', 'git', 'G');
    clearPanelUiState('s1');
    expect(getPanelUiState('s1', 'file-tree')).toBeUndefined();
    expect(getPanelUiState('s1', 'git')).toBeUndefined();
  });

  it('clearPanelUiState(sessionId) 不影响其它 session', () => {
    setPanelUiState('s1', 'file-tree', 'A');
    setPanelUiState('s2', 'file-tree', 'B');
    clearPanelUiState('s1');
    expect(getPanelUiState('s1', 'file-tree')).toBeUndefined();
    expect(getPanelUiState<string>('s2', 'file-tree')).toBe('B');
  });

  it('clearAllPanelUiState 清空一切', () => {
    setPanelUiState('s1', 'file-tree', 'A');
    setPanelUiState('s2', 'git', 'B');
    clearAllPanelUiState();
    expect(getPanelUiState('s1', 'file-tree')).toBeUndefined();
    expect(getPanelUiState('s2', 'git')).toBeUndefined();
  });

  it('泛型类型不影响存储(任意结构都能存)', () => {
    const complex = { nested: { set: new Set(['x']), n: 3 }, arr: [1, 2, 3] };
    setPanelUiState('s1', 'file-tree', complex);
    expect(getPanelUiState<typeof complex>('s1', 'file-tree')).toEqual(complex);
  });
});
