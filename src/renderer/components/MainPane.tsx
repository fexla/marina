/**
 * @file src/renderer/components/MainPane.tsx
 * @purpose 右侧主区域:TabBar (当前 path 下的 sessions) + 终端区
 *   (本窗口持有的 session 显示 xterm,否则显示新建终端页面)。
 *
 * @关键设计 (CP-2 勘误后):
 * - "持有 = 显示" 不变量:TerminalView 只在 displayableSession (即 selected
 *   且 owner=myWindow 的) 不为 null 时挂载。selected 但 owner != myWindow
 *   (orphan / 他人持有) 时显示 EmptyPathState 新建终端页 — 没有"接管会话"
 *   占位 UI (用户勘误反思 #3)
 * - TabBar 顺序稳定:本窗口持有的 + orphan 按 path 下 sessions 的原始顺序
 *   排列;只把"其他窗口持有"的单独抽到最右端灰显 (用户勘误 #1)
 *   Tab 自己根据 session.ownerWindowId 决定 variant
 * - SESSION_CREATE 调用统一从 state.lastTerminalDims 读 cols/rows,避免
 *   spawn 80×24 然后 resize 到 142×42 触发的 ConPTY 重画 PowerShell 横幅
 *   (用户勘误 #2)
 * - main-pane 容器挂 ResizeObserver,持续把粗估的 cols/rows 写进 store
 *   (字号 × 0.6 估字宽,字号 × lineHeight 估行高);TerminalView 第一次
 *   xterm fit 后会用真实值覆盖
 *
 * @对应文档章节: 软件定义书.md 6.3 (右侧标签页)、6.4 (终端区域)
 */
import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
} from 'react';
import {
  COMMAND_CHANNELS,
  type CreateSessionResponse,
} from '@shared/protocol';
import type { SessionInfo } from '@shared/types';
import {
  findMyOwnedSessionId,
  getDisplayableSession,
  getSessionsInSelectedPath,
  useAppDispatch,
  useAppState,
} from '../store';
import { TerminalView } from './TerminalView';
import { Icon } from './icons';
import { useContextMenuApi } from './ContextMenu';
import { useToast } from './Toast';

export function MainPane(): JSX.Element {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const sessions = getSessionsInSelectedPath(state);
  const displayable = getDisplayableSession(state);

  const containerRef = useRef<HTMLElement | null>(null);
  const fontSize = state.settings.appearance?.terminalFontSize ?? 13;
  const lineHeight = state.settings.appearance?.terminalLineHeight ?? 1.2;

  // M1-B:拖 Explorer 文件夹到终端区 → 在该路径用默认模板新建终端 (spec 7.3)
  const [dragOver, setDragOver] = useState(false);

  const handleDragOver = (e: DragEvent<HTMLElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLElement>): void => {
    // 只在真正离开容器时清,避免子元素 dragenter 引起 flash
    if (e.currentTarget === e.target) setDragOver(false);
  };

  const handleDrop = async (e: DragEvent<HTMLElement>): Promise<void> => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);

    const files = Array.from(e.dataTransfer.files);
    const dims = state.lastTerminalDims;
    for (const file of files) {
      const path = (file as File & { path?: string }).path;
      if (!path) continue;
      // 默认模板:全局 default,与 Sidebar 双击行为对齐 (无 bookmark 上下文)
      const templateId = state.defaultTemplateId ?? 'shell';
      try {
        const res = await window.api.invoke<unknown, CreateSessionResponse>(
          COMMAND_CHANNELS.SESSION_CREATE,
          { pathId: path, templateId, cols: dims.cols, rows: dims.rows },
        );
        dispatch({ type: 'view/select-path', pathId: res.session.pathId });
        dispatch({ type: 'view/select-session', sessionId: res.session.id });
      } catch (err) {
        console.error('[MainPane] drop create-session failed', err);
      }
    }
  };

  // ResizeObserver:把主区容器尺寸 + 字号 → 估算 cols/rows → 写入 store。
  // SESSION_CREATE 调用点统一读 store.lastTerminalDims,确保 spawn PTY 时
  // 尺寸接近 xterm fit 后的值,避免 ConPTY 重画 banner 重复进 ring buffer。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const update = (): void => {
      // monospace 字宽 ≈ 字号 × 0.6;cell 高 = 字号 × lineHeight。
      // 这是粗估 (xterm 真实算法考虑 letterSpacing 等),首次创建时差几列
      // 不致命;TerminalView 一旦 mount 会用 fit 后的精确值覆盖。
      const charWidth = fontSize * 0.6;
      const cellHeight = fontSize * lineHeight;
      // 主区扣掉 statusbar (约 24px) 和 padding (8px*2),保留有效区域
      const usableW = Math.max(0, el.clientWidth - 16);
      const usableH = Math.max(0, el.clientHeight - 56);
      const cols = Math.max(20, Math.floor(usableW / charWidth));
      const rows = Math.max(5, Math.floor(usableH / cellHeight));
      dispatch({ type: 'view/update-terminal-dims', dims: { cols, rows } });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [dispatch, fontSize, lineHeight]);

  const dropProps = {
    onDragOver: handleDragOver,
    onDragLeave: handleDragLeave,
    onDrop: (e: DragEvent<HTMLElement>) => void handleDrop(e),
  };

  if (!state.selectedPathId) {
    return (
      <main
        className={`main-pane${dragOver ? ' drag-over' : ''}`}
        ref={containerRef}
        {...dropProps}
      >
        <WelcomeState />
        {dragOver && <DropHint />}
      </main>
    );
  }

  return (
    <main
      className={`main-pane${dragOver ? ' drag-over' : ''}`}
      ref={containerRef}
      {...dropProps}
    >
      <TabBar sessions={sessions} selectedSessionId={state.selectedSessionId} />
      {displayable ? (
        <TerminalView
          // 用 sessionId 作 key,确保切换时彻底重建 xterm 实例
          key={displayable.id}
          session={displayable}
          myWindowId={state.myWindowId}
        />
      ) : (
        <EmptyPathState pathId={state.selectedPathId} />
      )}
      {dragOver && <DropHint />}
    </main>
  );
}

