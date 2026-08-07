/**
 * @file src/renderer/components/layout/LayoutHost.tsx
 * @purpose 递归渲染主工作区的受控 LayoutNode，并集中承载 dock 的通用 chrome。
 *
 * @关键设计:
 * - LayoutNode 来自 SessionInfo.uiLayout.tree，main 按产品规则生成；renderer 只读，
 *   没有拖放/浮动/树修改 IPC，因此“可组合架构”不会变成用户布局管理负担。
 * - terminal 是特殊不可关闭主 leaf；其他 leaf 必须由 PanelRegistry 注册。面板内容
 *   不再自行决定位置、宽度、折叠或 resize handle。
 * - width/collapsed 是 session 临时状态。拖动期间保留本地像素值保证手感，mouseup
 *   只提交一次 cmd:session:update-ui-layout，避免每帧跨窗口广播。
 *
 * @对应文档章节:软件定义书.md ADR-016；docs/方案-主工作区布局架构-20260712.md。
 */
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { COMMAND_CHANNELS } from '@shared/protocol';
import type { LayoutNode, SessionInfo } from '@shared/types';
import { useAppDispatch, useAppState } from '../../store';
import { Icon } from '../icons';
import { useTranslation } from '../LanguageProvider';
import { SearchBar } from '../common/SearchBar';
import { usePanelSearchShortcut } from '../../hooks/usePanelSearchShortcut';
import { useGitPollingDemand } from '../../hooks/useGitPollingDemand';
import { useFileTreePollingDemand } from '../../hooks/useFileTreePollingDemand';
import { isRegisteredPanelId, PANEL_REGISTRY, type RegisteredPanelId } from './panel-registry';

const RIGHT_DOCK_MIN_WIDTH = 280;
const RIGHT_DOCK_MAX_WIDTH = 900;

interface LayoutHostProps {
  /** null = 当前没有 owner session；TerminalDeck 仍必须留在稳定 leaf 中。 */
  session: SessionInfo | null;
  /** 由 MainPane 传入的稳定 TerminalDeck；terminal 不走 PanelRegistry。 */
  terminal: ReactNode;
  /** 设置页/简易模式/功能关闭时只卸载 panel subtree，不移动 terminal leaf。 */
  panelsEnabled: boolean;
}

/** 受控布局只允许一个 right dock stack；损坏/旧树找不到时降级为纯终端。 */
function findPanelStack(
  node: LayoutNode | undefined,
): Extract<LayoutNode, { kind: 'stack' }> | null {
  if (!node) return null;
  if (node.kind === 'stack') return node;
  if (node.kind !== 'split') return null;
  for (const child of node.children) {
    const found = findPanelStack(child);
    if (found) return found;
  }
  return null;
}

export function LayoutHost({ session, terminal, panelsEnabled }: LayoutHostProps): JSX.Element {
  const stack = session && panelsEnabled ? findPanelStack(session.uiLayout?.tree) : null;
  return (
    <div className="layout-host">
      {/* terminal leaf 永远是同一个第一子节点。切 session / blank tab / simple mode /
       * filePanel enabled 都不能改变它的父链,否则 TerminalDeck 会整体 unmount。 */}
      <div className="layout-split layout-split-horizontal">
        <div className="layout-terminal-leaf">{terminal}</div>
        {stack && session && <PanelStack key={session.id} node={stack} session={session} />}
      </div>
    </div>
  );
}

function panelIdsFromStack(node: Extract<LayoutNode, { kind: 'stack' }>): RegisteredPanelId[] {
  return node.children.flatMap((child) =>
    child.kind === 'leaf' && isRegisteredPanelId(child.panelId) ? [child.panelId] : [],
  );
}

