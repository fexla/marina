/**
 * @file src/renderer/components/file-tree/FileTreePanel.tsx
 * @purpose 当前 owner session 的双根只读文件导航面板。
 *
 * @关键设计:
 * - 只展示 FileTreeService 宣告的 `currentCwd` 与 `MARINA_WORKSPACE` 两个逻辑根；
 *   renderer 从不拼接/猜测绝对路径，也不提供地址栏。
 * - 目录按需展开，一次 IPC 只取直接子项，避免递归扫描 node_modules 等大目录。
 * - 点击文件走 cmd:file-tree:open-file；main 再次做 owner + realpath 根包含校验，
 *   成功后交给既有 FilePanelService，因此预览、大小限制和 fs.watch 逻辑不重复。
 *
 * @对应文档章节:软件定义书.md §14.6 受限文件导航例外、ADR-016。
 *
 * @不要在这里做的事:
 * - 不做文件编辑、创建、删除、重命名、上传或下载。
 * - 不显示任意目录、SSH/SFTP 远端目录或 Project/Workspace 容器。
 */
import { useCallback, useEffect, useState } from 'react';
import {
  COMMAND_CHANNELS,
  type FileTreeRootInfo,
  type GetFileTreeRootsResponse,
  type ListFileTreeDirectoryResponse,
} from '@shared/protocol';
import type { FileTreeEntry, FileTreeRootId } from '@shared/types';
import { dividerItem } from '../common/fileListRowContextMenu';
import { FileListRow } from '../common/FileListRow';
import { Icon } from '../icons';
import { useTranslation } from '../LanguageProvider';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { useToast } from '../Toast';
import type { ContextMenuItem } from '../ContextMenu';

interface FileTreePanelProps {
  /** 当前窗口实际持有的 session；main 会拒绝非 owner 的请求。 */
  sessionId: string;
}

interface DirectoryState {
  expanded: boolean;
  loading: boolean;
  snapshot?: ListFileTreeDirectoryResponse;
  error?: string;
}

type DirectoryStates = Record<string, DirectoryState | undefined>;

function directoryKey(rootId: FileTreeRootId, relativePath: string): string {
  return `${rootId}:${relativePath}`;
}

/**
 * FileTreePanel 只维护“哪些目录已展开/已请求”的纯 UI 临时态。
 * 文件系统真值与访问授权均在 FileTreeService，切 session 后本组件会被 LayoutHost
 * 按 sessionId 重挂，避免旧目录项闪到新终端。
 */
