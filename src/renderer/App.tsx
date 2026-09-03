/**
 * @file src/renderer/App.tsx
 * @purpose 应用根组件:handshake 协议 → AppStateProvider → useIpcSync 拉
 *   snapshot + 订阅事件 → 渲染主布局。
 *
 *   CP-4 起 inSettingsView=true 时,整个 body 被 SettingsView 替换 (用户
 *   决策对齐:"替换整个 body" 而非 modal 或仅替换 main pane)。
 *
 * @对应文档章节: 软件定义书.md 6.1 (整体布局)、6.6 (设置页面);
 *   ipc-protocol.md 第 4 章 handshake
 */
import { useEffect, useState, type ReactNode } from 'react';
import {
  EVENT_CHANNELS,
  PROTOCOL_VERSION,
  type GitStatusUpdatedPayload,
  type SessionDestroyedPayload,
} from '@shared/protocol';
import { LocalAppearanceProvider, useLocalAppearance } from './components/LocalAppearanceProvider';
import { clearCachedStatus, setCachedStatus } from '@shared/git-status-cache';
import { clearPanelUiState } from '@shared/panel-ui-cache';
import { claimSession } from './hooks/claim-gate';
import { AppStateProvider, useAppDispatch, useAppState, useIpcSync } from './store';
import { Sidebar } from './components/Sidebar';
import { MainPane } from './components/MainPane';
import { SettingsView } from './components/SettingsView';
import { WindowChrome } from './components/WindowChrome';
import { ContextMenuProvider } from './components/ContextMenu';
import { ToastProvider } from './components/Toast';
import { ModalProvider } from './components/Modal';
import { LanguageProvider } from './components/LanguageProvider';
import { LastSessionConfirmBridge } from './components/LastSessionConfirmBridge';
import { WebDownloadBridge } from './components/WebDownloadBridge';
import { MdThemeInjector } from './components/file-panel/MdThemeInjector';

type HandshakeState =
  | { status: 'pending' }
  | { status: 'ok'; buildVersion: string; buildType: 'dev' | 'portable' | 'installed' }
  | { status: 'mismatch'; mainVersion: number; rendererVersion: number }
  | { status: 'error'; message: string; errorCode: string | null };

export function App(): JSX.Element {
  // LocalAppearanceProvider 必须在最顶层(早于 handshake):错误/握手态也需要本机主题,
  // 而那些状态不走 useIpcSync(本机外观原本只在连接成功路径拉取)。详见
  // src/renderer/components/LocalAppearanceProvider.tsx 与
  // docs/plans/远程窗口错误态架构修复.md。
  return (
    <LocalAppearanceProvider>
      <AppBody />
    </LocalAppearanceProvider>
  );
}

