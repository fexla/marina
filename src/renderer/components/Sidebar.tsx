/**
 * @file src/renderer/components/Sidebar.tsx
 * @purpose 三栏侧栏 (收藏 / 临时 / 最近),路径节点 + 子 session 节点。
 *   含 + 按钮调文件夹选择器、拖文件夹到收藏区加入收藏 (drag-drop)、
 *   单击选中、双击新建 session、右键菜单 (CP-2 简化菜单)。
 *
 * @关键设计:
 * - 三栏始终显示,即使空 (软件定义书 6.2.1: 默认全部展开)
 * - 同 path 在三栏不重叠;每个 path 节点可展开看 sessions
 * - sessions 显示状态点 (active 绿 / idle 黄 / tombstoned 灰)、
 *   是否被其他窗口持有 (灰显 + ↗ 图标)
 * - 拖 Explorer 文件夹到 .sidebar-bookmarks-dropzone (CP-2 完成标志):
 *   先校验 file:// path 是否存在且是目录,然后调 cmd:bookmark:add
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
import { useToast } from './Toast';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';

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
  active: 'var(--pine, #f0f)',
  idle: 'var(--gold, #f0f)',
  exited: 'var(--muted, #f0f)',
};

// ──────────────────────────────────────────────────────────────────
// M1-C:全局 ContextMenuProvider 提到 App.tsx,这里只 useContextMenuApi。
// 旧版内嵌 provider 已删除,文件因此短了 100+ 行。
// ──────────────────────────────────────────────────────────────────

export function Sidebar(): JSX.Element {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const toast = useToast();
  const { t } = useTranslation();
  const [dragOver, setDragOver] = useState(false);

  const handlePickFolder = async (): Promise<void> => {
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
      console.error('[Sidebar] pick-folder + add-bookmark failed', err);
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
      // 这里再显式 dispatch 一次 select-path,防御性把视图切到该路径。
      dispatch({ type: 'view/select-path', pathId: res.session.pathId });
    } catch (err) {
      toast.push({
        kind: 'error',
        message: `打开文件夹失败:${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  /**
   * F10(beta 勘误2 续 v3):dropzone 拖拽全面重做。
   *
   * 历史问题:
   * - F8 心跳超时解决了"虚线框驻留"
   * - F9 加了文件类型过滤 + 浮卡 + inset 阴影,但用户反馈:
   *     (a) 左边框看不到 — overflow:hidden + 滚动容器下 inset box-shadow
   *         在左侧渲染不稳定
   *     (b) 鼠标在禁止/可放置之间闪烁 — dropEffect 只在 .sidebar-bookmarks-dropzone
   *         区设了 'copy';一旦光标飘出该子元素(footer 上方、滚动条 gutter、
   *         category header 间缝隙、或快速移动让 dragover 没赶上),回落到
   *         App.tsx 的 window-level dragover 兜底 preventDefault 但没设
   *         dropEffect,Chromium 落回 'none' 显示禁止图标。
   *
   * 新方案:
   * 1. drag handlers 提到整个 .sidebar (aside) — hit area 一口气覆盖,不再
   *    有"在 sidebar 内但又不在 dropzone"的真空区。
   * 2. dropEffect = 'copy' 无条件设(只要 preventDefault 了),不再做内部
   *    isFileDrag 过滤就停手 — 即便后续不接受,先把光标稳住。
   * 3. 边框靠独立的 `.sidebar-drag-overlay` 绝对定位 div,position:fixed-like
   *    inset:0 覆盖整个 sidebar,普通 border 而非 inset shadow,绕开 overflow
   *    渲染坑。pointer-events:none 不挡 drop。
   * 4. 心跳超时机制保留(F8)— 处理拖出窗口 / ESC 场景。
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
   * 仅用于 setDragOver 视觉态判定,不再用来决定是否 preventDefault。
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
    // 关键:无条件 preventDefault + dropEffect — 让 Chromium 在整个 sidebar
    // 区域稳定显示"复制"光标,杜绝光标闪烁。stopPropagation 阻止 App.tsx
    // 的 window-level dragover 在同一事件上重复处理。
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    // 视觉态只在真文件拖拽时激活,避免文本/内部拖拽误显高亮 + 浮卡。
    if (isFileDrag(e)) {
      setDragOver(true);
      clearDragOverSoon();
    }
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
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          dispatch({ type: 'view/select-path', pathId: null });
        }
      }}
      onDragOver={handleDragOver}
      onDrop={(e) => void handleDrop(e)}
    >
      {/* F10:独立 overlay 节点 — 覆盖整个 sidebar 区域。普通 border + 平滑过渡,
          避开 inset box-shadow 在 overflow:hidden + 滚动容器下渲染不稳的坑。
          pointer-events: none 不阻挡 drop。aria-hidden 视觉装饰不进无障碍树。
          dragOver=false 时整体 opacity:0(transition fade-out),不影响布局。 */}
      <div className="sidebar-drag-overlay" aria-hidden="true">
        <div className="sidebar-drop-hint">
          <span className="sidebar-drop-hint-icon">📁</span>
          <span className="sidebar-drop-hint-label">{t('sidebar.dropHint')}</span>
        </div>
      </div>
      <div className="sidebar-bookmarks-dropzone">
        <Category
          title={t('sidebar.category.bookmark')}
          iconName="bookmark"
          paths={state.pathTree.bookmarks}
          actionLabel="+"
          actionTitle={t('sidebar.addBookmark.title')}
          onAction={() => void handlePickFolder()}
        />
        <Category
          title={t('sidebar.category.temporary')}
          iconName="clock"
          paths={state.pathTree.temporary}
          actionLabel="+"
          actionTitle={t('sidebar.addTemporary.title')}
          onAction={() => void handlePickFolderForTemp()}
        />
        <Category title={t('sidebar.category.recent')} iconName="history" paths={state.pathTree.recent} />
        {/* BETA-011:系统路径分组。空数组(设置整体关闭 / 全部逐项关闭)时不渲染。 */}
        {state.pathTree.systemPaths.length > 0 && (
          <Category
            title={t('sidebar.category.system')}
            iconName="monitor"
            paths={state.pathTree.systemPaths}
          />
        )}
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
    </aside>
  );
}

