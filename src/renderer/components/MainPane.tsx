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
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import {
  COMMAND_CHANNELS,
  type CreateSessionResponse,
  type ListShellsResponse,
} from '@shared/protocol';
import { formatPathDisplayPath } from '@shared/path-display';
import type { SessionInfo, Template } from '@shared/types';
import {
  findMyOwnedSessionId,
  findPathNode,
  getDisplayableSession,
  getSessionsInSelectedPath,
  useAppDispatch,
  useAppState,
} from '../store';
import { TerminalView } from './TerminalView';
import { LayoutHost } from './layout/LayoutHost';
import { focusTerminalDom } from '../focus';
import { Icon, type IconName } from './icons';
import { TemplateIcon } from './TemplateIcon';
import { useContextMenuApi } from './ContextMenu';
import { useToast } from './Toast';
import { useModal } from './Modal';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import { useCloseSession } from '../hooks/useCloseSession';
import { buildSessionContextMenu } from './sessionContextMenu';
import { useTranslation } from './LanguageProvider';

interface DetectedShell {
  id: string;
  displayName: string;
  executablePath: string;
}

// ── 终端尺寸估算用常量(P2-25) ──
// 这是"PTY spawn 前的兜底估算":xterm 实际 mount 后由 fitAddon 写回真实
// cols/rows,本估算只在 SESSION_CREATE 还没拿到真实尺寸时给一个合理初值。
//
// MONO_CHAR_ASPECT:等宽字符宽 / 字号 的经验比例。Cascadia / JBM / consolas
// 等程序员字体在多数字号下宽高比稳定在 0.55-0.62 之间,取 0.6 是中位估值。
// 即便偏离 ±10%,估算的 cols 偏差也只是 ±10% — fitAddon mount 后立即纠正。
const MONO_CHAR_ASPECT = 0.6;
// TerminalView 容器周围的固定 chrome:左右各 ~12px 内边距,顶部 tabbar 32px +
// statusbar 24px = 56px。这两个常量配合容器 clientWidth/Height 估出可用区域。
const TERMINAL_HOST_PADDING_X = 24;
const TERMINAL_HOST_CHROME_Y = 56;
// 兜底下限:就算容器尺寸异常(0 或负),也至少给 PTY 一个 spawn 能跑起来的初值。
const MIN_COLS = 20;
const MIN_ROWS = 5;

// builtinTemplateIcon 已抽到 TemplateIcon 组件复用(P2-14)。

/**
 * shell id → lucide 图标。WindowsAdapter.getShellCandidates 用的 id
 * (pwsh / powershell / cmd / git-bash) 都有对应映射;其他平台未来扩展时
 * 落到 templateShell 兜底。
 */
function shellIcon(id: string): IconName {
  if (id === 'wsl' || id.startsWith('wsl:')) return 'shell';
  switch (id) {
    case 'pwsh':
      return 'shellPwsh';
    case 'powershell':
      return 'shellPowershell';
    case 'cmd':
      return 'shellCmd';
    case 'git-bash':
      return 'shellGitBash';
    default:
      return 'templateShell';
  }
}

function getWslDistroName(path: string): string | null {
  const match = path.match(/^\\\\(?:wsl\$|wsl\.localhost)\\([^\\]+)(?:\\|$)/i);
  return match?.[1] ?? null;
}

function filterShellsForWslPath(
  shells: DetectedShell[],
  distroName: string | null,
): DetectedShell[] {
  if (!distroName) return shells;
  const targetId = `wsl:${distroName}`.toLowerCase();
  const distroShells = shells.filter((s) => s.id.toLowerCase() === targetId);
  if (distroShells.length > 0) return distroShells;
  return shells.filter((s) => s.id.toLowerCase() === 'wsl');
}

