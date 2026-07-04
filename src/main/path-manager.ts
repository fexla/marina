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
  PathKind,
  PathNode,
  PathTree,
  RecentEntry,
  RecentFile,
} from '@shared/types';
import { normalizeRemotePath } from '@shared/remote-path';
import type { JsonStore } from './persistence';
import { logger } from './logger';

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

export interface PathRef {
  kind: PathKind;
  path: string;
  sshProfileId?: string;
}

export function makePathId(ref: PathRef): string {
  if (ref.kind === 'ssh') {
    if (!ref.sshProfileId) {
      throw new PathManagerError('InvalidName', 'ssh path 缺少 sshProfileId');
    }
    return `ssh:${encodeURIComponent(ref.sshProfileId)}:${encodeURIComponent(normalizeRemotePath(ref.path))}`;
  }
  return normalizePath(ref.path);
}

export function pathRefFromId(idOrPath: string): PathRef {
  if (idOrPath.startsWith('ssh:')) {
    const parts = idOrPath.split(':');
    if (parts.length >= 3 && parts[1]) {
      return {
        kind: 'ssh',
        sshProfileId: decodeURIComponent(parts[1]!),
        path: normalizeRemotePath(decodeURIComponent(parts.slice(2).join(':'))),
      };
    }
  }
  return { kind: 'local', path: normalizePath(idOrPath) };
}

