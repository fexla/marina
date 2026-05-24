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
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { WindowManager } from './window-manager';
import { TrayManager } from './tray';
import { SessionManager } from './session-manager';
import { PathManager } from './path-manager';
import { SshProfileManager } from './ssh-profile-manager';
import { KnownHostsManager, type KnownHostsHistoryFile } from './known-hosts-manager';
import { SettingsManager, DEFAULT_SETTINGS } from './settings-manager';
import { TemplatesManager } from './templates-manager';
import { JsonStore } from './persistence';
import { installIpcLayer } from './ipc';
import { getPlatformAdapter } from './platform';
import { AIClient } from './ai-client';
import { WindowsAdapter } from './platform/windows';
import { parseOpenHere, parseSimpleMode } from './argv-utils';
import { getBuildType } from './build-type';
import { logger } from './logger';
import type {
  BookmarksFile,
  RecentFile,
  Settings,
  SshProfilesFile,
  TemplatesFile,
} from '@shared/types';

let isQuitting = false;

export function setQuitting(): void {
  isQuitting = true;
}

export function getIsQuitting(): boolean {
  return isQuitting;
}

/**
 * BETA-043:并行 statSync 一遍所有路径,把不存在 / 非目录 / 无权限的路径喂给
 * PathManager.setInvalidPaths。仅在 bootstrap 末尾调一次,不做后台周期扫
 * (避免无谓 IO,且用户修了路径后随时可以手动重启刷新)。
 */
async function scanInvalidPathsAsync(pathManager: PathManager): Promise<void> {
  const tree = pathManager.getTree();
  const allPaths = [
    ...tree.bookmarks,
    ...tree.temporary,
    ...tree.recent,
  ];
  const invalid: string[] = [];
  for (const node of allPaths) {
    if (node.kind === 'ssh') continue;
    try {
      if (!existsSync(node.path)) {
        invalid.push(node.path);
        continue;
      }
      const st = statSync(node.path);
      if (!st.isDirectory()) invalid.push(node.path);
    } catch {
      invalid.push(node.path);
    }
  }
  if (invalid.length > 0) {
    logger.info('main', `BETA-043 invalid paths detected: ${invalid.length}`);
  }
  pathManager.setInvalidPaths(invalid);
}

