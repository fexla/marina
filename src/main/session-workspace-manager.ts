/**
 * @file session-workspace-manager.ts
 * @purpose 管理每个终端 session 的临时文件展示工作区：创建、安全定位、关闭后保留
 *   以及到期回收。
 *
 * @关键设计:
 * - 工作区仅是给该 session 内进程产出可展示文档的受管目录，不是 Marina 的
 *   Project / Workspace 产品层级；UI 不显示它，也不改变 Path 模型。
 * - 元数据写入工作区根目录的 manifest.json。应用崩溃后，下一次启动会把此前
 *   仍标为 active 的记录视为已关闭，再按当前保留期清理。
 * - 删除永远限定于 root/<UUID>；不信任 manifest 中的任意路径，避免损坏文件或
 *   路径穿越误删用户文件。
 *
 * @对应文档章节: docs/ipc-protocol.md (session env)、软件定义书.md 第 2、8 节。
 *
 * @不要在这里做的事:
 * - 不读取或展示工作区文件（FilePanelService 的职责）。
 * - 不管理 PTY/session 状态机（SessionManager 的职责）。
 * - 不创建产品意义上的 workspace / project 容器。
 */
import { promises as fs } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { JsonStore } from './persistence';
import { logger } from './logger';

const MODULE = 'SessionWorkspaceManager';
const MANIFEST_FILE = 'manifest.json';
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface WorkspaceRecord {
  /** null 表示 session 尚未销毁；应用重启时会被标记为关闭。 */
  closedAt: number | null;
}

interface WorkspaceManifest {
  version: 1;
  workspaces: Record<string, WorkspaceRecord>;
}

export interface SessionWorkspaceManagerOptions {
  /** 每个实例独立的受管根目录；生产传 userData/file-panel-workspaces。 */
  rootDir: string;
  /** 读取当前设置。修改保留期后调用 rescheduleCleanup() 立即生效。 */
  getRetentionDays: () => number;
  /** 测试注入时钟，生产不传。 */
  now?: () => number;
}

/**
 * 终端临时展示工作区的生命周期管理器。
 *
 * 生命周期：
 *   create(sessionId) -> active
 *   release(sessionId) -> retained until closedAt + retentionDays
 *   cleanupExpired() -> removed
 *
 * SessionManager 是唯一业务调用方：PTY spawn 失败会 discard，正常关闭会 release。
 */
export class SessionWorkspaceManager {
  private readonly rootDir: string;
  private readonly rootResolved: string;
  private readonly getRetentionDays: () => number;
  private readonly now: () => number;
  private readonly store: JsonStore<WorkspaceManifest>;
  private records = new Map<string, WorkspaceRecord>();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private initialized = false;

  constructor(options: SessionWorkspaceManagerOptions) {
    this.rootDir = options.rootDir;
    this.rootResolved = resolve(options.rootDir);
    this.getRetentionDays = options.getRetentionDays;
    this.now = options.now ?? Date.now;
    this.store = new JsonStore<WorkspaceManifest>(join(this.rootDir, MANIFEST_FILE));
  }

  /**
   * 创建根目录、恢复 manifest，并回收本次启动前已经到期的目录。
   *
   * 上一次进程未走正常 shutdown 时，active session 不可能在内存中恢复，因此把
   * 它们标成当前时刻关闭，仍保留完整配置的天数而不是启动即删。
   */
  async initialize(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const { value, source } = await this.store.load({ version: 1, workspaces: {} });
    this.records = this.sanitizeManifest(value);
    this.initialized = true;

    let recoveredActive = false;
    const recoveredAt = this.now();
    for (const record of this.records.values()) {
      if (record.closedAt === null) {
        record.closedAt = recoveredAt;
        recoveredActive = true;
      }
    }
    if (recoveredActive) {
      logger.info(
        MODULE,
        `initialize: marked ${this.records.size} recovered workspace record(s) closed`,
      );
      this.persist();
    }
    logger.info(MODULE, `initialize: manifest source=${source} records=${this.records.size}`);
    await this.cleanupExpired();
  }

  /**
   * 为新 session 创建一个空目录并记录 active 生命周期。
   *
   * @throws 若 sessionId 不是 UUID 或 mkdir 失败。失败时 caller 不得 spawn PTY，
   * 因为不能向子进程提供一个不存在的 MARINA_WORKSPACE。
   */
  async create(sessionId: string): Promise<string> {
    this.requireInitialized();
    const dir = this.workspacePath(sessionId);
    await fs.mkdir(dir);
    this.records.set(sessionId, { closedAt: null });
    this.persist();
    logger.info(MODULE, `create: sessionId=${sessionId} dir=${dir}`);
    return dir;
  }

  /**
   * PTY spawn 失败时立即撤销刚创建的工作区；该目录从未交给成功启动的子进程，
   * 所以不适用保留期。幂等，避免错误处理路径二次清理再抛错误。
   */
  async discard(sessionId: string): Promise<void> {
    this.requireInitialized();
    const dir = this.workspacePath(sessionId);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
    if (this.records.delete(sessionId)) this.persist();
    this.rescheduleCleanup();
    logger.info(MODULE, `discard: removed unlaunched workspace sessionId=${sessionId}`);
  }

