/**
 * @file src/main/file-panel-service.ts
 * @purpose 终端侧边文件预览面板的"大脑":每终端的已打开文件状态机 + 文件内容读取
 *    + 变更自动刷新。本机 HTTP 传输层(M3)已拆到 src/main/http/local-http-gateway.ts。
 *
 * @工作原理:
 * 终端里跑的程序(agent / 脚本 / CLI)经注入的环境变量(MARINA_SERVICE /
 * MARINA_TOKEN / TERMINAL_ID)调 LocalHttpGateway 的 RESTful 接口,把文件"打开 /
 * 切换 / 关闭"到**绑定该终端**的侧边面板。本服务是这些状态的**唯一源**,任何变化
 * emit 'filePanelUpdated',由 ipc 层路由给该 session 的 owner 窗口渲染。
 *
 * @关键设计:
 * - 唯一状态源:Map<sessionId, PanelState>。REST 只改面板视图(开/关/切),
 *   不在 HTTP 上提供"任意文件读"——读内容走 renderer→main 的 cmd:file-panel:read,
 *   且仅限已打开列表里的路径。安全面因此被压到最小。
 * - 自动刷新:每个已打开文件起 fs.watch,200ms 防抖;变更 → 重 stat 更新
 *   mtimeMs/size → emit。renderer 的 viewer 把 mtimeMs 列入 effect 依赖,
 *   变化即重新 read,实现"文件改了面板自动刷新"。
 * - 大小上限:text/markdown/diff 2MB(超出截断 + truncated 标记,镜像 scrollback
 *   ring 的尾部裁切哲学);image 10MB(超出拒绝,避免 base64 撑爆 IPC)。
 * - HTTP 安全面(127.0.0.1 + Bearer token + /health 免鉴权)见 local-http-gateway.ts
 *   文件头 —— M3 把传输层拆走后,service 不再持有 server/token。
 *
 * @SSH 限制:SSH 会话的 currentCwd 是远程路径,且远程进程根本到不了本机
 *   127.0.0.1(除非反向隧道,超出 v1)。所以本功能 v1 仅实质支持本地终端;
 *   即便 SSH 程序误调,fs.stat 远程路径会失败 → 返回错误,安全无副作用。
 *
 * @循环依赖破除:FilePanelService 需要 sessionManager.get() 拿 currentCwd/
 *   owner;SessionManager 需要 gateway.getUrl() 注入 env。解法是
 *   "组装顺序":index.ts 先 new FilePanelService → new LocalHttpGateway(filePanelService)
 *   → new SessionManager(经 options 传 gateway)→ filePanelService.attachSessionLookup(sm)。
 *   env 注入发生在 createSession(IPC 触发,必在组装完成之后),时序安全。
 *
 * @对应:docs/ipc-protocol.md(file-panel 域);src/shared/protocol.ts
 *   FILE_PANEL_* channel;src/main/session-manager.ts env 注入;
 *   src/main/ipc.ts wireEventBroadcasts 事件路由;src/main/http/local-http-gateway.ts。
 */
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, watch, type FSWatcher, type Stats } from 'node:fs';
import { basename, dirname, resolve, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import type { OpenedFile, OpenedFileOrigin } from '@shared/types';
import { detectFileKind } from '@shared/file-kind';
import type {
  FilePanelSnapshot,
  ReadFileResponse,
  ReadImageResponse,
  GalleryResolveImageResponse,
} from '@shared/protocol';
import { isRemoteUrl } from '@shared/url-scheme';
import { normalizePath } from './path-manager';
import { logger } from './logger';
import { send, readBody } from './http/http-helpers';

const MODULE = 'FilePanelService';

/** text/markdown 读取上限(字节)。超出按尾部裁切 + truncated 标记。 */
const MAX_READ_TEXT_BYTES = 2 * 1024 * 1024;
/** 图片读取上限(字节)。超出直接拒绝(base64 会撑爆 IPC)。 */
const MAX_READ_IMAGE_BYTES = 10 * 1024 * 1024;
/** 网络图下载上限(字节)。超出拒绝(与本地图片上限一致,防撑爆 IPC/workspace)。 */
const MAX_NETWORK_IMAGE_BYTES = 10 * 1024 * 1024;
/** 网络图下载超时(ms)。超过视为失败(renderer 显示占位+重试)。 */
const NETWORK_IMAGE_TIMEOUT_MS = 10_000;
/** gallery 网络图缓存子目录名(落在 session 绑定的 workspace 下,随 workspace 回收)。 */
const GALLERY_CACHE_DIR = '__marina_gallery__';
/** fs.watch 防抖间隔(ms):编辑器连续保存时只触发一次刷新。 */
const WATCH_DEBOUNCE_MS = 200;
/** 外部 heading 属于不可信 HTTP 输入；限制长度避免把超大字符串广播进每个 renderer。 */
const MAX_HEADING_TARGET_LENGTH = 512;
/** 扩展名 → mime(图片 dataUrl 用)。detectFileKind 已保证只对图片走到这里。 */
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  avif: 'image/avif',
  tiff: 'image/tiff',
  tif: 'image/tiff',
};

/**
 * FilePanelService 对 session 信息的最小依赖。SessionManager 天然满足
 * (有 get 方法),用接口而非具体类,既破除循环依赖又便于单测注入 mock。
 */
export interface FilePanelSessionLookup {
  get(sessionId: string): { currentCwd: string; ownerWindowId: string | null } | null;
}

/**
 * 打开文件时由上游附带的可选语义。FilePanelService 负责随 OpenedFile 状态保存并
 * 广播，但不解释来源内容；导航规则仍由对应 viewer / source module 决定。
 */
export interface OpenFileOptions {
  origin?: OpenedFileOrigin;
  /** 可见 Markdown 标题文字；只触发一次性 owner 定向导航，不进入 OpenedFile。 */
  heading?: string;
  /**
   * IPC 发起者在请求开始时的 owner id。文件系统 await 完成后、修改 PanelState 前
   * 必须再校验一次，防止旧窗口的迟到请求污染新 owner。HTTP program-push 省略。
   */
  expectedOwnerWindowId?: string;
}

/**
 * v0.3.3 T12(testability enabler):按 sessionId 截其 owner window 的屏。
 * 注入式回调(FilePanelService 不引 electron,保持可测)—— index.ts 闭合
 * sessionManager.get → ownerWindowId → windowManager.getById → webContents.capturePage
 * → NativeImage.toPNG()。成功返回 PNG Buffer;不可截(无 owner/窗口已销毁/最小化)
 * 返回 {error}。HTTP /screenshot 路由调它。
 */
export type WindowCaptureFn = (sessionId: string) => Promise<{ png: Buffer } | { error: string }>;

/**
 * v0.3.3 ADR-024:workspace 操作回调(由 index.ts 闭合到 SessionManager)。
 * FilePanelService 不持有 SessionManager(保持可测),只拿这些 op 供 HTTP 路由用。
 * 未注入时 workspace 路由返 503。
 */