function DropHint(): JSX.Element {
  return (
    <div className="main-pane-drop-hint" aria-hidden="true">
      <div className="main-pane-drop-hint-inner">
        松开鼠标 — 在该文件夹打开新终端
      </div>
    </div>
  );
}

function WelcomeState(): JSX.Element {
  return (
    <div className="welcome-state">
      <h2>Marina</h2>
      <p>从左侧选一个路径开始,或点击 <strong>收藏 +</strong> 添加文件夹。</p>
    </div>
  );
}

function EmptyPathState({ pathId }: { pathId: string }): JSX.Element {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const [creating, setCreating] = useState(false);

  // CP-3:每个模板按钮直接用对应模板创建 session。
  // 加号按钮 → 用 path 自身的默认模板 (若收藏路径) 或全局默认模板。
  const pathDefaultTemplateId = findDefaultTemplateForPath(state, pathId);

  const handleCreate = async (templateId: string): Promise<void> => {
    if (creating) return;
    setCreating(true);
    try {
      const dims = state.lastTerminalDims;
      const res = await window.api.invoke<unknown, CreateSessionResponse>(
        COMMAND_CHANNELS.SESSION_CREATE,
        { pathId, templateId, cols: dims.cols, rows: dims.rows },
      );
      dispatch({ type: 'view/select-session', sessionId: res.session.id });
    } catch (err) {
      console.error('[MainPane] create-session failed', err);
    } finally {
      setCreating(false);
    }
  };

  const templates = state.templates;

  return (
    <div className="empty-path-state">
      <button
        type="button"
        className="empty-create-btn"
        onClick={() => void handleCreate(pathDefaultTemplateId)}
        disabled={creating}
        aria-label="在此路径用默认模板新建终端"
        title={`默认模板:${
          templates.find((t) => t.id === pathDefaultTemplateId)?.name ?? pathDefaultTemplateId
        }`}
      >
        +
      </button>
      <p className="empty-hint">在 <code>{pathId}</code> 新建终端</p>
      <div className="empty-templates">
        {templates.map((t) => (
          <button
            key={t.id}
            type="button"
            className="template-button"
            onClick={() => void handleCreate(t.id)}
            disabled={creating}
            title={t.command ? `${t.name} — 启动命令: ${t.command}` : t.name}
          >
            <span className="template-icon">{t.icon}</span>
            <span className="template-label">{t.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function findDefaultTemplateForPath(
  state: ReturnType<typeof useAppState>,
  pathId: string,
): string {
  const node = state.pathTree.bookmarks.find((p) => p.id === pathId);
  return node?.defaultTemplateId ?? state.defaultTemplateId ?? 'shell';
}

interface TabBarProps {
  sessions: SessionInfo[];
  selectedSessionId: string | null;
}

function TabBar({ sessions, selectedSessionId }: TabBarProps): JSX.Element {
  const state = useAppState();
  const dispatch = useAppDispatch();

  const handleNewTab = async (): Promise<void> => {
    if (!state.selectedPathId) return;
    // 用该 path 的默认模板 (收藏路径有自定义默认 → 用它)
    const templateId = findDefaultTemplateForPath(state, state.selectedPathId);
    try {
      const dims = state.lastTerminalDims;
      const res = await window.api.invoke<unknown, CreateSessionResponse>(
        COMMAND_CHANNELS.SESSION_CREATE,
        {
          pathId: state.selectedPathId,
          templateId,
          cols: dims.cols,
          rows: dims.rows,
        },
      );
      dispatch({ type: 'view/select-session', sessionId: res.session.id });
    } catch (err) {
      console.error('[TabBar] new tab failed', err);
    }
  };

  // CP-3 勘误 #5:**彻底**移除"灰显抽到最右边"的分组逻辑。
  // 直接按 path.sessionIds 顺序渲染所有 tab — 不分组、不重排。
  // 灰显 / orphan / mine 的视觉差由 Tab 自己根据 ownerWindowId 决定 variant,
  // 与位置无关。
  //
  // 顺序保证:sessions 来自 getSessionsInSelectedPath → path.sessionIds,
  // 这个数组 PathManager 用 push 追加 (创建顺序);任何 owner 切换 / 状态
  // 变化都不会 reorder,所以同一窗口的同一 path 看到的 tab 顺序在 session
  // 生命周期内稳定。侧栏 SessionItem 也用同一数组顺序,两边自然同步。
  // 拖拽改顺序是 V1.2 工作 (软件定义书 5.2、7.3 规划)。
  return (
    <div className="tab-bar">
      <div className="tab-list">
        {sessions.map((s) => (
          <Tab
            key={s.id}
            session={s}
            myWindowId={state.myWindowId}
            selected={s.id === selectedSessionId}
          />
        ))}
      </div>
      <button
        type="button"
        className="tab-new-btn"
        onClick={() => void handleNewTab()}
        title="新建终端"
      >
        +
      </button>
    </div>
  );
}

interface TabProps {
  session: SessionInfo;
  myWindowId: string;
  selected: boolean;
}

function Tab({ session, myWindowId, selected }: TabProps): JSX.Element {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const ctxMenu = useContextMenuApi();
  const toast = useToast();

  // Variant 由 session.ownerWindowId 自决,不再由父级分组传入。这样 tab
  // 即使移动 (虽然现在不再重排) 也不会丢 variant。
  const variant: 'mine' | 'orphan' | 'other' =
    session.ownerWindowId === myWindowId
      ? 'mine'
      : session.ownerWindowId === null
        ? 'orphan'
        : 'other';

  const copyToClipboard = (text: string, label: string): void => {
    navigator.clipboard
      .writeText(text)
      .then(() => toast.push({ kind: 'success', message: `已复制 ${label}` }))
      .catch(() => toast.push({ kind: 'error', message: '复制失败' }));
  };

  const handleContextMenu = (e: MouseEvent<HTMLButtonElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    const path =
      state.pathTree.bookmarks.find((p) => p.id === session.pathId)?.path ||
      state.pathTree.temporary.find((p) => p.id === session.pathId)?.path ||
      state.pathTree.recent.find((p) => p.id === session.pathId)?.path ||
      session.originalCwd;

    ctxMenu.open({
      x: e.clientX,
      y: e.clientY,
      title: session.displayName,
      items: [
        {
          label: '重命名…',
          disabled: variant !== 'mine',
          ...(variant !== 'mine' ? { hint: '本窗口不是持有者,无法重命名' } : {}),
          onSelect: () => {
            const next = window.prompt('新名称', session.displayName);
            if (!next) return;
            window.api
              .invoke(COMMAND_CHANNELS.SESSION_RENAME, {
                sessionId: session.id,
                newDisplayName: next,
              })
              .catch((err: unknown) =>
                toast.push({
                  kind: 'error',
                  message: `重命名失败:${err instanceof Error ? err.message : String(err)}`,
                }),
              );
          },
        },
        {
          label: '复制路径',
          onSelect: () => copyToClipboard(path, '路径'),
        },
        {
          label: '复制 cwd',
          onSelect: () => copyToClipboard(session.currentCwd, 'cwd'),
        },
        {
          label: '在 Explorer 中显示',
          onSelect: () => {
            window.api
              .invoke(COMMAND_CHANNELS.SYSTEM_SHOW_IN_EXPLORER, { path })
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
          label: '关闭',
          danger: true,
          disabled: variant === 'other',
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

  const handleClick = (e: MouseEvent<HTMLButtonElement>): void => {
    e.preventDefault();
    if (variant === 'other') {
      // 其他窗口持有 → 聚焦那个窗口,所有权不变 (软件定义书 8.4)
      window.api
        .invoke(COMMAND_CHANNELS.SESSION_FOCUS_OWNER, {
          sessionId: session.id,
        })
        .catch((err) => console.error('[Tab] focus-owner failed', err));
      return;
    }
    if (variant === 'orphan') {
      // 乐观接管:本地立即改 owner + select,消除"+按钮闪一下"现象。
      // claim 失败 (race: SessionAlreadyOwned/NotFound,几乎不会发生)
      // 时再 dispatch 回滚到之前持有状态。
      const prevOwnedId = findMyOwnedSessionId(state);
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
      dispatch({ type: 'view/select-session', sessionId: session.id });

      window.api
        .invoke(COMMAND_CHANNELS.SESSION_CLAIM, { sessionId: session.id })
        .catch((err) => {
          console.error('[Tab] claim failed, rolling back', err);
          // 回滚:目标变回 orphan,旧持有变回 myWindow
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
      return;
    }
    // 本窗口持有 (mine):仅切换 view (新模型下其实 myTabs 至多 1 个,
    // 多数场景这就是当前 selected — no-op,但保留分支以防 race)
    dispatch({ type: 'view/select-session', sessionId: session.id });
  };

  const handleClose = (e: MouseEvent<HTMLSpanElement>): void => {
    e.stopPropagation();
    window.api
      .invoke(COMMAND_CHANNELS.SESSION_CLOSE, { sessionId: session.id })
      .catch((err) => console.error('[Tab] close failed', err));
  };

  // ADR-008:cwd 漂移提示。session.pathId 永久不变,只有 currentCwd 与
  // originalCwd 不一致时才显示 ⚠️。
  const cwdDrifted =
    !!session.currentCwd &&
    !!session.originalCwd &&
    session.currentCwd.toLowerCase() !== session.originalCwd.toLowerCase();

  const tooltipParts: string[] = [];
  if (variant === 'other') {
    tooltipParts.push(`${session.displayName} (在其他窗口)`);
  } else {
    tooltipParts.push(session.displayName);
  }
  if (cwdDrifted) {
    tooltipParts.push(`当前目录 → ${session.currentCwd}`);
    tooltipParts.push(`(原: ${session.originalCwd})`);
  }
  if (session.state === 'exited') {
    tooltipParts.push(`已退出 (exitCode=${session.exitCode ?? 0})`);
  }

  return (
    <button
      type="button"
      className={
        `tab` +
        (selected ? ' selected' : '') +
        (variant === 'other' ? ' owned-by-other' : '') +
        (variant === 'orphan' ? ' orphan' : '') +
        (session.state === 'exited' ? ' exited' : '') +
        (session.state === 'idle' ? ' idle' : '') +
        (session.state === 'active' ? ' active' : '')
      }
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      title={tooltipParts.join('\n')}
    >
      <span
        className={`tab-state-dot tab-state-${session.state}`}
        aria-label={`状态: ${session.state}`}
      />
      <span className="tab-name">{session.displayName}</span>
      {cwdDrifted && (
        <span className="tab-cwd-drift" aria-label="当前目录已变">
          <Icon name="alertTriangle" size={11} />
        </span>
      )}
      {variant !== 'other' && (
        <span
          className="tab-close"
          onClick={handleClose}
          title="关闭"
          role="button"
        >
          ×
        </span>
      )}
    </button>
  );
}
