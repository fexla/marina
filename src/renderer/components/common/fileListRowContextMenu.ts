/**
 * @file src/renderer/components/common/fileListRowContextMenu.ts
 * @purpose 三面板(file-tree / git / file-panel)文件条目右键菜单的**统一生成器**。
 *
 * @v0.3.1 重构(ADR-018):能力驱动。
 *   面板构造 `FileEntryContext` 描述"这个条目能做什么",`buildFileEntryMenu`
 *   自动生成统一形态的菜单。`<FileListRow>`(渲染统一) + 本生成器(菜单统一)
 *   = 文件条目的完整统一抽象。**新增面板只需实现 FileEntryContext + 用 FileListRow,
 *   零拼装菜单**。
 *
 * @关键设计:
 * - 能力驱动:ctx 提供哪些能力,菜单就生成哪些项。不提供 openFile 就没"打开文件",
 *   不提供 resolveAbsolutePath 就没"复制绝对路径",不提供 close 就没关闭族。
 *   这样各面板菜单"能做什么"由其本性决定,不强求项数一致(目录无"打开文件",
 *   file-tree 无"复制绝对路径"是合理的)。
 * - 路径解析保持各面板特色:reveal / openFile / resolveAbsolutePath 是**注入的能力**,
 *   不强制统一实现。file-tree 走 rootId 抽象(不暴露绝对路径),git 走 repoRoot IPC,
 *   file-panel 直接持有绝对路径 —— 三套路径来源本质不同,硬统一会引入不必要的抽象层。
 * - 菜单顺序统一(对所有面板):
 *     操作族(primary / openFile / close) → divider → 路径族(copyRelative / copyAbsolute / reveal)
 *   两组都非空才插 divider,尾部不插。
 * - 文案统一(label 由 deps.tx 双语),消除了之前三面板各写各的"复制路径"/"复制相对路径"等。
 *
 * @对应文档:ADR-018 文件条目统一菜单抽象;docs/方案-文件条目统一菜单-20260719.md
 *
 * @不要在这里做的事:
 * - 不决定菜单何时弹出(由 FileListRow.onContextMenu 触发)。
 * - 不持有状态(纯函数 builder,依赖通过参数注入)。
 * - 不渲染菜单(ContextMenu 组件负责)。
 */
import type { ContextMenuItem } from '../ContextMenu';

/** 菜单依赖:复制到剪贴板、错误 toast、i18n。由调用方从 hook 注入。 */
export interface FileMenuDeps {
  copyToClipboard: (text: string, label: string) => void;
  toastError: (msg: string) => void;
  /** i18n 双语(zh, en) → 当前语言文本。 */
  tx: (zh: string, en: string) => string;
}

/**
 * 一个文件条目的"能力上下文"。由所在面板构造,描述这个条目能做什么。
 *
 * 除 `primary` 外所有字段可选 —— **提供了才生成对应菜单项**(能力驱动)。
 * 这让目录 / 文件 / git 变更 / 已打开 tab 各自只暴露合理的能力,
 * 不强求菜单项数完全一致(那反而失真)。
 */
export interface FileEntryContext {
  /**
   * 主操作(左键/双击行为)。通常是菜单第一项。
   * file-panel tab 无强主操作(左键已切 active),可不提供。
   */
  primary?: {
    label: string;
    run: () => void;
  };

  /**
   * 打开文件本身(预览工作区真实内容,而非 diff)。
   *
   * 仅当与 primary 语义不同时才提供:
   * - git:primary=打开 diff,另需"打开文件"看文件本身 → 提供
   * - file-tree:primary 已是"打开"(= 预览文件) → 不提供(重复)
   * - file-panel:文件已打开,无意义 → 不提供
   */
  openFile?: {
    run: () => void;
    /** 如 deleted 文件工作区已删,打开会失败 → 禁用此项而非报错。 */
    disabled?: boolean;
  };

  /** 复制相对路径(提供了 relativePath 自动生成"复制相对路径")。 */
  relativePath?: string;

  /**
   * 复制绝对路径(提供了 resolver 自动生成"复制绝对路径")。
   *
   * async 因为本路径可能要跨 IPC 解析(git:resolve-path)。
   * file-tree 不提供(保持 rootId 抽象,不向 renderer 暴露绝对路径);
   * git / file-panel 提供。
   */
  resolveAbsolutePath?: () => Promise<string>;

