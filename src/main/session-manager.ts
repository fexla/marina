/**
 * @file src/main/session-manager.ts
 * @purpose 完整 Session 管理器 — CP-2 接管 CP-1 简化版 PtyController。
 *   sessionId UUID 与 windowId 解耦,owner 字段独立,多 session 每窗口每路径。
 *
 * @关键设计:
 * - sessionId: UUID,与 windowId 完全解耦
 *   (CP-1 用 sessionId == windowId 是临时简化;现在改正)
 * - 每个 session 隶属一个 path (PathManager.attachSession 维护映射)
 * - owner_window_id 字段独立:窗口关闭时 owner 变 null,session 不死
 *   (软件定义书 8.4 + AGENTS.md CP-2 完成标志:跨窗口接管)
 * - PTY 字节流仅推送给 owner (软件定义书 9.3)。owner 切换时新 owner 通过
 *   cmd:session:get-scrollback 拉历史 — 但 CP-2 不实现 scrollback 缓冲
 *   (留给 CP-3),所以 owner 切换后看不到历史输出,接管后看到的是从此刻
 *   往后的新输出。这是 CP-2 文档化的限制。
 * - PTY 退出 → CP-2 直接 destroy session 不进墓地。墓地 5 分钟保留是
 *   CP-3 的事 (软件定义书 8.3)
 * - spawn 函数可注入,便于测试 (避免 mock 整个 node-pty 模块)
 *
 * @对应文档章节:
 *   软件定义书.md 5.1.2、8.3、8.4;ipc-protocol.md 5.2、6.2
 *   AGENTS.md CP-2 完成标志 (跨窗口数据共享 + owner 接管)
 *
 * @AGENTS.md 5.3 必测:
 * - SessionManager 创建/销毁/状态查询/owner 切换
 * - Session 状态机所有转移 (CP-2 范围: active ↔ idle [TODO CP-3] ↔ destroyed)
 *
 * @CP-3 待补:
 * - 墓地 (tombstoned 状态保留 5 分钟,可重启)
 * - scrollback ring buffer (2MB,owner 切换时拉历史)
 * - cwd 跟踪 (OSC 1337 hook + path 迁移)
 * - 16ms 字节流聚合
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { spawn as defaultSpawnPty, type IPty, type IDisposable } from 'node-pty';
import type {
  SessionExitedPayload,
  SessionOutputPayload,
} from '@shared/protocol';
import type { SessionInfo } from '@shared/types';
import type { WindowManager } from './window-manager';
import type { PathManager } from './path-manager';
import { buildSpawnEnv, validateDimensions } from './pty-utils';

const SPAWN_ENV_SKIP = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL'];

/**
 * spawn 工厂,与 node-pty 的 spawn 兼容。测试中用 mock 替换。
 */
export type PtySpawnFn = (
  file: string,
  args: string[] | string,
  options: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string>;
  },
) => IPty;

/**
 * 默认 shell 解析。CP-3 通过 PlatformAdapter.detectShells() 优先 pwsh 7。
 */
export function getDefaultShell(): string {
  if (process.platform === 'win32') return 'powershell.exe';
  return process.env['SHELL'] ?? '/bin/sh';
}

interface ManagedSession {
  info: SessionInfo;
  pty: IPty;
  /** evt:session:output 单调序号 */
  outputSeq: number;
  /** PTY 监听句柄,destroy 时释放 */
  disposables: IDisposable[];
}

export interface CreateSessionInput {
  pathId: string; // 已 normalize 的绝对路径
  templateId: string; // CP-2 只支持 'shell',CP-3 接 TemplateManager
  ownerWindowId: string;
  cols: number;
  rows: number;
}

export class SessionManagerError extends Error {
  constructor(
    public readonly code:
      | 'PathNotFound'
      | 'TemplateNotFound'
      | 'SessionNotFound'
      | 'SessionAlreadyOwned'
      | 'NotOwner'
      | 'PtySpawnFailed'
      | 'CwdNotAccessible',
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(`[SessionManager] ${code}: ${message}`);
    this.name = 'SessionManagerError';
  }
}

