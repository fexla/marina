/**
 * @file src/main/pty-controller.ts
 * @purpose CP-1 简化版 PTY 控制器:每个窗口绑定一个 PowerShell PTY。
 *   注册 cmd:session:* IPC handler,推送 evt:session:output / exited。
 *
 * @关键设计 (CP-1 简化):
 * - sessionId = windowId,一对一,简化生命周期管理
 * - 窗口 cmd:session:create 时若已有 PTY 先 kill 再开新的 (HMR 友好)
 * - 窗口关闭 (onWindowClosed) 时强制 kill 该窗口的 PTY,避免僵尸
 * - 不实现墓地 / scrollback / owner 切换 / OSC 1337 — 留给 CP-3
 *
 * @PTY 字节流推送策略 (CP-1):
 * - PTY onData 每次都立刻推送 evt:session:output (无 16ms 聚合)
 * - 16ms 聚合在 CP-3 引入 — CP-1 流量小不必优化
 * - 字节流用 base64 编码塞进 JSON (ipc-protocol 8.2)
 *
 * @对应文档章节:
 *   软件定义书.md 5.1.2 (Session 管理)、5.1.8 (CWD 跟踪 — CP-3 实现);
 *   ipc-protocol.md 第 5.2 (Session 命令)、第 8 (字节流);
 *   AGENTS.md CP-1 完成标志 (xterm 显示 PowerShell prompt 并能跑命令)
 *
 * @CP-3 重构计划:
 * 此文件在 CP-3 接入完整 SessionManager 后会显著重构:
 * - sessionId 与 windowId 解耦,owner 字段独立
 * - 引入墓地、scrollback、cwd 跟踪、模板支持
 * - 字节流聚合 16ms
 * 现在的实现是"一次性脚手架",故意叫 PtyController 而不是 SessionManager,
 * 让重命名清晰。
 */
import type { BrowserWindow } from 'electron';
import { ipcMain } from 'electron';
import { spawn as spawnPty, type IPty } from 'node-pty';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import {
  COMMAND_CHANNELS,
  EVENT_CHANNELS,
  type CloseSessionPayload,
  type CommandEnvelope,
  type CreateSessionPayload,
  type CreateSessionResponse,
  type EventEnvelope,
  type ResizeSessionPayload,
  type SendInputPayload,
  type SessionExitedPayload,
  type SessionOutputPayload,
} from '@shared/protocol';
import type { WindowManager } from './window-manager';

interface ManagedPty {
  sessionId: string; // CP-1 = windowId
  windowId: string;
  pty: IPty;
  /** evt:session:output 的单调序号 */
  outputSeq: number;
  shellPath: string;
  cwd: string;
}

/**
 * Windows 默认 shell 选择。CP-1 阶段简单:用 Windows PowerShell 5.1
 * (powershell.exe,Win10/11 永远存在;PATH 解析)。
 *
 * CP-3 时通过 PlatformAdapter.detectShells() 优先 pwsh 7。
 */
function getDefaultShell(): string {
  if (process.platform === 'win32') return 'powershell.exe';
  // macOS / Linux 占位 (V1 不实际启动,因为只支持 Windows)
  return process.env['SHELL'] ?? '/bin/sh';
}

/**
 * 把 process.env 里的 undefined 值过滤掉,转成 node-pty 要的纯 string 字典。
 * 同时剔除 Electron 的私有变量避免污染子 shell。
 */
function buildSpawnEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const skip = new Set(['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL']);
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && !skip.has(key)) {
      env[key] = value;
    }
  }
  return env;
}

export class PtyController {
  private readonly ptys = new Map<string, ManagedPty>();
  private installed = false;

  constructor(private readonly windowManager: WindowManager) {}

  /**
   * 注册所有 IPC handler 并挂上 WindowManager 钩子。只能调用一次。
   */
  install(): void {
    if (this.installed) {
      throw new Error('[PtyController] install() already called');
    }
    this.installed = true;

    ipcMain.handle(COMMAND_CHANNELS.SESSION_CREATE, async (_event, envelope) =>
      this.handleCreate(envelope as CommandEnvelope<CreateSessionPayload>),
    );
    ipcMain.handle(COMMAND_CHANNELS.SESSION_SEND_INPUT, (_event, envelope) =>
      this.handleSendInput(envelope as CommandEnvelope<SendInputPayload>),
    );
    ipcMain.handle(COMMAND_CHANNELS.SESSION_RESIZE, (_event, envelope) =>
      this.handleResize(envelope as CommandEnvelope<ResizeSessionPayload>),
    );
    ipcMain.handle(COMMAND_CHANNELS.SESSION_CLOSE, (_event, envelope) =>
      this.handleClose(envelope as CommandEnvelope<CloseSessionPayload>),
    );

    // 窗口关闭时强制清理对应 PTY
    this.windowManager.onWindowClosed((windowId) => {
      this.killByWindowId(windowId);
    });
  }

  /**
   * 关闭所有 PTY,通常在 app.quit 之前调用。
   */
  shutdown(): void {
    for (const m of this.ptys.values()) {
      try {
        m.pty.kill();
      } catch (err) {
        console.error(`[PtyController] kill failed for ${m.sessionId}:`, err);
      }
    }
    this.ptys.clear();
  }

  // ──────────────────────────────────────────────────────────────────
  // IPC handlers
  // ──────────────────────────────────────────────────────────────────

