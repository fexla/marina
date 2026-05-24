/**
 * @file src/main/path-manager.test.ts
 * @purpose PathManager 单元测试。覆盖 Path 状态机所有转移、容量限制、
 *   bookmark 增删改查、归类优先级、错误码。
 *
 * @关键设计:
 * - 用 in-memory FakeJsonStore 替代真实 JsonStore,避免 fs I/O 影响测试
 *   速度;persistence 自身的 atomic / debounce 由 persistence.test.ts
 *   单独覆盖,这里只验证 PathManager 调对了 store.set
 * - 每个测试用 new PathManager 隔离状态,绝不共享
 *
 * @对应文档章节: AGENTS.md 5.3 (Path 状态机必测;PathManager 增删改查;
 *   容量限制 30 个最近);软件定义书.md 8.2 (状态机)
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { BookmarksFile, RecentFile } from '@shared/types';
import { PathManager, PathManagerError, normalizePath } from './path-manager';
import type { JsonStore } from './persistence';

/**
 * 内存 JsonStore 替身。只关心 load() 返回什么 + set() 被调用时存的值。
 */
class FakeJsonStore<T> {
  private current: T | null = null;
  /** 给测试断言用,记录每次 set 的内容 */
  public readonly setHistory: T[] = [];

  setInitial(value: T): void {
    this.current = value;
  }

  async load(defaultValue: T): Promise<{ value: T; source: 'main' | 'bak' | 'default' }> {
    if (this.current !== null) return { value: this.current, source: 'main' };
    return { value: defaultValue, source: 'default' };
  }

  set(value: T): void {
    this.current = value;
    this.setHistory.push(value);
  }

  getInMemory(): T | null {
    return this.current;
  }

  async flush(): Promise<void> {
    /* no-op */
  }

  destroy(): void {
    /* no-op */
  }
}

function makeManager(opts?: {
  initialBookmarks?: BookmarksFile;
  initialRecent?: RecentFile;
}): {
  mgr: PathManager;
  bookmarksStore: FakeJsonStore<BookmarksFile>;
  recentStore: FakeJsonStore<RecentFile>;
} {
  const bookmarksStore = new FakeJsonStore<BookmarksFile>();
  const recentStore = new FakeJsonStore<RecentFile>();
  if (opts?.initialBookmarks) bookmarksStore.setInitial(opts.initialBookmarks);
  if (opts?.initialRecent) recentStore.setInitial(opts.initialRecent);
  const mgr = new PathManager(
    bookmarksStore as unknown as JsonStore<BookmarksFile>,
    recentStore as unknown as JsonStore<RecentFile>,
  );
  return { mgr, bookmarksStore, recentStore };
}

const TEST_PATH_A = process.platform === 'win32' ? 'C:\\projects\\a' : '/projects/a';
const TEST_PATH_B = process.platform === 'win32' ? 'C:\\projects\\b' : '/projects/b';
const TEST_PATH_C = process.platform === 'win32' ? 'C:\\projects\\c' : '/projects/c';

describe('normalizePath', () => {
  if (process.platform === 'win32') {
    it('Windows: 卷符大写化', () => {
      expect(normalizePath('c:\\foo\\bar')).toBe('C:\\foo\\bar');
      expect(normalizePath('C:\\foo\\bar')).toBe('C:\\foo\\bar');
    });

    it('Windows: 移除尾部反斜杠 (除根)', () => {
      expect(normalizePath('C:\\foo\\bar\\')).toBe('C:\\foo\\bar');
      // resolve('C:\\') 在 Windows 上规范化为 'C:\\',这是根,不剥离
      expect(normalizePath('C:\\').endsWith('\\')).toBe(true);
    });
  } else {
    it('POSIX: 移除尾部斜杠', () => {
      expect(normalizePath('/foo/bar/')).toBe('/foo/bar');
      expect(normalizePath('/')).toBe('/');
    });
  }

  it('相对路径 → 绝对', () => {
    const result = normalizePath('.');
    expect(result.length).toBeGreaterThan(1);
  });
});

