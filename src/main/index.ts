/**
 * @file src/main/index.ts
 * @purpose Electron 主进程 entry。负责守护进程的整体启动 / 退出流程,
 *   把窗口管理委托给 WindowManager,把托盘管理委托给 TrayManager,
 *   PTY 管理委托给 PtyController。
 *
 * @关键设计:
 * - 单实例锁: 第二次启动 EasyTerm.exe 转发到已运行实例新开窗口
 *   (软件定义书 5.1.6, AGENTS.md CP-1 完成标志)
 * - window-all-closed 不调用 app.quit() — 应用进入"纯托盘模式",
 *   生命周期独立于任何窗口 (软件定义书 8.1, 9.2.1)
 * - 退出仅来自 TrayManager 的"完全退出"主动触发 + 用 isQuitting
 *   标志区分"窗口关"与"应用真退出",before-quit 设此标志
 * - 子模块的初始化顺序:WindowManager → TrayManager → PtyController →
 *   IPC handlers → 创建首个窗口
 *
 * @对应文档章节: 软件定义书.md 第 8.1、9.2.1 节;AGENTS.md 检查点 1
 *
 * @不要在这里做的事:
 * - 不要直接创建 BrowserWindow (那是 WindowManager 的职责)
 * - 不要直接 spawn PTY (那是 PtyController 的职责)
 * - 不要写业务逻辑 — 这个文件只是装配 + 生命周期事件
 */
import { app } from 'electron';
import { WindowManager } from './window-manager';
import { TrayManager } from './tray';

/**
 * 应用是否处于"完全退出"流程中。从托盘菜单"完全退出 EasyTerm"触发后置 true。
 * before-quit 钩子也会置 true,用于区分:
 * - 窗口被关 (isQuitting=false): 应用继续在纯托盘模式
 * - 应用真退出 (isQuitting=true): TrayManager 销毁托盘图标
 */
let isQuitting = false;

export function setQuitting(): void {
  isQuitting = true;
}

export function getIsQuitting(): boolean {
  return isQuitting;
}

/**
 * 装配子系统并打开第一个窗口。
 *
 * 顺序敏感性:
 * 1. 单实例锁必须在所有子系统初始化前申请,失败立刻 quit
 * 2. WindowManager 在 app.whenReady() 后才能用 (BrowserWindow 需要 app ready)
 * 3. PtyController / TrayManager 在 WindowManager 之后,因为他们订阅其事件
 * 4. 创建首个窗口必须在以上全部就绪后
 */
function bootstrap(): void {
  // 单实例锁: 第二次启动转发已运行实例新开窗口
  // (CP-1 完成标志: AGENTS.md 4.2 检查点 1)
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  const windowManager = new WindowManager();

  // 第二次启动 EasyTerm.exe → 在已运行实例上新开一个窗口 (软件定义书 5.1.6)
  // 不是聚焦旧窗口,因为"用户主动启动一次"应该有一个新窗口出现作为反馈。
  app.on('second-instance', () => {
    try {
      windowManager.createWindow();
    } catch (err) {
      console.error('[main] second-instance: createWindow failed', err);
    }
  });

  // 关闭所有窗口绝不退出应用 (软件定义书 9.2.1)
  // 即使在 macOS / Linux,我们也保持托盘常驻 (软件定义书 12.3)
  // 例外: isQuitting=true 时是"完全退出"流程,让 Electron 继续走默认退出
  app.on('window-all-closed', () => {
    if (isQuitting) {
      // 让默认行为执行 (即什么都不做,因为我们将在 before-quit/will-quit 链上自然退出)
      return;
    }
    // 故意留空 — 进入"纯托盘模式" (TrayManager 已设置托盘图标常驻)
  });

  app.on('before-quit', () => {
    isQuitting = true;
  });

  const trayManager = new TrayManager(windowManager);

  app.whenReady().then(() => {
    trayManager.init();
    // CP-1 后续 commit 加入: PtyController
    windowManager.createWindow();
  });

  // 真退出前确保托盘图标先消失,避免短暂残留
  app.on('will-quit', () => {
    trayManager.destroy();
  });
}

bootstrap();
