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
import { AppStateProvider, useAppState, useIpcSync } from './store';
import { Sidebar } from './components/Sidebar';
import { MainPane } from './components/MainPane';
import { SettingsView } from './components/SettingsView';
import { WindowChrome } from './components/WindowChrome';
import { ContextMenuProvider } from './components/ContextMenu';
import { ToastProvider } from './components/Toast';

type HandshakeState =
  | { status: 'pending' }
  | { status: 'ok'; buildVersion: string }
  | { status: 'mismatch'; mainVersion: number; rendererVersion: number }
  | { status: 'error'; message: string };

export function App(): JSX.Element {
  const [handshake, setHandshake] = useState<HandshakeState>({ status: 'pending' });

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
      .then(({ protocolVersion, buildVersion }) => {
        if (protocolVersion !== PROTOCOL_VERSION) {
          setHandshake({
            status: 'mismatch',
            mainVersion: protocolVersion,
            rendererVersion: PROTOCOL_VERSION,
          });
          return;
        }
        setHandshake({ status: 'ok', buildVersion });
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
      <ConnectedShell buildVersion={handshake.buildVersion} />
    </AppStateProvider>
  );
}

function ConnectedShell({ buildVersion }: { buildVersion: string }): JSX.Element {
  const sync = useIpcSync();
  const state = useAppState();

  const currentTheme = state.settings.appearance?.theme ?? 'rose-pine';
  const windowStyle = state.settings.appearance?.windowStyle ?? 'windows';
  const uiZoom = state.settings.appearance?.uiZoom ?? 1;

  // 即时同步 uiZoom 到 webFrame.setZoomFactor (preload 桥)。
  // 必须在 early return 之前 — React Hooks 规则:每次渲染调用顺序须一致。
  useEffect(() => {
    if (typeof window !== 'undefined' && window.api?.setUiZoom) {
      window.api.setUiZoom(uiZoom);
    }
  }, [uiZoom]);

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
    <ToastProvider>
      <ContextMenuProvider>
        <div
          className="app-root with-shell"
          data-theme={currentTheme}
          data-window-style={windowStyle}
        >
          <WindowChrome windowStyle={windowStyle} buildVersion={buildVersion} />
          {state.inSettingsView ? (
            <SettingsView />
          ) : (
            <div className="app-body">
              <Sidebar />
              <MainPane />
            </div>
          )}
        </div>
      </ContextMenuProvider>
    </ToastProvider>
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