  private async handleCreate(
    envelope: CommandEnvelope<CreateSessionPayload>,
  ): Promise<CreateSessionResponse> {
    const { windowId, payload } = envelope;
    const { cols, rows } = this.validateDimensions(payload.cols, payload.rows);

    const win = this.windowManager.getById(windowId);
    if (!win) {
      throw new Error(
        `[PtyController] WindowNotRegistered: windowId="${windowId}" 不在 WindowManager 中。` +
          `可能原因: (1) 窗口已被关闭, (2) 这是 bootstrap 占位 windowId 而非真实 UUID。`,
      );
    }

    // 同一窗口若已有 PTY,先清理 (HMR / 用户重连 friendly)
    this.killByWindowId(windowId);

    const shellPath = getDefaultShell();
    const cwd = homedir();

    let pty: IPty;
    try {
      pty = spawnPty(shellPath, [], {
        name: 'xterm-color',
        cols,
        rows,
        cwd,
        env: buildSpawnEnv(),
      });
    } catch (err) {
      throw new Error(
        `[PtyController] PtySpawnFailed: 无法启动 "${shellPath}" cwd="${cwd}". ` +
          `可能原因: (1) shell 不存在或不在 PATH, (2) cwd 不可访问, ` +
          `(3) node-pty 原生模块未为当前 Electron 重编译 (跑 npm run postinstall)。 ` +
          `原始错误: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // sessionId = windowId,简化 CP-1 模型
    const sessionId = windowId;
    const managed: ManagedPty = {
      sessionId,
      windowId,
      pty,
      outputSeq: 0,
      shellPath,
      cwd,
    };
    this.ptys.set(sessionId, managed);

    // PTY 字节流 → 推送给 owner window
    pty.onData((data) => this.pushOutput(managed, data));

    pty.onExit(({ exitCode, signal }) => {
      this.ptys.delete(sessionId);
      const evtPayload: SessionExitedPayload = {
        sessionId,
        exitCode,
        ...(typeof signal === 'number' ? { signal } : {}),
      };
      this.sendEvent(win, EVENT_CHANNELS.SESSION_EXITED, evtPayload);
    });

    return {
      sessionId,
      pid: pty.pid,
      shellPath,
      cwd,
    };
  }

  private handleSendInput(envelope: CommandEnvelope<SendInputPayload>): void {
    const { sessionId, data } = envelope.payload;
    const managed = this.ptys.get(sessionId);
    if (!managed) {
      throw new Error(`[PtyController] SessionNotFound: sessionId="${sessionId}"`);
    }
    // data 是 base64,转回字符串再 write
    const text = Buffer.from(data, 'base64').toString('utf8');
    managed.pty.write(text);
  }

  private handleResize(envelope: CommandEnvelope<ResizeSessionPayload>): void {
    const { sessionId, cols, rows } = envelope.payload;
    const managed = this.ptys.get(sessionId);
    if (!managed) {
      throw new Error(`[PtyController] SessionNotFound: sessionId="${sessionId}"`);
    }
    const validated = this.validateDimensions(cols, rows);
    try {
      managed.pty.resize(validated.cols, validated.rows);
    } catch (err) {
      // ConPTY 在某些边界情况下 resize 失败,记录但不 throw 给 renderer
      // (resize 失败不应让 UI 报错,只是显示稍微错位)
      console.warn(
        `[PtyController] resize ignored for ${sessionId} ${cols}x${rows}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private handleClose(envelope: CommandEnvelope<CloseSessionPayload>): void {
    const { sessionId } = envelope.payload;
    const managed = this.ptys.get(sessionId);
    if (!managed) return; // 幂等,close 不存在的 session 不报错
    try {
      managed.pty.kill();
    } catch (err) {
      console.error(`[PtyController] kill failed for ${sessionId}:`, err);
    }
    this.ptys.delete(sessionId);
  }

  // ──────────────────────────────────────────────────────────────────
  // 内部帮助
  // ──────────────────────────────────────────────────────────────────

  private killByWindowId(windowId: string): void {
    // CP-1 简化模型:sessionId = windowId
    const managed = this.ptys.get(windowId);
    if (!managed) return;
    try {
      managed.pty.kill();
    } catch (err) {
      console.error(`[PtyController] cleanup kill failed for ${windowId}:`, err);
    }
    this.ptys.delete(windowId);
  }

  private pushOutput(managed: ManagedPty, data: string): void {
    const win = this.windowManager.getById(managed.windowId);
    if (!win || win.isDestroyed()) {
      // owner 已不在,丢弃 (CP-3 会写入 scrollback ring buffer)
      return;
    }
    const payload: SessionOutputPayload = {
      sessionId: managed.sessionId,
      data: Buffer.from(data, 'utf8').toString('base64'),
      seq: managed.outputSeq++,
    };
    this.sendEvent(win, EVENT_CHANNELS.SESSION_OUTPUT, payload);
  }

  private sendEvent<P>(win: BrowserWindow, channel: string, payload: P): void {
    if (win.isDestroyed()) return;
    const envelope: EventEnvelope<P> = {
      eventId: randomUUID(),
      timestamp: Date.now(),
      payload,
    };
    win.webContents.send(channel, envelope);
  }

  private validateDimensions(cols: number, rows: number): { cols: number; rows: number } {
    // ConPTY 不喜欢 0 或负数,且过大会内存爆炸。约束在合理范围内。
    const safe = (n: number, min: number, max: number, fallback: number): number => {
      if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
      if (n < min) return min;
      if (n > max) return max;
      return n;
    };
    return {
      cols: safe(cols, 1, 1000, 80),
      rows: safe(rows, 1, 1000, 24),
    };
  }
}
