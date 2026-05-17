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
import { useEffect, useState } from 'react';
import { PROTOCOL_VERSION } from '@shared/protocol';
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

type HandshakeState =
  | { status: 'pending' }
  | { status: 'ok'; buildVersion: string; buildType: 'dev' | 'portable' | 'installed' }
  | { status: 'mismatch'; mainVersion: number; rendererVersion: number }
  | { status: 'error'; message: string };

export function App(): JSX.Element {
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
        setHandshake({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      });
  }, []);

  if (handshake.status === 'pending') {
    return <FullPagePlaceholder title="Marina" subtitle="正在握手…" />;
  }

  if (handshake.status === 'mismatch') {
    return (
      <FullPagePlaceholder
        title="Marina"
        subtitle="协议版本不匹配"
        body={`主进程协议版本 ${handshake.mainVersion},渲染端 ${handshake.rendererVersion}。请重启应用或重装。`}
        variant="error"
      />
    );
  }

  if (handshake.status === 'error') {
    return (
      <FullPagePlaceholder
        title="Marina"
        subtitle="启动失败"
        body={handshake.message}
        variant="error"
      />
    );
  }

  // handshake OK
  return (
    <AppStateProvider
      myWindowId={window.api.windowId}
      myWindowNumber={window.api.windowNumber}
    >
      <ConnectedShell
        buildVersion={handshake.buildVersion}
        buildType={handshake.buildType}
      />
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

  // 右键 Tab → "在新窗口中打开":?selectSessionId=X。等 snapshot 加载完(此时
  // sessions 已包含新 owner 信息)再 dispatch 选中,避免选到不存在的 session。
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!sync.ready) return;
    const params = new URLSearchParams(window.location.search);
    const initialSessionId = params.get('selectSessionId');
    if (!initialSessionId) return;
    dispatch({
      type: 'view/focus-requested',
      selectSessionId: initialSessionId,
    });
    // 一次性,清掉 query 防止刷新 / DevTools 重载时重新触发
    const url = new URL(window.location.href);
    url.searchParams.delete('selectSessionId');
    window.history.replaceState({}, '', url.toString());
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

  if (sync.error) {
    return (
      <FullPagePlaceholder
        title="Marina"
        subtitle="加载 snapshot 失败"
        body={sync.error}
        variant="error"
      />
    );
  }

  if (!sync.ready) {
    return <FullPagePlaceholder title="Marina" subtitle="加载状态…" />;
  }

  return (
    <LanguageProvider>
    <ToastProvider>
      <ModalProvider>
        <LastSessionConfirmBridge />
        <ContextMenuProvider>
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
            {state.inSettingsView ? (
              <SettingsView />
            ) : state.simpleMode ? (
              // BETA-027:简易页面 — 隐藏 Sidebar / Tab bar,只保留 WindowChrome
              // + 终端区。退出简易模式的入口现在嵌在 terminal-statusbar 里(pid 之后)。
              <div className="app-body simple-mode">
                <MainPane />
              </div>
            ) : (
              <div className="app-body">
                <Sidebar />
                <MainPane />
              </div>
            )}
          </div>
        </ContextMenuProvider>
      </ModalProvider>
    </ToastProvider>
    </LanguageProvider>
  );
}

function FullPagePlaceholder({
  title,
  subtitle,
  body,
  variant,
}: {
  title: string;
  subtitle: string;
  body?: string;
  variant?: 'error';
}): JSX.Element {
  return (
    <div className="app-root">
      <div className={`bootstrap-placeholder${variant === 'error' ? ' error' : ''}`}>
        <h1>{title}</h1>
        <p className="subtitle">{subtitle}</p>
        {body && <pre className="error-pre">{body}</pre>}
      </div>
    </div>
  );
}