function AppBody(): JSX.Element {
  const [handshake, setHandshake] = useState<HandshakeState>({ status: 'pending' });

  // F12(DROP-1 重构):window 层成为拖拽决策的"唯一权威"。
  //
  // 历史:F9-F11 让 Sidebar 自己 preventDefault + 设 dropEffect='copy',
  // 然后 window 兜底靠 e.defaultPrevented 判断是否被消费 — 两个 handler
  // 独立判断"光标在不在 sidebar 内",在 Chromium dragover 节流空帧 +
  // React 合成事件派发时序的双重干扰下,偶尔不同步,光标在 copy/⊘ 间闪。
  //
  // 现在:子组件不再碰 preventDefault / dropEffect。所有决策集中到这
  // 一个 native 监听器,通过 e.target.closest('[data-drop-zone]') 同步
  // 判断 — 一次事件,一个决策,不可能"两个 handler 抢答"。
  //
  // 关键:dragenter 和 dragover 都要 preventDefault!HTML5 DnD 规范明文
  // 规定 "both ... must be cancelled to allow dropping"。光标跨越子元
  // 素边界时,事件序列是 dragleave(旧)→ dragenter(新)→ dragover(新)。
  // 如果只挂 dragover,dragenter 期间新元素被 Chromium 默认判定为"非
  // drop target",光标会闪一帧 ⊘ 再被下一个 dragover 改回 copy —
  // F12.1 修复的就是这个症状。
  //
  // 子组件只剩两件事:
  //   (1) 在自己的根 element 加 data-drop-zone="..."(声明"我接受")
  //   (2) onDrop 处理消费逻辑(读 files、IPC 等);可选 onDragOver
  //       仅维护视觉态(高亮/浮卡),与决策完全解耦。
  //
  // 浏览器默认行为(必须吃掉):
  //   (a) Chromium 把窗口导航到 file:///... ;
  //   (b) Win11 屏幕顶端弹"拖放到此处以共享"系统浮层。
  useEffect(() => {
    const handleDragEnterOver = (e: globalThis.DragEvent): void => {
      e.preventDefault();
      const target = e.target instanceof Element ? e.target : null;
      const inDropZone = target?.closest('[data-drop-zone]') ?? null;
      if (e.dataTransfer) e.dataTransfer.dropEffect = inDropZone ? 'copy' : 'none';
    };
    const handleDrop = (e: globalThis.DragEvent): void => {
      // drop zone 自己的 React onDrop 在 bubble 阶段先跑过(读完 files、
      // preventDefault);此处兜底吃掉所有"未消费"drop,防止 Chromium
      // navigate 到 file://。preventDefault 幂等,无条件调用即可。
      e.preventDefault();
    };
    window.addEventListener('dragenter', handleDragEnterOver);
    window.addEventListener('dragover', handleDragEnterOver);
    window.addEventListener('drop', handleDrop);
    return () => {
      window.removeEventListener('dragenter', handleDragEnterOver);
      window.removeEventListener('dragover', handleDragEnterOver);
      window.removeEventListener('drop', handleDrop);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.api) {
      setHandshake({
        status: 'error',
        message: 'window.api 不存在 — preload 脚本未正确加载。',
        errorCode: null,
      });
      return;
    }
    window.api
      .getProtocolVersion()
      .then(({ protocolVersion, buildVersion, buildType }) => {
        if (protocolVersion !== PROTOCOL_VERSION) {
          setHandshake({
            status: 'mismatch',
            mainVersion: protocolVersion,
            rendererVersion: PROTOCOL_VERSION,
          });
          return;
        }
        setHandshake({ status: 'ok', buildVersion, buildType });
      })
      .catch((err: unknown) => {
        // 远程窗口连不上 daemon 时,getProtocolVersion()→invoke()→ensureTransport()
        // 会 throw ConnectError(带 code)。提取 code 供错误页给针对性诊断。
        const errorCode =
          err !== null &&
          typeof err === 'object' &&
          'code' in err &&
          typeof (err as { code?: unknown }).code === 'string'
            ? (err as { code: string }).code
            : null;
        setHandshake({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
          errorCode,
        });
      });
  }, []);

  // ?backend= 标识本窗口是否连远程 daemon(preload 从 URL query 解析,窗口创建时定死,
  // 见 window-manager.ts createWindow)。在 render 期间算一次,本函数所有错误分支共用,
  // 消除原先三处重复的 new URLSearchParams(...).get('backend') 判定。
  const isRemoteWindow = detectRemoteWindow();

  if (handshake.status === 'pending') {
    return (
      <FramelessShell>
        <PendingCard />
      </FramelessShell>
    );
  }

  if (handshake.status === 'mismatch') {
    // Bug 1 现场:原走 FullPagePlaceholder(无 WindowChrome)→ frame:false 窗口无标题栏。
    // 改走 FramelessShell,标题栏 + 本机主题由外壳保证,这里只给版本说明卡片。
    return (
      <FramelessShell>
        <ProtocolMismatchCard
          mainVersion={handshake.mainVersion}
          rendererVersion={handshake.rendererVersion}
          isRemoteWindow={isRemoteWindow}
        />
      </FramelessShell>
    );
  }

  if (handshake.status === 'error') {
    // 远程窗口连不上 daemon 时,getProtocolVersion 走 invoke→ensureTransport 会 throw,
    // 提前在这里失败(到不了 ConnectedShell 的 sync.error)。走 FramelessShell:
    // 标题栏 + 本机主题由外壳保证,不再每条分支自己挂 AppStateProvider / 查 ?backend=。
    if (isRemoteWindow) {
      return (
        <FramelessShell>
          <RemoteConnectionErrorScreen
            errorMessage={handshake.message}
            errorCode={handshake.errorCode}
          />
        </FramelessShell>
      );
    }
    // 本地窗口握手 error(window.api 不存在等,极罕见)。同样走 FramelessShell
    // 保证标题栏,内容是本地启动错误卡片。
    return (
      <FramelessShell>
        <LocalStartupErrorCard message={handshake.message} />
      </FramelessShell>
    );
  }

  // handshake OK
  return (
    <AppStateProvider myWindowId={window.api.windowId} myWindowNumber={window.api.windowNumber}>
      <ConnectedShell buildVersion={handshake.buildVersion} buildType={handshake.buildType} />
    </AppStateProvider>
  );
}

