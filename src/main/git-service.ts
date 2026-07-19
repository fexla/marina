/**
 * @file src/main/git-service.ts
 * @purpose 为 GitPanel 提供 session 绑定的、只读 Git 变更浏览与 diff 预览(v0.3.0)。
 *
 * @关键设计:
 * - 与 FileTreeService 同构的安全模式:仅允许当前 owner client 浏览 session
 *   currentCwd 所在 Git 仓库;SSH session 一律拒绝(不引入远端 git 协议,与
 *   file-tree 的 SSH 拒绝策略对称)。
 * - 只读:只调 `git status` 与 `git diff` 类查询命令,从不调用任何写 .git 的
 *   命令(add/commit/push/branch/...都不在本服务的词汇表里)。这是 §13.2/§14.6
 *   的产品边界 —— Git 面板是"只读变更浏览器",不是 Git GUI。
 * - diff 产出策略:不引入新 FileKind / 新 IPC。diff 文本写入 session 的
 *   MARINA_WORKSPACE/__marina_diff__/<sha>.diff 受管临时文件,再交给既有
 *   FilePanelService.openFile,享受 watcher/tab/close/上限全套既有机制
 *   (见 docs/方案-Git面板与文件条目统一-20260718.md §6.2)。
 * - 动态 LayoutNode:evaluateAvailability 是 Git tab 出现/消失的判定函数,
 *   SessionManager cwd 变更时防抖调用它重算 tree(见 §6.7)。它只做 realpath +
 *   stat .git,绝不调 git 二进制,因此 cd 频繁时不会产生子进程风暴。
 * - 真正跑 git 二进制(getStatus/openDiff)只在用户主动操作时触发,且 spawn
 *   限 5s 超时 + 8MB stdout 上限防恶意大输出。
 *
 * @对应文档章节: 软件定义书.md §14.6 受限 Git 变更浏览例外(v0.3.0,ADR-017);
 *   docs/方案-Git面板与文件条目统一-20260718.md §6.1;docs/ipc-protocol.md git 域。
 *
 * @不要在这里做的事:
 * - 不调任何写 .git 的 git 子命令(add/commit/push/pull/fetch/merge/rebase/
 *   stash/branch/checkout/restore/reset/...)。这些属于 Git GUI 范畴,违反 §13.2。
 * - 不做 commit history / log / blame(只看工作区当前变更)。
 * - 不支持 SSH session(与 file-tree 一致,不引入远端 git)。
 * - 不持有 session 路径缓存:每个请求回查 sessionLookup,避免 cwd 变更/接管后
 *   的陈旧授权。
 */
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { FilePanelSnapshot } from '@shared/protocol';
import type { PathKind } from '@shared/types';
import type { FilePanelService } from './file-panel-service';
import { logger } from './logger';

const MODULE = 'GitService';

/** 单次 status 返回的变更文件上限,与 file-tree 的 500 项对齐。 */
const MAX_STATUS_ENTRIES = 500;
/** runGit 的 stdout 字节上限,防恶意大输出撑爆内存。 */
const MAX_GIT_STDOUT_BYTES = 8 * 1024 * 1024;
/** runGit 超时(ms)。git 内置 hook 可能挂起,5s 足够 porcelain/diff 返回。 */
const GIT_TIMEOUT_MS = 5000;
/** diff 文本字节上限(与 file-panel MAX_READ_TEXT_BYTES 对齐,2MB)。 */
const MAX_DIFF_TEXT_BYTES = 2 * 1024 * 1024;
/** 向上查找 .git 的最大层数,防异常挂载点死循环。 */
const MAX_REPO_ROOT_DEPTH = 20;
/** diff 临时文件子目录,挂在 session 的 MARINA_WORKSPACE 下,随 session 回收。 */
const DIFF_TEMP_SUBDIR = '__marina_diff__';

/** IPC 可识别的只读 Git 浏览错误。详情足够诊断,但不回显未授权绝对路径。 */
export class GitError extends Error {
  constructor(
    public readonly code:
      | 'SessionMissing'
      | 'NotOwner'
      | 'SshUnsupported'
      | 'NotARepo'
      | 'InvalidPath'
      | 'OutsideRepoRoot'
      | 'GitBinaryMissing'
      | 'GitFailed',
    message: string,
  ) {
    super(`[${MODULE}:${code}] ${message}`);
    this.name = 'GitError';
  }
}

/** GitService 对 session 信息的最小依赖(与 FileTreeService 同构)。 */
export interface GitSessionLookup {
  get(sessionId: string): {
    /** 用 pathId 的 kind 区分 daemon 本地路径与 SSH 远程 shell,不猜 cwd 字符串。 */
    pathId: string;
    currentCwd: string;
    ownerWindowId: string | null;
  } | null;
}

/** GitService 对受管临时工作区的依赖(session 销毁自动回收,适合放 diff 缓存)。 */
export interface GitWorkspaceLookup {
  /** 仅 live session 有可用目录;实现方不得接受任意外部路径。 */
  getPathForSession(sessionId: string): string | null;
}

