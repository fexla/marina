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
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  COMMAND_CHANNELS,
  type FileTreeRootInfo,
  type GetFileTreeRootsResponse,
  type ListFileTreeDirectoryResponse,
  type ListFileTreeRecursiveResponse,
} from '@shared/protocol';
import type { FileTreeEntry, FileTreeRootId } from '@shared/types';
import { fileIconFor } from '@shared/file-icon';
import { matchText } from '@shared/text-search';
import type { PanelSearchProps } from '../layout/panel-registry';
import { usePanelPreference } from '../../hooks/usePanelPreference';
import { usePanelUiState } from '../../hooks/usePanelUiState';
import { buildFileEntryMenu } from '../common/fileListRowContextMenu';
import { FileListRow } from '../common/FileListRow';
import { HighlightedText } from '../common/HighlightedText';
import { Icon } from '../icons';
import { useTranslation } from '../LanguageProvider';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { useToast } from '../Toast';
import type { ContextMenuItem } from '../ContextMenu';

interface FileTreePanelProps {
  /** 当前窗口实际持有的 session；main 会拒绝非 owner 的请求。 */
  sessionId: string;
  /** v0.3.1:dock 级搜索状态(C2 接入过滤)。 */
  search: PanelSearchProps;
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
 * v0.3.1:递归判断 entry 是否匹配搜索(或含匹配后代,仅限已加载子树)。
 *
 * - 叶子文件:name / relativePath 包含 query → 匹配
 * - 目录:自身名匹配 → 匹配(整目录可见);否则递归已加载子 entries,
 *   任一后代匹配 → 保留(让用户看到匹配的上下文路径)
 *
 * 懒加载限制:未展开(未加载 snapshot)的子目录无法递归,只看目录名是否匹配。
 * 搜索模式下 DirectoryChildren 会强制展开已加载目录,匹配后代会浮现。
 */
function entryMatches(
  entry: FileTreeEntry,
  rootId: FileTreeRootId,
  directories: DirectoryStates,
  query: string,
  caseSensitive: boolean,
): boolean {
  // 自身名匹配 → 保留(文件/目录都算)
  if (matchText(entry.name, query, caseSensitive)) return true;
  if (matchText(entry.relativePath, query, caseSensitive)) return true;
  // 目录:递归已加载子树
  if (entry.kind === 'directory') {
    const childState = directories[directoryKey(rootId, entry.relativePath)];
    if (childState?.snapshot) {
      return childState.snapshot.entries.some((child) =>
        entryMatches(child, rootId, directories, query, caseSensitive),
      );
    }
  }
  return false;
}

/**
 * FileTreePanel 只维护“哪些目录已展开/已请求”的纯 UI 临时态。
 * 文件系统真值与访问授权均在 FileTreeService，切 session 后本组件会被 LayoutHost
 * 按 sessionId 重挂，避免旧目录项闪到新终端。
 */
export function FileTreePanel({ sessionId, search }: FileTreePanelProps): JSX.Element {
  const { tx } = useTranslation();
  const [roots, setRoots] = useState<FileTreeRootInfo[] | null>(null);
  const [rootError, setRootError] = useState<string | null>(null);
  // 需求3(ADR-019 L1):展开/加载态走组件外缓存,切面板再切回不丢展开目录。
  const [directories, setDirectories] = usePanelUiState<DirectoryStates>(
    sessionId,
    'file-tree',
    {},
  );
  /** v0.3.2:搜索用的全量扁平缓存(按 rootId)。query 变化不重拉,只在进入搜索态/
   * session 变化时拉一次,让本地过滤即时(无 IPC 延迟)。 */
  const [recursiveResults, setRecursiveResults] = useState<
    Partial<Record<FileTreeRootId, ListFileTreeRecursiveResponse>>
  >({});
  const isSearching = search.visible && search.query.length > 0;

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
    [sessionId, setDirectories],
  );

