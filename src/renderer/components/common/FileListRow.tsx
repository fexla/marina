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
 * - 右键菜单统一走既有 ContextMenu(useContextMenuApi),不重复造菜单基础设施。
 *   buildContextMenu 返回 ContextMenuItem[],由本组件 onContextMenu 触发。
 * - 焦点归还:ContextMenu 的 previousActiveElementRef 机制(CP-4 勘误 FOC-5)
 *   已处理菜单关闭后的焦点回收,本组件无需重复。
 *
 * @对应文档章节: docs/方案-Git面板与文件条目统一-20260718.md §5.2;ADR-016。
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
export type StatusTone =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflict';

/** 徽标字母(M/A/D/R/?/C)与 tone 的组合;statusBadge=null 时不渲染徽标。 */
export interface StatusBadge {
  letter: string;
  tone: StatusTone;
}

export interface FileListRowProps {
  /**
   * 视觉变体:
   * - 'list':纵向列表项(file-tree 目录树、git 变更列表)
   * - 'tab':横向标签页(file-panel 已打开文件的 tab 条)
   */
  variant: 'list' | 'tab';
  /** 主图标(folder / file / gitBranch 等)。null = 不渲染图标槽。 */
  icon: IconName | null;
  /** 主标签(文件名 / tab 名)。可为 ReactNode(如搜索高亮 <mark> 片段)。 */
  label: ReactNode;
  /** tooltip(完整路径等)。 */
  title?: string;
  /** 缩进层级(list variant 专用;tab 忽略)。每层 14px,对齐既有 file-tree 视觉。 */
  depth?: number;
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
  /** 左侧二级槽(chevron 展开箭头等,置于 icon 之前)。 */
  leading?: ReactNode;
  /** 禁用交互(不响应 click / contextmenu,视觉灰显)。 */
  disabled?: boolean;
  /** 可访问性:目录展开态(list variant 专用)。未传则不渲染 aria-expanded。 */
  ariaExpanded?: boolean | undefined;
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
  label,
  title,
  depth = 0,
  statusBadge,
  selected = false,
  dimmed = false,
  onClick,
  buildContextMenu,
  trailing,
  leading,
  disabled = false,
  ariaExpanded,
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
        {icon && <Icon name={icon} size={14} />}
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

  // variant === 'list'
  return (
    <div
      className={`file-list-row file-list-row-list${selected ? ' selected' : ''}${
        dimmed ? ' dimmed' : ''
      }${disabled ? ' disabled' : ''}`}
      // ADR-019:缩进走 --tree-indent-unit(树形缩进单一真相源),与 file-tree / git-tree
      // 统一。depth=0 不加 margin(根层贴左),>0 时按 depth 倍数缩进。
      style={depth > 0 ? { marginLeft: `calc(var(--tree-indent-unit, 14px) * ${depth})` } : undefined}
    >
      <button
        type="button"
        className="file-list-row-button"
        onClick={disabled ? undefined : onClick}
        disabled={disabled}
        title={title}
        onContextMenu={handleContextMenu}
        aria-expanded={ariaExpanded}
        aria-label={ariaLabel}
      >
        {leading}
        {icon && <Icon name={icon} size={14} />}
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
