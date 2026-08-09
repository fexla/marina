/**
 * @file src/renderer/components/common/FileListRow.tsx
 * @purpose 文件条目的统一抽象 —— file-tree / git / file-panel 三个面板共用。
 *
 * @关键设计:
 * - 「数据 + 行为」统一:icon / label / status / onClick / buildContextMenu 由
 *   调用方注入,组件本身不感知面板语义。三面板的右键菜单因此长相一致。
 * - 「视觉」按 variant 区分:list(file-tree / git 的纵向列表项)与
 *   tab(file-panel 的横向标签页)。两者天然有不同视觉语言(VS Code 的
 *   explorer 与 tab 也是两套样式),强行合并会牺牲表达力;variant 是对
 *   "统一抽象"的正确切片 —— 统一的是逻辑,不是像素。
 * - 树结构是一个不可拆接口:`treeNode` 同时携带 depth、branch/leaf 与展开态。
 *   本组件统一渲染 disclosure gutter + 层级 margin + aria-expanded，调用方不能
 *   再出现「目录手拼 chevron、叶子漏 spacer，14px 缩进被 16px gutter 抵消」。
 * - 右键菜单统一走既有 ContextMenu(useContextMenuApi),不重复造菜单基础设施。
 *   buildContextMenu 返回 ContextMenuItem[],由本组件 onContextMenu 触发。
 * - 焦点归还:ContextMenu 的 previousActiveElementRef 机制(CP-4 勘误 FOC-5)
 *   已处理菜单关闭后的焦点回收,本组件无需重复。
 *
 * @对应文档章节: docs/方案-Git面板与文件条目统一-20260718.md §5.2;
 *   docs/standards/panel-ui-state.md ADR-019。
 *
 * @不要在这里做的事:
 * - 不决定条目数据来源(由各 Panel 注入)。
 * - 不决定左键语义(目录展开 / 打开 diff / 切 tab 由 onClick 回调注入)。
 * - 不持久化任何状态(选中 / active 态由父级控制并传入)。
 */
import { type MouseEvent, type ReactNode } from 'react';
import { Icon, type IconName } from '../icons';
import { useContextMenuApi, type ContextMenuItem } from '../ContextMenu';

/** Git 变更状态徽标的语义色映射。null = 无徽标(file-tree / file-panel 条目)。 */
export type StatusTone = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict';

/** 徽标字母(M/A/D/R/?/C)与 tone 的组合;statusBadge=null 时不渲染徽标。 */
export interface StatusBadge {
  letter: string;
  tone: StatusTone;
}

/**
 * list 行的树结构语义。depth 与 disclosure role 必须一起提交，防止调用方只缩进
 * 或只画箭头；branch 的 expanded 同时驱动图标和 aria-expanded。
 */
export type FileListTreeNode =
  | { kind: 'leaf'; depth: number }
  | { kind: 'branch'; depth: number; expanded: boolean };

export interface FileListRowProps {
  /**
   * 视觉变体:
   * - 'list':纵向列表项(file-tree 目录树、git 变更列表)
   * - 'tab':横向标签页(file-panel 已打开文件的 tab 条)
   */
  variant: 'list' | 'tab';
  /** 主图标(folder / file / gitBranch 等)。null = 不渲染图标槽。 */
  icon: IconName | null;
  /** 主图标右下角的短角标（例如已打开 Diff 页签的 “D”）。 */
  iconCornerBadge?: string | undefined;
  /** 主标签(文件名 / tab 名)。可为 ReactNode(如搜索高亮 <mark> 片段)。 */
  label: ReactNode;
  /** tooltip(完整路径等)。 */
  title?: string;
  /**
   * 树节点语义(list variant 专用)。不传表示普通平铺列表；传入后统一获得层级缩进、
   * 12px disclosure gutter 与 branch 展开 ARIA，叶子也保留等宽空 gutter。
   */
  treeNode?: FileListTreeNode;
  /** 状态徽标(Git 面板的 M/A/D 等)。null = 不渲染。 */
  statusBadge?: StatusBadge | null;
  /** 选中 / active 态(tab 的 active 或 list 的 hover-selected)。 */
  selected?: boolean;
  /** 灰显(其他窗口持有 / 已退出等)。 */
  dimmed?: boolean;
  /** 左键点击行为,由所在面板注入(目录展开 / 打开 diff / 切 tab)。 */
  onClick?: () => void;
  /**
   * 右键菜单项构建器。返回 ContextMenuItem[];返回空数组或不传 = 不弹菜单。
   * 由各面板按条目上下文动态生成,保证三面板菜单形态一致。
   */
  buildContextMenu?: () => ContextMenuItem[];
  /** 右侧附加槽(tab 的 × 关闭按钮 / 列表项的活跃点)。 */
  trailing?: ReactNode;
  /** 禁用交互(不响应 click / contextmenu,视觉灰显)。 */
  disabled?: boolean;
  /** 可访问性:条目的 ARIA role 描述。默认由 variant 决定。 */
  ariaLabel?: string | undefined;
}

