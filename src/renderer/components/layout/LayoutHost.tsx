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
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { COMMAND_CHANNELS } from '@shared/protocol';
import type { LayoutNode, SessionInfo } from '@shared/types';
import { useAppDispatch, useAppState } from '../../store';
import { Icon } from '../icons';
import { useTranslation } from '../LanguageProvider';
import { isRegisteredPanelId, PANEL_REGISTRY, type RegisteredPanelId } from './panel-registry';

const RIGHT_DOCK_MIN_WIDTH = 280;
const RIGHT_DOCK_MAX_WIDTH = 900;

interface LayoutHostProps {
  session: SessionInfo;
  /** 由 MainPane 传入的终端主内容；terminal 不走 PanelRegistry。 */
  terminal: ReactNode;
}

export function LayoutHost({ session, terminal }: LayoutHostProps): JSX.Element {
  return (
    <div className="layout-host">
      <LayoutNodeView node={session.uiLayout?.tree} session={session} terminal={terminal} />
    </div>
  );
}

function LayoutNodeView({
  node,
  session,
  terminal,
}: {
  node: LayoutNode | undefined;
  session: SessionInfo;
  terminal: ReactNode;
}): JSX.Element {
  // 不应发生（SessionManager 创建时必带树）；保守降级到 terminal，绝不因为一个
  // 旧/损坏 snapshot 让用户失去 xterm。
  if (!node) return <div className="layout-terminal-leaf">{terminal}</div>;

  switch (node.kind) {
    case 'leaf':
      if (node.panelId === 'terminal')
        return <div className="layout-terminal-leaf">{terminal}</div>;
      return <div className="layout-invalid-leaf">Unknown panel: {node.panelId}</div>;
    case 'split':
      return (
        <div className={`layout-split layout-split-${node.direction}`}>
          {node.children.map((child, index) => (
            <LayoutNodeView
              // 树是 main 端静态产品规则，index 在这里稳定；leaf 自身没有可重排 UI。
              key={`${child.kind}-${index}`}
              node={child}
              session={session}
              terminal={terminal}
            />
          ))}
        </div>
      );
    case 'stack':
      return <PanelStack node={node} session={session} />;
    default: {
      const unreachable: never = node;
      return <div className="layout-invalid-leaf">Unknown layout node: {String(unreachable)}</div>;
    }
  }
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
  const width = pendingWidth ?? persisted.width;

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
      <div className="panel-dock-body" role="tabpanel">
        <ActivePanel key={`${activePanelId}-${session.id}`} sessionId={session.id} />
      </div>
    </aside>
  );
}
