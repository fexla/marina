/**
 * @file src/main/tray.ts
 * @purpose 系统托盘管理。常驻托盘图标、右键菜单、单击聚焦最近活动窗口、
 *   "完全退出 Marina"流程。
 *
 * @关键设计:
 * - 托盘是应用"始终在线"的代表 (软件定义书 6.5)
 * - 单击: 有窗口聚焦最近活动的;无窗口新开一个 (软件定义书 6.5.2)
 * - 右键菜单 V1 完整规格 (软件定义书 6.5.3) 包括会话子菜单 / 设置 /
 *   完全退出。CP-1 仅实现"打开新窗口" + "完全退出",其余项 CP-3/CP-4
 *   随 SessionManager / SettingsManager 接入后补齐。
 * - 完全退出: 设置 isQuitting → 显式 app.quit(),让 Electron 走标准退出
 *   (before-quit → will-quit → quit)。这样 window-all-closed 不会被
 *   误解为纯托盘模式。
 * - 图标: CP-1 用 nativeImage.createFromBitmap 程序化生成 16x16 Rose Pine
 *   紫色方块,避免引入二进制 .ico 资源。CP-4 阶段会换成 build/icon.ico。
 *
 * @对应文档章节: 软件定义书.md 6.5、7.4 节;AGENTS.md CP-1 完成标志
 *
 * @不要在这里做的事:
 * - 不要在这里弹"完全退出"二次确认对话框 (CP-1 还没 session 概念,
 *   无法判断"有 session 在跑"。CP-3 有 SessionManager 后再加,
 *   软件定义书 7.4.3)
 * - 不要直接调 BrowserWindow API (通过 WindowManager)
 */
import {
  app,
  clipboard,
  dialog,
  Menu,
  nativeImage,
  Tray,
  type MenuItemConstructorOptions,
  type NativeImage,
} from 'electron';
import { EVENT_CHANNELS } from '@shared/protocol';
import { randomUUID } from 'node:crypto';
import type { WindowManager } from './window-manager';
import type { RemoteDaemonProfile, SessionInfo } from '@shared/types';
import type { SessionManager } from './session-manager';
import type { SettingsManager } from './settings-manager';
import { logger } from './logger';
import { setQuitting } from './index';

/**
 * 程序化生成 16×16 RGBA 托盘占位图标。
 *
 * M1-E 起,接受 variant 区分三态(spec 6.5.1):
 *   - 'default':静态深紫,Iris 紫色 ">" 内填 — 无 session 或 idle
 *   - 'active':绿色光点 — 至少一个 session 处于 active
 *
 * variant='build-icon' 时优先尝试从 build/icon.ico 读取真实设计图标(打包后用)。
 * 读取失败统一 fallback 到 default 程序生成版,确保始终有图标显示。
 */
function generateTrayIcon(variant: 'default' | 'active'): NativeImage {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);

  // Rose Pine 色板
  const BASE = [0x19, 0x17, 0x24]; // 背景
  const IRIS = [0xc4, 0xa7, 0xe7]; // 提示符
  const PINE = [0x31, 0x74, 0x8f]; // active 光点

  // 圆角矩形背景
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // 四角去角
      const corner =
        (x < 2 && y < 2) ||
        (x >= size - 2 && y < 2) ||
        (x < 2 && y >= size - 2) ||
        (x >= size - 2 && y >= size - 2);
      if (corner) {
        buf[i] = 0;
        buf[i + 1] = 0;
        buf[i + 2] = 0;
        buf[i + 3] = 0;
      } else {
        buf[i] = BASE[0]!;
        buf[i + 1] = BASE[1]!;
        buf[i + 2] = BASE[2]!;
        buf[i + 3] = 0xff;
      }
    }
  }

  // 画 ">" 提示符 (在 (4-9, 5-11) 区域用 IRIS 色)
  const promptPixels: ReadonlyArray<readonly [number, number]> = [
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 8],
    [6, 9],
    [5, 10],
    [4, 11],
  ];
  for (const [px, py] of promptPixels) {
    const i = (py * size + px) * 4;
    buf[i] = IRIS[0]!;
    buf[i + 1] = IRIS[1]!;
    buf[i + 2] = IRIS[2]!;
    buf[i + 3] = 0xff;
    // 加粗一像素
    const i2 = (py * size + px + 1) * 4;
    buf[i2] = IRIS[0]!;
    buf[i2 + 1] = IRIS[1]!;
    buf[i2 + 2] = IRIS[2]!;
    buf[i2 + 3] = 0xff;
  }

  // active 时右下角加 3×3 绿光点
  if (variant === 'active') {
    for (let y = 11; y < 14; y++) {
      for (let x = 11; x < 14; x++) {
        const i = (y * size + x) * 4;
        buf[i] = PINE[0]!;
        buf[i + 1] = PINE[1]!;
        buf[i + 2] = PINE[2]!;
        buf[i + 3] = 0xff;
      }
    }
  }

  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