export interface WorkspaceOps {
  /** 查当前 session 绑定的 workspace 绝对路径(CLI `workspace`)。 */
  getCurrentPath(sessionId: string): string | null;
  /** bind = upsert。forceNew=true + 存在→抛 NameConflict。 */
  bind(
    sessionId: string,
    name: string,
    forceNew: boolean,
  ): Promise<
    | { kind: 'created'; workspaceId: string; dir: string }
    | { kind: 'switched'; workspaceId: string; dir: string; createdAt: number; fileCount: number }
  >;
  /** 列当前 session pathScope 下的命名 workspace。 */
  list(sessionId: string): Promise<
    Array<{
      workspaceId: string;
      name: string | null;
      createdAt: number;
      closedAt: number | null;
      pinned: boolean;
      pathScope: string | null;
      fileCount: number;
    }>
  >;
  /** 切回新空临时 workspace。 */
  newWorkspace(sessionId: string): Promise<{ workspaceId: string; dir: string }>;
  /** 剥 name+pinned(name=null=当前)。返 null=未找到。 */
  unpin(sessionId: string, name: string | null): Promise<{ workspaceId: string } | null>;
  /**
   * v0.3.3 Feature D 接线:读当前 session 绑定 workspace 的文件面板快照
   * (openedFiles/activeFilePath/scroll/runs)。切换 workspace 后用此重建 PanelState
   * + renderer 恢复 scroll/runs。无绑定/无快照返 null。
   */
  readSnapshotForSession?(sessionId: string): Promise<{
    openedFiles: Array<{
      path: string;
      kind: string;
      external: boolean;
      origin?: OpenedFileOrigin;
    }>;
    activeFilePath: string | null;
    scroll: Record<string, { scrollTop: number; scrollLeft: number }>;
    runs: unknown;
  } | null>;
}

/**
 * v0.3.3 ADR-027:命令面板的 HTTP /run 路由回调(注入式,与 WorkspaceOps 同款)。
 * 转发给 CommandPanelService.runCommand。未注入时 /run 返 503。
 */
export interface CommandRunOps {
  /** 推送/重跑一条指令。sudo=true 时以远程 sudo 跑(仅 SSH session 生效)。返回命令面板快照。 */
  runCommand(
    sessionId: string,
    command: string,
    title: string | null,
    requestingClientId: string | null,
    sudo?: boolean,
  ): Promise<{ commands: unknown[]; activeKey: string | null }>;
}

/**
 * v0.3.3 ADR-028：pi package 事件处理回调(注入式，与 WorkspaceOps 同款)。由 index.ts
 * 闭合到 PiSessionCoordinator.handlePiSessionEvent(M2:从 SessionManager 拆出)。
 * 未注入时 /pi-session-event 返 503。
 * FilePanelService 不持 SessionManager(保持可测)，只拿这个 op 供 HTTP 路由用。
 */
export interface PiEventOps {
  /**
   * 处理 pi package 转发的事件。sessionId=terminal(Marina session)。
   * 返回 { workspaceId? }：session_start 新建 workspace 后返回 id,gateway 作为 HTTP
   * 响应体交回 bridge,bridge 用 pi.appendEntry 存进对话(下次 resume 读出带上)。
   */
  applyPiSessionEvent(
    sessionId: string,
    payload: {
      piSessionId: string;
      event:
        | 'session_start'
        | 'session_shutdown'
        | 'agent_working'
        | 'agent_settled'
        | 'name_changed';
      reason?: string;
      name?: string | null;
      /** bridge 从对话 entry 恢复的 workspaceId(resume 时带上,Marina 据此切回)。 */
      workspaceId?: string | null;
      /**
       * fork/子会话亲缘(方案 20260817 裁决 1/3):本对话文件的来源(父会话文件
       * 路径,header.parentSession)。fork/clone/pi-subagents 子会话才有。
       */
      parentSessionFile?: string | null;
      /** 父对话当前 workspace(bridge 读父文件最后一条绑定 entry 得到)。 */
      parentBinding?: string | null;
    },
  ): Promise<{ workspaceId?: string } | void>;
}

interface PanelState {
  files: OpenedFile[];
  activePath: string | null;
  /** path → fs.watch 句柄;关闭文件 / session 销毁时统一 close */
  watchers: Map<string, FSWatcher>;
  /** path → 防抖 timer */
  watchTimers: Map<string, NodeJS.Timeout>;
}

/** 注入终端 env 用(M3 后由 LocalHttpGateway.getUrl 承担,见 http/local-http-gateway.ts)。 */
/**
 * 极简 glob 匹配(只支持 `*` 与 `?`,大小写不敏感)。用于 `close --glob '*.md'`。
 *
 * @为什么不引 picomatch/minimatch:AGENTS.md 边界 2 禁止未授权新增依赖;
 *   面板关文件的场景只需要最常见的 `*`/`?`,手写一个 30 行正则转换足够,
 *   也避免引一个有自己语义(如 `**` 跨目录、brace 展开)的库带来意外。
 *
 * 匹配目标:OpenedFile.name(basename)。pattern 含 `*`/`?` 走通配;否则做
 * basename 全等(大小写不敏感,对齐 Windows 文件系统)。返回是否命中。
 */
function matchFileGlob(pattern: string, fileName: string): boolean {
  const p = pattern.toLowerCase();
  const n = fileName.toLowerCase();
  if (!p.includes('*') && !p.includes('?')) return n === p;
  // 把 glob 转成正则:先转义所有正则元字符(**含 * 和 ?**),再把转义后的 \* / \?
  // 还原成通配(.* / .)。\* / \? 也必须先转义,否则裸 * 会变成正则量词导致
  // `Nothing to repeat`(曾让 /^*\.md$/ 报错)。
  const escaped = p.replace(/[.+^${}()|[\]\\*?]/g, '\\$&');
  const re = escaped.replace(/\\\*/g, '.*').replace(/\\\?/g, '.');
  return new RegExp(`^${re}$`).test(n);
}

/** 构造 200 快照响应。 */
function snapshot(state: PanelState | undefined): FilePanelSnapshot {
  if (!state) return { files: [], activePath: null };
  return { files: state.files, activePath: state.activePath };
}

/**
 * 终端侧边文件预览面板服务。EventEmitter(沿用 SessionManager 模式):
 * - `filePanelUpdated` = 可重放的文件列表/active 状态；
 * - `filePanelNavigationRequested` = 仅一次的标题跳转意图，必须定向给当前 owner。
 * requestActivation 仅 openFile 成功时为 true(见 emitUpdated)。
 */
export class FilePanelService extends EventEmitter {
  private readonly panels = new Map<string, PanelState>();
  private lookup: FilePanelSessionLookup | null = null;
  /** v0.3.3 ADR-024:workspace 操作回调(核心面板用,见 attachWorkspaceOps 注释)。 */
  private workspaceOps: WorkspaceOps | null = null;

  constructor() {
    super();
  }

  /** 组装期后绑定 session 查询能力(见文件头"循环依赖破除")。 */
  attachSessionLookup(lookup: FilePanelSessionLookup): void {
    this.lookup = lookup;
  }

  /**
   * v0.3.3 ADR-024:注入 workspace 操作回调。
   * 注意:M3 后 workspace HTTP 路由已迁到 LocalHttpGateway,这里保留 ops 是给
   *   核心面板用 —— resolveGalleryImage 需要 getCurrentPath(gallery 缓存落盘)
   *   和 onWorkspaceSwitched 需要 readSnapshotForSession/getCurrentPath(workspace
   *   切换后重建面板)。网关侧的路由 ops 由 index.ts 注入 gateway。
   */
  attachWorkspaceOps(ops: WorkspaceOps): void {
    this.workspaceOps = ops;
  }

  /** 清掉所有 watcher + 面板(应用退出 / 测试清理用)。HTTP server 由 gateway 关。 */
  stop(): Promise<void> {
    for (const [sid] of this.panels) this.clearPanel(sid);
    this.panels.clear();
    return Promise.resolve();
  }

  // ────────────────────────────────────────────────────────────────
  // 状态机:open / show / close / get(被 REST 与 IPC UI 共用)
  // ────────────────────────────────────────────────────────────────

  /** 查某 session 当前面板快照(无 session / 无文件 → 空)。 */
  getOpenFiles(sessionId: string): FilePanelSnapshot {
    return snapshot(this.panels.get(sessionId));
  }