function bootstrap(): void {
  // DEV-COEXIST(2026-05-16):dev 模式下改 app 名,让 npm run dev 与打包版
  // Marina.exe 互不冲突。Electron 把以下 4 类资源全部按 `productName` 派生:
  //   - app.getPath('userData') → %APPDATA%\Marina (dev) vs %APPDATA%\Marina
  //   - requestSingleInstanceLock 的锁键(底层用 userData 目录)
  //   - 日志目录(logger 走 join(userData, 'logs'))
  //   - 任务栏 AppUserModelID(影响 Windows 任务栏分组)
  // 必须在 requestSingleInstanceLock / getPath('userData') / setAppUserModelId
  // 之前调用 — 一旦解析过,Electron 缓存了路径,改 name 不再生效。
  //
  // 同样的 portable 形态也独立一份,避免运行中的 portable 与已安装版互踩
  // settings.json / 单实例锁。仅 installed 形态使用 "Marina" 原名。
  if (!app.isPackaged) {
    app.setName('Marina (dev)');
  } else if (process.env['PORTABLE_EXECUTABLE_DIR']) {
    app.setName('Marina (portable)');
  }

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
  // 诊断条目保留:TIT-2 排查时这条 log 是定位 second-instance 路径的关键证据。
  // logger.setLogDir 此时还没调,先进 pending 缓存,setLogDir 后 flush 入盘。
  logger.info('main', 'requestSingleInstanceLock result', {
    gotLock,
    argv: process.argv,
  });
  if (!gotLock) {
    logger.info('main', 'second instance exiting (primary will handle)');
    app.quit();
    return;
  }

  const windowManager = new WindowManager();

  // 数据目录:%APPDATA%\Marina (Electron 由 productName 自动派生;v1.5 改名后从 EasyTerm 切到 Marina,见 ADR-012)
  // 注:在 app.whenReady 之前调 app.getPath('userData') 是合法的,
  // Electron 31 在 ready 前就把它解析好了
  const dataDir = app.getPath('userData');

  // 勘误第二轮:Chromium 启动期报 "Unable to move the cache: 拒绝访问 (0x5)"。
  // 原因:Electron 默认 sessionData == userData,Chromium 把 HTTP/code/GPU 缓存
  // 直接放进 userData 根。这会与 v1.5 改名前残留的目录、单实例锁文件、Backup-*
  // 等结构冲突,Chromium 在迁移时遇到拒绝访问。
  // 把 sessionData 显式指向 userData/session-data 子目录,与设置/书签文件隔离,
  // Chromium 在该子目录里独立初始化缓存,旧目录的占用对它不再可见。
  // 必须在 app.whenReady 之前调,否则 session 已用旧 path 初始化了。
  app.setPath('sessionData', join(dataDir, 'session-data'));

  // M1-D:绑定日志目录 (fire-and-forget,在此之前的 logger 调用先缓存到内存)
  void logger.setLogDir(join(dataDir, 'logs'));
  logger.info('main', 'bootstrap starting', { dataDir });
  const settingsStore = new JsonStore<Settings>(join(dataDir, 'settings.json'));
  const bookmarksStore = new JsonStore<BookmarksFile>(join(dataDir, 'bookmarks.json'));
  const recentStore = new JsonStore<RecentFile>(join(dataDir, 'recent.json'));
  const sshProfilesStore = new JsonStore<SshProfilesFile>(join(dataDir, 'ssh-profiles.json'));
  // SSH 方案 §阶段 3.1:known_hosts 指纹历史,跨重启保留。即便用户没用过
  // SSH 也创建实例(空 history),让 IPC handler 行为一致 — 反正不写盘就不
  // 产生文件,nil cost。
  const knownHostsStore = new JsonStore<KnownHostsHistoryFile>(
    join(dataDir, 'known-hosts-history.json'),
  );
  const templatesStore = new JsonStore<TemplatesFile>(join(dataDir, 'templates.json'));

  const settingsManager = new SettingsManager(settingsStore);
  const pathManager = new PathManager(bookmarksStore, recentStore);
  const sshProfileManager = new SshProfileManager(sshProfilesStore);
  const knownHostsManager = new KnownHostsManager(knownHostsStore);
  const templatesManager = new TemplatesManager(templatesStore);
  const sessionManager = new SessionManager(
    windowManager,
    pathManager,
    templatesManager,
    settingsManager,
    {
      // 透传到子 shell 的 TERM_PROGRAM_VERSION,模仿 iTerm2 / WezTerm。
      // 用户在 .bashrc / Profile.ps1 里可以拿这个版本号做条件判断。
      appVersion: app.getVersion(),
    },
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
          logger.warn('main', 'persist windowDefaults failed', err);
        }
      },
    };
  });

  // second-instance:
  //   - `--open-here <path>` → 走 openPathInTerminal,按 settings.systemIntegration.explorerOpenIn 路由
  //   - 否则:已有窗口时聚焦最近活动的;否则新开 (M1-K 行为)
  app.on('second-instance', (_event, argv, workingDirectory, additionalData) => {
    // TIT-2 诊断:把 second-instance 收到的全部信息落盘,定位 --open-here 丢失原因
    logger.info('main', 'second-instance event received', {
      argv,
      workingDirectory,
      additionalData,
    });
    try {
      const requested = parseOpenHere(argv);
      const simpleMode = parseSimpleMode(argv);
      logger.info('main', 'second-instance parseOpenHere result', {
        requested,
        simpleMode,
        idxOfFlag: argv.indexOf('--open-here'),
      });
      if (requested) {
        const path = sanitizeOpenHerePath(requested);
        const mode = settingsManager.get().systemIntegration.explorerOpenIn;
        void openPathInTerminal(
          { windowManager, sessionManager, templatesManager },
          path,
          mode,
          simpleMode,
        ).catch((err) => logger.error('main', 'openPathInTerminal failed', err));
        return;
      }
      const recent = windowManager.getMostRecentlyActive();
      if (recent) {
        if (recent.isMinimized()) recent.restore();
        recent.focus();
      } else {
        windowManager.createWindowFromFactory();
      }
    } catch (err) {
      logger.error('main', 'second-instance handler failed', err);
    }
  });

  app.on('window-all-closed', () => {
    // isQuitting=true 时 (主动 quit) 让默认行为执行,继续走 before-quit / will-quit
    if (isQuitting) return;
    // BETA-003b · ADR-013:Linux 上 lifecycleModel='no-persistence',关掉最后
    // 一个窗口 = 应用退出。alive session 的二次确认已在 windowManager 的
    // closeInterceptor 里处理过,走到这里说明 modal 用户已确认 / 本就无 alive session,
    // 安全 quit。
    // Windows ('tray-resident') / macOS ('dock-resident') 保持"app 不死于窗口"。
    if (process.platform === 'linux') {
      isQuitting = true;
      app.quit();
    }
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
      // 勘误第二轮:补 'clipboard-sanitized-write' / 'clipboard-write'。
      // 主路径已切到 preload 的 Electron clipboard 桥(window.api.clipboard),
      // 不再依赖 navigator.clipboard;但保留这两个白名单,以防三方库 / 未来
      // 代码用 navigator.clipboard 也能正常工作,而不是再次掉进"writeText
      // 静默 reject"的坑。
      const ALLOWED_PERMISSIONS = new Set<string>([
        FONT_PERMISSION,
        'clipboard-read',
        'clipboard-write',
        'clipboard-sanitized-write',
      ]);
      electronSession.defaultSession.setPermissionRequestHandler(
        (_webContents, permission, callback) => {
          callback(ALLOWED_PERMISSIONS.has(permission as string));
        },
      );
      electronSession.defaultSession.setPermissionCheckHandler((_wc, permission) => {
        return ALLOWED_PERMISSIONS.has(permission as string);
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
      const { bookmarksSource } = await pathManager.initialize();
      logger.info('main', `bookmarks loaded from: ${bookmarksSource}`);
      const sshProfilesSrc = await sshProfileManager.initialize();
      logger.info('main', `ssh profiles loaded from: ${sshProfilesSrc}`);
      await knownHostsManager.initialize();
      const tmplSrc = await templatesManager.initialize();
      logger.info('main', `templates loaded from: ${tmplSrc}`);

      // BETA-031:AI 助手客户端,settings 读取走 SettingsManager.get() 闭包,
      // 用户改 key / provider 即刻生效;BETA-006 用同实例做状态复核。
      const aiClient = new AIClient(() => settingsManager.get());
      sessionManager.setAiClient(aiClient);

      installIpcLayer({
        windowManager,
        pathManager,
        settingsManager,
        sessionManager,
        sshProfileManager,
        knownHostsManager,
        templatesManager,
        aiClient,
      });

      // ── 设置副作用 wiring ─────────────────────────────
      // settings.behavior.autoStart 改变 → 触发 OS Run 表写入
      //
      // CP-4 勘误 #2:已经移除 "跟随系统主题" 功能 (nativeTheme 监听 +
      // followSystemTheme 字段)。原因:Windows 上 nativeTheme.shouldUseDarkColors
      // 在不少机器上不可靠 (尤其多用户 / 远程会话),自动切主题反而是 bug 来源;
      // 用户主动选 7 套主题已足够。
      //
      // BETA-003a:Linux 也走 getPlatformAdapter(),拿到 LinuxAdapter 实例;
      // macOS 仍占位,getPlatformAdapter 会 throw,保留 null 即可。
      const platformAdapter =
        process.platform === 'darwin' ? null : getPlatformAdapter();

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
        // Explorer 右键集成不再走 settings — 它的开关由
        // cmd:explorer-integration:set-{classic,modern} 直接调用 platformAdapter,
        // 系统状态 = HKCU key / MSIX 包是否存在(现场查,不持久化在 settings.json)。
      });

      // 2026-05-16:干净安装时种入默认收藏(桌面 / 主目录),取代旧的"系统"
      // 独立分组。bookmarksSource==='default' 表示 bookmarks.json 不存在,
      // 是真正的首次启动 — addBookmark 内部会去重 + 持久化,后续启动直接读盘
      // 拿到这些条目,不会重复种入。
      if (bookmarksSource === 'default' && platformAdapter) {
        const seeds = platformAdapter.getDefaultBookmarkSeeds();
        for (const seed of seeds) {
          try {
            pathManager.addBookmark({ path: seed.path, displayName: seed.label });
          } catch (err) {
            logger.warn('main', `seed default bookmark failed: ${seed.path}`, err);
          }
        }
      }

      // BETA-043:启动期异步扫描所有 path,标记不可访问者。不做后台周期扫
      // (一次启动只扫一遍;运行时新建 session spawn 前的 statSync 仍有兜底)。
      scanInvalidPathsAsync(pathManager).catch((err) => {
        logger.warn('main', 'scanInvalidPathsAsync failed', err);
      });

      // v1.5 改名遗留清理:EasyTerm 时代写入的右键菜单 key 若残留,会与 Marina
      // 并排出现两条菜单项。启动期静默清一次。失败 (例如本来就没装过) 不阻塞。
      if (platformAdapter instanceof WindowsAdapter) {
        platformAdapter
          .cleanupLegacyExplorerIntegration()
          .catch((err) =>
            logger.warn('main', 'cleanupLegacyExplorerIntegration failed', err),
          );
      }

      // 启动期同步:如果 HKCU 经典菜单已存在但 exe 路径变了(用户卸载重装、
      // 或从 portable/dev 路径切到 installed 路径),刷新 command 字段。
      // 仅 installed 形态做此动作 —— dev/portable 不应在启动期写注册表。
      if (
        platformAdapter instanceof WindowsAdapter &&
        getBuildType() === 'installed'
      ) {
        platformAdapter
          .syncFileManagerIntegrationIfPresent(app.getPath('exe'))
          .catch((err) =>
            logger.warn('main', 'syncFileManagerIntegrationIfPresent failed', err),
          );
      }

      // BETA-003b · ADR-013:三平台共享 close 拦截 — 只对 lifecycleModel
      // === 'no-persistence'(Linux)的"最后窗口 + 仍有 alive session" 场景
      // preventDefault + 发 IPC 让 renderer 弹 LastSessionConfirm modal。
      // Windows ('tray-resident')/ macOS ('dock-resident') 走原有路径,本拦截器
      // 直接返回 false 放行。
      if (platformAdapter) {
        const adapter = platformAdapter;
        windowManager.setCloseInterceptor((win) => {
          if (isQuitting) return false; // 已经在退出流程,放行
          if (adapter.lifecycleModel !== 'no-persistence') return false;
          // 检查是否为最后一个窗口
          const others = windowManager
            .list()
            .filter((w) => w.electronWindowId !== win.webContents.id);
          if (others.length > 0) return false;
          // 检查 alive session 数
          const aliveCount = sessionManager
            .list()
            .filter((s) => s.state !== 'exited').length;
          if (aliveCount === 0) return false; // 全 exited,静默关
          // 拦截 + 通知 renderer 弹 modal
          win.webContents.send('evt:ui:show-last-session-confirm', {
            eventId: 'lsc-' + Date.now(),
            timestamp: Date.now(),
            payload: { sessionCount: aliveCount },
          });
          return true;
        });
      }

      // BETA-003a:Linux 不做托盘,跳过 trayManager.init()
      if (process.platform === 'win32') {
        trayManager.init();
      }

      // 交互级冒烟测试 harness。仅在 MARINA_SMOKE_INTERACTIVE=1 时装载。
      // 完整端到端验证:真实 BrowserWindow + preload bridge + IPC handler +
      // SessionManager + node-pty。详见 src/main/smoke-interactive.ts。
      const smokeInteractive = process.env['MARINA_SMOKE_INTERACTIVE'] === '1';
      if (smokeInteractive) {
        const { installSmokeInteractiveHarness, installSmokeGlobalTimeout } =
          await import('./smoke-interactive.js');
        installSmokeGlobalTimeout();
        installSmokeInteractiveHarness(() => {
          const list = windowManager.list();
          if (list.length === 0) return null;
          return windowManager.getById(list[0]!.id);
        });
      }

      // 启动行为:--open-here 优先级最高 (Explorer 右键触发的冷启动 — 用户意图明确)。
      // 其次看 settings.behavior.startupBehavior:tray-only 不开窗,其他开窗。
      let startupOpenHere = parseOpenHere(process.argv);
      const startupSimpleMode = parseSimpleMode(process.argv);

      // BETA-003c:Linux 上 Nautilus / Nemo / Caja 的 "在终端中打开" 是通过
      // gsettings org.gnome.desktop.default-applications.terminal exec 拉起
      // Marina,**不传 argv 参数**,而是 fork+chdir+exec ——子进程的 process.cwd()
      // 就是用户右键的那个目录。我们检测这个信号,当 cwd 不是 / 也不是 home 时
      // 自动把它作为 startupOpenHere。GUI 应用菜单启动时 cwd 通常是 / 或 home,
      // 走默认空窗逻辑。
      if (
        process.platform === 'linux' &&
        startupOpenHere === null &&
        !startupSimpleMode
      ) {
        try {
          const cwd = process.cwd();
          const home = app.getPath('home');
          if (cwd !== '/' && cwd !== home && existsSync(cwd)) {
            startupOpenHere = cwd;
            logger.info('main', `linux cold-start picked process.cwd: ${cwd}`);
          }
        } catch (err) {
          logger.warn('main', 'linux cwd detection failed', err);
        }
      }
      // TIT-2 诊断:与 second-instance 路径对比 — 冷启动 argv 形态是什么样
      logger.info('main', 'cold-start parseOpenHere result', {
        startupOpenHere,
        startupSimpleMode,
        argv: process.argv,
      });
      const wantWindow =
        startupOpenHere !== null ||
        settingsManager.get().behavior.startupBehavior !== 'tray-only' ||
        smokeInteractive;
      if (wantWindow) {
        const win = windowManager.createWindowFromFactory({
          simpleMode: startupSimpleMode,
        });
        if (startupOpenHere !== null) {
          // 冷启动:在刚创建的窗口里起 session(忽略 explorerOpenIn=recent-window-tab,
          // 此时没有"最近"可用)。等 did-finish-load 后再 createSession,
          // 保证 evt:session:created 不会落在 renderer 还没订阅的空档。
          const targetWindow = windowManager.getById(win.id);
          const path = sanitizeOpenHerePath(startupOpenHere);
          if (targetWindow) {
            targetWindow.webContents.once('did-finish-load', () => {
              if (targetWindow.isDestroyed()) return;
              void createSessionInWindow(
                { sessionManager, templatesManager },
                win.id,
                path,
              ).catch((err) =>
                logger.error('main', 'cold-start open-here createSession failed', err),
              );
            });
          }
        }
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
        sshProfileManager.flush(),
        knownHostsManager.flush(),
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

/**
 * 把 Explorer 传来的路径做基础清理:trim、剥末尾反斜杠(除根盘符外)、
 * 校验路径存在且是目录;不存在/不是目录 → 退回到用户家目录 + warn 日志。
 * 调用方可以放心拿返回值喂给 sessionManager。
 */
function sanitizeOpenHerePath(raw: string): string {
  let p = raw.trim();
  // Explorer 偶尔在末尾留反斜杠("C:\\Users\\me\\"),除盘符根本身外都剥掉
  if (p.length > 3 && (p.endsWith('\\') || p.endsWith('/'))) {
    p = p.slice(0, -1);
  }
  try {
    if (!existsSync(p) || !statSync(p).isDirectory()) {
      logger.warn(
        'main',
        `open-here path "${p}" 不存在或不是目录,退回 home`,
      );
      return app.getPath('home');
    }
  } catch (err) {
    logger.warn('main', `open-here path stat 失败,退回 home: ${p}`, err);
    return app.getPath('home');
  }
  return p;
}

interface OpenPathDeps {
  windowManager: WindowManager;
  sessionManager: SessionManager;
  templatesManager: TemplatesManager;
}

/**
 * Explorer 右键 → "在 Marina 终端中打开" 已运行时的 dispatcher。
 *
 * - mode='new-window': 始终新开一个窗口,等 did-finish-load 后再 createSession
 *   (复用 tray.ts focusSession 已验证过的模式)
 * - mode='recent-window-tab': 复用最近活动窗口直接 createSession;若无最近 → 降级 new-window
 *
 * 冷启动场景不走这里(无 most-recently-active,直接走 whenReady 末尾的分支)。
 */
async function openPathInTerminal(
  deps: OpenPathDeps,
  pathArg: string,
  mode: 'new-window' | 'recent-window-tab',
  /**
   * BETA-027:Explorer 简易模式入口。simple 时强制走 new-window 分支并注入
   * ?mode=simple query;复用 recent-window-tab 的"已开普通窗口"无意义。
   */
  simpleMode = false,
): Promise<void> {
  const { windowManager, sessionManager, templatesManager } = deps;

  if (mode === 'recent-window-tab' && !simpleMode) {
    const recent = windowManager.getMostRecentlyActive();
    if (recent) {
      if (recent.isMinimized()) recent.restore();
      recent.focus();
      const windowId = windowManager
        .list()
        .find((w) => w.electronWindowId === recent.webContents.id)?.id;
      if (windowId) {
        await createSessionInWindow(
          { sessionManager, templatesManager },
          windowId,
          pathArg,
        );
        return;
      }
    }
    // 无最近活动窗口 → 降级新开
  }

  // mode='new-window' / recent 降级 / 简易模式:新开窗口,等 did-finish-load 再
  // createSession,这样 evt:session:created 不会落在 renderer 还没订阅的空档。
  const info = windowManager.createWindowFromFactory({ simpleMode });
  const target = windowManager.getById(info.id);
  if (!target) return;
  target.webContents.once('did-finish-load', () => {
    if (target.isDestroyed()) return;
    void createSessionInWindow(
      { sessionManager, templatesManager },
      info.id,
      pathArg,
    ).catch((err) =>
      logger.error('main', 'openPathInTerminal createSession failed', err),
    );
  });
}

/**
 * 在指定窗口里 创建一个 session,用全局默认模板。复用 SessionManager.createSession
 * 完整流程;path tree 通过 attachSession 自动维护。renderer 端收到 evt:session:created
 * 后自动选中(store.tsx case 'sessions/created' 逻辑)。
 */
async function createSessionInWindow(
  deps: Pick<OpenPathDeps, 'sessionManager' | 'templatesManager'>,
  ownerWindowId: string,
  pathArg: string,
): Promise<void> {
  const { sessionManager, templatesManager } = deps;
  // 80x24 是终端事实标准 fallback;renderer 在 TerminalView mount 之后会通过
  // cmd:session:resize 把 PTY 重新尺寸调到 xterm fit() 的实际值。
  await sessionManager.createSession({
    pathId: pathArg,
    templateId: templatesManager.getDefaultTemplateId(),
    ownerWindowId,
    cols: 80,
    rows: 24,
  });
}

bootstrap();