export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, ManagedSession>();

  constructor(
    /**
     * 持有 WindowManager 引用主要为后续 CP-3 cwd 跟踪与 owner 路由用,
     * CP-2 阶段未直接使用 (IPC 层在 owner 切换时自己查 WindowManager)。
     * 留接口避免 CP-3 时反复改 constructor 签名。
     */
    private readonly _windowManager: WindowManager,
    private readonly pathManager: PathManager,
    private readonly spawnFn: PtySpawnFn = defaultSpawnPty,
  ) {
    super();
    void this._windowManager; // 抑制 noUnusedLocals
  }

  // ──────────────────────────────────────────────────────────────────
  // 生命周期
  // ──────────────────────────────────────────────────────────────────

  /**
   * 创建一个 session 并启动 PTY。
   *
   * @throws SessionManagerError PtySpawnFailed / CwdNotAccessible /
   *   TemplateNotFound (CP-2 只支持 'shell' 一个模板)
   */
  createSession(input: CreateSessionInput): SessionInfo {
    if (input.templateId !== 'shell') {
      throw new SessionManagerError(
        'TemplateNotFound',
        `CP-2 仅支持 'shell' 模板,实际: ${input.templateId}。完整模板系统在 CP-3。`,
      );
    }
    const dims = validateDimensions(input.cols, input.rows);
    const shellPath = getDefaultShell();
    // CP-2: 把 path 作为 cwd 启动 PTY (CP-3 后还会 OSC 1337 跟踪 cwd 变化)
    const cwd = input.pathId || homedir();

    let pty: IPty;
    try {
      pty = this.spawnFn(shellPath, [], {
        name: 'xterm-color',
        cols: dims.cols,
        rows: dims.rows,
        cwd,
        env: buildSpawnEnv(process.env, SPAWN_ENV_SKIP),
      });
    } catch (err) {
      throw new SessionManagerError(
        'PtySpawnFailed',
        `无法启动 "${shellPath}" cwd="${cwd}". ` +
          `可能原因: (1) shell 不在 PATH; (2) cwd 不可访问; ` +
          `(3) node-pty 原生模块未为当前 Electron 重编译。原始错误: ${
            err instanceof Error ? err.message : String(err)
          }`,
        { shellPath, cwd },
      );
    }

    const sessionId = randomUUID();
    const info: SessionInfo = {
      id: sessionId,
      pathId: input.pathId,
      templateId: 'shell',
      cwd,
      cols: dims.cols,
      rows: dims.rows,
      pid: pty.pid,
      displayName: 'Shell',
      ownerWindowId: input.ownerWindowId,
      state: 'active',
      createdAt: Date.now(),
    };

    const disposables: IDisposable[] = [];
    const managed: ManagedSession = { info, pty, outputSeq: 0, disposables };
    this.sessions.set(sessionId, managed);

    disposables.push(
      pty.onData((data) => this.handlePtyData(managed, data)),
      pty.onExit(({ exitCode, signal }) => this.handlePtyExit(managed, exitCode, signal)),
    );

    // 把 session 挂到 path 上 (PathManager 自动触发分类流转 + emit)
    this.pathManager.attachSession(sessionId, input.pathId);
    this.emit('sessionCreated', { ...info });
    return { ...info };
  }

  /**
   * 关闭并销毁 session。CP-2 简化:直接 kill,不进墓地。
   * 幂等:不存在的 sessionId 不报错。
   */
  closeSession(sessionId: string): void {
    const managed = this.sessions.get(sessionId);
    if (!managed) return; // 幂等
    this.destroySession(managed, 'user-closed');
  }

  /**
   * 关闭所有 session — 应用退出前调。
   */
  shutdown(): void {
    for (const sid of [...this.sessions.keys()]) {
      this.closeSession(sid);
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Owner 管理
  // ──────────────────────────────────────────────────────────────────

  /**
   * 把 sessionId 的 owner 改为 windowId。
   * 若已有 owner 是其他窗口,会强制接管 (CP-2 简化;严格"先释放后接管"
   * 模式由 ipc-protocol claim/release 的语义在 IPC 层执行,SessionManager
   * 接受任意切换)。
   *
   * @throws SessionManagerError SessionNotFound
   */
  claimOwner(sessionId: string, windowId: string): void {
    const managed = this.sessions.get(sessionId);
    if (!managed) {
      throw new SessionManagerError('SessionNotFound', `sessionId="${sessionId}"`);
    }
    const oldOwner = managed.info.ownerWindowId;
    if (oldOwner === windowId) return; // 已是 owner
    managed.info.ownerWindowId = windowId;
    this.emit('sessionOwnerChanged', {
      sessionId,
      oldOwnerWindowId: oldOwner,
      newOwnerWindowId: windowId,
    });
  }

  /**
   * 释放对 sessionId 的 ownership (变成无主)。
   * @throws SessionManagerError SessionNotFound / NotOwner
   */
  releaseOwner(sessionId: string, windowId: string): void {
    const managed = this.sessions.get(sessionId);
    if (!managed) {
      throw new SessionManagerError('SessionNotFound', `sessionId="${sessionId}"`);
    }
    if (managed.info.ownerWindowId !== windowId) {
      throw new SessionManagerError(
        'NotOwner',
        `windowId="${windowId}" 不是 sessionId="${sessionId}" 的 owner ` +
          `(实际 owner: ${managed.info.ownerWindowId})`,
      );
    }
    managed.info.ownerWindowId = null;
    this.emit('sessionOwnerChanged', {
      sessionId,
      oldOwnerWindowId: windowId,
      newOwnerWindowId: null,
    });
  }

  /**
   * 窗口被关闭时调用:该窗口持有的所有 session 的 owner 变 null,
   * **不杀 PTY** (软件定义书 9.3:关闭窗口完全不影响 session)。
   */
  handleWindowClosed(windowId: string): void {
    for (const managed of this.sessions.values()) {
      if (managed.info.ownerWindowId === windowId) {
        managed.info.ownerWindowId = null;
        this.emit('sessionOwnerChanged', {
          sessionId: managed.info.id,
          oldOwnerWindowId: windowId,
          newOwnerWindowId: null,
        });
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // PTY I/O
  // ──────────────────────────────────────────────────────────────────

  /**
   * 把 base64 数据写到 PTY stdin。session 不存在时静默 (CP-1 修过的同样
   * 关闭/HMR 竞态,详见 src/main/pty-controller 删前的注释)。
   */
  sendInput(sessionId: string, base64Data: string): void {
    const managed = this.sessions.get(sessionId);
    if (!managed) return; // 静默 (race with close)
    const text = Buffer.from(base64Data, 'base64').toString('utf8');
    managed.pty.write(text);
  }

  /**
   * 调整 PTY 终端尺寸。session 不存在时静默 (同样竞态考虑)。
   */
  resize(sessionId: string, cols: number, rows: number): void {
    const managed = this.sessions.get(sessionId);
    if (!managed) return;
    const dims = validateDimensions(cols, rows);
    managed.info.cols = dims.cols;
    managed.info.rows = dims.rows;
    try {
      managed.pty.resize(dims.cols, dims.rows);
    } catch (err) {
      console.warn(
        `[SessionManager] resize ignored sid=${sessionId} ${dims.cols}x${dims.rows}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // 查询
  // ──────────────────────────────────────────────────────────────────

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((m) => ({ ...m.info }));
  }

  get(sessionId: string): SessionInfo | null {
    const m = this.sessions.get(sessionId);
    return m ? { ...m.info } : null;
  }

  count(): number {
    return this.sessions.size;
  }

  // ──────────────────────────────────────────────────────────────────
  // 内部
  // ──────────────────────────────────────────────────────────────────

  private handlePtyData(managed: ManagedSession, data: string): void {
    const payload: SessionOutputPayload = {
      sessionId: managed.info.id,
      data: Buffer.from(data, 'utf8').toString('base64'),
      seq: managed.outputSeq++,
    };
    this.emit('sessionOutput', payload);
  }

  private handlePtyExit(
    managed: ManagedSession,
    exitCode: number,
    signal: number | undefined,
  ): void {
    if (!this.sessions.has(managed.info.id)) return; // 已被 closeSession 清理过
    const payload: SessionExitedPayload = {
      sessionId: managed.info.id,
      exitCode,
      ...(typeof signal === 'number' ? { signal } : {}),
    };
    this.emit('sessionExited', payload);
    // CP-2: 立即销毁;CP-3 进入墓地保留 5 分钟
    this.destroySession(managed, 'pty-exited');
  }

  private destroySession(
    managed: ManagedSession,
    reason: 'user-closed' | 'pty-exited' | 'app-quit',
  ): void {
    const sid = managed.info.id;
    if (!this.sessions.has(sid)) return; // 已销毁过

    // 释放 PTY 监听句柄
    for (const d of managed.disposables) {
      try {
        d.dispose();
      } catch {
        // ignore
      }
    }
    if (reason !== 'pty-exited') {
      // pty-exited 时进程已死,不需要再 kill
      try {
        managed.pty.kill();
      } catch (err) {
        console.warn(`[SessionManager] kill failed sid=${sid}: ${
          err instanceof Error ? err.message : String(err)
        }`);
      }
    }
    this.sessions.delete(sid);
    this.pathManager.detachSession(sid);
    this.emit('sessionDestroyed', { sessionId: sid, reason });
  }
}
