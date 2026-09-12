/**
 * @file session-workspace-manager.ts
 * @purpose 管理终端 session 的临时文件展示工作区：创建、命名/绑定复用(bind)、
 *   关闭后保留、到期回收，以及文件面板状态快照的落盘/读取。
 *
 * @关键设计 (v0.3.3 ADR-024):
 * - workspaceId 是独立稳定 UUID，**与 sessionId 解耦**。目录 = <root>/<workspaceId>/。
 *   session 运行中可"领养"别的 workspaceId 的目录（bind 切换）。main 的 SessionManager
 *   维护 Map<sessionId, workspaceId>（当前绑定）。
 * - manifest schema v2：record = {name, createdAt, closedAt, pinned, pathScope}。
 *   v1→v2 迁移把旧 sessionId 当 workspaceId（目录本就按 sessionId 命名），补默认字段。
 * - pinned=true 跳过 cleanupExpired，永不自动删（用户明确要保留的命名 workspace）。
 * - name 在 pathScope 内唯一；合法字符：非空、禁路径分隔符、≤64。
 * - 文件面板快照独立文件 <workspace>/__marina_state__/file-panel.json，与 manifest 分开
 *   （manifest 低频写、快照滚动高频写，分开避免 churn）。
 * - 删除永远限定于 root/<UUID>；不信任 manifest 中的任意路径，避免路径穿越误删用户文件。
 * - **没有 remove**（防 AI 误删数据）；不想要的命名 workspace 用 unpin 退回可回收态。
 *
 * @对应文档章节: ADR-024（docs/方案-workspace绑定复用与状态持久化-20260801.md）、
 *   docs/ipc-protocol.md (session env)、软件定义书.md 第 2、8 节。
 *
 * @不要在这里做的事:
 * - 不读取或展示工作区文件（FilePanelService 的职责）。
 * - 不管理 PTY/session 状态机（SessionManager 的职责）。
 * - 不创建产品意义上的 workspace / project 容器（这是受管临时目录，UI 不显示它）。
 */
import { promises as fs } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { OpenedFileOrigin } from '@shared/types';
import type { CommandEntry } from '@shared/protocol';
import { JsonStore } from './persistence';
import { logger } from './logger';

const MODULE = 'SessionWorkspaceManager';
const MANIFEST_FILE = 'manifest.json';
const STATE_DIR = '__marina_state__';
const SNAPSHOT_FILE = 'file-panel.json';
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_NAME_LEN = 64;
/** cleanup 失败退避:首次 30s,连续失败每次翻倍,cap 1h(见 cleanupBackoffMs 注释)。 */
const CLEANUP_BACKOFF_BASE_MS = 30_000;
const CLEANUP_BACKOFF_CAP_MS = 60 * 60 * 1000;

/**
 * 把指向 workspace 内部目录的绝对路径重写到另一个 workspace 目录(cloneWorkspace
 * 用)。p 位于 sourceDir 内(相等或真子路径)→ 同相对位置下的 newDir 路径;
 * 否则原样返回(external 文件路径不受影响)。
 *
 * 比较用大小写不敏感(目录名是 UUID,碰撞概率为零;但 Windows 路径大小写
 * 可能因注入源不同而不一致,不敏感比较更稳)。
 */
function remapWorkspaceInternalPath(p: string, sourceDir: string, newDir: string): string {
  const normalize = (s: string) => s.replace(/[\\/]+$/, '').toLowerCase();
  const src = normalize(sourceDir);
  const probe = normalize(p);
  if (probe !== src && !probe.startsWith(`${src}\\`) && !probe.startsWith(`${src}/`)) {
    return p;
  }
  // 归一化大小写不敏感匹配后,用剥前缀取代 relative()(后者对大小写不一致的
  // 输入会返回整路径,语义不对)。剥掉前缀后再去开头的分隔符,拼到 newDir 下。
  const prefixLen = sourceDir.length;
  const tail = p.slice(prefixLen).replace(/^[\\/]+/, '');
  return tail ? join(newDir, tail) : newDir;
}
/** workspaceId 与旧 v1 sessionId 都是 UUID v4，同一正则。 */
const WORKSPACE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** name 禁止路径分隔符（防止拼接成路径越界）；允许其余可见字符。 */
const NAME_FORBIDDEN_RE = /[\\/]/;

/** 命名/绑定态 workspace 记录（manifest v2）。 */
export interface WorkspaceRecord {
  /** null = 未命名临时 workspace；非空 = 已 bind 命名 + pinned。 */
  name: string | null;
  createdAt: number;
  /** null 表示仍有 session 占用；非空 = 已关闭，等 closedAt + retentionDays 回收。 */
  closedAt: number | null;
  /** pinned=true 跳过 cleanupExpired，永不自动删。name 非空隐含 pinned=true。 */
  pinned: boolean;
  /** pathScope = session.pathId（本地目录或 ssh:<profileId>:<remotePath>）；未命名临时=null。 */
  pathScope: string | null;
}

