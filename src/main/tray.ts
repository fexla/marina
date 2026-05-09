/**
 * @file src/main/tray.ts
 * @purpose 系统托盘管理。常驻托盘图标、右键菜单、单击聚焦最近活动窗口、
 *   "完全退出 EasyTerm"流程。
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
import { app, Menu, nativeImage, Tray, type NativeImage } from 'electron';
import type { WindowManager } from './window-manager';
import { setQuitting } from './index';

/**
 * 程序化生成一个 16x16 Rose Pine 风格的托盘占位图标。
 *
 * 设计:深紫色边框 (base #191724) + 浅紫色内填 (iris #c4a7e7),
 * 在浅色与深色 Windows 任务栏下都有一定辨识度。
 *
 * 不用外部 .ico 文件的理由:
 * - CP-1 不引入二进制资源,git 历史更清爽
 * - CP-4 打包阶段会有真正的设计图标
 * - createFromBitmap 在 Win/mac/Linux 都能跑
 */
function generatePlaceholderTrayIcon(): NativeImage {
  const size = 16;
  const buffer = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const isBorder = x === 0 || x === size - 1 || y === 0 || y === size - 1;
      if (isBorder) {
        buffer[i] = 0x19; // base R
        buffer[i + 1] = 0x17; // G
        buffer[i + 2] = 0x24; // B
        buffer[i + 3] = 0xff;
      } else {
        buffer[i] = 0xc4; // iris R
        buffer[i + 1] = 0xa7; // G
        buffer[i + 2] = 0xe7; // B
        buffer[i + 3] = 0xff;
      }
    }
  }
  return nativeImage.createFromBitmap(buffer, { width: size, height: size });
}

export class TrayManager {
  private tray: Tray | null = null;

  constructor(private readonly windowManager: WindowManager) {}

  /**
   * 初始化托盘。必须在 app.whenReady() 之后调用。
   * 重复调用会先销毁旧的再建新的。
   */
  init(): void {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }

    const icon = generatePlaceholderTrayIcon();
    this.tray = new Tray(icon);
    this.tray.setToolTip('EasyTerm');

    this.tray.on('click', () => this.handleSingleClick());
    // 双击在 Windows 等同于单击 (软件定义书 6.5.2: "避免双击意外行为")
    this.tray.on('double-click', () => this.handleSingleClick());

    this.rebuildContextMenu();

    // 窗口数变化时菜单某些项 (例如未来的"显示所有 / 关闭所有") 需要刷新
    this.windowManager.onWindowCreated(() => this.rebuildContextMenu());
    this.windowManager.onWindowClosed(() => this.rebuildContextMenu());
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
      this.windowManager.createWindow();
    } catch (err) {
      console.error('[TrayManager] handleSingleClick: createWindow failed', err);
    }
  }

  /**
   * 重建右键菜单。每次窗口数变化时调用。
   *
   * CP-1 阶段菜单非常精简,完整版本 (软件定义书 6.5.3) 在后续 CP 加入:
   *   - "显示所有窗口" (CP-1 用不到,只有 1-N 个窗口都已可见)
   *   - "关闭所有窗口" (CP-2 加,用于多窗口场景)
   *   - "正在运行的会话" 子菜单 (CP-3 加,需要 SessionManager)
   *   - "设置" (CP-4 加,需要 SettingsManager 路由)
   */
  private rebuildContextMenu(): void {
    if (!this.tray) return;

    const menu = Menu.buildFromTemplate([
      {
        label: '打开新窗口',
        click: () => {
          try {
            this.windowManager.createWindow();
          } catch (err) {
            console.error('[TrayManager] open new window failed', err);
          }
        },
      },
      { type: 'separator' },
      {
        label: '完全退出 EasyTerm',
        click: () => this.quitApp(),
      },
    ]);
    this.tray.setContextMenu(menu);
  }

  /**
   * 完全退出应用 (软件定义书 7.4.3)。
   *
   * CP-1 简化:无 session 概念,直接走 app.quit()。
   * CP-3 起接入 SessionManager 后,会先检查 confirmOnQuit 设置 +
   * 是否有 session 在跑,弹对话框。
   */
  private quitApp(): void {
    setQuitting();
    this.destroy();
    app.quit();
  }
}
