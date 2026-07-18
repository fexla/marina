/**
 * @file src/main/file-panel-service.ts
 * @purpose 终端侧边文件预览面板的"大脑":本机 HTTP 服务 + 每终端的已打开文件
 *   状态机 + 文件内容读取 + 变更自动刷新。
 *
 * @工作原理:
 * 终端里跑的程序(agent / 脚本 / CLI)经注入的环境变量(MARINA_SERVICE /
 * MARINA_TOKEN / TERMINAL_ID)调本服务的 RESTful 接口,把文件"打开 / 切换 /
 * 关闭"到**绑定该终端**的侧边面板。本服务是这些状态的**唯一源**,任何变化
 * emit 'filePanelUpdated',由 ipc 层路由给该 session 的 owner 窗口渲染。
 *
 * @关键设计:
 * - 唯一状态源:Map<sessionId, PanelState>。REST 只改面板视图(开/关/切),
 *   不在 HTTP 上提供"任意文件读"——读内容走 renderer→main 的 cmd:file-panel:read,
 *   且仅限已打开列表里的路径。安全面因此被压到最小。
 * - 安全面收口:
 *     * HTTP 只绑 127.0.0.1(loopback),本机其它用户进程也走不到别的登录会话
 *     * 每次 start 生成随机 Bearer token,注入 MARINA_TOKEN;请求必须带
 *       Authorization: Bearer <token>,否则 401
 *     * 路径经 normalizePath 规范化 + fs.stat 校验"存在且是文件",相对路径
 *       按 session.currentCwd 解析(防 ../../穿越到任意文件被打开预览)
 * - 自动刷新:每个已打开文件起 fs.watch,200ms 防抖;变更 → 重 stat 更新
 *   mtimeMs/size → emit。renderer 的 viewer 把 mtimeMs 列入 effect 依赖,
 *   变化即重新 read,实现"文件改了面板自动刷新"。
 * - 大小上限:text/markdown 2MB(超出截断 + truncated 标记,镜像 scrollback
 *   ring 的尾部裁切哲学);image 10MB(超出拒绝,避免 base64 撑爆 IPC)。
 *
 * @SSH 限制:SSH 会话的 currentCwd 是远程路径,且远程进程根本到不了本机
 *   127.0.0.1(除非反向隧道,超出 v1)。所以本功能 v1 仅实质支持本地终端;
 *   即便 SSH 程序误调,fs.stat 远程路径会失败 → 返回错误,安全无副作用。
 *
 * @循环依赖破除:FilePanelService 需要 sessionManager.get() 拿 currentCwd/
 *   owner;SessionManager 需要 filePanelService.getUrl() 注入 env。解法是
 *   "组装顺序":index.ts 先 new FilePanelService → start() → new SessionManager
 *   (经 options 传 filePanelService)→ filePanelService.attachSessionLookup(sm)。
 *   env 注入发生在 createSession(IPC 触发,必在组装完成之后),时序安全。
 *
 * @对应:docs/ipc-protocol.md(file-panel 域);src/shared/protocol.ts
 *   FILE_PANEL_* channel;src/main/session-manager.ts env 注入;
 *   src/main/ipc.ts wireEventBroadcasts 事件路由。
 */
import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { promises as fs, watch, type FSWatcher, type Stats } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import type { OpenedFile } from '@shared/types';
import { detectFileKind } from '@shared/file-kind';
import type { FilePanelSnapshot, ReadFileResponse, ReadImageResponse } from '@shared/protocol';
import { isRemoteUrl } from '@shared/url-scheme';
import { normalizePath } from './path-manager';
import { logger } from './logger';

const MODULE = 'FilePanelService';

/** text/markdown 读取上限(字节)。超出按尾部裁切 + truncated 标记。 */
const MAX_READ_TEXT_BYTES = 2 * 1024 * 1024;
/** 图片读取上限(字节)。超出直接拒绝(base64 会撑爆 IPC)。 */
const MAX_READ_IMAGE_BYTES = 10 * 1024 * 1024;
/** fs.watch 防抖间隔(ms):编辑器连续保存时只触发一次刷新。 */
const WATCH_DEBOUNCE_MS = 200;
/** 绑定地址:仅回环,本机外部网络不可达。 */
const HOST = '127.0.0.1';

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