export function FileTreePanel({ sessionId }: FileTreePanelProps): JSX.Element {
  const { tx } = useTranslation();
  const [roots, setRoots] = useState<FileTreeRootInfo[] | null>(null);
  const [rootError, setRootError] = useState<string | null>(null);
  const [directories, setDirectories] = useState<DirectoryStates>({});

  const loadDirectory = useCallback(
    async (rootId: FileTreeRootId, relativePath: string): Promise<void> => {
      const key = directoryKey(rootId, relativePath);
      setDirectories((current) => {
        const previous = current[key];
        const next: DirectoryState = {
          expanded: true,
          loading: true,
          ...(previous?.snapshot ? { snapshot: previous.snapshot } : {}),
        };
        return { ...current, [key]: next };
      });
      try {
        const snapshot = await window.api.invoke<
          { sessionId: string; rootId: FileTreeRootId; relativePath: string },
          ListFileTreeDirectoryResponse
        >(COMMAND_CHANNELS.FILE_TREE_LIST_DIRECTORY, { sessionId, rootId, relativePath });
        setDirectories((current) => ({
          ...current,
          [key]: { expanded: true, loading: false, snapshot },
        }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn('[FileTreePanel] list directory failed', err);
        setDirectories((current) => ({
          ...current,
          [key]: { ...current[key], expanded: true, loading: false, error: message },
        }));
      }
    },
    [sessionId],
  );

  useEffect(() => {
    let cancelled = false;
    setRoots(null);
    setRootError(null);
    setDirectories({});
    window.api
      .invoke<{ sessionId: string }, GetFileTreeRootsResponse>(
        COMMAND_CHANNELS.FILE_TREE_GET_ROOTS,
        {
          sessionId,
        },
      )
      .then((response) => {
        if (cancelled) return;
        setRoots(response.roots);
        // 每个可用根各自懒加载第一级；不会递归，也不会因一个根不可用阻断另一个。
        response.roots
          .filter((root) => root.available)
          .forEach((root) => void loadDirectory(root.id, ''));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.warn('[FileTreePanel] get roots failed', err);
        setRootError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, loadDirectory]);

  const toggleDirectory = (rootId: FileTreeRootId, relativePath: string): void => {
    const key = directoryKey(rootId, relativePath);
    const state = directories[key];
    if (state?.snapshot && !state.loading) {
      setDirectories((current) => ({
        ...current,
        [key]: { ...state, expanded: !state.expanded },
      }));
      return;
    }
    void loadDirectory(rootId, relativePath);
  };

  const openFile = (rootId: FileTreeRootId, relativePath: string): void => {
    window.api
      .invoke(COMMAND_CHANNELS.FILE_TREE_OPEN_FILE, { sessionId, rootId, relativePath })
      // main 端 FileTreeService.openFile 成功后会进 FilePanelService.openFile，后者
      // 发出带 requestActivation=true 的 evt:file-panel:updated，LayoutHost 据此切到
      // 「已打开」面板。这里不再单独请求激活，避免两套激活机制(上一轮的错误补丁)。
      // reject 时保留现有警告且不切换。
      .catch((err: unknown) => console.warn('[FileTreePanel] open file failed', err));
  };

  if (rootError) {
    return (
      <div className="file-tree-error">
        {tx('文件导航不可用', 'File navigation unavailable')}: {rootError}
      </div>
    );
  }
  if (!roots) {
    return (
      <div className="file-tree-loading">{tx('正在读取文件根目录…', 'Loading file roots…')}</div>
    );
  }

  return (
    <div className="file-tree-panel" aria-label={tx('文件', 'Files')}>
      {roots.map((root) => {
        const state = directories[directoryKey(root.id, '')];
        return (
          <section key={root.id} className="file-tree-root">
            <button
              type="button"
              className="file-tree-root-button"
              disabled={!root.available}
              onClick={() => toggleDirectory(root.id, '')}
              aria-expanded={root.available ? !!state?.expanded : undefined}
              title={root.available ? root.label : root.reason}
            >
              <Icon name={state?.expanded ? 'chevronDown' : 'chevronRight'} size={12} />
              <Icon name="folder" size={14} />
              <span>{root.label}</span>
            </button>
            {!root.available ? (
              <p className="file-tree-unavailable">
                {root.reason ?? tx('目录不可用', 'Unavailable')}
              </p>
            ) : (
              <DirectoryChildren
                sessionId={sessionId}
                rootId={root.id}
                state={state}
                directories={directories}
                onToggle={toggleDirectory}
                onOpen={openFile}
                tx={tx}
              />
            )}
          </section>
        );
      })}
    </div>
  );
}

function DirectoryChildren({
  sessionId,
  rootId,
  state,
  directories,
  onToggle,
  onOpen,
  tx,
}: {
  sessionId: string;
  rootId: FileTreeRootId;
  state: DirectoryState | undefined;
  directories: DirectoryStates;
  onToggle: (rootId: FileTreeRootId, relativePath: string) => void;
  onOpen: (rootId: FileTreeRootId, relativePath: string) => void;
  tx: (zh: string, en: string) => string;
}): JSX.Element | null {
  if (!state?.expanded) return null;
  if (state.loading)
    return <div className="file-tree-loading file-tree-indent">{tx('读取中…', 'Loading…')}</div>;
  if (state.error) return <div className="file-tree-error file-tree-indent">{state.error}</div>;
  if (!state.snapshot) return null;

  return (
    <div className="file-tree-children">
      {state.snapshot.entries.map((entry) => (
        <FileTreeEntryRow
          key={entry.relativePath}
          sessionId={sessionId}
          rootId={rootId}
          entry={entry}
          state={directories[directoryKey(rootId, entry.relativePath)]}
          directories={directories}
          onToggle={onToggle}
          onOpen={onOpen}
          tx={tx}
        />
      ))}
      {state.snapshot.entries.length === 0 && (
        <div className="file-tree-empty file-tree-indent">{tx('空目录', 'Empty directory')}</div>
      )}
      {state.snapshot.truncated && (
        <div className="file-tree-truncated file-tree-indent">
          {tx('目录项过多，仅显示前 500 项。', 'Too many entries; showing the first 500.')}
        </div>
      )}
    </div>
  );
}

function FileTreeEntryRow({
  sessionId,
  rootId,
  entry,
  state,
  directories,
  onToggle,
  onOpen,
  tx,
}: {
  sessionId: string;
  rootId: FileTreeRootId;
  entry: FileTreeEntry;
  state: DirectoryState | undefined;
  directories: DirectoryStates;
  onToggle: (rootId: FileTreeRootId, relativePath: string) => void;
  onOpen: (rootId: FileTreeRootId, relativePath: string) => void;
  tx: (zh: string, en: string) => string;
}): JSX.Element {
  const isDirectory = entry.kind === 'directory';
  // 右键菜单依赖:每个 row 一个 hook 实例完全合法(React 按组件位置记忆)。
  // 条目数量不会很大,换来的内聚性比层层透传 props 更可读。
  const copyToClipboard = useCopyToClipboard();
  const toast = useToast();

  const buildContextMenu = (): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];
    // 主操作与左键一致:目录=展开/收起,文件=打开预览。
    items.push({
      label: isDirectory ? tx('展开/收起', 'Expand/Collapse') : tx('打开', 'Open'),
      onSelect: () =>
        isDirectory
          ? onToggle(rootId, entry.relativePath)
          : onOpen(rootId, entry.relativePath),
    });
    items.push(dividerItem());
    // 复制相对路径(file-tree 不持有绝对路径,见 fileListRowContextMenu.ts 头注)。
    // 对用户贴路径到 commit message / import / 文档里都很实用。
    items.push({
      label: tx('复制相对路径', 'Copy relative path'),
      onSelect: () => copyToClipboard(entry.relativePath || '.', '相对路径'),
    });
    // 在系统文件管理器定位:走专用 reveal-path IPC,main 端做根包含校验后
    // 调 shell.showItemInFolder。renderer 始终拿不到绝对路径。
    items.push({
      label: tx('在 Explorer 中显示', 'Reveal in Explorer'),
      onSelect: () => {
        window.api
          .invoke(COMMAND_CHANNELS.FILE_TREE_REVEAL_PATH, {
            sessionId,
            rootId,
            relativePath: entry.relativePath,
          })
          .catch((err: unknown) =>
            toast.push({
              kind: 'error',
              message: `定位失败:${err instanceof Error ? err.message : String(err)}`,
            }),
          );
      },
    });
    return items;
  };

  return (
    <div className="file-tree-entry">
      {/* 重构后:条目本体走统一的 FileListRow(variant=list),为后续右键菜单与
          git/file-panel 三面板一致化打基础。leading 槽放 chevron/filler 以保留
          原视觉对齐。目录展开的子树仍在本组件内递归渲染(不变)。 */}
      <FileListRow
        variant="list"
        icon={isDirectory ? 'folder' : 'file'}
        label={entry.name}
        title={entry.name}
        onClick={() =>
          isDirectory ? onToggle(rootId, entry.relativePath) : onOpen(rootId, entry.relativePath)
        }
        ariaExpanded={isDirectory ? !!state?.expanded : undefined}
        buildContextMenu={buildContextMenu}
        leading={
          isDirectory ? (
            <Icon name={state?.expanded ? 'chevronDown' : 'chevronRight'} size={12} />
          ) : (
            <span className="file-tree-leaf-spacer" />
          )
        }
      />
      {isDirectory && (
        <DirectoryChildren
          sessionId={sessionId}
          rootId={rootId}
          state={state}
          directories={directories}
          onToggle={onToggle}
          onOpen={onOpen}
          tx={tx}
        />
      )}
    </div>
  );
}
