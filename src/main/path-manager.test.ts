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

function makeManager(opts?: { initialBookmarks?: BookmarksFile; initialRecent?: RecentFile }): {
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
        version: 4,
        groups: [],
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
      // v1 磁盘文件(无 groups 字段);转 unknown 模拟旧盘加载
      initialBookmarks: {
        version: 1,
        paths: [{ id: 'legacy', path: TEST_PATH_A, addedAt: 1 }],
      } as unknown as BookmarksFile,
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
      // v1 磁盘文件(无 groups 字段)
      initialBookmarks: {
        version: 1,
        paths: [
          { id: 'ok', path: TEST_PATH_A, addedAt: 1 },
          { id: 'broken', path: '~/x', kind: 'ssh', addedAt: 2 },
        ],
      } as unknown as BookmarksFile,
    });
    await mgr.initialize();
    const tree = mgr.getTree();
    expect(tree.bookmarks).toHaveLength(1);
    expect(tree.bookmarks[0]!.id).toBe(normalizePath(TEST_PATH_A));
  });

  it('迁移:kind=ssh 完整 bookmark 正常加载,narrow 出 sshProfileId', async () => {
    const { mgr } = makeManager({
      // v1 磁盘文件(无 groups 字段)
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
      } as unknown as BookmarksFile,
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

  it('addBookmark 带 groupId 时原子地直接进入该组', async () => {
    const { mgr, bookmarksStore } = makeManager();
    await mgr.initialize();
    const group = mgr.addGroup('工作', 'local');

    const bookmark = mgr.addBookmark({ path: TEST_PATH_A, groupId: group.id });

    expect(bookmark.groupId).toBe(group.id);
    expect(mgr.getTree().bookmarks[0]?.groupId).toBe(group.id);
    expect(bookmarksStore.setHistory.at(-1)?.paths[0]?.groupId).toBe(group.id);
  });

  it('addBookmark 拒绝不存在/空 groupId，且不留下半完成收藏', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();

    expect(() => mgr.addBookmark({ path: TEST_PATH_A, groupId: 'missing' })).toThrowError(
      /GroupNotFound/,
    );
    expect(() => mgr.addBookmark({ path: TEST_PATH_A, groupId: '' })).toThrowError(/GroupNotFound/);
    expect(mgr.getTree().bookmarks).toEqual([]);
  });

  it('addBookmark 重复路径 throw BookmarkAlreadyExists', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.addBookmark({ path: TEST_PATH_A });
    expect(() => mgr.addBookmark({ path: TEST_PATH_A })).toThrowError(/BookmarkAlreadyExists/);
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
    expect(() => mgr.renameBookmark(TEST_PATH_A, 'x'.repeat(101))).toThrowError(/InvalidName/);
    expect(() => mgr.renameBookmark(TEST_PATH_A, 123 as unknown as string)).toThrowError(
      /InvalidName/,
    );
  });

  it('reorderBookmarks 改顺序(全未分组 = flat 特例)', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.addBookmark({ path: TEST_PATH_A });
    mgr.addBookmark({ path: TEST_PATH_B });
    mgr.addBookmark({ path: TEST_PATH_C });
    mgr.reorderBookmarks({ ungrouped: [TEST_PATH_C, TEST_PATH_A, TEST_PATH_B], groups: [] });
    const tree = mgr.getTree();
    expect(tree.bookmarks.map((b) => b.path)).toEqual([TEST_PATH_C, TEST_PATH_A, TEST_PATH_B]);
  });

  it('reorderBookmarks 数量不匹配 throw InvalidOrderList', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.addBookmark({ path: TEST_PATH_A });
    mgr.addBookmark({ path: TEST_PATH_B });
    expect(() => mgr.reorderBookmarks({ ungrouped: [TEST_PATH_A], groups: [] })).toThrowError(
      /InvalidOrderList/,
    );
  });

  it('reorderBookmarks 含未知 path throw InvalidOrderList', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.addBookmark({ path: TEST_PATH_A });
    mgr.addBookmark({ path: TEST_PATH_B });
    expect(() =>
      mgr.reorderBookmarks({ ungrouped: [TEST_PATH_A, TEST_PATH_C], groups: [] }),
    ).toThrowError(/InvalidOrderList/);
  });

  it('reorderBookmarks 重复 id throw InvalidOrderList', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.addBookmark({ path: TEST_PATH_A });
    mgr.addBookmark({ path: TEST_PATH_B });
    expect(() =>
      mgr.reorderBookmarks({ ungrouped: [TEST_PATH_A, TEST_PATH_A], groups: [] }),
    ).toThrowError(/InvalidOrderList/);
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
    expect(pathsInRecent.has(process.platform === 'win32' ? 'C:\\p34' : '/p34')).toBe(true);
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

// ╔══════════════════════════════════════════════════════════════════╗
// ║  v0.3.3 ADR-025 / Feature E.1+E.2:收藏分组 + session 拖序 后端单测  ║
// ╚══════════════════════════════════════════════════════════════════╝
// 覆盖:bookmarks.json v1→v2 迁移 / 分层 reorder 校验+应用 / group CRUD /
// 删组子项归未分组 / 组名唯一校验 / getTree 组装 / sessionOrder(内存)。
describe('PathManager — 收藏分组 (ADR-025 / Feature E.1)', () => {
  // 构造一个带 3 bookmark + 2 group 的初始状态,给 reorder/CRUD 测试复用。
  async function makeWithGroups() {
    const { mgr, bookmarksStore } = makeManager();
    await mgr.initialize();
    mgr.addBookmark({ path: TEST_PATH_A });
    mgr.addBookmark({ path: TEST_PATH_B });
    mgr.addBookmark({ path: TEST_PATH_C });
    const g1 = mgr.addGroup('工作', 'local');
    const g2 = mgr.addGroup('个人', 'local');
    return { mgr, bookmarksStore, g1, g2 };
  }

  // ── schema v1→v2 迁移 ────────────────────────────────────────
  it('迁移:v1 文件(无 groups)→ 加载后 groups=[], path groupId=undefined', async () => {
    const { mgr } = makeManager({
      initialBookmarks: {
        version: 1,
        paths: [{ id: 'legacy', path: TEST_PATH_A, addedAt: 1 }],
      } as unknown as BookmarksFile,
    });
    await mgr.initialize();
    const tree = mgr.getTree();
    expect(tree.groups).toEqual([]);
    expect(tree.bookmarks[0]!.groupId).toBeUndefined();
  });

  it('迁移:v2 文件带 groups + path.groupId → 正确恢复(平铺升级为 v3 嵌套形状)', async () => {
    const { mgr } = makeManager({
      initialBookmarks: {
        version: 2,
        groups: [{ id: 'g1', name: '工作' }],
        paths: [{ id: 'b1', path: TEST_PATH_A, groupId: 'g1', addedAt: 1 }],
        // v2 是历史 schema,类型上已升到 v3 —— 迁移测试故意喂旧版本,转义类型检查。
      } as unknown as BookmarksFile,
    });
    await mgr.initialize();
    const tree = mgr.getTree();
    expect(tree.groups).toEqual([{ id: 'g1', name: '工作', kind: 'local', subgroups: [] }]);
    expect(tree.bookmarks[0]!.groupId).toBe('g1');
  });

  it('迁移:v3 文件带嵌套 subgroups → 按成员证据归 local', async () => {
    const { mgr } = makeManager({
      initialBookmarks: {
        version: 3,
        groups: [
          {
            id: 'g1',
            name: '工作',
            subgroups: [{ id: 'g1-1', name: '项目A', subgroups: [] }],
          },
        ],
        paths: [{ id: 'b1', path: TEST_PATH_A, groupId: 'g1-1', addedAt: 1 }],
      } as unknown as BookmarksFile,
    });
    await mgr.initialize();
    const tree = mgr.getTree();
    expect(tree.groups).toEqual([
      {
        id: 'g1',
        name: '工作',
        kind: 'local',
        subgroups: [{ id: 'g1-1', name: '项目A', kind: 'local', subgroups: [] }],
      },
    ]);
    expect(tree.bookmarks[0]!.groupId).toBe('g1-1');
  });

  it('迁移:磁盘 groups 损坏(非数组/缺字段)→ 静默丢弃该 entry', async () => {
    const { mgr } = makeManager({
      // groups 混入脏数据(string/缺字段/空id/重复id),转 unknown 模拟脏盘加载
      initialBookmarks: {
        version: 2,
        groups: [
          { id: 'g1', name: '工作' },
          { id: '', name: '空id' }, // 空 id 丢
          { name: '缺id' }, // 缺 id 丢
          'not-an-object', // 非对象丢
          { id: 'g1', name: '重复id' }, // 重复 id 只留首个
        ],
        paths: [],
      } as unknown as BookmarksFile,
    });
    await mgr.initialize();
    const tree = mgr.getTree();
    expect(tree.groups).toEqual([{ id: 'g1', name: '工作', kind: 'local', subgroups: [] }]);
  });

  it('持久化:persistBookmarks 写 version=4 + kind + 递归 groups + path.groupId', async () => {
    const { mgr, bookmarksStore, g1, g2 } = await makeWithGroups();
    // 把 A、B 放进 g1，并给 g1 建一个子组 g1-1
    const sub = mgr.addGroup('子组', 'local', g1.id);
    mgr.reorderBookmarks({
      ungrouped: [TEST_PATH_C],
      groups: [
        { id: g1.id, childOrder: [TEST_PATH_A, TEST_PATH_B], subgroupOrder: [sub.id] },
        { id: sub.id, childOrder: [], subgroupOrder: [] },
        { id: g2.id, childOrder: [], subgroupOrder: [] },
      ],
    });
    const last = bookmarksStore.setHistory.at(-1);
    expect(last).toMatchObject({ version: 4 });
    expect(last!.groups).toContainEqual({
      id: g1.id,
      name: '工作',
      kind: 'local',
      subgroups: [{ id: sub.id, name: '子组', kind: 'local', subgroups: [] }],
    });
    const persistedA = last!.paths.find((p) => (p as { path?: string }).path === TEST_PATH_A);
    expect(persistedA).toMatchObject({ groupId: g1.id });
  });

  // ── 分层 reorder ─────────────────────────────────────────────
  it('分层 reorder:把 path 移进分组 + 调顺序 + groupId 正确', async () => {
    const { mgr, g1, g2 } = await makeWithGroups();
    mgr.reorderBookmarks({
      ungrouped: [TEST_PATH_C],
      groups: [
        { id: g1.id, childOrder: [TEST_PATH_B, TEST_PATH_A], subgroupOrder: [] },
        { id: g2.id, childOrder: [], subgroupOrder: [] },
      ],
    });
    const tree = mgr.getTree();
    // bookmarks 数组顺序 = ungrouped + 各 group childOrder 拼接
    expect(tree.bookmarks.map((b) => b.path)).toEqual([TEST_PATH_C, TEST_PATH_B, TEST_PATH_A]);
    const byPath = Object.fromEntries(tree.bookmarks.map((b) => [b.path, b]));
    expect(byPath[TEST_PATH_A]!.groupId).toBe(g1.id);
    expect(byPath[TEST_PATH_B]!.groupId).toBe(g1.id);
    expect(byPath[TEST_PATH_C]!.groupId).toBeUndefined();
  });

  it('分层 reorder:嵌套 payload 把组移进组 + 子组顺序正确', async () => {
    const { mgr, g1, g2 } = await makeWithGroups();
    mgr.reorderBookmarks({
      ungrouped: [TEST_PATH_A, TEST_PATH_B, TEST_PATH_C],
      groups: [
        { id: g1.id, childOrder: [], subgroupOrder: [g2.id] },
        { id: g2.id, childOrder: [], subgroupOrder: [] },
      ],
    });
    const tree = mgr.getTree();
    expect(tree.groups.find((g) => g.id === g1.id)!.subgroups!.map((s) => s.id)).toEqual([g2.id]);
    // g2 不再是顶层
    expect(tree.groups.map((g) => g.id)).toEqual([g1.id]);
  });

  it('分层 reorder:subgroupOrder 引用未知组 → InvalidGroupId', async () => {
    const { mgr, g1 } = await makeWithGroups();
    expect(() =>
      mgr.reorderBookmarks({
        ungrouped: [TEST_PATH_A, TEST_PATH_B, TEST_PATH_C],
        groups: [
          { id: g1.id, childOrder: [], subgroupOrder: ['ghost'] },
          { id: 'ghost', childOrder: [], subgroupOrder: [] },
        ],
      }),
    ).toThrowError(/InvalidGroupId/);
  });

  it('分层 reorder:subgroupOrder 成环 → InvalidGroupId', async () => {
    const { mgr, g1, g2 } = await makeWithGroups();
    expect(() =>
      mgr.reorderBookmarks({
        ungrouped: [TEST_PATH_A, TEST_PATH_B, TEST_PATH_C],
        groups: [
          { id: g1.id, childOrder: [], subgroupOrder: [g2.id] },
          { id: g2.id, childOrder: [], subgroupOrder: [g1.id] },
        ],
      }),
    ).toThrowError(/InvalidGroupId/);
  });

  it('分层 reorder:遗漏空组 → InvalidGroupId，原树不变', async () => {
    const { mgr, g1, g2 } = await makeWithGroups();
    expect(() =>
      mgr.reorderBookmarks({
        ungrouped: [TEST_PATH_A, TEST_PATH_B, TEST_PATH_C],
        groups: [{ id: g2.id, childOrder: [], subgroupOrder: [] }],
      }),
    ).toThrowError(/InvalidGroupId/);
    expect(mgr.getTree().groups.map((group) => group.id)).toEqual([g1.id, g2.id]);
  });

  it('分层 reorder:未知 groupId → InvalidGroupId', async () => {
    const { mgr } = await makeWithGroups();
    expect(() =>
      mgr.reorderBookmarks({
        ungrouped: [],
        groups: [{ id: 'nope', childOrder: [TEST_PATH_A], subgroupOrder: [] }],
      }),
    ).toThrowError(/InvalidGroupId/);
  });

  it('分层 reorder:遗漏某个 path → InvalidOrderList', async () => {
    const { mgr, g1, g2 } = await makeWithGroups();
    // 只排了 A,漏了 B、C
    expect(() =>
      mgr.reorderBookmarks({
        ungrouped: [TEST_PATH_A],
        groups: [
          { id: g1.id, childOrder: [], subgroupOrder: [] },
          { id: g2.id, childOrder: [], subgroupOrder: [] },
        ],
      }),
    ).toThrowError(/InvalidOrderList/);
  });

  it('分层 reorder:同一 path 在两组 → InvalidOrderList(重复)', async () => {
    const { mgr, g1, g2 } = await makeWithGroups();
    expect(() =>
      mgr.reorderBookmarks({
        ungrouped: [TEST_PATH_C],
        groups: [
          { id: g1.id, childOrder: [TEST_PATH_A], subgroupOrder: [] },
          { id: g2.id, childOrder: [TEST_PATH_A, TEST_PATH_B], subgroupOrder: [] }, // A 重复
        ],
      }),
    ).toThrowError(/InvalidOrderList/);
  });

  // ── group CRUD ───────────────────────────────────────────────
  it('addGroup:新建空组(追加末尾),返回 id;允许空组', async () => {
    const { mgr } = await makeWithGroups();
    const g = mgr.addGroup('新组', 'local');
    expect(g.id).toBeTruthy();
    expect(mgr.getTree().groups.map((x) => x.name)).toContain('新组');
    // 空组在 tree 里可见(没有子 path)
    expect(mgr.getTree().groups.at(-1)).toEqual({
      id: g.id,
      name: '新组',
      kind: 'local',
      subgroups: [],
    });
  });

  it('addGroup:parentId 指定父组 → 成为子组;未知父组 → GroupNotFound', async () => {
    const { mgr, g1 } = await makeWithGroups();
    const sub = mgr.addGroup('子组', 'local', g1.id);
    const tree = mgr.getTree();
    expect(tree.groups.map((g) => g.id)).toEqual([g1.id, expect.anything()]);
    expect(tree.groups.find((g) => g.id === g1.id)!.subgroups!.map((s) => s.id)).toEqual([sub.id]);
    expect(() => mgr.addGroup('孤儿', 'local', 'nope')).toThrowError(/GroupNotFound/);
  });

  it('addGroup:空名 / 过长 / 含分隔符 → InvalidName', async () => {
    const { mgr } = await makeWithGroups();
    expect(() => mgr.addGroup('', 'local')).toThrowError(/InvalidName/);
    expect(() => mgr.addGroup('a'.repeat(65), 'local')).toThrowError(/InvalidName/);
    expect(() => mgr.addGroup('a/b', 'local')).toThrowError(/InvalidName/);
    expect(() => mgr.addGroup('a\\b', 'local')).toThrowError(/InvalidName/);
  });

  it('addGroup:收藏内重名 → GroupNameConflict', async () => {
    const { mgr } = await makeWithGroups();
    expect(() => mgr.addGroup('工作', 'local')).toThrowError(/GroupNameConflict/);
  });

  it('renameGroup:改名成功;收藏内重名(排除自身)→ GroupNameConflict', async () => {
    const { mgr, g1 } = await makeWithGroups();
    mgr.renameGroup(g1.id, '工作改');
    expect(mgr.getTree().groups.find((x) => x.id === g1.id)!.name).toBe('工作改');
    // g1 改成与 g2 同名 → 冲突
    expect(() => mgr.renameGroup(g1.id, '个人')).toThrowError(/GroupNameConflict/);
    // 改成自己当前名 → 无操作不报错
    expect(() => mgr.renameGroup(g1.id, '工作改')).not.toThrow();
  });

  it('renameGroup:未知 id → GroupNotFound', async () => {
    const { mgr } = await makeWithGroups();
    expect(() => mgr.renameGroup('nope', 'x')).toThrowError(/GroupNotFound/);
  });

  it('removeGroup:子 path groupId 清空→归未分组,path 不丢', async () => {
    const { mgr, g1, g2 } = await makeWithGroups();
    // 先把 A、B 放进 g1
    mgr.reorderBookmarks({
      ungrouped: [TEST_PATH_C],
      groups: [
        { id: g1.id, childOrder: [TEST_PATH_A, TEST_PATH_B], subgroupOrder: [] },
        { id: g2.id, childOrder: [], subgroupOrder: [] },
      ],
    });
    mgr.removeGroup(g1.id);
    const tree = mgr.getTree();
    expect(tree.groups.find((x) => x.id === g1.id)).toBeUndefined();
    // 三条 path 都还在,且 groupId 都清空了
    expect(tree.bookmarks).toHaveLength(3);
    expect(tree.bookmarks.every((b) => b.groupId === undefined)).toBe(true);
  });

  it('removeGroup:解散嵌套组 → 子 path 提升到父组,子组提升到父级位置', async () => {
    const { mgr, g1, g2 } = await makeWithGroups();
    const sub = mgr.addGroup('子组', 'local', g1.id);
    mgr.reorderBookmarks({
      ungrouped: [],
      groups: [
        { id: g1.id, childOrder: [TEST_PATH_A], subgroupOrder: [sub.id] },
        { id: sub.id, childOrder: [TEST_PATH_B], subgroupOrder: [] },
        { id: g2.id, childOrder: [TEST_PATH_C], subgroupOrder: [] },
      ],
    });
    // 解散子组 sub:B 提升到 g1,A 留在 g1
    mgr.removeGroup(sub.id);
    const tree = mgr.getTree();
    const g1Node = tree.groups.find((g) => g.id === g1.id)!;
    expect(g1Node.subgroups).toEqual([]);
    const byPath = Object.fromEntries(tree.bookmarks.map((b) => [b.path, b]));
    expect(byPath[TEST_PATH_A]!.groupId).toBe(g1.id);
    expect(byPath[TEST_PATH_B]!.groupId).toBe(g1.id);
    expect(byPath[TEST_PATH_C]!.groupId).toBe(g2.id);
  });

  it('removeGroup:未知 id → GroupNotFound', async () => {
    const { mgr } = await makeWithGroups();
    expect(() => mgr.removeGroup('nope')).toThrowError(/GroupNotFound/);
  });

  // ── getTree 组装 ─────────────────────────────────────────────
  it('getTree:groups 顺序 = groups 数组位置;未分组 path 仍在 bookmarks(顶置由 renderer 排)', async () => {
    const { mgr, g1, g2 } = await makeWithGroups();
    mgr.reorderBookmarks({
      ungrouped: [TEST_PATH_C],
      groups: [
        { id: g2.id, childOrder: [TEST_PATH_A], subgroupOrder: [] },
        { id: g1.id, childOrder: [TEST_PATH_B], subgroupOrder: [] },
      ],
    });
    const tree = mgr.getTree();
    expect(tree.groups.map((g) => g.id)).toEqual([g2.id, g1.id]);
    expect(tree.bookmarks).toHaveLength(3);
    // getTree 返回深拷贝,改返回值不影响内部状态
    tree.groups[0]!.name = '被改';
    expect(mgr.getTree().groups[0]!.name).not.toBe('被改');
  });

  // ── replaceAll (导入) 带 groups ──────────────────────────────
  it('replaceAll:导入带 groups + path.groupId,严格校验', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.replaceAll({
      groups: [{ id: 'g1', name: '导入组', subgroups: [] }],
      bookmarks: [{ id: 'b1', path: TEST_PATH_A, kind: 'local', groupId: 'g1', addedAt: 1 }],
      recent: [],
    });
    const tree = mgr.getTree();
    expect(tree.groups).toEqual([{ id: 'g1', name: '导入组', kind: 'local', subgroups: [] }]);
    expect(tree.bookmarks[0]!.groupId).toBe('g1');
  });

  it('replaceAll:导入嵌套子组,严格校验', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.replaceAll({
      groups: [
        {
          id: 'g1',
          name: '导入组',
          subgroups: [{ id: 'g1-1', name: '子组', subgroups: [] }],
        },
      ],
      bookmarks: [{ id: 'b1', path: TEST_PATH_A, kind: 'local', groupId: 'g1-1', addedAt: 1 }],
      recent: [],
    });
    const tree = mgr.getTree();
    expect(tree.groups[0]!.subgroups!.map((s) => s.id)).toEqual(['g1-1']);
  });

  it('replaceAll:groups 含重复 id → 拒绝(内部状态保留)', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.addGroup('已存在', 'local');
    expect(() =>
      mgr.replaceAll({
        groups: [
          { id: 'dup', name: 'a' },
          { id: 'dup', name: 'b' },
        ],
        bookmarks: [],
        recent: [],
      }),
    ).toThrowError(/InvalidName/);
    // 原状态未变
    expect(mgr.getTree().groups.map((g) => g.name)).toEqual(['已存在']);
  });

  it('迁移:v3 根级空组无成员证据 → 回落 local，不再出现在 SSH 段', async () => {
    const { mgr, bookmarksStore } = makeManager({
      initialBookmarks: {
        version: 3,
        groups: [{ id: 'empty', name: '本机空组', subgroups: [] }],
        paths: [],
      } as unknown as BookmarksFile,
    });
    await mgr.initialize();
    expect(mgr.getTree().groups).toEqual([
      { id: 'empty', name: '本机空组', kind: 'local', subgroups: [] },
    ]);
    expect(bookmarksStore.setHistory.at(-1)?.version).toBe(4);
  });

  it('迁移:v3 SSH-only 组按成员证据归 ssh，空子组继承 ssh', async () => {
    const { mgr } = makeManager({
      initialBookmarks: {
        version: 3,
        groups: [
          {
            id: 'remote',
            name: '远程项目',
            subgroups: [{ id: 'remote-empty', name: '待整理', subgroups: [] }],
          },
        ],
        paths: [
          {
            id: 'b-ssh',
            path: '~/repo',
            kind: 'ssh',
            sshProfileId: 'profile-a',
            groupId: 'remote',
            addedAt: 1,
          },
        ],
      } as unknown as BookmarksFile,
    });
    await mgr.initialize();
    expect(mgr.getTree().groups).toEqual([
      {
        id: 'remote',
        name: '远程项目',
        kind: 'ssh',
        subgroups: [{ id: 'remote-empty', name: '待整理', kind: 'ssh', subgroups: [] }],
      },
    ]);
  });

  it('迁移:v3 混合组拆成 local/ssh 两个实例，并重写 SSH groupId', async () => {
    const { mgr } = makeManager({
      initialBookmarks: {
        version: 3,
        groups: [{ id: 'mixed', name: '项目', subgroups: [] }],
        paths: [
          { id: 'b-local', path: TEST_PATH_A, groupId: 'mixed', addedAt: 1 },
          {
            id: 'b-ssh',
            path: '~/repo',
            kind: 'ssh',
            sshProfileId: 'profile-a',
            groupId: 'mixed',
            addedAt: 2,
          },
        ],
      } as unknown as BookmarksFile,
    });
    await mgr.initialize();
    const tree = mgr.getTree();
    expect(tree.groups.map((group) => [group.name, group.kind])).toEqual([
      ['项目', 'local'],
      ['项目', 'ssh'],
    ]);
    const localGroup = tree.groups.find((group) => group.kind === 'local')!;
    const sshGroup = tree.groups.find((group) => group.kind === 'ssh')!;
    expect(localGroup.id).toBe('mixed');
    expect(sshGroup.id).not.toBe('mixed');
    expect(tree.bookmarks.find((bookmark) => bookmark.kind === 'local')!.groupId).toBe(
      localGroup.id,
    );
    expect(tree.bookmarks.find((bookmark) => bookmark.kind === 'ssh')!.groupId).toBe(sshGroup.id);
  });

  it('迁移:v3 嵌套 mixed 祖先按 kind 拆树，空后代继承单-kind 父组', async () => {
    const { mgr } = makeManager({
      initialBookmarks: {
        version: 3,
        groups: [
          {
            id: 'root',
            name: '全部项目',
            subgroups: [
              {
                id: 'local-child',
                name: '本机项目',
                subgroups: [{ id: 'local-empty', name: '待整理', subgroups: [] }],
              },
            ],
          },
        ],
        paths: [
          { id: 'b-local', path: TEST_PATH_A, groupId: 'local-child', addedAt: 1 },
          {
            id: 'b-ssh',
            path: '~/repo',
            kind: 'ssh',
            sshProfileId: 'profile-a',
            groupId: 'root',
            addedAt: 2,
          },
        ],
      } as unknown as BookmarksFile,
    });
    await mgr.initialize();
    const tree = mgr.getTree();
    const localRoot = tree.groups.find((group) => group.kind === 'local')!;
    const sshRoot = tree.groups.find((group) => group.kind === 'ssh')!;
    expect(localRoot.subgroups?.[0]).toMatchObject({
      id: 'local-child',
      kind: 'local',
      subgroups: [{ id: 'local-empty', name: '待整理', kind: 'local', subgroups: [] }],
    });
    expect(sshRoot.subgroups).toEqual([]);
  });

  it('迁移:v4 合法数据幂等，不产生额外写盘', async () => {
    const { mgr, bookmarksStore } = makeManager({
      initialBookmarks: {
        version: 4,
        groups: [{ id: 'g', name: '项目', kind: 'local', subgroups: [] }],
        paths: [
          {
            id: 'b',
            path: TEST_PATH_A,
            kind: 'local',
            groupId: 'g',
            addedAt: 1,
          },
        ],
      },
    });
    await mgr.initialize();
    expect(bookmarksStore.setHistory).toEqual([]);
    expect(mgr.getTree().groups[0]!.kind).toBe('local');
  });

  it('迁移:orphan groupId 清回未分组，避免收藏从 UI 消失', async () => {
    const { mgr } = makeManager({
      initialBookmarks: {
        version: 3,
        groups: [],
        paths: [{ id: 'orphan', path: TEST_PATH_A, groupId: 'missing', addedAt: 1 }],
      } as unknown as BookmarksFile,
    });
    await mgr.initialize();
    expect(mgr.getTree().bookmarks[0]!.groupId).toBeUndefined();
  });

  it('group kind:同名可跨 kind 共存；父子组与 bookmark 禁止跨 kind', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    const local = mgr.addGroup('项目', 'local');
    const ssh = mgr.addGroup('项目', 'ssh');
    expect(local.name).toBe(ssh.name);
    expect(() => mgr.addGroup('非法 kind', 'remote' as never)).toThrowError(/InvalidName/);
    expect(() => mgr.addGroup('错误子组', 'ssh', local.id)).toThrowError(/InvalidGroupId/);
    expect(() => mgr.addBookmark({ path: TEST_PATH_A, groupId: ssh.id })).toThrowError(
      /InvalidGroupId/,
    );
    expect(mgr.getTree().bookmarks).toEqual([]);
  });

  it('导入:同 kind 重名组整体拒绝；不同 kind 同名允许', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    expect(() =>
      mgr.replaceAll({
        groups: [
          { id: 'local-a', name: '项目', kind: 'local' },
          { id: 'local-b', name: '项目', kind: 'local' },
        ],
        bookmarks: [],
        recent: [],
      }),
    ).toThrowError(/GroupNameConflict/);

    mgr.replaceAll({
      groups: [
        { id: 'local', name: '项目', kind: 'local' },
        { id: 'ssh', name: '项目', kind: 'ssh' },
      ],
      bookmarks: [],
      recent: [],
    });
    expect(mgr.getTree().groups.map((group) => [group.name, group.kind])).toEqual([
      ['项目', 'local'],
      ['项目', 'ssh'],
    ]);
  });

  it('启动迁移:同 kind 重名组确定性改名，保留两个组', async () => {
    const { mgr } = makeManager({
      initialBookmarks: {
        version: 4,
        groups: [
          { id: 'a', name: '项目', kind: 'local', subgroups: [] },
          { id: 'b', name: '项目', kind: 'local', subgroups: [] },
        ],
        paths: [],
      },
    });
    await mgr.initialize();
    expect(mgr.getTree().groups.map((group) => group.name)).toEqual(['项目', '项目 (2)']);
  });

  it('reorder:同一子组被两个父组引用时拒绝，失败后原树不变', async () => {
    const { mgr, g1, g2 } = await makeWithGroups();
    const child = mgr.addGroup('子组', 'local', g1.id);
    const before = mgr.getTree();
    expect(() =>
      mgr.reorderBookmarks({
        ungrouped: [TEST_PATH_A, TEST_PATH_B, TEST_PATH_C],
        groups: [
          { id: g1.id, childOrder: [], subgroupOrder: [child.id] },
          { id: child.id, childOrder: [], subgroupOrder: [] },
          { id: g2.id, childOrder: [], subgroupOrder: [child.id] },
        ],
      }),
    ).toThrowError(/InvalidGroupId/);
    expect(mgr.getTree()).toEqual(before);
  });

  it('reorder:跨 kind 归组被拒绝，失败后 bookmarks/group 树保持原状', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.addBookmark({ path: TEST_PATH_A });
    mgr.addBookmark({
      path: '~/repo',
      kind: 'ssh',
      sshProfileId: 'profile-a',
    });
    const local = mgr.addGroup('本机', 'local');
    const ssh = mgr.addGroup('远程', 'ssh');
    const before = mgr.getTree();
    expect(() =>
      mgr.reorderBookmarks({
        ungrouped: [],
        groups: [
          { id: local.id, childOrder: ['ssh:profile-a:~%2Frepo'], subgroupOrder: [] },
          { id: ssh.id, childOrder: [TEST_PATH_A], subgroupOrder: [] },
        ],
      }),
    ).toThrowError(/InvalidGroupId/);
    expect(mgr.getTree()).toEqual(before);
  });
});