function normalizePathRef(input: string | PathRef): PathRef {
  if (typeof input === 'string') return pathRefFromId(input);
  if (input.kind === 'ssh') {
    if (!input.sshProfileId) {
      throw new PathManagerError('InvalidName', 'ssh path 缺少 sshProfileId');
    }
    return {
      kind: 'ssh',
      sshProfileId: input.sshProfileId,
      path: normalizeRemotePath(input.path),
    };
  }
  return { kind: 'local', path: normalizePath(input.path) };
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

  /**
   * BETA-043:启动期扫描发现的"不可访问"路径集合(normalized)。
   * getTree() 用于把对应 PathNode 标 invalid。bootstrap 启动末尾填一次,
   * 不做后台周期扫(资源考虑)。
   */
  private invalidPaths = new Set<string>();

  constructor(
    private readonly bookmarksStore: JsonStore<BookmarksFile>,
    private readonly recentStore: JsonStore<RecentFile>,
  ) {
    super();
  }

  /**
   * 从持久化加载初始数据。在 Main 启动时调用一次。
   *
   * 返回 bookmarks.json 的加载来源:'main' / 'bak' / 'default'。
   * bootstrap 用 'default' 判定干净安装,继而种入 PlatformAdapter 提供的
   * 默认收藏(桌面 / 主目录)。
   */
  async initialize(): Promise<{ bookmarksSource: 'main' | 'bak' | 'default' }> {
    const bk = await this.bookmarksStore.load(DEFAULT_BOOKMARKS_FILE);
    const rc = await this.recentStore.load(DEFAULT_RECENT_FILE);
    // v2.1 §II.1:把磁盘上的旧 schema(kind 缺失 / ssh 但 sshProfileId 缺失)
    // 在内存层 coerce 成新 discriminated union。损坏条目静默丢弃,与旧
    // validateBookmarksArray "整体拒绝" 不同 —— 启动期不能因为一条坏数据
    // 让用户进不来 Marina。
    this.bookmarks = bk.value.paths.flatMap(migrateBookmarkOnLoad);
    this.recent = rc.value.paths.flatMap(migrateRecentOnLoad);
    this.sortRecent();
    return { bookmarksSource: bk.source };
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
    kind?: PathKind;
    sshProfileId?: string;
    displayName?: string;
    defaultTemplateId?: string;
  }): Bookmark {
    const ref = normalizePathRef({
      kind: input.kind ?? 'local',
      path: input.path,
      ...(input.sshProfileId ? { sshProfileId: input.sshProfileId } : {}),
    });
    const id = makePathId(ref);
    if (this.findBookmarkByPath(id)) {
      throw new PathManagerError('BookmarkAlreadyExists', `path="${id}" 已收藏`);
    }
    const bookmark = buildBookmark({
      id: randomUUID(),
      ref,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.defaultTemplateId ? { defaultTemplateId: input.defaultTemplateId } : {}),
      addedAt: Date.now(),
    });
    this.bookmarks.push(bookmark);
    // 收藏后,该路径自动从 recent 中移出 (避免重复出现)
    this.removeRecentInternal(id);
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
    const id = makePathId(pathRefFromId(pathId));
    const idx = this.bookmarks.findIndex((b) => bookmarkPathId(b) === id);
    if (idx < 0) {
      throw new PathManagerError('BookmarkNotFound', `pathId="${pathId}" 不在收藏`);
    }
    const removed = this.bookmarks[idx]!;
    this.bookmarks.splice(idx, 1);
    // 移除收藏后,如果路径没有 session 在跑,要进入最近;有的话进入临时 (自动)
    if (!this.hasSessionsForPath(id)) {
      this.touchRecent(pathRefFromBookmark(removed)); // 移到最近
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
    const id = makePathId(pathRefFromId(pathId));
    const bookmark = this.findBookmarkByPath(id);
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
    const normalized = orderedPathIds.map((id) => makePathId(pathRefFromId(id)));
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
    const id = makePathId(pathRefFromId(pathId));
    const bookmark = this.findBookmarkByPath(id);
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
    const id = makePathId(pathRefFromId(input));
    const idx = this.recent.findIndex((r) => recentPathId(r) === id);
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
    const id = makePathId(pathRefFromId(path));
    const ref = pathRefFromId(id);
    const previousPath = this.sessionToPath.get(sessionId);
    if (previousPath === id) return; // 无变化 (重复调用)
    if (previousPath !== undefined) {
      // 防御:理论上 ADR-008 后不会到这。若到了,说明上层有 bug,记一条 warn。
      logger.warn(
        'PathManager',
        `attachSession 不一致: sessionId="${sessionId}" 旧 path="${previousPath}" 新 path="${id}"。` +
          `ADR-008 之后 session.pathId 应永久不变,这是 bug。`,
      );
      this.detachSessionInternal(sessionId, /* emit */ false);
    }
    this.sessionToPath.set(sessionId, id);
    // STM-3:不再 removeRecentInternal — 旧写法先删后 unshift 会把已有 entry 的
    // useCount 重置为 1,daily-driver "开终端 → 关终端 → 开终端" 循环下,useCount
    // 永远在 1↔2 之间震荡而不真实累加。新写法:只 touch(存在则 ++,不存在则新建),
    // 让 useCount 真实记录使用次数。getTree() 已经按 sessionPaths 过滤,recent
    // 数组里"暂时归在临时分类"的 entry 不会重复显示,无需先 remove。
    this.touchRecentTimestamp(ref);
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
      this.touchRecent(pathRefFromId(path));
      this.persistRecent();
    }
    if (emit) this.emitChange();
  }

  // ──────────────────────────────────────────────────────────────────
  // 树查询 (给 IPC snapshot / 广播用)
  // ──────────────────────────────────────────────────────────────────

  /**
   * 获取完整 PathTree,三个分类无重叠(优先级:收藏 > 临时 > 最近)。
   *
   * BETA-043:invalidPaths 集合里的路径会被标 invalid: true。
   */
  getTree(): PathTree {
    const bookmarkPaths = new Set(this.bookmarks.map(bookmarkPathId));
    const sessionPaths = new Set(this.sessionToPath.values());
    const markInvalid = (id: string): { invalid?: true } =>
      this.invalidPaths.has(id) ? { invalid: true } : {};

    const bookmarks: PathNode[] = this.bookmarks.map((b) => {
      const id = bookmarkPathId(b);
      return buildPathNode({
        id,
        ref: pathRefFromBookmark(b),
        category: 'bookmarked',
        sessionIds: this.sessionsForPath(id),
        ...(b.displayName ? { displayName: b.displayName } : {}),
        ...(b.defaultTemplateId ? { defaultTemplateId: b.defaultTemplateId } : {}),
        ...markInvalid(id),
      });
    });

    const temporary: PathNode[] = [...sessionPaths]
      .filter((p) => !bookmarkPaths.has(p))
      .map((p) => {
        const ref = pathRefFromId(p);
        return buildPathNode({
          id: p,
          ref,
          category: 'temporary',
          sessionIds: this.sessionsForPath(p),
          ...markInvalid(p),
        });
      });

    const recent: PathNode[] = this.recent
      .filter((r) => {
        const n = recentPathId(r);
        return !bookmarkPaths.has(n) && !sessionPaths.has(n);
      })
      .map((r) => {
        const id = recentPathId(r);
        return buildPathNode({
          id,
          ref: pathRefFromRecent(r),
          category: 'recent',
          sessionIds: [],
          ...markInvalid(id),
        });
      });

    return { bookmarks, temporary, recent };
  }

  /**
   * BETA-043:批量标记一组路径为不可访问。bootstrap 启动末尾扫描后调用一次。
   * 调用会触发 pathTreeUpdated。
   */
  setInvalidPaths(normalizedPaths: Iterable<string>): void {
    this.invalidPaths = new Set();
    for (const p of normalizedPaths) {
      this.invalidPaths.add(makePathId(pathRefFromId(p)));
    }
    this.emit('pathTreeUpdated', this.getTree());
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

  hasSshProfileReferences(profileId: string): boolean {
    const isMatch = (kind: PathKind, sshProfileId: string | undefined): boolean =>
      kind === 'ssh' && sshProfileId === profileId;
    return (
      this.bookmarks.some((b) =>
        b.kind === 'ssh' ? isMatch(b.kind, b.sshProfileId) : false,
      ) ||
      this.recent.some((r) =>
        r.kind === 'ssh' ? isMatch(r.kind, r.sshProfileId) : false,
      ) ||
      [...this.sessionToPath.values()].some((id) => {
        const ref = pathRefFromId(id);
        return ref.kind === 'ssh' && ref.sshProfileId === profileId;
      })
    );
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
    return this.bookmarks.find((b) => bookmarkPathId(b) === normalizedPath);
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
  private touchRecent(rawPath: string | PathRef): void {
    const ref = normalizePathRef(rawPath);
    this.touchRecentTimestamp(ref);
    this.sortRecent();
    this.trimRecent();
  }

  private touchRecentTimestamp(ref: PathRef): void {
    const id = makePathId(ref);
    const existing = this.recent.find((r) => recentPathId(r) === id);
    if (existing) {
      existing.lastUsedAt = Date.now();
      existing.useCount++;
    } else {
      this.recent.unshift(
        buildRecentEntry({ ref, lastUsedAt: Date.now(), useCount: 1 }),
      );
    }
  }

  private removeRecentInternal(normalizedPath: string): void {
    const idx = this.recent.findIndex((r) => recentPathId(r) === normalizedPath);
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
   * TYP-2 / SEC-4(v1.3):入参视为「外部不可信数据」(用户导入的 JSON 归档
   * 可能跨版本、可能损坏、可能含 path traversal 段)。先 type guard 把每条
   * entry 的形状校验一遍,再把 path 字段统一 normalize。任一条违规 → 抛
   * PathManagerError,**不**部分应用(原状态保留)。
   *
   * 不做存在性校验(addBookmark 也只在 path 存在时才接受,但 import 场景
   * 用户的 bookmark 路径可能临时不可达 — 比如插了 U 盘后又拔了。这种是
   * 用户数据,留着就好,使用时再校验)。
   *
   * @param input.bookmarks 新的收藏列表 (顺序保留)
   * @param input.recent 新的最近列表 (按当前数组顺序;内部仍会再 sortRecent)
   * @throws PathManagerError('InvalidName') 任一 entry 形状不合规
   */
  replaceAll(input: { bookmarks: unknown; recent: unknown }): void {
    // 入参视为外部不可信(导入归档可能跨版本 / kind 缺失 / sshProfileId 缺失);
    // validateBookmarksArray / validateRecentArray 做严格 narrow + path normalize。
    const bookmarks = validateBookmarksArray(input.bookmarks);
    const recent = validateRecentArray(input.recent);
    this.bookmarks = bookmarks;
    this.recent = recent;
    this.sortRecent();
    this.persistBookmarks();
    this.persistRecent();
    this.emitChange();
  }
}

/**
 * TYP-2 / SEC-4:Bookmark 数组形状校验 + path normalize。
 *
 * 必需字段:`id: string` / `path: string` / `addedAt: number`
 * 可选字段:`displayName?: string` / `defaultTemplateId?: string`
 *
 * 任一条违规(类型不符 / 必需字段缺失 / 不是对象)整体拒绝,抛
 * PathManagerError。caller(ipc.ts applyArchiveInMemory)捕获后让 import
 * 失败,内部状态保留。
 */
function validateBookmarksArray(input: unknown): Bookmark[] {
  if (!Array.isArray(input)) {
    throw new PathManagerError('InvalidName', 'bookmarks 必须是数组');
  }
  const out: Bookmark[] = [];
  for (let i = 0; i < input.length; i++) {
    const b = input[i];
    if (typeof b !== 'object' || b === null) {
      throw new PathManagerError('InvalidName', `bookmarks[${i}] 不是对象`);
    }
    const r = b as Record<string, unknown>;
    if (typeof r['id'] !== 'string' || !r['id']) {
      throw new PathManagerError('InvalidName', `bookmarks[${i}].id 非法`);
    }
    if (typeof r['path'] !== 'string' || !r['path']) {
      throw new PathManagerError('InvalidName', `bookmarks[${i}].path 非法`);
    }
    if (typeof r['addedAt'] !== 'number' || !Number.isFinite(r['addedAt'])) {
      throw new PathManagerError('InvalidName', `bookmarks[${i}].addedAt 非法`);
    }
    if (r['displayName'] !== undefined && typeof r['displayName'] !== 'string') {
      throw new PathManagerError('InvalidName', `bookmarks[${i}].displayName 非法`);
    }
    if (r['defaultTemplateId'] !== undefined && typeof r['defaultTemplateId'] !== 'string') {
      throw new PathManagerError('InvalidName', `bookmarks[${i}].defaultTemplateId 非法`);
    }
    const kind: PathKind = r['kind'] === 'ssh' ? 'ssh' : 'local';
    const sshProfileId =
      typeof r['sshProfileId'] === 'string' ? r['sshProfileId'] : undefined;
    if (kind === 'ssh' && !sshProfileId) {
      throw new PathManagerError(
        'InvalidName',
        `bookmarks[${i}] kind="ssh" 但缺少 sshProfileId`,
      );
    }
    const ref = normalizePathRef({
      kind,
      path: r['path'],
      ...(sshProfileId ? { sshProfileId } : {}),
    });
    out.push(
      buildBookmark({
        id: r['id'],
        ref,
        addedAt: r['addedAt'],
        ...(typeof r['displayName'] === 'string' ? { displayName: r['displayName'] } : {}),
        ...(typeof r['defaultTemplateId'] === 'string'
          ? { defaultTemplateId: r['defaultTemplateId'] }
          : {}),
      }),
    );
  }
  return out;
}

/**
 * RecentEntry 数组形状校验 + path normalize。
 *
 * 必需字段:`path: string` / `lastUsedAt: number` / `useCount: number`
 */
function validateRecentArray(input: unknown): RecentEntry[] {
  if (!Array.isArray(input)) {
    throw new PathManagerError('InvalidName', 'recent 必须是数组');
  }
  const out: RecentEntry[] = [];
  for (let i = 0; i < input.length; i++) {
    const r = input[i];
    if (typeof r !== 'object' || r === null) {
      throw new PathManagerError('InvalidName', `recent[${i}] 不是对象`);
    }
    const o = r as Record<string, unknown>;
    if (typeof o['path'] !== 'string' || !o['path']) {
      throw new PathManagerError('InvalidName', `recent[${i}].path 非法`);
    }
    if (typeof o['lastUsedAt'] !== 'number' || !Number.isFinite(o['lastUsedAt'])) {
      throw new PathManagerError('InvalidName', `recent[${i}].lastUsedAt 非法`);
    }
    if (typeof o['useCount'] !== 'number' || !Number.isFinite(o['useCount'])) {
      throw new PathManagerError('InvalidName', `recent[${i}].useCount 非法`);
    }
    const kind: PathKind = o['kind'] === 'ssh' ? 'ssh' : 'local';
    const sshProfileId =
      typeof o['sshProfileId'] === 'string' ? o['sshProfileId'] : undefined;
    if (kind === 'ssh' && !sshProfileId) {
      throw new PathManagerError(
        'InvalidName',
        `recent[${i}] kind="ssh" 但缺少 sshProfileId`,
      );
    }
    const ref = normalizePathRef({
      kind,
      path: o['path'],
      ...(sshProfileId ? { sshProfileId } : {}),
    });
    out.push(
      buildRecentEntry({ ref, lastUsedAt: o['lastUsedAt'], useCount: o['useCount'] }),
    );
  }
  return out;
}

function bookmarkPathId(bookmark: Bookmark): string {
  return makePathId(pathRefFromBookmark(bookmark));
}

function recentPathId(recent: RecentEntry): string {
  return makePathId(pathRefFromRecent(recent));
}

function pathRefFromBookmark(bookmark: Bookmark): PathRef {
  switch (bookmark.kind) {
    case 'local':
      return { kind: 'local', path: normalizePath(bookmark.path) };
    case 'ssh':
      return {
        kind: 'ssh',
        sshProfileId: bookmark.sshProfileId,
        path: normalizeRemotePath(bookmark.path),
      };
  }
}

function pathRefFromRecent(recent: RecentEntry): PathRef {
  switch (recent.kind) {
    case 'local':
      return { kind: 'local', path: normalizePath(recent.path) };
    case 'ssh':
      return {
        kind: 'ssh',
        sshProfileId: recent.sshProfileId,
        path: normalizeRemotePath(recent.path),
      };
  }
}

/**
 * Bookmark 构造器 — 把 PathRef 当作"权威 kind 来源",discriminated union
 * 保证 ssh 分支必带 sshProfileId(本地分支必无)。所有 Bookmark 构造点
 * 统一走这里,避免散落 `...(ref.kind !== 'local' ? { kind } : {})` 模式。
 */
function buildBookmark(input: {
  id: string;
  ref: PathRef;
  addedAt: number;
  displayName?: string;
  defaultTemplateId?: string;
}): Bookmark {
  const common = {
    id: input.id,
    path: input.ref.path,
    addedAt: input.addedAt,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.defaultTemplateId ? { defaultTemplateId: input.defaultTemplateId } : {}),
  };
  switch (input.ref.kind) {
    case 'local':
      return { ...common, kind: 'local' };
    case 'ssh':
      return { ...common, kind: 'ssh', sshProfileId: input.ref.sshProfileId! };
  }
}

function buildRecentEntry(input: {
  ref: PathRef;
  lastUsedAt: number;
  useCount: number;
}): RecentEntry {
  const common = {
    path: input.ref.path,
    lastUsedAt: input.lastUsedAt,
    useCount: input.useCount,
  };
  switch (input.ref.kind) {
    case 'local':
      return { ...common, kind: 'local' };
    case 'ssh':
      return { ...common, kind: 'ssh', sshProfileId: input.ref.sshProfileId! };
  }
}

function buildPathNode(input: {
  id: string;
  ref: PathRef;
  category: PathNode['category'];
  sessionIds: string[];
  displayName?: string;
  defaultTemplateId?: string;
  invalid?: true;
}): PathNode {
  const common = {
    id: input.id,
    path: input.ref.path,
    category: input.category,
    sessionIds: input.sessionIds,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.defaultTemplateId ? { defaultTemplateId: input.defaultTemplateId } : {}),
    ...(input.invalid ? { invalid: true as const } : {}),
  };
  switch (input.ref.kind) {
    case 'local':
      return { ...common, kind: 'local' };
    case 'ssh':
      return { ...common, kind: 'ssh', sshProfileId: input.ref.sshProfileId! };
  }
}