describe('PathManager — 初始化', () => {
  it('空 store 时 tree 三栏全空', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    const tree = mgr.getTree();
    expect(tree.bookmarks).toEqual([]);
    expect(tree.temporary).toEqual([]);
    expect(tree.recent).toEqual([]);
  });

  it('从持久化恢复 bookmarks', async () => {
    const { mgr } = makeManager({
      initialBookmarks: {
        version: 1,
        paths: [
          { id: 'b1', path: TEST_PATH_A, addedAt: 1 },
          { id: 'b2', path: TEST_PATH_B, displayName: 'Project B', addedAt: 2 },
        ],
      },
    });
    await mgr.initialize();
    const tree = mgr.getTree();
    expect(tree.bookmarks).toHaveLength(2);
    expect(tree.bookmarks[0]!.path).toBe(TEST_PATH_A);
    expect(tree.bookmarks[1]!.displayName).toBe('Project B');
  });

  it('从持久化恢复 recent,按 lastUsedAt 降序', async () => {
    const { mgr } = makeManager({
      initialRecent: {
        version: 1,
        paths: [
          { path: TEST_PATH_A, lastUsedAt: 100, useCount: 1 },
          { path: TEST_PATH_B, lastUsedAt: 300, useCount: 5 },
          { path: TEST_PATH_C, lastUsedAt: 200, useCount: 2 },
        ],
      },
    });
    await mgr.initialize();
    const tree = mgr.getTree();
    expect(tree.recent.map((r) => r.path)).toEqual([TEST_PATH_B, TEST_PATH_C, TEST_PATH_A]);
  });

  // ──────────────────────────────────────────────────────────────────
  // SSH 方案 v2.1 §II.1:磁盘迁移不变式 — 老 schema(kind 缺失)、损坏
  // schema(kind=ssh 缺 sshProfileId)都要能让 Marina 启动起来。
  // ──────────────────────────────────────────────────────────────────

  it('迁移:旧 bookmark 缺 kind → 自动按 local 加载', async () => {
    const { mgr } = makeManager({
      initialBookmarks: {
        version: 1,
        paths: [{ id: 'legacy', path: TEST_PATH_A, addedAt: 1 }],
      },
    });
    await mgr.initialize();
    const tree = mgr.getTree();
    expect(tree.bookmarks).toHaveLength(1);
    expect(tree.bookmarks[0]!.kind).toBe('local');
  });

  it('迁移:旧 recent 缺 kind → 自动按 local 加载', async () => {
    const { mgr } = makeManager({
      initialRecent: {
        version: 1,
        paths: [{ path: TEST_PATH_A, lastUsedAt: 100, useCount: 3 }],
      },
    });
    await mgr.initialize();
    const tree = mgr.getTree();
    expect(tree.recent).toHaveLength(1);
    expect(tree.recent[0]!.kind).toBe('local');
  });

  it('迁移:kind=ssh 但缺 sshProfileId 的 bookmark → 启动期静默丢弃', async () => {
    const { mgr } = makeManager({
      initialBookmarks: {
        version: 1,
        paths: [
          { id: 'ok', path: TEST_PATH_A, addedAt: 1 },
          { id: 'broken', path: '~/x', kind: 'ssh', addedAt: 2 },
        ],
      },
    });
    await mgr.initialize();
    const tree = mgr.getTree();
    expect(tree.bookmarks).toHaveLength(1);
    expect(tree.bookmarks[0]!.id).toBe(normalizePath(TEST_PATH_A));
  });

  it('迁移:kind=ssh 完整 bookmark 正常加载,narrow 出 sshProfileId', async () => {
    const { mgr } = makeManager({
      initialBookmarks: {
        version: 1,
        paths: [
          {
            id: 'r',
            path: '~/repo',
            kind: 'ssh',
            sshProfileId: 'profile-a',
            addedAt: 1,
          },
        ],
      },
    });
    await mgr.initialize();
    const tree = mgr.getTree();
    expect(tree.bookmarks).toHaveLength(1);
    const node = tree.bookmarks[0]!;
    expect(node.kind).toBe('ssh');
    if (node.kind === 'ssh') {
      expect(node.sshProfileId).toBe('profile-a');
    }
  });
});

