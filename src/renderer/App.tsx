/**
 * @file src/renderer/App.tsx
 * @purpose 应用根组件。CP-1 阶段做 handshake (协议版本校验) + 渲染
 *   单一 TerminalView。CP-2 起接入路由切换 MainView (侧栏 + tabs) /
 *   SettingsView。
 *
 * @关键设计 (CP-1):
 * - handshake: 启动后立即调 cmd:app:get-protocol-version,版本不匹配
 *   显示明显错误页 (ipc-protocol.md 4.3、10.3)
 * - 通过 window.api 提供的 windowNumber 显示在标题区,验证 windowId
 *   的 query string 传递链路
 *
 * @对应文档章节: 软件定义书.md 6.1 (整体布局);ipc-protocol.md 第 4 章
 */
import { useEffect, useState } from 'react';
import { PROTOCOL_VERSION } from '@shared/protocol';
import { TerminalView } from './components/TerminalView';

type HandshakeState =
  | { status: 'pending' }
  | { status: 'ok'; buildVersion: string; protocolVersion: number }
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
        setHandshake({ status: 'ok', buildVersion, protocolVersion });
      })
      .catch((err: unknown) => {
        setHandshake({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      });
  }, []);

  if (handshake.status === 'pending') {
    return (
      <div className="app-root">
        <div className="bootstrap-placeholder">
          <h1>EasyTerm</h1>
          <p className="subtitle">正在握手…</p>
        </div>
      </div>
    );
  }

  if (handshake.status === 'mismatch') {
    return (
      <div className="app-root">
        <div className="bootstrap-placeholder error">
          <h1>EasyTerm</h1>
          <p className="subtitle">协议版本不匹配</p>
          <p className="hint">
            主进程协议版本 {handshake.mainVersion},渲染端 {handshake.rendererVersion}。
            这通常意味着应用文件被部分替换。请重启 EasyTerm 或重装。
          </p>
        </div>
      </div>
    );
  }

  if (handshake.status === 'error') {
    return (
      <div className="app-root">
        <div className="bootstrap-placeholder error">
          <h1>EasyTerm</h1>
          <p className="subtitle">启动失败</p>
          <pre className="error-pre">{handshake.message}</pre>
        </div>
      </div>
    );
  }

  // handshake OK — 渲染主视图
  return (
    <div className="app-root with-terminal">
      <header className="app-header">
        <span className="app-title">EasyTerm</span>
        <span className="app-window-badge">
          Window {window.api.windowNumber || '?'}
        </span>
        <span className="app-version">v{handshake.buildVersion}</span>
      </header>
      <main className="app-main">
        <TerminalView windowId={window.api.windowId} />
      </main>
    </div>
  );
}
