/**
 * @file src/renderer/components/git/GitPanel.tsx
 * @purpose 当前 owner session 的 Git 变更浏览面板(v0.3.0)。
 *
 * @关键设计:
 * - 扁平变更列表(不递归目录树),按 tone 分组(conflict 置顶,untracked 默认折叠)。
 *   点文件 → cmd:git:open-diff → 跳「已打开」面板看 diff(FilePanelService 接管)。
 * - 状态拉取每次面板激活时主动调 cmd:git:get-status。本期 watcher 未启用,
 *   仓库变更不自动推;用户切回面板即重拉(对齐 PRD §5.1.4 的最小可行)。
 * - 右键菜单走统一 <FileListRow> 的 buildContextMenu,与 file-tree/file-panel 一致。
 *
 * @对应文档章节: 软件定义书.md §14.6 受限 Git 变更浏览例外(v0.3.0,ADR-017);
 *   docs/方案-Git面板与文件条目统一-20260718.md §5.1。
 *
 * @不要在这里做的事:
 * - 不调任何写 .git 的命令(没有对应 IPC,产品边界)。
 * - 不展示 commit history / branch / log(超出本期范围)。
 * - status 真值走组件外缓存(git-status-cache.ts),消除面板切换的 spawn git 延迟。
 *   mount 先读缓存秒显,后台静默刷新(loading 不覆盖已有 snapshot)。缓存失效由
 *   main 端 evt:git:status-updated(预取/watcher)或本组件 loadStatus 成功驱动。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  COMMAND_CHANNELS,
  EVENT_CHANNELS,
  type GetGitStatusResponse,
  type GitStatusGroup,
  type GitStatusTone,
  type GitStatusUpdatedPayload,
  type GitUnavailableReason,
} from '@shared/protocol';
import { buildGitTree, type GitTreeNode } from '@shared/build-git-tree';
import { matchText } from '@shared/text-search';
import { fileIconFor } from '@shared/file-icon';
import { usePanelPreference } from '../../hooks/usePanelPreference';
import type { PanelSearchProps } from '../layout/panel-registry';
import { buildFileEntryMenu } from '../common/fileListRowContextMenu';
import { FileListRow, type StatusBadge, type StatusTone } from '../common/FileListRow';
import { HighlightedText } from '../common/HighlightedText';
import { Icon } from '../icons';
import { useTranslation } from '../LanguageProvider';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { useToast } from '../Toast';
import type { ContextMenuItem } from '../ContextMenu';
import {
  getCachedStatus,
  setCachedStatus,
  type GitStatusCacheEntry,
} from '@shared/git-status-cache';
import { GitTree } from './GitTree';

/** v0.3.0:树形/平铺视图模式。默认 tree(对齐 VS Code Source Control)。 */
type GitViewMode = 'tree' | 'flat';
const DEFAULT_VIEW_MODE: GitViewMode = 'tree';
// viewMode 持久化改走 usePanelPreference(L2,ADR-019);老 key marina.git.viewMode
// 由 panel-preferences 的惰性迁移自动收编到 marina.panel.git.viewMode。原
// readViewMode/writeViewMode(裸 localStorage)已删除。

interface GitPanelProps {
  sessionId: string;
  /** v0.3.1:dock 级搜索状态(C2 接入过滤)。 */
  search: PanelSearchProps;
}

interface ViewState {
  loading: boolean;
  snapshot?: { groups: GitStatusGroup[]; truncated: boolean } | undefined;
  unavailable?: GitUnavailableReason | undefined;
  error?: string | undefined;
  /** untracked 组是否展开(node_modules 等会污染列表,默认折叠)。 */
  untrackedExpanded: boolean;
}

/**
 * tone → StatusBadge 字母映射(与 GitService.toneToLetter 对齐,但 renderer
 * 不依赖 main 的内部函数,自行定义避免跨进程耦合)。
 */
/** D1:变更计数 chip 的文案与顺序(与 badgeFor 的字母对齐)。 */
const STATUS_TONE_LABELS: Array<{ tone: GitStatusTone; zh: string; en: string }> = [
  { tone: 'conflict', zh: '冲突', en: 'conflict' },
  { tone: 'modified', zh: '修改', en: 'modified' },
  { tone: 'added', zh: '新增', en: 'added' },
  { tone: 'deleted', zh: '删除', en: 'deleted' },
  { tone: 'renamed', zh: '重命名', en: 'renamed' },
  { tone: 'untracked', zh: '未跟踪', en: 'untracked' },
];