function ConnectedShell({
  buildVersion,
  buildType,
}: {
  buildVersion: string;
  buildType: 'dev' | 'portable' | 'installed';
}): JSX.Element {
  const sync = useIpcSync();
  const state = useAppState();
  const dispatch = useAppDispatch();

  // ADR-021:GitPanel 在 WARM（其他面板/折叠/失焦）时会卸载，但 60s 后台结果仍
  // 必须写组件外缓存。根层 bridge 常驻；GitPanel 自己的 listener 只负责 live state。
  useEffect(() => {
    const offStatus = window.api.on<GitStatusUpdatedPayload>(
      EVENT_CHANNELS.GIT_STATUS_UPDATED,
      (payload) => {
        if ('unavailable' in payload && payload.unavailable !== undefined) {
          setCachedStatus(payload.sessionId, { unavailable: payload.unavailable, at: Date.now() });
          return;
        }
        setCachedStatus(payload.sessionId, {
          groups: payload.groups ?? [],
          truncated: payload.truncated ?? false,
          at: Date.now(),
        });
      },
    );
    const offDestroyed = window.api.on<SessionDestroyedPayload>(
      EVENT_CHANNELS.SESSION_DESTROYED,
      ({ sessionId }) => {
        clearCachedStatus(sessionId);
        // L2:session 销毁时回收该 session 的 L1 UI 缓存(展开目录/选中态/滚动位置),
        // 与 git-status-cache 对称。panel-ui-cache.ts 的 clearPanelUiState 语义要求
        // 不传 panelId 即清该 session 全部面板,防陈旧 UI 态滞留内存。
        clearPanelUiState(sessionId);
      },
    );
    return () => {
      offStatus();
      offDestroyed();
    };
  }, []);

  const currentTheme = state.settings.appearance?.theme ?? 'rose-pine';
  const windowStyle = state.settings.appearance?.windowStyle ?? 'windows';
  const uiZoom = state.settings.appearance?.uiZoom ?? 1;
  const uiFontFamily = state.settings.appearance?.uiFontFamily ?? '';
  const terminalFontFamily = state.settings.appearance?.terminalFontFamily ?? '';

  // BETA-027:Explorer 简易模式入口走 query string ?mode=simple,渲染端在
  // startup 阶段把它转成 dispatch view/set-simple-mode。冷启动一次性,不监听变化。
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('mode') === 'simple') {
      dispatch({ type: 'view/set-simple-mode', value: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 右键 Tab → “在新窗口中打开”:?selectSessionId=X。等 snapshot 加载完再处理。
  // 本地 backend 的旧流程在创建窗口前已把 owner claim 给新 windowId,这里只选中。
  // 远程 backend 无法提前知道新 WS clientId,所以旧窗口先 release 成 orphan,
  // 新窗口在这里用自己的 daemon clientId claim,再挂载 TerminalView。
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!sync.ready) return;
    const params = new URLSearchParams(window.location.search);
    const initialSessionId = params.get('selectSessionId');
    if (!initialSessionId) return;

    // 一次性,先清 query,避免 React 重渲 / DevTools reload 重复 claim。
    const url = new URL(window.location.href);
    url.searchParams.delete('selectSessionId');
    window.history.replaceState({}, '', url.toString());

    const target = state.sessions.get(initialSessionId);
    if (!target) return;
    const selectTarget = (): void => {
      dispatch({ type: 'view/focus-requested', selectSessionId: initialSessionId });
    };

    if (target.ownerWindowId === null) {
      void claimSession(initialSessionId)
        .then(() => {
          // owner-changed 广播通常先到；本地补一次同值更新保证即使事件延迟,
          // getDisplayableSession 也能立即让 TerminalView 挂载。
          dispatch({
            type: 'sessions/owner-changed',
            sessionId: initialSessionId,
            ownerWindowId: state.myWindowId,
          });
          selectTarget();
        })
        .catch((err) => console.error('[App] claim moved remote session failed', err));
      return;
    }

    selectTarget();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync.ready]);

  // 即时同步 uiZoom 到 webFrame.setZoomFactor (preload 桥)。
  // 必须在 early return 之前 — React Hooks 规则:每次渲染调用顺序须一致。
  useEffect(() => {
    if (typeof window !== 'undefined' && window.api?.setUiZoom) {
      window.api.setUiZoom(uiZoom);
    }
  }, [uiZoom]);

  // settings.appearance.uiFontFamily / terminalFontFamily 写到 :root CSS 变量。
  // 用户报告"UI 字体没生效":历史 CSS 把这俩值硬编码在 :root,设置变更后
  // 没有任何代码把它写回 DOM。在这里 setProperty 即可。空字符串走 CSS 默认值。
  useEffect(() => {
    const root = document.documentElement;
    if (uiFontFamily.trim()) {
      root.style.setProperty('--ui-font-family', uiFontFamily);
    } else {
      root.style.removeProperty('--ui-font-family');
    }
    if (terminalFontFamily.trim()) {
      root.style.setProperty('--terminal-font-family', terminalFontFamily);
    } else {
      root.style.removeProperty('--terminal-font-family');
    }
  }, [uiFontFamily, terminalFontFamily]);

  // F3(beta 勘误2):把 data-theme 同时挂在 <html> 上 — 否则 ContextMenu /
  // Modal / Toast 这类 Provider 渲染的 DOM 节点在 .app-root 之外(它们包裹
  // .app-root 作为子节点,自己的 portal-like 节点是 .app-root 的兄弟),
  // 拿不到 data-theme 选择器定义的 CSS 变量,只能 fallback 到 :root 的
  // rose-pine 默认值。挂到 <html> 后所有 DOM 节点都在主题作用域内。
  // (旧版仍保留 .app-root 上的 data-theme,内部已大量按它写过 CSS 选择器,
  // 同时挂两处不冲突,新主题切换路径以 <html> 为准。)
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', currentTheme);
  }, [currentTheme]);

  // BETA-003c resize 修复:把平台标记挂到 <html data-platform>,CSS 据此
  // 排除 Linux 上的 .app-root border-radius — Linux 跑 transparent:false
  // (Wayland 透明窗口 resize bug),圆角内会露 #191724 实色边角,要把圆角
  // 关掉。Windows / macOS 仍走系统 frameless 圆角 + CSS 圆角双保险。
  useEffect(() => {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const isLinux = /linux/i.test(ua) && !/android/i.test(ua);
    const isMac = /mac/i.test(ua) && !isLinux;
    const platform = isLinux ? 'linux' : isMac ? 'darwin' : 'win32';
    document.documentElement.setAttribute('data-platform', platform);
  }, []);

  // ConnectedShell 已在 AppStateProvider 内(AppBody handshake OK 分支包的),
  // 所以这里的 FramelessShell 用 inheritAppState 复用外层 store,避免嵌套第二个空 store。
  const isRemoteWindow = detectRemoteWindow();

  if (sync.error) {
    // 远程窗口加载失败 = 远程连接失败(preload ensureTransport 抛 ConnectError)。
    // 绝不静默回退本地。走 FramelessShell:标题栏 + 本机主题 + 针对性诊断卡片。
    if (isRemoteWindow) {
      return (
        <FramelessShell inheritAppState buildVersion={buildVersion} buildType={buildType}>
          <RemoteConnectionErrorScreen errorMessage={sync.error} errorCode={sync.errorCode} />
        </FramelessShell>
      );
    }
    return (
      <FramelessShell inheritAppState buildVersion={buildVersion} buildType={buildType}>
        <LocalStartupErrorCard message={`加载 snapshot 失败:${sync.error}`} />
      </FramelessShell>
    );
  }

  if (!sync.ready) {
    return (
      <FramelessShell inheritAppState buildVersion={buildVersion} buildType={buildType}>
        <PendingCard label="加载状态…" />
      </FramelessShell>
    );
  }

  return (
    <LanguageProvider>
      <ToastProvider>
        <ModalProvider>
          <LastSessionConfirmBridge />
          <WebDownloadBridge />
          <ContextMenuProvider>
            <MdThemeInjector />
            <div
              className="app-root with-shell"
              data-theme={currentTheme}
              data-window-style={windowStyle}
              data-simple-mode={state.simpleMode ? 'true' : 'false'}
            >
              <WindowChrome
                windowStyle={windowStyle}
                buildVersion={buildVersion}
                buildType={buildType}
              />
              {/* MainPane/TerminalDeck 永久挂载。设置页只是 overlay；简易模式只
               * 增删 keyed Sidebar，不移动 MainPane，避免任何 UI 模式切换销毁 xterm。 */}
              <div className="app-content-shell">
                <div
                  className={`app-body${state.simpleMode ? ' simple-mode' : ''}${
                    state.inSettingsView ? ' workspace-hidden' : ''
                  }`}
                  inert={state.inSettingsView ? '' : undefined}
                  aria-hidden={state.inSettingsView ? true : undefined}
                >
                  {!state.simpleMode && <Sidebar key="sidebar" />}
                  <MainPane key="main-pane" />
                </div>
                {state.inSettingsView && (
                  <div className="settings-layer">
                    <SettingsView />
                  </div>
                )}
              </div>
            </div>
          </ContextMenuProvider>
        </ModalProvider>
      </ToastProvider>
    </LanguageProvider>
  );
}