export function MainPane(): JSX.Element {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const sessions = getSessionsInSelectedPath(state);
  const displayable = getDisplayableSession(state);

  const containerRef = useRef<HTMLElement | null>(null);
  const fontSize = state.settings.appearance?.terminalFontSize ?? 13;
  const lineHeight = state.settings.appearance?.terminalLineHeight ?? 1.2;

  // FOC-6:selectedSessionId 变化时(托盘点击 / 跨窗口聚焦 /
  // evt:window:focus-requested / view/select-session 等任意路径)
  // 把焦点送到新 session 的 xterm。
  //
  // 与 A1/A2 的关系:
  // - A1 在 TerminalView mount 时 term.focus() — 覆盖新建 + 切 session(key 重建)
  // - A2 在 Tab / Chrome / Template button click 末尾 focusTerminalDom — 显式
  // - A4 此 effect 兜底所有 dispatch 路径(reducer 改 selectedSessionId 但
  //   没人显式 focus 的场景,如 sessions/created reducer 自动 select)
  //
  // displayable 为 null(EmptyPathState)时不送焦点 — xterm 不存在,
  // focusTerminalDom 内部 querySelector 会 no-op 安全。
  useEffect(() => {
    if (state.selectedSessionId) focusTerminalDom();
  }, [state.selectedSessionId]);

  // 勘误第二轮:移除"拖文件夹到主区 → 新建终端"自定义。原 M1-B 的 onDragOver
  // preventDefault 把整个 main-pane 变成 droptarget,xterm 元素接不到 drop
  // 事件,Windows Terminal-风格的"拖文件到终端 → 粘贴路径"默认行为被吃掉。
  // 现在:主区不处理 drop 事件,事件穿透到 .terminal-host,xterm 沿用默认行为。
  // 加文件夹到收藏仍由 Sidebar 处理。

  // FLK-2:把主区容器尺寸 + 字号 → 估算 cols/rows → 写入 store。
  //
  // 历史:原版本挂 ResizeObserver 持续 dispatch dims,会和 TerminalView
  // 内部的 RO 双写抖动 — 拖窗时 chrome 每帧 layout 更新但 xterm 网格滞后
  // 150ms,体感"周边在跳但终端慢半拍"。
  //
  // 现在:只在 mount 时算一次,作为"PTY spawn 前的兜底估算"用,后续真实
  // 尺寸完全由 TerminalView mount 后的 fitAddon.fit() 写回 store
  // (TerminalView 是单一权威)。
  //
  // 字号 / 行高变化触发重算 — 用户改字号后再新建 session 时尺寸更准。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const charWidth = fontSize * MONO_CHAR_ASPECT;
    const cellHeight = fontSize * lineHeight;
    const usableW = Math.max(0, el.clientWidth - TERMINAL_HOST_PADDING_X);
    const usableH = Math.max(0, el.clientHeight - TERMINAL_HOST_CHROME_Y);
    const cols = Math.max(MIN_COLS, Math.floor(usableW / charWidth));
    const rows = Math.max(MIN_ROWS, Math.floor(usableH / cellHeight));
    dispatch({ type: 'view/update-terminal-dims', dims: { cols, rows } });
  }, [dispatch, fontSize, lineHeight]);

  if (!state.selectedPathId) {
    return (
      <main className="main-pane" ref={containerRef}>
        <WelcomeState />
      </main>
    );
  }

  return (
    <main className="main-pane" ref={containerRef}>
      {/* BETA-027:简易模式下 Tab bar 隐藏(浮动工具栏由 App.tsx 直接渲染)
          issue #4:appearance.hideTopTabBar=true 时也隐藏 TabBar(Sidebar 仍在) */}
      {!state.simpleMode && !state.settings.appearance?.hideTopTabBar && (
        <TabBar
          sessions={sessions}
          selectedSessionId={state.selectedSessionId}
          showBlankTab={!displayable}
        />
      )}
      <div className="terminal-area">
        {displayable ? (
          !state.simpleMode && state.settings.filePanel?.enabled ? (
            <LayoutHost
              // LayoutHost 按 session 的 main 端 tree 渲染终端主区 + 固定右 dock。
              // sessionId 改变时整体重挂，避免 FileTree/FilePanel 暂态串到新 terminal。
              key={`layout-${displayable.id}`}
              session={displayable}
              terminal={<TerminalView key={displayable.id} session={displayable} />}
            />
          ) : (
            <TerminalView key={displayable.id} session={displayable} />
          )
        ) : (
          <EmptyPathState pathId={state.selectedPathId} />
        )}
      </div>
    </main>
  );
}

function WelcomeState(): JSX.Element {
  const { tx } = useTranslation();
  return (
    <div className="welcome-state">
      <h2>Marina</h2>
      <p>
        {tx('从左侧选一个路径开始,或点击', 'Pick a path on the left, or click')}{' '}
        <strong>{tx('收藏 +', 'Bookmark +')}</strong> {tx('添加文件夹。', 'to add a folder.')}
      </p>
    </div>
  );
}