describe('PathManager — addBookmark / removeBookmark', () => {
  it('addBookmark 添加新条目并落盘', async () => {
    const { mgr, bookmarksStore } = makeManager();
    await mgr.initialize();

    const b = mgr.addBookmark({ path: TEST_PATH_A, displayName: 'Alpha' });
    expect(b.path).toBe(TEST_PATH_A);
    expect(b.displayName).toBe('Alpha');
    expect(b.id).toMatch(/^[0-9a-f-]{36}$/);

    const tree = mgr.getTree();
    expect(tree.bookmarks).toHaveLength(1);
    expect(bookmarksStore.setHistory).toHaveLength(1);
    expect(bookmarksStore.setHistory[0]!.paths[0]!.path).toBe(TEST_PATH_A);
  });

  it('addBookmark 重复路径 throw BookmarkAlreadyExists', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.addBookmark({ path: TEST_PATH_A });
    expect(() => mgr.addBookmark({ path: TEST_PATH_A })).toThrowError(
      /BookmarkAlreadyExists/,
    );
  });

  it('addBookmark 自动从 recent 移除 (避免重复出现)', async () => {
    const { mgr } = makeManager({
      initialRecent: {
        version: 1,
        paths: [{ path: TEST_PATH_A, lastUsedAt: 100, useCount: 1 }],
      },
    });
    await mgr.initialize();
    mgr.addBookmark({ path: TEST_PATH_A });

    const tree = mgr.getTree();
    expect(tree.bookmarks).toHaveLength(1);
    expect(tree.recent).toHaveLength(0);
  });

  it('removeBookmark 移除并进入最近 (无 session 时)', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.addBookmark({ path: TEST_PATH_A });
    mgr.removeBookmark(TEST_PATH_A);
    const tree = mgr.getTree();
    expect(tree.bookmarks).toEqual([]);
    expect(tree.recent.map((r) => r.path)).toContain(TEST_PATH_A);
  });

  it('removeBookmark 时若有 session → 进入临时而非最近', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.addBookmark({ path: TEST_PATH_A });
    mgr.attachSession('s1', TEST_PATH_A);
    mgr.removeBookmark(TEST_PATH_A);

    const tree = mgr.getTree();
    expect(tree.bookmarks).toEqual([]);
    expect(tree.temporary.map((r) => r.path)).toContain(TEST_PATH_A);
    expect(tree.recent.map((r) => r.path)).not.toContain(TEST_PATH_A);
  });

  it('removeBookmark 不存在 throw BookmarkNotFound', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    expect(() => mgr.removeBookmark(TEST_PATH_A)).toThrowError(/BookmarkNotFound/);
  });
});

describe('PathManager — renameBookmark / reorderBookmarks / setDefaultTemplate', () => {
  beforeEach(() => {
    /* placeholder */
  });

  it('renameBookmark 修改 displayName', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.addBookmark({ path: TEST_PATH_A });
    mgr.renameBookmark(TEST_PATH_A, 'My Alpha');
    expect(mgr.getTree().bookmarks[0]!.displayName).toBe('My Alpha');
  });

  it('renameBookmark 空字符串 → 清掉 displayName', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.addBookmark({ path: TEST_PATH_A, displayName: 'Old' });
    mgr.renameBookmark(TEST_PATH_A, '');
    expect(mgr.getTree().bookmarks[0]!.displayName).toBeUndefined();
  });

  it('renameBookmark 超长 / 非字符串 throw InvalidName', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.addBookmark({ path: TEST_PATH_A });
    expect(() => mgr.renameBookmark(TEST_PATH_A, 'x'.repeat(101))).toThrowError(
      /InvalidName/,
    );
    expect(() => mgr.renameBookmark(TEST_PATH_A, 123 as unknown as string)).toThrowError(
      /InvalidName/,
    );
  });

  it('reorderBookmarks 改顺序', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.addBookmark({ path: TEST_PATH_A });
    mgr.addBookmark({ path: TEST_PATH_B });
    mgr.addBookmark({ path: TEST_PATH_C });
    mgr.reorderBookmarks([TEST_PATH_C, TEST_PATH_A, TEST_PATH_B]);
    const tree = mgr.getTree();
    expect(tree.bookmarks.map((b) => b.path)).toEqual([
      TEST_PATH_C,
      TEST_PATH_A,
      TEST_PATH_B,
    ]);
  });

  it('reorderBookmarks 数量不匹配 throw InvalidOrderList', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.addBookmark({ path: TEST_PATH_A });
    mgr.addBookmark({ path: TEST_PATH_B });
    expect(() => mgr.reorderBookmarks([TEST_PATH_A])).toThrowError(/InvalidOrderList/);
  });

  it('reorderBookmarks 含未知 path throw InvalidOrderList', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.addBookmark({ path: TEST_PATH_A });
    mgr.addBookmark({ path: TEST_PATH_B });
    expect(() => mgr.reorderBookmarks([TEST_PATH_A, TEST_PATH_C])).toThrowError(
      /InvalidOrderList/,
    );
  });

  it('reorderBookmarks 重复 id throw InvalidOrderList', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.addBookmark({ path: TEST_PATH_A });
    mgr.addBookmark({ path: TEST_PATH_B });
    expect(() => mgr.reorderBookmarks([TEST_PATH_A, TEST_PATH_A])).toThrowError(
      /InvalidOrderList/,
    );
  });

  it('setDefaultTemplate 设置和清空', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.addBookmark({ path: TEST_PATH_A });
    mgr.setDefaultTemplate(TEST_PATH_A, 'claude-code');
    expect(mgr.getTree().bookmarks[0]!.defaultTemplateId).toBe('claude-code');
    mgr.setDefaultTemplate(TEST_PATH_A, null);
    expect(mgr.getTree().bookmarks[0]!.defaultTemplateId).toBeUndefined();
  });
});

