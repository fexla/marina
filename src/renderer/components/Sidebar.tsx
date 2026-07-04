/**
 * @file src/renderer/components/Sidebar.tsx
 * @purpose 三栏侧栏 (收藏 / 临时 / 最近),路径节点 + 子 session 节点。
 *   含 + 按钮调文件夹选择器、拖文件夹到收藏区加入收藏 (drag-drop)、
 *   单击选中、双击新建 session、右键菜单 (CP-2 简化菜单)。
 *
 * @关键设计:
 * - 三栏始终显示,即使空 (软件定义书 6.2.1: 默认全部展开)
 * - 同 path 在三栏不重叠;每个 path 节点可展开看 sessions
 * - sessions 显示状态点 (active 绿 / idle 黄 / exited 灰)、
 *   是否被其他窗口持有 (灰显 + ↗ 图标)
 * - 拖 Explorer 文件夹到 .sidebar-bookmarks-dropzone (CP-2 完成标志):
 *   先校验 file:// path 是否存在且是目录,然后调 cmd:bookmark:add
 * - SSH 方案 v2.1 §II.3:顶部 [本地] [远程] segmented control(仅在
 *   hasSshProfiles || advanced.enableRemote 时显示),按 kind 过滤三栏内容。
 *   本地用户(无 profile 且未启用远程)的 UI 与 beta.9 完全一致。
 * - 设置入口固定在底部 (CP-2 占位,CP-4 接入完整设置)
 *
 * @对应文档章节: 软件定义书.md 6.2 (左侧栏)、7.3 (拖拽规格)
 */
import {
  memo,
  useEffect,
  useState,
  useMemo,
  useRef,
  type DragEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronRight, X } from 'lucide-react';
import {
  COMMAND_CHANNELS,
  type AddBookmarkResponse,
  type CreateSessionResponse,
  type PickFolderResponse,
} from '@shared/protocol';
import type { PathNode, SessionInfo } from '@shared/types';
import { disambiguatePathNames } from '@shared/path-display';
import { useTranslation } from './LanguageProvider';
import {
  findMyOwnedSessionId,
  useAppDispatch,
  useAppState,
  useAppStateRef,
} from '../store';
import { Icon, type IconName } from './icons';
import { useContextMenuApi, type ContextMenuItem } from './ContextMenu';
import { useModal } from './Modal';
import { useToast } from './Toast';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import { buildSessionContextMenu } from './sessionContextMenu';

/**
 * 状态点颜色 (软件定义书 6.2.4 状态指示):
 * - active 🟢:近期有 PTY 输出
 * - idle  🟡:活着但 N 秒无输出
 * - exited ⚫:进程已退出 (ADR-008 取代旧 'tombstoned')
 *
 * 用 CSS variables 走主题切换 (CP-4 接通);#f0f fallback 是 stylelint 兜底
 * 防止变量缺失渲染成黑色 (软件定义书 5.1.9)。
 */
const STATE_DOT_COLOR: Record<SessionInfo['state'], string> = {
  active: 'var(--color-success, #f0f)',
  idle: 'var(--color-warning, #f0f)',
  exited: 'var(--color-text-muted, #f0f)',
};

// ──────────────────────────────────────────────────────────────────
// M1-C:全局 ContextMenuProvider 提到 App.tsx,这里只 useContextMenuApi。
// 旧版内嵌 provider 已删除,文件因此短了 100+ 行。
// ──────────────────────────────────────────────────────────────────

/**
 * SSH 方案 v2.1 §II.3:Sidebar 顶部 segmented control。
 * 'local' = 本机 + 所有 WSL 发行版,'remote' = 所有 SSH profile。
 * 持久化到 localStorage,跨重启保留;但 segmented control 本身只在用户已
 * 加 SSH profile 或勾了 advanced.enableRemote 时才渲染 — 否则 UI 与
 * beta.9 完全一致(本地视野不变式)。
 */
type SidebarSegment = 'local' | 'remote';
const SIDEBAR_SEGMENT_LS_KEY = 'marina.sidebar.segment';

function readSegmentFromStorage(): SidebarSegment {
  if (typeof window === 'undefined' || !window.localStorage) return 'local';
  const v = window.localStorage.getItem(SIDEBAR_SEGMENT_LS_KEY);
  return v === 'remote' ? 'remote' : 'local';
}

/**
 * Sidebar 宽度持久化(localStorage)。右侧 resize handle 拖动调整,松开时落盘。
 *
 * 范围 [SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH]:小于 min 路径名挤成省略号,大于
 * max 抢占终端区视觉权重。中间档默认 280px 与历史 CSS 一致,无 sidebarWidth
 * 时回落到该值(旧用户首次升级看不出变化)。
 */
const SIDEBAR_WIDTH_LS_KEY = 'marina.sidebar.width';
const SIDEBAR_DEFAULT_WIDTH = 280;
const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 600;

function clampSidebarWidth(n: number): number {
  if (!Number.isFinite(n)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.round(n)));
}

function readSidebarWidthFromStorage(): number {
  if (typeof window === 'undefined' || !window.localStorage) return SIDEBAR_DEFAULT_WIDTH;
  const v = window.localStorage.getItem(SIDEBAR_WIDTH_LS_KEY);
  if (v === null) return SIDEBAR_DEFAULT_WIDTH;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return SIDEBAR_DEFAULT_WIDTH;
  return clampSidebarWidth(n);
}