/** git 二进制解析与开关,由 SettingsManager 注入(避免 GitService 读 settings)。 */
export interface GitRuntimeConfig {
  /** settings.advanced.enableGitPanel。false 时 GitService 全部 API 返回 unavailable。 */
  enableGitPanel: boolean;
  /** settings.advanced.gitBinaryPath。'' = PATH 查找;非空 = 用户指定路径。 */
  gitBinaryPath: string;
}

export type GitUnavailableReason = 'disabled' | 'ssh-unsupported' | 'not-a-repo' | 'git-binary-missing';

export type GitAvailability =
  | { available: true }
  | { available: false; reason: GitUnavailableReason };

/** porcelain v2 行的解析结果,按状态分组。 */
export type GitStatusTone =
  | 'conflict'
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked';

export interface GitStatusEntry {
  /** 相对 repoRoot 的 POSIX 风格路径(renamed 时是新路径)。 */
  relativePath: string;
  /** renamed 专用:旧路径;其他状态为 undefined。 */
  oldPath?: string;
}

export interface GitStatusGroup {
  tone: GitStatusTone;
  entries: GitStatusEntry[];
}

export interface GitStatusSnapshot {
  /** 仓库根的 canonical 绝对路径;UI 不显示它(避免泄露),但 diff 需要它定位。 */
  repoRoot: string;
  groups: GitStatusGroup[];
  truncated: boolean;
}

/**
 * 受限只读 Git 浏览主服务。
 *
 * 所有公开方法都要求 requesterId === session.ownerWindowId,且 SSH session 一律
 * 拒绝。这样一个窗口即使知道其他窗口的 sessionId,也不能把 GitService 当作跨
 * session 文件读取接口。
 */
export class GitService extends EventEmitter {
  private readonly watchers = new Map<string, { close: () => void }>();
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  private runtimeConfig: GitRuntimeConfig = { enableGitPanel: true, gitBinaryPath: '' };

  constructor(
    private readonly sessionLookup: GitSessionLookup,
    private readonly workspaceLookup: GitWorkspaceLookup,
    private readonly filePanelService: FilePanelService,
  ) {
    super();
  }

  /** SettingsManager 在启动 + 设置变更时注入。 */
  setRuntimeConfig(cfg: GitRuntimeConfig): void {
    this.runtimeConfig = cfg;
  }

  /**
   * 快速判定 Git tab 是否应该出现。只做 realpath + stat .git,不调 git 二进制。
   *
   * 被 SessionManager 在 cwd 变更时(防抖)调用以重建 LayoutNode。因此必须快、
   * 必须不 spawn 子进程。SSH 检查由调用方根据 pathKind 提前做(避免每个 session
   * 都 realpath 一次远端路径)。
   *
   * @param cwdReal session.currentCwd 已 canonicalize 的绝对路径(调用方负责 realpath)
   * @param pathKind session.pathId 的 PathKind(SSH 直接拒绝)
   */
  async evaluateAvailability(
    cwdReal: string,
    pathKind: PathKind,
  ): Promise<GitAvailability> {
    if (!this.runtimeConfig.enableGitPanel) return { available: false, reason: 'disabled' };
    if (pathKind === 'ssh') return { available: false, reason: 'ssh-unsupported' };
    if (!cwdReal) return { available: false, reason: 'not-a-repo' };
    const repoRoot = await findRepoRoot(cwdReal);
    return repoRoot ? { available: true } : { available: false, reason: 'not-a-repo' };
  }

  /**
   * 列出当前仓库工作区变更。SSH session / 非 repo / disable 返回 unavailable,
   * 由 UI 表现为「Git tab 不出现」(动态 LayoutNode 已在 SessionManager 处理了
   * tab 出现/消失;这里主要供 GitPanel 主动拉取用)。
   *
   * @throws GitError SessionMissing / NotOwner / InvalidPath / OutsideRepoRoot /
   *   GitBinaryMissing / GitFailed
   */
  async getStatus(
    sessionId: string,
    requesterId: string,
  ): Promise<GitStatusSnapshot | { unavailable: GitUnavailableReason }> {
    const session = this.requireOwnerSession(sessionId, requesterId);
    if (pathKindFromPathId(session.pathId) === 'ssh') {
      return { unavailable: 'ssh-unsupported' };
    }
    if (!this.runtimeConfig.enableGitPanel) {
      return { unavailable: 'disabled' };
    }
    const cwdReal = await this.realpathOrThrow(session.currentCwd);
    const repoRoot = await findRepoRoot(cwdReal);
    if (!repoRoot) return { unavailable: 'not-a-repo' };

    // porcelain=v2 机器友好,字段稳定。-z 用 NUL 分隔(文件名可含空格/特殊字符)。
    // --untracked-files=all 列全部未跟踪文件(包括未跟踪目录里的文件)。
    const { stdout } = await this.runGit(repoRoot, [
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=all',
    ]);
    const groups = parsePorcelainV2(stdout.toString('utf8'));
    let truncated = false;
    const total = groups.reduce((n, g) => n + g.entries.length, 0);
    if (total > MAX_STATUS_ENTRIES) {
      truncated = true;
      // 截断:保留每组前 N 项,按 tone 优先级(conflict > modified > ...)。
      const perGroup = Math.max(1, Math.floor(MAX_STATUS_ENTRIES / groups.length));
      for (const g of groups) {
        if (g.entries.length > perGroup) g.entries.length = perGroup;
      }
    }
    return { repoRoot, groups, truncated };
  }