interface PanelState {
  files: OpenedFile[];
  activePath: string | null;
  /** path → fs.watch 句柄;关闭文件 / session 销毁时统一 close */
  watchers: Map<string, FSWatcher>;
  /** path → 防抖 timer */
  watchTimers: Map<string, NodeJS.Timeout>;
}

/** start() 的注入参数。enabled=false → 不起服务,getUrl() 返回 null。 */
export interface FilePanelServiceOptions {
  enabled: boolean;
  /** 0 = 让系统分配空闲端口;正整数 = 尝试固定端口(占用回退自动并 warn) */
  port: number;
}

/** 构造 200 快照响应。 */
function snapshot(state: PanelState | undefined): FilePanelSnapshot {
  if (!state) return { files: [], activePath: null };
  return { files: state.files, activePath: state.activePath };
}

/**
 * 终端侧边文件预览面板服务。EventEmitter(沿用 SessionManager 模式):
 * emit 'filePanelUpdated' = { sessionId, files, activePath, requestActivation }
 * (requestActivation 仅 openFile 成功时为 true,见 emitUpdated)。
 */
export class FilePanelService extends EventEmitter {
  private readonly panels = new Map<string, PanelState>();
  private lookup: FilePanelSessionLookup | null = null;
  private server: Server | null = null;
  private baseUrl: string | null = null;
  private token: string | null = null;
  /**
   * enabled / wantPort 在 start() 时按"已加载的用户 settings"赋值,不在构造
   * 期读 —— index.ts 里 SessionManager 构造先持有 service 引用,而 settings
   * 要到 settingsManager.initialize() 之后才可用。构造无参,避免时序耦合。
   */
  private enabled = false;
  private wantPort = 0;

  constructor() {
    super();
  }

  /** 组装期后绑定 session 查询能力(见文件头"循环依赖破除")。 */
  attachSessionLookup(lookup: FilePanelSessionLookup): void {
    this.lookup = lookup;
  }

  /** 注入终端 env 用:返回服务地址 + token;未启动 / 被禁用时返回 null。 */
  getUrl(): { baseUrl: string; token: string } | null {
    if (!this.enabled || !this.baseUrl || !this.token) return null;
    return { baseUrl: this.baseUrl, token: this.token };
  }

  /**
   * 启动 HTTP 服务。enabled=false 时 no-op。端口优先用 wantPort,被占用
   * 回退系统分配(0)并 log warn。失败抛错让上层决定(不静默吞,与项目惯例
   * 一致——logger 文件头强调"出问题时开发者能调试")。
   */
  async start(opts: FilePanelServiceOptions): Promise<{ baseUrl: string; token: string } | null> {
    this.enabled = opts.enabled;
    this.wantPort = opts.port;
    if (!this.enabled) {
      logger.info(MODULE, 'start: disabled (settings.filePanel.enabled=false), skip');
      return null;
    }
    if (this.server) return this.getUrl();

    this.token = randomBytes(24).toString('hex');
    this.server = createServer((req, res) => this.handle(req, res));

    await this.listenWithFallback();
    this.baseUrl = `http://${HOST}:${this.actualPort()}`;
    logger.info(MODULE, `HTTP listening on ${this.baseUrl} (token len=${this.token.length})`);
    return this.getUrl();
  }