/**
 * v2.1 §II.1 启动期 migrate:磁盘 Bookmark 缺 kind 时 coerce 'local';
 * kind === 'ssh' 但缺 sshProfileId 视为损坏数据,丢弃(配合 flatMap)。
 * 与 validateBookmarksArray 不同的是 — 启动期容错,损坏数据让用户能进
 * Marina;import 走严格校验。
 */
function migrateBookmarkOnLoad(raw: unknown): Bookmark[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const r = raw as Record<string, unknown>;
  if (typeof r['id'] !== 'string' || typeof r['path'] !== 'string') return [];
  if (typeof r['addedAt'] !== 'number') return [];
  const rawKind = r['kind'];
  const kind: PathKind = rawKind === 'ssh' ? 'ssh' : 'local';
  const sshProfileId =
    typeof r['sshProfileId'] === 'string' ? r['sshProfileId'] : undefined;
  if (kind === 'ssh' && !sshProfileId) return [];
  const base = {
    id: r['id'],
    path: r['path'],
    addedAt: r['addedAt'],
    ...(typeof r['displayName'] === 'string' ? { displayName: r['displayName'] } : {}),
    ...(typeof r['defaultTemplateId'] === 'string'
      ? { defaultTemplateId: r['defaultTemplateId'] }
      : {}),
  };
  if (kind === 'local') return [{ ...base, kind: 'local' }];
  return [{ ...base, kind: 'ssh', sshProfileId: sshProfileId! }];
}

function migrateRecentOnLoad(raw: unknown): RecentEntry[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const r = raw as Record<string, unknown>;
  if (typeof r['path'] !== 'string') return [];
  if (typeof r['lastUsedAt'] !== 'number' || typeof r['useCount'] !== 'number') return [];
  const rawKind = r['kind'];
  const kind: PathKind = rawKind === 'ssh' ? 'ssh' : 'local';
  const sshProfileId =
    typeof r['sshProfileId'] === 'string' ? r['sshProfileId'] : undefined;
  if (kind === 'ssh' && !sshProfileId) return [];
  const base = {
    path: r['path'],
    lastUsedAt: r['lastUsedAt'],
    useCount: r['useCount'],
  };
  if (kind === 'local') return [{ ...base, kind: 'local' }];
  return [{ ...base, kind: 'ssh', sshProfileId: sshProfileId! }];
}
