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
  type MouseEvent,
} from 'react';
import {
  COMMAND_CHANNELS,
  type CreateSessionResponse,
  type ListShellsResponse,
} from '@shared/protocol';
import type { SessionInfo, Template } from '@shared/types';
import {
  findMyOwnedSessionId,
  getDisplayableSession,
  getSessionsInSelectedPath,
  useAppDispatch,
  useAppState,
} from '../store';
import { TerminalView } from './TerminalView';
import { writeClipboardText } from '../clipboard';
import { focusTerminalDom } from '../focus';
import { Icon, type IconName } from './icons';
import { useContextMenuApi } from './ContextMenu';
import { useToast } from './Toast';
import { useModal } from './Modal';

interface DetectedShell {
  id: string;
  displayName: string;
  executablePath: string;
}

/**
 * 勘误第二轮 #4:把内置模板 id 映射到 lucide 图标。已知 builtin 走矢量图标
 * (templateShell/templateClaudeCode/templateCodex/templateOpenCode);
 * 未知 / 自定义 模板回退到 template.icon emoji 字符串。
 */
function builtinTemplateIcon(id: string): IconName | null {
  switch (id) {
    case 'shell':
      return 'templateShell';
    case 'claude-code':
      return 'templateClaudeCode';
    case 'codex':
      return 'templateCodex';
    case 'opencode':
      return 'templateOpenCode';
    default:
      return null;
  }
}

/**
 * shell id → lucide 图标。WindowsAdapter.getShellCandidates 用的 id
 * (pwsh / powershell / cmd / git-bash) 都有对应映射;其他平台未来扩展时
 * 落到 templateShell 兜底。
 */