  /**
   * 打开文件并切为 active。已存在则等价 show(更新 mtime + 重置 watcher)。
   * 路径相对 session.currentCwd 解析;校验存在且是文件。
   *
   * @param options.origin 真正掌握来源的上游可附带语义元数据；重复普通打开同一路径
   *   时保留已有 origin，避免一次 show/open 刷新把 Git diff 的导航真值抹掉。
   * @param options.heading 可选可见标题文字；打开状态发出后再单独发一次导航请求。
   * @param options.expectedOwnerWindowId IPC 请求开始时的 owner；异步解析后原子重验。
   * @throws FilePanelError NotFound / NotFile / SessionMissing / ResolveFailed /
   *   InvalidHeadingTarget / NotOwner
   */
  async openFile(
    sessionId: string,
    rawPath: string,
    options: OpenFileOptions = {},
  ): Promise<FilePanelSnapshot> {
    const abs = await this.resolveAndStat(sessionId, rawPath);
    let state = this.panels.get(sessionId);
    const existingOrigin = state?.files.find((file) => file.path === abs)?.origin;
    const opened = await this.toOpenedFile(abs, options.origin ?? existingOrigin);
    // resolveAndStat/toOpenedFile 都跨异步文件系统边界。此后到 emit 之间没有 await，
    // 因而这里重验后，同一 event-loop turn 内的状态修改与事件发送对 owner 是原子的。
    this.requireExpectedOwner(sessionId, options.expectedOwnerWindowId);
    const heading = this.normalizeHeadingTarget(options.heading);
    if (heading && opened.kind !== 'markdown') {
      throw new FilePanelError(
        'InvalidHeadingTarget',
        `[FilePanelService] openFile heading navigation rejected for path="${abs}" kind="${opened.kind}". ` +
          'Possible causes: (1) --heading was used with a non-Markdown file, ' +
          '(2) the file extension is not recognized as Markdown. ' +
          'Open a .md/.markdown file or omit --heading, then retry.',
      );
    }
    if (!state) {
      state = { files: [], activePath: null, watchers: new Map(), watchTimers: new Map() };
      this.panels.set(sessionId, state);
    }
    const idx = state.files.findIndex((f) => f.path === abs);
    if (idx >= 0) {
      state.files[idx] = opened; // 更新 mtime/size
    } else {
      state.files.push(opened);
    }
    state.activePath = abs;
    this.ensureWatcher(sessionId, state, abs);
    // requestActivation=true:无论新增还是重复打开(更新 mtime)，用户/终端程序都
    // 期望侧边面板切到「已打开」。show/close/fs.watch 刷新走 false(见下)，不会抢
    // 用户已手动切回「文件」的焦点。统一在此发出，HTTP /open-file、IPC
    // cmd:file-panel:open、文件树点击三条入口都覆盖(它们最终都进 openFile)。
    this.emitUpdated(sessionId, state, true);
    if (heading) {
      this.emit('filePanelNavigationRequested', {
        sessionId,
        path: abs,
        heading,
        // 相同 path + heading 连续请求仍需让 renderer 的 effect 再执行一次。
        requestId: randomUUID(),
      });
    }
    return snapshot(state);
  }

  /** 仅切 active(点 tab)。文件不在列表 → 抛 NotFound(不悄悄 open)。 */
  showFile(sessionId: string, rawPath: string): FilePanelSnapshot {
    const state = this.panels.get(sessionId);
    if (!state) throw new FilePanelError('NotFound', '面板无已打开文件');
    const abs = this.normalizeForSession(sessionId, rawPath);
    if (!state.files.some((f) => f.path === abs)) {
      throw new FilePanelError('NotFound', `文件未在面板中: ${rawPath}`);
    }
    state.activePath = abs;
    this.emitUpdated(sessionId, state);
    return snapshot(state);
  }

  /**
   * 关闭一个已打开文件;若关的是 active,回退到列表前一项(或 null)。
   *
   * 匹配顺序(对齐需求:CLI `close` 可只给文件名,不必给完整路径):
   *   1. 规范化绝对路径精确匹配(renderer 的 tab × 关闭恒走这条,从不回退)。
   *   2. 精确未中 → 按 basename 大小写不敏感匹配(只给文件名的场景)。
   *      恰好一个命中 → 关它;多个同名 → 抛 NotFound("ambiguous"),提示用完整
   *      路径或 glob;零命中 → 抛 NotFound。
   *
   * @设计理由:renderer 永远传 file.path(精确命中,行为与旧版一致);CLI/agent
   *   常只拿得到文件名(用户从 list 里复制 name),basename 回退让它「关不掉」
   *   的旧痛点消失。多个同名时报错而非猜,避免误关。
   */
  closeFile(sessionId: string, rawPath: string): FilePanelSnapshot {
    const state = this.panels.get(sessionId);
    if (!state) throw new FilePanelError('NotFound', `文件未在面板中: ${rawPath}`);
    const abs = this.normalizeForSession(sessionId, rawPath);
    const target = this.resolveCloseTarget(state, abs, rawPath);
    this.stopWatcher(state, target);
    const idx = state.files.findIndex((f) => f.path === target);
    if (idx < 0) return snapshot(state); // 理论不可达(resolveCloseTarget 已保证)
    state.files.splice(idx, 1);
    if (state.activePath === target) {
      state.activePath = state.files[idx - 1]?.path ?? state.files[0]?.path ?? null;
    }
    this.emitUpdated(sessionId, state);
    return snapshot(state);
  }

  /**
   * 关闭全部已打开文件(`close --all`)。返回剩余快照(恒为空)。每关一个都
   * 停 watcher;一次性 splice 后发一次 emit(批量,不为每个文件各发一次)。
   */
  closeAllFiles(sessionId: string): FilePanelSnapshot {
    const state = this.panels.get(sessionId);
    if (!state) return snapshot(undefined);
    for (const abs of [...state.watchers.keys()]) this.stopWatcher(state, abs);
    state.files = [];
    state.activePath = null;
    this.emitUpdated(sessionId, state);
    return snapshot(state);
  }

  /**
   * 按条件批量关闭(`close --stale` / `close --glob`)。predicate 收 OpenedFile
   * 返回是否关闭。先收集要关的路径(避免 splice 边遍历边改),再停 watcher +
   * 移除,回退 active。返回关闭掉的路径列表(供 CLI 输出「关了哪些」)。
   *
   * stale 场景:调用方应先 await refreshStale(sessionId) 让 missing 字段反映
   * 磁盘真值,再以 (f) => f.missing === true 调本方法。
   */
  closeMatchingFiles(
    sessionId: string,
    predicate: (f: OpenedFile) => boolean,
  ): { snapshot: FilePanelSnapshot; closedPaths: string[] } {
    const state = this.panels.get(sessionId);
    if (!state) return { snapshot: snapshot(undefined), closedPaths: [] };
    const toClose = state.files.filter(predicate).map((f) => f.path);
    if (toClose.length === 0) return { snapshot: snapshot(state), closedPaths: [] };
    for (const abs of toClose) this.stopWatcher(state, abs);
    const set = new Set(toClose);
    state.files = state.files.filter((f) => !set.has(f.path));
    if (state.activePath && set.has(state.activePath)) {
      state.activePath = state.files[0]?.path ?? null;
    }
    this.emitUpdated(sessionId, state);
    return { snapshot: snapshot(state), closedPaths: toClose };
  }