describe('PathManager — session 拖序 (Feature E.2 / 决策 #15)', () => {
  it('reorderSessions:重排某 path 下 session 顺序(内存真值)', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    // 模拟 SessionManager attach 三个 session 到同一 path
    mgr.attachSession('s1', TEST_PATH_A);
    mgr.attachSession('s2', TEST_PATH_A);
    mgr.attachSession('s3', TEST_PATH_A);
    // 初始顺序 = 插入序
    let tree = mgr.getTree();
    expect(tree.temporary[0]!.sessionIds).toEqual(['s1', 's2', 's3']);
    mgr.reorderSessions(TEST_PATH_A, ['s3', 's1', 's2']);
    tree = mgr.getTree();
    expect(tree.temporary[0]!.sessionIds).toEqual(['s3', 's1', 's2']);
  });

  it('reorderSessions:新 attach 的 session 追加到末尾(显式顺序存在时仍兼容)', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.attachSession('s1', TEST_PATH_A);
    mgr.attachSession('s2', TEST_PATH_A);
    mgr.reorderSessions(TEST_PATH_A, ['s2', 's1']);
    // 再 attach 一个 —— 显式顺序里没有它,走插入序兼底:过滤后剩 [s2,s1],新 s3 追加末尾
    mgr.attachSession('s3', TEST_PATH_A);
    expect(mgr.getTree().temporary[0]!.sessionIds).toEqual(['s2', 's1', 's3']);
  });

  it('reorderSessions:数量不匹配 → InvalidOrderList', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.attachSession('s1', TEST_PATH_A);
    mgr.attachSession('s2', TEST_PATH_A);
    expect(() => mgr.reorderSessions(TEST_PATH_A, ['s1'])).toThrowError(/InvalidOrderList/);
  });

  it('reorderSessions:未知 sessionId → InvalidOrderList', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.attachSession('s1', TEST_PATH_A);
    expect(() => mgr.reorderSessions(TEST_PATH_A, ['s1', 'ghost'])).toThrowError(
      /InvalidOrderList/,
    );
  });

  it('reorderSessions:重复 sessionId → InvalidOrderList', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.attachSession('s1', TEST_PATH_A);
    mgr.attachSession('s2', TEST_PATH_A);
    expect(() => mgr.reorderSessions(TEST_PATH_A, ['s1', 's1'])).toThrowError(/InvalidOrderList/);
  });

  it('detachSession:从显式顺序里剔除该 session;空了删 entry', async () => {
    const { mgr } = makeManager();
    await mgr.initialize();
    mgr.attachSession('s1', TEST_PATH_A);
    mgr.attachSession('s2', TEST_PATH_A);
    mgr.reorderSessions(TEST_PATH_A, ['s2', 's1']);
    mgr.detachSession('s2');
    expect(mgr.getTree().temporary[0]!.sessionIds).toEqual(['s1']);
  });
});