export class TrayManager {
  private tray: Tray | null = null;
  /** M1-H:状态变化节流,避免高频抖动 */
  private rebuildTimer: NodeJS.Timeout | null = null;
  private currentIconVariant: 'default' | 'active' = 'default';
  /** v2.0 远程后端(§14.9):daemon 模式下的配对密码,供托盘菜单"复制 daemon 密码"。null = 非 daemon 模式 / 未设置。 */
  private daemonToken: string | null = null;
  /** daemon 监听端口(默认 12580),供托盘菜单展示"daemon 信息"。null = 非 daemon 模式。 */
  private daemonPort: number | null = null;
  /** 重置密码的回调(index.ts 注入:调 resetDaemonCredentials + setDaemonToken)。无 = 未注入。 */
  private resetDaemonTokenHandler: (() => Promise<void>) | null = null;
  /** v2.0 远程后端(每窗口):远程 profile 列表 provider,供托盘"连接到远程…"子菜单。无 = 未注入。 */
  private remoteProfilesProvider: (() => RemoteDaemonProfile[]) | null = null;

  constructor(
    private readonly windowManager: WindowManager,
    private readonly sessionManager?: SessionManager,
    private readonly settingsManager?: SettingsManager,
  ) {}

  /**
   * 设置 daemon 配对密码(供托盘菜单展示/复制)。
   * index.ts 在 --headless --daemon 模式启动拿到密码后调。
   */
  setDaemonToken(token: string | null): void {
    this.daemonToken = token;
    this.rebuildContextMenu();
  }

  /** 设置 daemon 监听端口(供托盘菜单展示)。 */
  setDaemonPort(port: number | null): void {
    this.daemonPort = port;
    this.rebuildContextMenu();
  }

  /**
   * 注入重置 token 的回调(只在 daemon 模式下注入,菜单才显示"重置"项)。
   * handler 内部:resetDaemonCredentials → setDaemonToken(新) → 日志。
   */
  setResetDaemonTokenHandler(handler: () => Promise<void>): void {
    this.resetDaemonTokenHandler = handler;
    this.rebuildContextMenu();
  }

  /**
   * 注入远程 profile 列表 provider(供托盘"连接到远程…"子菜单)。
   * profile CRUD 后调以刷菜单。index.ts 注入:= () => remoteProfileManager.list()。
   */
  setRemoteProfilesProvider(provider: () => RemoteDaemonProfile[]): void {
    this.remoteProfilesProvider = provider;
    this.rebuildContextMenu();
  }

  /** profile 列表变化时外部调,刷托盘菜单(连接到远程子菜单)。 */
  refreshRemoteProfilesMenu(): void {
    if (this.remoteProfilesProvider) this.rebuildContextMenu();
  }

  /**
   * 初始化托盘。必须在 app.whenReady() 之后调用。
   * 重复调用会先销毁旧的再建新的。
   */
  init(): void {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }

    this.tray = new Tray(generateTrayIcon('default'));
    this.tray.setToolTip('Marina');

