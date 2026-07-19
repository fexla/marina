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
import { GitPanel } from '../git/GitPanel';

export type RegisteredPanelId = 'file-tree' | 'git' | 'file-panel';

/**
 * v0.3.1:面板搜索状态(dock 级共享 SearchBar 驱动)。LayoutHost 持有唯一一份,
 * 按当前 active panel 传入。面板自己决定怎么用:
 * - 列表型(file-tree / git / file-panel tab list):用 query 过滤
 * - 查看器型(file-panel 内 FileViewer):文件内查找 + 跳转行
 *
 * visible=false 时面板不应执行搜索(清空过滤 / 清除高亮)。
 */
export interface PanelSearchProps {
  /** 查询字符串(空串 = 无查询)。 */
  query: string;
  /** 大小写敏感开关。 */
  caseSensitive: boolean;
  /** 搜索栏是否打开。关闭时面板应回到无过滤态。 */
  visible: boolean;
}

export interface RegisteredPanelProps {
  /** 当前窗口实际持有的 session；main 会拒绝非 owner 的请求。 */
  sessionId: string;
  /** v0.3.1:dock 级搜索状态(见上)。面板可选地使用。 */
  search: PanelSearchProps;
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
  git: {
    id: 'git',
    label: { zh: 'Git', en: 'Git' },
    // v0.3.0:product-rule,但 LayoutNode 中是否出现 git leaf 由 main 端按
    // session.cwd 是否在仓库内动态决定(见 SessionManager.buildSessionLayoutTree)。
    // enableGitPanel=false 时 main 根本不生成 git leaf → tab 不出现。
    trigger: 'product-rule',
    Component: GitPanel,
  },
  'file-panel': {
    id: 'file-panel',
    label: { zh: '已打开', en: 'Opened' },
    trigger: 'program-push',
    Component: FilePanel,
  },
};

/** LayoutNode 由 main 生成,非法/未知 leaf 在 renderer 直接忽略而不是猜测渲染。 */
export function isRegisteredPanelId(panelId: string): panelId is RegisteredPanelId {
  return panelId === 'file-tree' || panelId === 'git' || panelId === 'file-panel';
}
