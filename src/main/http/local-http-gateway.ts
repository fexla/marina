/**
 * @file src/main/http/local-http-gateway.ts
 * @purpose Marina 的本地 HTTP API 网关:127.0.0.1 + Bearer token 的单一 HTTP 入口,
 *   把终端里 agent / 脚本 / CLI 发来的 REST 请求路由到 5 个业务(file-panel /
 *   workspace / command-panel / pi / screenshot)。
 *
 * @关键设计:
 * - M3 从 FilePanelService 拆出:原来 FilePanelService 混了核心面板状态 + HTTP server
 *   + 跨 5 业务路由。本类持有 HTTP 传输层(server/鉴权/quiesce gate/路由分发),
 *   FilePanelService 瘦回核心面板 + file-panel handler(gateway 调)。
 * - 传输层只做"框架":health 免鉴权 → checkAuth(401) → isQuiescing(503) → 按路由分发。
 *   各路由的业务逻辑在注入的 ops(workspaceOps/commandRunOps/piEventOps/windowCapture)
 *   或 FilePanelService 的 handler(file-panel 端点)里 —— gateway 保持薄,不持有
 *   业务状态。
 * - 安全面收口(继承原 FilePanelService):
 *     * 只绑 127.0.0.1(loopback),本机其它用户进程也走不到别的登录会话
 *     * 每次 start 生成随机 Bearer token,注入 MARINA_TOKEN;请求必须带
 *       Authorization: Bearer <token>,否则 401
 *     * GET /health 是唯一免鉴权端点(存活探测,给 marina ping 用),放在 checkAuth
 *       之前 —— 未注入 token 的进程也要能探活,与"Marina 没在跑"区分。
 * - H4 quiesce gate:进入退出流程后拒绝新的 HTTP 工作(agent 脚本在 daemon 退出窗口
 *   内发来的请求不落 shutdown/flush 之后)。/health 提前放行,存活探测不受影响。
 * - ops 注入式(与 FilePanelService 原 attach* 同款):不引 electron / 不持
 *   SessionManager,保持可测。index.ts 闭合到 coordinator / windowManager。
 *
 * @对应文档:docs/架构整改-M1M2M3整体设计.md 决策 4;软件定义书 ADR-024(workspace
 *   路由)/ ADR-027(/run)/ ADR-028(/pi-session-event) / T12(/screenshot)。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { isQuiescing } from '../app-lifecycle';
import { logger } from '../logger';
import { send, readBody, sendPng } from './http-helpers';
import { FilePanelError } from '../file-panel-service';
import type {
  CommandRunOps,
  FilePanelService,
  PiEventOps,
  WindowCaptureFn,
  WorkspaceOps,
} from '../file-panel-service';

const MODULE = 'LocalHttpGateway';
/** 绑定地址:仅回环,本机外部网络不可达。 */
const HOST = '127.0.0.1';

/** start() 的注入参数。enabled=false → 不起服务,getUrl() 返回 null。 */
export interface LocalHttpGatewayOptions {
  enabled: boolean;
  /** 0 = 让系统分配空闲端口;正整数 = 尝试固定端口(占用回退自动并 warn) */
  port: number;
}

/**
 * Marina 本地 HTTP API 网关。
 */
export class LocalHttpGateway {
  private server: Server | null = null;
  private baseUrl: string | null = null;
  private token: string | null = null;
  /**
   * enabled / wantPort 在 start() 时按"已加载的用户 settings"赋值,不在构造
   * 期读 —— 组装时 settings 尚未 initialize。构造只收 filePanelService(路由
   * 分发目标),避免时序耦合。
   */
  private enabled = false;
  private wantPort = 0;

  /** v0.3.3 T12:截图回调,由 index.ts 注入(不引 electron,保持可测)。null=未注入,/screenshot 503。 */
  private windowCapture: WindowCaptureFn | null = null;
  /** v0.3.3 ADR-024:workspace 操作回调(workspace HTTP 路由用)。 */
  private workspaceOps: WorkspaceOps | null = null;
  /** v0.3.3 ADR-027:命令面板 /run 路由回调(转发给 CommandPanelService)。 */
  private commandRunOps: CommandRunOps | null = null;
  /** v0.3.3 ADR-028：pi package /pi-session-event 路由回调(转发给 PiSessionCoordinator)。 */
  private piEventOps: PiEventOps | null = null;

