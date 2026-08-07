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
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Pencil,
  Trash2,
  X,
} from 'lucide-react';
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  useDroppable,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import {
  COMMAND_CHANNELS,
  type AddBookmarkResponse,
  type CreateSessionResponse,
  type PickFolderResponse,
} from '@shared/protocol';
import type { GroupNode, PathNode, SessionInfo, SshProfile, Template } from '@shared/types';
import { disambiguatePathNames } from '@shared/path-display';
import { hasAnyRemote } from '@shared/remote-visibility';
import { makeSshPathId } from '@shared/remote-path';
import {
  BOOKMARK_ROOT_GROUP_CONTAINER,
  BOOKMARK_UNGROUPED_CONTAINER,
  bookmarkPathIdsForContainer,
  bookmarkSubgroupContainerId,
  isDescendantGroupInLayout,
  moveBookmarkGroupToPlacement,
  moveBookmarkInLayout,
  moveBookmarkToPlacement,
  parentGroupId,
  visibleBookmarkSlotToFullIndex,
  type BookmarkGroupOrder,
  type BookmarkOrderLayout,
  type BookmarkPlacement,
} from '@shared/bookmark-dnd-layout';
import { useTranslation } from './LanguageProvider';
import {
  findMyOwnedSessionId,
  findPathNode,
  useAppDispatch,
  useAppState,
  useAppStateRef,
} from '../store';
import { Icon, type IconName } from './icons';
import { useContextMenuApi, type ContextMenuItem } from './ContextMenu';
import { useModal } from './Modal';
import { useToast } from './Toast';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import { usePanelPreference } from '../hooks/usePanelPreference';
import { claimSession } from '../hooks/claim-gate';
import { buildSessionContextMenu } from './sessionContextMenu';
import { closeSessionWithContinue } from '../hooks/useCloseSession';
import { SkillInstallDialog } from './SkillInstallDialog';
import { TemplateIcon } from './TemplateIcon';
import { BackendDirectoryPicker } from './BackendDirectoryPicker';
import { SshConnectionDialog } from './SshConnectionDialog';

