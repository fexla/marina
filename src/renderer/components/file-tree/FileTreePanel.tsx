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
 * - 目录列表快照的失效源 = main 端 demand-aware 轮询(ADR-021,与 Git 同构):
 *   LayoutHost 报 HOT/NONE(仅前台终端的文件面板 = HOT),本面板报展开目录
 *   集合,FileTreePollingService 每 3s 重验 + diff,变化经 evt:file-tree:changed
 *   广播,组件订阅后静默替换快照。此前列表缓存无任何失效源,删除的文件会
 *   一直停留在面板上(远程文件系统 inotify 不可靠,轮询是唯一可靠失效源)。
 *
 * @对应文档章节:软件定义书.md §14.6 受限文件导航例外、ADR-016。
 *
 * @不要在这里做的事:
 * - 不做文件编辑、创建、删除、重命名、上传或下载。
 * - 不显示任意目录、SSH/SFTP 远端目录或 Project/Workspace 容器。
 */
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  COMMAND_CHANNELS,
  EVENT_CHANNELS,
  type FileTreeChangedPayload,
  type FileTreePollingDir,
  type FileTreeRootInfo,
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
import { waitForClaim } from '../../hooks/claim-gate';
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

/** 搜索最多挂载 200 行；main 可扫描 5000 项，但全量命中时一次挂大量 DOM 会卡 renderer。 */
const MAX_VISIBLE_SEARCH_RESULTS = 200;

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
        const snapshot = await window.api.invoke(COMMAND_CHANNELS.FILE_TREE_LIST_DIRECTORY, {
          sessionId,
          rootId,
          relativePath,
        });
        // 大目录返回最多 500 项；标记为 transition 让 React concurrent renderer
        // 可在构建大量行时主动让出主线程，避免一次同步更新冻结整个窗口。
        startTransition(() => {
          setDirectories((current) => ({
            ...current,
            [key]: { expanded: true, loading: false, snapshot },
          }));
        });
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

  // ── 目录列表快照的失效源:main 端 demand 轮询 + 事件推送 ────────────
  // 背景:列表快照存在 L1 组件外缓存(panel-ui-cache),此前**没有任何失效源**
  // —— 无 watcher、无轮询、收起再展开也不重拉,远程文件系统
  // (inotify 不可靠)上删除的文件几小时不消失。
  // 机制(ADR-021,与 Git 面板同构):LayoutHost 的 useFileTreePollingDemand
  // 报 HOT/NONE(仅前台终端的文件面板 = HOT);本面板把展开目录集合
  // 报给 main(FILE_TREE_SET_WATCHED_DIRS);main 端 FileTreePollingService 每 3s
  // 重验并 diff,变化时经 evt:file-tree:changed 广播,本组件订阅后直填快照。
  /** 上次上报的展开集合(JSON 序列化比较,内容没变不发 IPC,与
   *  useGitPollingDemand 的 lastSent 同策略,避免每次展开/收起都重发。 */
  const lastDirsSentRef = useRef<string | null>(null);

  // 展开集合变化 → 上报轮询目标。不关心可见性:demand(HOT/NONE)由
  // LayoutHost 的 hook 管,这里只报告"要盯哪些目录"。
  useEffect(() => {
    const dirs: FileTreePollingDir[] = [];
    for (const [key, state] of Object.entries(directories)) {
      if (!state?.expanded) continue;
      const sep = key.indexOf(':');
      dirs.push({
        rootId: key.slice(0, sep) as FileTreeRootId,
        relativePath: key.slice(sep + 1),
      });
    }
    const serialized = JSON.stringify(dirs);
    if (lastDirsSentRef.current === serialized) return;
    lastDirsSentRef.current = serialized;
    window.api
      .invoke(COMMAND_CHANNELS.FILE_TREE_SET_WATCHED_DIRS, { sessionId, dirs })
      .catch((err: unknown) => {
        // 失败清 lastSent 让下一次变化可重试(同 useGitPollingDemand 策略)。
        if (lastDirsSentRef.current === serialized) lastDirsSentRef.current = null;
        console.warn('[FileTreePanel] set watched dirs failed', err);
      });
  }, [directories, sessionId]);

  // 面板卸载:撤销本窗口的轮询目标(level 的 NONE 由 LayoutHost hook 的
  // cleanup 发,双路都幂等)。
  useEffect(() => {
    return () => {
      lastDirsSentRef.current = null;
      window.api
        .invoke(COMMAND_CHANNELS.FILE_TREE_SET_WATCHED_DIRS, { sessionId, dirs: [] })
        .catch((err: unknown) => console.warn('[FileTreePanel] clear watched dirs failed', err));
    };
  }, [sessionId]);

  // main 端轮询 diff 出变化 → 广播 → 本窗口按 sessionId 过滤,直填快照。
  // 只更新本面板已存在的目录 key(没展开的目录 renderer 无数据可更新);
  // 内容相同(JSON 相等)不写 state,避免无谓重渲染。main 已按基线
  // diff,这里再做一次相等保护,防与用户手动展开的响应竞态覆盖。
  useEffect(() => {
    const off = window.api.on<FileTreeChangedPayload>(
      EVENT_CHANNELS.FILE_TREE_CHANGED,
      (payload) => {
        if (payload.sessionId !== sessionId || payload.changes.length === 0) return;
        startTransition(() => {
          setDirectories((current) => {
            let next = current;
            for (const change of payload.changes) {
              const key = directoryKey(change.rootId, change.relativePath);
              const prev = current[key];
              if (!prev) continue;
              if (JSON.stringify(prev.snapshot) === JSON.stringify(change.snapshot)) continue;
              next = { ...next, [key]: { ...prev, loading: false, snapshot: change.snapshot } };
            }
            return next === current ? current : next;
          });
        });
      },
    );
    return off;
  }, [sessionId, setDirectories]);

  useEffect(() => {
    let cancelled = false;
    setRoots(null);
    setRootError(null);
    // directories 不在这里清:它走 usePanelUiState(按 sessionId 隔离),sessionId
    // 变化会触发组件重挂(LayoutHost key 含 sessionId),新 mount 自动读新 session 缓存;
    // 在这里 setDirectories({}) 反而会清掉刚从缓存恢复的展开态(需求3)。
    setRecursiveResults({});
    // 若该 session 正在被 claim(乐观接管 orphan),等 claim 完成(main 端 owner 就位)
    // 再发请求,消除 NotOwner race。claim 失败(SessionAlreadyOwned/传输 reject)时
    // outcome.ok === false —— 此时 main 端 owner 不会就位,硬发只会命中 NotOwner
    // 然后渲染错误态,所以必须中止请求(失败后果由各 claim 调用方的 rollback +
    // 组件卸载处理)。常规切换(已持有)时 waitForClaim 立即返回 { ok: true }。
    void waitForClaim(sessionId).then((outcome) => {
      if (cancelled || !outcome.ok) return;
      window.api
        .invoke(COMMAND_CHANNELS.FILE_TREE_GET_ROOTS, {
          sessionId,
        })
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
    const missing = roots.filter((r) => r.available && !recursiveResults[r.id]);
    if (missing.length === 0) return;
    Promise.all(
      missing.map((r) =>
        window.api
          .invoke(COMMAND_CHANNELS.FILE_TREE_LIST_RECURSIVE, { sessionId, rootId: r.id })
          .then((res) => [r.id, res] as const)
          .catch((err: unknown) => {
            console.warn('[FileTreePanel] list-recursive failed', r.id, err);
            return null;
          }),
      ),
    ).then((results) => {
      if (cancelled) return;
      // 单 root 最多 5000 entries；命中很多时构建过滤结果也会很重。标记为
      // transition，让搜索输入/窗口拖动可抢占，避免远程大响应落地时冻结整窗。
      startTransition(() => {
        setRecursiveResults((prev) => {
          const next = { ...prev };
          for (const row of results) {
            if (!row) continue;
            next[row[0]] = row[1];
          }
          return next;
        });
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
      const toggleCached = (): void =>
        setDirectories((current) => ({
          ...current,
          [key]: { ...state, expanded: !state.expanded },
        }));
      // 展开缓存的大目录仍会同步创建最多 500 行；与首次 load 成功同样必须允许
      // concurrent renderer 分片。收起只卸载节点，保持同步以获得即时反馈。
      // 展开已缓存目录 = 纯翻转:先显示缓存(秒开),新列表由 main 端 3s 轮询
      // 的 evt:file-tree:changed 事件送达后静默替换。
      if (state.expanded) toggleCached();
      else startTransition(toggleCached);
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
    if (!isSearching) return { items: [], truncated: false, dirCount: 0, limited: false };
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
        if (matchText(entry.name, q, cs) || matchText(entry.relativePath, q, cs)) {
          out.push({ rootId: root.id, entry, truncated: res.truncated, dirCount: res.dirCount });
        }
      }
    }
    // 相对路径稳定排序(文件/目录不强制分组,按路径字典序更符合搜索直觉)。
    out.sort((a, b) => a.entry.relativePath.localeCompare(b.entry.relativePath));
    return {
      items: out.slice(0, MAX_VISIBLE_SEARCH_RESULTS),
      truncated: anyTruncated,
      dirCount: totalDirCount,
      limited: out.length > MAX_VISIBLE_SEARCH_RESULTS,
    };
  }, [isSearching, search.query, search.caseSensitive, roots, recursiveResults]);

  // 需求2(ADR-019):双根切换 —— 顶部 toolbar 选「当前目录 / 临时工作区」,
  // 下方只渲染选中 root 的树(不再两个并排)。activeRootId 是 L2 偏好(跨重启记忆);
  // 偏好命中且可用 → 用它,否则回退第一个可用 root(异常兑底:workspace 创建中 /
  // cwd 丢失时自动落到另一个)。单 available root 不显示 toolbar(切无可切);
  // 零 available(SSH 会话等)在根渲染显示不可用提示。
  const availableRoots = useMemo(() => (roots ?? []).filter((r) => r.available), [roots]);
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
  items: Array<{
    rootId: FileTreeRootId;
    entry: FileTreeEntry;
    truncated: boolean;
    dirCount: number;
  }>;
  truncated: boolean;
  dirCount: number;
  /** 匹配数超过 renderer 安全挂载上限；提示用户缩小查询。 */
  limited: boolean;
}

/**
 * v0.3.2:搜索态的全量扁平结果列表。跨所有 available root 合并后按 relativePath 排序。
 *
 * 这是“树过滤 → 扁平全量过滤”的切换:懒加载时未展开目录搜不到,本组件用 main 端
 * list-recursive 一次拉全量缓存,本地过滤即时响应。label 显示完整 relativePath
 * (高亮匹配片段),让用户能按路径片段搜(如「src/foo」)。
 *
 * 性能:main 端 5000 entry 上限 + BFS；renderer 最多挂 200 个匹配项，超出提示
 * 缩小查询，避免宽泛搜索一次创建数千 DOM。
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
  const stillLoading = roots.some((r) => r.available && !recursiveResults[r.id]);

  if (stillLoading) {
    return (
      <div className="file-tree-loading">{tx('正在扫描全目录…', 'Scanning all directories…')}</div>
    );
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
          label={<HighlightedText text={entry.relativePath} query={q} caseSensitive={cs} />}
          title={entry.relativePath}
          {...(entry.kind === 'file' ? { onClick: () => onOpen(rootId, entry.relativePath) } : {})}
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
      {matches.limited && (
        <div className="file-tree-truncated">
          {tx(
            `匹配过多，仅显示前 ${MAX_VISIBLE_SEARCH_RESULTS} 项；请缩小搜索范围。`,
            `Too many matches; showing the first ${MAX_VISIBLE_SEARCH_RESULTS}. Narrow the search to see more.`,
          )}
        </div>
      )}
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
            isDirectory ? onToggle(rootId, entry.relativePath) : onOpen(rootId, entry.relativePath),
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
      {/* ADR-019:treeNode 把 depth + branch/leaf + expanded 一次性交给 FileListRow；
          disclosure gutter / chevron / leaf spacer 都由共享行模块渲染，调用方不拼像素。 */}
      <FileListRow
        variant="list"
        treeNode={
          isDirectory
            ? {
                kind: 'branch',
                depth,
                expanded: !!state?.expanded || isSearching,
              }
            : { kind: 'leaf', depth }
        }
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
        buildContextMenu={buildContextMenu}
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
