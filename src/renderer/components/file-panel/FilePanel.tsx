/**
 * @file src/renderer/components/file-panel/FilePanel.tsx
 * @purpose 终端程序经 MARINA_SERVICE 推送的“已打开文件”内容面板。
 *
 * @关键设计:
 * - 面板仍严格绑定单个 session；MainPane/PanelRegistry 用 sessionId 变化重挂，
 *   因而切终端、接管或切窗口时绝不混用其他 session 的打开文件状态。
 * - 文件开关/切换走 IPC → FilePanelService 真值 → evt:file-panel:updated 回推，
 *   不做乐观本地文件列表，避免 renderer 与 main 状态漂移。
 * - 尺寸、折叠和 dock chrome 已移交 LayoutHost。这里仅渲染内容，不决定自己
 *   在窗口中的位置；这是 ADR-016 Panel Registry 的边界。
 *
 * @对应文档章节:软件定义书.md §14.6、ADR-016；docs/ipc-protocol.md file-panel 域。
 *
 * @不要在这里做的事:
 * - 不浏览目录（FileTreePanel + FileTreeService 的职责）。
 * - 不直接读本地文件系统；所有内容读取经 main IPC。
 * - 不保存 width/collapsed 等布局状态。
 */
import { useEffect } from 'react';
import { COMMAND_CHANNELS, type FilePanelSnapshot } from '@shared/protocol';
import type { OpenedFile } from '@shared/types';
import { FileListRow } from '../common/FileListRow';
import { useAppDispatch, useAppState } from '../../store';
import { useTranslation } from '../LanguageProvider';
import { FileViewer } from './FileViewer';

interface FilePanelProps {
  /** 绑定的终端 session id；父级按 session 切换重新挂载。 */
  sessionId: string;
}

export function FilePanel({ sessionId }: FilePanelProps): JSX.Element {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const { tx } = useTranslation();
  const snapshot: FilePanelSnapshot = state.filePanels.get(sessionId) ?? {
    files: [],
    activePath: null,
  };

  // mount / sessionId 变化时拉一次真值：接管已有 session、窗口刚聚焦等场景可能
  // 在本组件订阅前已经收到事件。FilePanelService 是唯一状态源。
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
          // 初始化拉取/同步已有快照，不是 openFile，不请求激活面板。
          requestActivation: false,
        });
      })
      .catch((err: unknown) => console.warn('[FilePanel] get-open-files failed', err));
    return () => {
      cancelled = true;
    };
  }, [sessionId, dispatch]);

  const activeFile: OpenedFile | null =
    snapshot.files.find((file) => file.path === snapshot.activePath) ?? null;

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

  return (
    <div className="file-panel-content">
      <div className="file-panel-tabs">
        {snapshot.files.length === 0 ? (
          <span className="file-panel-empty-hint">
            {tx(
              '从“文件”面板选择文件，或让终端内程序调用 MARINA_SERVICE 打开文件。',
              'Select a file from Files, or let a terminal program open one through MARINA_SERVICE.',
            )}
          </span>
        ) : (
          snapshot.files.map((file) => {
            const isActive = file.path === snapshot.activePath;
            return (
              <FileListRow
                key={file.path}
                variant="tab"
                icon="file"
                label={file.name}
                title={file.path}
                selected={isActive}
                onClick={() => handleShow(file.path)}
                /* × 关闭按钮保留原视觉与交互:点击不触发 onClick(切 tab),
                   只调 close。trailing 槽挂在 row 容器上,与 button 分离。 */
                trailing={
                  <span
                    className="file-list-row-tab-close"
                    role="button"
                    tabIndex={0}
                    onClick={() => handleClose(file.path)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') handleClose(file.path);
                    }}
                    title={tx('关闭', 'Close')}
                  >
                    ×
                  </span>
                }
              />
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
    </div>
  );
}