/**
 * 状态点颜色 (软件定义书 6.2.4 状态指示):
 * - active 🟢:近期有 PTY 输出
 * - idle  🟡:活着但 N 秒无输出
 * - exited ⚫:进程已退出 (ADR-008 取代旧 'tombstoned')
 *
 * 用 CSS variables 走主题切换 (CP-4 接通);#f0f fallback 是 stylelint 兜底
 * 防止变量缺失渲染成黑色 (软件定义书 5.1.9)。
 *
 * v0.3.3 Feature E.3(决策 #16):状态色从 JS 内联 style (旧 STATE_DOT_COLOR)
 * 改为 CSS class 驱动(.session-state-bar[data-state=...]),让 @keyframes 呼吸
 * 与 prefers-reduced-motion 能生效。色值仍走主题 CSS variables。
 */

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
interface BackendDirectoryPickerIntent {
  kind: 'bookmark' | 'temporary';
  /** bookmark 从分组菜单发起时，选择结果原子地直接进入该组。 */
  groupId?: string;
}
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
  const ctxMenu = useContextMenuApi();
  const { t } = useTranslation();
  const [dragOver, setDragOver] = useState(false);
  const [directoryPickerIntent, setDirectoryPickerIntent] =
    useState<BackendDirectoryPickerIntent | null>(null);
  const [sshConnectionDialogOpen, setSshConnectionDialogOpen] = useState(false);

  // v1.14(方案-远程UI统一 §III.2):segmented 远程 tab 顶部的「Marina 电脑」区段。
  // 数据源 = state.remoteBackendProfiles —— store 已保证它在任何窗口(含远程窗口)
  // 都是客户端本机保存的电脑列表(snapshot/load 前用 REMOTE_PROFILE_LIST 覆盖,
  // 之后由本地 REMOTE_PROFILES_UPDATED 事件持续同步,见 store.tsx snapshot 处理)。
  const localProfiles = state.remoteBackendProfiles;
  const openRemoteWindow = async (profileId: string): Promise<void> => {
    try {
      // WINDOW_CREATE 是 local-control,远程窗口里也由客户端本地 main 创建新窗口。
      await window.api.invoke(COMMAND_CHANNELS.WINDOW_CREATE, { backendProfileId: profileId });
    } catch (err) {
      toast.push({
        kind: 'error',
        message: `打开远程窗口失败:${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };
  const [collapsedCategoryIds, setCollapsedCategoryIds] = useState<Set<string>>(() => new Set());
  const [segment, setSegmentState] = useState<SidebarSegment>(() =>
    // 远程窗口(连 daemon)默认选中「当前电脑」段,而非沿用 localStorage 的 segment ——
    // 远程窗口的主用途是操作所连 daemon 的路径/终端,默认跳到 SSH 段不符合预期。
    // 用户仍可手动切到 SSH 段(切后照常落盘 localStorage)。
    window.api.backendProfileId ? 'local' : readSegmentFromStorage(),
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
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => readSidebarWidthFromStorage());
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
  const hasDaemonProfiles = state.remoteBackendProfiles.length > 0;
  const daemonRunning = state.remoteDaemonStatus?.running === true;
  /**
   * 本地不变式的核心:v1.14 起显示条件统一走 hasAnyRemote(SSH profile /
   * 远程电脑 / enableRemote / daemon 运行 任一为真),不再各自写条件。
   * 全 false 时 segmented control 整体不渲染,segment 强制视为 'local',
   * sidebar 跟 beta.9 完全一致。
   */
  const showSegmented = hasAnyRemote({
    hasSshProfiles,
    hasDaemonProfiles,
    enableRemote,
    daemonRunning,
  });
  const effectiveSegment: SidebarSegment = showSegmented ? segment : 'local';
  const isRemoteBackendWindow = window.api.backendProfileId !== null;
  // 用户裁决 1A:当前电脑段在远程 backend 窗口显示 daemon 的名字（如 FEX），
  // 本地窗口显示「当前电脑」。名字来自客户端保存的电脑 profile（store 保证
  // 任何窗口都持有客户端本机列表）。
  const currentComputerLabel = isRemoteBackendWindow
    ? localProfiles.find((p) => p.id === window.api.backendProfileId)?.displayName
    : undefined;
  // 用户裁决 3A:OS 文件夹拖入只在「客户端本机 backend + 当前电脑段」可用。
  const dropEnabled = !isRemoteBackendWindow && effectiveSegment === 'local';
  const selectedBackendPath = state.selectedPathId
    ? findPathNode(state.pathTree, state.selectedPathId)
    : undefined;
  const directoryPickerInitialPath =
    selectedBackendPath?.kind === 'local' ? selectedBackendPath.path : undefined;

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
  // v0.3.3 ADR-025:收藏分组(虚拟节点)不分本地/远程 —— 分组是跨 segment 的组织容器,
  // 只有里面的 path 按 segment 过滤。故 groups 直接取全集。
  const groupsFiltered = useMemo(() => state.pathTree.groups ?? [], [state.pathTree.groups]);
  // 收藏去重名(Category 内部算的那套提到外面,BookmarkCategory 复用)。
  const bookmarkDisplayNames = useMemo(
    () => disambiguatePathNames(bookmarksFiltered),
    [bookmarksFiltered],
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

  const isCategoryCollapsed = (categoryId: string): boolean => collapsedCategoryIds.has(categoryId);

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
   * 新建收藏分组(嵌套版)。
   *
   * 入口:收藏分类的 ⋯/右键菜单(顶层)与分组右键菜单(新建子组)。仍使用
   * 项目自绘 Modal；Electron renderer 中原生 window.prompt 会直接返回 null。
   */
  const addGroupPrompt = async (parentId?: string): Promise<void> => {
    const name = await modal.prompt({
      title: parentId
        ? t('sidebar.group.addSub') || '新建子组'
        : t('sidebar.group.add') || '新建分组',
      message: parentId ? '输入子组名称' : '输入分组名称',
      placeholder: parentId ? '子组名' : '分组名',
      confirmLabel: '新建',
    });
    if (!name?.trim()) return;
    try {
      await window.api.invoke(COMMAND_CHANNELS.BOOKMARK_GROUP_ADD, {
        name: name.trim(),
        ...(parentId ? { parentId } : {}),
      });
    } catch (err) {
      toast.push({
        kind: 'error',
        message: `新建分组失败:${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  /** 收藏分类的「新建分组」菜单（⋯ 按钮与右键共用）。 */
  const openAddGroupContextMenu = (e: MouseEvent<HTMLElement>, title: string): void => {
    e.preventDefault();
    e.stopPropagation();
    ctxMenu.open({
      x: e.clientX,
      y: e.clientY,
      title,
      items: [
        {
          label: t('sidebar.group.add') || '新建分组',
          icon: <FolderInput size={13} />,
          onSelect: () => void addGroupPrompt(),
        },
      ],
    });
  };

  /**
   * 收藏栏 "+" 按钮。按当前 segment 走不同流程（用户裁决 2A：不手输路径）：
   *
   * - 当前电脑段：beta.9 行为 — 系统 folder picker → BOOKMARK_ADD；
   *   远程 backend 窗口则用 renderer 自绘的点击式 backend 目录选择器。
   * - SSH 段：打开统一连接面板；0/1/N profile 都可选择已有或就地新建，
   *   新建后立即从 profile 默认目录启动 session，不跳设置页。
   */
  const handleAddBookmark = async (
    _event?: React.MouseEvent<HTMLButtonElement>,
    groupId?: string,
  ): Promise<void> => {
    if (effectiveSegment === 'remote') {
      if (groupId) {
        toast.push({
          kind: 'warn',
          message: 'SSH 远端目录浏览尚不可用；不能用文本路径替代选择器',
        });
        return;
      }
      setSshConnectionDialogOpen(true);
      return;
    }
    // 远程 backend 的“当前电脑段”指 daemon 文件系统。不能把 native dialog
    // 命令发给 daemon；改用 renderer 自绘、backend-data 驱动的点击式选择器。
    if (isRemoteBackendWindow) {
      setDirectoryPickerIntent({ kind: 'bookmark', ...(groupId ? { groupId } : {}) });
      return;
    }
    // 真正的本地窗口保留 beta.9 native folder picker；groupId 与 path 在一个
    // BOOKMARK_ADD 中提交，避免先闪到未分组再 reorder 的半完成状态。
    try {
      const result = await window.api.invoke<unknown, PickFolderResponse>(
        COMMAND_CHANNELS.BOOKMARK_PICK_FOLDER,
        {},
      );
      if (result.path === null) return;
      await window.api.invoke<unknown, AddBookmarkResponse>(COMMAND_CHANNELS.BOOKMARK_ADD, {
        path: result.path,
        ...(groupId ? { groupId } : {}),
      });
    } catch (err) {
      toast.push({
        kind: 'error',
        message: `添加文件夹失败:${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  /** 在指定 backend 绝对路径创建默认模板 session，并立即选中。 */
  const createSessionAtPath = async (path: string): Promise<void> => {
    const templateId = state.defaultTemplateId ?? 'shell';
    const dims = state.lastTerminalDims;
    const res = await window.api.invoke<unknown, CreateSessionResponse>(
      COMMAND_CHANNELS.SESSION_CREATE,
      {
        pathId: path,
        templateId,
        cols: dims.cols,
        rows: dims.rows,
      },
    );
    // session 创建后:乐观 dispatch sessions/created 立即写入 state + 选中它。
    dispatch({ type: 'sessions/created', session: res.session });
    if (res.warning) toast.push({ kind: 'warn', message: res.warning });
  };

  /**
   * SSH 段 "+"（收藏 + 临时共用）：无论 0/1/N 个 profile 都打开统一连接面板。
   * profile 数量不再暗中改变交互；“新建 SSH 连接”始终可见。
   */
  const openSshConnectionMenu = (): void => setSshConnectionDialogOpen(true);

  /** 从 profile 的默认远端目录（回退 home）开 session；错误交给表单就地展示。 */
  const connectSshSession = async (profile: SshProfile): Promise<void> => {
    const pathId = makeSshPathId(profile.id, profile.defaultRemoteCwd ?? '~');
    await createSessionAtPath(pathId);
  };

  /**
   * 临时栏 "+" 按钮：当前电脑段 = native picker（远程 backend 窗口用点击式
   * 选择器）；SSH 段 = 连接 SSH（与收藏 + 同一任务）。选完后共创建 session。
   */
  const handlePickFolderForTemp = async (
    _event?: React.MouseEvent<HTMLButtonElement>,
  ): Promise<void> => {
    if (effectiveSegment === 'remote') {
      openSshConnectionMenu();
      return;
    }
    if (isRemoteBackendWindow) {
      setDirectoryPickerIntent({ kind: 'temporary' });
      return;
    }
    try {
      const result = await window.api.invoke<unknown, PickFolderResponse>(
        COMMAND_CHANNELS.BOOKMARK_PICK_FOLDER,
        {},
      );
      if (result.path === null) return;
      await createSessionAtPath(result.path);
    } catch (err) {
      toast.push({
        kind: 'error',
        message: `打开文件夹失败:${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  /** 文件夹选择器完成后按打开意图调用 backend 命令；选择器先关闭以归还焦点。 */
  const handleBackendDirectorySelected = async (path: string): Promise<void> => {
    const intent = directoryPickerIntent;
    setDirectoryPickerIntent(null);
    if (!intent) return;
    try {
      if (intent.kind === 'bookmark') {
        await window.api.invoke<unknown, AddBookmarkResponse>(COMMAND_CHANNELS.BOOKMARK_ADD, {
          path,
          ...(intent.groupId ? { groupId: intent.groupId } : {}),
        });
      } else {
        await createSessionAtPath(path);
      }
    } catch (err) {
      toast.push({
        kind: 'error',
        message: `${intent.kind === 'bookmark' ? '添加文件夹' : '打开文件夹'}失败:${
          err instanceof Error ? err.message : String(err)
        }`,
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
    // 用户裁决 3A:OS 文件夹拖入只在「客户端本机 backend + 当前电脑段」可用。
    if (!isFileDrag(e) || !dropEnabled) return;
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
    if (!dropEnabled) {
      toast.push({
        kind: 'warn',
        message: isRemoteBackendWindow
          ? '远程窗口不支持从文件管理器拖入，请到远程电脑上用「+」选择文件夹'
          : 'SSH 段不支持拖入本地文件夹，请切回「当前电脑」段或用「+」添加',
      });
      return;
    }
    const files = Array.from(e.dataTransfer.files);
    for (const file of files) {
      // file.path 是 Electron 提供的扩展属性 (浏览器标准 File API 没有),
      // V1 我们假定 sandbox: false + nodeIntegration: false + contextIsolation: true
      // 也就是 webPreferences 默认提供 file.path
      const path = (file as File & { path?: string }).path;
      if (!path) continue;
      try {
        await window.api.invoke<unknown, AddBookmarkResponse>(COMMAND_CHANNELS.BOOKMARK_ADD, {
          path,
        });
      } catch (err) {
        console.error('[Sidebar] drop add-bookmark failed', err);
      }
    }
  };

  return (
    <aside
      className={`sidebar${dragOver ? ' drag-over' : ''}`}
      data-drop-zone={dropEnabled ? 'files' : undefined}
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
          aria-label={t('sidebar.segment.label') || '当前电脑 / 远程'}
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
            {currentComputerLabel ?? t('sidebar.segment.local') ?? '当前电脑'}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={effectiveSegment === 'remote'}
            className={`sidebar-segmented-item${effectiveSegment === 'remote' ? ' active' : ''}`}
            onClick={() => setSegment('remote')}
            data-testid="sidebar-segment-remote"
          >
            {t('sidebar.segment.remote') ?? '远程'}
          </button>
        </div>
      )}
      {effectiveSegment === 'remote' && (
        <section className="sidebar-computers">
          <header className="sidebar-computers-header">
            <span className="sidebar-category-icon" aria-hidden="true">
              <Icon name="server" size={12} />
            </span>
            {t('sidebar.computers.title') || 'Marina 电脑'}
          </header>
          {localProfiles.length === 0 ? (
            <p className="sidebar-computers-empty">
              {t('sidebar.computers.empty') || '去 设置 → 远程 添加'}
            </p>
          ) : (
            <ul className="sidebar-computers-list">
              {localProfiles.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className="sidebar-computer-item"
                    disabled={!p.hasToken}
                    title={
                      p.hasToken
                        ? `${p.displayName} (${p.host}) — ${t('sidebar.computers.openTitle') || '在新窗口打开'}`
                        : `${p.displayName} (${p.host}) — ${t('sidebar.computers.noTokenTitle') || '未设密码,去 设置 → 远程 填写'}`
                    }
                    onClick={() => void openRemoteWindow(p.id)}
                  >
                    <Icon name="server" size={12} />
                    <span className="sidebar-computer-name">{p.displayName}</span>
                    <span className="sidebar-computer-host">{p.host}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <div className="sidebar-bookmarks-dropzone" data-segment={effectiveSegment}>
        <BookmarkCategory
          paths={bookmarksFiltered}
          allPaths={state.pathTree.bookmarks}
          groups={groupsFiltered}
          collapsed={isCategoryCollapsed('bookmark')}
          onToggleCollapsed={() => handleToggleCategory('bookmark')}
          onContextMenu={(e) =>
            openAddGroupContextMenu(e, t('sidebar.category.bookmark') || '收藏')
          }
          onRequestAddSubgroup={(parentId) => void addGroupPrompt(parentId)}
          onRequestAddFolder={(groupId) => void handleAddBookmark(undefined, groupId)}
          {...(effectiveSegment === 'remote'
            ? { addFolderDisabledReason: 'SSH 远端目录浏览尚不可用；不会退化为手输路径' }
            : {})}
          actionLabel={<Icon name="plus" size={12} />}
          actionTitle={t('sidebar.addBookmark.title')}
          onAction={(e) => void handleAddBookmark(e)}
          displayNames={bookmarkDisplayNames}
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
          onAction={(e) => void handlePickFolderForTemp(e)}
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
      {directoryPickerIntent && (
        <BackendDirectoryPicker
          title={
            directoryPickerIntent.kind === 'bookmark'
              ? '收藏远程电脑上的文件夹'
              : '在远程电脑上打开终端'
          }
          confirmLabel={directoryPickerIntent.kind === 'bookmark' ? '加入收藏' : '打开终端'}
          {...(directoryPickerInitialPath ? { initialPath: directoryPickerInitialPath } : {})}
          onCancel={() => setDirectoryPickerIntent(null)}
          onSelect={(path) => void handleBackendDirectorySelected(path)}
        />
      )}
      {sshConnectionDialogOpen && (
        <SshConnectionDialog
          profiles={state.sshProfiles}
          onCancel={() => setSshConnectionDialogOpen(false)}
          onConnect={async (profile) => {
            await connectSshSession(profile);
            setSshConnectionDialogOpen(false);
          }}
        />
      )}
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
  /** 根级分类右键菜单（v0.3.3：仅收藏提供“新建分组”）。 */
  onContextMenu?: (e: MouseEvent<HTMLElement>) => void;
  /** affordance 内容 — 通常是 lucide icon (<Icon name="plus" .../>) */
  actionLabel?: ReactNode;
  actionTitle?: string;
  /** 事件带出,供调用方定位弹层锚点(如远程段选服务器菜单) */
  onAction?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

function Category({
  categoryId,
  title,
  iconName,
  paths,
  emptyLabel = '空',
  collapsed,
  onToggleCollapsed,
  onContextMenu,
  actionLabel,
  actionTitle,
  onAction,
}: CategoryProps): JSX.Element {
  // BETA-014:同 category 内末级文件夹同名时自动补父目录区分;手动命名的不参与。
  const displayNames = useMemo(() => disambiguatePathNames(paths), [paths]);
  return (
    <section className={`sidebar-category${collapsed ? ' collapsed' : ''}`}>
      <header
        className="sidebar-category-header"
        onClick={() => onToggleCollapsed(categoryId)}
        onContextMenu={onContextMenu}
        title={collapsed ? `展开${title}` : `折叠${title}`}
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
              onAction?.(e);
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

// ═══════════════════════════════════════════════════════════════════╗
// ║  v0.3.3 ADR-025 / Feature E.1+E.2:收藏分组渲染 + @dnd-kit 拖序       ║
// ║  用户裁决(2026-08-04):分组可递归嵌套;组动作只保留右键;             ║
// ║  F2 重命名、Delete 解散(组头焦点内)                                ║
// ╚══════════════════════════════════════════════════════════════════╝
// 设计:
// - 收藏栏(Category=bookmark)用 BookmarkCategory 替换原平铺渲染:
//   未分组块(隐式,顶置)+ 分组森林(GroupBlock 递归渲染组头与子组)。
// - 分组折叠态走 L2 偏好 usePanelPreference(附录 G.1),不裸 localStorage。
// - 拖序走 @dnd-kit 多容器:未分组 + 各组各为 SortableContext(共享 DndContext),
//   拖动跨容器=移组,拖动同容器=组内排序;拖完发分层 BOOKMARK_REORDER。
// - group/path/session 各自只碰撞真实 container 的 0..N insertion slot；
//   slot 命中后膨胀为等高 placeholder。组标题是“追加到组内”的大目标。
// - 最终层级/顺序只来自 targetContainerId + targetIndex；自身/后代 slot 禁用。
// - 临时/最近栏不受影响(决策 #13:只收藏可分组/可拖序)。
// - 排序能力直接内联进 PathItem 的 <li>(传 sortableId 才启用),避免额外的
//   包裹 <li> 造成 li 嵌套(无效 HTML)。临时/最近不传 → 零 dnd 开销。
const UNGROUPED_CONTAINER = BOOKMARK_UNGROUPED_CONTAINER;
/** 组 draggable id 前缀(避免与 pathId / 容器 id 冲突)。 */
const GROUP_ID_PREFIX = 'bookmark-group:';
const GROUP_DROP_ID_PREFIX = 'bookmark-group-drop:';
/** 容器型 droppable id 前缀（v2 提示线模型：容器本身是唯一落点）。 */
const PATH_LIST_DROP_ID_PREFIX = 'bookmark-path-list:';
const GROUP_LIST_DROP_ID_PREFIX = 'bookmark-group-list:';
/** 递归 DOM 每层只加一次该缩进；最终层级只由真实容器决定。 */
const GROUP_TREE_INDENT_PX = 12;
/** 提示线错容器留出的右侧内边距（px），避免提示线贴到 scrollbar。 */
const DROP_INDICATOR_RIGHT_PAD_PX = 14;
/** 取路径最后一段作为显示名（跨平台、兼容 /与\\）。 */
function basename(p: string | undefined): string {
  if (!p) return '';
  const segs = p.split(/[\\/]/);
  return segs[segs.length - 1] || p;
}
/** 反解 subgroup 容器 id（__marina_subgroups__:<encodeURIComponent gid>）为 gid；失败返回 null。
 *  前缀需与 bookmark-dnd-layout.ts 的 BOOKMARK_SUBGROUP_CONTAINER_PREFIX 一致。 */
function decodeSubgroupId(containerId: string): string | null {
  const prefix = '__marina_subgroups__:';
  if (!containerId.startsWith(prefix)) return null;
  try {
    return decodeURIComponent(containerId.slice(prefix.length));
  } catch {
    return null;
  }
}
/** 根据层级深度计算提示线左侧缩进（与行缩进对齐）。 */
function indentForDepth(depth: number): number {
  return 8 + Math.max(0, depth) * GROUP_TREE_INDENT_PX;
}

/**
 * 分组头:折叠/展开、组名、右键菜单。
 *
 * 用户裁决(2026-08-04):删除重复 ⋯，组动作只放右键菜单。
 * 菜单:添加文件夹到该组 / 新建子组 / 重命名 / 解散。组头获得焦点时:F2 = 重命名,
 * Delete = 解散分组(路径与子组提升到上级,绝不删数据)。
 * 折叠态走 usePanelPreference(panelId='sidebar', key='groupCollapsed', 默认空 Set)。
 */
function GroupHeader({
  group,
  collapsed,
  depth,
  index,
  parentContainerId,
  onToggleCollapse,
  onRequestAddSubgroup,
  onRequestAddFolder,
  addFolderDisabledReason,
  dragHandle,
  dropTarget,
}: {
  group: GroupNode;
  collapsed: boolean;
  depth: number;
  index: number;
  parentContainerId: string;
  onToggleCollapse: () => void;
  onRequestAddSubgroup: () => void;
  onRequestAddFolder: () => void;
  addFolderDisabledReason?: string;
  dragHandle: Pick<
    ReturnType<typeof useSortable>,
    'setActivatorNodeRef' | 'attributes' | 'listeners'
  >;
  dropTarget: Pick<ReturnType<typeof useDroppable>, 'setNodeRef'>;
}): JSX.Element {
  const { t } = useTranslation();
  const toast = useToast();
  const ctxMenu = useContextMenuApi();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(group.name);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const beginRename = (): void => {
    setName(group.name);
    setRenaming(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  };

  const commitRename = (): void => {
    const v = name.trim();
    setRenaming(false);
    if (!v || v === group.name) return;
    window.api
      .invoke(COMMAND_CHANNELS.BOOKMARK_GROUP_RENAME, { id: group.id, name: v })
      .catch((err: unknown) => {
        toast.push({
          kind: 'error',
          message: `重命名分组失败:${err instanceof Error ? err.message : String(err)}`,
        });
      });
  };

  /** 解散分组:路径与子组提升到上级,绝不删数据。后端已保证;这里给 toast 反馈。 */
  const handleDissolve = (): void => {
    window.api
      .invoke(COMMAND_CHANNELS.BOOKMARK_GROUP_REMOVE, { id: group.id })
      .then(() =>
        toast.push({
          kind: 'success',
          message: `已解散分组「${group.name}」，路径与子组已移至上级，未删除任何数据`,
        }),
      )
      .catch((err: unknown) => {
        toast.push({
          kind: 'error',
          message: `解散分组失败:${err instanceof Error ? err.message : String(err)}`,
        });
      });
  };

  const openGroupMenu = (x: number, y: number): void => {
    ctxMenu.open({
      x,
      y,
      title: group.name,
      items: [
        {
          label: `添加文件夹到「${group.name}」…`,
          icon: <FolderInput size={13} />,
          disabled: !!addFolderDisabledReason,
          ...(addFolderDisabledReason ? { hint: addFolderDisabledReason } : {}),
          onSelect: onRequestAddFolder,
        },
        {
          label: t('sidebar.group.addSub') || '新建子组',
          icon: <FolderPlus size={13} />,
          onSelect: onRequestAddSubgroup,
        },
        { divider: true, label: '' },
        {
          label: t('sidebar.group.rename') || '重命名',
          icon: <Pencil size={13} />,
          onSelect: beginRename,
        },
        {
          label: t('sidebar.group.dissolve') || '解散分组',
          icon: <Trash2 size={13} />,
          danger: true,
          hint: '路径与子组移至上级，不删除数据',
          onSelect: handleDissolve,
        },
      ],
    });
  };

  const handleContextMenu = (e: MouseEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    openGroupMenu(e.clientX, e.clientY);
  };

  /** F2/Delete 只在组头自身聚焦时生效;重命名输入框内的按键不触发。 */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'F2') {
      e.preventDefault();
      beginRename();
    } else if (e.key === 'Delete') {
      e.preventDefault();
      handleDissolve();
    }
  };

  const setHeaderRef = (node: HTMLDivElement | null): void => {
    dragHandle.setActivatorNodeRef(node);
    dropTarget.setNodeRef(node);
  };

  return (
    <div
      ref={setHeaderRef}
      className="sidebar-group-header"
      {...dragHandle.attributes}
      {...(dragHandle.listeners ?? {})}
      onClick={onToggleCollapse}
      onContextMenu={handleContextMenu}
      onKeyDown={handleKeyDown}
      title={`${collapsed ? `展开${group.name}` : `折叠${group.name}`}；拖动整行调整位置与层级`}
      data-bookmark-group-id={group.id}
      data-group-depth={depth}
      data-group-index={index}
      data-group-parent-container={parentContainerId}
    >
      <span className="sidebar-group-chevron" aria-hidden="true">
        {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
      </span>
      {renaming ? (
        <input
          ref={inputRef}
          type="text"
          className="sidebar-group-rename-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitRename}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitRename();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setRenaming(false);
            }
          }}
        />
      ) : (
        <span className="sidebar-group-name" title={group.name}>
          <Icon name="group" size={12} />
          {group.name}
        </span>
      )}
    </div>
  );
}

/**
 * 拖拽过程唯一真值：当前 pointer 命中的容器 + 插入索引，以及一条用于渲染的
 * 绝对定位提示线几何。设计见 docs/plans/sidebar-interaction-redesign-rationale-20260804.md
 * 的「不改变高度的提示线」模型。
 *
 * 关键不变量：拖动期间列表里**不渲染任何占位 placeholder**，所有可见行的高
 * 度与位置恒定不变。因此每个行的 getBoundingClientRect 在整个拖动过程中是
 * 稳定的，碰撞检测按行中点单调递推，绝不会出现「向下拖反而落点向上」。
 * 提示线是一条 position:absolute 的水平线，用 top/left/width 表达
 * 「插到哪一行之间」(y) 与「哪一层缩进」(x→容器深度)，本身不占布局高度。
 */
interface DropIndicatorGeometry {
  /** 相对提示线锚容器的纵坐标 (px)。 */
  top: number;
  /** 左侧缩进 (px)，编码层级深度。 */
  left: number;
  /** 提示线宽度 (px)；越深越短。 */
  width: number;
}

interface BookmarkDragState {
  activeType?: string | undefined;
  activeId?: string | undefined;
  overId?: string | undefined;
  placement?: BookmarkPlacement | undefined;
  targetLabel?: string | undefined;
  indicator?: DropIndicatorGeometry | undefined;
}

/**
 * 在一个容器的直接子行里，按指针 y 推导插入索引与提示线 top。
 *
 * 算法：依次取每个子行的中点，指针 y 越过几个中点就插入到第几位。所有子行
 * 在拖动期间高度恒定（源行留在原位、DragOverlay 为 portal，不挤占布局），
 * 因此中点序列稳定且单调，指针向下移 → 索引只增不减。
 *
 * @param container 列表容器元素（如 <ul> 或 group-list div）。
 * @param pointerY 指针 / 跟手行纵向中点（viewport 坐标）。
 * @param srcId 被拖项 id；其对应子行不参与计数但仍占位（保持高度）。可选。
 * @param idAttr 子行上携带 id 的 data-属性名（如 'pathId' / 'bookmarkGroupId'）。
 * @returns 插入索引（0..有效子行数）；以及提示线 top（相对 container）。
 */
function computeInsertionAtY(
  container: HTMLElement,
  pointerY: number,
  srcId?: string,
  idAttr?: 'pathId' | 'bookmarkGroupId' | 'sessionId',
): { index: number; lineTop: number } {
  const containerRect = container.getBoundingClientRect();
  const children = Array.from(container.children) as HTMLElement[];
  let index = 0;
  let lineTop = 0;
  for (const child of children) {
    const isSource = !!srcId && !!idAttr && child.dataset[idAttr] === srcId;
    const rect = child.getBoundingClientRect();
    if (!isSource) {
      const mid = rect.top + rect.height / 2;
      if (pointerY < mid) {
        lineTop = rect.top - containerRect.top;
        return { index, lineTop };
      }
      index += 1;
    } else if (children.length === 1) {
      // 容器里只有源行：插在源行处（视觉上原地）。
      lineTop = rect.top - containerRect.top;
    }
  }
  // 越过所有有效中点 → 插到末尾；提示线贴最后一行下沿。
  if (children.length > 0) {
    const last = children[children.length - 1]!;
    const r = last.getBoundingClientRect();
    lineTop = r.bottom - containerRect.top;
  } else {
    lineTop = 0;
  }
  return { index, lineTop };
}

/**
 * 不占布局高度的拖拽提示线。拖动期间由 DndContext 的 onDragMove 驱动更新
 * 其 top/left/width。位置由指针 y 决定（插入到哪一行间隙），缩进由落点
 * 容器深度决定（x 选择容器、容器决定缩进），完全所见即所得。
 */
function DropIndicator({ geom }: { geom: DropIndicatorGeometry }): JSX.Element {
  return (
    <div
      className="dnd-drop-indicator"
      aria-hidden="true"
      style={{ top: `${geom.top}px`, left: `${geom.left}px`, width: `${geom.width}px` }}
    >
      <span className="dnd-drop-indicator-line" />
    </div>
  );
}

/**
 * path 容器：本身是唯一 droppable（携带 containerId + depth），不再在每个间隙
 * 插入占位插槽。拖动期间不改变任何行的高度与位置，碰撞按指针 y 相对各子行
 * 中点单调推导插入索引（见 computeInsertionAtY）。该 droppable 的 data 同时
 * 携带 visibleIds/fullIds/activeId，供 BookmarkCategory 的碰撞回调把可见段索引
 * 映射回全量布局索引（hidden local/SSH segment 不会丢）。 */
function BookmarkPathList({
  paths,
  containerId,
  depth,
  dragState,
  fullLayout,
  renderPath,
  className,
}: {
  paths: PathNode[];
  containerId: string;
  depth: number;
  dragState: BookmarkDragState | null;
  fullLayout: BookmarkOrderLayout;
  renderPath: (
    path: PathNode,
    dndRow?: { containerId: string; index: number; depth: number },
  ) => JSX.Element;
  className: string;
}): JSX.Element {
  const activePathId = dragState?.activeType === 'bookmark-path' ? dragState.activeId : undefined;
  const visibleIds = paths.map((path) => path.id);
  const fullIds = bookmarkPathIdsForContainer(fullLayout, containerId) ?? visibleIds;
  // 末尾兑底的 placement（用全量索引，hidden segment 不丢）。
  const tailFullIndex = fullIds.filter((id) => id !== activePathId).length;
  const { setNodeRef, isOver } = useDroppable({
    id: `${PATH_LIST_DROP_ID_PREFIX}${encodeURIComponent(containerId)}`,
    data: {
      rowKind: 'container-tail',
      containerId,
      depth,
      placement: {
        targetContainerId: containerId,
        targetIndex: tailFullIndex,
      } as BookmarkPlacement,
    },
  });
  return (
    <SortableContext
      items={paths.map((path) => path.id)}
      strategy={verticalListSortingStrategy}
      id={containerId}
    >
      <ul
        ref={setNodeRef}
        className={`${className}${isOver ? ' drop-over' : ''}`}
        data-container-id={containerId}
        data-container-depth={depth}
      >
        {paths.map((path, i) => renderPath(path, { containerId, index: i, depth }))}
      </ul>
    </SortableContext>
  );
}

/** group 容器的 0..N 真实插槽。共享边界因递归 DOM 自然展开为“插槽阶梯”。 */
function BookmarkGroupList({
  groups,
  parentId,
  depth,
  dragState,
  fullLayout,
  collapsedSet,
  toggleGroup,
  byGroup,
  renderPath,
  onRequestAddSubgroup,
  onRequestAddFolder,
  addFolderDisabledReason,
  disabled,
}: {
  groups: GroupNode[];
  parentId: string | null;
  depth: number;
  dragState: BookmarkDragState | null;
  fullLayout: BookmarkOrderLayout;
  collapsedSet: Set<string>;
  toggleGroup: (groupId: string) => void;
  byGroup: Map<string, PathNode[]>;
  renderPath: (
    path: PathNode,
    dndRow?: { containerId: string; index: number; depth: number },
  ) => JSX.Element;
  onRequestAddSubgroup: (parentId: string) => void;
  onRequestAddFolder: (groupId: string) => void;
  addFolderDisabledReason?: string;
  disabled?: boolean;
}): JSX.Element {
  const containerId =
    parentId === null ? BOOKMARK_ROOT_GROUP_CONTAINER : bookmarkSubgroupContainerId(parentId);
  const activeGroupId = dragState?.activeType === 'bookmark-group' ? dragState.activeId : undefined;
  const tailIndex = groups.filter((g) => g.id !== activeGroupId).length;
  const { setNodeRef, isOver } = useDroppable({
    id: `${GROUP_LIST_DROP_ID_PREFIX}${encodeURIComponent(containerId)}`,
    ...(disabled ? { disabled } : {}),
    data: {
      rowKind: 'container-tail',
      containerId,
      depth,
      placement: { targetContainerId: containerId, targetIndex: tailIndex } as BookmarkPlacement,
    },
  });
  return (
    <SortableContext
      items={groups.map((group) => GROUP_ID_PREFIX + group.id)}
      strategy={verticalListSortingStrategy}
      id={containerId}
    >
      <div
        ref={setNodeRef}
        className={`bookmark-group-container${isOver ? ' drop-over' : ''}`}
        data-group-container-id={containerId}
        data-group-container-depth={depth}
      >
        {groups.map((group, i) => (
          <GroupBlock
            key={group.id}
            group={group}
            depth={depth}
            index={i}
            containerId={containerId}
            dragState={dragState}
            fullLayout={fullLayout}
            collapsedSet={collapsedSet}
            toggleGroup={toggleGroup}
            byGroup={byGroup}
            renderPath={renderPath}
            onRequestAddSubgroup={onRequestAddSubgroup}
            onRequestAddFolder={onRequestAddFolder}
            {...(addFolderDisabledReason ? { addFolderDisabledReason } : {})}
          />
        ))}
      </div>
    </SortableContext>
  );
}

/**
 * 递归渲染的分组块：自身是父级 SortableContext 的 sortable（整条组行是 activator），
 * 同时也是 path 的 droppable 容器（pathContainerId = 组 id）；内部含子组
 * SortableContext + 本组 path SortableContext。深度缩进由 paddingLeft 表达。
 */
function GroupBlock({
  group,
  depth,
  index,
  containerId,
  dragState,
  fullLayout,
  collapsedSet,
  toggleGroup,
  byGroup,
  renderPath,
  onRequestAddSubgroup,
  onRequestAddFolder,
  addFolderDisabledReason,
}: {
  group: GroupNode;
  depth: number;
  /** 该组在父级 subgroup-list 里的序号（拖拽 v3 行模型用）。 */
  index: number;
  /** 该组所在排序容器 id（父级 subgroup-list；根组=BOOKMARK_ROOT_GROUP_CONTAINER）。 */
  containerId: string;
  dragState: BookmarkDragState | null;
  fullLayout: BookmarkOrderLayout;
  collapsedSet: Set<string>;
  toggleGroup: (groupId: string) => void;
  byGroup: Map<string, PathNode[]>;
  renderPath: (
    p: PathNode,
    dndRow?: { containerId: string; index: number; depth: number },
  ) => JSX.Element;
  onRequestAddSubgroup: (parentId: string) => void;
  onRequestAddFolder: (groupId: string) => void;
  addFolderDisabledReason?: string;
}): JSX.Element {
  const groupId = GROUP_ID_PREFIX + group.id;
  const isCollapsed = collapsedSet.has(group.id);
  const gPaths = byGroup.get(group.id) ?? [];
  const subgroups = group.subgroups ?? [];
  const activeGroupId = dragState?.activeType === 'bookmark-group' ? dragState.activeId : undefined;
  const activePathId = dragState?.activeType === 'bookmark-path' ? dragState.activeId : undefined;
  const groupDropForbidden =
    !!activeGroupId &&
    (activeGroupId === group.id || isDescendantGroupInLayout(fullLayout, activeGroupId, group.id));
  const subgroupContainerId = bookmarkSubgroupContainerId(group.id);
  const groupPlacement: BookmarkPlacement = {
    targetContainerId: subgroupContainerId,
    targetIndex: subgroups.filter((subgroup) => subgroup.id !== activeGroupId).length,
  };
  const visiblePathIds = gPaths.map((path) => path.id);
  const fullPathIds = bookmarkPathIdsForContainer(fullLayout, group.id) ?? visiblePathIds;
  const pathPlacement: BookmarkPlacement = {
    targetContainerId: group.id,
    targetIndex:
      visibleBookmarkSlotToFullIndex(
        fullPathIds,
        visiblePathIds,
        activePathId,
        visiblePathIds.filter((id) => id !== activePathId).length,
      ) ?? fullPathIds.filter((id) => id !== activePathId).length,
  };

  const sortable = useSortable({
    id: groupId,
    data: { type: 'bookmark-group', groupId: group.id },
  });
  // 组标题是「行模型」的一行（rowKind='group-head'）：指针 y 在标题上半=插到本组
  // 之前（同父容器）；下半 + x 靠右=嵌入进本组（拖组→子组末尾；拖路径→路径末尾）；
  // 下半 + x 靠左=插到本组之后（同父容器）。缩进随选择实时变化，所见即所得。
  const dropTarget = useDroppable({
    id: GROUP_DROP_ID_PREFIX + group.id,
    disabled: !dragState || (dragState.activeType === 'bookmark-group' && groupDropForbidden),
    data: {
      rowKind: 'group-head',
      type: 'bookmark-group-drop',
      groupId: group.id,
      containerId,
      index,
      depth,
      // 嵌入本组时的落点（预计算末尾）
      nestGroupPlacement: groupPlacement,
      nestPathPlacement: pathPlacement,
      subgroupContainerId,
    },
  });

  // 折叠组在 pointer 稳定悬停 450ms 后展开；快速划过不会让整棵树乱跳。
  useEffect(() => {
    if (!isCollapsed || !dropTarget.isOver || !dragState) return undefined;
    const timer = window.setTimeout(() => toggleGroup(group.id), 450);
    return () => window.clearTimeout(timer);
  }, [dragState, dropTarget.isOver, group.id, isCollapsed, toggleGroup]);

  const className =
    'sidebar-group bookmark-drop-zone' +
    (sortable.isDragging ? ' dragging' : '') +
    (dropTarget.isOver ? ' drop-over' : '');

  return (
    <div
      ref={sortable.setNodeRef}
      style={{ paddingLeft: depth > 0 ? GROUP_TREE_INDENT_PX : undefined }}
      className={className}
      data-bookmark-group-id={group.id}
    >
      <GroupHeader
        group={group}
        collapsed={isCollapsed}
        depth={depth}
        index={index}
        parentContainerId={containerId}
        onToggleCollapse={() => toggleGroup(group.id)}
        onRequestAddSubgroup={() => onRequestAddSubgroup(group.id)}
        onRequestAddFolder={() => onRequestAddFolder(group.id)}
        {...(addFolderDisabledReason ? { addFolderDisabledReason } : {})}
        dragHandle={sortable}
        dropTarget={dropTarget}
      />
      {!isCollapsed && (
        <>
          <BookmarkGroupList
            groups={subgroups}
            parentId={group.id}
            depth={depth + 1}
            dragState={dragState}
            fullLayout={fullLayout}
            collapsedSet={collapsedSet}
            toggleGroup={toggleGroup}
            byGroup={byGroup}
            renderPath={renderPath}
            onRequestAddSubgroup={onRequestAddSubgroup}
            onRequestAddFolder={onRequestAddFolder}
            disabled={groupDropForbidden}
            {...(addFolderDisabledReason ? { addFolderDisabledReason } : {})}
          />
          <BookmarkPathList
            paths={gPaths}
            containerId={group.id}
            depth={depth + 1}
            dragState={dragState}
            fullLayout={fullLayout}
            renderPath={renderPath}
            className="sidebar-paths sidebar-group-paths"
          />
        </>
      )}
    </div>
  );
}

/**
 * 收藏栏:带分组的布局 + @dnd-kit 拖序。
 *
 * 拖序语义(决策 #13:只收藏可拖序):
 * - 同容器(未分组或同一组)内拖动 = 组内排序。
 * - 跨容器拖动 = 移到目标组(拖到未分组 = 移出组)。
 * - 拖完统一发分层 BOOKMARK_REORDER {ungrouped, groups[{id, childOrder}]}。
 */
function BookmarkCategory({
  paths,
  allPaths,
  groups,
  collapsed,
  onToggleCollapsed,
  onContextMenu,
  onRequestAddSubgroup,
  onRequestAddFolder,
  addFolderDisabledReason,
  actionLabel,
  actionTitle,
  onAction,
  displayNames,
}: {
  /** 当前 local/SSH segment 可见路径（只用于渲染和碰撞）。 */
  paths: PathNode[];
  /** backend 全量收藏（用于提交完整 reorder，绝不能丢掉另一 segment）。 */
  allPaths: PathNode[];
  /** 分组森林（顶层数组；子组递归挂在 subgroups 下）。 */
  groups: GroupNode[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onContextMenu: (e: MouseEvent<HTMLElement>) => void;
  /** 新建分组；parentId 给定时新建子组。 */
  onRequestAddSubgroup: (parentId: string) => void;
  /** 从组右键菜单直接选择文件夹并原子地加入该组。 */
  onRequestAddFolder: (groupId: string) => void;
  addFolderDisabledReason?: string;
  actionLabel?: ReactNode;
  actionTitle?: string;
  /** 事件带出,供调用方定位弹层锚点(如远程段选服务器菜单) */
  onAction?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  displayNames: Map<string, string>;
}): JSX.Element {
  const { t } = useTranslation();
  const toast = useToast();
  // 分组折叠态:L2 偏好(附录 G.1),跨重启保留;默认全展开。
  const [collapsedGroupIds, setCollapsedGroupIds] = usePanelPreference<string[]>(
    'sidebar',
    'groupCollapsed',
    [],
  );
  const collapsedSet = useMemo(() => new Set(collapsedGroupIds), [collapsedGroupIds]);
  const toggleGroup = (groupId: string): void => {
    setCollapsedGroupIds((prev) =>
      prev.includes(groupId) ? prev.filter((x) => x !== groupId) : [...prev, groupId],
    );
  };

  // 按 groupId 派生各容器(path 顺序 = bookmarks 数组顺序,即后端真值)。
  const ungrouped = useMemo(() => paths.filter((p) => !p.groupId), [paths]);
  const byGroup = useMemo(() => {
    const m = new Map<string, PathNode[]>();
    const walk = (nodes: GroupNode[]): void => {
      for (const g of nodes) {
        m.set(g.id, []);
        walk(g.subgroups ?? []);
      }
    };
    walk(groups);
    for (const p of paths) {
      if (p.groupId && m.has(p.groupId)) m.get(p.groupId)!.push(p);
    }
    return m;
  }, [paths, groups]);

  // 全部组（扁平遍历），供落点文案与菜单扁平列表用。
  const allGroupsFlat = useMemo(() => {
    const out: GroupNode[] = [];
    const walk = (nodes: GroupNode[]): void => {
      for (const g of nodes) {
        out.push(g);
        walk(g.subgroups ?? []);
      }
    };
    walk(groups);
    return out;
  }, [groups]);
  const groupNameById = useMemo(
    () => new Map(allGroupsFlat.map((group) => [group.id, group.name])),
    [allGroupsFlat],
  );

  // BOOKMARK_REORDER 的后端契约要求 payload 覆盖全部收藏。UI 虽只渲染当前
  // local/SSH segment，拖拽计算必须用全量布局，否则隐藏 segment 的 pathId 会丢失。
  // 组树 → 扁平组表（subgroupOrder 表达层级）。
  const fullLayout = useMemo<BookmarkOrderLayout>(() => {
    const groupIds = new Set<string>();
    const groupsFlat: BookmarkGroupOrder[] = [];
    const walk = (node: GroupNode): void => {
      groupIds.add(node.id);
      groupsFlat.push({
        id: node.id,
        childOrder: allPaths.filter((path) => path.groupId === node.id).map((path) => path.id),
        subgroupOrder: (node.subgroups ?? []).map((s) => s.id),
      });
      for (const sub of node.subgroups ?? []) walk(sub);
    };
    for (const g of groups) walk(g);
    return {
      ungrouped: allPaths
        .filter((path) => !path.groupId || !groupIds.has(path.groupId))
        .map((path) => path.id),
      groups: groupsFlat,
    };
  }, [allPaths, groups]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  /**
   * droppable 数据。拖拽 v3 是「行模型」：每个可见行（路径 li / 组标题）本身是
   * droppable，携带它在排序容器里的 containerId + index + 视觉 depth。
   * - rowKind='path'：路径行。y 上半=插到本行前；下半=插到本行后。
   * - rowKind='group-head'：组标题行。y 上半=插到本组前；下半时 x 靠右=嵌入进本组
   *   （拖组→子组末尾；拖路径→路径末尾），x 靠左=插到本组后。
   * - rowKind='container-tail'：空容器的末尾兑底（指针在容器空白区且不命中任何行）。
   * 这正是「y 选行、x 决定是否嵌入该行对应的组」，所见即所得。 */
  type DndData = {
    rowKind?: 'path' | 'group-head' | 'container-tail';
    // 兼容：useSortable 在 active 上放 type 而非 rowKind
    type?: string;
    groupId?: string;
    containerId?: string;
    index?: number;
    depth?: number;
    // group-head 嵌入本组时的预计算落点
    nestGroupPlacement?: BookmarkPlacement;
    nestPathPlacement?: BookmarkPlacement;
    subgroupContainerId?: string;
    // container-tail 用
    placement?: BookmarkPlacement;
  };

  /**  /** 组标题「嵌入」的 x 阈值：指针 x 超过子内容缩进列 = 嵌入。 */
  const isNestingByX = (rowRect: DOMRect, depth: number, pointerX: number): boolean => {
    // 子内容左边界（相对 viewport）= 行左 + (depth+1) 级缩进。行左已含 depth 级 padding。
    const nestLeft = rowRect.left + (depth + 1) * GROUP_TREE_INDENT_PX;
    return pointerX >= nestLeft;
  };

  /**
   * 把一次拖拽解析为 {placement, indicator}。纯函数，由 onDragMove 驱动。
   * - path 行：上半→前置；下半→后置。
   * - group-head 行：上半→前置（同父）；下半 + x 嵌入→进本组；下半 + x 靠左→后置。
   * - container-tail：末尾。 */
  const resolveDrop = (
    activeType: string | undefined,
    overData: DndData | undefined,
    overNode: HTMLElement | null,
    pointerX: number,
    pointerY: number,
  ): { placement: BookmarkPlacement; indicator: DropIndicatorGeometry } | null => {
    if (!overData) return null;

    if (overData.rowKind === 'container-tail') {
      const p = overData.placement;
      if (!p) return null;
      const rect = overNode?.getBoundingClientRect();
      const depth = overData.depth ?? 0;
      return {
        placement: p,
        indicator: { top: rect ? rect.bottom : 0, left: indentForDepth(depth), width: 0 },
      };
    }

    if (!overNode) return null;
    const rect = overNode.getBoundingClientRect();
    const depth = overData.depth ?? 0;
    const midY = rect.top + rect.height / 2;
    const upperHalf = pointerY < midY;

    if (overData.rowKind === 'path') {
      if (activeType !== 'bookmark-path') return null;
      const containerId = overData.containerId!;
      const idx = overData.index ?? 0;
      // 上半→前置；下半→后置（index 都不改相对顺序，只决定插在行前还是行后）。
      const targetIndex = upperHalf ? idx : idx + 1;
      return {
        placement: { targetContainerId: containerId, targetIndex },
        indicator: {
          top: upperHalf ? rect.top : rect.bottom,
          left: indentForDepth(depth),
          width: 0,
        },
      };
    }

    if (overData.rowKind === 'group-head') {
      const containerId = overData.containerId!;
      const idx = overData.index ?? 0;
      if (upperHalf) {
        // 前置：插到本组之前（同父容器）。
        return {
          placement: { targetContainerId: containerId, targetIndex: idx },
          indicator: { top: rect.top, left: indentForDepth(depth), width: 0 },
        };
      }
      // 下半：x 决定是「后置兄弟」还是「嵌入本组」。
      const nest = isNestingByX(rect, depth, pointerX);
      if (nest) {
        if (activeType === 'bookmark-group') {
          const p = overData.nestGroupPlacement;
          if (!p) return null;
          return {
            placement: p,
            indicator: { top: rect.bottom, left: indentForDepth(depth + 1), width: 0 },
          };
        }
        if (activeType === 'bookmark-path') {
          const p = overData.nestPathPlacement;
          if (!p) return null;
          return {
            placement: p,
            indicator: { top: rect.bottom, left: indentForDepth(depth + 1), width: 0 },
          };
        }
        return null;
      }
      // 后置兄弟。
      return {
        placement: { targetContainerId: containerId, targetIndex: idx + 1 },
        indicator: { top: rect.bottom, left: indentForDepth(depth), width: 0 },
      };
    }
    return null;
  };

  /**
   * 碰撞：只接受携带 rowKind 的行；useSortable wrapper droppable 不携带 rowKind
   * → 被过滤。指针同时落在「行」与包裹「容器」上时，优先选行（非 container-tail），
   * 这样 y 选行、x 嵌入才生效。多个行命中时取 depth 最大（最嵌套叶子）。 */
  const slotCollisionDetection: CollisionDetection = (args) => {
    type Hit = { collision: { id: unknown }; rowKind: string; depth: number; area: number };
    const hits = pointerWithin(args)
      .map((collision): Hit | null => {
        const container = args.droppableContainers.find((c) => c.id === collision.id);
        const data = container?.data.current as DndData | undefined;
        if (!data?.rowKind) return null;
        const rect = container?.rect.current;
        const area = rect ? rect.width * rect.height : Infinity;
        return {
          collision: collision as unknown as Hit['collision'],
          rowKind: data.rowKind,
          depth: data.depth ?? 0,
          area,
        };
      })
      .filter((x): x is Hit => x !== null);
    if (hits.length > 1) {
      // 行（path/group-head）优先于 container-tail；同优先级里取 depth 最大、面积最小（最具体）。
      const rank = (h: Hit): number => (h.rowKind === 'container-tail' ? 1 : 0);
      hits.sort((a, b) => rank(a) - rank(b) || b.depth - a.depth || a.area - b.area);
    }
    return hits.map((h) => h.collision as unknown as ReturnType<typeof pointerWithin>[number]);
  };

  /**
   * 纯坐标驱动的落点解析：用真实指针 (x,y) 在 DOM 里找命中的行，再走 resolveDrop。
   *
   * 为什么不依赖 dnd-kit 的碰撞回调：dnd-kit 的 over / pointerWithin 用的是 DragOverlay
   * 跟随矩形（有抓取偏移且延迟），不是真实指针，导致「指针在 g2 标题、over 却报 g1
   * 源行」这类错位。用户要「拖到哪就放到哪」，只能用真实 clientX/Y 在 DOM 里命中行。
   * dnd-kit 退化为只管传感器激活 + DragOverlay + 释放事件。 */
  const resolveDropFromPoint = (
    activeType: string | undefined,
    x: number,
    y: number,
  ): { placement: BookmarkPlacement; indicator: DropIndicatorGeometry } | null => {
    const root = indicatorHostRef.current;
    if (!root || !activeType) return null;
    // 先找组标题行（更具体的叶子），再找路径行。
    const headEl = Array.from(
      root.querySelectorAll<HTMLElement>('.sidebar-group-header[data-bookmark-group-id]'),
    ).find((el) => {
      const r = el.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    });
    if (headEl) {
      const gid = headEl.dataset.bookmarkGroupId!;
      const depth = Number(headEl.dataset.groupDepth ?? '0');
      // 嵌入进该组的落点：拖组→该组 subgroup-list 末尾；拖路径→该组 path-list 末尾。
      const subCount = (allGroupsFlat.find((g) => g.id === gid)?.subgroups ?? []).filter(
        (sg) => sg.id !== dragState?.activeId,
      ).length;
      const pathCount = (byGroup.get(gid) ?? []).filter((p) => p.id !== dragState?.activeId).length;
      const data: DndData = {
        rowKind: 'group-head',
        groupId: gid,
        containerId: headEl.dataset.groupParentContainer ?? '',
        index: Number(headEl.dataset.groupIndex ?? '0'),
        depth,
        nestGroupPlacement: {
          targetContainerId: bookmarkSubgroupContainerId(gid),
          targetIndex: subCount,
        },
        nestPathPlacement: { targetContainerId: gid, targetIndex: pathCount },
      };
      return resolveDrop(activeType, data, headEl, x, y);
    }
    // 路径行
    const pathEl = Array.from(root.querySelectorAll<HTMLElement>('[data-path-id]')).find((el) => {
      const r = el.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    });
    if (pathEl) {
      const data = {
        rowKind: 'path' as const,
        containerId: pathEl.dataset.pathContainerId,
        index: Number(pathEl.dataset.pathIndex ?? '0'),
        depth: Number(pathEl.dataset.pathDepth ?? '0'),
      };
      return resolveDrop(activeType, data as DndData, pathEl, x, y);
    }
    // container-tail 兑底：指针没命中任何行（落在容器空白区）。
    // 取命中的最深（面积最小）容器作为落点上下文。 */
    const tailEls = Array.from(
      root.querySelectorAll<HTMLElement>('[data-container-id],[data-group-container-id]'),
    ).filter((el) => {
      const r = el.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    });
    let tailEl: HTMLElement | undefined;
    let tailArea = Infinity;
    for (const el of tailEls) {
      const r = el.getBoundingClientRect();
      const a = r.width * r.height;
      if (a < tailArea) {
        tailArea = a;
        tailEl = el;
      }
    }
    if (tailEl) {
      const rect = tailEl.getBoundingClientRect();
      // 关键修复（bug #2）：指针落在某组 G 的子组列表空白区时——
      // 这块空白在视觉上紧贴 G 标题下方，用户最想表达的是「放到 G 的同级后面」，
      // 但旧逻辑一律当「嵌入 G 的子组末尾」。现在用 x 区分：x 靠左（未越过子内容
      // 缩进列）= 同级后置（放在 G 之后、G 的下一个兄弟之前）；x 靠右 = 嵌入 G 末尾。
      const subgroupContainerId = tailEl.dataset.groupContainerId;
      if (subgroupContainerId) {
        // 从容器 id 反解出 G。容器 id 形如 __marina_subgroups__:<encodeURIComponent gid>。
        const gid = decodeSubgroupId(subgroupContainerId);
        const gOrder = gid ? fullLayout.groups.find((g) => g.id === gid) : undefined;
        if (gid && gOrder) {
          const containerDepth = Number(tailEl.dataset.groupContainerDepth ?? '0');
          const gDepth = Math.max(0, containerDepth - 1); // G 的视觉深度
          // x 是否越过「子内容缩进列」= 是否嵌入。与 group-head 的 isNestingByX 一致。
          const nestLeft = rect.left + GROUP_TREE_INDENT_PX;
          if (x < nestLeft) {
            // 同级后置：放在 G 之后。容器 = G 的父级 subgroup 容器；index = G 在父级的序号+1。
            const parentId = parentGroupId(fullLayout, gid);
            const parentContainer =
              parentId === null
                ? BOOKMARK_ROOT_GROUP_CONTAINER
                : bookmarkSubgroupContainerId(parentId);
            const siblings =
              parentId === null
                ? fullLayout.groups
                    .filter((g) => parentGroupId(fullLayout, g.id) === null)
                    .map((g) => g.id)
                : (fullLayout.groups.find((g) => g.id === parentId)?.subgroupOrder ?? []);
            const gIndex = siblings.indexOf(gid);
            const placement: BookmarkPlacement = {
              targetContainerId: parentContainer,
              targetIndex: gIndex < 0 ? siblings.length : gIndex + 1,
            };
            return resolveDrop(
              activeType,
              { rowKind: 'container-tail', containerId: parentContainer, depth: gDepth, placement },
              tailEl,
              x,
              y,
            );
          }
          // x 靠右：嵌入 G 的子组末尾（保留旧语义）。
          const childCount = tailEl.querySelectorAll(':scope > [data-bookmark-group-id]').length;
          const placement: BookmarkPlacement = {
            targetContainerId: subgroupContainerId,
            targetIndex: childCount,
          };
          return resolveDrop(
            activeType,
            {
              rowKind: 'container-tail',
              containerId: subgroupContainerId,
              depth: containerDepth,
              placement,
            },
            tailEl,
            x,
            y,
          );
        }
      }
      // 路径容器尾部：追到末尾。 */
      const containerId = tailEl.dataset.containerId ?? tailEl.dataset.groupContainerId ?? '';
      const depth = Number(
        tailEl.dataset.containerDepth ?? tailEl.dataset.groupContainerDepth ?? '0',
      );
      const childCount = tailEl.querySelectorAll(':scope > [data-path-id]').length;
      const placement: BookmarkPlacement = {
        targetContainerId: containerId,
        targetIndex: childCount,
      };
      return resolveDrop(
        activeType,
        { rowKind: 'container-tail', containerId, depth, placement },
        tailEl,
        x,
        y,
      );
    }
    return null;
  };

  const [dragState, setDragState] = useState<BookmarkDragState | null>(null);
  const clearDragState = (): void => setDragState(null);
  // 提示线错容器：sidebar-bookmark-groups（position:relative）。
  const indicatorHostRef = useRef<HTMLDivElement | null>(null);
  // dragState 的 ref，供 pointermove 回调读到最新 activeType（避免闭包旧值）。
  const dragStateRef = useRef<BookmarkDragState | null>(null);
  dragStateRef.current = dragState;
  // resolveDropFromPoint 的 ref：它捕获 allGroupsFlat/byGroup（每次 render 重建闭包），
  // 放进 ref 保证 pointermove 总用最新版，而 effect 本身只在拖拽开关时挂卸。
  const resolveDropFromPointRef = useRef(resolveDropFromPoint);
  resolveDropFromPointRef.current = resolveDropFromPoint;
  const isDragging = !!dragState;
  // 拖拽期间自己监听 pointermove，用真实 clientX/Y 驱动提示线 + 落点。
  // （dnd-kit 的 over/碰撞用的是 DragOverlay 跟随矩形，有偏移与延迟，不能用来选行。）
  useEffect(() => {
    if (!isDragging) return undefined;
    const onMove = (e: PointerEvent): void => {
      const at = dragStateRef.current;
      if (!at?.activeType) return;
      const drop = resolveDropFromPointRef.current(at.activeType, e.clientX, e.clientY);
      const host = indicatorHostRef.current;
      const hostRect = host?.getBoundingClientRect();
      const hostWidth = host?.clientWidth ?? 0;
      const indicator: DropIndicatorGeometry | undefined =
        drop && hostRect
          ? {
              top: drop.indicator.top - hostRect.top + host!.scrollTop,
              left: drop.indicator.left,
              width: Math.max(40, hostWidth - drop.indicator.left - DROP_INDICATOR_RIGHT_PAD_PX),
            }
          : undefined;
      setDragState((prev) =>
        prev
          ? {
              ...prev,
              ...(drop ? { placement: drop.placement } : { placement: undefined }),
              ...(indicator ? { indicator } : { indicator: undefined }),
            }
          : prev,
      );
    };
    window.addEventListener('pointermove', onMove, { passive: true, capture: true });
    return () => window.removeEventListener('pointermove', onMove, { capture: true });
  }, [isDragging]);

  const handleDragStart = (event: DragStartEvent): void => {
    const data = event.active.data.current as DndData | undefined;
    // 兼容：useSortable 在 active 上放 type 而非 kind。
    const activeType = data?.type;
    setDragState({
      activeType,
      activeId:
        activeType === 'bookmark-group' && data?.groupId ? data.groupId : String(event.active.id),
    });
  };

  /** onDragOver 仅维护 overId（用于折叠组悬停展开计时）。提示线/落点由 pointermove 驱动。 */
  const handleDragOver = (event: DragOverEvent): void => {
    setDragState((prev) =>
      prev ? { ...prev, ...(event.over ? { overId: String(event.over.id) } : {}) } : prev,
    );
  };

  /** 释放只提交最后一次 onDragMove 记下的 placement；没有 placement 等价取消。 */
  const handleDragEnd = (event: DragEndEvent): void => {
    const last = dragState;
    clearDragState();
    const activeData = event.active.data.current as DndData | undefined;
    const activeType = activeData?.type;
    const placement = last?.placement;
    if (!placement) return;

    const nextLayout =
      activeType === 'bookmark-group' && activeData?.groupId
        ? moveBookmarkGroupToPlacement(fullLayout, activeData.groupId, placement)
        : activeType === 'bookmark-path'
          ? moveBookmarkToPlacement(fullLayout, String(event.active.id), placement)
          : null;
    if (!nextLayout) return;

    window.api.invoke(COMMAND_CHANNELS.BOOKMARK_REORDER, nextLayout).catch((err: unknown) => {
      console.warn('[BookmarkCategory] reorder rejected:', err);
      toast.push({
        kind: 'error',
        message: `调整收藏顺序失败:${err instanceof Error ? err.message : String(err)}`,
      });
    });
  };

  /** 路径右键「移动到分组」：重算完整布局后发 BOOKMARK_REORDER（组 = 追加末尾）。 */
  const movePathToGroup = (pathId: string, targetGroupId: string | null): void => {
    const nextLayout =
      targetGroupId === null
        ? moveBookmarkInLayout(fullLayout, {
            activeId: pathId,
            overId: BOOKMARK_UNGROUPED_CONTAINER,
            overContainerId: BOOKMARK_UNGROUPED_CONTAINER,
          })
        : moveBookmarkInLayout(fullLayout, {
            activeId: pathId,
            overId: targetGroupId,
            overContainerId: targetGroupId,
          });
    if (!nextLayout) return;
    window.api.invoke(COMMAND_CHANNELS.BOOKMARK_REORDER, nextLayout).catch((err: unknown) => {
      console.warn('[BookmarkCategory] move-to-group rejected:', err);
      toast.push({
        kind: 'error',
        message: `移动失败:${err instanceof Error ? err.message : String(err)}`,
      });
    });
  };

  const renderPath = (
    p: PathNode,
    dndRow?: { containerId: string; index: number; depth: number },
  ): JSX.Element => {
    const override = p.kind === 'ssh' ? undefined : displayNames.get(p.id);
    return (
      <PathItem
        key={p.id}
        node={p}
        sortableId={p.id}
        {...(dndRow ? { dndRow } : {})}
        {...(override !== undefined ? { displayNameOverride: override } : {})}
        groups={groups}
        onMovePathToGroup={movePathToGroup}
      />
    );
  };

  const activeOverlayLabel =
    dragState?.activeType === 'bookmark-group'
      ? groupNameById.get(dragState.activeId ?? '')
      : (paths.find((path) => path.id === dragState?.activeId)?.displayName ??
        basename(paths.find((path) => path.id === dragState?.activeId)?.path));

  return (
    <DndContext
      sensors={sensors}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      collisionDetection={slotCollisionDetection}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={clearDragState}
    >
      <section className={`sidebar-category${collapsed ? ' collapsed' : ''}`}>
        <header
          className="sidebar-category-header"
          onClick={onToggleCollapsed}
          onContextMenu={onContextMenu}
          title={
            collapsed
              ? `展开${t('sidebar.category.bookmark')}`
              : `折叠${t('sidebar.category.bookmark')}`
          }
        >
          <span className="sidebar-category-chevron" aria-hidden="true">
            {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </span>
          <span className="sidebar-category-title">
            <span className="sidebar-category-icon" aria-hidden="true">
              <Icon name="bookmark" size={12} />
            </span>
            {t('sidebar.category.bookmark')}
          </span>
          <span className="sidebar-category-count">{paths.length}</span>
          {actionLabel && (
            <button
              type="button"
              className="sidebar-category-action"
              onClick={(e) => {
                e.stopPropagation();
                onAction?.(e);
              }}
              title={actionTitle}
            >
              {actionLabel}
            </button>
          )}
        </header>
        {collapsed ? null : paths.length === 0 && groups.length === 0 ? (
          <p className="sidebar-empty">空</p>
        ) : (
          <div className="sidebar-bookmark-groups" ref={indicatorHostRef}>
            <BookmarkPathList
              paths={ungrouped}
              containerId={UNGROUPED_CONTAINER}
              depth={0}
              dragState={dragState}
              fullLayout={fullLayout}
              renderPath={renderPath}
              className="sidebar-paths sidebar-ungrouped"
            />
            <BookmarkGroupList
              groups={groups}
              parentId={null}
              depth={0}
              dragState={dragState}
              fullLayout={fullLayout}
              collapsedSet={collapsedSet}
              toggleGroup={toggleGroup}
              byGroup={byGroup}
              renderPath={renderPath}
              onRequestAddSubgroup={onRequestAddSubgroup}
              onRequestAddFolder={onRequestAddFolder}
              {...(addFolderDisabledReason ? { addFolderDisabledReason } : {})}
            />
            {dragState?.indicator ? <DropIndicator geom={dragState.indicator} /> : null}
          </div>
        )}
      </section>
      <DragOverlay dropAnimation={null}>
        {dragState && activeOverlayLabel ? (
          <div className={`bookmark-drag-overlay ${dragState.activeType ?? ''}`}>
            <Icon
              name={dragState.activeType === 'bookmark-group' ? 'group' : 'bookmark'}
              size={12}
            />
            <span>{activeOverlayLabel}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

interface SessionDragState {
  activeId: string;
  targetIndex?: number;
  indicator?: DropIndicatorGeometry;
}

/** session 列表容器：本身是唯一 droppable（携带 kind='session-list'）。 */
function SessionListDropTarget({
  ulRef,
  pathId,
  enabled,
  children,
}: {
  ulRef: (node: HTMLUListElement | null) => void;
  pathId: string;
  enabled: boolean;
  children: ReactNode;
}): JSX.Element {
  const { setNodeRef, isOver } = useDroppable({
    id: `session-list:${encodeURIComponent(pathId)}`,
    disabled: !enabled,
    data: { kind: 'session-list', pathId },
  });
  const composedRef = (node: HTMLUListElement | null): void => {
    setNodeRef(node);
    ulRef(node);
  };
  return (
    <ul ref={composedRef} className={`session-list${isOver ? ' drop-over' : ''}`}>
      {children}
    </ul>
  );
}

function PathItem({
  node,
  displayNameOverride,
  sortableId,
  dndRow,
  groups,
  onMovePathToGroup,
}: {
  node: PathNode;
  displayNameOverride?: string;
  /**
   * v0.3.3 Feature E.2:传了才启用 @dnd-kit 拖拽(仅收藏栏传,临时/最近不传)。
   * id = node.id;不传时 useSortable 不被调用,零 dnd 开销。
   */
  sortableId?: string;
  /**
   * v0.3.3 拖拽 v3（y 选行/x 定层）：该路径行作为 droppable 携带的排序元数据。
   * containerId = 所在排序容器（未分组或某组的 path-list），index = 在该容器里的
   * 可见序号，depth = 视觉深度。仅收藏栏传。 */
  dndRow?: { containerId: string; index: number; depth: number };
  /** 收藏分组树(仅 BookmarkCategory 传;用于「移动到分组」子菜单)。 */
  groups?: GroupNode[];
  /** 移动到指定组(null = 未分组);仅 BookmarkCategory 传。 */
  onMovePathToGroup?: (pathId: string, groupId: string | null) => void;
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
  // v0.3.3 用户裁决 8A:badge 只统计未退出的 session(活跃终端数量)。
  const activeCount = sessions.filter((s) => s.state !== 'exited').length;
  // BETA-014:优先用 Category 算好的去重名;退到本节点 displayName / 末段
  const displayName = displayNameOverride ?? node.displayName ?? formatPathDisplayName(node);

  // v0.3.3 Feature E.2:仅收藏栏(传 sortableId)启用拖拽。useSortable 是条件调用 ——
  // React hooks 规则要求顶层调用,故用 sortableId 是否为空区分启用,但 hook 本身始终调。
  // 临时/最近传 undefined → useSortable({id: undefined}) 不参与任何 SortableContext,零开销。
  const sortable = useSortable({
    id: sortableId ?? `disabled-path:${node.id}`,
    disabled: !sortableId,
    data: { type: 'bookmark-path', ...(dndRow ? { rowKind: 'path', ...dndRow } : {}) },
  });
  // DragOverlay 负责跟手；源 li 固定留在原位充当等高 source placeholder。
  const sortableProps = sortableId
    ? {
        ref: sortable.setNodeRef,
        ...sortable.attributes,
        ...sortable.listeners,
      }
    : {};

  // 同 path session 拖拽：列表容器是唯一 droppable，按指针 y 在子行中点
  // 单调推导插入索引；不渲染任何占位 placeholder，列表高度恒定。
  const sessionSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );
  const [sessionDragState, setSessionDragState] = useState<SessionDragState | null>(null);
  const sessionListRef = useRef<HTMLUListElement | null>(null);
  // 同 BookmarkCategory：DragOverlay 跟随有延迟，拖拽期间缓存真实指针 clientY。
  const sessionPointerYRef = useRef<number | null>(null);
  const isSessionDragging = !!sessionDragState;
  useEffect(() => {
    if (!isSessionDragging) return undefined;
    const onMove = (e: PointerEvent): void => {
      sessionPointerYRef.current = e.clientY;
    };
    window.addEventListener('pointermove', onMove, { passive: true, capture: true });
    return () => window.removeEventListener('pointermove', onMove, { capture: true });
  }, [isSessionDragging]);
  const sessionCollisionDetection: CollisionDetection = (args) =>
    pointerWithin(args).filter((collision) => {
      const data = args.droppableContainers.find((container) => container.id === collision.id)?.data
        .current as { kind?: string } | undefined;
      return data?.kind === 'session-list';
    });
  const resolveSessionIndex = (
    pointerY: number,
    activeId: string,
  ): { index: number; lineTop: number } | null => {
    const ul = sessionListRef.current;
    if (!ul) return null;
    return computeInsertionAtY(ul, pointerY, activeId, 'sessionId');
  };
  const handleSessionDragEnd = (event: DragEndEvent, sess: SessionInfo[]): void => {
    const last = sessionDragState;
    setSessionDragState(null);
    const activeId = String(event.active.id);
    const targetIndex = last?.targetIndex;
    if (typeof targetIndex !== 'number') return;
    const withoutActive = sess.map((session) => session.id).filter((id) => id !== activeId);
    if (withoutActive.length === sess.length) return;
    const clamped = Math.max(0, Math.min(targetIndex, withoutActive.length));
    withoutActive.splice(clamped, 0, activeId);
    const current = sess.map((session) => session.id);
    if (current.every((id, index) => id === withoutActive[index])) return;
    window.api
      .invoke(COMMAND_CHANNELS.SESSION_REORDER, {
        pathId: node.id,
        orderedSessionIds: withoutActive,
      })
      .catch((err: unknown) => {
        console.warn('[PathItem] session reorder rejected:', err);
        toast.push({
          kind: 'error',
          message: `调整终端顺序失败:${err instanceof Error ? err.message : String(err)}`,
        });
      });
  };

  // M1-C:行内重命名 (仅收藏支持)
  const [renaming, setRenaming] = useState(false);
  const [renameText, setRenameText] = useState(displayName);
  // 只对本地收藏路径开放：SSH 路径指向另一台未运行 Marina 的机器，不能安全地
  // 创建 .pi/.claude/.agents 项目目录；远程 backend 则由 daemon 正常处理。
  const [skillInstallerOpen, setSkillInstallerOpen] = useState(false);
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

  // 双击去抖:单击选中 path 不能立即派发,否则双击序列里的第一击会先派发
  // view/select-path —— 在 hideTopTabBar 模式下该 reducer 会无条件清空
  // selectedSessionId,于是主区在 dblclick 触发 SESSION_CREATE 并返回之前
  // 一直显示 EmptyPathState(新建终端页),表现为“先闪一下新建页再创建终端”。
  // 把单击选中延后一个双击阈值窗口,DBLCLICK 在窗口内到达时取消这次选中,
  // 双击就只会“直接新建终端”而不会先切到新建页。
  // 这是文件管理器/终端启动器的标准 click-vs-dblclick 消歧模式。
  const pendingSelectTimer = useRef<number | null>(null);
  const DBLCLICK_DISAMBIG_MS = 230;
  // 组件卸载时清掉挂起的 timer,避免卸载后派发 dispatch(React 会告警)。
  useEffect(() => {
    return () => {
      if (pendingSelectTimer.current !== null) {
        window.clearTimeout(pendingSelectTimer.current);
      }
    };
  }, []);

  const handleSelect = (): void => {
    if (renaming) return;
    if (pendingSelectTimer.current !== null) {
      window.clearTimeout(pendingSelectTimer.current);
    }
    pendingSelectTimer.current = window.setTimeout(() => {
      pendingSelectTimer.current = null;
      dispatch({ type: 'view/select-path', pathId: node.id });
    }, DBLCLICK_DISAMBIG_MS);
  };

  const handleToggleExpand = (e: MouseEvent<HTMLSpanElement>): void => {
    e.stopPropagation();
    dispatch({ type: 'view/toggle-path-expand', pathId: node.id });
  };

  const handleDoubleClick = async (): Promise<void> => {
    // 双击 = 在该 path 下用默认模板新建 session
    // 取消挂起的单击选中(view/select-path),否则它会在 SESSION_CREATE
    // 期间把 selectedSessionId 清空,闪一下新建页(见 handleSelect 注释)。
    if (pendingSelectTimer.current !== null) {
      window.clearTimeout(pendingSelectTimer.current);
      pendingSelectTimer.current = null;
    }
    // 优先级:bookmark.defaultTemplateId > 全局 defaultTemplateId > 'shell' 兜底
    const templateId = node.defaultTemplateId ?? state.defaultTemplateId ?? 'shell';
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
      // 乐观 dispatch sessions/created:把新 session 立即写入 state 并选中它
      // (reducer 同时设 selectedPathId + 展开 path)。
      //
      // 为什么不用 view/select-path + view/select-session:在 hideTopTabBar 模式下
      // view/select-path 会清空 selectedSessionId(强制进 EmptyPathState);若此时
      // evt:session:created 广播还没到(远程 session / 慢机),select-session 设的
      // id 尚不在 sessions 里,getDisplayableSession 返回 null → 主区闪一下新建页。
      // 乐观 sessions/created 直接补进 state + 选中,广播后到达再幂等覆盖,全程无空窗。
      dispatch({ type: 'sessions/created', session: res.session });
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

  /** 设置默认模板(「默认模板」子菜单共用;null = 跟随全局默认)。 */
  const setDefaultTemplate = (templateId: string | null): void => {
    window.api
      .invoke(COMMAND_CHANNELS.BOOKMARK_SET_DEFAULT_TEMPLATE, {
        pathId: node.id,
        templateId,
      })
      .catch((err: unknown) =>
        toast.push({
          kind: 'error',
          message: `设置默认模板失败:${err instanceof Error ? err.message : String(err)}`,
        }),
      );
  };

  // v0.3.3 用户裁决 5A:菜单按用户任务分区;机器相关动作只在用户看得见结果的
  // 地方出现。分区:打开/定位(仅客户端本机路径)→ 复制 → 组织(收藏)→
  // 启动方式(收藏)→ 项目工具。移除收藏只做移除,不暗中清最近记录。
  const showExplorer = window.api.backendProfileId === null && node.kind !== 'ssh';
  const handleContextMenu = (e: MouseEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    const items: ContextMenuItem[] = [];

    // ── 打开/定位 + 复制 ──
    if (showExplorer) {
      items.push({
        label: '在文件管理器中显示',
        icon: <FolderOpen size={13} />,
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
    items.push({
      label: '复制路径',
      icon: <Copy size={13} />,
      onSelect: () => copyToClipboard(node.path, '路径'),
    });

    if (node.category === 'bookmarked') {
      // ── 组织(仅收藏) ──
      items.push({ divider: true, label: '' });
      items.push({ label: '重命名…', icon: <Pencil size={13} />, onSelect: beginRename });
      if (groups && onMovePathToGroup) {
        const moveItems: ContextMenuItem[] = [
          {
            label: '未分组',
            checked: !node.groupId,
            disabled: !node.groupId,
            onSelect: () => onMovePathToGroup(node.id, null),
          },
          { divider: true, label: '' },
        ];
        const walk = (nodes: GroupNode[], depth: number): void => {
          for (const g of nodes) {
            const indent = depth > 0 ? '　'.repeat(depth) : '';
            moveItems.push({
              label: `${indent}${g.name}`,
              checked: node.groupId === g.id,
              disabled: node.groupId === g.id,
              onSelect: () => onMovePathToGroup(node.id, g.id),
            });
            walk(g.subgroups ?? [], depth + 1);
          }
        };
        walk(groups, 0);
        items.push({ label: '移动到分组', icon: <FolderInput size={13} />, submenu: moveItems });
      }
      items.push({
        label: '移除收藏',
        icon: <Trash2 size={13} />,
        danger: true,
        onSelect: () => {
          // 只移除收藏;无 session 时路径按状态机自动进「最近」,不在这里
          // 暗中清掉最近记录(菜单项只做它说的事)。
          window.api
            .invoke(COMMAND_CHANNELS.BOOKMARK_REMOVE, { pathId: node.id })
            .then(() => toast.push({ kind: 'success', message: `已移除收藏 ${displayName}` }))
            .catch((err: unknown) =>
              toast.push({
                kind: 'error',
                message: `移除失败:${err instanceof Error ? err.message : String(err)}`,
              }),
            );
        },
      });

      // ── 启动方式:默认模板(子菜单,首项「跟随全局默认」) ──
      items.push({
        label: '默认模板',
        submenu: [
          {
            label: '跟随全局默认',
            checked: !node.defaultTemplateId,
            onSelect: () => setDefaultTemplate(null),
          },
          { divider: true, label: '' },
          ...state.templates.map(
            (template): ContextMenuItem => ({
              label: `${template.icon} ${template.name}`,
              hint: template.command ? `启动命令: ${template.command}` : '系统默认 shell',
              checked: template.id === node.defaultTemplateId,
              onSelect: () => setDefaultTemplate(template.id),
            }),
          ),
        ],
      });

      // ── 项目工具(当前 backend 的本地路径可用) ──
      if (node.kind === 'local' && !node.invalid) {
        items.push({ divider: true, label: '' });
        items.push({
          label: '安装 Marina Skill…',
          hint: '为 Pi / Claude Code / Codex 安装 show-in-marina',
          onSelect: () => setSkillInstallerOpen(true),
        });
      }
    } else if (node.category === 'temporary' || node.category === 'recent') {
      items.push({ divider: true, label: '' });
      items.push({
        label: '加入收藏',
        icon: <FolderPlus size={13} />,
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
    <>
      <li
        className={`path-item${selected ? ' selected' : ''}${node.invalid ? ' invalid' : ''}${sortableId && sortable.isDragging ? ' dragging' : ''}`}
        data-path-id={node.id}
        {...(dndRow
          ? {
              'data-path-container-id': dndRow.containerId,
              'data-path-index': dndRow.index,
              'data-path-depth': dndRow.depth,
            }
          : {})}
        {...sortableProps}
      >
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
            <span className="path-session-count" title={`${activeCount} 个活跃终端`}>
              {activeCount}
            </span>
          )}
        </div>
        {expanded && sessions.length > 0 && (
          <DndContext
            sensors={sessionSensors}
            measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
            collisionDetection={sessionCollisionDetection}
            onDragStart={(event) => setSessionDragState({ activeId: String(event.active.id) })}
            onDragMove={(event) => {
              const pointerY =
                sessionPointerYRef.current ??
                (() => {
                  const r = event.active.rect.current.translated;
                  return r ? r.top + r.height / 2 : -Infinity;
                })();
              const activeId = String(event.active.id);
              const resolved = resolveSessionIndex(pointerY, activeId);
              if (!resolved) return;
              const ul = sessionListRef.current;
              const hostRect = ul?.getBoundingClientRect();
              const indicator: DropIndicatorGeometry | undefined =
                ul && hostRect
                  ? {
                      top: resolved.lineTop,
                      left: 28,
                      width: Math.max(40, ul.clientWidth - 28 - DROP_INDICATOR_RIGHT_PAD_PX),
                    }
                  : undefined;
              setSessionDragState({
                activeId,
                targetIndex: resolved.index,
                ...(indicator ? { indicator } : {}),
              });
            }}
            onDragEnd={(event) => handleSessionDragEnd(event, sessions)}
            onDragCancel={() => setSessionDragState(null)}
          >
            <SortableContext
              items={sessions.map((session) => session.id)}
              strategy={verticalListSortingStrategy}
            >
              <SessionListDropTarget
                ulRef={(node) => {
                  sessionListRef.current = node;
                }}
                pathId={node.id}
                enabled={!!sessionDragState}
              >
                {sessions.map((session) => (
                  <SessionItem
                    key={session.id}
                    session={session}
                    myWindowId={state.myWindowId}
                    selected={state.selectedSessionId === session.id}
                    template={state.templates.find(
                      (template) => template.id === session.templateId,
                    )}
                    sortableId={session.id}
                  />
                ))}
                {sessionDragState?.indicator ? (
                  <DropIndicator geom={sessionDragState.indicator} />
                ) : null}
              </SessionListDropTarget>
            </SortableContext>
            <DragOverlay dropAnimation={null}>
              {sessionDragState ? (
                <div className="bookmark-drag-overlay session">
                  <Icon name="templateShell" size={12} />
                  <span>
                    {sessions.find((session) => session.id === sessionDragState.activeId)
                      ?.displayName ?? '终端'}
                  </span>
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        )}
      </li>
      {skillInstallerOpen && (
        <SkillInstallDialog
          projectPath={node.path}
          projectName={displayName}
          onClose={() => setSkillInstallerOpen(false)}
          onSuccess={(message) => toast.push({ kind: 'success', message })}
          onError={(message) => toast.push({ kind: 'error', message, durationMs: 10000 })}
        />
      )}
    </>
  );
}

interface SessionItemProps {
  session: SessionInfo;
  /** 父级传入 — 避免本组件订阅 state.myWindowId 触发无关重渲 */
  myWindowId: string;
  /** 父级传入 — 同上,避免订阅 state.selectedSessionId */
  selected: boolean;
  /** 模板图标数据；snapshot 尚未同步模板时为 undefined，回退通用终端 icon。 */
  template?: Pick<Template, 'id' | 'icon'> | undefined;
  /**
   * v0.3.3 Feature E.2:传了才启用 @dnd-kit 拖拽(同 path 内排序)。
   * 不传 → useSortable 被 disabled,零 dnd 开销(与 PathItem 同样模式)。
   */
  sortableId?: string;
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
  template,
  sortableId,
}: SessionItemProps): JSX.Element {
  const dispatch = useAppDispatch();
  const ctxMenu = useContextMenuApi();
  const toast = useToast();
  const stateRef = useAppStateRef();
  const isMine = session.ownerWindowId === myWindowId;
  const ownedByOther = session.ownerWindowId !== null && session.ownerWindowId !== myWindowId;
  // generation 守卫:每次 orphan 接管递增并捕获序号。claim 是异步的,迟到的失败
  // 回滚必须只在「用户没有再点别的终端」时才执行 —— 否则会覆盖用户后续已经成功的
  // 选择(例如快速连点 A→B→C,C 成功后 B 的迟到失败不该把用户拽回 A)。
  const claimGenRef = useRef(0);

  // v0.3.3 Feature E.2:同 path 内 session 拖序(仅传 sortableId 时启用)。
  const sessionSortable = useSortable({
    id: sortableId ?? `disabled-session:${session.id}`,
    disabled: !sortableId,
    data: { type: 'session' },
  });

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
        // 关闭走统一续看逻辑(关掉当前终端时自动切到同目录另一个无主终端)。
        // SessionItem 刻意不订阅 useAppState(防抖动),这里用 stateRef.current。
        onClose: (sid) => void closeSessionWithContinue(stateRef.current, dispatch, sid),
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

    const gen = ++claimGenRef.current;
    claimSession(session.id).catch((err) => {
      console.error('[Sidebar] claim failed, rolling back', err);
      // generation 守卫:若用户在此期间又点了别的终端(claimGenRef 已推进),
      // 不要用这次迟到的失败覆盖用户的新选择。
      if (claimGenRef.current !== gen) return;
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
      data-session-id={session.id}
      className={`session-item${selected ? ' selected' : ''}${
        ownedByOther ? ' owned-by-other' : ''
      }${session.state === 'exited' ? ' exited' : ''}${
        // v0.3.3 E.3(T06 定稿):active 行挂 active-session class,供 CSS 反色文字 +
        // 满底背景。详见 global.css .session-state-bar 注释。
        session.state === 'active' ? ' active-session' : ''
      }${sortableId && sessionSortable.isDragging ? ' dragging' : ''}`}
      {...(sortableId
        ? {
            ref: sessionSortable.setNodeRef,
            ...sessionSortable.attributes,
            ...sessionSortable.listeners,
          }
        : {})}
      onClick={() => void handleClick()}
      onContextMenu={handleContextMenu}
      title={fullTitle}
    >
      {/* v0.3.3 Feature E.3(T06 定稿,2026-08-02):
          状态色条从「3px 细条颜色呼吸」升级为「细条变宽覆盖整行背景」动画。
          设计(见原型 docs/prototypes/e3-colorbar-prototype.html + ADR):
          - 一个绝对定位的背景层(.session-state-bar),背景恒为 info 色;
          - idle/exited:width 3px(左侧细竛条);active:width 100%(满底覆盖);
          - width 走 transition(1s cubic-bezier,ease-out-expo),idle↔active 正逆都平滑;
          - active 稳态:opacity 脉冲(2.6s);active 行文字反色(bg-primary)。
          配色用 var(--color-info)(跟主题变,T06 裁决),不 color-mix 派生。
          exited 色=灰(text-muted),死亡态额外靠 exit-code 图标 + 整行 dim 区分。
          注:旧设计「idle 黄/active 绿呼吸/exited 灰」(T07 issue 原文)已废弃。 */}
      <span
        className="session-state-bar"
        data-state={session.state}
        data-unviewed={session.hasUnviewedWork && session.state === 'idle' ? 'true' : undefined}
        aria-label={`状态: ${session.state}`}
      />
      <span className="session-template-icon" aria-hidden="true">
        {template ? (
          <TemplateIcon template={template} size={12} />
        ) : (
          <Icon name="templateShell" size={12} />
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
        <span className="session-exit-code" title={`已退出 (exitCode=${session.exitCode ?? 0})`}>
          {/* v0.3.3 E.3:竛条版退出状态图标——成功 Check / 失败 X / 未知 circleDot。
              原本叠在 9px 圆点上的 check/X 迁到这里(竛条太窄放不下),并合并掉旧的
              中性 circleDot 占位,一处表达退出成败。 */}
          {session.exitCode === 0 ? (
            <Check size={11} className="session-exit-icon ok" />
          ) : (
            <X size={11} className="session-exit-icon fail" />
          )}
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