interface WorkspaceManifest {
  version: 2;
  workspaces: Record<string, WorkspaceRecord>;
}

/** 文件面板快照（<workspace>/__marina_state__/file-panel.json）。 */
export interface FilePanelSnapshotData {
  version: 1;
  openedFiles: Array<{
    path: string;
    kind: string;
    external: boolean;
    /** 可选以兼容旧 version=1 快照；新 Git diff 必须持久化其导航来源。 */
    origin?: OpenedFileOrigin;
  }>;
  activeFilePath: string | null;
  scroll: Record<string, { scrollTop: number; scrollLeft: number }>;
  runs: Array<{ key: string; state: string; output: string; exitCode: number | null }>;
  /**
   * 命令页切片(v0.3.3 ADR-039:命令与文档同一快照,同一条恢复/继承管线)。
   * 可选以兼容旧快照;undefined = 磁盘记忆保留(见 protocol.ts 注释)。
   */
  commandPanel?: { version: 2; commands: CommandEntry[]; activeKey: string | null };
  /** 用户当时在看「文件」还是「命令」侧;可选以兼容旧快照。 */
  panelView?: 'file' | 'command';
}

export interface SessionWorkspaceManagerOptions {
  /** 每个实例独立的受管根目录；生产传 userData/file-panel-workspaces。 */
  rootDir: string;
  /** 读取当前设置。修改保留期后调用 rescheduleCleanup() 立即生效。 */
  getRetentionDays: () => number;
  /** 测试注入时钟，生产不传。 */
  now?: () => number;
  /** 测试注入 UUID 生成器，生产不传。 */
  uuid?: () => string;
}

/** create() 的返回：新建 workspace 的身份 + 绝对路径。 */
export interface CreatedWorkspace {
  workspaceId: string;
  dir: string;
}

/** bind upsert 的两种结果。 */
export type BindResult =
  | { kind: 'created'; workspaceId: string; dir: string }
  | { kind: 'switched'; workspaceId: string; dir: string; createdAt: number; fileCount: number };

/** list() 的单项。 */
export interface WorkspaceListItem {
  workspaceId: string;
  name: string | null;
  createdAt: number;
  closedAt: number | null;
  pinned: boolean;
  pathScope: string | null;
  fileCount: number;
}

/**
 * 终端临时展示工作区的生命周期管理器。
 *
 * 生命周期：
 *   create() -> active(closedAt=null) 的未命名临时 workspace
 *   bind(name, pathScope) -> upsert:新建命名+pin / 切到已存在命名
 *   release(workspaceId) -> closedAt=now,retained until closedAt + retentionDays
 *   cleanupExpired() -> removed（pinned 跳过）
 *
 * SessionManager 是唯一业务调用方：它维护 Map<sessionId, workspaceId>，
 * 在 create/bind/new 后更新映射，PTY spawn 失败会 discard，正常关闭会 release。
 */
export class SessionWorkspaceManager {
  private readonly rootDir: string;
  private readonly rootResolved: string;
  private readonly getRetentionDays: () => number;
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly store: JsonStore<WorkspaceManifest>;
  private records = new Map<string, WorkspaceRecord>();
  private cleanupTimer: NodeJS.Timeout | null = null;
  /**
   * cleanup 失败后的重试退避(毫秒,0 = 无退避)。一次失败 → CLEANUP_BACKOFF_BASE_MS,
   * 连续失败每次翻倍,cap 到 CLEANUP_BACKOFF_CAP_MS;全部成功清零。
   *
   * 为什么必须退避(实测事故 2026-09-03 portable):cleanupExpired 失败后
   * rescheduleCleanup 算出 delay=0(到期记录仍在,expiry 已过)→ setTimeout(0)
   * 立即重试 → 无限风暴。一个被文件面板 fs.watch 锁住的 workspace 以 ~640ms/轮
   * 刷了数小时(每轮 fs.rm 递归扫描 + rmdir ×3 重试),main 的 IO/线程池被拖垮,
   * pi 的 agent_settled HTTP POST 3s 超时。退避把暂时性占用(EBUSY)压到分钟级重试,
   * 既不删不掉也刷不死进程。
   */
  private cleanupBackoffMs = 0;
  private initialized = false;

  constructor(options: SessionWorkspaceManagerOptions) {
    this.rootDir = options.rootDir;
    this.rootResolved = resolve(options.rootDir);
    this.getRetentionDays = options.getRetentionDays;
    this.now = options.now ?? Date.now;
    this.uuid = options.uuid ?? randomUUID;
    this.store = new JsonStore<WorkspaceManifest>(join(this.rootDir, MANIFEST_FILE));
  }