function shellIcon(id: string): IconName {
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
    const charWidth = fontSize * 0.6;
    const cellHeight = fontSize * lineHeight;
    const usableW = Math.max(0, el.clientWidth - 16);
    const usableH = Math.max(0, el.clientHeight - 56);
    const cols = Math.max(20, Math.floor(usableW / charWidth));
    const rows = Math.max(5, Math.floor(usableH / cellHeight));
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
      <TabBar
        sessions={sessions}
        selectedSessionId={state.selectedSessionId}
        showBlankTab={!displayable}
      />
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
    </main>
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
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  // 勘误第二轮 #3:启动期拉一次 detectShells,缓存到组件状态。SessionManager
  // 内部已 cache,所以二次以上调用是 O(1)。
  const [shells, setShells] = useState<DetectedShell[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.api
      .invoke<unknown, ListShellsResponse>(
        COMMAND_CHANNELS.SETTINGS_LIST_SHELLS,
        {},
      )
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
  }, []);

  const handleCreate = async (
    templateId: string,
    shellId?: string,
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
          cols: dims.cols,
          rows: dims.rows,
        },
      );
      dispatch({ type: 'view/select-session', sessionId: res.session.id });
      // FOC-3:模板按钮点击后焦点漂在 button 上,挂载 TerminalView 后
      // 自动把焦点送回 xterm。A4 的 selectedSessionId effect 也会兜底,
      // 但显式 + rAF 让"立即可打字"语义更清晰。
      focusTerminalDom();
    } catch (err) {
      console.error('[MainPane] create-session failed', err);
      toast.push({
        kind: 'error',
        message: `新建终端失败:${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setCreating(false);
    }
  };

  const templates = state.templates;

  return (
    <div className="empty-path-state">
      <p className="empty-hint">在 <code>{pathId}</code> 新建终端</p>

      {shells && shells.length > 0 && (
        <div className="empty-section">
          <div className="empty-section-title">检测到的 Shell</div>
          <div className="empty-button-grid">
            {shells.map((s) => (
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
        <div className="empty-section-title">启动模板</div>
        <div className="empty-button-grid">
          {templates.map((t) => (
            <TemplateLaunchButton
              key={t.id}
              template={t}
              creating={creating}
              onLaunch={() => void handleCreate(t.id)}
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
  // 勘误第二轮 #4:已知 builtin id 走 lucide 矢量图标;其他模板(自定义)
  // 仍渲染用户输入的 icon 字符串(emoji / 文本)。
  const builtinIconName = builtinTemplateIcon(template.id);
  return (
    <button
      type="button"
      className="template-button"
      onClick={onLaunch}
      disabled={creating}
      title={template.command ? `${template.name} — 启动命令: ${template.command}` : template.name}
    >
      <span className="template-icon">
        {builtinIconName ? (
          <Icon name={builtinIconName} size={18} />
        ) : (
          template.icon
        )}
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
          title="新建终端 — 选择 Shell 或模板"
        >
          <span className="tab-blank-icon" aria-hidden="true">+</span>
          <span className="tab-name">新建</span>
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
  const state = useAppState();
  const dispatch = useAppDispatch();
  const ctxMenu = useContextMenuApi();
  const toast = useToast();
  const modal = useModal();

  // Variant 由 session.ownerWindowId 自决,不再由父级分组传入。这样 tab
  // 即使移动 (虽然现在不再重排) 也不会丢 variant。
  const variant: 'mine' | 'orphan' | 'other' =
    session.ownerWindowId === myWindowId
      ? 'mine'
      : session.ownerWindowId === null
        ? 'orphan'
        : 'other';

  // 勘误第二轮:走 main 端 Electron clipboard (绕开 web Permission 权限拒绝)
  const copyToClipboard = (text: string, label: string): void => {
    void writeClipboardText(text).then((ok) => {
      toast.push(
        ok
          ? { kind: 'success', message: `已复制 ${label}` }
          : { kind: 'error', message: '复制失败' },
      );
    });
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
          // 用户测试发现"始终灰显":原代码用 `variant !== 'mine'`,
          // 把 orphan(无主)session 也灰掉了。spec 6.3 与 milestone-1
          // 工作记录 §2.3 描述是"**不是本窗口持有时**灰显"。orphan 不属
          // 于"他人持有",应可重命名。改为仅 'other' 时灰显。
          label: '重命名…',
          disabled: variant === 'other',
          ...(variant === 'other' ? { hint: '其他窗口持有,无法重命名' } : {}),
          onSelect: async () => {
            // CPB-P2 同款改造:window.prompt → 自绘 Modal.prompt。
            // 原生 prompt 关闭后焦点漂到 body,这里 Modal.prompt 内置
            // previousActiveElement 归还。
            const next = await modal.prompt({
              title: '重命名会话',
              message: '为此会话指定新的显示名(不影响 sessionId)',
              defaultValue: session.displayName,
              confirmLabel: '保存',
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
        },
        {
          // STM-3:恢复 OSC 标题自动更新 — 用户手改名后,Claude Code 等
          // 持续刷标题的程序被锁(manuallyRenamed=true),此项重置标志位
          // 让 OSC 0/1/2 标题事件再次生效。仅在 'mine' / 'orphan' 显示
          // (与 '重命名' 同条件)。
          label: '恢复自动标题',
          disabled: variant === 'other',
          ...(variant === 'other' ? { hint: '其他窗口持有,无法修改' } : {}),
          onSelect: () => {
            window.api
              .invoke(COMMAND_CHANNELS.SESSION_CLEAR_MANUAL_RENAME, {
                sessionId: session.id,
              })
              .then(() => {
                toast.push({
                  kind: 'info',
                  message: '已恢复 — shell / agent 的标题将再次自动更新',
                });
              })
              .catch((err: unknown) =>
                toast.push({
                  kind: 'error',
                  message: `恢复失败:${err instanceof Error ? err.message : String(err)}`,
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
          label: `复制 PID${session.pid > 0 ? ` (${session.pid})` : ''}`,
          disabled: session.pid <= 0,
          onSelect: () => copyToClipboard(String(session.pid), 'PID'),
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
        (session.state === 'exited' ? ' exited' : '')
      }
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      title={tooltipParts.join('\n')}
    >
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