  constructor(private readonly filePanelService: FilePanelService) {}

  /**
   * v0.3.3 T12:注入截图回调(/screenshot 路由用)。不引 electron,网关层保持可测:
   * index.ts 闭合 sessionManager→ownerWindow→webContents.capturePage→toPNG。
   * 未注入时 /screenshot 返 503(功能未启用),不崩。
   */
  attachWindowCapture(capture: WindowCaptureFn): void {
    this.windowCapture = capture;
  }

  /** v0.3.3 ADR-024:注入 workspace 操作回调(workspace HTTP 路由用)。 */
  attachWorkspaceOps(ops: WorkspaceOps): void {
    this.workspaceOps = ops;
  }

  /** v0.3.3 ADR-027:注入命令面板 run 回调(HTTP /run 路由用)。 */
  attachCommandRunOps(ops: CommandRunOps): void {
    this.commandRunOps = ops;
  }

  /** v0.3.3 ADR-028：注入 pi 事件处理回调(HTTP /pi-session-event 路由用)。 */
  attachPiEventOps(ops: PiEventOps): void {
    this.piEventOps = ops;
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
  async start(opts: LocalHttpGatewayOptions): Promise<{ baseUrl: string; token: string } | null> {
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

  /** 关闭 HTTP 服务(应用退出用)。文件面板面板状态由 FilePanelService 自己清。 */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => {
        this.server = null;
        this.baseUrl = null;
        resolve();
      });
    });
  }

  /**
   * 统一路由分发。完整路由语义继承原 FilePanelService.handle(M3 前):
   * /health(免鉴权)→ checkAuth(401)→ isQuiescing(503)→ 各业务路由。
   */
  private handle(req: IncomingMessage, res: ServerResponse): void {
    const u = new URL(req.url ?? '/', this.baseUrl ?? `http://${HOST}`);
    const method = req.method ?? 'GET';

    // GET /health 是唯一的免鉴权端点:纯存活探测,给终端里跑的 agent 脚本
    // (marina ping)用。必须放在 checkAuth 之前 —— 否则未注入 MARINA_TOKEN
    // 的进程探不到活,无法和"Marina 没在跑"区分。返回体不含敏感信息;
    // HTTP 只绑 127.0.0.1 已是第一道防线(见文件头"安全面收口")。
    if (method === 'GET' && u.pathname === '/health') {
      send(res, 200, { ok: true, marina: true });
      return;
    }

    // 其余所有接口都要鉴权(包括 GET)。先校验 token,再路由。
    if (!this.checkAuth(req)) {
      send(res, 401, { error: 'unauthorized: invalid or missing token' });
      return;
    }

    // 退出 quiesce gate(H4):进入退出流程后拒绝新的 HTTP 工作(agent 脚本在
    // daemon 退出窗口内发来的请求不落 shutdown/flush 之后)。/health 在上面
    // 已提前放行,存活探测不受影响。
    if (isQuiescing()) {
      send(res, 503, { error: 'shutting down' });
      return;
    }
    const terminal = u.searchParams.get('terminal') ?? undefined;

    // GET /opening-files?terminal=<id>
    // 拉取前先 await refreshStale:让 CLI `list` 的「僵尸 tab」标记始终反映
    // 磁盘真值(补 fs.watch 漏掉的事件:Marina 关闭期间被删、watcher error 已停)。
    // 面板数小(N 个 stat),开销可忽。IPC 的 get-open-files 不走这条(保持同步快路径)。
    if (method === 'GET' && u.pathname === '/opening-files') {
      if (!terminal) return send(res, 400, { error: 'missing query: terminal' });
      return void this.filePanelService.handleOpeningFiles(res, terminal);
    }

    // POST /open-file | /show-file | /close-file  body {terminal, path}
    if (
      method === 'POST' &&
      (u.pathname === '/open-file' || u.pathname === '/show-file' || u.pathname === '/close-file')
    ) {
      void this.filePanelService.handlePost(req, res, u.pathname);
      return;
    }

    // POST /close-files  body {terminal, mode, pattern?} —— 批量关:`all` / `stale` / `glob`
    if (method === 'POST' && u.pathname === '/close-files') {
      void this.filePanelService.handleCloseFiles(req, res);
      return;
    }

    // v0.3.3 T12:GET /screenshot?terminal=<id> —— 截该 session owner window 的屏,返 image/png。
    // 给 agent/CLI 自测 UI 用(消除人工截图)。鉴权同其他路由;capture 回调未注入返 503。
    if (method === 'GET' && u.pathname === '/screenshot') {
      if (!terminal) return send(res, 400, { error: 'missing query: terminal' });
      return void this.handleScreenshot(res, terminal);
    }

    // v0.3.3 ADR-024 / Feature D:workspace HTTP 路由(CLI `marina workspace*` 用)。
    // workspaceId 与 sessionId 解耦,CLI 一律查当前桌面 daemon(按 terminal→session→
    // workspaceId→dir);main 是真值源,$env:MARINA_WORKSPACE 不可靠(退化为 spawn 时值)。
    if (method === 'GET' && u.pathname === '/workspace') {
      if (!terminal) return send(res, 400, { error: 'missing query: terminal' });
      return void this.handleWorkspaceCurrent(res, terminal);
    }
    if (method === 'GET' && u.pathname === '/workspace/list') {
      if (!terminal) return send(res, 400, { error: 'missing query: terminal' });
      return void this.handleWorkspaceList(res, terminal);
    }
    if (method === 'POST' && u.pathname === '/workspace/bind') {
      void this.handleWorkspaceBind(req, res);
      return;
    }
    if (method === 'POST' && u.pathname === '/workspace/new') {
      void this.handleWorkspaceNew(req, res);
      return;
    }
    if (method === 'POST' && u.pathname === '/workspace/unpin') {
      void this.handleWorkspaceUnpin(req, res);
      return;
    }

    // v0.3.3 ADR-027:POST /run body {terminal, command, title?} —— AI 经
    // `marina run "<cmd>"` 推送任意命令字符串,转发给 CommandPanelService。
    // 鉴权同其他路由(Bearer)。owner 校验在 CommandPanelService 内(sessionLookup)。
    if (method === 'POST' && u.pathname === '/run') {
      void this.handleRun(req, res);
      return;
    }

    // v0.3.3 ADR-028:POST /pi-session-event body {terminal, piSessionId, event, reason?, name?}
    // —— pi package(@earendil-works/pi-coding-agent)订阅 pi 生命周期事件后转发到这里。
    // Marina 作为决策者按 settings.piIntegration 决定做不做。鉴权同其他路由(Bearer)。
    // fire-and-forget:响应与 pi 业务结果无关,Marina 处理失败不阻塞 pi。
    if (method === 'POST' && u.pathname === '/pi-session-event') {
      void this.handlePiSessionEvent(req, res);
      return;
    }

    send(res, 404, { error: `not found: ${method} ${u.pathname}` });
  }

  /**
   * v0.3.3 T12:GET /screenshot?terminal=<id>。调注入的 windowCapture 回调截 owner window
   * 的屏,成功返 image/png 二进制;失败(无 owner/窗口销毁/最小化/capture 抛错)返 JSON 错误。
   * capture 回调未注入(旧启动/单测未设)→ 503 明确表示功能未启用,不崩。
   */
  private async handleScreenshot(res: ServerResponse, terminal: string): Promise<void> {
    if (!this.windowCapture) {
      send(res, 503, { error: 'screenshot 未启用(windowCapture 未注入)' });
      return;
    }
    try {
      const result = await this.windowCapture(terminal);
      if ('error' in result) {
        // 400 = 客户端可理解的原因(无 owner / 窗口已关 / 最小化),不是服务端 bug
        send(res, 400, { error: result.error });
        return;
      }
      sendPng(res, result.png);
    } catch (err) {
      logger.error(MODULE, 'screenshot failed', err);
      send(res, 500, { error: 'screenshot internal error' });
    }
  }

  // ── v0.3.3 ADR-024 / Feature D:workspace HTTP handlers ───────────

  /** GET /workspace?terminal=<id> → 当前 session 绑定的 workspace 绝对路径。 */
  private handleWorkspaceCurrent(res: ServerResponse, terminal: string): void {
    if (!this.workspaceOps) {
      send(res, 503, { error: 'workspace 未启用(workspaceOps 未注入)' });
      return;
    }
    const dir = this.workspaceOps.getCurrentPath(terminal);
    if (!dir) {
      send(res, 404, { error: 'session 无绑定的 workspace' });
      return;
    }
    send(res, 200, { path: dir });
  }

  /** GET /workspace/list?terminal=<id> → 当前 pathScope 下的命名 workspace 列表。 */
  private async handleWorkspaceList(res: ServerResponse, terminal: string): Promise<void> {
    if (!this.workspaceOps) {
      send(res, 503, { error: 'workspace 未启用(workspaceOps 未注入)' });
      return;
    }
    try {
      const items = await this.workspaceOps.list(terminal);
      send(res, 200, { items });
    } catch (err) {
      send(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** POST /workspace/bind body {terminal, name, new?} → upsert。 */
  private async handleWorkspaceBind(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.workspaceOps) {
      send(res, 503, { error: 'workspace 未启用(workspaceOps 未注入)' });
      return;
    }
    try {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      const terminal = body?.terminal;
      const name = body?.name;
      const forceNew = body?.new === true;
      if (typeof terminal !== 'string' || typeof name !== 'string') {
        send(res, 400, { error: 'missing fields: terminal, name' });
        return;
      }
      const result = await this.workspaceOps.bind(terminal, name, forceNew);
      // Feature D:切到已存在 workspace(switched)才需恢复快照;created(首次命名当前
      // workspace)文件面板不变(同一个 workspace 只是加了名字)。
      if (result.kind === 'switched') {
        void this.filePanelService.onWorkspaceSwitched(terminal);
      }
      send(res, 200, result);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      const status = code === 'NameConflict' ? 409 : 400;
      send(res, status, {
        error: err instanceof Error ? err.message : String(err),
        code,
      });
    }
  }

  /** POST /workspace/new body {terminal} → 切回新空临时 workspace。 */
  private async handleWorkspaceNew(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.workspaceOps) {
      send(res, 503, { error: 'workspace 未启用(workspaceOps 未注入)' });
      return;
    }
    try {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      const terminal = body?.terminal;
      if (typeof terminal !== 'string') {
        send(res, 400, { error: 'missing field: terminal' });
        return;
      }
      const result = await this.workspaceOps.newWorkspace(terminal);
      // Feature D:切到新空 workspace,文件面板清空(新 workspace 无快照)。
      void this.filePanelService.onWorkspaceSwitched(terminal);
      send(res, 200, result);
    } catch (err) {
      send(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** POST /workspace/unpin body {terminal, name?} → 剥 name+pinned。 */
  private async handleWorkspaceUnpin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.workspaceOps) {
      send(res, 503, { error: 'workspace 未启用(workspaceOps 未注入)' });
      return;
    }
    try {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      const terminal = body?.terminal;
      const name = typeof body?.name === 'string' ? body.name : null;
      if (typeof terminal !== 'string') {
        send(res, 400, { error: 'missing field: terminal' });
        return;
      }
      const result = await this.workspaceOps.unpin(terminal, name);
      if (!result) {
        send(res, 404, { error: 'workspace 未找到' });
        return;
      }
      send(res, 200, result);
    } catch (err) {
      send(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * v0.3.3 ADR-027:POST /run。body {terminal, command, title?}。转发给注入的
   * commandRunOps(CommandPanelService)。成功返命令面板快照;失败(SSH/shell/spawn/
   * session 缺失)返 400 + error。ops 未注入返 503。
   */
  private async handleRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.commandRunOps) {
      send(res, 503, { error: 'command-panel 未启用(commandRunOps 未注入)' });
      return;
    }
    let body: { terminal?: string; command?: string; title?: string; sudo?: boolean };
    try {
      body = JSON.parse(await readBody(req)) as {
        terminal?: string;
        command?: string;
        title?: string;
        sudo?: boolean;
      };
    } catch {
      return send(res, 400, { error: 'invalid JSON body' });
    }
    const { terminal, command, title, sudo } = body;
    if (!terminal) return send(res, 400, { error: 'body 需要 { terminal }' });
    if (!command || !command.trim()) {
      return send(res, 400, { error: 'body 需要 { command } 且非空' });
    }
    try {
      const snapshot = await this.commandRunOps.runCommand(
        terminal,
        command,
        title ?? null,
        // HTTP 路由无明确发起 client;CommandPanelService 会用 session owner 作为
        // 事件定向目标(owner 收到后更新面板)。传 null 让 service 兜底。
        null,
        !!sudo,
      );
      send(res, 200, snapshot);
    } catch (err) {
      this.sendError(res, err);
    }
  }

  /**
   * v0.3.3 ADR-028:POST /pi-session-event。body {terminal, piSessionId, event,
   * reason?, name?, workspaceId?, parentSessionFile?, parentBinding?}(后两个是
   * 方案 20260817 的 fork/子会话亲缘字段,可选)。
   * 解析 + 校验后转发给注入的 piEventOps(PiSessionCoordinator.handlePiSessionEvent)。
   * fire-and-forget 语义：响应只表“已接收”，不保证 pi 业务结果(那由后续 evt 推送)。
   * 处理失败返 500 + error，但 pi 不会因此卡住(它不等业务结果)。
   */
  private async handlePiSessionEvent(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.piEventOps) {
      send(res, 503, { error: 'pi-event 未启用(piEventOps 未注入)' });
      return;
    }
    let body: {
      terminal?: string;
      piSessionId?: string;
      event?: string;
      reason?: string;
      name?: string | null;
      workspaceId?: string | null;
      parentSessionFile?: string | null;
      parentBinding?: string | null;
    };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      return send(res, 400, { error: 'invalid JSON body' });
    }
    const {
      terminal,
      piSessionId,
      event,
      reason,
      name,
      workspaceId,
      parentSessionFile,
      parentBinding,
    } = body;
    if (!terminal) return send(res, 400, { error: 'body 需要 { terminal }' });
    if (!piSessionId) return send(res, 400, { error: 'body 需要 { piSessionId }' });
    const VALID_EVENTS = [
      'session_start',
      'session_shutdown',
      'agent_working',
      'agent_settled',
      'name_changed',
    ] as const;
    if (!event || !(VALID_EVENTS as readonly string[]).includes(event)) {
      return send(res, 400, { error: `body.event 必须是 ${VALID_EVENTS.join('|')} 之一` });
    }
    try {
      const payload: {
        piSessionId: string;
        event: (typeof VALID_EVENTS)[number];
        reason?: string;
        name?: string | null;
        workspaceId?: string | null;
        parentSessionFile?: string | null;
        parentBinding?: string | null;
      } = { piSessionId, event: event as (typeof VALID_EVENTS)[number] };
      if (reason !== undefined) payload.reason = reason;
      if (name !== undefined && name !== null) payload.name = name;
      if (workspaceId !== undefined && workspaceId !== null) payload.workspaceId = workspaceId;
      // 方案 20260817:亲缘字段(可选;旧版 bridge 不带,校验为 string 才透传)。
      if (
        parentSessionFile !== undefined &&
        parentSessionFile !== null &&
        typeof parentSessionFile === 'string'
      )
        payload.parentSessionFile = parentSessionFile;
      if (
        parentBinding !== undefined &&
        parentBinding !== null &&
        typeof parentBinding === 'string'
      )
        payload.parentBinding = parentBinding;
      // session_start 可能返回 { workspaceId }(新建的),作为响应体交回 bridge 存进
      // pi 对话 entry(appendEntry);其它事件返回 void → 响应 { ok: true }。
      const result = await this.piEventOps.applyPiSessionEvent(terminal, payload);
      send(res, 200, result && 'workspaceId' in result ? result : { ok: true });
    } catch (err) {
      this.sendError(res, err);
    }
  }

  private checkAuth(req: IncomingMessage): boolean {
    if (!this.token) return false;
    const header = req.headers.authorization;
    return typeof header === 'string' && header === `Bearer ${this.token}`;
  }

  /** 业务错误 → HTTP 状态码映射(与 FilePanelService 原 sendError 同语义)。 */
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