  /**
   * 创建根目录、恢复 manifest（含 v1→v2 迁移），并回收本次启动前已到期的目录。
   *
   * 上一次进程未走正常 shutdown 时，active session 不可能在内存中恢复，因此把
   * 它们标成当前时刻关闭，仍保留完整配置的天数而不是启动即删。
   *
   * v1→v2 迁移：旧 manifest 以 sessionId 为 key、record 只有 closedAt。迁移把旧
   * sessionId 当作 workspaceId（目录本就按 sessionId 命名），每条补
   * {name:null, createdAt: closedAt ?? now, pinned:false, pathScope:null}。
   * 迁移幂等（已经是 v2 的不重复迁移）、原子写（JsonStore）、损坏回退默认值。
   */
  async initialize(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const loaded = await this.store.load({ version: 2, workspaces: {} });
    // store.load 拿到的 value 可能是 v1（旧 manifest）或 v2。migrateManifest 内部
    // 归一到 v2 + 校验每条 record，并把迁移标记带回（用于日志）。
    const { records, migrated } = this.migrateManifest(loaded.value);
    this.records = records;
    this.initialized = true;

    let recoveredActive = false;
    const recoveredAt = this.now();
    for (const record of this.records.values()) {
      if (record.closedAt === null) {
        record.closedAt = recoveredAt;
        recoveredActive = true;
      }
    }
    if (recoveredActive || migrated) {
      if (recoveredActive) {
        logger.info(MODULE, `initialize: marked recovered workspace record(s) closed`);
      }
      if (migrated) {
        logger.info(MODULE, `initialize: migrated manifest v1→v2`);
      }
      this.persist();
    }
    logger.info(
      MODULE,
      `initialize: manifest source=${loaded.source} records=${this.records.size} migrated=${migrated}`,
    );
    await this.cleanupExpired();
  }

  /**
   * 创建一个新的空临时 workspace（未命名、未 pin）。
   *
   * SessionManager 调此方法拿到 {workspaceId, dir} 后，维护 sessionId→workspaceId
   * 映射并把 dir 注入 env.MARINA_WORKSPACE。
   *
   * @throws 若 mkdir 失败。失败时 caller 不得 spawn PTY，因为不能向子进程提供
   *   一个不存在的 MARINA_WORKSPACE。
   */
  async create(): Promise<CreatedWorkspace> {
    this.requireInitialized();
    const workspaceId = this.uuid();
    const dir = this.workspacePath(workspaceId);
    await fs.mkdir(dir);
    this.records.set(workspaceId, {
      name: null,
      createdAt: this.now(),
      closedAt: null,
      pinned: false,
      pathScope: null,
    });
    this.persist();
    logger.info(MODULE, `create: workspaceId=${workspaceId} dir=${dir}`);
    return { workspaceId, dir };
  }

