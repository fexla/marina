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
  FolderInput,
  Pencil,
  Trash2,
  X,
} from 'lucide-react';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  COMMAND_CHANNELS,
  type AddBookmarkResponse,
  type CreateSessionResponse,
  type PickFolderResponse,
} from '@shared/protocol';
import type { GroupNode, PathNode, SessionInfo, SshProfile } from '@shared/types';
import { disambiguatePathNames } from '@shared/path-display';
import { hasAnyRemote } from '@shared/remote-visibility';
import { useTranslation } from './LanguageProvider';
import { findMyOwnedSessionId, useAppDispatch, useAppState, useAppStateRef } from '../store';
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
  const [segment, setSegmentState] = useState<SidebarSegment>(() => readSegmentFromStorage());
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
   * 新建收藏分组。
   *
   * 入口统一放在根级分类与现有分组的右键菜单中，不再在收藏列表底部常驻一个
   * 虚线按钮：分组是低频组织动作，常驻按钮会打断路径列表的视觉节奏。仍使用
   * 项目自绘 Modal；Electron renderer 中原生 window.prompt 会直接返回 null。
   */
  const addGroupPrompt = async (): Promise<void> => {
    const name = await modal.prompt({
      title: t('sidebar.group.add') || '新建分组',
      message: t('sidebar.group.add') || '输入分组名称',
      placeholder: '分组名',
      confirmLabel: '新建',
    });
    if (!name?.trim()) return;
    try {
      await window.api.invoke(COMMAND_CHANNELS.BOOKMARK_GROUP_ADD, { name: name.trim() });
    } catch (err) {
      toast.push({
        kind: 'error',
        message: `新建分组失败:${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  /** 根级分类（收藏 / 临时 / 最近）共用的新建分组右键菜单。 */
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
   * 远程段:给指定 SSH profile 弹路径 prompt 并添加远程收藏。
   * 与设置页「添加远程文件夹」同协议(REMOTE_BOOKMARK_ADD)。
   */
  const promptRemotePathFor = async (profile: SshProfile): Promise<void> => {
    const remotePath = await modal.prompt({
      title: `添加远程文件夹 — ${profile.name}`,
      message: `输入 ${profile.username}@${profile.host} 上的目录路径。`,
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
  };

  /**
   * 收藏栏 "+" 按钮。按当前 segment 走不同流程:
   *
   * - 本地段:beta.9 行为 — 系统 folder picker → BOOKMARK_ADD
   * - 远程段:先定服务器再输远端路径。单 profile 直接 prompt(标题带服务器名);
   *   多 profile 弹服务器菜单让用户选(v1.14 修复 —— 原实现硬编码
   *   profiles[0],配了多个服务器时侧栏只能给第一个加收藏,要别的得绕设置页)。
   *   零 profile 时 toast 引导用户去设置(showSegmented 已经保证不会出现
   *   0 profile + 不能切远程段的状态,但 enableRemote=true 仍可能 0 profile)。
   */
  const handleAddBookmark = async (e?: React.MouseEvent<HTMLButtonElement>): Promise<void> => {
    if (effectiveSegment === 'remote') {
      const profiles = state.sshProfiles;
      if (profiles.length === 0) {
        toast.push({
          kind: 'warn',
          message: '请先在 设置 → 远程 添加 SSH 服务器',
        });
        return;
      }
      if (profiles.length === 1) {
        void promptRemotePathFor(profiles[0]!);
        return;
      }
      // 多 profile:先选服务器(菜单锚在 + 按钮正下方)。
      const rect = e?.currentTarget.getBoundingClientRect();
      ctxMenu.open({
        x: rect?.left ?? 0,
        y: rect ? rect.bottom : 0,
        items: profiles.map((p) => ({
          label: `${p.name} (${p.username}@${p.host})`,
          onSelect: () => void promptRemotePathFor(p),
        })),
      });
      return;
    }
    // 本地段:beta.9 行为
    try {
      const result = await window.api.invoke<unknown, PickFolderResponse>(
        COMMAND_CHANNELS.BOOKMARK_PICK_FOLDER,
        {},
      );
      if (result.path === null) return;
      await window.api.invoke<unknown, AddBookmarkResponse>(COMMAND_CHANNELS.BOOKMARK_ADD, {
        path: result.path,
      });
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
      // session 创建后:乐观 dispatch sessions/created 立即写入 state + 选中它
      // (reducer 同时设 selectedPathId + 展开)。替代原先的 view/select-path +
      // view/select-session —— 后者在 hideTopTabBar 模式下会因 select-path 清空
      // selectedSessionId 而闪一下 EmptyPathState(广播晚于 invoke 返回时)。
      dispatch({ type: 'sessions/created', session: res.session });
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
          aria-label={t('sidebar.segment.label') || '本地 / 远程'}
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
          groups={groupsFiltered}
          collapsed={isCategoryCollapsed('bookmark')}
          onToggleCollapsed={() => handleToggleCategory('bookmark')}
          onContextMenu={(e) =>
            openAddGroupContextMenu(e, t('sidebar.category.bookmark') || '收藏')
          }
          onRequestAddGroup={() => void addGroupPrompt()}
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
          onContextMenu={(e) =>
            openAddGroupContextMenu(e, t('sidebar.category.temporary') || '临时')
          }
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
          onContextMenu={(e) => openAddGroupContextMenu(e, t('sidebar.category.recent') || '最近')}
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
  /** 根级分类右键菜单（v0.3.3：提供低频的“新建分组”入口）。 */
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

// ╔══════════════════════════════════════════════════════════════════╗
// ║  v0.3.3 ADR-025 / Feature E.1+E.2:收藏分组渲染 + @dnd-kit 拖序       ║
// ╚══════════════════════════════════════════════════════════════════╝
// 设计:
// - 收藏栏(Category=bookmark)用 BookmarkCategory 替换原平铺渲染:
//   未分组块(隐式,顶置)+ 各分组块(组头:折叠/重命名/删组)。
// - 分组折叠态走 L2 偏好 usePanelPreference(附录 G.1),不裸 localStorage。
// - 拖序走 @dnd-kit 多容器:未分组 + 各组各为 SortableContext(共享 DndContext),
//   拖动跨容器=移组,拖动同容器=组内排序;拖完发分层 BOOKMARK_REORDER。
// - 临时/最近栏不受影响(决策 #13:只收藏可分组/可拖序)。
// - 排序能力直接内联进 PathItem 的 <li>(传 sortableId 才启用),避免额外的
//   包裹 <li> 造成 li 嵌套(无效 HTML)。临时/最近不传 → 零 dnd 开销。
const UNGROUPED_CONTAINER = '__marina_ungrouped__';

/**
 * 分组头:折叠/展开、组名、重命名、删组。
 * 折叠态走 usePanelPreference(panelId='sidebar', key='groupCollapsed', 默认空 Set)。
 * 右键菜单集中承载“新建 / 重命名 / 删除”；行尾编辑按钮仍保留为可见快捷入口。
 */
function GroupHeader({
  group,
  collapsed,
  onToggleCollapse,
  onRequestAddGroup,
}: {
  group: GroupNode;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onRequestAddGroup: () => void;
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

  const handleDelete = (): void => {
    // 删组:子 path 归未分组,绝不删 path。后端已保证;这里给个 toast 反馈。
    window.api
      .invoke(COMMAND_CHANNELS.BOOKMARK_GROUP_REMOVE, { id: group.id })
      .then(() =>
        toast.push({
          kind: 'success',
          message: `已删除分组「${group.name}」,其下路径已归到未分组`,
        }),
      )
      .catch((err: unknown) => {
        toast.push({
          kind: 'error',
          message: `删除分组失败:${err instanceof Error ? err.message : String(err)}`,
        });
      });
  };

  const openGroupContextMenu = (e: MouseEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    ctxMenu.open({
      x: e.clientX,
      y: e.clientY,
      title: group.name,
      items: [
        {
          label: t('sidebar.group.add') || '新建分组',
          icon: <FolderInput size={13} />,
          onSelect: onRequestAddGroup,
        },
        { divider: true, label: '' },
        {
          label: t('sidebar.group.rename') || '重命名分组',
          icon: <Pencil size={13} />,
          onSelect: beginRename,
        },
        {
          label: t('sidebar.group.remove') || '删除分组',
          icon: <Trash2 size={13} />,
          danger: true,
          onSelect: handleDelete,
        },
      ],
    });
  };

  return (
    <div
      className="sidebar-group-header"
      onClick={onToggleCollapse}
      onContextMenu={openGroupContextMenu}
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
          <Icon name="folder" size={12} />
          {group.name}
        </span>
      )}
      <span className="sidebar-group-actions">
        <button
          type="button"
          className="sidebar-group-action"
          onClick={(e) => {
            e.stopPropagation();
            beginRename();
          }}
          title={t('sidebar.group.rename') || '重命名分组'}
        >
          <Pencil size={11} />
        </button>
        <button
          type="button"
          className="sidebar-group-action"
          onClick={(e) => {
            e.stopPropagation();
            handleDelete();
          }}
          title={t('sidebar.group.remove') || '删除分组(路径归到未分组)'}
        >
          <Trash2 size={11} />
        </button>
      </span>
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
  groups,
  collapsed,
  onToggleCollapsed,
  onContextMenu,
  onRequestAddGroup,
  actionLabel,
  actionTitle,
  onAction,
  displayNames,
}: {
  paths: PathNode[];
  groups: GroupNode[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onContextMenu: (e: MouseEvent<HTMLElement>) => void;
  onRequestAddGroup: () => void;
  actionLabel?: ReactNode;
  actionTitle?: string;
  /** 事件带出,供调用方定位弹层锚点(如远程段选服务器菜单) */
  onAction?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  displayNames: Map<string, string>;
}): JSX.Element {
  const { t } = useTranslation();
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
    for (const g of groups) m.set(g.id, []);
    for (const p of paths) {
      if (p.groupId && m.has(p.groupId)) m.get(p.groupId)!.push(p);
    }
    return m;
  }, [paths, groups]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  /**
   * 拖完重算完整布局并发 BOOKMARK_REORDER。
   * 多容器 dnd-kit:active.id 是被拖 pathId,over.id 是落点 pathId(或组占位),
   * over.data.current?.sortable?.containerId 告诉落在哪个容器。
   */
  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    const fromContainer =
      (active.data.current?.sortable as { containerId?: string } | undefined)?.containerId ??
      UNGROUPED_CONTAINER;
    // over 可能是某 path(有 containerId),也可能是空容器的 droppable id(=containerId 本身)
    const overContainer =
      (over.data.current?.sortable as { containerId?: string } | undefined)?.containerId ?? overId;

    // 取源 / 目标容器的当前顺序(克隆后操作)。
    const listFor = (containerId: string): PathNode[] => {
      if (containerId === UNGROUPED_CONTAINER) return ungrouped.slice();
      return (byGroup.get(containerId) ?? []).slice();
    };
    const fromList = listFor(fromContainer);
    const toList = fromContainer === overContainer ? fromList : listFor(overContainer);

    const fromIdx = fromList.findIndex((p) => p.id === activeId);
    if (fromIdx < 0) return;
    const [moved] = fromList.splice(fromIdx, 1);

    if (fromContainer === overContainer) {
      const overIdx = toList.findIndex((p) => p.id === overId);
      if (overIdx < 0) toList.push(moved);
      else toList.splice(overIdx, 0, moved);
    } else {
      // 跨容器:落到 over path 前;over 是空容器占位则追加末尾。
      const overIdx = toList.findIndex((p) => p.id === overId);
      if (overIdx < 0) toList.push(moved);
      else toList.splice(overIdx, 0, moved);
    }

    // 回填到 ungrouped / byGroup 的视图(本次 render 内的乐观更新);
    // 真值由后端 BOOKMARK_REORDER 后 evt:path:tree-updated 回灌。
    if (fromContainer === UNGROUPED_CONTAINER) {
      ungrouped.splice(0, ungrouped.length, ...fromList);
    } else {
      byGroup.set(fromContainer, fromList);
    }
    if (overContainer === UNGROUPED_CONTAINER) {
      ungrouped.splice(0, ungrouped.length, ...toList);
    } else if (overContainer !== fromContainer) {
      byGroup.set(overContainer, toList);
    }

    // 组装分层 payload(groups 顺序 = 当前 groups 数组顺序)。
    const payloadGroups = groups.map((g) => ({
      id: g.id,
      childOrder: (byGroup.get(g.id) ?? []).map((p) => p.id),
    }));
    const ungroupedIds = ungrouped.map((p) => p.id);
    window.api
      .invoke(COMMAND_CHANNELS.BOOKMARK_REORDER, { ungrouped: ungroupedIds, groups: payloadGroups })
      .catch((err: unknown) => {
        // 后端校验失败(理论上不会,因为我们用真值组装)——吞掉,等 tree 回灌纠偏。
        console.warn('[BookmarkCategory] reorder rejected:', err);
      });
  };

  const renderPath = (p: PathNode): JSX.Element => {
    const override = p.kind === 'ssh' ? undefined : displayNames.get(p.id);
    return (
      <PathItem
        key={p.id}
        node={p}
        sortableId={p.id}
        {...(override !== undefined ? { displayNameOverride: override } : {})}
      />
    );
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <section className={`sidebar-category${collapsed ? ' collapsed' : ''}`}>
        <header
          className="sidebar-category-header"
          onClick={onToggleCollapsed}
          onContextMenu={onContextMenu}
          title={collapsed ? '展开分组' : '折叠分组'}
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
          <div className="sidebar-bookmark-groups">
            {/* 未分组块(隐式,顶置):有未分组 path 才渲染。*/}
            <SortableContext
              items={ungrouped.map((p) => p.id)}
              strategy={verticalListSortingStrategy}
              id={UNGROUPED_CONTAINER}
            >
              {ungrouped.length > 0 && (
                <ul className="sidebar-paths sidebar-ungrouped">{ungrouped.map(renderPath)}</ul>
              )}
            </SortableContext>
            {/* 各分组块(按 groups 顺序)。*/}
            {groups.map((g) => {
              const gPaths = byGroup.get(g.id) ?? [];
              const isCollapsed = collapsedSet.has(g.id);
              return (
                <div className="sidebar-group" key={g.id}>
                  <GroupHeader
                    group={g}
                    collapsed={isCollapsed}
                    onToggleCollapse={() => toggleGroup(g.id)}
                    onRequestAddGroup={onRequestAddGroup}
                  />
                  {!isCollapsed && (
                    <SortableContext
                      items={gPaths.map((p) => p.id)}
                      strategy={verticalListSortingStrategy}
                      id={g.id}
                    >
                      <ul className="sidebar-paths sidebar-group-paths">
                        {gPaths.map(renderPath)}
                      </ul>
                    </SortableContext>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </DndContext>
  );
}

function PathItem({
  node,
  displayNameOverride,
  sortableId,
}: {
  node: PathNode;
  displayNameOverride?: string;
  /**
   * v0.3.3 Feature E.2:传了才启用 @dnd-kit 拖拽(仅收藏栏传,临时/最近不传)。
   * id = node.id;不传时 useSortable 不被调用,零 dnd 开销。
   */
  sortableId?: string;
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
  const displayName = displayNameOverride ?? node.displayName ?? formatPathDisplayName(node);

  // v0.3.3 Feature E.2:仅收藏栏(传 sortableId)启用拖拽。useSortable 是条件调用 ——
  // React hooks 规则要求顶层调用,故用 sortableId 是否为空区分启用,但 hook 本身始终调。
  // 临时/最近传 undefined → useSortable({id: undefined}) 不参与任何 SortableContext,零开销。
  const sortable = useSortable({
    id: sortableId,
    disabled: !sortableId,
    data: { type: 'bookmark-path' },
  });
  const sortableStyle =
    sortableId && sortable.transform
      ? { transform: CSS.Translate.toString(sortable.transform), transition: sortable.transition }
      : undefined;
  const sortableProps = sortableId
    ? {
        ref: sortable.setNodeRef as React.LiHTMLAttributes<HTMLLIElement>['ref'],
        ...sortable.attributes,
        ...sortable.listeners,
      }
    : {};

  // v0.3.3 Feature E.2:同 path 下 session 拖序(各 path 独立 DndContext;决策 #15)。
  const sessionSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );
  const handleSessionDragEnd = (event: DragEndEvent, sess: SessionInfo[]): void => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const fromIdx = sess.findIndex((s) => s.id === active.id);
    const overIdx = sess.findIndex((s) => s.id === over.id);
    if (fromIdx < 0 || overIdx < 0) return;
    // 重排:从 fromIdx 删掉插到 overIdx 前。
    const ordered = sess.map((s) => s.id);
    const [moved] = ordered.splice(fromIdx, 1);
    ordered.splice(overIdx, 0, moved);
    window.api
      .invoke(COMMAND_CHANNELS.SESSION_REORDER, { pathId: node.id, orderedSessionIds: ordered })
      .catch((err: unknown) => {
        console.warn('[PathItem] session reorder rejected:', err);
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
      if (node.kind === 'local' && !node.invalid) {
        items.push({
          label: '安装 Marina Skill…',
          hint: '为 Pi / Claude Code / Codex 安装 show-in-marina',
          onSelect: () => setSkillInstallerOpen(true),
        });
      }
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
            .then(() => toast.push({ kind: 'success', message: `已移除收藏 ${displayName}` }))
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
    <>
      <li
        className={`path-item${selected ? ' selected' : ''}${node.invalid ? ' invalid' : ''}${sortableId && sortable.isDragging ? ' dragging' : ''}`}
        style={sortableStyle}
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
            <span className="path-session-count" title={`${activeCount} 个终端`}>
              {activeCount}
            </span>
          )}
        </div>
        {expanded && sessions.length > 0 && (
          <DndContext
            sensors={sessionSensors}
            collisionDetection={closestCenter}
            onDragEnd={(e) => handleSessionDragEnd(e, sessions)}
          >
            <SortableContext
              items={sessions.map((s) => s.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="session-list">
                {sessions.map((s) => (
                  <SessionItem
                    key={s.id}
                    session={s}
                    myWindowId={state.myWindowId}
                    selected={state.selectedSessionId === s.id}
                    sortableId={s.id}
                  />
                ))}
              </ul>
            </SortableContext>
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
    id: sortableId,
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
      className={`session-item${selected ? ' selected' : ''}${
        ownedByOther ? ' owned-by-other' : ''
      }${session.state === 'exited' ? ' exited' : ''}${
        // v0.3.3 E.3(T06 定稿):active 行挂 active-session class,供 CSS 反色文字 +
        // 满底背景。详见 global.css .session-state-bar 注释。
        session.state === 'active' ? ' active-session' : ''
      }${sortableId && sessionSortable.isDragging ? ' dragging' : ''}`}
      style={
        sortableId && sessionSortable.transform
          ? {
              transform: CSS.Translate.toString(sessionSortable.transform),
              transition: sessionSortable.transition,
            }
          : undefined
      }
      {...(sortableId
        ? {
            ref: sessionSortable.setNodeRef as React.LiHTMLAttributes<HTMLLIElement>['ref'],
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
        aria-label={`状态: ${session.state}`}
      />
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