function PanelStack({
  node,
  session,
}: {
  node: Extract<LayoutNode, { kind: 'stack' }>;
  session: SessionInfo;
}): JSX.Element {
  const { tx } = useTranslation();
  const appState = useAppState();
  const dispatch = useAppDispatch();
  const panelIds = panelIdsFromStack(node);
  // defaultPanelId 也要校验属于当前 stack:旧/损坏布局的 defaultActivePanelId
  // 可能不在 panelIds 里,此时回退 panelIds[0],避免激活不存在的 tab。下面
  // storedPanelId 的校验同理。
  const rawDefault = isRegisteredPanelId(node.defaultActivePanelId)
    ? node.defaultActivePanelId
    : (panelIds[0] ?? 'file-tree');
  const defaultPanelId = panelIds.includes(rawDefault) ? rawDefault : (panelIds[0] ?? 'file-tree');
  // activePanelId 由 store(activePanels)驱动,并校验属于当前 stack:旧快照/布局
  // 变化可能导致 store 记着 'file-panel' 但当前布局没有该面板,此时回退
  // defaultPanelId,避免渲染 tab 列表里不存在的 active 面板。openFile 成功时
  // reducer(file-panel/updated 的 requestActivation 分支)直接把 activePanels 设为
  // 'file-panel',无论 PanelStack 是否挂载 — remount 不抢焦点、卸载期间请求也不
  // 丢。用户手动点 tab 走 view/set-active-panel。
  const storedPanelId = appState.activePanels.get(session.id);
  const activePanelId =
    storedPanelId && panelIds.includes(storedPanelId) ? storedPanelId : defaultPanelId;
  const activeDefinition = PANEL_REGISTRY[activePanelId];
  // 宽度与折叠态属于 right dock 本身，不属于 stack 中当前激活的页面。此前把
  // file-tree/file-panel 各自的 width 当 dock 宽度，导致点 tab 时几何跳变。
  const persisted = session.uiLayout?.docks.right ?? { width: 440, collapsed: false };
  const [pendingWidth, setPendingWidth] = useState<number | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const openedCount = appState.filePanels.get(session.id)?.files.length ?? 0;
  const commandSnapshot = appState.commandPanels.get(session.id);
  const activeCommandHasOutput = Boolean(
    commandSnapshot?.commands.find((entry) => entry.key === commandSnapshot.activeKey)?.output,
  );
  const width = pendingWidth ?? persisted.width;

  // ADR-021:PanelStack 是“当前 Session + 当前面板”的 UI 真值源。Git 可见且本窗口
  // 聚焦时 HOT(3s)，显示其他面板/失焦时 WARM(60s)，非 owner/unmount 时 NONE。
  useGitPollingDemand({
    sessionId: session.id,
    gitAvailable: panelIds.includes('git'),
    gitVisible: activePanelId === 'git' && !persisted.collapsed,
    isOwner: session.ownerWindowId === appState.myWindowId,
  });

  // 文件树同机制,但只有 HOT/NONE:仅前台终端的文件面板需要刷新(需求),无 WARM
  // 保温档。展开目录集合由 FileTreePanel 经 FILE_TREE_SET_WATCHED_DIRS 另报。
  useFileTreePollingDemand({
    sessionId: session.id,
    fileTreeVisible: activePanelId === 'file-tree' && !persisted.collapsed,
    isOwner: session.ownerWindowId === appState.myWindowId,
  });

  // v0.3.1:dock 级面板搜索(Ctrl+F 唤出)。状态在 PanelStack 持有,随 session
  // 生命周期(切 session remount → 重置)。query 跨 panel 共享(切 tab 不清),
  // active panel 自己决定怎么用(列表过滤 / 文件内查找)。
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  // 输入框值必须逐键即时更新；面板过滤/高亮可能触及 500~5000 行，用 deferred
  // 副本把重计算降为可中断更新，避免“大结果集 + 输入一键”冻结整个 renderer。
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  // v0.3.1 C3:文件内查找的命中数/当前序号由当前 Markdown/FileViewer 汇报(事件),
  // LayoutHost 只展示。导航(onNext/onPrev)反向 dispatch 事件给当前 viewer。
  const [searchMatches, setSearchMatches] = useState(0);
  const [searchCurrent, setSearchCurrent] = useState(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const dockBodyRef = useRef<HTMLDivElement | null>(null);

  const handleOpenSearch = useCallback((): void => {
    setSearchVisible(true);
    // setState 后立即 focus 太早,DOM 还没挂;用 raf 等下一帧
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, []);
  const handleCloseSearch = useCallback((): void => {
    setSearchVisible(false);
    setSearchQuery('');
    setSearchMatches(0);
    setSearchCurrent(0);
    // 关闭后焦点回到 dock body(下一个面板操作起点)
    dockBodyRef.current?.focus();
  }, []);

  // v0.3.1 C3:监听当前 viewer 汇报的文件内查找结果(matches/current)。
  // 只收本 session 的事件(多窗口时其他窗口的 LayoutHost 不响应)。
  useEffect(() => {
    const onResult = (e: Event): void => {
      const detail = (e as CustomEvent<{ sessionId: string; matches: number; current: number }>)
        .detail;
      if (!detail || detail.sessionId !== session.id) return;
      setSearchMatches(detail.matches);
      setSearchCurrent(detail.current);
    };
    window.addEventListener('marina:panel-search-result', onResult);
    return () => window.removeEventListener('marina:panel-search-result', onResult);
  }, [session.id]);

  // 导航:dispatch 给当前 active panel 的 FileViewer(若在查找文件内容)。
  const navigateSearch = useCallback(
    (direction: 'next' | 'previous'): void => {
      window.dispatchEvent(
        new CustomEvent('marina:panel-search-navigate', {
          detail: { sessionId: session.id, direction },
        }),
      );
    },
    [session.id],
  );

  // Ctrl+F 全局快捷键(焦点非 input/terminal 时触发)。终端有焦点时 xterm
  // attachCustomKeyEventHandler 吃掉,不冒泡,本 hook 收不到 —— 行为正确。
  usePanelSearchShortcut(!persisted.collapsed, handleOpenSearch);

  // 换 session / 主端确认的 dock 宽度时撤销 drag 覆盖。切换 stack 页面不影响
  // 该 effect：页面不是布局容器，不能改变 right dock 的几何。
  useEffect(() => {
    setPendingWidth(null);
  }, [session.id, persisted.width]);
  useEffect(() => () => dragCleanupRef.current?.(), []);
  // 面板激活完全由 reducer 处理,这里不需要任何自动切换 effect:openFile 成功时
  // reducer(file-panel/updated 的 requestActivation=true 分支)直接把 activePanels
  // 设为 'file-panel',无论 PanelStack 是否挂载。remount 从 store 恢复(不抢
  // 焦点),卸载期间(设置页/简易模式)发生的新请求也不丢。

  const updateLayout = (patch: { width?: number; collapsed?: boolean }): void => {
    window.api
      .invoke(COMMAND_CHANNELS.SESSION_UPDATE_UI_LAYOUT, {
        sessionId: session.id,
        patch: { docks: { right: patch } },
      })
      .catch((err: unknown) => {
        setPendingWidth(null);
        console.warn('[LayoutHost] update panel layout failed', err);
      });
  };

  const startResize = (event: MouseEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    let finalWidth = startWidth;
    const onMove = (moveEvent: globalThis.MouseEvent): void => {
      const delta = startX - moveEvent.clientX;
      finalWidth = Math.max(
        RIGHT_DOCK_MIN_WIDTH,
        Math.min(RIGHT_DOCK_MAX_WIDTH, startWidth + delta),
      );
      setPendingWidth(finalWidth);
    };
    const stop = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', stop);
      dragCleanupRef.current = null;
      if (finalWidth !== persisted.width) updateLayout({ width: finalWidth });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', stop);
    dragCleanupRef.current = stop;
  };

  if (persisted.collapsed) {
    return (
      <aside className="panel-dock panel-dock-collapsed">
        <button
          type="button"
          className="panel-dock-expand-button"
          onClick={() => updateLayout({ collapsed: false })}
          title={tx(
            `展开${activeDefinition.label.zh}面板`,
            `Expand ${activeDefinition.label.en} panel`,
          )}
          aria-label={tx(
            `展开${activeDefinition.label.zh}面板`,
            `Expand ${activeDefinition.label.en} panel`,
          )}
        >
          ‹
        </button>
      </aside>
    );
  }

  const ActivePanel = activeDefinition.Component;
  // search props 对象(传给 ActivePanel)。每渲染重建,但面板用 useMemo 依赖
  // query/caseSensitive/visible,不会过度重算。
  const searchProps = {
    query: deferredSearchQuery,
    caseSensitive: searchCaseSensitive,
    visible: searchVisible,
  };
  return (
    <aside className="panel-dock" style={{ width }}>
      <div
        className="panel-dock-resize-handle"
        onMouseDown={startResize}
        role="separator"
        aria-orientation="vertical"
      />
      <header className="panel-dock-header">
        <div
          className="panel-dock-tabs"
          role="tablist"
          aria-label={tx('工作区面板', 'Workspace panels')}
        >
          {panelIds.map((panelId) => {
            const definition = PANEL_REGISTRY[panelId];
            const active = panelId === activePanelId;
            return (
              <button
                key={panelId}
                type="button"
                role="tab"
                aria-selected={active}
                className={`panel-dock-tab${active ? ' active' : ''}`}
                onClick={() =>
                  dispatch({ type: 'view/set-active-panel', sessionId: session.id, panelId })
                }
                title={tx(definition.label.zh, definition.label.en)}
              >
                {tx(definition.label.zh, definition.label.en)}
                {panelId === 'file-panel' && openedCount > 0 ? ` (${openedCount})` : ''}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className="panel-dock-collapse-button"
          onClick={() => updateLayout({ collapsed: true })}
          title={tx('折叠', 'Collapse')}
          aria-label={tx('折叠', 'Collapse')}
        >
          <Icon name="chevronRight" size={14} />
        </button>
      </header>
      <div className="panel-dock-body" role="tabpanel" tabIndex={-1} ref={dockBodyRef}>
        {searchVisible && (
          <SearchBar
            query={searchQuery}
            onQueryChange={setSearchQuery}
            onClose={handleCloseSearch}
            caseSensitive={searchCaseSensitive}
            onToggleCase={() => setSearchCaseSensitive((v) => !v)}
            inputRef={searchInputRef}
            showNavigator={
              (activePanelId === 'file-panel' && openedCount > 0) ||
              (activePanelId === 'command' && activeCommandHasOutput)
            }
            matches={searchMatches}
            current={searchCurrent}
            onNext={() => navigateSearch('next')}
            onPrev={() => navigateSearch('previous')}
          />
        )}
        <ActivePanel
          key={`${activePanelId}-${session.id}`}
          sessionId={session.id}
          search={searchProps}
        />
      </div>
    </aside>
  );
}