  /**
   * 在 Explorer / Finder 中显示。
   *
   * 各面板自己实现 reveal 逻辑(注入实现,不强制统一):
   * - file-tree:cmd:file-tree:reveal-path(rootId + relativePath,main 端 resolve + show)
   * - git / file-panel:先 resolveAbsolutePath 再 cmd:system:show-in-explorer
   */
  reveal?: () => void;

  /** 关闭族(file-panel tab 语义;其他面板无此能力)。 */
  close?: {
    close: () => void;
    closeOthers: () => void;
    closeAll: () => void;
    /** 如只剩一个文件时,"关闭其他"禁用。 */
    closeOthersDisabled?: boolean;
    closeAllDisabled?: boolean;
  };
}

/** 分隔符便利构造。ContextMenuItem.divider=true 时其他字段忽略。 */
export function dividerItem(): ContextMenuItem {
  return { divider: true, label: '' };
}

/**
 * 按 FileEntryContext 生成统一形态的右键菜单。
 *
 * @param ctx 条目能力上下文
 * @param deps 复制 / toast / i18n 依赖
 * @returns ContextMenuItem[] —— 顺序:操作族 → divider → 路径族
 *
 * @能力→项映射:
 *   primary            → 主操作(label 由 ctx 给)
 *   openFile           → "打开文件"
 *   close              → "关闭" / "关闭其他" / "关闭所有"
 *   relativePath       → "复制相对路径"
 *   resolveAbsolutePath→ "复制绝对路径"
 *   reveal             → "在 Explorer 中显示"
 */
export function buildFileEntryMenu(ctx: FileEntryContext, deps: FileMenuDeps): ContextMenuItem[] {
  const { tx, copyToClipboard, toastError } = deps;
  const actionItems: ContextMenuItem[] = [];
  const pathItems: ContextMenuItem[] = [];

  // ── 操作族 ──
  if (ctx.primary) {
    actionItems.push({ label: ctx.primary.label, onSelect: ctx.primary.run });
  }
  if (ctx.openFile) {
    const item: ContextMenuItem = {
      label: tx('打开文件', 'Open file'),
      onSelect: ctx.openFile.run,
    };
    if (ctx.openFile.disabled) item.disabled = true;
    actionItems.push(item);
  }
  if (ctx.close) {
    const closeOthersItem: ContextMenuItem = {
      label: tx('关闭其他', 'Close others'),
      onSelect: ctx.close.closeOthers,
    };
    if (ctx.close.closeOthersDisabled) closeOthersItem.disabled = true;
    const closeAllItem: ContextMenuItem = {
      label: tx('关闭所有', 'Close all'),
      onSelect: ctx.close.closeAll,
    };
    if (ctx.close.closeAllDisabled) closeAllItem.disabled = true;
    actionItems.push(
      { label: tx('关闭', 'Close'), onSelect: ctx.close.close },
      closeOthersItem,
      closeAllItem,
    );
  }

  // ── 路径族 ──
  if (ctx.relativePath) {
    pathItems.push({
      label: tx('复制相对路径', 'Copy relative path'),
      onSelect: () => copyToClipboard(ctx.relativePath as string, '相对路径'),
    });
  }
  if (ctx.resolveAbsolutePath) {
    pathItems.push({
      label: tx('复制绝对路径', 'Copy absolute path'),
      onSelect: () => {
        ctx
          .resolveAbsolutePath!()
          .then((abs) => copyToClipboard(abs, '绝对路径'))
          .catch((err: unknown) =>
            toastError(`解析路径失败:${err instanceof Error ? err.message : String(err)}`),
          );
      },
    });
  }
  if (ctx.reveal) {
    pathItems.push({
      label: tx('在 Explorer 中显示', 'Reveal in Explorer'),
      onSelect: ctx.reveal,
    });
  }

  // ── 合并:操作族 + (divider 如果两组都非空) + 路径族 ──
  const items: ContextMenuItem[] = [...actionItems];
  if (actionItems.length > 0 && pathItems.length > 0) {
    items.push(dividerItem());
  }
  items.push(...pathItems);
  return items;
}