describe('PathManager — Session attach / detach 触发状态机', () => {
  it('在非收藏路径 attach session → 临时分类', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.attachSession('s1', TEST_PATH_A);

    const tree = mgr.getTree();
    expect(tree.temporary).toHaveLength(1);
    expect(tree.temporary[0]!.path).toBe(TEST_PATH_A);
    expect(tree.temporary[0]!.sessionIds).toEqual(['s1']);
  });

  it('在收藏路径 attach session → 仍在收藏分类 (不重复出现)', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.addBookmark({ path: TEST_PATH_A });
    mgr.attachSession('s1', TEST_PATH_A);

    const tree = mgr.getTree();
    expect(tree.bookmarks).toHaveLength(1);
    expect(tree.bookmarks[0]!.sessionIds).toEqual(['s1']);
    expect(tree.temporary).toHaveLength(0);
  });

  it('detach 最后一个 session → 临时变最近', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.attachSession('s1', TEST_PATH_A);
    mgr.detachSession('s1');

    const tree = mgr.getTree();
    expect(tree.temporary).toEqual([]);
    expect(tree.recent.map((r) => r.path)).toContain(TEST_PATH_A);
  });

  it('detach 非最后 session → 仍在临时', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.attachSession('s1', TEST_PATH_A);
    mgr.attachSession('s2', TEST_PATH_A);
    mgr.detachSession('s1');

    const tree = mgr.getTree();
    expect(tree.temporary).toHaveLength(1);
    expect(tree.temporary[0]!.sessionIds).toEqual(['s2']);
  });

  it('detach 收藏路径的 session → 仍在收藏 (不进最近)', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.addBookmark({ path: TEST_PATH_A });
    mgr.attachSession('s1', TEST_PATH_A);
    mgr.detachSession('s1');

    const tree = mgr.getTree();
    expect(tree.bookmarks).toHaveLength(1);
    expect(tree.bookmarks[0]!.sessionIds).toEqual([]);
    expect(tree.recent).toEqual([]);
  });

  it('attach 已在的 session 到不同 path → 自动从旧 path detach', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.attachSession('s1', TEST_PATH_A);
    mgr.attachSession('s1', TEST_PATH_B);

    const tree = mgr.getTree();
    const aPath = tree.temporary.find((p) => p.path === TEST_PATH_A);
    const bPath = tree.temporary.find((p) => p.path === TEST_PATH_B);
    expect(aPath).toBeUndefined(); // A 不再有 session,变最近了
    expect(bPath?.sessionIds).toEqual(['s1']);
    expect(tree.recent.map((r) => r.path)).toContain(TEST_PATH_A);
  });

  it('detach 不存在的 sessionId 不报错 (幂等)', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    expect(() => mgr.detachSession('s-nonexistent')).not.toThrow();
  });
});