/**
 * 文件条目统一渲染。
 *
 * 行为契约:
 * - 左键:触发 onClick(若有);disabled 时不响应。
 * - 右键:触发 buildContextMenu(若有);返回非空数组则交 ContextMenu 弹出。
 * - 视觉:variant 决定布局与 className 后缀,selected / dimmed / disabled 加修饰类。
 */
export function FileListRow({
  variant,
  icon,
  iconCornerBadge,
  label,
  title,
  treeNode,
  statusBadge,
  selected = false,
  dimmed = false,
  onClick,
  buildContextMenu,
  trailing,
  disabled = false,
  ariaLabel,
}: FileListRowProps): JSX.Element {
  const ctxMenu = useContextMenuApi();

  const handleContextMenu = (e: MouseEvent): void => {
    if (disabled || !buildContextMenu) return;
    const items = buildContextMenu();
    if (items.length === 0) return;
    e.preventDefault();
    ctxMenu.open({ x: e.clientX, y: e.clientY, items });
  };

  const renderedIcon = icon ? (
    iconCornerBadge ? (
      <span className="file-list-row-icon-with-badge" aria-hidden="true">
        <Icon name={icon} size={14} />
        <span className="file-list-row-icon-corner-badge">{iconCornerBadge}</span>
      </span>
    ) : (
      <Icon name={icon} size={14} />
    )
  ) : null;

  // variant=tab 时整体是一个带 × 按钮的容器(既有 file-tab 视觉);label 区可点。
  // variant=list 时整体是一个 button(既有 file-tree-entry-button 视觉)。
  if (variant === 'tab') {
    return (
      <div
        className={`file-list-row file-list-row-tab${selected ? ' active' : ''}${
          dimmed ? ' dimmed' : ''
        }${disabled ? ' disabled' : ''}`}
        title={title}
        onContextMenu={handleContextMenu}
      >
        {renderedIcon}
        <button
          type="button"
          className="file-list-row-label"
          onClick={disabled ? undefined : onClick}
          disabled={disabled}
        >
          {label}
        </button>
        {statusBadge && (
          <span className={`file-list-row-badge tone-${statusBadge.tone}`}>
            {statusBadge.letter}
          </span>
        )}
        {trailing}
      </div>
    );
  }

  // variant === 'list'。树层级、disclosure gutter 与 ARIA 必须在同一模块内生成：
  // 过去 depth 在这里、chevron/spacer 却由各 caller 手拼，Git 叶子漏 spacer 后
  // 14px depth 被父目录的 12px chevron + 4px gap 抵消，图标看起来同级。
  const treeDepth = treeNode ? Math.max(0, Math.trunc(treeNode.depth)) : 0;
  const treeDisclosure = treeNode ? (
    <span className="file-list-row-tree-disclosure" aria-hidden="true">
      {treeNode.kind === 'branch' && (
        <Icon name={treeNode.expanded ? 'chevronDown' : 'chevronRight'} size={12} />
      )}
    </span>
  ) : null;
  const treeExpanded = treeNode?.kind === 'branch' ? treeNode.expanded : undefined;

  return (
    <div
      className={`file-list-row file-list-row-list${selected ? ' selected' : ''}${
        dimmed ? ' dimmed' : ''
      }${disabled ? ' disabled' : ''}`}
      // ADR-019:缩进只走 --tree-indent-unit；treeNode 把 depth 与 gutter 绑定为一个接口。
      style={
        treeDepth > 0
          ? { marginLeft: `calc(var(--tree-indent-unit, 14px) * ${treeDepth})` }
          : undefined
      }
    >
      <button
        type="button"
        className="file-list-row-button"
        onClick={disabled ? undefined : onClick}
        disabled={disabled}
        title={title}
        onContextMenu={handleContextMenu}
        aria-expanded={treeExpanded}
        aria-label={ariaLabel}
      >
        {treeDisclosure}
        {renderedIcon}
        <span className="file-list-row-label-text">{label}</span>
        {statusBadge && (
          <span className={`file-list-row-badge tone-${statusBadge.tone}`}>
            {statusBadge.letter}
          </span>
        )}
      </button>
      {trailing}
    </div>
  );
}
