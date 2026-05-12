/**
 * @file src/main/index.ts
 * @purpose Electron 主进程 entry。装配所有 manager,初始化持久化 store,
 *   注册 IPC 层,管理应用整体生命周期。
 *
 * @关键设计:
 * - 单实例锁: 第二次启动 Marina.exe 转发到已运行实例新开窗口
 *   (软件定义书 5.1.6, AGENTS.md CP-1 完成标志)
 * - window-all-closed 不调用 app.quit() — 应用进入"纯托盘模式"
 *   (软件定义书 8.1, 9.2.1)
 * - 退出仅来自 TrayManager 的"完全退出"或 cmd:app:quit IPC,通过 isQuitting
 *   标志区分"窗口关"与"应用真退出"
 * - 启动顺序:单实例锁 → app.whenReady → JsonStore 创建 → manager.initialize
 *   并行 → installIpcLayer → trayManager.init → 创建首窗
 * - 退出顺序:before-quit → SessionManager.shutdown → manager.flush 等待
 *   持久化落盘 → will-quit → trayManager.destroy
 *
 * @对应文档章节: 软件定义书.md 8.1、9.2.1;AGENTS.md 检查点 1/2
 */
import { app, Menu, session as electronSession } from 'electron';
import { join } from 'node:path';
import { WindowManager } from './window-manager';
import { TrayManager } from './tray';
import { SessionManager } from './session-manager';
import { PathManager } from './path-manager';
import { SettingsManager, DEFAULT_SETTINGS } from './settings-manager';
import { TemplatesManager } from './templates-manager';
import { JsonStore } from './persistence';
import { installIpcLayer } from './ipc';
import { getPlatformAdapter } from './platform';
import { logger } from './logger';
import type {
  BookmarksFile,
  RecentFile,
  Settings,
  TemplatesFile,
} from '@shared/types';

let isQuitting = false;

export function setQuitting(): void {
  isQuitting = true;
}

export function getIsQuitting(): boolean {
  return isQuitting;
}