  /** 尝试 wantPort,失败(EADDRINUSE)回退 0(系统分配)。 */
  private async listenWithFallback(): Promise<void> {
    const tryListen = (port: number): Promise<void> =>
      new Promise((resolve, reject) => {
        const srv = this.server!;
        const onError = (err: NodeJS.ErrnoException): void => {
          srv.off('listening', onListening);
          reject(err);
        };
        const onListening = (): void => {
          srv.off('error', onError);
          resolve();
        };
        srv.once('error', onError);
        srv.once('listening', onListening);
        srv.listen(port, HOST);
      });

    try {
      if (this.wantPort > 0) {
        await tryListen(this.wantPort);
      } else {
        await tryListen(0);
      }
    } catch (err) {
      if (this.wantPort > 0 && (err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        logger.warn(MODULE, `port ${this.wantPort} busy, falling back to auto-assigned port`);
        await tryListen(0);
      } else {
        throw err;
      }
    }
  }

  private actualPort(): number {
    const addr = this.server?.address();
    return addr && typeof addr === 'object' ? addr.port : 0;
  }

  /** 关闭服务 + 清掉所有 watcher(应用退出 / 测试清理用)。 */
  stop(): Promise<void> {
    for (const [sid] of this.panels) this.clearPanel(sid);
    this.panels.clear();
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => {
        this.server = null;
        this.baseUrl = null;
        resolve();
      });
    });
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
   * @throws FilePanelError NotFound / NotFile / SessionMissing / ResolveFailed
   */
  async openFile(sessionId: string, rawPath: string): Promise<FilePanelSnapshot> {
    const abs = await this.resolveAndStat(sessionId, rawPath);
    const opened = await this.toOpenedFile(abs);
    let state = this.panels.get(sessionId);
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

  /** 关闭一个已打开文件;若关的是 active,回退到列表前一项(或 null)。 */
  closeFile(sessionId: string, rawPath: string): FilePanelSnapshot {
    const state = this.panels.get(sessionId);
    if (!state) return snapshot(undefined);
    const abs = this.normalizeForSession(sessionId, rawPath);
    this.stopWatcher(state, abs);
    const idx = state.files.findIndex((f) => f.path === abs);
    if (idx < 0) return snapshot(state);
    state.files.splice(idx, 1);
    if (state.activePath === abs) {
      state.activePath = state.files[idx - 1]?.path ?? state.files[0]?.path ?? null;
    }
    this.emitUpdated(sessionId, state);
    return snapshot(state);
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
    // text / markdown
    const buf = await fs.readFile(abs);
    const truncated = buf.byteLength > MAX_READ_TEXT_BYTES;
    const text = truncated
      ? buf.subarray(0, MAX_READ_TEXT_BYTES).toString('utf8')
      : buf.toString('utf8');
    return { kind: file.kind, text, truncated };
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
    // renderer 预处理把空格转 %20 防 CommonMark 截断(用户自己 %20 转义的也兼容)。
    // decode 还原真实文件路径 —— fs.readFile 要真实路径,不认 %20。
    let decoded = src;
    try {
      decoded = decodeURIComponent(src);
    } catch {
      // % 后非 hex 等 malformed sequence,保留原值让 resolve 尝试
    }
    // 网络 / data: / blob: → renderer 直接用 <img>,不经此通道(传进来也拒)
    if (isRemoteUrl(decoded)) {
      return { error: 'not a local image' };
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
    try {
      const buf = await fs.readFile(abs);
      return { dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
    } catch (err) {
      return { error: `read failed: ${err instanceof Error ? err.message : String(err)}` };
    }
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
    let abs: string;
    try {
      // resolve(base, rawPath):rawPath 绝对则忽略 base;相对则拼到 session cwd 上。
      // 再过 normalizePath 规范化(卷符大写 / 去 trailing sep),与 path id 一致。
      abs = normalizePath(resolve(base, rawPath));
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

  private async toOpenedFile(abs: string): Promise<OpenedFile> {
    const stat = await fs.stat(abs);
    return {
      path: abs,
      name: basename(abs),
      kind: detectFileKind(basename(abs)),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
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
      state.files[idx] = {
        ...state.files[idx]!,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
      this.emitUpdated(sessionId, state);
    } catch (err) {
      // 文件被删等:保留条目,下次 read 报错给用户。不主动移除(可能只是临时不可达)。
      logger.warn(
        MODULE,
        `refresh stat failed for ${abs}: ${err instanceof Error ? err.message : String(err)}`,
      );
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

  private clearPanel(sessionId: string): void {
    const state = this.panels.get(sessionId);
    if (!state) return;
    for (const abs of [...state.watchers.keys()]) this.stopWatcher(state, abs);
  }

  // ────────────────────────────────────────────────────────────────
  // HTTP 路由
  // ────────────────────────────────────────────────────────────────

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const u = new URL(req.url ?? '/', this.baseUrl ?? `http://${HOST}`);
    const method = req.method ?? 'GET';

    // GET /health 是唯一的免鉴权端点:纯存活探测,给终端里跑的 agent 脚本
    // (marina ping)用。必须放在 checkAuth 之前 —— 否则未注入 MARINA_TOKEN
    // 的进程探不到活,无法和"Marina 没在跑"区分。返回体不含敏感信息;
    // HTTP 只绑 127.0.0.1 已是第一道防线(见文件头"安全面收口")。
    if (method === 'GET' && u.pathname === '/health') {
      this.send(res, 200, { ok: true, marina: true });
      return;
    }

    // 其余所有接口都要鉴权(包括 GET)。先校验 token,再路由。
    if (!this.checkAuth(req)) {
      this.send(res, 401, { error: 'unauthorized: invalid or missing token' });
      return;
    }
    const terminal = u.searchParams.get('terminal') ?? undefined;

    // GET /opening-files?terminal=<id>
    if (method === 'GET' && u.pathname === '/opening-files') {
      if (!terminal) return this.send(res, 400, { error: 'missing query: terminal' });
      return this.send(res, 200, this.getOpenFiles(terminal));
    }

    // POST /open-file | /show-file | /close-file  body {terminal, path}
    if (
      method === 'POST' &&
      (u.pathname === '/open-file' || u.pathname === '/show-file' || u.pathname === '/close-file')
    ) {
      void this.handlePost(req, res, u.pathname);
      return;
    }

    this.send(res, 404, { error: `not found: ${method} ${u.pathname}` });
  }

  private async handlePost(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<void> {
    let body: { terminal?: string; path?: string };
    try {
      body = JSON.parse(await this.readBody(req)) as { terminal?: string; path?: string };
    } catch {
      return this.send(res, 400, { error: 'invalid JSON body' });
    }
    const { terminal, path } = body;
    if (!terminal || !path) {
      return this.send(res, 400, { error: 'body 需要 { terminal, path }' });
    }
    try {
      let result: FilePanelSnapshot;
      if (pathname === '/open-file') result = await this.openFile(terminal, path);
      else if (pathname === '/show-file') result = this.showFile(terminal, path);
      else result = this.closeFile(terminal, path);
      this.send(res, 200, result);
    } catch (err) {
      this.sendError(res, err);
    }
  }

  private sendError(res: ServerResponse, err: unknown): void {
    if (err instanceof FilePanelError) {
      const status = err.code === 'NotFound' ? 404 : err.code === 'SessionMissing' ? 404 : 400; // NotFile / ResolveFailed
      this.send(res, status, { error: err.message, code: err.code });
      return;
    }
    logger.error(MODULE, 'unexpected error', err);
    this.send(res, 500, { error: 'internal error' });
  }

  private checkAuth(req: IncomingMessage): boolean {
    if (!this.token) return false;
    const header = req.headers.authorization;
    return typeof header === 'string' && header === `Bearer ${this.token}`;
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        chunks.push(c);
        // 防恶意大 body:超过 64KB 直接拒
        if (Buffer.concat(chunks).byteLength > 64 * 1024) {
          reject(new Error('body too large'));
          req.destroy();
        }
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      // 禁用缓存:状态接口必须实时,客户端不该拿到旧快照
      'Cache-Control': 'no-store',
    });
    res.end(json);
  }
}

/** FilePanelService 抛的业务错误,带 code 供 HTTP 层映射状态码。 */
export class FilePanelError extends Error {
  constructor(
    readonly code: 'NotFound' | 'NotFile' | 'SessionMissing' | 'ResolveFailed',
    message: string,
  ) {
    super(message);
    this.name = 'FilePanelError';
  }
}
