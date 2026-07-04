/**
 * @file src/renderer/components/file-panel/FilePanel.tsx
 * @purpose 终端右侧的"已打开文件"面板。绑定单个 session(由 MainPane 传
 *   sessionId),切终端时 MainPane 用新 sessionId 重挂,内容自动跟着切。
 *
 * @结构:
 * - 顶部 header:标题"已打开文件" + 折叠按钮
 * - tabs 行:每个已打开文件一个 tab(点击=show 切 active,×=close)
 * - body:active 文件的 FileViewer(text/markdown/image)
 * - 左边缘 resize handle:拖动改宽(镜像 .sidebar-resize-handle)
 *
 * @状态来源:filePanels Map 来自 store(main 推 evt:file-panel:updated)。
 *   mount / sessionId 变化时主动拉一次 get-open-files(处理 claim 接管已有
 *   文件 / 窗口刚聚焦等"事件可能已错过"的场景)。
 *
 * @UI 操作(show/close)走 IPC → main 改状态 → 事件回推。乐观更新交给 store
 *   事件循环本身(事件来得快,肉眼无延迟),不本地预判,避免和 main 真值漂移。
 */
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { COMMAND_CHANNELS, type FilePanelSnapshot } from '@shared/protocol';
import type { OpenedFile } from '@shared/types';
import { useAppDispatch, useAppState } from '../../store';
import { useTranslation } from '../LanguageProvider';
import { FileViewer } from './FileViewer';

interface FilePanelProps {
  /** 绑定的终端 session id;切终端时父级换值 → 本组件重挂/重取 */
  sessionId: string;
}

const MIN_WIDTH = 280;
const MAX_WIDTH = 900;
const DEFAULT_WIDTH = 440;

export function FilePanel({ sessionId }: FilePanelProps): JSX.Element | null {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const { tx } = useTranslation();

  const snapshot: FilePanelSnapshot = state.filePanels.get(sessionId) ?? {
    files: [],
    activePath: null,
  };
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [collapsed, setCollapsed] = useState(false);

  // mount / sessionId 变化 → 拉一次当前列表(接管时事件可能已错过)
  useEffect(() => {
    let cancelled = false;
    window.api
      .invoke<unknown, FilePanelSnapshot>(COMMAND_CHANNELS.FILE_PANEL_GET_OPEN_FILES, {
        sessionId,
      })
      .then((snap) => {
        if (cancelled) return;
        dispatch({
          type: 'file-panel/updated',
          sessionId,
          files: snap.files,
          activePath: snap.activePath,
        });
      })
      .catch((err: unknown) => console.warn('[FilePanel] get-open-files failed', err));
    return () => {
      cancelled = true;
    };
  }, [sessionId, dispatch]);

  // 拖拽 resize:window 监听挂在 startResize 里;组件卸载时若还在拖(files 中途被
  // 另一来源清空 → return null),必须摘掉监听,否则命中已死的 setWidth + 泄漏。
  const dragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanupRef.current?.(), []);

  const activeFile: OpenedFile | null =
    snapshot.files.find((f) => f.path === snapshot.activePath) ?? null;

  // 无文件时整个面板不渲染 —— 避免空面板常驻右侧挤占终端空间。
  // 注意:此 return 必须在所有 hooks(useState/useEffect)之后,否则违反
  // React hooks 规则(条件性 hook 调用)。get-open-files 拉回文件后自然会显示。
  if (snapshot.files.length === 0) return null;

  const handleShow = (path: string): void => {
    window.api
      .invoke(COMMAND_CHANNELS.FILE_PANEL_SHOW, { sessionId, path })
      .catch((err: unknown) => console.warn('[FilePanel] show failed', err));
  };
  const handleClose = (path: string): void => {
    window.api
      .invoke(COMMAND_CHANNELS.FILE_PANEL_CLOSE, { sessionId, path })
      .catch((err: unknown) => console.warn('[FilePanel] close failed', err));
  };

  // 拖左边缘改宽:鼠标左移 delta → 面板变宽(面板贴右侧,向左扩张)
  const startResize = (e: MouseEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: globalThis.MouseEvent): void => {
      const delta = startX - ev.clientX;
      setWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startW + delta)));
    };
    const stop = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', stop);
      dragCleanupRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', stop);
    dragCleanupRef.current = stop;
  };

  // 折叠态:只剩一个竖条 + 展开按钮,不占内容空间
  if (collapsed) {
    return (
      <aside className="file-panel file-panel-collapsed">
        <div className="file-panel-resize-handle" />
        <button
          type="button"
          className="file-panel-expand-btn"
          onClick={() => setCollapsed(false)}
          title={tx('展开文件面板', 'Expand file panel')}
          aria-label={tx('展开文件面板', 'Expand file panel')}
        >
          ‹
        </button>
      </aside>
    );
  }

  return (
    <aside className="file-panel" style={{ width }}>
      <div
        className="file-panel-resize-handle"
        onMouseDown={startResize}
        role="separator"
        aria-orientation="vertical"
      />
      <header className="file-panel-header">
        <span className="file-panel-title">{tx('已打开文件', 'Opened Files')}</span>
        <button
          type="button"
          className="file-panel-collapse-btn"
          onClick={() => setCollapsed(true)}
          title={tx('折叠', 'Collapse')}
          aria-label={tx('折叠', 'Collapse')}
        >
          ›
        </button>
      </header>
      <div className="file-panel-tabs">
        {snapshot.files.length === 0 ? (
          <span className="file-panel-empty-hint">
            {tx('暂无已打开文件(终端内程序可调 MARINA_SERVICE 打开)', 'No opened files')}
          </span>
        ) : (
          snapshot.files.map((f) => {
            const isActive = f.path === snapshot.activePath;
            return (
              <div key={f.path} className={`file-tab${isActive ? ' active' : ''}`} title={f.path}>
                <button type="button" className="file-tab-name" onClick={() => handleShow(f.path)}>
                  {f.name}
                </button>
                <span
                  className="file-tab-close"
                  role="button"
                  tabIndex={0}
                  onClick={() => handleClose(f.path)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') handleClose(f.path);
                  }}
                  title={tx('关闭', 'Close')}
                >
                  ×
                </span>
              </div>
            );
          })
        )}
      </div>
      <div className="file-panel-body">
        {activeFile ? (
          <FileViewer sessionId={sessionId} file={activeFile} />
        ) : (
          <div className="file-panel-placeholder">
            {tx('选择上方文件查看内容', 'Select a file above to view')}
          </div>
        )}
      </div>
    </aside>
  );
}