function EmptyPathState({ pathId }: { pathId: string }): JSX.Element {
  const { tx } = useTranslation();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const node = findPathNode(state.pathTree, pathId);
  const isSshPath = node?.kind === 'ssh';
  const wslDistroName = node ? getWslDistroName(node.path) : null;
  const isWslPath = !!wslDistroName;
  const displayPath = isSshPath && node ? node.path : node ? formatPathDisplayPath(node) : pathId;
  // 勘误第二轮 #3:启动期拉一次 detectShells,缓存到组件状态。SessionManager
  // 内部已 cache,所以二次以上调用是 O(1)。
  const [shells, setShells] = useState<DetectedShell[] | null>(null);

  useEffect(() => {
    if (isSshPath) {
      setShells([]);
      return;
    }
    let cancelled = false;
    window.api
      .invoke<unknown, ListShellsResponse>(COMMAND_CHANNELS.SETTINGS_LIST_SHELLS, {})
      .then((res) => {
        if (!cancelled) setShells(res.shells);
      })
      .catch((err) => {
        console.warn('[EmptyPathState] list-shells failed', err);
        if (!cancelled) setShells([]); // 失败 → 不显示 shell 区段,但仍允许模板按钮
      });
    return () => {
      cancelled = true;
    };
  }, [isSshPath]);

  const handleCreate = async (
    templateId: string,
    shellId?: string,
    sshTmuxMode?: 'disabled' | 'attach-or-create',
  ): Promise<void> => {
    if (creating) return;
    setCreating(true);
    try {
      const dims = state.lastTerminalDims;
      const res = await window.api.invoke<unknown, CreateSessionResponse>(
        COMMAND_CHANNELS.SESSION_CREATE,
        {
          pathId,
          templateId,
          ...(shellId ? { shellId } : {}),
          ...(isSshPath ? { sshTmuxMode: sshTmuxMode ?? 'disabled' } : {}),
          cols: dims.cols,
          rows: dims.rows,
        },
      );
      // 乐观 dispatch sessions/created:广播(evt:session:created)可能晚于 invoke
      // 返回,此时 select-session 设的 id 还不在 state 里 → getDisplayableSession
      // 返回 null → 闪一下新建页。直接把 res.session 写入 state + 选中,无空窗。
      dispatch({ type: 'sessions/created', session: res.session });
      if (res.warning) {
        toast.push({ kind: 'warn', message: tx(res.warning, res.warning) });
      }
      // FOC-3:模板按钮点击后焦点漂在 button 上,挂载 TerminalView 后
      // 自动把焦点送回 xterm。A4 的 selectedSessionId effect 也会兜底,
      // 但显式 + rAF 让"立即可打字"语义更清晰。
      focusTerminalDom();
    } catch (err) {
      console.error('[MainPane] create-session failed', err);
      toast.push({
        kind: 'error',
        message: tx(
          `新建终端失败:${err instanceof Error ? err.message : String(err)}`,
          `Failed to create terminal: ${err instanceof Error ? err.message : String(err)}`,
        ),
      });
    } finally {
      setCreating(false);
    }
  };

  const templates = state.templates;
  const visibleShells = shells ? filterShellsForWslPath(shells, wslDistroName) : null;
  const wslShellId = isWslPath ? visibleShells?.[0]?.id : undefined;

  return (
    <div className="empty-path-state">
      <p className="empty-hint">
        {tx('在', 'New terminal in')} <code>{displayPath}</code>
        {tx(' 新建终端', '')}
      </p>

      {isSshPath && (
        <div className="empty-section">
          <div className="empty-section-title">SSH</div>
          <div className="empty-button-grid">
            <button
              type="button"
              className="template-button"
              onClick={() => void handleCreate('shell', undefined, 'disabled')}
              disabled={creating}
              title={displayPath}
            >
              <span className="template-icon">
                <Icon name="shell" size={18} />
              </span>
              <span className="template-label">{tx('连接', 'Connect')}</span>
            </button>
            <button
              type="button"
              className="template-button"
              onClick={() => void handleCreate('shell', undefined, 'attach-or-create')}
              disabled={creating}
              title={tx(`通过 tmux 连接 ${displayPath}`, `Connect with tmux to ${displayPath}`)}
            >
              <span className="template-icon">
                <Icon name="templateShell" size={18} />
              </span>
              <span className="template-label">tmux</span>
            </button>
          </div>
        </div>
      )}

      {!isSshPath && visibleShells && visibleShells.length > 0 && (
        <div className="empty-section">
          <div className="empty-section-title">{tx('检测到的 Shell', 'Detected shells')}</div>
          <div className="empty-button-grid">
            {visibleShells.map((s) => (
              <button
                key={s.id}
                type="button"
                className="template-button"
                onClick={() => void handleCreate('shell', s.id)}
                disabled={creating}
                title={`${s.displayName}\n${s.executablePath}`}
              >
                <span className="template-icon">
                  <Icon name={shellIcon(s.id)} size={18} />
                </span>
                <span className="template-label">{s.displayName}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="empty-section">
        <div className="empty-section-title">{tx('启动模板', 'Launch templates')}</div>
        <div className="empty-button-grid">
          {(isSshPath || !isWslPath || wslShellId) &&
            templates.map((t) => (
              <TemplateLaunchButton
                key={t.id}
                template={t}
                creating={creating}
                onLaunch={() =>
                  void handleCreate(t.id, isSshPath ? undefined : wslShellId, 'disabled')
                }
              />
            ))}
        </div>
      </div>
    </div>
  );
}

function TemplateLaunchButton({
  template,
  creating,
  onLaunch,
}: {
  template: Template;
  creating: boolean;
  onLaunch: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="template-button"
      onClick={onLaunch}
      disabled={creating}
      title={template.command ? `${template.name} — 启动命令: ${template.command}` : template.name}
    >
      <span className="template-icon">
        <TemplateIcon template={template} size={18} />
      </span>
      <span className="template-label">{template.name}</span>
    </button>
  );
}

interface TabBarProps {
  sessions: SessionInfo[];
  selectedSessionId: string | null;
  /**
   * 勘误第二轮 #8:当 displayable=null 时,父级 MainPane 显示 EmptyPathState
   * 作为内容,此时 tabbar 里渲染一个"新建"占位 tab(visually selected),
   * 让"新建终端页面"看起来像一个 chrome 空白页 tab,而不是游离在标签页之外。
   */
  showBlankTab: boolean;
}

function TabBar({ sessions, selectedSessionId, showBlankTab }: TabBarProps): JSX.Element {
  const { tx } = useTranslation();
  const state = useAppState();
  const dispatch = useAppDispatch();

  const handleClickBlankTab = (): void => {
    // 已经显示 EmptyPathState → 取消选中真正的 session,确保新建页保持当前态。
    // 多数情况下 selectedSessionId 已经是非 mine 的 session id,这里只是让
    // dispatch 触发一次重算确保 view 一致。
    dispatch({ type: 'view/select-session', sessionId: null });
    // 显式 blur 占位 tab 按钮 —EmptyPathState 没有 xterm 可以 focus,
    // 但至少不应该让 button 一直 :focus 着,Tab 键导航变奇怪。
    (document.activeElement as HTMLElement | null)?.blur();
  };

  // CP-3 勘误 #5:**彻底**移除"灰显抽到最右边"的分组逻辑。
  // 直接按 path.sessionIds 顺序渲染所有 tab — 不分组、不重排。
  // 灰显 / orphan / mine 的视觉差由 Tab 自己根据 ownerWindowId 决定 variant,
  // 与位置无关。
  //
  // 勘误第二轮 #8:移除尾部 "+" 按钮 → 替换为常驻"新建" tab。新建 tab 在
  // 用户当前持有/查看其他 session 时点击即切换到 EmptyPathState,这与 Chrome
  // 的 new-tab 行为一致(不在被点之前消耗资源);自动选中只在已无 displayable
  // 时才发生(showBlankTab=true)。
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
        <button
          type="button"
          className={`tab tab-blank${showBlankTab ? ' selected' : ''}`}
          onClick={handleClickBlankTab}
          title={tx('新建终端 — 选择 Shell 或模板', 'New terminal — pick a shell or template')}
        >
          <span className="tab-blank-icon" aria-hidden="true">
            +
          </span>
          <span className="tab-name">{tx('新建', 'New')}</span>
        </button>
      </div>
    </div>
  );
}

interface TabProps {
  session: SessionInfo;
  myWindowId: string;
  selected: boolean;
}

function Tab({ session, myWindowId, selected }: TabProps): JSX.Element {
  const { tx } = useTranslation();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const ctxMenu = useContextMenuApi();
  const toast = useToast();
  const modal = useModal();
  // tab 的 × 关闭走统一续看逻辑:关掉当前正在看的终端时自动切到同目录另一个
  // 无主终端(见 useCloseSession)。与 statusbar「关闭」/ 右键菜单「关闭」一致。
  const closeSession = useCloseSession();

  // Variant 由 session.ownerWindowId 自决,不再由父级分组传入。这样 tab
  // 即使移动 (虽然现在不再重排) 也不会丢 variant。
  const variant: 'mine' | 'orphan' | 'other' =
    session.ownerWindowId === myWindowId
      ? 'mine'
      : session.ownerWindowId === null
        ? 'orphan'
        : 'other';

  // 复制到剪贴板 — 统一走 useCopyToClipboard hook(P2-11)。
  const copyToClipboard = useCopyToClipboard();

  const handleContextMenu = (e: MouseEvent<HTMLButtonElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    ctxMenu.open({
      x: e.clientX,
      y: e.clientY,
      title: session.displayName,
      items: buildSessionContextMenu(session, {
        variant,
        pathTree: state.pathTree,
        copyToClipboard,
        onClose: (sid) => void closeSession(sid),
        toastError: (message) => toast.push({ kind: 'error', message }),
        onRename: async () => {
          // Tab 端走 Modal.prompt(Sidebar 端走行内编辑,两者菜单"内容"对齐
          // 但触发体验各按各侧的惯例)。
          const next = await modal.prompt({
            title: tx('重命名会话', 'Rename session'),
            message: tx(
              '为此会话指定新的显示名(不影响 sessionId)',
              'New display name for this session (sessionId stays the same)',
            ),
            defaultValue: session.displayName,
            confirmLabel: tx('保存', 'Save'),
          });
          if (next === null) return;
          const trimmed = next.trim();
          if (!trimmed) return;
          window.api
            .invoke(COMMAND_CHANNELS.SESSION_RENAME, {
              sessionId: session.id,
              newDisplayName: trimmed,
            })
            .catch((err: unknown) =>
              toast.push({
                kind: 'error',
                message: `重命名失败:${err instanceof Error ? err.message : String(err)}`,
              }),
            );
        },
      }),
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

      window.api.invoke(COMMAND_CHANNELS.SESSION_CLAIM, { sessionId: session.id }).catch((err) => {
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
      // FOC-2:乐观接管成功路径也需要送焦点;rAF + 选择器在新 TerminalView
      // 挂上后命中。失败 rollback 后 EmptyPathState 没 xterm,focusTerminalDom
      // 会 no-op,无副作用。
      focusTerminalDom();
      return;
    }
    // 本窗口持有 (mine):仅切换 view (新模型下其实 myTabs 至多 1 个,
    // 多数场景这就是当前 selected — no-op,但保留分支以防 race)
    dispatch({ type: 'view/select-session', sessionId: session.id });
    // FOC-2:Tab click 后 button 默认接管 :focus,把焦点送回 xterm,
    // 让用户敲键立即生效。orphan 接管分支已在前文 dispatch 后落到
    // 同一 selectedSessionId 路径,A4 的 effect 会兜底;但显式调用
    // 让"点 tab → 能打字"的契约不依赖 effect 触发时机。
    focusTerminalDom();
  };

  const handleClose = (e: MouseEvent<HTMLSpanElement>): void => {
    e.stopPropagation();
    void closeSession(session.id);
  };

  // ADR-008:cwd 漂移提示。session.pathId 永久不变,只有 currentCwd 与
  // originalCwd 不一致时才显示 ⚠️。
  const cwdDrifted =
    !!session.currentCwd &&
    !!session.originalCwd &&
    session.currentCwd.toLowerCase() !== session.originalCwd.toLowerCase();

  const tooltipParts: string[] = [];
  if (variant === 'other') {
    tooltipParts.push(
      tx(`${session.displayName} (在其他窗口)`, `${session.displayName} (owned by another window)`),
    );
  } else {
    tooltipParts.push(session.displayName);
  }
  if (cwdDrifted) {
    tooltipParts.push(
      tx(`当前目录 → ${session.currentCwd}`, `Current dir → ${session.currentCwd}`),
    );
    tooltipParts.push(tx(`(原: ${session.originalCwd})`, `(orig: ${session.originalCwd})`));
  }
  if (session.state === 'exited') {
    tooltipParts.push(
      tx(
        `已退出 (exitCode=${session.exitCode ?? 0})`,
        `Exited (exitCode=${session.exitCode ?? 0})`,
      ),
    );
  }

  return (
    <button
      type="button"
      className={
        `tab` +
        (selected ? ' selected' : '') +
        (variant === 'other' ? ' owned-by-other' : '') +
        (variant === 'orphan' ? ' orphan' : '') +
        (session.state === 'exited' ? ' exited' : '')
      }
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      title={tooltipParts.join('\n')}
    >
      <span className="tab-name">{session.displayName}</span>
      {cwdDrifted && (
        <span
          className="tab-cwd-drift"
          aria-label={tx('当前目录已变', 'Current directory changed')}
        >
          <Icon name="alertTriangle" size={11} />
        </span>
      )}
      {variant !== 'other' && (
        <span className="tab-close" onClick={handleClose} title={tx('关闭', 'Close')} role="button">
          ×
        </span>
      )}
    </button>
  );
}