interface CategoryProps {
  title: string;
  iconName: IconName;
  paths: PathNode[];
  actionLabel?: string;
  actionTitle?: string;
  onAction?: () => void;
}

function Category({
  title,
  iconName,
  paths,
  actionLabel,
  actionTitle,
  onAction,
}: CategoryProps): JSX.Element {
  // BETA-014:同 category 内末级文件夹同名时自动补父目录区分;手动命名的不参与。
  const displayNames = useMemo(() => disambiguatePathNames(paths), [paths]);
  return (
    <section className="sidebar-category">
      <header className="sidebar-category-header">
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
            onClick={onAction}
            title={actionTitle}
          >
            {actionLabel}
          </button>
        )}
      </header>
      {paths.length === 0 ? (
        <p className="sidebar-empty">空</p>
      ) : (
        <ul className="sidebar-paths">
          {paths.map((p) => {
            const override = displayNames.get(p.id);
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
    displayNameOverride ?? node.displayName ?? lastSegmentOf(node.path);

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
        pathId: node.path,
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
          pathId: node.path,
          templateId,
          cols: dims.cols,
          rows: dims.rows,
        },
      );
      // 先切 path (会自动选 my-owned firstSid,但新创建的可能不是 firstSid),
      // 再显式 select 新创建的 session。两次 dispatch 在 React 18 自动 batch。
      dispatch({ type: 'view/select-path', pathId: node.id });
      dispatch({ type: 'view/select-session', sessionId: res.session.id });
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

    if (node.category === 'bookmarked') {
      items.push({ divider: true, label: '' });
      items.push({ label: '重命名…', onSelect: beginRename });
      items.push({
        label: '移除收藏',
        danger: true,
        onSelect: () => {
          window.api
            .invoke(COMMAND_CHANNELS.BOOKMARK_REMOVE, { pathId: node.path })
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
                pathId: node.path,
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
            .invoke(COMMAND_CHANNELS.BOOKMARK_ADD, { path: node.path })
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
              .invoke(COMMAND_CHANNELS.PATH_REMOVE_FROM_RECENT, { path: node.path })
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
    const tpl = stateRef.current.templates.find((t) => t.id === session.templateId);
    const fullCmd = tpl
      ? `${tpl.command || '(纯 shell)'} ${tpl.args.join(' ')}`.trim()
      : '(模板未找到)';

    ctxMenu.open({
      x: e.clientX,
      y: e.clientY,
      title: session.displayName,
      items: [
        {
          // 与 Tab 同口径:仅"其他窗口持有"时灰显;orphan / 本窗口持有 都允许。
          // 原 `disabled: !isMine` 把 orphan 也灰掉,与 spec 6.3 不符。
          label: '重命名…',
          disabled: ownedByOther,
          ...(ownedByOther ? { hint: '其他窗口持有,无法重命名' } : {}),
          onSelect: beginRename,
        },
        {
          label: '复制路径',
          onSelect: () => copyToClipboard(session.pathId, '路径'),
        },
        {
          label: '复制 cwd',
          onSelect: () => copyToClipboard(session.currentCwd, 'cwd'),
        },
        {
          label: `复制 PID${session.pid > 0 ? ` (${session.pid})` : ''}`,
          disabled: session.pid <= 0,
          onSelect: () => copyToClipboard(String(session.pid), 'PID'),
        },
        {
          label: '在 Explorer 中显示',
          onSelect: () => {
            window.api
              .invoke(COMMAND_CHANNELS.SYSTEM_SHOW_IN_EXPLORER, { path: session.pathId })
              .catch((err: unknown) =>
                toast.push({
                  kind: 'error',
                  message: `打开 Explorer 失败:${err instanceof Error ? err.message : String(err)}`,
                }),
              );
          },
        },
        { divider: true, label: '' },
        {
          label: `完整命令:${fullCmd}`,
          disabled: true,
          hint: fullCmd,
        },
        { divider: true, label: '' },
        {
          label: '关闭',
          danger: true,
          disabled: ownedByOther,
          onSelect: () => {
            window.api
              .invoke(COMMAND_CHANNELS.SESSION_CLOSE, { sessionId: session.id })
              .catch((err: unknown) =>
                toast.push({
                  kind: 'error',
                  message: `关闭失败:${err instanceof Error ? err.message : String(err)}`,
                }),
              );
          },
        },
      ],
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

function lastSegmentOf(path: string): string {
  // 跨平台:取 / 或 \ 分隔的最后一段;空字符串 / 根路径回退到原路径
  const m = path.match(/[^/\\]+$/);
  return m ? m[0] : path;
}