export function Sidebar(): JSX.Element {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const toast = useToast();
  const modal = useModal();
  const { t } = useTranslation();
  const [dragOver, setDragOver] = useState(false);
  const [collapsedCategoryIds, setCollapsedCategoryIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [segment, setSegmentState] = useState<SidebarSegment>(() =>
    readSegmentFromStorage(),
  );
  const setSegment = (next: SidebarSegment): void => {
    setSegmentState(next);
    try {
      window.localStorage?.setItem(SIDEBAR_SEGMENT_LS_KEY, next);
    } catch {
      // localStorage 在 incognito / 严格模式下可能抛 SecurityError,忽略即可
    }
  };

  // ── Sidebar 宽度可拖动 + 持久化 ──
  // 拖动期间只 setWidth 不写 localStorage(快速移动会大量触发 setItem),松开
  // 时才落盘一次。全局 mousemove/mouseup 监听通过 ref 标记 isResizing,避免
  // 鼠标移出 sidebar 边缘后丢失事件;widthRef 镜像 state 让 onUp 拿到最新值
  // 而不依赖 setState updater(updater 内 throw 会把异常抛到 commit)。
  // document.body.style.cursor 临时锁成 ew-resize,防止拖动越过 sidebar 边界
  // 进入终端区时鼠标光标抖。
  const [sidebarWidth, setSidebarWidth] = useState<number>(() =>
    readSidebarWidthFromStorage(),
  );
  const widthRef = useRef(sidebarWidth);
  widthRef.current = sidebarWidth;
  const isResizingRef = useRef(false);

  const handleResizeMouseDown = (e: MouseEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    isResizingRef.current = true;
    document.body.style.cursor = 'ew-resize';
    // 不允许拖动时选中文本
    document.body.style.userSelect = 'none';
  };

  useEffect(() => {
    const onMove = (e: globalThis.MouseEvent): void => {
      if (!isResizingRef.current) return;
      // sidebar 左边贴 viewport 左缘(无窗口阴影/边距),clientX 直接当宽度用
      setSidebarWidth(clampSidebarWidth(e.clientX));
    };
    const onUp = (): void => {
      if (!isResizingRef.current) return;
      isResizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try {
        window.localStorage?.setItem(SIDEBAR_WIDTH_LS_KEY, String(widthRef.current));
      } catch {
        // localStorage 失败容忍 — 本次会话内拖动仍生效,下次重启回落默认
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const handleResizeDoubleClick = (): void => {
    // 双击 handle 复位默认宽度(类似浏览器 devtools 分隔条惯例)
    setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
    try {
      window.localStorage?.setItem(SIDEBAR_WIDTH_LS_KEY, String(SIDEBAR_DEFAULT_WIDTH));
    } catch {
      // ignore
    }
  };

  const enableRemote = state.settings?.advanced?.enableRemote === true;
  const hasSshProfiles = state.sshProfiles.length > 0;
  /**
   * 本地不变式的核心:没 profile 且没勾 enableRemote 时,segmented control
   * 整体不渲染,segment 强制视为 'local',sidebar 跟 beta.9 完全一致。
   */
  const showSegmented = hasSshProfiles || enableRemote;
  const effectiveSegment: SidebarSegment = showSegmented ? segment : 'local';

  // SSH 方案 v2.1 §II.3:三栏按 segment 过滤(本地 = kind==='local',包含
  // WSL UNC 路径;远程 = kind==='ssh')。本地用户无 profile + 未启 enableRemote
  // 时 effectiveSegment 强制 'local',跟 beta.9 一样。
  const filterNodesBySegment = (nodes: PathNode[]): PathNode[] =>
    effectiveSegment === 'remote'
      ? nodes.filter((n) => n.kind === 'ssh')
      : nodes.filter((n) => n.kind === 'local');
  const bookmarksFiltered = useMemo(
    () => filterNodesBySegment(state.pathTree.bookmarks),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.pathTree.bookmarks, effectiveSegment],
  );
  const temporaryFiltered = useMemo(
    () => filterNodesBySegment(state.pathTree.temporary),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.pathTree.temporary, effectiveSegment],
  );
  const recentFiltered = useMemo(
    () => filterNodesBySegment(state.pathTree.recent),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.pathTree.recent, effectiveSegment],
  );

  const isCategoryCollapsed = (categoryId: string): boolean =>
    collapsedCategoryIds.has(categoryId);

  const handleToggleCategory = (categoryId: string): void => {
    setCollapsedCategoryIds((prev) => {
      const next = new Set(prev);
      if (next.has(categoryId)) {
        next.delete(categoryId);
      } else {
        next.add(categoryId);
      }
      return next;
    });
  };

  /**
   * 收藏栏 "+" 按钮。按当前 segment 走不同流程:
   *
   * - 本地段:beta.9 行为 — 系统 folder picker → BOOKMARK_ADD
   * - 远程段:用首个 SSH profile 弹 prompt 让用户输远端路径。多 profile
   *   时提示"用 X profile;要别的请去 设置 → 远程"。零 profile 时 toast
   *   引导用户去设置(showSegmented 已经保证不会出现 0 profile + 不能切
   *   远程段的状态,但 enableRemote=true 仍可能 0 profile)。
   */
  const handleAddBookmark = async (): Promise<void> => {
    if (effectiveSegment === 'remote') {
      const profiles = state.sshProfiles;
      if (profiles.length === 0) {
        toast.push({
          kind: 'warn',
          message: '请先在 设置 → 远程 添加 SSH 服务器',
        });
        return;
      }
      const profile = profiles[0]!;
      const remotePath = await modal.prompt({
        title: `添加远程文件夹 — ${profile.name}`,
        message:
          profiles.length > 1
            ? `用 ${profile.name}(${profile.username}@${profile.host}) 添加。改用其他服务器请去 设置 → 远程`
            : `输入 ${profile.username}@${profile.host} 上的目录路径。`,
        placeholder: '~/project',
        defaultValue: '~',
        confirmLabel: '加入',
      });
      const path = remotePath?.trim();
      if (!path) return;
      try {
        await window.api.invoke<unknown, AddBookmarkResponse>(
          COMMAND_CHANNELS.REMOTE_BOOKMARK_ADD,
          { sshProfileId: profile.id, remotePath: path },
        );
        toast.push({ kind: 'success', message: `已添加远程文件夹 ${path}` });
      } catch (err) {
        toast.push({
          kind: 'error',
          message: `添加远程文件夹失败:${err instanceof Error ? err.message : String(err)}`,
        });
      }
      return;
    }
    // 本地段:beta.9 行为
    try {
      const result = await window.api.invoke<unknown, PickFolderResponse>(
        COMMAND_CHANNELS.BOOKMARK_PICK_FOLDER,
        {},
      );
      if (result.path === null) return;
      await window.api.invoke<unknown, AddBookmarkResponse>(
        COMMAND_CHANNELS.BOOKMARK_ADD,
        { path: result.path },
      );
    } catch (err) {
      toast.push({
        kind: 'error',
        message: `添加文件夹失败:${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  /**
   * 勘误第二轮 #6:临时栏 + 按钮 — 选文件夹后直接在该路径起一个 session。
   * 临时分类完全从 PathManager.sessionToPath 推导,所以"加入临时"=" 在该
   * 路径起一个 session 后让它自然出现在临时栏"。配合默认模板 (全局默认)。
   */
  const handlePickFolderForTemp = async (): Promise<void> => {
    try {
      const result = await window.api.invoke<unknown, PickFolderResponse>(
        COMMAND_CHANNELS.BOOKMARK_PICK_FOLDER,
        {},
      );
      if (result.path === null) return;
      const templateId = state.defaultTemplateId ?? 'shell';
      const dims = state.lastTerminalDims;
      const res = await window.api.invoke<unknown, CreateSessionResponse>(
        COMMAND_CHANNELS.SESSION_CREATE,
        {
          pathId: result.path,
          templateId,
          cols: dims.cols,
          rows: dims.rows,
        },
      );
      // session 创建后:store reducer 自动 select 它(因 ownerWindowId === myWindowId)。
      // 这里再显式 dispatch 一次 select-path,防御性把视图切到该路径;紧随
      // 其后 select-session 把焦点重新落到新 session 上 —— hideTopTabBar=true
      // 模式下 view/select-path reducer 会清空 selectedSessionId,不补一次
      // select-session 会落到 EmptyPathState(用户刚显式新建却看不到终端)。
      dispatch({ type: 'view/select-path', pathId: res.session.pathId });
      dispatch({ type: 'view/select-session', sessionId: res.session.id });
      if (res.warning) {
        toast.push({ kind: 'warn', message: res.warning });
      }
    } catch (err) {
      toast.push({
        kind: 'error',
        message: `打开文件夹失败:${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  /**
   * F12(DROP-1 架构重构):拖拽决策全部收拢到 App.tsx 的 window 监听器。
   * Sidebar 不再 preventDefault / 不再设 dropEffect — 那些事 window 统
   * 一管,通过 `data-drop-zone="files"` 标记声明"我接受"。
   *
   * 本组件这里只剩两件事:
   *   1. onDragOver 维护视觉态(.drag-over 高亮 + 居中浮卡)
   *   2. onDrop 消费 files → IPC bookmark:add
   *
   * 心跳超时(F8 引入)仍然保留:拖出窗口 / ESC 时没有可靠的 dragleave,
   * 靠"150ms 没收到下一个 dragover 就清视觉态"兜底。
   */
  const dragHeartbeatRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearDragOverSoon = (): void => {
    if (dragHeartbeatRef.current) clearTimeout(dragHeartbeatRef.current);
    dragHeartbeatRef.current = setTimeout(() => {
      setDragOver(false);
      dragHeartbeatRef.current = null;
    }, 150);
  };

  useEffect(() => {
    return () => {
      if (dragHeartbeatRef.current) clearTimeout(dragHeartbeatRef.current);
    };
  }, []);

  /**
   * 检查当前拖拽内容是否含文件。
   * 注:Chromium 的 DataTransfer.types 在 dragover 阶段对 OS 文件拖拽稳定
   * 返回包含 "Files" 的数组。非文件来源(终端选区 / 网页文本拖拽)不含。
   * 仅用于视觉态门控 — 避免拖文本时也跳出"放下添加为收藏"的浮卡。
   */
  const isFileDrag = (e: DragEvent<HTMLElement>): boolean => {
    const types = e.dataTransfer?.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i++) {
      if (types[i] === 'Files') return true;
    }
    return false;
  };

  const handleDragOver = (e: DragEvent<HTMLElement>): void => {
    // 注意:这里不调 preventDefault / 不设 dropEffect — App.tsx 的 window
    // 监听器是唯一决策点(它会通过 data-drop-zone 属性识别本元素是 drop
    // zone 并设 'copy')。本 handler 只为视觉反馈服务。
    if (!isFileDrag(e)) return;
    setDragOver(true);
    clearDragOverSoon();
  };

  const handleDrop = async (e: DragEvent<HTMLElement>): Promise<void> => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (dragHeartbeatRef.current) {
      clearTimeout(dragHeartbeatRef.current);
      dragHeartbeatRef.current = null;
    }
    const files = Array.from(e.dataTransfer.files);
    for (const file of files) {
      // file.path 是 Electron 提供的扩展属性 (浏览器标准 File API 没有),
      // V1 我们假定 sandbox: false + nodeIntegration: false + contextIsolation: true
      // 也就是 webPreferences 默认提供 file.path
      const path = (file as File & { path?: string }).path;
      if (!path) continue;
      try {
        await window.api.invoke<unknown, AddBookmarkResponse>(
          COMMAND_CHANNELS.BOOKMARK_ADD,
          { path },
        );
      } catch (err) {
        console.error('[Sidebar] drop add-bookmark failed', err);
      }
    }
  };

  return (
    <aside
      className={`sidebar${dragOver ? ' drag-over' : ''}`}
      data-drop-zone="files"
      style={{ flexBasis: `${sidebarWidth}px` }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          dispatch({ type: 'view/select-path', pathId: null });
        }
      }}
      onDragOver={handleDragOver}
      onDrop={(e) => void handleDrop(e)}
    >
      {/* F11(beta 勘误2 续 v4):撤回 F9 inset box-shadow / F10 overlay border —
          sidebar 紧贴窗口左/下边,Win11 窗口圆角会吃掉绝对定位元素 inset:0 的
          左/下 2px 边框。改用纯背景洗涤区分 drag-over 态,浮卡居中作为主要
          视觉锚,完全不依赖边框渲染。pointer-events:none + aria-hidden 不挡 drop。 */}
      <div className="sidebar-drop-hint" aria-hidden="true">
        <span className="sidebar-drop-hint-icon">📁</span>
        <span className="sidebar-drop-hint-label">{t('sidebar.dropHint')}</span>
      </div>
      {showSegmented && (
        <div
          className="sidebar-segmented"
          role="tablist"
          aria-label={t('sidebar.segment.label') || '路径来源'}
          data-testid="sidebar-segmented"
        >
          <button
            type="button"
            role="tab"
            aria-selected={effectiveSegment === 'local'}
            className={`sidebar-segmented-item${effectiveSegment === 'local' ? ' active' : ''}`}
            onClick={() => setSegment('local')}
            data-testid="sidebar-segment-local"
          >
            {t('sidebar.segment.local') || '本地'}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={effectiveSegment === 'remote'}
            className={`sidebar-segmented-item${effectiveSegment === 'remote' ? ' active' : ''}`}
            onClick={() => setSegment('remote')}
            data-testid="sidebar-segment-remote"
          >
            {t('sidebar.segment.remote') || '远程'}
          </button>
        </div>
      )}
      <div className="sidebar-bookmarks-dropzone" data-segment={effectiveSegment}>
        <Category
          categoryId="bookmark"
          title={t('sidebar.category.bookmark')}
          iconName="bookmark"
          paths={bookmarksFiltered}
          collapsed={isCategoryCollapsed('bookmark')}
          onToggleCollapsed={handleToggleCategory}
          actionLabel={<Icon name="plus" size={12} />}
          actionTitle={t('sidebar.addBookmark.title')}
          onAction={() => void handleAddBookmark()}
        />
        <Category
          categoryId="temporary"
          title={t('sidebar.category.temporary')}
          iconName="clock"
          paths={temporaryFiltered}
          collapsed={isCategoryCollapsed('temporary')}
          onToggleCollapsed={handleToggleCategory}
          actionLabel={<Icon name="plus" size={12} />}
          actionTitle={t('sidebar.addTemporary.title')}
          onAction={() => void handlePickFolderForTemp()}
        />
        <Category
          categoryId="recent"
          title={t('sidebar.category.recent')}
          iconName="history"
          paths={recentFiltered}
          collapsed={isCategoryCollapsed('recent')}
          onToggleCollapsed={handleToggleCategory}
        />
      </div>
      <div className="sidebar-footer">
        <button
          type="button"
          className="settings-entry"
          onClick={() => dispatch({ type: 'view/enter-settings' })}
          title="设置"
        >
          <Icon name="settings" size={14} />
          <span>设置</span>
        </button>
      </div>
      {/*
        右侧 resize handle:绝对定位,4px 宽,贴右边。鼠标按下时 setIsResizing,
        全局 mousemove 计算新宽度。双击复位默认宽度。aria-hidden 因为只是视觉
        affordance,不进辅助技术导航树(用户操作纯靠鼠标拖)。
      */}
      <div
        className="sidebar-resize-handle"
        onMouseDown={handleResizeMouseDown}
        onDoubleClick={handleResizeDoubleClick}
        title="拖动调整宽度 (双击复位)"
        aria-hidden="true"
      />
    </aside>
  );
}

interface CategoryProps {
  categoryId: string;
  title: string;
  iconName: IconName;
  paths: PathNode[];
  emptyLabel?: string;
  collapsed: boolean;
  onToggleCollapsed: (categoryId: string) => void;
  /** affordance 内容 — 通常是 lucide icon (<Icon name="plus" .../>) */
  actionLabel?: ReactNode;
  actionTitle?: string;
  onAction?: () => void;
}

function Category({
  categoryId,
  title,
  iconName,
  paths,
  emptyLabel = '空',
  collapsed,
  onToggleCollapsed,
  actionLabel,
  actionTitle,
  onAction,
}: CategoryProps): JSX.Element {
  // BETA-014:同 category 内末级文件夹同名时自动补父目录区分;手动命名的不参与。
  const displayNames = useMemo(() => disambiguatePathNames(paths), [paths]);
  return (
    <section
      className={`sidebar-category${collapsed ? ' collapsed' : ''}`}
    >
      <header
        className="sidebar-category-header"
        onClick={() => onToggleCollapsed(categoryId)}
        title={collapsed ? '展开分组' : '折叠分组'}
      >
        <span className="sidebar-category-chevron" aria-hidden="true">
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </span>
        <span className="sidebar-category-title">
          <span className="sidebar-category-icon" aria-hidden="true">
            <Icon name={iconName} size={12} />
          </span>
          {title}
        </span>
        <span className="sidebar-category-count">{paths.length}</span>
        {actionLabel && (
          <button
            type="button"
            className="sidebar-category-action"
            onClick={(e) => {
              e.stopPropagation();
              onAction?.();
            }}
            title={actionTitle}
          >
            {actionLabel}
          </button>
        )}
      </header>
      {collapsed ? null : paths.length === 0 ? (
        <p className="sidebar-empty">{emptyLabel}</p>
      ) : (
        <ul className="sidebar-paths">
          {paths.map((p) => {
            const override = p.kind === 'ssh' ? undefined : displayNames.get(p.id);
            return (
              <PathItem
                key={p.id}
                node={p}
                {...(override !== undefined ? { displayNameOverride: override } : {})}
              />
            );
          })}
        </ul>
      )}
    </section>
  );
}

function PathItem({
  node,
  displayNameOverride,
}: {
  node: PathNode;
  displayNameOverride?: string;
}): JSX.Element {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const ctxMenu = useContextMenuApi();
  const toast = useToast();
  const expanded = state.expandedPathIds.has(node.id);
  const selected = state.selectedPathId === node.id;
  const sessions = useMemo(
    () => node.sessionIds.map((sid) => state.sessions.get(sid)).filter(Boolean) as SessionInfo[],
    [node.sessionIds, state.sessions],
  );
  const activeCount = sessions.length;
  // BETA-014:优先用 Category 算好的去重名;退到本节点 displayName / 末段
  const displayName =
    displayNameOverride ??
    node.displayName ??
    formatPathDisplayName(node);

  // M1-C:行内重命名 (仅收藏支持)
  const [renaming, setRenaming] = useState(false);
  const [renameText, setRenameText] = useState(displayName);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  const beginRename = (): void => {
    setRenameText(displayName);
    setRenaming(true);
    requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
  };

  const commitRename = (): void => {
    const v = renameText.trim();
    setRenaming(false);
    if (!v || v === displayName) return;
    window.api
      .invoke(COMMAND_CHANNELS.BOOKMARK_RENAME, {
        pathId: node.id,
        newDisplayName: v,
      })
      .catch((err: unknown) => {
        toast.push({
          kind: 'error',
          message: `重命名失败:${err instanceof Error ? err.message : String(err)}`,
        });
      });
  };

  const handleSelect = (): void => {
    if (renaming) return;
    dispatch({ type: 'view/select-path', pathId: node.id });
  };

  const handleToggleExpand = (e: MouseEvent<HTMLSpanElement>): void => {
    e.stopPropagation();
    dispatch({ type: 'view/toggle-path-expand', pathId: node.id });
  };

  const handleDoubleClick = async (): Promise<void> => {
    // 双击 = 在该 path 下用默认模板新建 session
    // 优先级:bookmark.defaultTemplateId > 全局 defaultTemplateId > 'shell' 兜底
    const templateId =
      node.defaultTemplateId ?? state.defaultTemplateId ?? 'shell';
    try {
      const dims = state.lastTerminalDims;
      const res = await window.api.invoke<unknown, CreateSessionResponse>(
          COMMAND_CHANNELS.SESSION_CREATE,
        {
          pathId: node.id,
          templateId,
          cols: dims.cols,
          rows: dims.rows,
        },
      );
      // 先切 path (会自动选 my-owned firstSid,但新创建的可能不是 firstSid),
      // 再显式 select 新创建的 session。两次 dispatch 在 React 18 自动 batch。
      dispatch({ type: 'view/select-path', pathId: node.id });
      dispatch({ type: 'view/select-session', sessionId: res.session.id });
      if (res.warning) {
        toast.push({ kind: 'warn', message: res.warning });
      }
    } catch (err) {
      // M1-K:不可达路径 / spawn 失败 → toast + (收藏路径) 提供"移除收藏"
      const msg = err instanceof Error ? err.message : String(err);
      toast.push({
        kind: 'error',
        message: `打开终端失败 (${node.path}):${msg}`,
        durationMs: 10000,
      });
    }
  };

  // M1-C:复制到剪贴板 — 抽到 useCopyToClipboard hook(P2-11),
  // Sidebar/MainPane/TerminalView 多处行为一致。
  const copyToClipboard = useCopyToClipboard();

  // M1-C:右键菜单 — 按分类组装条目
  const handleContextMenu = (e: MouseEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    const items: ContextMenuItem[] = [];

    // 通用项
    items.push({
      label: '复制路径',
      onSelect: () => copyToClipboard(node.path, '路径'),
    });
    if (node.kind !== 'ssh') {
      items.push({
        label: '在 Explorer 中显示',
        onSelect: () => {
          window.api
            .invoke(COMMAND_CHANNELS.SYSTEM_SHOW_IN_EXPLORER, { path: node.path })
            .catch((err: unknown) =>
              toast.push({
                kind: 'error',
                message: `打开 Explorer 失败:${err instanceof Error ? err.message : String(err)}`,
              }),
            );
        },
      });
    }

    if (node.category === 'bookmarked') {
      items.push({ divider: true, label: '' });
      items.push({ label: '重命名…', onSelect: beginRename });
      items.push({
        label: '移除收藏',
        danger: true,
        onSelect: () => {
          const removeBookmark = async (): Promise<void> => {
            await window.api.invoke(COMMAND_CHANNELS.BOOKMARK_REMOVE, { pathId: node.id });
            // 首页已经不单独展示"收藏"分组。无 session 的收藏被移除后,
            // PathManager 会按状态机放入 recent;对用户来说这看起来像"没删掉",
            // 需要再右键"从最近移除"一次。这里把这两个 UI 动作合成一次。
            if (node.sessionIds.length === 0) {
              await window.api.invoke(COMMAND_CHANNELS.PATH_REMOVE_FROM_RECENT, {
                path: node.id,
              });
            }
          };
          removeBookmark()
            .then(() =>
              toast.push({ kind: 'success', message: `已移除收藏 ${displayName}` }),
            )
            .catch((err: unknown) =>
              toast.push({
                kind: 'error',
                message: `移除失败:${err instanceof Error ? err.message : String(err)}`,
              }),
            );
        },
      });

      // 设默认模板(沿用 CP-4 既有逻辑)— 作为子菜单的扁平展开
      items.push({ divider: true, label: '' });
      for (const t of state.templates) {
        items.push({
          label: `${t.icon} 设默认模板:${t.name}`,
          hint: t.command ? `启动命令: ${t.command}` : '系统默认 shell',
          checked: t.id === node.defaultTemplateId,
          onSelect: () => {
            window.api
              .invoke(COMMAND_CHANNELS.BOOKMARK_SET_DEFAULT_TEMPLATE, {
                pathId: node.id,
                templateId: t.id,
              })
              .catch((err: unknown) =>
                toast.push({
                  kind: 'error',
                  message: `设置默认模板失败:${err instanceof Error ? err.message : String(err)}`,
                }),
              );
          },
        });
      }
    } else if (node.category === 'temporary' || node.category === 'recent') {
      items.push({ divider: true, label: '' });
      items.push({
        label: '加入收藏',
        onSelect: () => {
          window.api
            .invoke(
              node.kind === 'ssh'
                ? COMMAND_CHANNELS.REMOTE_BOOKMARK_ADD
                : COMMAND_CHANNELS.BOOKMARK_ADD,
              node.kind === 'ssh'
                ? {
                    sshProfileId: node.sshProfileId,
                    remotePath: node.path,
                    ...(node.displayName ? { displayName: node.displayName } : {}),
                  }
                : { path: node.path },
            )
            .then(() => toast.push({ kind: 'success', message: `已加入收藏 ${displayName}` }))
            .catch((err: unknown) =>
              toast.push({
                kind: 'error',
                message: `加入收藏失败:${err instanceof Error ? err.message : String(err)}`,
              }),
            );
        },
      });
      if (node.category === 'recent') {
        items.push({
          label: '从最近移除',
          danger: true,
          onSelect: () => {
            window.api
              .invoke(COMMAND_CHANNELS.PATH_REMOVE_FROM_RECENT, { path: node.id })
              .catch((err: unknown) =>
                toast.push({
                  kind: 'error',
                  message: `从最近移除失败:${err instanceof Error ? err.message : String(err)}`,
                }),
              );
          },
        });
      }
    }

    ctxMenu.open({
      x: e.clientX,
      y: e.clientY,
      title: displayName,
      items,
    });
  };

  return (
    <li className={`path-item${selected ? ' selected' : ''}${node.invalid ? ' invalid' : ''}`}>
      <div
        className="path-item-row"
        onClick={handleSelect}
        onDoubleClick={() => void handleDoubleClick()}
        onContextMenu={handleContextMenu}
        title={node.invalid ? `${node.path}\n⚠️ 路径不可访问` : node.path}
      >
        {/*
          F2(beta 勘误2):左侧固定 12px 槽位,按优先级选一个内容渲染 —
          展开箭头(有会话时)> 警告 icon(invalid 时)> 透明 placeholder。
          三种状态用同一个槽位,保证所有路径行的 name 文本起始 x 坐标一致,
          解决了 invalid 行 ⚠️ 把后续文字往右顶导致与其他行不对齐的问题。
          有会话且 invalid 的极少数情况(session 创建后路径被删):展开
          箭头优先,⚠️ 通过 title tooltip 提示。
        */}
        {sessions.length > 0 ? (
          <span
            className="path-expand-arrow"
            onClick={handleToggleExpand}
            aria-label={expanded ? '收起' : '展开'}
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
        ) : node.invalid ? (
          <span className="path-expand-arrow path-invalid-slot" aria-label="路径不可访问">
            <AlertTriangle size={12} className="path-invalid-icon" />
          </span>
        ) : (
          <span className="path-expand-arrow placeholder" />
        )}
        {renaming ? (
          <input
            ref={renameInputRef}
            type="text"
            className="path-name-rename-input"
            value={renameText}
            onChange={(e) => setRenameText(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitRename();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setRenaming(false);
              }
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="path-name">{displayName}</span>
        )}
        {activeCount > 0 && !renaming && (
          <span className="path-session-count" title={`${activeCount} 个终端`}>
            {activeCount}
          </span>
        )}
      </div>
      {expanded && sessions.length > 0 && (
        <ul className="session-list">
          {sessions.map((s) => (
            <SessionItem
              key={s.id}
              session={s}
              myWindowId={state.myWindowId}
              selected={state.selectedSessionId === s.id}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

interface SessionItemProps {
  session: SessionInfo;
  /** 父级传入 — 避免本组件订阅 state.myWindowId 触发无关重渲 */
  myWindowId: string;
  /** 父级传入 — 同上,避免订阅 state.selectedSessionId */
  selected: boolean;
}

/**
 * 抖动源 D 的破法:本组件**不**调 useAppState()。
 *
 * 通过 props 拿渲染需要的 myWindowId / selected;事件回调里通过
 * useAppStateRef 拿最新 state(templates / 其他 session 列表 等)。
 * 用 React.memo 包裹后,sessions/state-changed 仅会让"那个真正变化的
 * session"对应的 SessionItem 重渲,其余引用未变的 props 被 memo 跳过。
 */
function SessionItemImpl({
  session,
  myWindowId,
  selected,
}: SessionItemProps): JSX.Element {
  const dispatch = useAppDispatch();
  const ctxMenu = useContextMenuApi();
  const toast = useToast();
  const stateRef = useAppStateRef();
  const isMine = session.ownerWindowId === myWindowId;
  const ownedByOther =
    session.ownerWindowId !== null && session.ownerWindowId !== myWindowId;

  // M1-C:行内重命名
  const [renaming, setRenaming] = useState(false);
  const [renameText, setRenameText] = useState(session.displayName);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  const beginRename = (): void => {
    setRenameText(session.displayName);
    setRenaming(true);
    requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
  };
  const commitRename = (): void => {
    const v = renameText.trim();
    setRenaming(false);
    if (!v || v === session.displayName) return;
    window.api
      .invoke(COMMAND_CHANNELS.SESSION_RENAME, {
        sessionId: session.id,
        newDisplayName: v,
      })
      .catch((err: unknown) =>
        toast.push({
          kind: 'error',
          message: `重命名失败:${err instanceof Error ? err.message : String(err)}`,
        }),
      );
  };

  // 同 PathItem.copyToClipboard,统一走 useCopyToClipboard hook(P2-11)。
  const copyToClipboard = useCopyToClipboard();

  const handleContextMenu = (e: MouseEvent<HTMLLIElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    const variant: 'mine' | 'orphan' | 'other' = isMine
      ? 'mine'
      : ownedByOther
        ? 'other'
        : 'orphan';
    ctxMenu.open({
      x: e.clientX,
      y: e.clientY,
      title: session.displayName,
      items: buildSessionContextMenu(session, {
        variant,
        pathTree: stateRef.current.pathTree,
        copyToClipboard,
        toastError: (message) => toast.push({ kind: 'error', message }),
        // Sidebar 端走"行内编辑"重命名(Tab 端走 Modal.prompt)
        onRename: beginRename,
      }),
    });
  };

  const handleClick = (): void => {
    if (renaming) return;
    // 本窗口已是 owner → 仅切 view
    if (isMine) {
      dispatch({ type: 'view/select-path', pathId: session.pathId });
      dispatch({ type: 'view/select-session', sessionId: session.id });
      return;
    }
    // 其他窗口持有 → 聚焦那个窗口,所有权不变 (软件定义书 8.4)
    if (ownedByOther) {
      window.api
        .invoke(COMMAND_CHANNELS.SESSION_FOCUS_OWNER, {
          sessionId: session.id,
        })
        .catch((err) => console.error('[Sidebar] focus-owner failed', err));
      return;
    }
    // 无主 → 乐观接管 (与 Tab.handleClick orphan 分支同协议:本地立即
    // 改 owner + select,消除 EmptyPathState 闪烁;失败回滚)
    const prevOwnedId = findMyOwnedSessionId(stateRef.current);
    if (prevOwnedId && prevOwnedId !== session.id) {
      dispatch({
        type: 'sessions/owner-changed',
        sessionId: prevOwnedId,
        ownerWindowId: null,
      });
    }
    dispatch({
      type: 'sessions/owner-changed',
      sessionId: session.id,
      ownerWindowId: myWindowId,
    });
    dispatch({ type: 'view/select-path', pathId: session.pathId });
    dispatch({ type: 'view/select-session', sessionId: session.id });

    window.api
      .invoke(COMMAND_CHANNELS.SESSION_CLAIM, { sessionId: session.id })
      .catch((err) => {
        console.error('[Sidebar] claim failed, rolling back', err);
        dispatch({
          type: 'sessions/owner-changed',
          sessionId: session.id,
          ownerWindowId: null,
        });
        if (prevOwnedId && prevOwnedId !== session.id) {
          dispatch({
            type: 'sessions/owner-changed',
            sessionId: prevOwnedId,
            ownerWindowId: myWindowId,
          });
        }
        dispatch({ type: 'view/select-session', sessionId: prevOwnedId });
      });
  };

  // ADR-008:currentCwd 与 originalCwd 不一致时显示 ⚠️ tooltip 真实 cwd。
  // session.pathId 永久不变,所以不会在 UI 上"跳" path,只是这个标志告诉用户
  // session 内 cd 走了。
  const cwdDrifted =
    !!session.currentCwd &&
    !!session.originalCwd &&
    !samePath(session.currentCwd, session.originalCwd);

  const baseTitle = ownedByOther
    ? `${session.displayName} (在其他窗口,点击聚焦那个窗口)`
    : session.displayName;
  const fullTitle = cwdDrifted
    ? `${baseTitle}\n当前目录已变 → ${session.currentCwd}\n(原: ${session.originalCwd})`
    : baseTitle;

  return (
    <li
      className={`session-item${selected ? ' selected' : ''}${
        ownedByOther ? ' owned-by-other' : ''
      }${session.state === 'exited' ? ' exited' : ''}`}
      onClick={() => void handleClick()}
      onContextMenu={handleContextMenu}
      title={fullTitle}
    >
      <span
        className="session-state-dot"
        style={{ backgroundColor: STATE_DOT_COLOR[session.state] }}
        aria-label={`状态: ${session.state}`}
      >
        {session.state === 'exited' && session.exitCode === 0 && (
          <Check size={9} className="session-state-dot-icon ok" />
        )}
        {session.state === 'exited' &&
          typeof session.exitCode === 'number' &&
          session.exitCode !== 0 && (
            <X size={9} className="session-state-dot-icon fail" />
          )}
      </span>
      {renaming ? (
        <input
          ref={renameInputRef}
          type="text"
          className="session-name-rename-input"
          value={renameText}
          onChange={(e) => setRenameText(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitRename();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setRenaming(false);
            }
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="session-name">{session.displayName}</span>
      )}
      {cwdDrifted && !renaming && (
        <span className="session-cwd-drift" aria-label="当前目录已变" title={session.currentCwd}>
          <Icon name="alertTriangle" size={11} />
        </span>
      )}
      {session.state === 'exited' && !renaming && (
        <span
          className="session-exit-code"
          title={`已退出 (exitCode=${session.exitCode ?? 0})`}
        >
          <Icon name="circleDot" size={11} />
        </span>
      )}
      {ownedByOther && !renaming && (
        <span className="session-owned-by-other" title="在其他窗口持有">
          <Icon name="externalLink" size={11} />
        </span>
      )}
    </li>
  );
}

/**
 * React.memo 包裹 SessionItem — 仅当 session 引用 / myWindowId / selected
 * 任一变化时才重渲。
 *
 * 关键前提:reducer 在 sessions/state-changed 时做的是 `new Map(state.sessions)`
 * + `sessions.set(id, merged)`,**只换那个变化的 session 的引用**,其它
 * session 引用保持不变 — 默认浅比较即可正确跳过无关项重渲。
 */
const SessionItem = memo(SessionItemImpl);

/**
 * 比较两个路径是否指向同一目录。Windows 大小写无关,POSIX 大小写敏感。
 * 不做 normalize (currentCwd / originalCwd 进入 SessionInfo 之前已经 path.resolve 过)。
 */
function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  // Windows 上 C:\Foo 和 c:\foo 指同一目录。SessionManager 已经把卷符大写,
  // 但 OSC 报告的 cwd 卷符大小写可能不一致,这里再松一层。
  return a.toLowerCase() === b.toLowerCase();
}

function formatPathDisplayName(node: PathNode): string {
  const leaf = lastSegmentOf(node.path);
  return leaf;
}

function lastSegmentOf(path: string): string {
  // 跨平台:取 / 或 \ 分隔的最后一段;空字符串 / 根路径回退到原路径
  const m = path.match(/[^/\\]+$/);
  return m ? m[0] : path;
}
