/**
 * @file src/main/path-manager.ts
 * @purpose 管理路径的三栏分类 (收藏 / 临时 / 最近) 与 Path 状态机。
 *
 * @关键设计:
 * - Path 状态机 (软件定义书 8.2):
 *     最近 ↔ 临时 (有/无终端在跑)
 *     最近/临时 → 收藏 (用户主动加入)
 *     收藏 → 最近 (用户移除收藏)
 * - 同一 path 任意时刻只属于一个分类 (优先级:收藏 > 临时 > 最近)
 * - "最近"分类容量上限 30,按 lastUsedAt 降序,自动淘汰最旧
 * - PathNode.id 使用 normalize 后的绝对路径字符串本身,稳定且不需要
 *   额外 ID 映射;Bookmark 内部仍有 UUID 用于持久化记账,但对 renderer
 *   不可见
 * - 任何变化触发 emit('pathTreeUpdated'),IPC 层负责广播 + throttle
 *
 * @对应文档章节: 软件定义书.md 第 4 (心智模型)、5.1.1、8.2、11.1
 *
 * @不要在这里做的事:
 * - 不直接读写磁盘 (通过 PersistenceManager / JsonStore)
 * - 不持有 Session 实例 (SessionManager 管 Session 生命周期,这里只
 *   通过 attachSession/detachSession 维护 sessionId → path 的映射)
 *
 * @AGENTS.md 5.3 必测: Path 状态机所有转移、容量限制、增删改查并发。
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { resolve, sep } from 'node:path';
import type {
  Bookmark,
  BookmarksFile,
  PathNode,
  PathTree,
  RecentEntry,
  RecentFile,
} from '@shared/types';
import type { JsonStore } from './persistence';

const RECENT_CAPACITY = 30;

const DEFAULT_BOOKMARKS_FILE: BookmarksFile = { version: 1, paths: [] };
const DEFAULT_RECENT_FILE: RecentFile = { version: 1, paths: [] };

/**
 * 把任意路径输入规范化为稳定 id。
 * - 转绝对路径
 * - Windows: 卷符大写
 * - 移除 trailing separator,但根路径保留 (Windows "C:\" / POSIX "/")
 *
 * 同一物理路径在内存中始终得到相同 id,无需额外的 path → id 映射表。
 */
export function normalizePath(input: string): string {
  let n = resolve(input);
  if (process.platform === 'win32' && /^[a-z]:/.test(n)) {
    n = n[0]!.toUpperCase() + n.slice(1);
  }
  if (!isRootPath(n) && n.endsWith(sep)) {
    n = n.slice(0, -1);
  }
  return n;
}

/**
 * 判断是否文件系统根路径。
 * - Windows: "C:\\" / "D:\\" 等 (drive letter + colon + sep)
 * - POSIX: "/"
 */
function isRootPath(p: string): boolean {
  if (process.platform === 'win32') {
    return /^[A-Za-z]:\\$/.test(p);
  }
  return p === '/';
}

export interface PathManagerEvents {
  pathTreeUpdated: (tree: PathTree) => void;
  bookmarksUpdated: (bookmarks: Bookmark[]) => void;
}

/**
 * 错误类型,与 ipc-protocol.md 7 的错误码对齐。
 */
export class PathManagerError extends Error {
  constructor(
    public readonly code:
      | 'PathNotExist'
      | 'PathNotDirectory'
      | 'BookmarkAlreadyExists'
      | 'BookmarkNotFound'
      | 'PathNotInRecent'
      | 'InvalidOrderList'
      | 'InvalidName',
    message: string,
  ) {
    super(`[PathManager] ${code}: ${message}`);
    this.name = 'PathManagerError';
  }
}

export class PathManager extends EventEmitter {
  /**
   * sessionId → 该 session 当前归属的 (normalized) path。
   * SessionManager 在 attachSession / detachSession 时调用此处更新。
   * 临时分类完全从这个 Map 推导。
   */
  private readonly sessionToPath = new Map<string, string>();

  /**
   * 在内存中始终保持 bookmarks 数组的最新状态;JsonStore 异步落盘。
   * 数组顺序 = UI 显示顺序。
   */
  private bookmarks: Bookmark[] = [];

  /**
   * recent,按 lastUsedAt 降序;最大 RECENT_CAPACITY 项。
   */
  private recent: RecentEntry[] = [];

  constructor(
    private readonly bookmarksStore: JsonStore<BookmarksFile>,
    private readonly recentStore: JsonStore<RecentFile>,
  ) {
    super();
  }