function badgeFor(tone: GitStatusTone): StatusBadge | null {
  const letter: Record<GitStatusTone, string> = {
    conflict: 'C',
    modified: 'M',
    added: 'A',
    deleted: 'D',
    renamed: 'R',
    untracked: '?',
  };
  return { letter: letter[tone], tone: tone as StatusTone };
}

function toneLabel(tone: GitStatusTone, tx: (zh: string, en: string) => string): string {
  switch (tone) {
    case 'conflict':
      return tx('冲突', 'Conflicts');
    case 'modified':
      return tx('已修改', 'Modified');
    case 'added':
      return tx('已新增', 'Added');
    case 'deleted':
      return tx('已删除', 'Deleted');
    case 'renamed':
      return tx('已重命名', 'Renamed');
    case 'untracked':
      return tx('未跟踪', 'Untracked');
  }
}

export function GitPanel({ sessionId, search }: GitPanelProps): JSX.Element {
  // C1:搜索骨架已接入,过滤逻辑 C2 实现。
  void search;
  const { tx } = useTranslation();
  // 需求3(ADR-019 L2):viewMode 走面板偏好(跨重启),老 key 自动迁移。
  const [viewMode, setViewMode] = usePanelPreference<GitViewMode>(
    'git',
    'viewMode',
    DEFAULT_VIEW_MODE,
  );
  // mount 初始化:先读组件外缓存。命中 → loading:false + snapshot 秒显(零延迟);
  // 未命中 → loading:true 走首次拉取。这是 stale-while-revalidate 的核心。
  const [state, setState] = useState<ViewState>(() => {
    const cached = getCachedStatus(sessionId);
    if (cached) {
      return {
        loading: false,
        untrackedExpanded: false,
        snapshot:
          cached.groups !== undefined
            ? { groups: cached.groups, truncated: cached.truncated ?? false }
            : undefined,
        unavailable: cached.unavailable,
      };
    }
    return { loading: true, untrackedExpanded: false };
  });
  const copyToClipboard = useCopyToClipboard();
  const toast = useToast();

  const loadStatus = useCallback(async (): Promise<void> => {
    // 关键:后台刷新时不把已有 snapshot 清掉(避免秒显后闪烁)。
    // loading 标志用于指示"后台正在刷",但 UI 分支里只要 snapshot/unavailable 还在
    // 就继续显示旧值,不回到 loading 占位。
    setState((s) => ({ ...s, loading: true, error: undefined }));
    try {
      const resp = await window.api.invoke<unknown, GetGitStatusResponse>(
        COMMAND_CHANNELS.GIT_GET_STATUS,
        { sessionId },
      );
      if ('unavailable' in resp) {
        setState((s) => ({
          ...s,
          loading: false,
          unavailable: resp.unavailable,
          snapshot: undefined,
        }));
        setCachedStatus(sessionId, { unavailable: resp.unavailable, at: Date.now() });
      } else {
        setState((s) => ({
          ...s,
          loading: false,
          unavailable: undefined,
          snapshot: { groups: resp.groups, truncated: resp.truncated },
        }));
        const entry: GitStatusCacheEntry = {
          groups: resp.groups,
          truncated: resp.truncated,
          at: Date.now(),
        };
        setCachedStatus(sessionId, entry);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[GitPanel] get-status failed', err);
      setState((s) => ({ ...s, loading: false, error: message }));
    }
  }, [sessionId]);

  // mount / sessionId 变化时拉一次(后台刷新)。有缓存时 UI 已秒显旧值,这里拉
  // 新值是为了同步切走期间的变化。ADR-021 同时把可见 demand 切 HOT；main 端
  // session+cwd in-flight coalescer 保证本 mount 拉取与 HOT immediate 只 spawn 一次。
  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // main 端在 cwd 进仓库(预取)或 demand-aware 周期刷新时
  // emit evt:git:status-updated 带 snapshot。过滤本 session → 直接用 payload 更新
  // state + 缓存,不走二次 IPC。这是"零延迟面板切换"的关键:用户点 tab 之前
  // 预取已把缓存填好,切过来秒显最新值。
  useEffect(() => {
    const off = window.api.on<GitStatusUpdatedPayload>(
      EVENT_CHANNELS.GIT_STATUS_UPDATED,
      (payload) => {
        if (payload.sessionId !== sessionId) return;
        if ('unavailable' in payload && payload.unavailable !== undefined) {
          setState((s) => ({
            ...s,
            loading: false,
            unavailable: payload.unavailable,
            snapshot: undefined,
          }));
          setCachedStatus(sessionId, { unavailable: payload.unavailable, at: Date.now() });
        } else {
          const groups = payload.groups ?? [];
          const truncated = payload.truncated ?? false;
          setState((s) => ({
            ...s,
            loading: false,
            unavailable: undefined,
            snapshot: { groups, truncated },
          }));
          setCachedStatus(sessionId, { groups, truncated, at: Date.now() });
        }
      },
    );
    return off;
  }, [sessionId]);

  // tree 模式:把所有 groups 的 entries 打平后构建目录树。useMemo 只在 snapshot/viewMode
  // 变时重算。必须在所有 early return 之前调用(React hooks 规则)。
  // v0.3.1 C2:搜索过滤。visible + 非空 query 时按 relativePath/oldPath 过滤
  // entries。tree 模式用过滤后的 entries 构建(自然只含匹配路径的树);flat 模式
  // 直接渲染过滤后的 groups。空 groups(全被过滤) 不渲染分组。
  const isSearching = search.visible && search.query.length > 0;
  const filteredGroups = useMemo<GitStatusGroup[]>(() => {
    if (!state.snapshot) return [];
    if (!isSearching) return state.snapshot.groups;
    const q = search.query;
    return state.snapshot.groups
      .map((g) => ({
        ...g,
        entries: g.entries.filter(
          (e) =>
            matchText(e.relativePath, q, search.caseSensitive) ||
            (e.oldPath !== undefined && matchText(e.oldPath, q, search.caseSensitive)),
        ),
      }))
      .filter((g) => g.entries.length > 0);
  }, [isSearching, search.query, search.caseSensitive, state.snapshot]);

  const treeNodes = useMemo<GitTreeNode[]>(() => {
    if (viewMode !== 'tree' || !state.snapshot) return [];
    const allEntries = filteredGroups.flatMap((g) =>
      g.entries.map((e) => ({ relativePath: e.relativePath, oldPath: e.oldPath, tone: g.tone })),
    );
    return buildGitTree(allEntries);
  }, [viewMode, state.snapshot, filteredGroups]);

  // D1 变更计数:全量变更数(非过滤后),显示在面板顶部 summary bar。只算 total +
  // 按 tone 分类,让用户一眼看到「3 modified · 1 added · 2 untracked」。
  const counts = useMemo(() => {
    const map = new Map<GitStatusTone, number>();
    let total = 0;
    for (const g of state.snapshot?.groups ?? []) {
      const n = g.entries.length;
      if (n > 0) {
        map.set(g.tone, (map.get(g.tone) ?? 0) + n);
        total += n;
      }
    }
    return { map, total };
  }, [state.snapshot]);

  const openDiff = (relativePath: string): void => {
    window.api
      .invoke(COMMAND_CHANNELS.GIT_OPEN_DIFF, { sessionId, relativePath })
      // main 端 GitService.openDiff 成功后进 FilePanelService.openFile,后者
      // 发 evt:file-panel:updated(requestActivation=true)切到「已打开」。
      .catch((err: unknown) => {
        console.warn('[GitPanel] open-diff failed', err);
        toast.push({
          kind: 'error',
          message: `打开 diff 失败:${err instanceof Error ? err.message : String(err)}`,
        });
      });
  };

  // v0.3.1 勘误:打开文件本身(不走 diff)。deleted 文件工作区已不存在 → 禁用此项。
  const openFile = (relativePath: string): void => {
    window.api
      .invoke(COMMAND_CHANNELS.GIT_OPEN_FILE, { sessionId, relativePath })
      .catch((err: unknown) => {
        console.warn('[GitPanel] open-file failed', err);
        toast.push({
          kind: 'error',
          message: `打开文件失败:${err instanceof Error ? err.message : String(err)}`,
        });
      });
  };

  // v0.3.1 勘误:resolve 相对路径 → 绝对路径(供复制绝对路径 / reveal)。复用 fileListRowContextMenu
  // 的 copyPathItems / revealInExplorerItem,与 file-tree/file-panel 菜单一致。
  const resolveAbsPath = async (relativePath: string): Promise<string> => {
    const res = await window.api.invoke<
      { sessionId: string; relativePath: string },
      { absolutePath: string }
    >(COMMAND_CHANNELS.GIT_RESOLVE_PATH, { sessionId, relativePath });
    return res.absolutePath;
  };

  // v0.3.1 ADR-018:右键菜单改用统一生成器 buildFileEntryMenu。
  // tree + flat 都用它,形态与其他面板一致。deleted 文件 → openFile 禁用。
  const buildEntryMenu = (relativePath: string, tone?: GitStatusTone): ContextMenuItem[] =>
    buildFileEntryMenu(
      {
        primary: { label: tx('打开 diff', 'Open diff'), run: () => openDiff(relativePath) },
        openFile: {
          run: () => openFile(relativePath),
          disabled: tone === 'deleted',
        },
        relativePath,
        resolveAbsolutePath: () => resolveAbsPath(relativePath),
        // reveal / openExternal 都先 resolve 到绝对路径再调系统 IPC。抽个局部 helper
        // 避免两处重复 then/catch ladder。
        reveal: () => withAbsPath(relativePath, (abs) => onSystemOp(abs, 'show')),
        // v0.3.2:用系统默认应用打开(deleted 文件工作区已删,让系统报错即可)。
        openExternal: () => withAbsPath(relativePath, (abs) => onSystemOp(abs, 'open')),
      },
      { copyToClipboard, toastError: (m) => toast.push({ kind: 'error', message: m }), tx },
    );

  /** resolve 相对路径为绝对路径后执行 op;解析失败 / 系统调用失败都 toast。 */
  function withAbsPath(relativePath: string, op: (abs: string) => void): void {
    resolveAbsPath(relativePath)
      .then(op)
      .catch((err: unknown) =>
        toast.push({
          kind: 'error',
          message: `解析路径失败:${err instanceof Error ? err.message : String(err)}`,
        }),
      );
  }

  /** 对绝对路径调系统 show-in-explorer / open-path 二选一。 */
  function onSystemOp(abs: string, op: 'show' | 'open'): void {
    const channel =
      op === 'show' ? COMMAND_CHANNELS.SYSTEM_SHOW_IN_EXPLORER : COMMAND_CHANNELS.SYSTEM_OPEN_PATH;
    const failLabel = op === 'show' ? '打开 Explorer 失败' : '打开失败';
    window.api.invoke(channel, { path: abs }).catch((err: unknown) =>
      toast.push({
        kind: 'error',
        message: `${failLabel}:${err instanceof Error ? err.message : String(err)}`,
      }),
    );
  }

  /** v0.3.2 B1:目录节点右键菜单(与 file-tree 目录菜单对称)。primary=展开/收起
   *  (onToggle 由 GitTree 注入,访问其内部 collapsed state);路径族同文件(resolvePath
   *  对目录也工作,reveal/openExternal 用资源管理器打开目录)。 */
  const buildDirMenu = (
    dirPath: string,
    _tone: GitStatusTone,
    onToggle: () => void,
  ): ContextMenuItem[] =>
    buildFileEntryMenu(
      {
        primary: { label: tx('展开/收起', 'Expand/Collapse'), run: onToggle },
        relativePath: dirPath,
        resolveAbsolutePath: () => resolveAbsPath(dirPath),
        reveal: () => withAbsPath(dirPath, (abs) => onSystemOp(abs, 'show')),
        openExternal: () => withAbsPath(dirPath, (abs) => onSystemOp(abs, 'open')),
      },
      { copyToClipboard, toastError: (m) => toast.push({ kind: 'error', message: m }), tx },
    );

  // ── 状态分支:loading / error / unavailable / 正常 ──
  // 有缓存(snapshot/unavailable)时优先显示旧值,不回 loading 占位(避免闪烁)。
  // 只有"首次进入且无缓存"才显示 loading。
  if (state.loading && !state.snapshot && !state.unavailable) {
    return <div className="git-panel-loading">{tx('正在读取变更…', 'Loading changes…')}</div>;
  }
  if (state.error) {
    return (
      <div className="git-panel-error">
        {tx('读取 Git 状态失败', 'Failed to read Git status')}: {state.error}
      </div>
    );
  }
  if (state.unavailable) {
    // 动态 LayoutNode 已在 main 端裁掉 Git tab(unavailable 时不生成 git leaf)。
    // 走到这里说明:用户看着 Git tab 时仓库被删 / cd 出仓库 / 设置关了。
    // 给一个明确但克制的提示,不弹错误。
    const msg: Record<GitUnavailableReason, string> = {
      'not-a-repo': tx(
        '当前目录已不在 Git 仓库内',
        'Current directory is no longer a Git repository',
      ),
      'ssh-unsupported': tx(
        'SSH 会话不支持 Git 面板',
        'Git panel is not supported for SSH sessions',
      ),
      disabled: tx('Git 面板已在设置中关闭', 'Git panel is disabled in settings'),
      'git-binary-missing': tx('未找到 git 二进制', 'Git binary not found'),
    };
    return <div className="git-panel-unavailable">{msg[state.unavailable]}</div>;
  }
  if (!state.snapshot) {
    return <div className="git-panel-loading">{tx('正在读取变更…', 'Loading changes…')}</div>;
  }
  if (state.snapshot.groups.length === 0) {
    return (
      <div className="git-panel-clean">{tx('工作区干净,无未提交变更', 'Working tree clean')}</div>
    );
  }

  // usePanelPreference 的 setter 已自动持久化,无需再手动 writeViewMode。
  const switchViewMode = (mode: GitViewMode): void => {
    setViewMode(mode);
  };

  return (
    <div className="git-panel" aria-label={tx('Git', 'Git')}>
      {counts.total > 0 && (
        <div className="git-panel-summary" role="status">
          {STATUS_TONE_LABELS.map(({ tone, zh, en }) => {
            const n = counts.map.get(tone);
            if (!n) return null;
            return (
              <span key={tone} className={`git-summary-chip git-summary-${tone}`}>
                <span className="git-summary-num">{n}</span>
                {tx(zh, en)}
              </span>
            );
          })}
          {state.snapshot?.truncated && (
            <span className="git-summary-truncated">
              {tx('(变更过多,已截断)', '(too many changes, truncated)')}
            </span>
          )}
        </div>
      )}
      <div className="git-panel-toolbar" role="group" aria-label={tx('视图模式', 'View mode')}>
        <button
          type="button"
          className={`git-panel-toolbar-btn${viewMode === 'tree' ? ' active' : ''}`}
          onClick={() => switchViewMode('tree')}
          title={tx('树形视图', 'Tree view')}
          aria-pressed={viewMode === 'tree'}
        >
          <Icon name="folderTree" size={14} />
        </button>
        <button
          type="button"
          className={`git-panel-toolbar-btn${viewMode === 'flat' ? ' active' : ''}`}
          onClick={() => switchViewMode('flat')}
          title={tx('平铺视图(按状态分组)', 'Flat view (grouped by status)')}
          aria-pressed={viewMode === 'flat'}
        >
          <Icon name="list" size={14} />
        </button>
      </div>
      {viewMode === 'tree' ? (
        treeNodes.length === 0 && isSearching ? (
          <div className="git-panel-empty">{tx('无匹配文件', 'No matching files')}</div>
        ) : (
          <GitTree
            sessionId={sessionId}
            nodes={treeNodes}
            onOpenDiff={openDiff}
            buildEntryMenu={buildEntryMenu}
            buildDirMenu={buildDirMenu}
            highlightQuery={isSearching ? search.query : ''}
            highlightCaseSensitive={search.caseSensitive}
          />
        )
      ) : filteredGroups.length === 0 && isSearching ? (
        <div className="git-panel-empty">{tx('无匹配文件', 'No matching files')}</div>
      ) : (
        filteredGroups.map((group) => {
          // untracked 默认折叠:node_modules / build 产物会污染列表。
          const isUntracked = group.tone === 'untracked';
          const expanded = !isUntracked || state.untrackedExpanded;
          return (
            <section key={group.tone} className="git-panel-group">
              <button
                type="button"
                className="git-panel-group-header"
                onClick={() =>
                  isUntracked &&
                  setState((s) => ({ ...s, untrackedExpanded: !s.untrackedExpanded }))
                }
                aria-expanded={expanded}
                disabled={!isUntracked}
              >
                {isUntracked ? (
                  <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={12} />
                ) : (
                  <span className="git-panel-group-spacer" />
                )}
                <span className={`git-panel-group-label tone-${group.tone}`}>
                  {toneLabel(group.tone, tx)}
                </span>
                <span className="git-panel-group-count">{group.entries.length}</span>
              </button>
              {expanded && (
                <div className="git-panel-group-entries">
                  {group.entries.map((entry) => {
                    const labelText = entry.oldPath
                      ? `${entry.oldPath} → ${entry.relativePath}`
                      : entry.relativePath;
                    return (
                      <FileListRow
                        key={entry.relativePath}
                        variant="list"
                        icon={fileIconFor(entry.relativePath)}
                        label={
                          <HighlightedText
                            text={labelText}
                            query={isSearching ? search.query : ''}
                            caseSensitive={search.caseSensitive}
                          />
                        }
                        title={labelText}
                        statusBadge={badgeFor(group.tone)}
                        onClick={() => openDiff(entry.relativePath)}
                        buildContextMenu={() => buildEntryMenu(entry.relativePath, group.tone)}
                      />
                    );
                  })}
                </div>
              )}
            </section>
          );
        })
      )}
      {state.snapshot.truncated && (
        <div className="git-panel-truncated">
          {tx('变更过多,仅显示前 500 项。', 'Too many changes; showing the first 500.')}
        </div>
      )}
    </div>
  );
}