    this.tray.on('click', () => this.handleSingleClick());
    // 双击在 Windows 等同于单击 (软件定义书 6.5.2: "避免双击意外行为")
    this.tray.on('double-click', () => this.handleSingleClick());

    this.rebuildContextMenu();
    this.refreshIcon();

    // 窗口 / session 变化都触发菜单 + 图标重建(节流 300ms)
    this.windowManager.onWindowCreated(() => this.scheduleRebuild());
    this.windowManager.onWindowClosed(() => this.scheduleRebuild());
    this.sessionManager?.on('sessionCreated', () => this.scheduleRebuild());
    this.sessionManager?.on('sessionDestroyed', () => this.scheduleRebuild());
    this.sessionManager?.on('sessionStateChanged', () => this.scheduleRebuild());
    this.sessionManager?.on('sessionOwnerChanged', () => this.scheduleRebuild());
  }

  private scheduleRebuild(): void {
    if (this.rebuildTimer) return;
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      this.rebuildContextMenu();
      this.refreshIcon();
    }, 300);
  }

  /**
   * M1-H:刷新图标与 tooltip,根据当前 session 集合判断 active/idle。
   */
  private refreshIcon(): void {
    if (!this.tray) return;
    const sessions = this.sessionManager?.list() ?? [];
    const total = sessions.length;
    const live = sessions.filter((s) => s.state !== 'exited').length;
    const active = sessions.filter((s) => s.state === 'active').length;
    const desired: 'default' | 'active' = active > 0 ? 'active' : 'default';
    if (desired !== this.currentIconVariant) {
      this.currentIconVariant = desired;
      try {
        this.tray.setImage(generateTrayIcon(desired));
      } catch (err) {
        logger.warn('TrayManager', 'setImage failed', err);
      }
    }
    this.tray.setToolTip(
      `Marina — ${total} 个会话${total > 0 ? ` (${live} 运行中,${active} 活跃)` : ''}`,
    );
  }

  /**
   * 销毁托盘图标。在 app.quit 真正执行前调用,避免图标残留几秒钟。
   */
  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  /**
   * 单击 / 双击托盘:
   * - 有窗口 → 聚焦最近活动的 (若被最小化则恢复)
   * - 无窗口 → 新开一个
   */
  private handleSingleClick(): void {
    const recent = this.windowManager.getMostRecentlyActive();
    if (recent) {
      if (recent.isMinimized()) recent.restore();
      recent.focus();
      return;
    }
    try {
      this.windowManager.createWindowFromFactory();
    } catch (err) {
      logger.error('TrayManager', 'handleSingleClick: createWindow failed', err);
    }
  }

  /**
   * 重建右键菜单。M1-H 完整化(spec 6.5.3):
   *   - 打开新窗口
   *   - 显示所有窗口(>=1 窗口时)
   *   - 关闭所有窗口(>=1 窗口时)
   *   - --
   *   - 正在运行的会话(子菜单,>=1 session 时)
   *   - --
   *   - 设置
   *   - 完全退出 Marina
   */
  private rebuildContextMenu(): void {
    if (!this.tray) return;

    const sessions = this.sessionManager?.list() ?? [];
    const liveSessions = sessions.filter((s) => s.state !== 'exited');
    const windowCount = this.windowManager.count();

    const items: MenuItemConstructorOptions[] = [];

    items.push({
      label: '打开新窗口',
      click: () => {
        try {
          this.windowManager.createWindowFromFactory();
        } catch (err) {
          logger.error('TrayManager', 'open new window failed', err);
        }
      },
    });

    if (windowCount > 0) {
      items.push({
        label: '显示所有窗口',
        click: () => {
          for (const info of this.windowManager.list()) {
            const w = this.windowManager.getById(info.id);
            if (!w || w.isDestroyed()) continue;
            if (w.isMinimized()) w.restore();
            w.show();
          }
        },
      });
      items.push({
        label: `关闭所有窗口 (${windowCount})`,
        click: () => {
          // 关闭所有窗口 — 不影响 session,应用进入"纯托盘模式"
          for (const info of this.windowManager.list()) {
            this.windowManager.closeWindow(info.id);
          }
        },
      });
    }

    items.push({ type: 'separator' });

    // 正在运行的会话子菜单
    if (sessions.length > 0) {
      const submenu: MenuItemConstructorOptions[] = sessions.map((s) =>
        this.buildSessionMenuItem(s),
      );
      items.push({
        label: `正在运行的会话 (${sessions.length})`,
        submenu,
      });
      items.push({ type: 'separator' });
    }

    // v2.0 远程连接(客户端角色):开新窗口连保存的远程电脑。列已设密码的 profile。
    const remoteProfiles = this.remoteProfilesProvider?.() ?? [];
    if (remoteProfiles.length > 0) {
      items.push({
        label: '连接到其他电脑…',
        submenu: remoteProfiles.map((p) => ({
          label: `${p.displayName} (${p.host})${p.hasToken ? '' : ' · 未设密码'}`,
          enabled: p.hasToken !== false,
          click: () => {
            try {
              const info = this.windowManager.createWindowFromFactory({ backendProfileId: p.id });
              // 托盘绕过 ipc WINDOW_CREATE handler，需同步设置 OS 层标题，
              // 否则自绘标题栏有远程名但任务栏 / Alt+Tab 仍只显示普通 Window N。
              this.windowManager
                .getById(info.id)
                ?.setTitle(`Marina — Window ${info.number} → ${p.displayName} (${p.host})`);
            } catch (err) {
              logger.error('TrayManager', 'open remote window failed', err);
            }
          },
        })),
      });
    }

    items.push({
      label: '设置…',
      click: () => this.openSettings(),
    });

    // v2.0 远程连接(服务端角色):展示服务端口 + 复制连接密码 + 重置密码快捷入口
    // (密码加载后就有,不只运行中。设置页“允许远程连接”是主控,托盘是便捷复制/查看)。
    if (this.daemonToken) {
      // 服务端口(只读展示,设置页可改)。未启动时展示配置里的端口。
      if (this.daemonPort !== null) {
        items.push({ label: `服务端口: ${this.daemonPort}`, enabled: false });
      }
      items.push({
        label: '复制连接密码',
        click: () => {
          clipboard.writeText(this.daemonToken ?? '');
          logger.info('TrayManager', 'connection password copied to clipboard');
        },
      });
      // 重置密码(吊销所有已连电脑)。需确认 —— 重置后已连的都要用新密码重连。
      if (this.resetDaemonTokenHandler) {
        items.push({
          label: '重置连接密码…',
          click: async () => {
            const choice = await dialog.showMessageBox({
              type: 'warning',
              buttons: ['重置', '取消'],
              defaultId: 1,
              cancelId: 1,
              title: '重置连接密码',
              message: '重置后所有已连接的电脑都会被断开,需用新密码重新连接。确定?',
            });
            if (choice.response === 0) {
              try {
                await this.resetDaemonTokenHandler!();
                logger.info('TrayManager', 'connection password reset (all clients revoked)');
              } catch (err) {
                logger.error('TrayManager', 'connection password reset failed', err);
              }
            }
          },
        });
      }
    }

    items.push({ type: 'separator' });

    items.push({
      label: `完全退出 Marina${liveSessions.length > 0 ? ` (${liveSessions.length} 个会话运行中)` : ''}`,
      click: () => this.quitApp(),
    });

    this.tray.setContextMenu(Menu.buildFromTemplate(items));
  }

  /**
   * 构造"正在运行的会话"子菜单中的单项。
   * 状态符号:● active / ◐ idle / ○ exited;点击 → 聚焦 owner 窗口并选中该 session。
   */
  private buildSessionMenuItem(s: SessionInfo): MenuItemConstructorOptions {
    const symbol = s.state === 'active' ? '●' : s.state === 'idle' ? '◐' : '○';
    const cwd = s.currentCwd || s.originalCwd;
    const cwdShort = cwd.length > 50 ? '…' + cwd.slice(-47) : cwd;
    return {
      label: `${symbol} ${s.displayName}   ${cwdShort}`,
      click: () => this.focusSession(s),
    };
  }

  private focusSession(s: SessionInfo): void {
    try {
      const ownerId = s.ownerWindowId;
      if (ownerId) {
        const win = this.windowManager.getById(ownerId);
        if (win && !win.isDestroyed()) {
          if (win.isMinimized()) win.restore();
          win.focus();
          win.webContents.send(EVENT_CHANNELS.WINDOW_FOCUS_REQUESTED, {
            eventId: randomUUID(),
            timestamp: Date.now(),
            payload: { reason: 'tray-session-click', selectSessionId: s.id },
          });
          return;
        }
      }
      // 无 owner:新开窗口并发选中事件
      const info = this.windowManager.createWindowFromFactory();
      const win = this.windowManager.getById(info.id);
      // 窗口 ready 后才发(否则 webContents.send 没人接);用 once webContents.did-finish-load
      win?.webContents.once('did-finish-load', () => {
        if (win.isDestroyed()) return;
        win.webContents.send(EVENT_CHANNELS.WINDOW_FOCUS_REQUESTED, {
          eventId: randomUUID(),
          timestamp: Date.now(),
          payload: { reason: 'tray-session-click', selectSessionId: s.id },
        });
      });
    } catch (err) {
      logger.error('TrayManager', 'focusSession failed', err);
    }
  }

  private openSettings(): void {
    try {
      let recent = this.windowManager.getMostRecentlyActive();
      if (!recent) {
        const info = this.windowManager.createWindowFromFactory();
        recent = this.windowManager.getById(info.id);
      }
      if (!recent || recent.isDestroyed()) return;
      if (recent.isMinimized()) recent.restore();
      recent.focus();
      // 让 renderer 切到 settings 视图。当前没有 cmd:view:enter-settings,
      // 复用 WINDOW_FOCUS_REQUESTED + 一个特殊 reason,renderer 端识别即切。
      recent.webContents.send(EVENT_CHANNELS.WINDOW_FOCUS_REQUESTED, {
        eventId: randomUUID(),
        timestamp: Date.now(),
        payload: { reason: 'tray-open-settings' },
      });
    } catch (err) {
      logger.error('TrayManager', 'openSettings failed', err);
    }
  }

  /**
   * 完全退出应用 (软件定义书 7.4.3)。
   *
   * CP-4 起完整版:
   * - settings.behavior.confirmOnQuit=true 且有 session 在跑(state≠exited)
   *   → 弹 dialog.showMessageBox 二次确认
   * - 用户点"取消" → 不退出
   * - 用户点"退出" → setQuitting + app.quit (will-quit 会负责 SIGTERM
   *   + 等 5 秒强制 kill,见 软件定义书 7.4.3)
   *
   * 关闭单窗口绝对不调到这里 (软件定义书 7.4.1, AGENTS.md 红线)。
   */
  private async quitApp(): Promise<void> {
    const settings = this.settingsManager?.get();
    const confirmOnQuit = settings?.behavior?.confirmOnQuit ?? true;
    const sessions = this.sessionManager?.list() ?? [];
    const liveCount = sessions.filter((s) => s.state !== 'exited').length;

    if (confirmOnQuit && liveCount > 0) {
      const owner = this.windowManager.getMostRecentlyActive();
      const result = await dialog.showMessageBox(owner ?? (undefined as never), {
        type: 'warning',
        title: '完全退出 Marina?',
        message: `还有 ${liveCount} 个终端在运行,完全退出会关掉它们。`,
        detail: '如果只想隐藏窗口,请关闭窗口而不是"完全退出"。',
        buttons: ['取消', '完全退出'],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response !== 1) return;
    }

    setQuitting();
    this.destroy();
    app.quit();
  }
}