  /**
   * 从持久化加载初始数据。在 Main 启动时调用一次。
   */
  async initialize(): Promise<void> {
    const bk = await this.bookmarksStore.load(DEFAULT_BOOKMARKS_FILE);
    const rc = await this.recentStore.load(DEFAULT_RECENT_FILE);
    this.bookmarks = bk.value.paths.slice();
    this.recent = rc.value.paths.slice();
    this.sortRecent();
  }

  /**
   * 等所有待写入落盘 (在应用退出前调)。
   */
  async flush(): Promise<void> {
    await this.bookmarksStore.flush();
    await this.recentStore.flush();
  }

  // ──────────────────────────────────────────────────────────────────
  // Bookmark CRUD
  // ──────────────────────────────────────────────────────────────────

  /**
   * 添加收藏。
   *
   * @throws PathManagerError BookmarkAlreadyExists 该路径已是收藏
   */
  addBookmark(input: {
    path: string;
    displayName?: string;
    defaultTemplateId?: string;
  }): Bookmark {
    const normalized = normalizePath(input.path);
    if (this.findBookmarkByPath(normalized)) {
      throw new PathManagerError('BookmarkAlreadyExists', `path="${normalized}" 已收藏`);
    }
    const bookmark: Bookmark = {
      id: randomUUID(),
      path: normalized,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.defaultTemplateId ? { defaultTemplateId: input.defaultTemplateId } : {}),
      addedAt: Date.now(),
    };
    this.bookmarks.push(bookmark);
    // 收藏后,该路径自动从 recent 中移出 (避免重复出现)
    this.removeRecentInternal(normalized);
    this.persistBookmarks();
    this.persistRecent();
    this.emitChange();
    return bookmark;
  }

  /**
   * 移除收藏。若该路径当前有 session,会自动出现在临时;否则进入最近。
   *
   * @throws PathManagerError BookmarkNotFound
   */
  removeBookmark(pathId: string): void {
    const normalized = normalizePath(pathId);
    const idx = this.bookmarks.findIndex((b) => b.path === normalized);
    if (idx < 0) {
      throw new PathManagerError('BookmarkNotFound', `pathId="${pathId}" 不在收藏`);
    }
    this.bookmarks.splice(idx, 1);
    // 移除收藏后,如果路径没有 session 在跑,要进入最近;有的话进入临时 (自动)
    if (!this.hasSessionsForPath(normalized)) {
      this.touchRecent(normalized); // 移到最近
    }
    this.persistBookmarks();
    this.persistRecent();
    this.emitChange();
  }

  /**
   * 重命名收藏的显示名。空字符串视为恢复默认 (清掉 displayName)。
   *
   * @throws PathManagerError BookmarkNotFound / InvalidName
   */
  renameBookmark(pathId: string, newDisplayName: string): void {
    if (typeof newDisplayName !== 'string' || newDisplayName.length > 100) {
      throw new PathManagerError(
        'InvalidName',
        `displayName 必须是 string 且长度 <= 100,实际: ${
          typeof newDisplayName
        } len=${newDisplayName?.length}`,
      );
    }
    const normalized = normalizePath(pathId);
    const bookmark = this.findBookmarkByPath(normalized);
    if (!bookmark) {
      throw new PathManagerError('BookmarkNotFound', `pathId="${pathId}"`);
    }
    if (newDisplayName === '') {
      delete bookmark.displayName;
    } else {
      bookmark.displayName = newDisplayName;
    }
    this.persistBookmarks();
    this.emitChange();
  }

  /**
   * 调整收藏顺序。orderedPathIds 必须包含且只包含当前所有 bookmark 的 path id。
   *
   * @throws PathManagerError InvalidOrderList
   */
  reorderBookmarks(orderedPathIds: string[]): void {
    const normalized = orderedPathIds.map(normalizePath);
    if (normalized.length !== this.bookmarks.length) {
      throw new PathManagerError(
        'InvalidOrderList',
        `预期 ${this.bookmarks.length} 项,实际 ${normalized.length} 项`,
      );
    }
    const seen = new Set<string>();
    const next: Bookmark[] = [];
    for (const id of normalized) {
      if (seen.has(id)) {
        throw new PathManagerError('InvalidOrderList', `重复的 pathId="${id}"`);
      }
      seen.add(id);
      const found = this.findBookmarkByPath(id);
      if (!found) {
        throw new PathManagerError(
          'InvalidOrderList',
          `pathId="${id}" 不在当前 bookmarks 列表`,
        );
      }
      next.push(found);
    }
    this.bookmarks = next;
    this.persistBookmarks();
    this.emitChange();
  }

  /**
   * 设置某收藏路径的默认启动模板;templateId=null 清除该字段。
   *
   * @throws PathManagerError BookmarkNotFound
   */
  setDefaultTemplate(pathId: string, templateId: string | null): void {
    const normalized = normalizePath(pathId);
    const bookmark = this.findBookmarkByPath(normalized);
    if (!bookmark) {
      throw new PathManagerError('BookmarkNotFound', `pathId="${pathId}"`);
    }
    if (templateId === null) {
      delete bookmark.defaultTemplateId;
    } else {
      bookmark.defaultTemplateId = templateId;
    }
    this.persistBookmarks();
    this.emitChange();
  }

  // ──────────────────────────────────────────────────────────────────
  // Recent CRUD
  // ──────────────────────────────────────────────────────────────────

  /**
   * 从最近列表移除。常用场景:用户右键"从最近移除"。
   *
   * @throws PathManagerError PathNotInRecent
   */
  removeFromRecent(input: string): void {
    const normalized = normalizePath(input);
    const idx = this.recent.findIndex((r) => normalizePath(r.path) === normalized);
    if (idx < 0) {
      throw new PathManagerError('PathNotInRecent', `path="${input}" 不在最近列表`);
    }
    this.recent.splice(idx, 1);
    this.persistRecent();
    this.emitChange();
  }

  // ──────────────────────────────────────────────────────────────────
  // Session attach / detach (由 SessionManager 调用)
  // ──────────────────────────────────────────────────────────────────

  /**
   * 把 sessionId attach 到指定 path,触发 path 状态机:
   * - 若 path 不在收藏 → 自动进入临时
   * - 若 path 在最近 → 从最近移除 (因为它要去临时了)
   *
   * v1.2 起 (ADR-008):session.pathId 创建后永不变,本方法对每个 sessionId
   * 只会被调一次。"先 detach 再 attach" 的旧逻辑保留为防御代码,正常路径
   * 不会触发。
   */
  attachSession(sessionId: string, path: string): void {
    const normalized = normalizePath(path);
    const previousPath = this.sessionToPath.get(sessionId);
    if (previousPath === normalized) return; // 无变化 (重复调用)
    if (previousPath !== undefined) {
      // 防御:理论上 ADR-008 后不会到这。若到了,说明上层有 bug,记一条 warn。
      console.warn(
        `[PathManager] attachSession 不一致: sessionId="${sessionId}" 旧 path="${previousPath}" 新 path="${normalized}"。` +
          `ADR-008 之后 session.pathId 应永久不变,这是 bug。`,
      );
      this.detachSessionInternal(sessionId, /* emit */ false);
    }
    this.sessionToPath.set(sessionId, normalized);
    // 如果新 path 之前在最近列表,移除 (它现在在临时了)
    this.removeRecentInternal(normalized);
    this.touchRecentTimestamp(normalized); // 更新 useCount/lastUsedAt 以便后来回到最近时排序正确
    this.persistRecent();
    this.emitChange();
  }

  /**
   * 把 sessionId 从 path 上 detach。如果是该 path 最后一个 session 且 path
   * 不在收藏,该 path 离开临时,进入最近。
   */
  detachSession(sessionId: string): void {
    this.detachSessionInternal(sessionId, /* emit */ true);
  }

  private detachSessionInternal(sessionId: string, emit: boolean): void {
    const path = this.sessionToPath.get(sessionId);
    if (path === undefined) return;
    this.sessionToPath.delete(sessionId);

    // 如果该 path 没有其他 session 且不在收藏,进入最近
    if (!this.hasSessionsForPath(path) && !this.findBookmarkByPath(path)) {
      this.touchRecent(path);
      this.persistRecent();
    }
    if (emit) this.emitChange();
  }

  // ──────────────────────────────────────────────────────────────────
  // 树查询 (给 IPC snapshot / 广播用)
  // ──────────────────────────────────────────────────────────────────

  /**
   * 获取完整 PathTree,三个分类无重叠 (优先级:收藏 > 临时 > 最近)。
   */
  getTree(): PathTree {
    const bookmarkPaths = new Set(this.bookmarks.map((b) => b.path));
    const sessionPaths = new Set(this.sessionToPath.values());

    const bookmarks: PathNode[] = this.bookmarks.map((b) => ({
      id: b.path,
      path: b.path,
      ...(b.displayName ? { displayName: b.displayName } : {}),
      category: 'bookmarked',
      sessionIds: this.sessionsForPath(b.path),
      ...(b.defaultTemplateId ? { defaultTemplateId: b.defaultTemplateId } : {}),
    }));

    const temporary: PathNode[] = [...sessionPaths]
      .filter((p) => !bookmarkPaths.has(p))
      .map((p) => ({
        id: p,
        path: p,
        category: 'temporary' as const,
        sessionIds: this.sessionsForPath(p),
      }));

    const recent: PathNode[] = this.recent
      .filter((r) => {
        const n = normalizePath(r.path);
        return !bookmarkPaths.has(n) && !sessionPaths.has(n);
      })
      .map((r) => ({
        id: normalizePath(r.path),
        path: normalizePath(r.path),
        category: 'recent' as const,
        sessionIds: [],
      }));

    return { bookmarks, temporary, recent };
  }

  /**
   * 测试 / 调试用:列出当前所有 bookmarks 的浅拷贝。
   */
  listBookmarks(): Bookmark[] {
    return this.bookmarks.map((b) => ({ ...b }));
  }

  /**
   * 测试 / 调试用:列出当前 recent 的浅拷贝。
   */
  listRecent(): RecentEntry[] {
    return this.recent.map((r) => ({ ...r }));
  }

  /**
   * 给 SessionManager 用:某 sessionId 当前在哪个 path。
   */
  getPathForSession(sessionId: string): string | undefined {
    return this.sessionToPath.get(sessionId);
  }

  // ──────────────────────────────────────────────────────────────────
  // 内部帮助
  // ──────────────────────────────────────────────────────────────────

  private findBookmarkByPath(normalizedPath: string): Bookmark | undefined {
    return this.bookmarks.find((b) => b.path === normalizedPath);
  }

  private sessionsForPath(normalizedPath: string): string[] {
    const result: string[] = [];
    for (const [sid, p] of this.sessionToPath.entries()) {
      if (p === normalizedPath) result.push(sid);
    }
    return result;
  }

  private hasSessionsForPath(normalizedPath: string): boolean {
    for (const p of this.sessionToPath.values()) {
      if (p === normalizedPath) return true;
    }
    return false;
  }

  /**
   * 把路径加入最近 (或更新已有的时间戳)。容量上限 30,按 lastUsedAt 降序。
   */
  private touchRecent(rawPath: string): void {
    const normalized = normalizePath(rawPath);
    this.touchRecentTimestamp(normalized);
    this.sortRecent();
    this.trimRecent();
  }

  private touchRecentTimestamp(normalizedPath: string): void {
    const existing = this.recent.find((r) => normalizePath(r.path) === normalizedPath);
    if (existing) {
      existing.lastUsedAt = Date.now();
      existing.useCount++;
    } else {
      this.recent.unshift({
        path: normalizedPath,
        lastUsedAt: Date.now(),
        useCount: 1,
      });
    }
  }

  private removeRecentInternal(normalizedPath: string): void {
    const idx = this.recent.findIndex((r) => normalizePath(r.path) === normalizedPath);
    if (idx >= 0) {
      this.recent.splice(idx, 1);
    }
  }

  private sortRecent(): void {
    this.recent.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  private trimRecent(): void {
    if (this.recent.length > RECENT_CAPACITY) {
      this.recent = this.recent.slice(0, RECENT_CAPACITY);
    }
  }

  private persistBookmarks(): void {
    this.bookmarksStore.set({ version: 1, paths: this.bookmarks.slice() });
  }

  private persistRecent(): void {
    this.recentStore.set({ version: 1, paths: this.recent.slice() });
  }

  private emitChange(): void {
    this.emit('pathTreeUpdated', this.getTree());
    this.emit('bookmarksUpdated', this.listBookmarks());
  }

  /**
   * CP-4 勘误 #12:整体替换 bookmarks + recent (用于设置导入)。
   * 替代"写盘后 app.relaunch"模式 — 直接 in-memory 替换并 emit,renderer
   * 通过 evt:path:tree-updated / evt:bookmarks:updated 即时刷新,无需重启。
   *
   * @param input.bookmarks 新的收藏列表 (顺序保留)
   * @param input.recent 新的最近列表 (按当前数组顺序;内部仍会再 sortRecent)
   */
  replaceAll(input: { bookmarks: Bookmark[]; recent: RecentEntry[] }): void {
    this.bookmarks = input.bookmarks.slice();
    this.recent = input.recent.slice();
    this.sortRecent();
    this.persistBookmarks();
    this.persistRecent();
    this.emitChange();
  }
}