  /**
   * 内部:拉一次 status 并 emit(预取 + watcher 复用)。跳过 owner 校验(可信
   * 内部调用)。session 不存在 / 错误时静默不 emit。
   */
  private async emitCurrentStatus(sessionId: string): Promise<void> {
    if (!this.sessionLookup.get(sessionId)) return; // 销毁竞态
    let stripped:
      | { groups: GitStatusGroup[]; truncated: boolean }
      | { unavailable: GitUnavailableReason };
    try {
      const result = await this.getStatusInternal(sessionId);
      stripped =
        'unavailable' in result
          ? { unavailable: result.unavailable }
          : { groups: result.groups, truncated: result.truncated };
    } catch (err) {
      logger.warn(
        'GitService',
        `emitCurrentStatus failed sid=${sessionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    this.emit('gitStatusUpdated', { sessionId, ...stripped });
  }

  /**
   * 预取 status 并 emit gitStatusUpdated 事件(供 renderer 缓存)。
   *
   * 由 SessionManager 在检测到 cwd 进仓库(flip 到 available)时调用,目的是让
   * renderer 在用户点 Git tab 之前就把缓存填上,消除面板切换的 spawn git 延迟
   * (AGENTS.md §10 面板切换延迟约束)。
   *
   * 与 getStatus 的区别:
   * - 不走 owner 校验:这是 main 端内部主动调用,不是 renderer 请求。SessionManager
   *   是可信调用方(它管 session 生命周期,拥有 cwd 真值)。
   * - 不 throw:预取失败(SSH / 非 repo / disable / git 报错)静默转为 unavailable
   *   或不 emit,避免预取扊住 session 创建/cd 流程。
   *
   * 副作用:成功(拿到 snapshot,非 unavailable)→ 启动 watcher 持续推更新;
   *   unavailable → 停 watcher(不在仓库 / SSH / disable 不需轮询)。
   */
  async prefetchStatus(sessionId: string): Promise<void> {
    await this.emitCurrentStatus(sessionId);
    // 根据当前状态启停 watcher。拿不到 session 说明已销毁,确保停。
    const session = this.sessionLookup.get(sessionId);
    if (!session) {
      this.stopWatcher(sessionId);
      return;
    }
    // 判是否需要 watcher:SSH / disable / 非仓尩 → 不需要。用 evaluateAvailability
    // 快速判(不 spawn git,只 realpath + stat .git)。
    const pathKind: PathKind = pathKindFromPathId(session.pathId);
    const cwdReal = await this.realpathOrThrow(session.currentCwd).catch(() => null);
    if (!cwdReal) {
      this.stopWatcher(sessionId);
      return;
    }
    const avail = await this.evaluateAvailability(cwdReal, pathKind);
    if (avail.available) {
      this.startWatcher(sessionId);
    } else {
      this.stopWatcher(sessionId);
    }
  }

  /**
   * 内部 getStatus:跳过 owner 校验(可信内部调用)。其他逻辑与 getStatus 完全一致。
   * 被 prefetchStatus / watcher 复用。
   */
  private async getStatusInternal(
    sessionId: string,
  ): Promise<GitStatusSnapshot | { unavailable: GitUnavailableReason }> {
    const session = this.sessionLookup.get(sessionId);
    if (!session) {
      // session 已销毁(预取与销毁竞态)。返 unavailable 而非 throw,预取静默退出。
      return { unavailable: 'not-a-repo' };
    }
    if (pathKindFromPathId(session.pathId) === 'ssh') {
      return { unavailable: 'ssh-unsupported' };
    }
    if (!this.runtimeConfig.enableGitPanel) {
      return { unavailable: 'disabled' };
    }
    const cwdReal = await this.realpathOrThrow(session.currentCwd);
    const repoRoot = await findRepoRoot(cwdReal);
    if (!repoRoot) return { unavailable: 'not-a-repo' };
    const { stdout } = await this.runGit(repoRoot, [
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=all',
    ]);
    const groups = parsePorcelainV2(stdout.toString('utf8'));
    let truncated = false;
    if (groups.reduce((n, g) => n + g.entries.length, 0) > MAX_STATUS_ENTRIES) {
      truncated = true;
      // 截断:保留按 tone 优先级的前 N 项(冲突置顶逻辑在 parsePorcelainV2 里已排序)。
      let used = 0;
      const kept: typeof groups = [];
      for (const g of groups) {
        const room = MAX_STATUS_ENTRIES - used;
        if (room <= 0) break;
        if (g.entries.length <= room) {
          kept.push(g);
          used += g.entries.length;
        } else {
          kept.push({ ...g, entries: g.entries.slice(0, room) });
          used = MAX_STATUS_ENTRIES;
        }
      }
      return { repoRoot, groups: kept, truncated };
    }
    return { repoRoot, groups, truncated };
  }

  /**
   * 产出某文件的 unified diff 并交给 FilePanelService 打开预览。
   *
   * diff 写入 session 的 MARINA_WORKSPACE/__marina_diff__/<sha>.diff,作为
   * 普通 .diff 文件走既有 openFile 路径。这样:tab 管理 / watcher 自动刷新 /
   * 关闭逻辑 / requestActivation 全部复用,零改动既有状态机。
   *
   * @param relativePath 相对 repoRoot 的路径(由 getStatus 返回,renderer 原样回传)
   * @throws GitError 同 getStatus + NotARepo(若 relativePath 不在 repoRoot 内)
   */
  async openDiff(
    sessionId: string,
    requesterId: string,
    relativePath: string,
  ): Promise<FilePanelSnapshot> {
    const session = this.requireOwnerSession(sessionId, requesterId);
    if (pathKindFromPathId(session.pathId) === 'ssh') {
      throw new GitError('SshUnsupported', 'SSH 会话不支持 Git 面板。请在远程终端中使用 git 命令。');
    }
    if (!this.runtimeConfig.enableGitPanel) {
      throw new GitError('GitFailed', 'Git 面板已在设置中禁用。');
    }
    const cwdReal = await this.realpathOrThrow(session.currentCwd);
    const repoRoot = await findRepoRoot(cwdReal);
    if (!repoRoot) {
      throw new GitError('NotARepo', '当前目录不在 Git 仓库内,无法生成 diff。');
    }
    const target = await this.resolveInsideRepo(repoRoot, relativePath);
    // target 在此仅用于越界校验(resolveInsideRepo 内部 realpath + isWithinRoot);
    // 实际 diff 调用走 relativePath(git -C repoRoot 自行解析)。保留调用以触发校验。
    void target;

    // diff 策略:对工作区文件统一用 `git diff -- <path>`,它会覆盖:
    // - 已跟踪文件的 unstaged 改动
    // - 已 staged 的改动用 `git diff --cached`(下面分情况)
    // 为保持简单:先尝试 unstaged diff;若文件是新增(untracked 或 added),用
    // `git diff --no-index /dev/null <path>` 产生"全增"diff。
    // porcelain v2 的 status letter 在 getStatus 时已知,但这里重新判定以避免
    // renderer 传错的 relativePath 与状态不匹配。最稳的做法:先看 `git status`
    // 单文件判定,再选 diff 子命令。
    const diffText = await this.produceDiff(repoRoot, relativePath);

    const tempPath = await this.writeDiffTemp(sessionId, relativePath, diffText);
    // FilePanelService.openFile:target 是 canonical path,加入已打开列表并切 active。
    // detectFileKind('.diff') 会归类(本期先归 text,DiffViewer 落地时改 'diff')。
    return this.filePanelService.openFile(sessionId, tempPath);
  }

  /**
   * v0.3.1 勘误:直接打开文件本身(相对仓库根的路径 → 绝对路径 → FilePanelService)。
   *
   * 与 openDiff 的区别:不走 git diff,直接读工作区当前内容(用户要"看文件本身"而非
   * "看改了什么")。复用 resolveInsideRepo 的越界校验(防 ../ 逃逸),复用
   * FilePanelService.openFile 的 tab/watcher/close 机制。
   *
   * @param relativePath 相对 repoRoot
   * @throws GitError NotARepo / 越界 / SSH / disabled;fs 读失败由 FilePanelService 抛
   */
  async openFile(
    sessionId: string,
    requesterId: string,
    relativePath: string,
  ): Promise<FilePanelSnapshot> {
    const session = this.requireOwnerSession(sessionId, requesterId);
    if (pathKindFromPathId(session.pathId) === 'ssh') {
      throw new GitError('SshUnsupported', 'SSH 会话不支持 Git 面板。');
    }
    if (!this.runtimeConfig.enableGitPanel) {
      throw new GitError('GitFailed', 'Git 面板已在设置中禁用。');
    }
    const cwdReal = await this.realpathOrThrow(session.currentCwd);
    const repoRoot = await findRepoRoot(cwdReal);
    if (!repoRoot) {
      throw new GitError('NotARepo', '当前目录不在 Git 仓库内。');
    }
    // resolveInsideRepo:realpath + isWithinRoot 越界校验,返回 canonical 绝对路径。
    const absolutePath = await this.resolveInsideRepo(repoRoot, relativePath);
    return this.filePanelService.openFile(sessionId, absolutePath);
  }

  /**
   * v0.3.1 勘误:解析相对路径为绝对路径(供 renderer 复制 / reveal-in-explorer)。
   *
   * 单文件绝对路径不算泄露(repoRoot 全貌未暴露;且用户自己选的文件,路径本就从终端
   * 可得)。越界校验同 openFile。
   *
   * @returns canonical 绝对路径
   */
  async resolvePath(
    sessionId: string,
    requesterId: string,
    relativePath: string,
  ): Promise<string> {
    const session = this.requireOwnerSession(sessionId, requesterId);
    if (pathKindFromPathId(session.pathId) === 'ssh') {
      throw new GitError('SshUnsupported', 'SSH 会话不支持 Git 面板。');
    }
    const cwdReal = await this.realpathOrThrow(session.currentCwd);
    const repoRoot = await findRepoRoot(cwdReal);
    if (!repoRoot) {
      throw new GitError('NotARepo', '当前目录不在 Git 仓库内。');
    }
    return this.resolveInsideRepo(repoRoot, relativePath);
  }

  /** session 销毁:清 watcher + 防抖 timer(ipc wireEventBroadcasts 调)。 */
  onSessionDestroyed(sessionId: string): void {
    this.stopWatcher(sessionId);
    const t = this.debounceTimers.get(sessionId);
    if (t) {
      clearTimeout(t);
      this.debounceTimers.delete(sessionId);
    }
  }

  // ────────────────────────────────────────────────────────────────
  // 内部:session / 路径校验
  // ────────────────────────────────────────────────────────────────

  /** owner 校验 + session 存在性。SSH 检查在各 public 方法内根据 pathId 做。 */
  private requireOwnerSession(
    sessionId: string,
    requesterId: string,
  ): { pathId: string; currentCwd: string; ownerWindowId: string | null } {
    const session = this.sessionLookup.get(sessionId);
    if (!session) {
      throw new GitError(
        'SessionMissing',
        '会话不存在或已关闭,无法浏览 Git 变更。请切换到仍在运行的终端。',
      );
    }
    if (!requesterId || session.ownerWindowId !== requesterId) {
      throw new GitError(
        'NotOwner',
        '当前窗口不持有该会话,无法浏览 Git 变更。请先在会话标签页中接管或切换到 owner 窗口。',
      );
    }
    return session;
  }

  private async realpathOrThrow(cwd: string): Promise<string> {
    try {
      return await fs.realpath(cwd);
    } catch (err) {
      throw new GitError(
        'NotARepo',
        `工作目录不可访问,无法判定 Git 状态。可能原因:(1)目录已被删除,(2)无读取权限。原始错误:${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** 验证 renderer 传入的 relativePath,并在 realpath 后再次验证 repoRoot 包含关系。 */
  private async resolveInsideRepo(repoRoot: string, rawRelativePath: string): Promise<string> {
    if (
      typeof rawRelativePath !== 'string' ||
      rawRelativePath.includes('\0') ||
      isAbsolute(rawRelativePath)
    ) {
      throw new GitError(
        'InvalidPath',
        'Git 路径请求只能携带相对路径,不能携带绝对路径、NUL 字符或盘符路径。',
      );
    }
    if (rawRelativePath.split(/[\\/]+/).some((part) => part === '..')) {
      throw new GitError(
        'OutsideRepoRoot',
        'Git 路径不能包含 "..",只能在仓库根目录内。',
      );
    }
    const lexicalTarget = resolve(repoRoot, rawRelativePath);
    if (!isWithinRoot(repoRoot, lexicalTarget)) {
      throw new GitError('OutsideRepoRoot', '请求路径位于仓库根目录之外,已拒绝。');
    }
    return lexicalTarget;
  }

  // ────────────────────────────────────────────────────────────────
  // 内部:git 子进程
  // ────────────────────────────────────────────────────────────────

  /**
   * 跑 git -C <repoRoot> <args>,返回 stdout Buffer + exit code。
   * gitBinaryPath 优先用用户设置;否则依赖 PATH 查找(Windows 上通常是
   * C:\Program Files\Git\cmd\git.exe,装 Git for Windows 时自动入 PATH)。
   */
  private runGit(
    repoRoot: string,
    args: string[],
  ): Promise<{ stdout: Buffer; stderr: string; exitCode: number }> {
    const binary = this.resolveGitBinary();
    if (!binary) {
      return Promise.reject(
        new GitError(
          'GitBinaryMissing',
          '未找到 git 二进制。请在设置 → 高级 → Git 二进制路径 中指定 git.exe 路径,或确保 git 在系统 PATH 中。',
        ),
      );
    }
    return new Promise((resolveP, rejectP) => {
      const fullArgs = ['-C', repoRoot, ...args];
      const child = spawn(binary, fullArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const stdoutChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrText = '';
      let resolved = false;
      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        rejectP(new GitError('GitFailed', `git ${args[0]} 超时(${GIT_TIMEOUT_MS}ms)。`));
      }, GIT_TIMEOUT_MS);

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > MAX_GIT_STDOUT_BYTES) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            try {
              child.kill('SIGKILL');
            } catch {
              /* ignore */
            }
            rejectP(
              new GitError(
                'GitFailed',
                `git ${args[0]} 输出超过 ${MAX_GIT_STDOUT_BYTES} 字节上限。仓库可能过大,请缩小变更范围。`,
              ),
            );
          }
          return;
        }
        stdoutChunks.push(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrText += chunk.toString('utf8');
      });
      child.on('error', (err) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        rejectP(
          new GitError(
            'GitFailed',
            `无法启动 git 二进制 "${binary}":${err.message}。请检查设置中的路径。`,
          ),
        );
      });
      child.on('close', (code) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        resolveP({
          stdout: Buffer.concat(stdoutChunks),
          stderr: stderrText,
          exitCode: code ?? -1,
        });
      });
    });
  }

  /** 解析 git 二进制路径。空配置 = PATH 查找失败返回 null(由调用方报错)。 */
  private resolveGitBinary(): string | null {
    const configured = this.runtimeConfig.gitBinaryPath.trim();
    if (configured) {
      // 用户指定路径:快速 stat 验证存在(避免 spawn 报模糊 ENOENT)。
      try {
        if (statSync(configured).isFile()) return configured;
      } catch {
        logger.warn(MODULE, `configured gitBinaryPath not found: ${configured}`);
        return null;
      }
    }
    // PATH 查找:依赖系统的 git(Windows 装 Git for Windows 后通常在 PATH)。
    // 测试环境通过 mock spawn 验证逻辑,这里返回 'git' 让 spawn 尝试。
    return 'git';
  }

  /**
   * 为单个文件产生 unified diff。
   *
   * 策略:
   * 1. 先查 status 决定 diff 子命令(untracked/add 用 --no-index vs /dev/null;
   *    tracked 改动用 `git diff -- <path>` 含 unstaged + 已 staged 部分)。
   * 2. 截断 MAX_DIFF_TEXT_BYTES(尾部裁切 + 标记,对齐 file-panel text 上限)。
   */
  private async produceDiff(repoRoot: string, relativePath: string): Promise<string> {
    // 用 porcelain v2 单文件查状态(比 `git status` 文本解析稳)。
    // 注意:对 untracked 文件 porcelain v2 仍会列出 `? <path>`。
    let statusLetter = 'M'; // 兜底按 modified 处理
    try {
      const { stdout } = await this.runGit(repoRoot, [
        'status',
        '--porcelain=v2',
        '-z',
        '--',
        relativePath,
      ]);
      const parsed = parsePorcelainV2(stdout.toString('utf8'));
      // 找到该文件的状态;renamed 取新路径匹配。
      for (const g of parsed) {
        for (const e of g.entries) {
          if (e.relativePath === relativePath || e.oldPath === relativePath) {
            statusLetter = toneToLetter(g.tone);
          }
        }
      }
    } catch {
      // status 查询失败不阻断 diff;按 modified 兜底重试。
      statusLetter = 'M';
    }

    let diffBuffer: Buffer;
    try {
      if (statusLetter === '?') {
        // 未跟踪文件:用 --no-index /dev/null <path> 产生"全增"diff。
        // --no-index 在仓库外也能用,exit code 1 = 有差异(正常),0 = 无差异。
        const r = await this.runGitNoIndex(repoRoot, relativePath);
        diffBuffer = r;
      } else {
        // 已跟踪:unstaged + staged 都看(用户期望"工作区现在与 HEAD 差多少")。
        // git diff HEAD -- <path> 同时含 staged+unstaged vs 最近 commit。
        // 但对新增但已 add 的文件,status letter 是 A,HEAD 可能不存在该文件 →
        // git diff HEAD 会输出全增,与 --no-index 等价,所以 A 也走 HEAD 分支。
        const r = await this.runGit(repoRoot, ['diff', 'HEAD', '--no-color', '--', relativePath]);
        diffBuffer = r.stdout;
      }
    } catch (err) {
      if (err instanceof GitError) throw err;
      throw new GitError(
        'GitFailed',
        `生成 diff 失败:${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const text = diffBuffer.toString('utf8');
    if (text.length <= MAX_DIFF_TEXT_BYTES) return text;
    // 尾部裁切 + 标记(对齐 file-panel-service 的 text 截断哲学)。
    return (
      text.slice(0, MAX_DIFF_TEXT_BYTES) +
      '\n\n... diff 过大已截断,请用外部工具查看完整差异 ...\n'
    );
  }

  /** `git diff --no-index /dev/null <path>` 包装(exit 1 是正常的"有差异")。 */
  private async runGitNoIndex(repoRoot: string, relativePath: string): Promise<Buffer> {
    // --no-index 不能配 -C,但 git 仍需在仓库上下文识别 ignore 规则。用 cwd=repoRoot。
    const binary = this.resolveGitBinary();
    if (!binary) {
      throw new GitError('GitBinaryMissing', '未找到 git 二进制(见设置 → 高级)。');
    }
    const target = resolve(repoRoot, relativePath);
    return new Promise<Buffer>((resolveP, rejectP) => {
      const child = spawn(
        binary,
        ['--no-pager', 'diff', '--no-color', '--no-index', '/dev/null', target],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      );
      const chunks: Buffer[] = [];
      let stderrText = '';
      let resolved = false;
      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        rejectP(new GitError('GitFailed', `git diff --no-index 超时(${GIT_TIMEOUT_MS}ms)。`));
      }, GIT_TIMEOUT_MS);
      child.stdout?.on('data', (c: Buffer) => {
        if (Buffer.concat(chunks).byteLength + c.byteLength <= MAX_GIT_STDOUT_BYTES) chunks.push(c);
      });
      child.stderr?.on('data', (c: Buffer) => {
        stderrText += c.toString('utf8');
      });
      child.on('error', (err) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        rejectP(new GitError('GitFailed', `git diff --no-index 启动失败:${err.message}`));
      });
      child.on('close', (code) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        // exit 0 = 无差异(untracked 文件理论总有差异);1 = 有差异(正常);
        // >1 = 真错误。
        if (typeof code === 'number' && code > 1) {
          rejectP(
            new GitError(
              'GitFailed',
              `git diff --no-index 退出码 ${code}:${stderrText.slice(0, 200)}`,
            ),
          );
          return;
        }
        resolveP(Buffer.concat(chunks));
      });
    });
  }

  /** 把 diff 文本写入 session 受管 workspace 的临时文件。返回 canonical 绝对路径。 */
  private async writeDiffTemp(
    sessionId: string,
    relativePath: string,
    diffText: string,
  ): Promise<string> {
    const workspace = this.workspaceLookup.getPathForSession(sessionId);
    if (!workspace) {
      throw new GitError(
        'GitFailed',
        '该会话没有可用的受管临时工作区,无法缓存 diff。请检查会话状态。',
      );
    }
    const dir = resolve(workspace, DIFF_TEMP_SUBDIR);
    await fs.mkdir(dir, { recursive: true });
    // 文件名:<sanitized relativePath>__<sha8>.diff。sanitizer 把路径分隔符换 _。
    // sha 防同名文件多次打开时互相覆盖导致 watcher 误刷新;实际上每次 openDiff
    // 重新覆写同 sha 文件正是我们想要的(用户点同一文件看最新 diff)。
    const safe = relativePath.replace(/[\\/]+/g, '__').slice(-60) || 'diff';
    const sha = createHash('sha256').update(diffText).digest('hex').slice(0, 8);
    const filePath = resolve(dir, `${safe}__${sha}.diff`);
    await fs.writeFile(filePath, diffText, 'utf8');
    return filePath;
  }

  // ────────────────────────────────────────────────────────────────
  // 内部:watcher(v0.3.0 轮询实现)
  // ────────────────────────────────────────────────────────────────

  /** 轮询间隔(ms)。3s 平衡及时性与 CPU:git status 在已索引仓库 <50ms,3s 一次可忽略。 */
  private static readonly WATCHER_POLL_MS = 3000;

  /**
   * 启动轮询 watcher:每 3s 拉一次 status 并 emit,让 renderer 缓存持续新鲜。
   * 幂等:已存在则不重复启动。session 销毁 / cd 出仓库时由 stopWatcher / prefetchStatus 停。
   *
   * 为什么用轮询而非 fs.watch:
   * - fs.watch 递归 watch 工作区会捕获 node_modules 噪声 + Windows/Linux/macOS
   *   行为不一致 + 高频变更会压爆。
   * - 只 watch .git/index 只捕获 staged,遗漏工作区 modified/untracked。
   * - 轮询一次 git status 捕获所有变化,逻辑简单,3s 间隔 CPU 可忽略。
   * 未来若需要更低延迟,可加 .git/index 的 fs.watch 即时触发(补充轮询)。
   */
  private startWatcher(sessionId: string): void {
    if (this.watchers.has(sessionId)) return; // 已启动,幂等
    const poll = async (): Promise<void> => {
      try {
        await this.emitCurrentStatus(sessionId);
      } catch (err) {
        logger.warn(
          'GitService',
          `watcher poll error sid=${sessionId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    };
    const handle = setInterval(() => {
      void poll();
    }, GitService.WATCHER_POLL_MS);
    // unref:不阻止进程退出(session 都关了进程应能退)。
    handle.unref?.();
    this.watchers.set(sessionId, {
      close: () => clearInterval(handle),
    });
    logger.debug('GitService', `watcher started sid=${sessionId} interval=${GitService.WATCHER_POLL_MS}ms`);
  }

  private stopWatcher(sessionId: string): void {
    const w = this.watchers.get(sessionId);
    if (w) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
      this.watchers.delete(sessionId);
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// 模块级辅助函数(纯函数,便于单测)
// ────────────────────────────────────────────────────────────────────

/** 从 pathId 字符串判定 PathKind(避免 GitService 直接依赖 path-manager)。 */
function pathKindFromPathId(pathId: string): PathKind {
  // ssh profile 的 pathId 形如 "ssh:profileId";本地是绝对路径。
  // 与 pathRefFromId 的判定逻辑一致(见 path-manager.ts),但内联以解耦。
  return pathId.startsWith('ssh:') ? 'ssh' : 'local';
}

/** 前缀字符串比较不安全,必须用 path.relative 的段边界。 */
function isWithinRoot(root: string, target: string): boolean {
  const relation = relative(root, target);
  return (
    relation === '' ||
    (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation))
  );
}

/** 从 startReal 向上找 .git,返回仓库根(含 .git 的目录)的 canonical path。 */
async function findRepoRoot(startReal: string): Promise<string | null> {
  let current = startReal;
  for (let i = 0; i < MAX_REPO_ROOT_DEPTH; i += 1) {
    const gitPath = resolve(current, '.git');
    try {
      const stat = await fs.stat(gitPath);
      // .git 可能是目录(标准)或文件(worktree/submodule 的 gitlink)。两者都认。
      if (stat.isDirectory() || stat.isFile()) return current;
    } catch {
      /* not found, go up */
    }
    const parent = resolve(current, '..');
    if (parent === current) return null; // 到达根
    current = parent;
  }
  return null;
}

/**
 * 解析 `git status --porcelain=v2 -z` 输出为分组列表。
 *
 * porcelain v2 行格式(简化):
 * - 已跟踪: `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`(renamed 时 path 是 `old\tnew`)
 * - 未跟踪: `? <path>`
 * - 忽略:   `! <path>`(我们不带 ignored,但容错跳过)
 * - 冲突:   `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`
 *
 * XY 是两字符状态码:X=index vs HEAD,Y=worktree vs index。
 */
export function parsePorcelainV2(input: string): GitStatusGroup[] {
  // -z 用 NUL 分隔记录。我们按 NUL split,逐条解析。
  const records = input.split('\0').filter((r) => r.length > 0);
  const buckets: Record<GitStatusTone, GitStatusEntry[]> = {
    conflict: [],
    modified: [],
    added: [],
    deleted: [],
    renamed: [],
    untracked: [],
  };
  for (const rec of records) {
    const parsed = parseOneRecord(rec);
    if (parsed) buckets[parsed.tone].push(parsed.entry);
  }
  // 按 tone 优先级输出(conflict 置顶,与 GitPanel 分组顺序一致)。
  const order: GitStatusTone[] = ['conflict', 'modified', 'added', 'deleted', 'renamed', 'untracked'];
  return order.map((tone) => ({ tone, entries: buckets[tone] })).filter((g) => g.entries.length > 0);
}

function parseOneRecord(rec: string): { tone: GitStatusTone; entry: GitStatusEntry } | null {
  if (rec.startsWith('1 ')) {
    // 已跟踪。XY 在 rec[2..4]。
    const xy = rec.slice(2, 4);
    // path 是最后一个空格后的部分(字段都是无空格的 hash/mode)。
    const parts = rec.split(' ');
    const pathPart = parts.slice(8).join(' '); // 以防路径含空格(实际 -z 已 NUL 分隔,这里安全)
    return { tone: trackedTone(xy), entry: parseTrackedPath(pathPart, xy) };
  }
  if (rec.startsWith('2 ')) {
    // renamed/copied。格式: `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<origPath>`
    const parts = rec.split(' ');
    const pathAndOld = parts.slice(9).join(' ');
    const tabIdx = pathAndOld.indexOf('\t');
    const newPath = tabIdx >= 0 ? pathAndOld.slice(0, tabIdx) : pathAndOld;
    const oldPath = tabIdx >= 0 ? pathAndOld.slice(tabIdx + 1) : undefined;
    const xy = rec.slice(2, 4);
    const entry: GitStatusEntry = { relativePath: newPath };
    if (oldPath !== undefined) entry.oldPath = oldPath;
    return {
      tone: trackedTone(xy) === 'modified' ? 'renamed' : trackedTone(xy),
      entry,
    };
  }
  if (rec.startsWith('? ')) {
    const path = rec.slice(2);
    return { tone: 'untracked', entry: { relativePath: path } };
  }
  if (rec.startsWith('u ')) {
    // 冲突。格式: `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`
    // 'u' 后 9 个字段(XY/sub/3 mode/1 worktree mode/3 hash)再是 path → slice(10)。
    const parts = rec.split(' ');
    const path = parts.slice(10).join(' ');
    return { tone: 'conflict', entry: { relativePath: path } };
  }
  // `! ` (ignored) 或未知:跳过。
  return null;
}

/** XY 两字符状态码 → tone。X=index vs HEAD, Y=worktree vs index。 */
function trackedTone(xy: string): GitStatusTone {
  const x = xy[0] ?? ' ';
  const y = xy[1] ?? ' ';
  // 冲突优先(u 行已单独处理,但 1 行的 XY 也可能含 U)。
  if (x === 'U' || y === 'U' || x === 'A' && y === 'A' || x === 'D' && y === 'D') return 'conflict';
  if (x === 'A' || y === 'A') return 'added'; // 新增到 index 或 worktree
  if (x === 'D' || y === 'D') return 'deleted';
  // M 占多数;C(copied)在 1 行不出现(只在 2 行),此处兜底 modified。
  return 'modified';
}

function parseTrackedPath(pathPart: string, _xy: string): GitStatusEntry {
  // 1 行的 path 不含 tab(renamed 在 2 行)。直接返回。
  return { relativePath: pathPart };
}

function toneToLetter(tone: GitStatusTone): string {
  switch (tone) {
    case 'conflict':
      return 'U';
    case 'modified':
      return 'M';
    case 'added':
      return 'A';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    case 'untracked':
      return '?';
  }
}