  /**
   * 同步面板里每个文件的 missing 标记(stat 磁盘真值)。用于:
   *   - HTTP GET /opening-files:每次 list 拉取前刷一次,让 CLI `list` 标记
   *     始终反映磁盘真值(补 fs.watch 可能漏掉的事件:例如 Marina 关闭期间
   *     文件被删,或 watcher error 已停)。
   *   - close --stale:关僵尸前先刷真值。
   * 任一文件的 missing 翻转才 emit(避免每次 list 都触发空广播)。返回快照。
   */
  async refreshStale(sessionId: string): Promise<FilePanelSnapshot> {
    const state = this.panels.get(sessionId);
    if (!state) return snapshot(undefined);
    let changed = false;
    await Promise.all(
      state.files.map(async (f) => {
        const exists = await this.pathExistsAsFile(f.path);
        const want = exists ? false : true;
        if (!!f.missing !== want) {
          f.missing = want;
          changed = true;
        }
      }),
    );
    if (changed) this.emitUpdated(sessionId, state);
    return snapshot(state);
  }

  /**
   * ADR-034:所有 session 面板当前打开的文件路径(marina-file:// 协议白名单
   * 数据源)。主文档永远可服务;其所在目录由 WebFileProtocol 补充放行。
   */
  getAllOpenFilePaths(): string[] {
    const out: string[] = [];
    for (const state of this.panels.values()) {
      for (const f of state.files) out.push(f.path);
    }
    return out;
  }

  /**
   * 读已打开文件内容。仅限面板列表内路径(防 renderer 被诱导读任意文件)。
   * text/markdown → 字符串(超限截断);image → base64 dataUrl;unknown → 占位。
   */
  async readFile(sessionId: string, rawPath: string): Promise<ReadFileResponse> {
    const state = this.panels.get(sessionId);
    const abs = this.normalizeForSession(sessionId, rawPath);
    const file = state?.files.find((f) => f.path === abs);
    if (!file) {
      return { kind: 'unknown', message: `文件未在面板中: ${rawPath}` };
    }
    if (file.kind === 'unknown') {
      return { kind: 'unknown', message: '该文件类型暂不支持预览' };
    }
    if (file.kind === 'image') {
      // 预判:OpenedFile.size 来自 stat,先用它拒超大图,避免 readFile 把整文件吃进
      // 内存(50MB 图原实现会先吃满再拒)。读后再校验一次防 size 之后被换成更大的。
      if (file.size > MAX_READ_IMAGE_BYTES) {
        return {
          kind: 'unknown',
          message: `图片过大(${file.size} 字节),超过 ${MAX_READ_IMAGE_BYTES} 上限`,
        };
      }
      const buf = await fs.readFile(abs);
      if (buf.byteLength > MAX_READ_IMAGE_BYTES) {
        return {
          kind: 'unknown',
          message: `图片过大(${buf.byteLength} 字节),超过 ${MAX_READ_IMAGE_BYTES} 上限`,
        };
      }
      const ext = abs.slice(abs.lastIndexOf('.') + 1).toLowerCase();
      const mime = IMAGE_MIME[ext] ?? 'application/octet-stream';
      return { kind: 'image', dataUrl: `data:${mime};base64,${buf.toString('base64')}`, mime };
    }
    // text / markdown / diff(三种同为 UTF-8 读路径,diff 由 renderer 高亮)。
    // 'web'(ADR-034)走同一 UTF-8 读路径,但响应 kind 固定映射为 'text':预览内容
    // 不经此通道(由 marina-file:// 协议流式服务),read 只服务 WebViewer 的
    // "源码查看"模式,复用 TextViewer 渲染。
    const buf = await fs.readFile(abs);
    const truncated = buf.byteLength > MAX_READ_TEXT_BYTES;
    const text = truncated
      ? buf.subarray(0, MAX_READ_TEXT_BYTES).toString('utf8')
      : buf.toString('utf8');
    return { kind: file.kind === 'web' ? 'text' : file.kind, text, truncated };
  }