  /**
   * 标记 session 已关闭。目录不立即删除，直到当前保留期到达；0 天时异步立即
   * 回收。此方法不 await 文件 I/O，保证 SessionManager 的同步销毁状态机不被
   * 磁盘慢路径卡住；退出前由 flush() 等待 manifest 落盘。
   */
  release(sessionId: string): void {
    this.requireInitialized();
    const record = this.records.get(sessionId);
    if (!record || record.closedAt !== null) return;
    record.closedAt = this.now();
    this.persist();
    this.rescheduleCleanup();
    logger.info(MODULE, `release: sessionId=${sessionId} retainedDays=${this.retentionDays()}`);
  }

  /** 设置变化后由 bootstrap 调用，使新的保留期立即影响既有已关闭工作区。 */
  rescheduleCleanup(): void {
    if (!this.initialized) return;
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    const now = this.now();
    let earliestExpiry: number | null = null;
    for (const record of this.records.values()) {
      if (record.closedAt === null) continue;
      const expiry = record.closedAt + this.retentionDays() * DAY_MS;
      if (earliestExpiry === null || expiry < earliestExpiry) earliestExpiry = expiry;
    }
    if (earliestExpiry === null) return;

    const delay = Math.max(0, Math.min(MAX_TIMEOUT_MS, earliestExpiry - now));
    this.cleanupTimer = setTimeout(() => {
      this.cleanupTimer = null;
      void this.cleanupExpired().catch((err: unknown) => {
        logger.error(MODULE, 'scheduled cleanup failed; will retry at next lifecycle event', err);
        this.rescheduleCleanup();
      });
    }, delay);
  }

  /**
   * 删除到期且已经关闭的受管目录。目录缺失也视为已清理；删除失败保留 manifest
   * 记录，以便下一次启动/定时器重试，而不是错误地宣称数据已删除。
   */
  async cleanupExpired(): Promise<void> {
    this.requireInitialized();
    const now = this.now();
    const retentionMs = this.retentionDays() * DAY_MS;
    let changed = false;

    for (const [sessionId, record] of [...this.records]) {
      if (record.closedAt === null || record.closedAt + retentionMs > now) continue;
      const dir = this.workspacePath(sessionId);
      try {
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
        this.records.delete(sessionId);
        changed = true;
        logger.info(MODULE, `cleanup: removed expired workspace sessionId=${sessionId}`);
      } catch (err) {
        logger.warn(
          MODULE,
          `cleanup: failed sessionId=${sessionId}; keeping record for retry: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    if (changed) this.persist();
    this.rescheduleCleanup();
  }

  /** 在应用退出前调用，取消定时器并确保生命周期元数据已写盘。 */
  async flush(): Promise<void> {
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    await this.store.flush();
  }

  /** 供测试与未来诊断使用：仅返回受管目录，不暴露或接受任意外部路径。 */
  getPathForSession(sessionId: string): string | null {
    return this.records.has(sessionId) ? this.workspacePath(sessionId) : null;
  }

  private persist(): void {
    this.store.set({
      version: 1,
      workspaces: Object.fromEntries(this.records),
    });
  }

  private retentionDays(): number {
    const value = this.getRetentionDays();
    // SettingsManager 会在写入前校验。此处仍保守兜底，防测试 stub / 损坏内存把
    // 清理任务变成 NaN 定时器或无限保留。
    return Number.isInteger(value) && value >= 0 && value <= 365 ? value : 7;
  }

  private workspacePath(sessionId: string): string {
    if (!SESSION_ID_RE.test(sessionId)) {
      throw new Error(
        `[${MODULE}] Invalid session id "${sessionId}" for workspace path. ` +
          'Expected a UUID generated by SessionManager; refusing to construct a filesystem path.',
      );
    }
    const candidate = resolve(this.rootDir, sessionId);
    const relativePath = relative(this.rootResolved, candidate);
    if (relativePath === '' || relativePath.startsWith('..') || relativePath.includes('..\\')) {
      throw new Error(
        `[${MODULE}] Refused workspace path outside managed root for sessionId="${sessionId}". ` +
          `root="${this.rootResolved}" candidate="${candidate}".`,
      );
    }
    return candidate;
  }

  private sanitizeManifest(raw: WorkspaceManifest): Map<string, WorkspaceRecord> {
    const result = new Map<string, WorkspaceRecord>();
    if (!raw || raw.version !== 1 || !raw.workspaces || typeof raw.workspaces !== 'object') {
      logger.warn(
        MODULE,
        'initialize: invalid manifest shape; starting with no tracked workspaces',
      );
      return result;
    }
    for (const [sessionId, record] of Object.entries(raw.workspaces)) {
      if (!SESSION_ID_RE.test(sessionId)) {
        logger.warn(
          MODULE,
          `initialize: ignoring invalid manifest sessionId=${JSON.stringify(sessionId)}`,
        );
        continue;
      }
      const closedAt = record?.closedAt;
      if (closedAt !== null && (typeof closedAt !== 'number' || !Number.isFinite(closedAt))) {
        logger.warn(MODULE, `initialize: ignoring invalid closedAt for sessionId=${sessionId}`);
        continue;
      }
      result.set(sessionId, { closedAt });
    }
    return result;
  }

  private requireInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        `[${MODULE}] Called before initialize(). Create and initialize the manager during app bootstrap ` +
          'before SessionManager can create a session.',
      );
    }
  }
}
