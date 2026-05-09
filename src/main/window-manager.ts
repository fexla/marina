/**
 * @file src/main/window-manager.ts
 * @purpose 管理所有 BrowserWindow 实例的创建、销毁、编号分配、聚焦。
 *   维护 windowId ↔ BrowserWindow 的映射,响应"新开窗口 / 关闭所有窗口 /
 *   聚焦某窗口"等命令。
 *
 * @关键设计:
 * - windowId 用 UUID v4,持久且不复用
 * - 窗口编号 (Window 1, Window 2, ...) 单调递增,关闭后不复用
 *   (软件定义书 6.7 节;每次应用启动从 1 重新开始,运行时分配,不持久化)
 * - 通过 query string ?windowId=... 把 ID 传给 Renderer (ipc-protocol 2.2)
 * - 维护"最近活动"窗口指针,用于托盘单击聚焦 (软件定义书 6.5.2)
 * - 监听 BrowserWindow 的 'closed' 事件自动清理映射,renderer 进程退出
 *   是异步的,清理必须惰性 (Electron 内部经验)
 *
 * @对应文档章节: 软件定义书.md 6.7、9.2、9.3 节;ipc-protocol.md 2.2 节
 *
 * @不要在这里做的事:
 * - 不要管理 session 的 owner 关系 (那是 PtyController/SessionManager 的职责)
 * - 不要存储窗口的视图状态如选中路径 — 那是 Renderer 私有,Main 不存
 * - 不要创建 Tray (那是 TrayManager)
 *
 * @CP-1 状态:
 * 完整实现 createWindow / closeWindow / list / focus / getById /
 * getByElectronId / getMostRecentlyActive。
 * CP-1 还不需要 session-window 的关系管理,该功能在 CP-3 加入。
 */
import { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { WindowInfo } from '@shared/types';

const __dirname = dirname(fileURLToPath(import.meta.url));

const isDev = !!process.env.ELECTRON_RENDERER_URL;

/**
 * 窗口数硬上限 (ipc-protocol.md 5.1, MaxWindowsReached 错误码)。
 * V1 设 20,合理上限避免误操作把内存爆满。
 */
const MAX_WINDOWS = 20;

interface ManagedWindow {
  info: WindowInfo;
  electronWindow: BrowserWindow;
  /** 该窗口最后一次获得焦点的时间戳,用于"最近活动"排序 */
  lastFocusedAt: number;
}

export interface IWindowManager {
  createWindow(): WindowInfo;
  closeWindow(windowId: string): boolean;
  list(): WindowInfo[];
  focus(windowId: string): boolean;
  getById(windowId: string): BrowserWindow | null;
  getByElectronId(electronId: number): BrowserWindow | null;
  getMostRecentlyActive(): BrowserWindow | null;
  count(): number;
}

export class WindowManager implements IWindowManager {
  private readonly windows = new Map<string, ManagedWindow>();
  /**
   * 下一个窗口编号。从 1 开始单调递增,关闭后不复用 (软件定义书 6.7)。
   * 每次应用启动从 1 重新开始,不持久化。
   */
  private nextWindowNumber = 1;
  /**
   * 窗口创建时的 listener 钩子,允许调用者在创建后插入额外逻辑
   * (例如 PtyController 在窗口创建时 spawn PTY)。
   */
  private onCreatedHandlers: Array<(info: WindowInfo, win: BrowserWindow) => void> = [];
  private onClosedHandlers: Array<(windowId: string) => void> = [];

  /**
   * 新开一个窗口。
   *
   * @throws Error('MaxWindowsReached') 已达 V1 上限 (20 个窗口)
   */
  createWindow(): WindowInfo {
    if (this.windows.size >= MAX_WINDOWS) {
      throw new Error(
        `[WindowManager] MaxWindowsReached: 已达窗口数上限 ${MAX_WINDOWS}。` +
          `先关闭一些窗口再继续。`,
      );
    }

    const windowId = randomUUID();
    const windowNumber = this.nextWindowNumber++;

    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 600,
      minHeight: 400,
      show: false,
      title: `EasyTerm — Window ${windowNumber}`,
      backgroundColor: '#191724', // Rose Pine base — 软件定义书 5.1.9
      webPreferences: {
        preload: resolve(__dirname, '../preload/index.mjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false, // node-pty 等原生模块需要,后续 CP-3 接入
      },
    });

    const info: WindowInfo = {
      id: windowId,
      number: windowNumber,
      electronWindowId: win.webContents.id,
    };

    const managed: ManagedWindow = {
      info,
      electronWindow: win,
      lastFocusedAt: Date.now(),
    };
    this.windows.set(windowId, managed);

    win.on('focus', () => {
      managed.lastFocusedAt = Date.now();
    });

    // 窗口关闭后清理映射。'closed' 在 webContents 销毁后触发,此时 win
    // 已经不可用,所以先取出 windowId 存到本地。
    win.on('closed', () => {
      this.windows.delete(windowId);
      for (const handler of this.onClosedHandlers) {
        try {
          handler(windowId);
        } catch (err) {
          // 一个 handler 出错不能影响其他 handler 或主流程
          console.error(`[WindowManager] onClosed handler threw for ${windowId}:`, err);
        }
      }
    });

    win.once('ready-to-show', () => {
      win.show();
    });

    // dev 模式从 Vite dev server 拉,build 后从本地文件加载
    const queryString = `?windowId=${encodeURIComponent(windowId)}&windowNumber=${windowNumber}`;
    if (isDev && process.env.ELECTRON_RENDERER_URL) {
      void win.loadURL(process.env.ELECTRON_RENDERER_URL + queryString);
      win.webContents.openDevTools({ mode: 'detach' });
    } else {
      void win.loadFile(resolve(__dirname, '../renderer/index.html'), {
        search: queryString.slice(1), // loadFile 的 search 不要前导 ?
      });
    }

    for (const handler of this.onCreatedHandlers) {
      try {
        handler(info, win);
      } catch (err) {
        console.error(`[WindowManager] onCreated handler threw for ${windowId}:`, err);
      }
    }

    return info;
  }

  /**
   * 关闭指定窗口。返回 true 表示找到并触发关闭,false 表示窗口不存在。
   *
   * 不弹任何确认对话框 (软件定义书 7.4.1, AGENTS.md 哲学红线)。
   */
  closeWindow(windowId: string): boolean {
    const managed = this.windows.get(windowId);
    if (!managed) return false;
    managed.electronWindow.close();
    return true;
  }

  /**
   * 关闭所有窗口,进入纯托盘模式 (软件定义书 7.4.2)。
   * 注意 Map 在迭代时不能修改,先拷贝再遍历。
   */
  closeAll(): void {
    const all = [...this.windows.values()];
    for (const m of all) {
      m.electronWindow.close();
    }
  }

  list(): WindowInfo[] {
    return [...this.windows.values()].map((m) => ({ ...m.info }));
  }

  count(): number {
    return this.windows.size;
  }

  focus(windowId: string): boolean {
    const managed = this.windows.get(windowId);
    if (!managed) return false;
    const win = managed.electronWindow;
    if (win.isMinimized()) win.restore();
    win.focus();
    managed.lastFocusedAt = Date.now();
    return true;
  }

  getById(windowId: string): BrowserWindow | null {
    return this.windows.get(windowId)?.electronWindow ?? null;
  }

  getByElectronId(electronId: number): BrowserWindow | null {
    for (const m of this.windows.values()) {
      if (m.info.electronWindowId === electronId) return m.electronWindow;
    }
    return null;
  }

  /**
   * 返回最近被聚焦过的窗口,用于托盘单击行为 (软件定义书 6.5.2)。
   * 无窗口时返回 null。
   */
  getMostRecentlyActive(): BrowserWindow | null {
    let best: ManagedWindow | null = null;
    for (const m of this.windows.values()) {
      if (!best || m.lastFocusedAt > best.lastFocusedAt) {
        best = m;
      }
    }
    return best?.electronWindow ?? null;
  }

  /**
   * 注册回调:每次新窗口创建后立即触发。用于让 PtyController 等模块挂钩。
   */
  onWindowCreated(handler: (info: WindowInfo, win: BrowserWindow) => void): void {
    this.onCreatedHandlers.push(handler);
  }

  /**
   * 注册回调:每次窗口关闭后触发。
   */
  onWindowClosed(handler: (windowId: string) => void): void {
    this.onClosedHandlers.push(handler);
  }
}
