/**
 * @file src/renderer/components/layout/panel-registry.tsx
 * @purpose 声明 renderer 可渲染的受控主工作区面板类型。
 *
 * @关键设计:
 * - 新增面板只需在此注册内容组件和几何规则；LayoutHost 不感知具体业务组件。
 * - Registry 不是用户可编辑插件系统。它与 main 的 PANEL_LAYOUT_RULES 同步维护，
 *   main 仍是 IPC 状态校验权威。
 * - terminal 不在本表中：终端是 Marina 的主产品能力，不能被降格为可关闭面板。
 *
 * @对应文档章节:软件定义书.md ADR-016。
 */
import type { ComponentType } from 'react';
import { FilePanel } from '../file-panel/FilePanel';
import { FileTreePanel } from '../file-tree/FileTreePanel';

export type RegisteredPanelId = 'file-tree' | 'file-panel';

export interface RegisteredPanelProps {
  sessionId: string;
}

export interface PanelDefinition {
  id: RegisteredPanelId;
  label: { zh: string; en: string };
  /** 谁控制面板出现：产品固定规则，或终端内程序经 MARINA_SERVICE 推送。 */
  trigger: 'product-rule' | 'program-push';
  Component: ComponentType<RegisteredPanelProps>;
}

export const PANEL_REGISTRY: Readonly<Record<RegisteredPanelId, PanelDefinition>> = {
  'file-tree': {
    id: 'file-tree',
    label: { zh: '文件', en: 'Files' },
    trigger: 'product-rule',
    Component: FileTreePanel,
  },
  'file-panel': {
    id: 'file-panel',
    label: { zh: '已打开', en: 'Opened' },
    trigger: 'program-push',
    Component: FilePanel,
  },
};

/** LayoutNode 由 main 生成，非法/未知 leaf 在 renderer 直接忽略而不是猜测渲染。 */
export function isRegisteredPanelId(panelId: string): panelId is RegisteredPanelId {
  return panelId === 'file-tree' || panelId === 'file-panel';
}