describe('PathManager — Recent 容量与排序', () => {
  it('容量上限 30,超出淘汰最旧', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    // 创建 35 个不同的临时路径,关掉让他们都进 recent
    for (let i = 0; i < 35; i++) {
      const p = process.platform === 'win32' ? `C:\\p${i}` : `/p${i}`;
      mgr.attachSession(`s${i}`, p);
      mgr.detachSession(`s${i}`);
    }
    const tree = mgr.getTree();
    expect(tree.recent.length).toBe(30);
    // 最新的 30 个应在,最旧的 5 个被淘汰 (p0-p4)
    const pathsInRecent = new Set(tree.recent.map((r) => r.path));
    expect(pathsInRecent.has(process.platform === 'win32' ? 'C:\\p34' : '/p34')).toBe(
      true,
    );
    expect(pathsInRecent.has(process.platform === 'win32' ? 'C:\\p0' : '/p0')).toBe(false);
  });

  it('removeFromRecent 移除指定 path', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.attachSession('s1', TEST_PATH_A);
    mgr.detachSession('s1'); // 进入 recent
    mgr.removeFromRecent(TEST_PATH_A);
    expect(mgr.getTree().recent).toEqual([]);
  });

  it('removeFromRecent 不存在 throw PathNotInRecent', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    expect(() => mgr.removeFromRecent(TEST_PATH_A)).toThrowError(/PathNotInRecent/);
  });
});

describe('PathManager — 分类优先级 (无重叠)', () => {
  it('同一 path 不会同时出现在两个分类', async () => {
    const { mgr } = makeManager({
      initialRecent: {
        version: 1,
        paths: [{ path: TEST_PATH_A, lastUsedAt: 100, useCount: 1 }],
      },
    });
    await mgr.initialize();
    mgr.addBookmark({ path: TEST_PATH_A });
    mgr.attachSession('s1', TEST_PATH_A);

    const tree = mgr.getTree();
    const inBookmarks = tree.bookmarks.some((p) => p.path === TEST_PATH_A);
    const inTemporary = tree.temporary.some((p) => p.path === TEST_PATH_A);
    const inRecent = tree.recent.some((p) => p.path === TEST_PATH_A);
    expect([inBookmarks, inTemporary, inRecent]).toEqual([true, false, false]);
  });
});

describe('PathManager — 事件发射', () => {
  it('addBookmark 触发 pathTreeUpdated 与 bookmarksUpdated', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    const treeListener = vi.fn();
    const bkListener = vi.fn();
    mgr.on('pathTreeUpdated', treeListener);
    mgr.on('bookmarksUpdated', bkListener);

    mgr.addBookmark({ path: TEST_PATH_A });
    expect(treeListener).toHaveBeenCalledTimes(1);
    expect(bkListener).toHaveBeenCalledTimes(1);
  });

  it('attachSession 触发 pathTreeUpdated', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    const treeListener = vi.fn();
    mgr.on('pathTreeUpdated', treeListener);
    mgr.attachSession('s1', TEST_PATH_A);
    expect(treeListener).toHaveBeenCalledTimes(1);
  });

  it('attach 同一 sessionId + 同一 path 不重复触发', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.attachSession('s1', TEST_PATH_A);
    const treeListener = vi.fn();
    mgr.on('pathTreeUpdated', treeListener);
    mgr.attachSession('s1', TEST_PATH_A);
    expect(treeListener).not.toHaveBeenCalled();
  });
});

describe('PathManager — flush', () => {
  it('flush 调用底层 store.flush', async () => {
    const { mgr, bookmarksStore, recentStore } = makeManager();
    const bkFlush = vi.spyOn(bookmarksStore, 'flush');
    const rcFlush = vi.spyOn(recentStore, 'flush');
    await mgr.initialize();
    await mgr.flush();
    expect(bkFlush).toHaveBeenCalled();
    expect(rcFlush).toHaveBeenCalled();
  });
});

describe('PathManagerError', () => {
  it('暴露 code 字段供 IPC 翻译', () => {
    const err = new PathManagerError('BookmarkNotFound', 'foo');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('BookmarkNotFound');
    expect(err.message).toContain('BookmarkNotFound');
  });
});