  /**
   * 克隆一个已有 workspace(pi /fork 的「继承」语义,方案 20260817 裁决 1):
   * 新建 workspace + 复制源的文件面板快照与受管文件,内部路径重写指向新目录。
   *
   * 复制内容:
   * - 源目录顶层所有文件/子目录(**不含** __marina_state__,状态目录单独处理);
   * - file-panel.json 快照:openedFiles[].path / activeFilePath / scroll 的 key
   *   里指向源目录内部的绝对路径,全部重写为新目录下的对应路径(external=true
   *   的外部路径不受影响)——否则 fork 的面板会直接指向父 workspace 里的文件,
   *   编辑会改到父的文件,违反「fork 不共享」(裁决 3)。ADR-039 起快照还含命令页
   *   切片(commandPanel/panelView/command: scroll 键),一并继承(命令与文档
   *   同一抽象);commandPanel.commands[].runCwd 按同规则重写。
   *
   * 失败策略:新建 workspace 必须成功(同 create());复制/快照是**尽力而为的
   * 增强**——源目录部分复制失败只 warn,不抛(fork 降级为空 workspace,行为安全)。
   *
   * @param sourceWorkspaceId 被继承的源 workspace(父对话的当前 workspace)。
   * @throws 源不存在(调用方应先 getRecord 判活)或新建失败。
   */
  async cloneWorkspace(sourceWorkspaceId: string): Promise<CreatedWorkspace> {
    this.requireInitialized();
    const sourceRecord = this.records.get(sourceWorkspaceId);
    if (!sourceRecord) {
      throw Object.assign(
        new Error(
          `[${MODULE}] cloneWorkspace: source workspace "${sourceWorkspaceId}" 不存在(可能已被回收)。` +
            `调用方应先 getRecord 判活;此时应退回 create() 新建空 workspace。`,
        ),
        { code: 'WorkspaceNotFound' },
      );
    }
    const sourceDir = this.workspacePath(sourceWorkspaceId);
    const created = await this.create();
    const { workspaceId, dir } = created;

    // 1) 复制受管文件(顶层逐项,跳过状态目录;失败降级为部分复制)。
    try {
      const entries = await fs.readdir(sourceDir, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.name === STATE_DIR) continue;
        await fs.cp(join(sourceDir, ent.name), join(dir, ent.name), { recursive: true });
      }
    } catch (err) {
      logger.warn(
        MODULE,
        `cloneWorkspace: copy files degraded ws=${workspaceId} src=${sourceWorkspaceId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // 2) 快照复制 + 内部路径重写(失败降级为无快照,面板空状态)。
    //    ADR-039:快照含命令页切片(commandPanel/panelView/command: scroll 键),
    //    spread 自动携带 —— fork 同样继承命令页(与文档一致);command 的 runCwd
    //    可能指向源目录内部,按同规则重写,否则 fork 里旧输出的相对链接漂移。
    try {
      const snapshot = await this.readSnapshot(sourceWorkspaceId);
      if (snapshot) {
        const remap = (p: string): string => remapWorkspaceInternalPath(p, sourceDir, dir);
        const remapped: FilePanelSnapshotData = {
          ...snapshot,
          openedFiles: snapshot.openedFiles.map((f) => ({ ...f, path: remap(f.path) })),
          activeFilePath: snapshot.activeFilePath ? remap(snapshot.activeFilePath) : null,
          scroll: Object.fromEntries(
            Object.entries(snapshot.scroll).map(([k, v]) => [remap(k), v]),
          ),
          ...(snapshot.commandPanel
            ? {
                commandPanel: {
                  ...snapshot.commandPanel,
                  commands: snapshot.commandPanel.commands.map((c) => ({
                    ...c,
                    ...(c.runCwd ? { runCwd: remap(c.runCwd) } : {}),
                  })),
                },
              }
            : {}),
        };
        await this.writeSnapshot(workspaceId, remapped);
      }
    } catch (err) {
      logger.warn(
        MODULE,
        `cloneWorkspace: snapshot copy degraded ws=${workspaceId} src=${sourceWorkspaceId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    logger.info(MODULE, `cloneWorkspace: ws=${workspaceId} inherited from=${sourceWorkspaceId}`);
    return created;
  }

  /**
   * bind = upsert（ADR-024 §2.2）。在给定 pathScope 内按 name 唯一定位：
   * - name 在 pathScope 内不存在 → 把 currentWorkspaceId 命名为 name + pinned=true +
   *   记 pathScope。目录不变、session 不动。返回 kind:'created'。
   * - name 已存在（pathScope 匹配）→ 返回该 workspaceId + dir（调用方 SessionManager
   *   负责把当前 session 切到它、弃掉旧临时）。返回 kind:'switched' + 元数据。
   *
   * @param currentWorkspaceId 当前 session 绑定的 workspaceId（新建路径用它来命名）。
   * @param name 命名（非空、禁分隔符、≤64）。
   * @param pathScope session.pathId（本地目录或 ssh:profileId:path）。
   * @param forceNew true 时（CLI --new）要求必须新建；name 已存在则抛 ConflictError。
   * @returns BindResult。
   * @throws 'InvalidName' name 不合法；'NameConflict' pathScope 内已存在且 forceNew；
   *   'WorkspaceNotFound' currentWorkspaceId 不在 manifest。
   */
  async bind(
    currentWorkspaceId: string,
    name: string,
    pathScope: string,
    forceNew: boolean,
  ): Promise<BindResult> {
    this.requireInitialized();
    this.validateName(name);
    const trimmed = name.trim();

    // pathScope 内按 name 查已存在（命名 workspace 的 pathScope 非空，未命名的不参与匹配）。
    const existing = this.findNamedInPathScope(trimmed, pathScope);
    if (existing) {
      if (forceNew) {
        throw Object.assign(new Error(`Workspace name "${trimmed}" already exists`), {
          code: 'NameConflict',
        });
      }
      const dir = this.workspacePath(existing.id);
      const fileCount = await this.countWorkspaceFiles(existing.id);
      logger.info(
        MODULE,
        `bind: switched session to existing name="${trimmed}" ws=${existing.id} files=${fileCount}`,
      );
      return {
        kind: 'switched',
        workspaceId: existing.id,
        dir,
        createdAt: existing.record.createdAt,
        fileCount,
      };
    }

    // 新建路径：把当前 workspace 命名 + pin。
    const current = this.records.get(currentWorkspaceId);
    if (!current) {
      throw Object.assign(
        new Error(`bind: current workspaceId="${currentWorkspaceId}" not in manifest`),
        { code: 'WorkspaceNotFound' },
      );
    }
    current.name = trimmed;
    current.pinned = true;
    current.pathScope = pathScope;
    this.persist();
    const dir = this.workspacePath(currentWorkspaceId);
    logger.info(
      MODULE,
      `bind: named current workspace ws=${currentWorkspaceId} name="${trimmed}" pathScope=${pathScope}`,
    );
    return { kind: 'created', workspaceId: currentWorkspaceId, dir };
  }

  /**
   * new：把当前 session 切到一个**新的空临时** workspace（原命名 workspace 保留
   * pinned 不动）。返回新 workspace。调用方 SessionManager 更新 sessionId→workspaceId
   * 映射并 release 旧临时（若旧的是未命名临时）。
   *
   * 注意：当前 workspace 若是命名/pinned 的，**不** release 它（它 pinned，由用户
   * unpin 或到期处理）；只是 session 不再占用它。调用方决定是否把它的 closedAt 标 now。
   */
  async switchToNew(): Promise<CreatedWorkspace> {
    return this.create();
  }

  /**
   * unpin：剥掉 name + pinned，workspace 退回普通态。
   * - 无人占用（occupied=false）→ closedAt=now，按 workspaceRetentionDays 自然回收。
   * - 当前 session 仍占用（occupied=true）→ closedAt 保持 null，等它关闭后再回收。
   *
   * @param workspaceId 要 unpin 的 workspace（ADR 允许 CLI 传 --name 间接定位，
   *   SessionManager 负责按 name+pathScope 解析成 workspaceId 再调此方法）。
   * @param occupied 当前是否有 session 占用此 workspace。
   * @throws 'WorkspaceNotFound'。
   */
  async unpin(workspaceId: string, occupied: boolean): Promise<void> {
    this.requireInitialized();
    const record = this.records.get(workspaceId);
    if (!record) {
      throw Object.assign(new Error(`unpin: workspaceId="${workspaceId}" not in manifest`), {
        code: 'WorkspaceNotFound',
      });
    }
    record.name = null;
    record.pinned = false;
    record.pathScope = null;
    if (!occupied) {
      record.closedAt = this.now();
    }
    this.persist();
    this.rescheduleCleanup();
    logger.info(
      MODULE,
      `unpin: ws=${workspaceId} occupied=${occupied} closedAt=${record.closedAt}`,
    );
  }

  /**
   * 按 name + pathScope 解析 workspace（CLI `unpin --name X` 用）。
   * 返回 workspaceId 或 null（未找到）。
   */
  resolveByName(name: string, pathScope: string): string | null {
    const found = this.findNamedInPathScope(name.trim(), pathScope);
    return found ? found.id : null;
  }

  /**
   * 列出给定 pathScope 下的所有命名 workspace（未命名临时不列）。
   * fileCount 异步 stat 工作区目录顶层文件数（不含 __marina_state__）。
   */
  async list(pathScope: string): Promise<WorkspaceListItem[]> {
    this.requireInitialized();
    const out: WorkspaceListItem[] = [];
    for (const [id, record] of this.records) {
      if (!record.name || record.pathScope !== pathScope) continue;
      const fileCount = await this.countWorkspaceFiles(id);
      out.push({
        workspaceId: id,
        name: record.name,
        createdAt: record.createdAt,
        closedAt: record.closedAt,
        pinned: record.pinned,
        pathScope: record.pathScope,
        fileCount,
      });
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    return out;
  }

  /**
   * PTY spawn 失败时立即撤销刚创建的工作区；该目录从未交给成功启动的子进程，
   * 所以不适用保留期。幂等，避免错误处理路径二次清理再抛错误。
   */
  async discard(workspaceId: string): Promise<void> {
    this.requireInitialized();
    const dir = this.workspacePath(workspaceId);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
    if (this.records.delete(workspaceId)) this.persist();
    this.rescheduleCleanup();
    logger.info(MODULE, `discard: removed unlaunched workspace ws=${workspaceId}`);
  }

  /**
   * 标记 workspace 已关闭。目录不立即删除，直到当前保留期到达；0 天时异步立即
   * 回收。此方法不 await 文件 I/O，保证 SessionManager 的同步销毁状态机不被
   * 磁盘慢路径卡住；退出前由 flush() 等待 manifest 落盘。
   *
   * pinned 的 workspace 即使调了 release 也会被 cleanupExpired 跳过（pinned 免回收），
   * 但 closedAt 仍会标记 —— release 表示"当前 session 不再占用"，pinned 表示"别删"，
   * 两者独立。pinned workspace 要真正可回收必须先 unpin。
   */
  release(workspaceId: string): void {
    this.requireInitialized();
    const record = this.records.get(workspaceId);
    if (!record || record.closedAt !== null) return;
    record.closedAt = this.now();
    this.persist();
    this.rescheduleCleanup();
    logger.info(
      MODULE,
      `release: ws=${workspaceId} pinned=${record.pinned} retainedDays=${this.retentionDays()}`,
    );
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

    // 到期时间决定"最早该试的时刻";上轮失败退避(cleanupBackoffMs)把实际重试
    // 推迟到 now+backoff —— 两者取大,避免 delay=0 无限重试(见字段注释)。首次
    // 尝试(backoff=0)仍是到期即删,保留"0 天=立即回收"的设计语义。
    const delay = Math.max(
      this.cleanupBackoffMs,
      Math.max(0, Math.min(MAX_TIMEOUT_MS, earliestExpiry - now)),
    );
    this.cleanupTimer = setTimeout(() => {
      this.cleanupTimer = null;
      void this.cleanupExpired().catch((err: unknown) => {
        logger.error(MODULE, 'scheduled cleanup failed; will retry at next lifecycle event', err);
        this.rescheduleCleanup();
      });
    }, delay);
  }

  /**
   * 删除到期且已经关闭的受管目录。**pinned=true 跳过**（ADR-024 §2.5）。
   * 目录缺失也视为已清理；删除失败保留 manifest 记录，以便下一次启动/定时器重试，
   * 而不是错误地宣称数据已删除。
   */
  async cleanupExpired(): Promise<void> {
    this.requireInitialized();
    const now = this.now();
    const retentionMs = this.retentionDays() * DAY_MS;
    let changed = false;
    let anyFailed = false;

    for (const [workspaceId, record] of [...this.records]) {
      // pinned 免回收（即使 closedAt 非空，只要还 pinned 就不删）。
      if (record.pinned) continue;
      if (record.closedAt === null || record.closedAt + retentionMs > now) continue;
      const dir = this.workspacePath(workspaceId);
      try {
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
        this.records.delete(workspaceId);
        changed = true;
        logger.info(MODULE, `cleanup: removed expired workspace ws=${workspaceId}`);
      } catch (err) {
        anyFailed = true;
        logger.warn(
          MODULE,
          `cleanup: failed ws=${workspaceId}; keeping record for retry: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    // 失败退避(见 cleanupBackoffMs 字段注释):目录被 fs.watch/别的进程暂时占用
    // (EBUSY)不该触发无限重试;全部成功才清零。
    if (anyFailed) {
      this.cleanupBackoffMs =
        this.cleanupBackoffMs === 0
          ? CLEANUP_BACKOFF_BASE_MS
          : Math.min(CLEANUP_BACKOFF_CAP_MS, this.cleanupBackoffMs * 2);
      logger.info(MODULE, `cleanup: had failures, next retry in ${this.cleanupBackoffMs}ms`);
    } else {
      this.cleanupBackoffMs = 0;
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

  /**
   * 复活一个已 release 的 workspace:closedAt 清回 null —— 它重新被 session
   * 占用,不再是待回收态。幂等(closedAt 已是 null / 不在 manifest → no-op)。
   *
   * 为什么必须存在(实测事故 2026-09-03 portable):pi resume 切回已 release 且
   * 已到期的 workspace 时,若只改 session→workspace 绑定而不清 closedAt,
   * cleanupExpired 不知道它重新被占用,持续 rmdir 一个正被使用的目录;目录被
   * 文件面板 fs.watch 锁住 → EBUSY → 无限重试风暴(见 cleanupBackoffMs 注释),
   * 最终拖垮 main 的 IO。两个调用点:pi resume 切回(switchSessionToWorkspace)
   * 与 CLI bind --name 切到已存在 workspace(bindWorkspace 的 switched 分支)。
   */
  retain(workspaceId: string): void {
    this.requireInitialized();
    const record = this.records.get(workspaceId);
    if (!record) {
      logger.warn(MODULE, `retain: unknown ws=${workspaceId} (no-op)`);
      return;
    }
    if (record.closedAt === null) return; // 活跃中,无需复活
    record.closedAt = null;
    this.persist();
    this.rescheduleCleanup();
    logger.info(MODULE, `retain: ws=${workspaceId} reopened (closedAt cleared)`);
  }

  /** 供测试与未来诊断使用：仅返回受管目录，不暴露或接受任意外部路径。 */
  getPathForWorkspace(workspaceId: string): string | null {
    return this.records.has(workspaceId) ? this.workspacePath(workspaceId) : null;
  }

  /**
   * ADR-034:所有存活 workspace(含 released 未到保留期)的目录 ——
   * marina-file:// 协议白名单数据源之一。records 里被 discard/cleanupExpired
   * 移除的不会再送出,故这里天然只含磁盘上仍受管的目录。
   */
  getAllWorkspaceDirs(): string[] {
    return [...this.records.keys()].map((id) => this.workspacePath(id));
  }

  /** 获取某 workspace 的 record（供 SessionManager 判断 pinned/状态）。 */
  getRecord(workspaceId: string): WorkspaceRecord | null {
    const r = this.records.get(workspaceId);
    return r ? { ...r } : null;
  }

  // ─── 文件面板状态快照 ───────────────────────────────────────────────

  /**
   * 读某 workspace 的文件面板快照。文件缺失/损坏返回 null（调用方按"空状态"恢复）。
   * 不进逐字节热路径（ADR-024 §2.6）：只在 bind 切换 / 首次拉取时调。
   */
  async readSnapshot(workspaceId: string): Promise<FilePanelSnapshotData | null> {
    this.requireInitialized();
    const file = this.snapshotPath(workspaceId);
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as FilePanelSnapshotData;
      if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) return null;
      return this.sanitizeSnapshot(parsed);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      logger.warn(
        MODULE,
        `readSnapshot: failed ws=${workspaceId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /**
   * 写某 workspace 的文件面板快照（覆盖）。调用方负责 debounce（滚动停滚 500ms、
   * 切走/关 session 强制 flush）。确保 __marina_state__ 目录存在。
   */
  async writeSnapshot(workspaceId: string, data: FilePanelSnapshotData): Promise<void> {
    this.requireInitialized();
    const file = this.snapshotPath(workspaceId);
    try {
      await fs.mkdir(join(this.workspacePath(workspaceId), STATE_DIR), { recursive: true });
      // 原子写：先写临时文件再 rename（与 JsonStore 同纪律，防写一半崩溃留损坏文件）。
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(data), 'utf8');
      await fs.rename(tmp, file);
    } catch (err) {
      logger.warn(
        MODULE,
        `writeSnapshot: failed ws=${workspaceId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // ─── 内部 ───────────────────────────────────────────────────────────

  private persist(): void {
    this.store.set({
      version: 2,
      workspaces: Object.fromEntries(this.records),
    });
  }

  private retentionDays(): number {
    const value = this.getRetentionDays();
    // SettingsManager 会在写入前校验。此处仍保守兜底，防测试 stub / 损坏内存把
    // 清理任务变成 NaN 定时器或无限保留。
    return Number.isInteger(value) && value >= 0 && value <= 365 ? value : 7;
  }

  private workspacePath(workspaceId: string): string {
    if (!WORKSPACE_ID_RE.test(workspaceId)) {
      throw new Error(
        `[${MODULE}] Invalid workspace id "${workspaceId}" for workspace path. ` +
          'Expected a UUID; refusing to construct a filesystem path.',
      );
    }
    const candidate = resolve(this.rootDir, workspaceId);
    const relativePath = relative(this.rootResolved, candidate);
    if (relativePath === '' || relativePath.startsWith('..') || relativePath.includes('..\\')) {
      throw new Error(
        `[${MODULE}] Refused workspace path outside managed root for workspaceId="${workspaceId}". ` +
          `root="${this.rootResolved}" candidate="${candidate}".`,
      );
    }
    return candidate;
  }

  private snapshotPath(workspaceId: string): string {
    return join(this.workspacePath(workspaceId), STATE_DIR, SNAPSHOT_FILE);
  }

  /** pathScope 内按 name 查已存在的命名 workspace。 */
  private findNamedInPathScope(
    name: string,
    pathScope: string,
  ): { id: string; record: WorkspaceRecord } | null {
    for (const [id, record] of this.records) {
      if (record.name === name && record.pathScope === pathScope) {
        return { id, record };
      }
    }
    return null;
  }

  /** name 合法性校验：非空 trim 后、禁路径分隔符、≤64。 */
  private validateName(name: string): void {
    const trimmed = name.trim();
    if (!trimmed) {
      throw Object.assign(new Error('Workspace name must not be empty'), { code: 'InvalidName' });
    }
    if (trimmed.length > MAX_NAME_LEN) {
      throw Object.assign(new Error(`Workspace name exceeds ${MAX_NAME_LEN} chars`), {
        code: 'InvalidName',
      });
    }
    if (NAME_FORBIDDEN_RE.test(trimmed)) {
      throw Object.assign(new Error('Workspace name must not contain path separators'), {
        code: 'InvalidName',
      });
    }
  }

  /**
   * 统计工作区顶层文件/目录数（不含 __marina_state__），给 list/bind 提示用。
   * 不递归（只做"这个 workspace 有没有东西"的粗略提示）。
   */
  private async countWorkspaceFiles(workspaceId: string): Promise<number> {
    try {
      const entries = await fs.readdir(this.workspacePath(workspaceId), { withFileTypes: true });
      return entries.filter((e) => e.name !== STATE_DIR).length;
    } catch {
      return 0;
    }
  }

  /**
   * 归一 manifest（含 v1→v2 迁移）。
   *
   * v1：{version:1, workspaces:{<sessionId>:{closedAt}}}。
   * v2：{version:2, workspaces:{<workspaceId>:{name,createdAt,closedAt,pinned,pathScope}}}。
   *
   * 迁移规则（ADR-024 §3）：旧 key（sessionId）当作 workspaceId 不变（目录本就按
   * sessionId 命名）；每条补 name=null, createdAt=closedAt ?? now, pinned=false, pathScope=null。
   * 已是 v2 的直接校验；损坏/未知 version 从空开始。
   */
  private migrateManifest(raw: unknown): {
    records: Map<string, WorkspaceRecord>;
    migrated: boolean;
  } {
    const result = new Map<string, WorkspaceRecord>();
    if (!raw || typeof raw !== 'object') {
      return { records: result, migrated: false };
    }
    const manifest = raw as { version?: unknown; workspaces?: unknown };
    const workspaces = manifest.workspaces;
    if (!workspaces || typeof workspaces !== 'object') {
      logger.warn(MODULE, 'migrateManifest: invalid manifest shape; starting empty');
      return { records: result, migrated: false };
    }

    const version = manifest.version;
    const isV1 = version === 1;
    const isV2 = version === 2;

    for (const [id, rec] of Object.entries(workspaces as Record<string, unknown>)) {
      // key 必须是合法 UUID（v1 的 sessionId 与 v2 的 workspaceId 都是 UUID v4）。
      if (!WORKSPACE_ID_RE.test(id)) {
        logger.warn(MODULE, `migrateManifest: ignoring invalid id=${JSON.stringify(id)}`);
        continue;
      }
      if (!rec || typeof rec !== 'object') continue;

      if (isV1) {
        // v1 record 只有 closedAt。迁移补默认字段。
        const v1 = rec as { closedAt?: unknown };
        const closedAt = this.coerceClosedAt(v1.closedAt);
        result.set(id, {
          name: null,
          createdAt: closedAt ?? this.now(),
          closedAt,
          pinned: false,
          pathScope: null,
        });
      } else if (isV2) {
        // v2 record：逐字段校验，缺字段补默认。
        const v2 = rec as Partial<WorkspaceRecord>;
        const closedAt = this.coerceClosedAt(v2.closedAt);
        const name = typeof v2.name === 'string' ? v2.name : null;
        const createdAt =
          typeof v2.createdAt === 'number' ? v2.createdAt : (closedAt ?? this.now());
        result.set(id, {
          name,
          createdAt,
          closedAt,
          pinned: v2.pinned === true,
          pathScope: typeof v2.pathScope === 'string' ? v2.pathScope : null,
        });
      } else {
        // 未知 version：跳过（load 已回退默认，正常不会到这）。
        logger.warn(MODULE, `migrateManifest: unknown version=${String(version)}; skip id=${id}`);
      }
    }
    return { records: result, migrated: isV1 };
  }

  /** closedAt 归一：number|null，否则 null。 */
  private coerceClosedAt(v: unknown): number | null {
    if (v === null) return null;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    return null;
  }

  /**
   * 校验快照里的可选来源元数据。快照文件可被旧版本或外部工具修改，不能把任意
   * JSON 强转后发给 renderer；只有完整 git-diff 形态才保留，否则按 legacy 无来源处理。
   */
  private sanitizeOpenedFileOrigin(value: unknown): OpenedFileOrigin | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const candidate = value as Record<string, unknown>;
    if (
      candidate.kind !== 'git-diff' ||
      typeof candidate.relativePath !== 'string' ||
      typeof candidate.repoIdentity !== 'string' ||
      candidate.repoIdentity.length === 0 ||
      typeof candidate.sourceMissing !== 'boolean'
    ) {
      return undefined;
    }
    return {
      kind: 'git-diff',
      relativePath: candidate.relativePath,
      repoIdentity: candidate.repoIdentity,
      sourceMissing: candidate.sourceMissing,
    };
  }

  /** 快照字段归一（防损坏文件导致 renderer 崩）。 */
  private sanitizeSnapshot(parsed: FilePanelSnapshotData): FilePanelSnapshotData {
    const openedFiles = Array.isArray(parsed.openedFiles)
      ? parsed.openedFiles
          .filter((f) => f && typeof f.path === 'string' && typeof f.kind === 'string')
          .map((f) => {
            const origin = this.sanitizeOpenedFileOrigin(f.origin);
            return {
              path: f.path,
              kind: f.kind,
              external: f.external === true,
              ...(origin ? { origin } : {}),
            };
          })
      : [];
    const scroll: Record<string, { scrollTop: number; scrollLeft: number }> = {};
    if (parsed.scroll && typeof parsed.scroll === 'object') {
      for (const [k, v] of Object.entries(parsed.scroll)) {
        if (v && typeof v.scrollTop === 'number' && typeof v.scrollLeft === 'number') {
          scroll[k] = { scrollTop: v.scrollTop, scrollLeft: v.scrollLeft };
        }
      }
    }
    const runs = Array.isArray(parsed.runs)
      ? parsed.runs
          .filter(
            (r) =>
              r &&
              typeof r.key === 'string' &&
              typeof r.state === 'string' &&
              typeof r.output === 'string',
          )
          .map((r) => ({
            key: r.key,
            state: r.state,
            output: r.output,
            exitCode: typeof r.exitCode === 'number' ? r.exitCode : null,
          }))
      : [];
    // 命令页切片(ADR-039):浅校验(条目 key/command/output 必须是 string),深
    // 归一(refreshPolicy 枚举/legacy strategy 迁移)留给 CommandPanelService
    // .restoreSnapshot —— 那里已有 normalizeRefreshPolicy,不在这重复一套。
    const commandPanel =
      parsed.commandPanel && typeof parsed.commandPanel === 'object'
        ? {
            version: 2 as const,
            commands: Array.isArray(parsed.commandPanel.commands)
              ? parsed.commandPanel.commands.filter(
                  (c): c is CommandEntry =>
                    !!c &&
                    typeof c.key === 'string' &&
                    typeof c.command === 'string' &&
                    typeof c.output === 'string',
                )
              : [],
            activeKey:
              typeof parsed.commandPanel.activeKey === 'string'
                ? parsed.commandPanel.activeKey
                : null,
          }
        : undefined;
    const panelView =
      parsed.panelView === 'file' || parsed.panelView === 'command' ? parsed.panelView : undefined;
    return {
      version: 1,
      openedFiles,
      activeFilePath: typeof parsed.activeFilePath === 'string' ? parsed.activeFilePath : null,
      scroll,
      runs,
      ...(commandPanel ? { commandPanel } : {}),
      ...(panelView ? { panelView } : {}),
    };
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
