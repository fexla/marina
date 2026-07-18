/**
 * @file src/renderer/components/common/fileListRowContextMenu.ts
 * @purpose 三面板(file-tree / git / file-panel)文件条目右键菜单的共用 builder。
 *
 * @关键设计:
 * - 「通用项」(复制路径 / Explorer 显示)在此单一来源,三面板长相一致。
 * - 「特有项」(打开 diff / 关闭其他 / 关闭所有 / 在文件树定位)由各面板自己
 *   拼到通用项前后,通过 buildXxxContextMenu 组合。
 * - 所有菜单项走既有 ContextMenu + useCopyToClipboard + useToast,零新增基础设施。
 * - i18n:目前菜单 label 直接写中文(与 Sidebar / sessionContextMenu 现状一致,
 *   项目 V1 中英双语英文版稍后)。后续若统一接 useTranslation,这里换 tx() 即可。
 *
 * @对应文档章节: docs/方案-Git面板与文件条目统一-20260718.md §5.3。
 *
 * @不要在这里做的事:
 * - 不决定菜单何时弹出(由 FileListRow.onContextMenu 触发)。
 * - 不持有状态(纯函数 builder,依赖通过参数注入)。
 */
import { COMMAND_CHANNELS } from '@shared/protocol';
import type { ContextMenuItem } from '../ContextMenu';

/** 菜单依赖:复制到剪贴板、错误 toast。由调用方从 hook 注入。 */
export interface FileMenuDeps {
  copyToClipboard: (text: string, label: string) => void;
  toastError: (msg: string) => void;
}

/** 「复制路径」菜单项。同时给相对路径与绝对路径两个变体。 */
export function copyPathItems(
  absolutePath: string,
  relativePath: string | null,
  deps: FileMenuDeps,
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    {
      label: '复制路径',
      onSelect: () => deps.copyToClipboard(absolutePath, '路径'),
    },
  ];
  // 相对路径与绝对路径不同时(仓库内文件 / workspace 内文件)多给一项,
  // 让用户能复制相对路径贴到 commit message 或文档里。
  if (relativePath && relativePath !== absolutePath) {
    items.push({
      label: '复制相对路径',
      onSelect: () => deps.copyToClipboard(relativePath, '相对路径'),
    });
  }
  return items;
}

/**
 * 「在 Explorer / Finder 中显示」菜单项。
 *
 * SSH session 的文件无本机路径语义,调用方应不追加此项(而非靠 disabled)。
 * 本函数假定调用方已判定为本地路径。
 */
export function revealInExplorerItem(absolutePath: string, deps: FileMenuDeps): ContextMenuItem {
  return {
    label: '在 Explorer 中显示',
    onSelect: () => {
      window.api
        .invoke(COMMAND_CHANNELS.SYSTEM_SHOW_IN_EXPLORER, { path: absolutePath })
        .catch((err: unknown) =>
          deps.toastError(
            `打开 Explorer 失败:${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    },
  };
}

/** 分隔符便利构造。ContextMenuItem.divider=true 时其他字段忽略。 */
export function dividerItem(): ContextMenuItem {
  return { divider: true, label: '' };
}