  useEffect(() => {
    let cancelled = false;
    setRoots(null);
    setRootError(null);
    // directories 不在这里清:它走 usePanelUiState(按 sessionId 隔离),sessionId
    // 变化会触发组件重挂(LayoutHost key 含 sessionId),新 mount 自动读新 session 缓存;
    // 在这里 setDirectories({}) 反而会清掉刚从缓存恢复的展开态(需求3)。
    setRecursiveResults({});
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

  // v0.3.2:进入搜索态时拉一次全量递归(每个 available root),供本地过滤。
  // 只在「开始搜索且某 root 未缓存」时拉;query 变化不重拉(本地过滤快)。
  // session 变化时 recursiveResults 被 roots effect 清空(下面 setRecursiveResults({}))。
  useEffect(() => {
    if (!isSearching || !roots) return;
    let cancelled = false;
    const missing = roots.filter(
      (r) => r.available && !recursiveResults[r.id],
    );
    if (missing.length === 0) return;
    Promise.all(
      missing.map((r) =>
        window.api.invoke<
          { sessionId: string; rootId: FileTreeRootId },
          ListFileTreeRecursiveResponse
        >(COMMAND_CHANNELS.FILE_TREE_LIST_RECURSIVE, { sessionId, rootId: r.id })
          .then((res) => [r.id, res] as const)
          .catch((err: unknown) => {
            console.warn('[FileTreePanel] list-recursive failed', r.id, err);
            return null;
          }),
      ),
    ).then((results) => {
      if (cancelled) return;
      setRecursiveResults((prev) => {
        const next = { ...prev };
        for (const row of results) {
          if (!row) continue;
          next[row[0]] = row[1];
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [isSearching, roots, recursiveResults, sessionId]);

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

  // v0.3.2:搜索态用全量递归缓存做本地过滤,得扁平匹配列表(跨所有 root 合并)。
  // 匹配 name 或 relativePath(后者让用户能按路径片段搜)。按 relativePath 排序稳定。
  const searchMatches = useMemo(() => {
    if (!isSearching) return { items: [], truncated: false, dirCount: 0 };
    const q = search.query;
    const cs = search.caseSensitive;
    const out: Array<{
      rootId: FileTreeRootId;
      entry: FileTreeEntry;
      truncated: boolean;
      dirCount: number;
    }> = [];
    let anyTruncated = false;
    let totalDirCount = 0;
    for (const root of roots ?? []) {
      if (!root.available) continue;
      const res = recursiveResults[root.id];
      if (!res) continue;
      if (res.truncated) anyTruncated = true;
      totalDirCount += res.dirCount;
      for (const entry of res.entries) {
        if (
          matchText(entry.name, q, cs) ||
          matchText(entry.relativePath, q, cs)
        ) {
          out.push({ rootId: root.id, entry, truncated: res.truncated, dirCount: res.dirCount });
        }
      }
    }
    // 相对路径稳定排序(文件/目录不强制分组,按路径字典序更符合搜索直觉)。
    out.sort((a, b) => a.entry.relativePath.localeCompare(b.entry.relativePath));
    return { items: out, truncated: anyTruncated, dirCount: totalDirCount };
  }, [isSearching, search.query, search.caseSensitive, roots, recursiveResults]);

  // 需求2(ADR-019):双根切换 —— 顶部 toolbar 选「当前目录 / 临时工作区」,
  // 下方只渲染选中 root 的树(不再两个并排)。activeRootId 是 L2 偏好(跨重启记忆);
  // 偏好命中且可用 → 用它,否则回退第一个可用 root(异常兑底:workspace 创建中 /
  // cwd 丢失时自动落到另一个)。单 available root 不显示 toolbar(切无可切);
  // 零 available(SSH 会话等)在根渲染显示不可用提示。
  const availableRoots = useMemo(
    () => (roots ?? []).filter((r) => r.available),
    [roots],
  );
  const [activeRootId, setActiveRootId] = usePanelPreference<FileTreeRootId | null>(
    'file-tree',
    'activeRootId',
    null,
  );
  const effectiveActiveRoot = useMemo(() => {
    if (activeRootId && availableRoots.some((r) => r.id === activeRootId)) {
      return availableRoots.find((r) => r.id === activeRootId) ?? null;
    }
    return availableRoots[0] ?? null;
  }, [activeRootId, availableRoots]);

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
      {isSearching ? (
        <SearchResultsList
          sessionId={sessionId}
          matches={searchMatches}
          search={search}
          roots={roots}
          recursiveResults={recursiveResults}
          onOpen={openFile}
          tx={tx}
        />
      ) : availableRoots.length === 0 ? (
        // 零可用 root(SSH 会话 / cwd 与 workspace 都不可用):显示首个 root 的原因。
        <p className="file-tree-unavailable">
          {roots[0]?.reason ?? tx('文件导航不可用', 'File navigation unavailable')}
        </p>
      ) : (
        <>
          {/* 双可用 root 时显示切换 toolbar(需求2);单 root 不显示(切无可切)。 */}
          {availableRoots.length >= 2 && (
            <div
              className="file-tree-toolbar"
              role="group"
              aria-label={tx('切换根目录', 'Switch root')}
            >
              {availableRoots.map((root) => (
                <button
                  key={root.id}
                  type="button"
                  className={`file-tree-toolbar-btn${
                    root.id === effectiveActiveRoot?.id ? ' active' : ''
                  }`}
                  onClick={() => setActiveRootId(root.id)}
                  aria-pressed={root.id === effectiveActiveRoot?.id}
                  title={root.label}
                >
                  <Icon name="folder" size={14} />
                  <span>{root.label}</span>
                </button>
              ))}
            </div>
          )}
          {effectiveActiveRoot && (
            <section className="file-tree-root">
              <DirectoryChildren
                sessionId={sessionId}
                rootId={effectiveActiveRoot.id}
                state={directories[directoryKey(effectiveActiveRoot.id, '')]}
                directories={directories}
                onToggle={toggleDirectory}
                onOpen={openFile}
                tx={tx}
                search={search}
                depth={0}
              />
            </section>
          )}
        </>
      )}
    </div>
  );
}

/** searchMatches useMemo 的返回型。 */
interface SearchMatches {
  items: Array<{ rootId: FileTreeRootId; entry: FileTreeEntry; truncated: boolean; dirCount: number }>;
  truncated: boolean;
  dirCount: number;
}

/**
 * v0.3.2:搜索态的全量扁平结果列表。跨所有 available root 合并后按 relativePath 排序。
 *
 * 这是“树过滤 → 扁平全量过滤”的切换:懒加载时未展开目录搜不到,本组件用 main 端
 * list-recursive 一次拉全量缓存,本地过滤即时响应。label 显示完整 relativePath
 * (高亮匹配片段),让用户能按路径片段搜(如「src/foo」)。
 *
 * 性能:main 端 5000 entry 上限 + BFS,renderer 仅渲染匹配项(过滤后通常 ≤ 几十)。
 */
function SearchResultsList({
  sessionId,
  matches,
  search,
  roots,
  recursiveResults,
  onOpen,
  tx,
}: {
  sessionId: string;
  matches: SearchMatches;
  search: PanelSearchProps;
  roots: FileTreeRootInfo[];
  recursiveResults: Partial<Record<FileTreeRootId, ListFileTreeRecursiveResponse>>;
  onOpen: (rootId: FileTreeRootId, relativePath: string) => void;
  tx: (zh: string, en: string) => string;
}): JSX.Element {
  const copyToClipboard = useCopyToClipboard();
  const toast = useToast();
  const q = search.query;
  const cs = search.caseSensitive;

  // 某个 available root 还没拉到递归缓存 → 显示 loading(通常很快,一次 IPC)。
  const stillLoading = roots.some(
    (r) => r.available && !recursiveResults[r.id],
  );

  if (stillLoading) {
    return <div className="file-tree-loading">{tx('正在扫描全目录…', 'Scanning all directories…')}</div>;
  }

  if (matches.items.length === 0) {
    return <div className="file-tree-empty">{tx('无匹配', 'No match')}</div>;
  }

  return (
    <div className="file-tree-search-results">
      {matches.items.map(({ rootId, entry }) => (
        <FileListRow
          key={`${rootId}:${entry.relativePath}`}
          variant="list"
          icon={entry.kind === 'directory' ? 'folder' : fileIconFor(entry.name)}
          label={
            <HighlightedText text={entry.relativePath} query={q} caseSensitive={cs} />
          }
          title={entry.relativePath}
          {...(entry.kind === 'file'
            ? { onClick: () => onOpen(rootId, entry.relativePath) }
            : {})}
          buildContextMenu={() =>
            buildFileEntryMenu(
              {
                ...(entry.kind === 'file'
                  ? {
                      primary: {
                        label: tx('打开', 'Open'),
                        run: () => onOpen(rootId, entry.relativePath),
                      } as const,
                    }
                  : {}),
                relativePath: entry.relativePath || '.',
                reveal: () => {
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
                ...(entry.kind === 'file'
                  ? {
                      openExternal: () => {
                        window.api
                          .invoke(COMMAND_CHANNELS.FILE_TREE_OPEN_PATH, {
                            sessionId,
                            rootId,
                            relativePath: entry.relativePath,
                          })
                          .catch((err: unknown) =>
                            toast.push({
                              kind: 'error',
                              message: `打开失败:${err instanceof Error ? err.message : String(err)}`,
                            }),
                          );
                      },
                    }
                  : {}),
              },
              { copyToClipboard, toastError: (m) => toast.push({ kind: 'error', message: m }), tx },
            )
          }
        />
      ))}
      {matches.truncated && (
        <div className="file-tree-truncated">
          {tx(
            '目录过大，仅扫描了部分内容（上限 5000 项 / 深度 15）。',
            'Directory too large; only partial contents scanned (limit 5000 entries / depth 15).',
          )}
        </div>
      )}
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
  search,
  depth = 0,
}: {
  sessionId: string;
  rootId: FileTreeRootId;
  state: DirectoryState | undefined;
  directories: DirectoryStates;
  onToggle: (rootId: FileTreeRootId, relativePath: string) => void;
  onOpen: (rootId: FileTreeRootId, relativePath: string) => void;
  tx: (zh: string, en: string) => string;
  search: PanelSearchProps;
  /** 当前层级(根层=0)。传给 FileListRow 做缩进,替代旧 CSS 层叠(ADR-019)。 */
  depth?: number;
}): JSX.Element | null {
  const isSearching = search.visible && search.query.length > 0;
  // 搜索模式下强制展开所有已加载目录(让匹配可见)。未加载目录仍需用户手动展开
  // (懒加载根本限制:没拉过的目录 renderer 无数据可过滤)。
  if (!isSearching && !state?.expanded) return null;
  if (state?.loading)
    return <div className="file-tree-loading file-tree-indent">{tx('读取中…', 'Loading…')}</div>;
  if (state?.error) return <div className="file-tree-error file-tree-indent">{state.error}</div>;
  if (!state?.snapshot) return null;

  // 搜索过滤:保留匹配叶子 + 含匹配后代的目录(递归已加载子树)。
  const filteredEntries = isSearching
    ? state.snapshot.entries.filter((entry) =>
        entryMatches(entry, rootId, directories, search.query, search.caseSensitive),
      )
    : state.snapshot.entries;

  return (
    <div className="file-tree-children">
      {filteredEntries.map((entry) => (
        <FileTreeEntryRow
          key={entry.relativePath}
          sessionId={sessionId}
          rootId={rootId}
          depth={depth}
          entry={entry}
          state={directories[directoryKey(rootId, entry.relativePath)]}
          directories={directories}
          onToggle={onToggle}
          onOpen={onOpen}
          tx={tx}
          search={search}
        />
      ))}
      {filteredEntries.length === 0 && isSearching && (
        <div className="file-tree-empty file-tree-indent">{tx('无匹配', 'No match')}</div>
      )}
      {state.snapshot.entries.length === 0 && !isSearching && (
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
  search,
  depth = 0,
}: {
  sessionId: string;
  rootId: FileTreeRootId;
  entry: FileTreeEntry;
  state: DirectoryState | undefined;
  directories: DirectoryStates;
  onToggle: (rootId: FileTreeRootId, relativePath: string) => void;
  onOpen: (rootId: FileTreeRootId, relativePath: string) => void;
  tx: (zh: string, en: string) => string;
  search: PanelSearchProps;
  /** 当前层级(根层=0)。传给 FileListRow 做缩进(ADR-019)。 */
  depth?: number;
}): JSX.Element {
  const isDirectory = entry.kind === 'directory';
  const isSearching = search.visible && search.query.length > 0;
  // 右键菜单依赖:每个 row 一个 hook 实例完全合法(React 按组件位置记忆)。
  // 条目数量不会很大,换来的内聚性比层层透传 props 更可读。
  const copyToClipboard = useCopyToClipboard();
  const toast = useToast();

  const buildContextMenu = (): ContextMenuItem[] =>
    buildFileEntryMenu(
      {
        // 主操作与左键一致:目录=展开/收起,文件=打开预览。
        primary: {
          label: isDirectory ? tx('展开/收起', 'Expand/Collapse') : tx('打开', 'Open'),
          run: () =>
            isDirectory
              ? onToggle(rootId, entry.relativePath)
              : onOpen(rootId, entry.relativePath),
        },
        // file-tree 不提供 openFile(primary 已是"打开");不提供 resolveAbsolutePath
        // (保持 rootId 抽象,不向 renderer 暴露绝对路径)。
        relativePath: entry.relativePath || '.',
        // reveal 走专用 reveal-path IPC:main 端做根包含校验后调
        // shell.showItemInFolder。renderer 始终拿不到绝对路径。
        reveal: () => {
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
        // v0.3.2:用系统默认应用打开(只对文件,目录无意义)。走对称的
        // file-tree:open-path IPC(main 端 resolve + openPath,保 rootId 抽象)。
        ...(isDirectory
          ? {}
          : {
              openExternal: () => {
                window.api
                  .invoke(COMMAND_CHANNELS.FILE_TREE_OPEN_PATH, {
                    sessionId,
                    rootId,
                    relativePath: entry.relativePath,
                  })
                  .catch((err: unknown) =>
                    toast.push({
                      kind: 'error',
                      message: `打开失败:${err instanceof Error ? err.message : String(err)}`,
                    }),
                  );
              },
            }),
      },
      { copyToClipboard, toastError: (m) => toast.push({ kind: 'error', message: m }), tx },
    );

  return (
    <div className="file-tree-entry">
      {/* 重构后:条目本体走统一的 FileListRow(variant=list),为后续右键菜单与
          git/file-panel 三面板一致化打基础。leading 槽放 chevron/filler 以保留
          原视觉对齐。目录展开的子树仍在本组件内递归渲染(不变)。 */}
      <FileListRow
        variant="list"
        depth={depth}
        icon={isDirectory ? 'folder' : fileIconFor(entry.name)}
        label={
          <HighlightedText
            text={entry.name}
            query={isSearching ? search.query : ''}
            caseSensitive={search.caseSensitive}
          />
        }
        title={entry.name}
        onClick={() =>
          isDirectory ? onToggle(rootId, entry.relativePath) : onOpen(rootId, entry.relativePath)
        }
        ariaExpanded={isDirectory ? !!state?.expanded || isSearching : undefined}
        buildContextMenu={buildContextMenu}
        leading={
          isDirectory ? (
            <Icon name={state?.expanded || isSearching ? 'chevronDown' : 'chevronRight'} size={12} />
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
          search={search}
          depth={depth + 1}
        />
      )}
    </div>
  );
}