  /**
   * 读 markdown 里的本地图片为 dataUrl。src 相对 mdPath 所在目录解析(用户 md 里
   * 写的 ./img.png / 同级文件 / 绝对路径)。网络/data:/blob: src 由 renderer 直接
   * 交给 <img>,不走这里(传进来也拒)。仅读图片扩展 + 限 MAX_READ_IMAGE_BYTES。
   *
   * 安全:路径穿越(../)虽可指向 md 目录外,但 (1) 只读图片扩展名,非图片拒绝;
   * (2) dataUrl 只在本机用户自己屏幕渲染,marina 不外发 → 无内容泄露路径。
   */
  async readImageAsset(sessionId: string, mdPath: string, src: string): Promise<ReadImageResponse> {
    if (!src || typeof src !== 'string') return { error: 'empty src' };
    // 网络 / data: / blob: → renderer 直接用 <img>,不经此通道(传进来也拒)
    if (isRemoteUrl(src)) {
      return { error: 'not a local image' };
    }
    const resolved = await this.resolveLocalImageAbs(sessionId, mdPath, src);
    if ('error' in resolved) return { error: resolved.error };
    try {
      const buf = await fs.readFile(resolved.abs);
      return { dataUrl: `data:${resolved.mime};base64,${buf.toString('base64')}` };
    } catch (err) {
      return { error: `read failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * 解析本地图引用为磁盘绝对路径 + mime。复用于 readImageAsset(读 dataUrl)/
   * gallery 本地图(resolve + open),保证两条路径走**同一套**安全面:
   * decode → 成员校验 → 相对 md 目录 resolve → stat(须 isFile)→ 大小上限 → MIME 白名单。
   *
   * @returns 成功 {abs, mime};失败 {error}(不读文件内容,只 resolve+stat)。
   */
  private async resolveLocalImageAbs(
    sessionId: string,
    mdPath: string,
    src: string,
  ): Promise<{ abs: string; mime: string } | { error: string }> {
    // renderer 预处理把空格转 %20 防 CommonMark 截断(用户自己 %20 转义的也兼容)。
    // decode 还原真实文件路径 —— fs.readFile 要真实路径,不认 %20。
    let decoded = src;
    try {
      decoded = decodeURIComponent(src);
    } catch {
      // % 后非 hex 等 malformed sequence,保留原值让 resolve 尝试
    }
    // 成员校验:mdPath 必须是该 session 已打开列表里的 md 文件(与 readFile 同防线)。
    // 防 renderer 被诱导用任意 mdPath + src 读磁盘任意目录的图片 —— 此前没这道门,
    // 等于"main 按绝对路径读任意本地图"的 IPC 暴露给 renderer。
    const state = this.panels.get(sessionId);
    if (!state?.files.some((f) => f.path === mdPath)) {
      return { error: 'md file not in this panel' };
    }
    const dir = dirname(mdPath);
    let abs: string;
    try {
      abs = normalizePath(resolve(dir, decoded));
    } catch (err) {
      return {
        error: `resolve failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    let stat: Stats;
    try {
      stat = await fs.stat(abs);
    } catch {
      return { error: 'not found' };
    }
    if (!stat.isFile()) return { error: 'not a file' };
    if (stat.size > MAX_READ_IMAGE_BYTES) {
      return { error: `image too large (${stat.size} > ${MAX_READ_IMAGE_BYTES})` };
    }
    const ext = abs.slice(abs.lastIndexOf('.') + 1).toLowerCase();
    const mime = IMAGE_MIME[ext];
    if (!mime) return { error: `unsupported image type: .${ext}` };
    return { abs, mime };
  }

  /**
   * v0.3.3 Feature A(ADR-026):解析 gallery 单张图为 dataUrl。
   *
   * - 本地图:复用 resolveLocalImageAbs(成员校验 + 相对 md 目录 + 大小/MIME 上限)
   *   后读 dataUrl。与 readImageAsset 走同一安全面。
   * - 网络图(http(s)):daemon 下载到 workspace 的 `__marina_gallery__/<hash>.<ext>`
   *   缓存(超时 NETWORK_IMAGE_TIMEOUT_MS、上限 MAX_NETWORK_IMAGE_BYTES),读成 dataUrl。
   *   prod CSP `img-src 'self' data:` 禁直接渲染远程 URL,故必须落盘转 dataUrl。
   *   缓存命中(URL hash 不变)不重复下载。下载缓存随 workspace 回收。
   *
   * @副作用:网络图首次解析会在 workspace 下创建缓存子目录并写文件。
   *
   * @常见问题排查:
   * - 返回 'workspace not available' → 该 session 未绑定 workspace(workspaceOps 未注入);
   *   网络图必须落盘,无 workspace 无法缓存。
   * - 返回 'network timeout' / 'network too large' / 'network fetch failed' →
   *   检查 URL 可达性 / 图片大小 / daemon 机器网络。
   */
  async resolveGalleryImage(
    sessionId: string,
    mdPath: string,
    src: string,
  ): Promise<GalleryResolveImageResponse> {
    if (!src || typeof src !== 'string') return { error: 'empty src' };
    // 网络图:http(s) 下载落盘。data:/blob: 在 gallery 语境无意义(无运行时生成),
    // 走本地分支会被 resolveLocalImageAbs 的 MIME 校验拒。
    if (isRemoteUrl(src) && /^https?:/i.test(src)) {
      const dl = await this.downloadNetworkImage(sessionId, src);
      if ('error' in dl) return { error: dl.error };
      return { dataUrl: `data:${dl.mime};base64,${dl.buf.toString('base64')}` };
    }
    // 本地图(含 data:/blob:/无协议):复用 read-image 的解析路径
    const resolved = await this.resolveLocalImageAbs(sessionId, mdPath, src);
    if ('error' in resolved) return { error: resolved.error };
    try {
      const buf = await fs.readFile(resolved.abs);
      return { dataUrl: `data:${resolved.mime};base64,${buf.toString('base64')}` };
    } catch (err) {
      return { error: `read failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * v0.3.3 Feature A(ADR-026):把 md 引用图 resolve 成磁盘绝对路径,供 ipc 层
   * 调 shell。真实语义是"resolver",不只服务 open —— gallery/markdown 内联图的
   * open-image(shell.openPath)与 reveal-image(shell.showItemInFolder)共用本方法。
   *
   * 返回的是已 resolve 的磁盘绝对路径(本地图原路径;网络图缓存路径),
   * 由 ipc 层调 shell。**不把路径返给 renderer**(防泄露——与
   * SYSTEM_OPEN_PATH 不同,后者要求 renderer 持路径;本通道全程 main 解析)。
   *
   * 安全:本地图复用 resolveLocalImageAbs(同成员校验 + 路径解析);网络图
   * 走 downloadNetworkImage(缓存命中不重复下载)确保缓存存在后返缓存路径。
   *
   * @returns {path} 成功(ipc 层 openPath);{error} 失败。
   */
  async openGalleryImage(
    sessionId: string,
    mdPath: string,
    src: string,
  ): Promise<{ path: string } | { error: string }> {
    if (!src || typeof src !== 'string') return { error: 'empty src' };
    if (isRemoteUrl(src) && /^https?:/i.test(src)) {
      const dl = await this.downloadNetworkImage(sessionId, src);
      if ('error' in dl) return { error: dl.error };
      return { path: dl.cachePath };
    }
    const resolved = await this.resolveLocalImageAbs(sessionId, mdPath, src);
    if ('error' in resolved) return { error: resolved.error };
    return { path: resolved.abs };
  }

  /**
   * 下载网络图到 workspace 缓存并返回 Buffer + 落盘路径 + mime。缓存命中(URL
   * hash 不变)直接读磁盘不重复下载。缓存目录在 session 绑定的 workspace 下,
   * 随 workspace 回收(ADR-026 §2.5:不留全局孤儿)。
   *
   * @安全:URL 必须是 http(s)(调用方已判);用 AbortController 超时防卡死;
   *   下载流累计字节数超 MAX_NETWORK_IMAGE_BYTES 立即中断(防超大响应撑爆磁盘)。
   * @returns {buf, mime, cachePath} 成功;{error} 失败(workspace 未绑定/超时/超大/非图片)。
   */
  private async downloadNetworkImage(
    sessionId: string,
    url: string,
  ): Promise<{ buf: Buffer; mime: string; cachePath: string } | { error: string }> {
    if (!this.workspaceOps) return { error: 'workspace not available (ops not injected)' };
    const wsPath = this.workspaceOps.getCurrentPath(sessionId);
    if (!wsPath) return { error: 'workspace not available' };
    const cacheDir = resolve(wsPath, GALLERY_CACHE_DIR);
    // URL → sha1 hash 作为缓存键(不含 URL 明文入文件名,避免非法字符/长度溢出)。
    const hash = createHash('sha1').update(url).digest('hex');
    // 从 URL 路径段推扩展名;取不到或非图片扩展名 → 默认 .img(mime 用响应头定)。
    let ext = '';
    try {
      const u = new URL(url);
      const last = u.pathname.split('/').pop() ?? '';
      const dot = last.lastIndexOf('.');
      if (dot >= 0) ext = last.slice(dot + 1).toLowerCase();
    } catch {
      // 非 URL 形态(理论上不会,调用方已判 http(s)),ext 保持空
    }
    const knownExt = ext && IMAGE_MIME[ext] ? ext : 'img';
    const cachePath = resolve(cacheDir, `${hash}.${knownExt}`);
    // 缓存命中:直接读磁盘(不重复下载)。stat 失败/为空 → 走下载。
    try {
      const st = await fs.stat(cachePath);
      if (st.isFile() && st.size > 0 && st.size <= MAX_NETWORK_IMAGE_BYTES) {
        const buf = await fs.readFile(cachePath);
        const mime = IMAGE_MIME[knownExt] ?? this.sniffImageMime(buf) ?? 'application/octet-stream';
        return { buf, mime, cachePath };
      }
    } catch {
      // 缓存未命中,继续下载
    }
    // 下载:AbortController 超时 + 累计字节上限中断
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NETWORK_IMAGE_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    } catch (err) {
      return { error: `network fetch failed: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) return { error: `network fetch failed (HTTP ${resp.status})` };
    // 流式读 + 累计字节上限(防超大响应撑爆磁盘/内存)
    const reader = resp.body?.getReader();
    if (!reader) return { error: 'network fetch failed (no body)' };
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > MAX_NETWORK_IMAGE_BYTES) {
            try {
              await reader.cancel();
            } catch {
              /* ignore */
            }
            return { error: `network too large (${total} > ${MAX_NETWORK_IMAGE_BYTES})` };
          }
          chunks.push(Buffer.from(value));
        }
      }
    } catch (err) {
      return { error: `network read failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    const buf = Buffer.concat(chunks);
    if (buf.length === 0) return { error: 'network fetch failed (empty body)' };
    // mime:响应头优先,其次扩展名映射,其次 magic sniff,兜底 octet-stream
    const mime =
      resp.headers.get('content-type')?.split(';')[0]?.trim() ||
      IMAGE_MIME[knownExt] ||
      this.sniffImageMime(buf) ||
      'application/octet-stream';
    // 落盘缓存(确保目录存在)
    try {
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(cachePath, buf);
    } catch (err) {
      // 落盘失败不影响本次返回(已拿到 buf + mime);只是下次会重下。记 warn。
      logger.warn(
        MODULE,
        `gallery 缓存写入失败(不影响本次渲染): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { buf, mime, cachePath };
  }

  /**
   * 从图片字节流前几个字节嗅探 mime(fetch 无 content-type 且扩展名无映射时的兜底)。
   * 只识别最常见的几种;识别不出返 null。
   */
  private sniffImageMime(buf: Buffer): string | null {
    if (buf.length < 4) return null;
    // PNG: 89 50 4E 47
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
      return 'image/png';
    // JPEG: FF D8 FF
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    // GIF: 47 49 46 38
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38)
      return 'image/gif';
    // WebP: RIFF....WEBP
    if (
      buf.length >= 12 &&
      buf[0] === 0x52 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46 &&
      buf[3] === 0x46 &&
      buf[8] === 0x57 &&
      buf[9] === 0x45 &&
      buf[10] === 0x42 &&
      buf[11] === 0x50
    )
      return 'image/webp';
    return null;
  }