/**
 * 远程连接错误码 → 针对性诊断(标题 + 排查清单)。preload ConnectError.code 驱动。
 * 避免用户面对笼统“连不上”,按失败阶段给具体原因和排查方向。
 */
function getRemoteErrorDiagnosis(errorCode: string | null): {
  title: string;
  checklist: string[];
} {
  switch (errorCode) {
    case 'AUTH_REJECTED':
      return {
        title: '连接密码错误',
        checklist: [
          '对方电脑的“连接密码”改过,或你填的是旧密码。',
          '去对方 Marina → 设置 → 远程 → 允许远程连接 → 复制最新的连接密码。',
          '回到这台电脑 → 设置 → 远程 → Marina 电脑 → 编辑该电脑,填入新密码。',
        ],
      };
    case 'TCP_UNREACHABLE':
      return {
        title: '无法连接到对方电脑',
        checklist: [
          '对方 Marina 是否已点“允许远程连接”→ 开启(状态应显示“运行中 · 端口 32780”)。',
          '对方防火墙是否放行 32780(三个 profile:域/专用/公用都要)。',
          '你填的 IP 是否正确,且能 ping 通(WireGuard/VPN 是否已连接)。',
          '对方 server 可能绑在了别的网卡 —— 检查对方是否有多个网络接口。',
        ],
      };
    case 'WS_HANDSHAKE':
      return {
        title: '目标端口不是 Marina',
        checklist: [
          '你连的 IP+端口上跑的是别的程序,不是 Marina daemon。',
          '确认对方 Marina 监听的端口(默认 32780),不要填到别的服务端口。',
        ],
      };
    case 'AUTH_TIMEOUT':
      return {
        title: '对方 daemon 没有响应',
        checklist: [
          'WS 连上了但对方没在超时内回认证确认。可能对方 daemon 卡住或异常,尝试在对方机器重启 Marina。',
          '两边 Marina 版本可能不兼容(本机版本与对方差异过大)。',
          '请对方查看日志:%APPDATA%\\Marina\\logs\\main.log,搜 “transport-ws”,看 client 连接和认证过程是否到达(若没有 connection 日志 = 连接没到对方;有 auth rejected = 密码不对)。',
        ],
      };
    case 'PROFILE_INCOMPLETE':
      return {
        title: '这台远程电脑配置不完整',
        checklist: ['去 设置 → 远程 → Marina 电脑,把 IP 和连接密码都填上。'],
      };
    default:
      return {
        title: '无法连接到远程电脑',
        checklist: [
          '确认对方 Marina 已开启“允许远程连接”。',
          '确认密码正确、IP 可达、防火墙放行 32780。',
          '看下方详细错误获取更多线索。',
        ],
      };
  }
}