function bootstrap(): void {
  // M1-D:全局崩溃兜底 — daily driver 最大风险是"未捕获异常让主进程死掉,
  // 一刹那所有 PTY 全部消失,用户工作全丢"。装一层 net,只记日志不让进程退,
  // 已经损坏的状态由各 manager 自愈或下次操作时校验。
  process.on('uncaughtException', (err) => {
    try {
      logger.error('main', 'uncaughtException — keeping process alive', err);
    } catch {
      console.error('[main] uncaughtException (logger unavailable):', err);
    }
  });
  process.on('unhandledRejection', (reason) => {
    try {
      logger.error('main', 'unhandledRejection', reason);
    } catch {
      console.error('[main] unhandledRejection:', reason);
    }
  });

  // CP-4 勘误 #13:dev 模式下 Vite + React Fast Refresh 必须 'unsafe-eval'。
  // 我们已通过 webRequest 显式设置 CSP (含 unsafe-eval@dev),Electron 看到
  // unsafe-eval 仍会在 renderer 控制台打印 "Insecure Content-Security-Policy"
  // 警告 — 这是它的硬编码检查。生产环境警告不会出现 (打包后该模块不加载)。
  // 显式关掉只针对未打包模式(dev)有效;打包后无影响。
  if (!app.isPackaged) {
    process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true';
  }

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  const windowManager = new WindowManager();

  // 数据目录:%APPDATA%\Marina (Electron 由 productName 自动派生;v1.5 改名后从 EasyTerm 切到 Marina,见 ADR-012)
  // 注:在 app.whenReady 之前调 app.getPath('userData') 是合法的,
  // Electron 31 在 ready 前就把它解析好了
  const dataDir = app.getPath('userData');

  // M1-D:绑定日志目录 (fire-and-forget,在此之前的 logger 调用先缓存到内存)
  void logger.setLogDir(join(dataDir, 'logs'));
  logger.info('main', 'bootstrap starting', { dataDir });
  const settingsStore = new JsonStore<Settings>(join(dataDir, 'settings.json'));
  const bookmarksStore = new JsonStore<BookmarksFile>(join(dataDir, 'bookmarks.json'));
  const recentStore = new JsonStore<RecentFile>(join(dataDir, 'recent.json'));
  const templatesStore = new JsonStore<TemplatesFile>(join(dataDir, 'templates.json'));

  const settingsManager = new SettingsManager(settingsStore);
  const pathManager = new PathManager(bookmarksStore, recentStore);
  const templatesManager = new TemplatesManager(templatesStore);
  const sessionManager = new SessionManager(
    windowManager,
    pathManager,
    templatesManager,
    settingsManager,
  );
  const trayManager = new TrayManager(windowManager, sessionManager, settingsManager);

  // M1-G:WindowManager 工厂注入 — 把 settings.windowDefaults 包成
  // initialBounds + onBeforeClose,所有 createWindow 入口共用。
  windowManager.setCreateOptionsProvider(() => {
    const s = settingsManager.get();
    const initialBounds = s.windowDefaults
      ? {
          width: s.windowDefaults.width,
          height: s.windowDefaults.height,
          ...(s.windowDefaults.x !== undefined ? { x: s.windowDefaults.x } : {}),
          ...(s.windowDefaults.y !== undefined ? { y: s.windowDefaults.y } : {}),
          maximized: !!s.windowDefaults.maximized,
        }
      : undefined;
    return {
      ...(initialBounds ? { initialBounds } : {}),
      onBeforeClose: (b) => {
        try {
          settingsManager.update({
            windowDefaults: {
              width: b.width,
              height: b.height,
              x: b.x,
              y: b.y,
              maximized: b.maximized,
            },
          });
        } catch (err) {
          console.warn('[main] persist windowDefaults failed:', err);
        }
      },
    };
  });

  // second-instance:已有窗口时聚焦最近活动的;否则新开。
  // M1-K:对齐"双击桌面快捷方式不该无脑新开窗口"的 daily-driver 直觉。
  app.on('second-instance', () => {
    try {
      const recent = windowManager.getMostRecentlyActive();
      if (recent) {
        if (recent.isMinimized()) recent.restore();
        recent.focus();
      } else {
        windowManager.createWindowFromFactory();
      }
    } catch (err) {
      console.error('[main] second-instance: createWindow failed', err);
    }
  });

  app.on('window-all-closed', () => {
    // window-all-closed 不退出:进入"纯托盘模式"
    // isQuitting=true 时 (主动 quit) 让默认行为执行,继续走 before-quit / will-quit
    if (isQuitting) return;
  });

  app.on('before-quit', () => {
    isQuitting = true;
  });

  app.whenReady().then(async () => {
    try {
      // M1-A 配套(P0-2):把 Electron 默认 application menu (File/Edit/View/...)
      // 完全禁掉。与"自绘标题栏 + 软件定义书 7.1 不做应用内快捷键"哲学一致。
      // 仍保留 webContents.before-input-event 拦截 F12 / Ctrl+Shift+I 开 DevTools
      // (在 window-manager.ts 内单独注册,与 menu 是否存在无关)。
      Menu.setApplicationMenu(null);

      // CP-4 勘误 #3:自动放行 'local-fonts' 权限 — 让 renderer 可以调用
      // navigator.fonts.query() / window.queryLocalFonts() 枚举系统字体,
      // 用于设置页"终端字体"和"UI 字体"下拉框列表 (替代写死白名单)。
      // 同步授权也需要 setPermissionCheckHandler。
      // CP-4 勘误 #13:同时把 CSP 通过响应头方式补上,即使 dev 模式下 Vite
      // 把页面 meta CSP 剥掉 / 改写,我们仍保证 CSP 已设置 — Electron 的
      // "no CSP" 安全警告主要看响应头。
      // 'local-fonts' 在 Electron 31 的 TS 类型里还未收录,但运行时是合法权限名
      // (Chromium 实现);用 string 比较绕开 TS 字面量收窄。
      const FONT_PERMISSION = 'local-fonts' as const;
      electronSession.defaultSession.setPermissionRequestHandler(
        (_webContents, permission, callback) => {
          const p = permission as string;
          if (p === FONT_PERMISSION || p === 'clipboard-read') {
            callback(true);
            return;
          }
          callback(false);
        },
      );
      electronSession.defaultSession.setPermissionCheckHandler((_wc, permission) => {
        const p = permission as string;
        return p === FONT_PERMISSION || p === 'clipboard-read';
      });

      const isDev = !!process.env['ELECTRON_RENDERER_URL'];
      // CSP via headers (兜底 + 消除 Electron unsafe-eval / 缺失 CSP 警告)。
      // dev 模式 Vite 的 React Refresh 用 new Function/eval,需要 'unsafe-eval';
      // 生产 (file://) 不需要。
      const cspProd =
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "font-src 'self' data:; img-src 'self' data:; connect-src 'self'";
      const cspDev =
        "default-src 'self' http://127.0.0.1:* ws://127.0.0.1:*; " +
        "script-src 'self' 'unsafe-eval' 'unsafe-inline' http://127.0.0.1:*; " +
        "style-src 'self' 'unsafe-inline' http://127.0.0.1:*; " +
        "font-src 'self' data: http://127.0.0.1:*; " +
        "img-src 'self' data: http://127.0.0.1:*; " +
        "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*";
      electronSession.defaultSession.webRequest.onHeadersReceived(
        (details, callback) => {
          callback({
            responseHeaders: {
              ...details.responseHeaders,
              'Content-Security-Policy': [isDev ? cspDev : cspProd],
            },
          });
        },
      );

      // 加载持久化数据,故意串行 (settings 决定后续行为,先加载)
      const settingsSrc = await settingsManager.initialize();
      logger.info('main', `settings loaded from: ${settingsSrc}`);
      logger.setLevel(
        settingsManager.get().advanced.logLevel === 'DEBUG' ? 'debug' : 'info',
      );
      await pathManager.initialize();
      const tmplSrc = await templatesManager.initialize();
      logger.info('main', `templates loaded from: ${tmplSrc}`);

      installIpcLayer({
        windowManager,
        pathManager,
        settingsManager,
        sessionManager,
        templatesManager,
      });

      // ── 设置副作用 wiring ─────────────────────────────
      // settings.behavior.autoStart 改变 → 触发 OS Run 表写入
      //
      // CP-4 勘误 #2:已经移除 "跟随系统主题" 功能 (nativeTheme 监听 +
      // followSystemTheme 字段)。原因:Windows 上 nativeTheme.shouldUseDarkColors
      // 在不少机器上不可靠 (尤其多用户 / 远程会话),自动切主题反而是 bug 来源;
      // 用户主动选 7 套主题已足够。
      const platformAdapter = process.platform === 'win32' ? getPlatformAdapter() : null;

      settingsManager.on('settingsChanged', (e: { changedKeys: string[]; settings: Settings }) => {
        if (e.changedKeys.includes('behavior.autoStart') && platformAdapter) {
          platformAdapter
            .setAutoStart(e.settings.behavior.autoStart)
            .catch((err) => logger.warn('main', 'setAutoStart failed', err));
        }
        // M1-D:日志级别即改即生效
        if (e.changedKeys.includes('advanced.logLevel')) {
          logger.setLevel(e.settings.advanced.logLevel === 'DEBUG' ? 'debug' : 'info');
        }
      });

      trayManager.init();
      // 启动行为:settings.behavior.startupBehavior='tray-only' → 不开窗口,只托盘运行
      if (settingsManager.get().behavior.startupBehavior !== 'tray-only') {
        windowManager.createWindowFromFactory();
      }
    } catch (err) {
      logger.error('main', 'bootstrap failed', err);
      // 启动失败不应让用户看到空白进程,直接退出
      app.exit(1);
    }
  });

  // 真退出前:杀 PTY、刷盘、销毁托盘
  app.on('will-quit', async () => {
    if (!isQuitting) return; // 防御性:不该走到这,因为 before-quit 已 set
    logger.info('main', 'will-quit: shutting down session manager + flushing stores');
    sessionManager.shutdown();
    try {
      // 等数据落盘最多 1 秒,避免无限 block
      const flushAll = Promise.all([
        settingsManager.flush(),
        pathManager.flush(),
        templatesManager.flush(),
        logger.flush(),
      ]);
      await Promise.race([
        flushAll,
        new Promise<void>((resolve) => setTimeout(resolve, 1000)),
      ]);
    } catch (err) {
      logger.warn('main', 'flush during quit failed', err);
    }
    trayManager.destroy();
  });

  // ESLint:DEFAULT_SETTINGS 引用让 import 不被 tree-shake 警告。
  // 实际我们不在这用,留这一行为了明示编译期依赖。
  void DEFAULT_SETTINGS;
}

bootstrap();