  /**
   * v0.3.3 Feature B:打开 markdown 文档里引用的**本地文件**进面板只读查看。
   *
   * 与 openFile 的区别:openFile 相对 session.currentCwd 解析(终端程序视角);
   * 本方法相对 **mdPath 所在目录** 解析(文档作者视角,与 readImageAsset 对图片
   * 的处理一致——用户心智统一:md 里写的相对路径都相对该 md 文件)。
   *
   * 安全(与 readImageAsset 同防线):
   * - mdPath 必须是该 session 已打开列表里的文件(成员校验),防 renderer 被诱导
   *   用任意 mdPath + src 打开磁盘任意文件。这是 renderer→main 的信任边界。
   * - src 走 normalizePath(resolve(dirname(mdPath), src)),再交 resolveAndStat 校验
   *   存在 + 是文件(目录拒)。穿越 ../ 可指向 md 目录外,但只进只读面板、不外发。
   *
   * @throws FilePanelError ResolveFailed(src 空/畸形)/ SessionMissing / NotFound /
   *   NotFile / 以及 toOpenedFile/detect 的内部错误。renderer 收到后 toast 提示。
   *
   * @returns 打开后的面板快照(与 openFile 同形,含新增/更新后的文件列表 + active)。
   */
  async openFileFromMarkdown(
    sessionId: string,
    mdPath: string,
    src: string,
    options: { heading?: string } = {},
  ): Promise<FilePanelSnapshot> {
    if (!src || typeof src !== 'string') {
      throw new FilePanelError('ResolveFailed', '链接路径为空');
    }
    // 网络/data:/blob:/mailto:/tel: 不该走到这(renderer MdLink 已按决策 #4 把
    // http(s)/mailto 当外链走 open-external,其余才进本地分支)。传进来也拒,
    // 与 readImageAsset 一致。
    if (isRemoteUrl(src)) {
      throw new FilePanelError('ResolveFailed', '远程链接不走本地文件打开');
    }
    // 成员校验:mdPath 必须是该 session 已打开列表里的文件(与 readImageAsset 同防线)。
    const state = this.panels.get(sessionId);
    if (!state?.files.some((f) => f.path === mdPath)) {
      throw new FilePanelError('NotFound', '源 markdown 文件不在当前面板');
    }
    // 相对 md 目录解析 + 规范化。decodeURIComponent 兼容 %20 等转义(与 readImageAsset
    // 一致;renderer 的 normalizeMdImageSources 对图片做了空格转义,链接 href 由
    // react-markdown 给原值,这里统一 decode 容错)。
    let decoded = src;
    try {
      decoded = decodeURIComponent(src);
    } catch {
      // malformed % 序列,保留原值让 resolve 尝试
    }
    let abs: string;
    try {
      abs = normalizePath(resolve(dirname(mdPath), decoded));
    } catch (err) {
      throw new FilePanelError(
        'ResolveFailed',
        `路径解析失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // 校验存在 + 是文件(目录拒,与 openFile 的 resolveAndStat 一致)。直接复用
    // openFile(sessionId, abs):绝对路径会忽略 currentCwd base,走完整状态机
    // (加/更新 tab、切 active、ensureWatcher、requestActivation),零重复逻辑。
    // options.heading(v0.3.3 ADR-035,marina:show 链接用)透传给 openFile:打开后
    // 单发一次 filePanelNavigationRequested 导航意图。
    return this.openFile(sessionId, abs, {
      ...(options.heading === undefined ? {} : { heading: options.heading }),
    });
  }

  /** session 销毁:清掉该 session 全部 watcher + 状态(ipc wireEventBroadcasts 调)。 */
  onSessionDestroyed(sessionId: string): void {
    if (!this.panels.has(sessionId)) return;
    this.clearPanel(sessionId);
    this.panels.delete(sessionId);
  }

  // ────────────────────────────────────────────────────────────────
  // 内部:路径解析 / stat / watcher / emit
  // ────────────────────────────────────────────────────────────────

  /**
   * 解析路径为规范化绝对路径并 stat。
   * 相对路径按 session.currentCwd join(终端程序 `open_file(tid,'README.md')`
   * 的典型用法)。SSH 远程 cwd 会让 fs.stat 失败 → 抛错,天然隔离。
   */
  private async resolveAndStat(sessionId: string, rawPath: string): Promise<string> {
    if (!rawPath || typeof rawPath !== 'string') {
      throw new FilePanelError('ResolveFailed', 'path 为空');
    }
    const info = this.lookup?.get(sessionId);
    if (!info) throw new FilePanelError('SessionMissing', `未知 terminal: ${sessionId}`);
    const base = info.currentCwd || process.cwd();
    // v0.3.x:Shell home 展开。rawPath 以 ~ 开头(裸 ~、~/x、~\x)→ os.homedir() 替换。
    // 仅作首字符(Shell 语义);中间的 ~ 是合法文件名字符,不动。展开后是绝对路径,
    // resolve(base, ...) 会忽略 base,正确。
    let p = rawPath;
    if (p === '~') {
      p = homedir();
    } else if (p.startsWith('~/') || p.startsWith('~\\')) {
      p = join(homedir(), p.slice(2));
    }
    let abs: string;
    try {
      // resolve(base, p):p 绝对(含 ~ 展开后的)则忽略 base;相对则拼到 session cwd 上。
      // 再过 normalizePath 规范化(卷符大写 / 去 trailing sep),与 path id 一致。
      abs = normalizePath(resolve(base, p));
    } catch (err) {
      throw new FilePanelError(
        'ResolveFailed',
        `路径解析失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let stat: Stats;
    try {
      stat = await fs.stat(abs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new FilePanelError('NotFound', `文件不存在: ${abs}`);
      }
      throw new FilePanelError(
        'ResolveFailed',
        `stat 失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!stat.isFile()) {
      throw new FilePanelError('NotFile', `不是文件(可能是目录): ${abs}`);
    }
    return abs;
  }

  /** show/close 用:只规范化,不 stat(路径必已在列表里,不再二次校验磁盘)。 */
  private normalizeForSession(sessionId: string, rawPath: string): string {
    const info = this.lookup?.get(sessionId);
    const base = info?.currentCwd || process.cwd();
    return normalizePath(resolve(base, rawPath));
  }

  /**
   * closeFile 的匹配核心:先精确,后 basename 回退。
   * - 精确命中 → 返回该规范化路径。
   * - 否则按 basename 大小写不敏感找;唯一命中 → 返回它;多个 → 抛 NotFound
   *   (ambiguous);零 → 抛 NotFound。
   * @param abs rawPath 规范化后的绝对路径(精确匹配用)
   * @param rawPath 原始入参(basename 回退用,避免从 abs 反推 basename 被
   *   resolve 改变大小写)。
   */
  private resolveCloseTarget(state: PanelState, abs: string, rawPath: string): string {
    if (state.files.some((f) => f.path === abs)) return abs;
    // basename 回退:rawPath 可能是相对名(report.md)。取其 basename 做比较。
    const wantName = basename(abs).toLowerCase();
    const byName = state.files.filter((f) => f.name.toLowerCase() === wantName);
    if (byName.length === 1) return byName[0]!.path;
    if (byName.length > 1) {
      throw new FilePanelError(
        'NotFound',
        `多个已打开文件名为 "${wantName}"(${byName.length} 个),请用完整路径或 glob 指定: ${byName.map((f) => f.path).join(', ')}`,
      );
    }
    throw new FilePanelError('NotFound', `文件未在面板中: ${rawPath}`);
  }

  /** stat 路径是否仍是普通文件(ENOENT / 目录 / 不可达 → false)。refreshStale 用。 */
  private async pathExistsAsFile(abs: string): Promise<boolean> {
    try {
      const s = await fs.stat(abs);
      return s.isFile();
    } catch {
      return false;
    }
  }

  private async toOpenedFile(abs: string, origin?: OpenedFileOrigin): Promise<OpenedFile> {
    const stat = await fs.stat(abs);
    return {
      path: abs,
      name: basename(abs),
      kind: detectFileKind(basename(abs)),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ...(origin ? { origin } : {}),
    };
  }

  private ensureWatcher(sessionId: string, state: PanelState, abs: string): void {
    // 已有 watcher:先关旧的(文件可能被替换为不同 inode,旧句柄失效)
    this.stopWatcher(state, abs);
    try {
      const w = watch(abs, () => this.scheduleRefresh(sessionId, state, abs));
      w.on('error', (err) => {
        // 文件被删 / 权限丢失等。不致命:面板项保留,下次 read 时报错。
        logger.warn(MODULE, `watch error on ${abs}: ${err.message}`);
        this.stopWatcher(state, abs);
      });
      state.watchers.set(abs, w);
    } catch (err) {
      // 某些文件系统 / 网络盘不支持 watch。降级:不自动刷新,其余功能不受影响。
      logger.warn(
        MODULE,
        `watch unavailable for ${abs}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private stopWatcher(state: PanelState, abs: string): void {
    const t = state.watchTimers.get(abs);
    if (t) {
      clearTimeout(t);
      state.watchTimers.delete(abs);
    }
    const w = state.watchers.get(abs);
    if (w) {
      try {
        w.close();
      } catch {
        /* ignore — 关闭幂等 */
      }
      state.watchers.delete(abs);
    }
  }

  /** fs.watch 防抖:编辑器连发多个 change 事件时,只触发一次重 stat + emit。 */
  private scheduleRefresh(sessionId: string, state: PanelState, abs: string): void {
    const existing = state.watchTimers.get(abs);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      state.watchTimers.delete(abs);
      void this.refreshOne(sessionId, state, abs);
    }, WATCH_DEBOUNCE_MS);
    state.watchTimers.set(abs, timer);
  }

  private async refreshOne(sessionId: string, state: PanelState, abs: string): Promise<void> {
    const idx = state.files.findIndex((f) => f.path === abs);
    if (idx < 0) return;
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) return;
      // 文件还在:刷新 size/mtime 并清掉可能的 missing 标记。
      const before = state.files[idx]!;
      state.files[idx] = {
        ...before,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        // 之前被标 missing(僵尸)而文件又回来了 → 清除标记。
        missing: false,
      };
      this.emitUpdated(sessionId, state);
    } catch (err) {
      // 文件被删等:保留条目(可能只是临时不可达),标 missing 让 CLI `list`
      // /面板能展示「该 tab 指向的文件已删」。文件重新出现会在下次 change 事件
      // 或 refreshStale 里清回 false。ENOENT 是常态;其它异常也降级为 missing
      // (用户会在 list 里看到,而不是一个静默陈旧的 mtime)。
      const code = (err as NodeJS.ErrnoException).code;
      const before = state.files[idx]!;
      if (!before.missing) {
        state.files[idx] = { ...before, missing: true };
        this.emitUpdated(sessionId, state);
      }
      if (code !== 'ENOENT') {
        logger.warn(
          MODULE,
          `refresh stat failed for ${abs}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * emit 'filePanelUpdated'。openFile 调用方传 requestActivation=true；show / close /
   * fs.watch 刷新用默认 false，不触发面板激活(不抢用户焦点)。
   */
  private emitUpdated(sessionId: string, state: PanelState, requestActivation = false): void {
    this.emit('filePanelUpdated', {
      sessionId,
      files: state.files,
      activePath: state.activePath,
      requestActivation,
    });
  }

  /**
   * 校验并规范化外部可见标题文字。这里只做边界校验，不读/解析 Markdown；实际匹配
   * 在 renderer 已有 AST/DOM 上完成，避免 Main 为一次 view intent 重读文件。
   */
  private requireExpectedOwner(sessionId: string, expectedOwnerWindowId: string | undefined): void {
    if (expectedOwnerWindowId === undefined) return;
    const session = this.lookup?.get(sessionId) ?? null;
    if (!session) {
      throw new FilePanelError(
        'SessionMissing',
        `[FilePanelService] openFile owner revalidation failed for sessionId="${sessionId}". ` +
          'Possible causes: (1) the session was destroyed while resolving the path, ' +
          '(2) renderer state is stale. Refresh application state and retry.',
      );
    }
    if (session.ownerWindowId !== expectedOwnerWindowId) {
      throw new FilePanelError(
        'NotOwner',
        `[FilePanelService] openFile owner changed while resolving sessionId="${sessionId}" ` +
          `expectedOwner="${expectedOwnerWindowId}" actualOwner="${session.ownerWindowId}". ` +
          'Possible causes: (1) another window claimed the session, (2) the initiating window closed. ' +
          'Retry from the current owner window.',
      );
    }
  }

  private normalizeHeadingTarget(raw: string | undefined): string | undefined {
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string') {
      throw new FilePanelError(
        'InvalidHeadingTarget',
        `[FilePanelService] openFile received a non-string heading target (type="${typeof raw}"). ` +
          'Possible causes: (1) a malformed HTTP client body, (2) an outdated custom client. ' +
          'Send heading as a UTF-8 string or omit the field.',
      );
    }
    const heading = raw.trim();
    const hasControlCharacter = [...heading].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    });
    if (!heading || heading.length > MAX_HEADING_TARGET_LENGTH || hasControlCharacter) {
      throw new FilePanelError(
        'InvalidHeadingTarget',
        `[FilePanelService] openFile received an invalid heading target (length=${heading.length}). ` +
          `Possible causes: (1) the heading is blank, (2) it exceeds ${MAX_HEADING_TARGET_LENGTH} characters, ` +
          '(3) it contains control characters. Pass the visible Markdown heading text and retry.',
      );
    }
    return heading;
  }

  /**
   * v0.3.3 Feature D 接线:workspace 切换完成后(bind/new/unpin 后,由 SessionManager
   * 通过注入的 notify 回调调本方法)重建该 session 的文件面板状态。
   *
   * 流程:① 读新 workspace 快照(readSnapshotForSession)② 相对路径拼 workspace 根转绝对
   * (external 的绝对路径原样保留)③ 清旧 watchers + 重建 PanelState ④ emit filePanelUpdated
   * (renderer 同步 openedFiles/activePath)⑤ emit 'workspaceChanged'(ipc 广播
   * evt:workspace:changed,renderer 据此调 restoreWorkspaceSnapshot 恢复 scroll/runs)。
   *
   * 快照缺失(新空 workspace / 损坏)→ PanelState 清空(files=[]),符合 new 语义。
   * 快照里的文件磁盘上已不存在 → 仍加入(用户能看到 tab,打开时 read 失败提示),
   * 与「打开过就保留」的产品语义一致(CLI list 标 !deleted)。
   */
  async onWorkspaceSwitched(sessionId: string): Promise<void> {
    if (!this.workspaceOps?.readSnapshotForSession) return;
    // 清旧 PanelState 的 watchers(避免泄漏 + 旧 watcher 触发误 emit)。
    const old = this.panels.get(sessionId);
    if (old) {
      for (const abs of [...old.watchers.keys()]) this.stopWatcher(old, abs);
      for (const t of old.watchTimers.values()) clearTimeout(t);
      old.watchTimers.clear();
    }
    let files: OpenedFile[] = [];
    let activePath: string | null = null;
    try {
      const snap = await this.workspaceOps.readSnapshotForSession(sessionId);
      if (snap) {
        const wsDir = this.workspaceOps.getCurrentPath(sessionId);
        // 逐文件 stat 拿 size/mtimeMs(失败=文件不存在,标 missing)。串行 stat(N 小,
        // 且避免并发 fs 压力);全失败也不阻塞(降级 missing)。
        files = await Promise.all(
          snap.openedFiles.map(async (f): Promise<OpenedFile> => {
            const abs =
              f.external || isAbsolute(f.path) ? f.path : wsDir ? join(wsDir, f.path) : f.path;
            try {
              const st = await fs.stat(abs);
              return {
                path: abs,
                name: basename(abs),
                // ADR-034:kind 按文件名重检测,不信任快照存储值 —— 旧快照里
                // .html 存的是 'text'(WebViewer 之前的时代),重开应自动升级为
                // 'web';detectFileKind 与 openFile 同源,恢复后的面板与新开一致。
                kind: detectFileKind(basename(abs)),
                size: st.size,
                mtimeMs: st.mtimeMs,
                ...(f.origin ? { origin: f.origin } : {}),
              };
            } catch {
              return {
                path: abs,
                name: basename(abs),
                kind: detectFileKind(basename(abs)),
                size: 0,
                mtimeMs: 0,
                missing: true,
                ...(f.origin ? { origin: f.origin } : {}),
              };
            }
          }),
        );
        activePath = snap.activeFilePath
          ? snap.openedFiles.find((f) => f.path === snap.activeFilePath)?.external ||
            isAbsolute(snap.activeFilePath)
            ? snap.activeFilePath
            : wsDir
              ? join(wsDir, snap.activeFilePath)
              : snap.activeFilePath
          : null;
      }
    } catch (err) {
      // 快照读失败不阻塞切换;降级为空面板(用户可重新打开)。
      console.warn('[file-panel] onWorkspaceSwitched readSnapshot failed:', err);
    }
    // 重建 PanelState(保留 watchers/watchTimers 容器,后续 openFile 会按需建 watcher)。
    const state: PanelState = { files, activePath, watchers: new Map(), watchTimers: new Map() };
    this.panels.set(sessionId, state);
    // renderer 同步 openedFiles/activePath(现有 FILE_PANEL_UPDATED 链路)。
    this.emitUpdated(sessionId, state);
    // renderer 恢复 scroll/runs(独立事件,因 main PanelState 不存这俩)。
    this.emit('workspaceChanged', { sessionId });
  }

  private clearPanel(sessionId: string): void {
    const state = this.panels.get(sessionId);
    if (!state) return;
    for (const abs of [...state.watchers.keys()]) this.stopWatcher(state, abs);
  }

  // ────────────────────────────────────────────────────────────────
  // HTTP 路由
  // ────────────────────────────────────────────────────────────────

  async handleOpeningFiles(res: ServerResponse, terminal: string): Promise<void> {
    try {
      const snap = await this.refreshStale(terminal);
      send(res, 200, snap);
    } catch (err) {
      this.sendError(res, err);
    }
  }

  /**
   * POST /close-files 批量关。body:
   *   { terminal, mode: 'all' | 'stale' | 'glob', pattern?: string }
   * - all:关全部。
   * - stale:先 refreshStale 刷磁盘真值,再关所有 missing===true。
   * - glob:按 basename glob(pattern 必填,支持 `*`/`?`)。
   * 返回 { files, activePath, closed } —— closed 是被关路径列表,供 CLI 输出。
   */
  async handleCloseFiles(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: { terminal?: string; mode?: string; pattern?: string };
    try {
      body = JSON.parse(await readBody(req)) as {
        terminal?: string;
        mode?: string;
        pattern?: string;
      };
    } catch {
      return send(res, 400, { error: 'invalid JSON body' });
    }
    const { terminal, mode, pattern } = body;
    if (!terminal) return send(res, 400, { error: 'body 需要 { terminal }' });
    if (mode !== 'all' && mode !== 'stale' && mode !== 'glob') {
      return send(res, 400, { error: "body.mode 必须是 'all' | 'stale' | 'glob'" });
    }
    if (mode === 'glob' && !pattern) {
      return send(res, 400, { error: "mode='glob' 需要 pattern" });
    }
    try {
      if (mode === 'all') {
        // 先抓当前列表再关(closeAllFiles 后 snap.files 已空),用于 closed 回包。
        const before = this.getOpenFiles(terminal);
        const snap = this.closeAllFiles(terminal);
        send(res, 200, { ...snap, closed: before.files.map((f) => f.path) });
        return;
      }
      if (mode === 'stale') {
        await this.refreshStale(terminal);
        const { snapshot: snap, closedPaths } = this.closeMatchingFiles(
          terminal,
          (f) => f.missing === true,
        );
        send(res, 200, { ...snap, closed: closedPaths });
        return;
      }
      // glob
      const pat = pattern as string;
      const { snapshot: snap, closedPaths } = this.closeMatchingFiles(terminal, (f) =>
        matchFileGlob(pat, f.name),
      );
      send(res, 200, { ...snap, closed: closedPaths });
    } catch (err) {
      this.sendError(res, err);
    }
  }

  async handlePost(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    let body: { terminal?: string; path?: string; heading?: unknown };
    try {
      body = JSON.parse(await readBody(req)) as {
        terminal?: string;
        path?: string;
        heading?: unknown;
      };
    } catch {
      return send(res, 400, { error: 'invalid JSON body' });
    }
    const { terminal, path, heading } = body;
    if (!terminal || !path) {
      return send(res, 400, { error: 'body 需要 { terminal, path }' });
    }
    if (heading !== undefined && typeof heading !== 'string') {
      return send(res, 400, { error: 'body.heading 必须是 string' });
    }
    try {
      let result: FilePanelSnapshot;
      if (pathname === '/open-file') {
        result = await this.openFile(terminal, path, heading === undefined ? {} : { heading });
      } else if (pathname === '/show-file') result = this.showFile(terminal, path);
      else result = this.closeFile(terminal, path);
      send(res, 200, result);
    } catch (err) {
      this.sendError(res, err);
    }
  }

  /**
   * v0.3.3 ADR-027:POST /run。body {terminal, command, title?}。转发给注入的
   * commandRunOps(CommandPanelService)。成功返命令面板快照;失败(SSH/shell/spawn/
   * session 缺失)返 400 + error。ops 未注入返 503。
   */
  private sendError(res: ServerResponse, err: unknown): void {
    if (err instanceof FilePanelError) {
      const status = err.code === 'NotFound' ? 404 : err.code === 'SessionMissing' ? 404 : 400; // NotFile / ResolveFailed
      send(res, status, { error: err.message, code: err.code });
      return;
    }
    logger.error(MODULE, 'unexpected error', err);
    send(res, 500, { error: 'internal error' });
  }
}

/** FilePanelService 抛的业务错误,带 code 供 HTTP 层映射状态码。 */
export class FilePanelError extends Error {
  constructor(
    readonly code:
      | 'NotFound'
      | 'NotFile'
      | 'SessionMissing'
      | 'ResolveFailed'
      | 'InvalidHeadingTarget'
      | 'NotOwner',
    message: string,
  ) {
    super(message);
    this.name = 'FilePanelError';
  }
}