/**
 * 远程连接失败的错误卡片(纯内容,不含标题栏/外壳)。
 *
 * 标题栏、data-theme、Provider 树由外层 <FramelessShell> 提供。本组件只负责:
 * - 按 error.code 给针对性诊断(标题 + 排查清单);
 * - 错误详情可选中 + 一键复制;
 * - 重试(reload 重新走 ensureTransport)/ 关窗 按钮。
 *
 * 必须在 FramelessShell 内使用(它的 WindowChrome 依赖 AppStateProvider)。
 */
function RemoteConnectionErrorScreen({
  errorMessage,
  errorCode,
}: {
  errorMessage: string;
  errorCode: string | null;
}): JSX.Element {
  const diagnosis = getRemoteErrorDiagnosis(errorCode);
  const handleRetry = (): void => {
    window.location.reload();
  };
  const handleClose = (): void => {
    window.close();
  };
  const handleCopy = async (): Promise<void> => {
    const detail = `[Marina 远程连接失败]\n错误码:${errorCode ?? 'unknown'}\n信息:${errorMessage}`;
    // 优先 navigator.clipboard(安全上下文);不可用时 fallback 到隐藏 textarea + execCommand。
    try {
      await navigator.clipboard.writeText(detail);
      return;
    } catch {
      /* 落到 fallback */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = detail;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch {
      /* 都不行就让用户手动选中下面的 pre */
    }
  };

  return (
    <div className="remote-error-screen">
      <div className="remote-error-card">
        <h1 className="remote-error-title">{diagnosis.title}</h1>
        <p className="remote-error-subtitle">
          这个窗口是远程窗口,但连不上对方电脑上的 Marina。
        </p>

        <ol className="remote-error-checklist">
          {diagnosis.checklist.map((item, i) => (
            <li key={i}>{item}</li>
              ))}
        </ol>

        {/* 详细错误默认展开(不用 details 折叠),确保始终可见 + 可选中复制 */}
        <div className="remote-error-detail">
          <div className="remote-error-detail-label">详细错误(可选中,或点按钮复制)</div>
          <pre
            className="remote-error-pre"
            ref={(el) => {
              /* 允许直接选中 */ void el;
            }}
          >
            {errorMessage}
          </pre>
          <button
            type="button"
            className="settings-button remote-error-copy"
            onClick={() => void handleCopy()}
          >
            复制错误信息
          </button>
        </div>

        <div className="remote-error-actions">
          <button type="button" className="settings-button" onClick={handleRetry}>
            重试连接
          </button>
          <button type="button" className="settings-button danger" onClick={handleClose}>
            关闭窗口
          </button>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// frame:false 窗口的基础外壳 + 错误/握手态卡片
//
// 这组组件是 Bug 1/Bug 2 的结构根治:见 docs/plans/远程窗口错误态架构修复.md。
// 设计原则——所有 frame:false 窗口的可见状态(含错误/握手态)都包在
// <FramelessShell> 里,标题栏 + 本机主题由外壳统一保证,不再靠每条分支自觉。
// ──────────────────────────────────────────────────────────────────

/**
 * 检测本窗口是否连了远程 daemon。
 *
 * 读 URL ?backend=(preload 从 query 解析,窗口创建时定死,见 window-manager.ts
 * createWindow 拼接 ?backend=<profileId>)。AppBody 和 ConnectedShell 各调一次
 * (不同函数作用域,无法共享局部 const),提成本工具函数消除重复。
 */
function detectRemoteWindow(): boolean {
  return typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('backend') !== null
    : false;
}

/**
 * frame:false 窗口的基础外壳(Bug 1 的结构根治)。
 *
 * 窗口在主进程是 frame:false(window-manager.ts createWindow),系统标题栏被整条
 * 拿掉,标题栏 100% 由 <WindowChrome> 自绘。所以任何“不渲染 WindowChrome 的
 * 可见状态”都会让用户看到一个没有最小化/最大化/关闭按钮的窗口(像卡死)。
 *
 * 历史上这个约束只靠每条错误分支自觉 —— mismatch 分支漏画过(Bug 1),且修了
 * 一条又复发另一条(见 git log b501a24/409e619/00fd171 同一天三次修同一 bug)。
 * 本外壳把“frame:false 窗口可见状态必有标题栏”从口头约定变成结构强制。
 *
 * 主题/windowStyle 来自 useLocalAppearance()(本机外观,与连接无关),fallback
 * 默认值 → Bug 2(错误态用默认主题)根治。
 *
 * @param inheritAppState 调用方已在 AppStateProvider 内时设 true,复用外层
 *   store(避免嵌套第二个空 store)。典型:ConnectedShell 内的 sync.error。
 *   App 顶层的 handshake 分支不传(默认 false),本外壳自己挂 AppStateProvider
 *   —— WindowChrome 内部调 useAppState(),无 Provider 会 throw 白屏。
 */
function FramelessShell({
  children,
  inheritAppState = false,
  buildVersion = 'unknown',
  buildType = 'portable',
}: {
  children: ReactNode;
  inheritAppState?: boolean;
  buildVersion?: string;
  buildType?: 'dev' | 'portable' | 'installed';
}): JSX.Element {
  const localAppearance = useLocalAppearance();
  // 本机外观未拉到时用默认值先渲染(与 settings-manager.ts DEFAULT_SETTINGS.appearance
  // 一致),拉到后自动切换。本地 IPC 通常 <50ms,用户几乎无感。
  const theme = localAppearance?.theme ?? 'rose-pine';
  const windowStyle = localAppearance?.windowStyle ?? 'windows';

  // window.api 不存在 = preload 完全没加载(致命错误,handshake error 的一个起因)。
  // 此时 WindowChrome 的按钮(调 window.api.invoke)无法工作,AppStateProvider 也
  // 拿不到 windowId。降级渲染纯静态卡片(与历史 FullPagePlaceholder 行为一致:
  // 无标题栏但显示错误),避免访问 window.api.windowId 导致白屏。
  // 说明:这个降级路径没有标题栏 —— 但 preload 没加载时连 IPC 都没有,标题栏按钮
  // 本来也不能用,降级是合理的(且这是极罕见的致命错误,不是常态)。
  if (typeof window === 'undefined' || !window.api) {
    return <div className="app-root" data-theme={theme}>{children}</div>;
  }

  const shell = (
    <LanguageProvider>
      <div className="app-root with-shell" data-theme={theme} data-window-style={windowStyle}>
        <WindowChrome windowStyle={windowStyle} buildVersion={buildVersion} buildType={buildType} />
        {children}
      </div>
    </LanguageProvider>
  );

  if (inheritAppState) {
    // 调用方(如 ConnectedShell)已在 AppStateProvider 内,直接复用。
    return shell;
  }
  // App 顶层的 handshake 分支:自己挂 AppStateProvider(WindowChrome 依赖它)。
  return (
    <AppStateProvider myWindowId={window.api.windowId} myWindowNumber={window.api.windowNumber}>
      {shell}
    </AppStateProvider>
  );
}

/** 握手中 / 状态加载中的极简卡片(标题栏由 FramelessShell 提供)。 */
function PendingCard({ label = '正在连接…' }: { label?: string }): JSX.Element {
  return (
    <div className="bootstrap-placeholder">
      <h1>Marina</h1>
      <p className="subtitle">{label}</p>
    </div>
  );
}

/**
 * 协议版本不匹配卡片(Bug 1 的内容侧)。标题栏由 FramelessShell 提供。
 * 远程场景:本机与对方 daemon 协议不一致;本地场景:主进程与渲染端不一致。
 */
function ProtocolMismatchCard({
  mainVersion,
  rendererVersion,
  isRemoteWindow,
}: {
  mainVersion: number;
  rendererVersion: number;
  isRemoteWindow: boolean;
}): JSX.Element {
  const handleClose = (): void => {
    window.close();
  };
  return (
    <div className="bootstrap-placeholder error">
      <h1>Marina</h1>
      <p className="subtitle">协议版本不匹配</p>
      <pre className="error-pre">
        {isRemoteWindow
          ? `本机与对方电脑的 Marina 协议版本不一致(本机 v${rendererVersion},对方 v${mainVersion})。\n请把两边升级到同一版本。`
          : `主进程协议版本 v${mainVersion},渲染端 v${rendererVersion}。\n请重启应用或重装。`}
      </pre>
      <div className="bootstrap-actions">
        <button type="button" className="settings-button" onClick={handleClose}>
          关闭窗口
        </button>
      </div>
    </div>
  );
}

/** 本地窗口启动失败卡片(window.api 不存在等极罕见情况)。 */
function LocalStartupErrorCard({ message }: { message: string }): JSX.Element {
  const handleClose = (): void => {
    window.close();
  };
  return (
    <div className="bootstrap-placeholder error">
      <h1>Marina</h1>
      <p className="subtitle">启动失败</p>
      <pre className="error-pre">{message}</pre>
      <div className="bootstrap-actions">
        <button type="button" className="settings-button" onClick={handleClose}>
          关闭窗口
        </button>
      </div>
    </div>
  );
}
