/**
 * @file src/shared/panel-preferences.test.ts
 * @purpose 验证面板偏好(L2)的读写、统一 key 规范、老 key 惰性迁移、storage 注入隔离。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  setPreferenceStorage,
  readPanelPreference,
  removePanelPreference,
  writePanelPreference,
  type PreferenceStorage,
} from './panel-preferences';

/** 每个用例注入全新内存 storage,保证用例间完全隔离。 */
function freshStorage(): PreferenceStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

let storage: PreferenceStorage;
beforeEach(() => {
  storage = freshStorage();
  setPreferenceStorage(storage);
});

describe('panel-preferences', () => {
  it('写入后可读回(字符串)', () => {
    writePanelPreference('git', 'viewMode', 'tree');
    expect(readPanelPreference('git', 'viewMode', 'flat')).toBe('tree');
  });

  it('写入后可读回(数字)', () => {
    writePanelPreference('sidebar', 'width', 280);
    expect(readPanelPreference('sidebar', 'width', 200)).toBe(280);
  });

  it('写入后可读回(对象)', () => {
    writePanelPreference('p', 'k', { a: 1, b: [2, 3] });
    expect(readPanelPreference<{ a: number; b: number[] }>('p', 'k', { a: 0, b: [] })).toEqual({
      a: 1,
      b: [2, 3],
    });
  });

  it('未命中返回 fallback(不影响 storage)', () => {
    expect(readPanelPreference('git', 'viewMode', 'tree')).toBe('tree');
    // fallback 不应写入 storage
    expect(storage.getItem('marina.panel.git.viewMode')).toBeNull();
  });

  it('不同 panel / key 互不干扰', () => {
    writePanelPreference('git', 'viewMode', 'flat');
    writePanelPreference('file-tree', 'activeRootId', 'session-cwd');
    expect(readPanelPreference('git', 'viewMode', 'tree')).toBe('flat');
    expect(readPanelPreference('file-tree', 'activeRootId', 'managed-workspace')).toBe(
      'session-cwd',
    );
  });

  it('removePanelPreference 删除指定 key', () => {
    writePanelPreference('git', 'viewMode', 'flat');
    removePanelPreference('git', 'viewMode');
    expect(readPanelPreference('git', 'viewMode', 'tree')).toBe('tree');
  });

  it('老 key marina.git.viewMode 惰性迁移到新规范', () => {
    // 模拟老版本用户机器:只写了老 key(裸字符串,无 JSON 引号)
    storage.setItem('marina.git.viewMode', 'flat');
    expect(storage.getItem('marina.panel.git.viewMode')).toBeNull();

    // 首次读:命中老 key → 迁移
    const value = readPanelPreference('git', 'viewMode', 'tree');
    expect(value).toBe('flat');

    // 迁移后:新 key 写入、老 key 删除
    expect(storage.getItem('marina.panel.git.viewMode')).toBe(JSON.stringify('flat'));
    expect(storage.getItem('marina.git.viewMode')).toBeNull();

    // 再次读:直接命中新 key(不再走迁移)
    expect(readPanelPreference('git', 'viewMode', 'tree')).toBe('flat');
  });

  it('老 key marina.sidebar.width(数字字符串)迁移', () => {
    storage.setItem('marina.sidebar.width', '320');
    const value = readPanelPreference('sidebar', 'width', 200);
    expect(value).toBe(320);
    expect(storage.getItem('marina.panel.sidebar.width')).toBe(JSON.stringify(320));
    expect(storage.getItem('marina.sidebar.width')).toBeNull();
  });

  it('老 key marina.sidebar.segment 迁移', () => {
    storage.setItem('marina.sidebar.segment', 'recent');
    expect(readPanelPreference('sidebar', 'segment', 'favorite')).toBe('recent');
    expect(storage.getItem('marina.panel.sidebar.segment')).toBe(JSON.stringify('recent'));
  });

  it('新 key 已存在时不触发迁移(新 key 优先)', () => {
    storage.setItem('marina.git.viewMode', 'flat'); // 老 key
    storage.setItem('marina.panel.git.viewMode', JSON.stringify('tree')); // 新 key
    expect(readPanelPreference('git', 'viewMode', 'flat')).toBe('tree');
    // 老 key 保持原样(没被读,没被删)
    expect(storage.getItem('marina.git.viewMode')).toBe('flat');
  });

  it('无老 key 且无新 key 时返回 fallback,不产生任何写入', () => {
    expect(readPanelPreference('git', 'viewMode', 'tree')).toBe('tree');
    expect(storage.getItem('marina.panel.git.viewMode')).toBeNull();
    expect(storage.getItem('marina.git.viewMode')).toBeNull();
  });

  it('覆盖写(同 key 后写胜出)', () => {
    writePanelPreference('git', 'viewMode', 'tree');
    writePanelPreference('git', 'viewMode', 'flat');
    expect(readPanelPreference('git', 'viewMode', 'tree')).toBe('flat');
  });
});
