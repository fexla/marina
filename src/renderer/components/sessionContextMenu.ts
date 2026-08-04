/**
 * @file src/renderer/components/sessionContextMenu.ts
 * @purpose 单一来源 — Tab 右键 / Sidebar session 右键共用的菜单项构造器。
 *   两边的菜单"内容"必须一致(用户明确要求),只有"重命名"的触发 UX 不同
 *   (Tab 走 Modal.prompt,Sidebar 走行内编辑),通过传入 onRename 回调解耦。
 *
 *   v0.3.3 用户裁决 6A:菜单按任务分层 —
 *   主任务(重命名/新窗口/简易窗口/关闭)+ 子菜单「复制信息」(cwd/初始目录/PID);
 *   「在文件管理器中显示」只对客户端本机 backend 的 local session 出现
 *   (远程 backend / SSH 的 Explorer 会在用户看不到的电脑上打开)。
 */
import { COMMAND_CHANNELS } from '@shared/protocol';
import type { PathTree, SessionInfo } from '@shared/types';
import { findPathNode } from '../store';
import type { ContextMenuItem } from './ContextMenu';

export type SessionVariant = 'mine' | 'orphan' | 'other';

export interface SessionMenuDeps {
  variant: SessionVariant;
  pathTree: PathTree;
  copyToClipboard: (text: string, label: string) => void;
  /** 触发重命名 UX。Tab 端走 Modal.prompt;Sidebar 端走行内编辑。 */
  onRename: () => void;
  /** 关闭终端(带「自动续看」):关掉当前正在看的终端时切到同目录另一个无主
   *  终端。两端的关闭都走它,保证标签栏可见/隐藏行为一致。不传则退回直接
   *  SESSION_CLOSE(向后兼容)。 */
  onClose?: (sessionId: string) => void;
  /** 失败 toast 推送器。给一个统一签名,内部包装 toast.push。 */
  toastError: (msg: string) => void;
}

export function buildSessionContextMenu(
  session: SessionInfo,
  deps: SessionMenuDeps,
): ContextMenuItem[] {
  const { variant, pathTree, copyToClipboard, onRename, toastError } = deps;
  const isOther = variant === 'other';
  // "在文件管理器中显示" 用 path-tree 节点的真实文件系统路径;节点不存在
  // (临时被 evict / 历史路径被清等)时回退到 session.originalCwd。
  const pathNode = findPathNode(pathTree, session.pathId);
  const explorerPath = pathNode?.path || session.originalCwd;
  // 6A:只有「客户端本机 backend + 非 SSH 路径」才显示 Explorer —— 远程
  // backend / SSH 的 Explorer 会在用户看不到的电脑/桌面打开。
  const showExplorer = window.api.backendProfileId === null && pathNode?.kind !== 'ssh';

  const invoke = window.api.invoke.bind(window.api);

  return [
    {
      label: '重命名…',
      disabled: isOther,
      ...(isOther ? { hint: '其他窗口持有,无法重命名' } : {}),
      onSelect: onRename,
    },
    {
      label: '在新窗口中打开',
      disabled: isOther,
      ...(isOther ? { hint: '其他窗口持有,无法移动' } : {}),
      onSelect: () => {
        invoke(COMMAND_CHANNELS.SESSION_OPEN_IN_NEW_WINDOW, {
          sessionId: session.id,
        }).catch((err: unknown) =>
          toastError(
            `打开新窗口失败:${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      },
    },
    {
      label: '在简易窗口中打开',
      disabled: isOther,
      ...(isOther ? { hint: '其他窗口持有,无法移动' } : {}),
      onSelect: () => {
        invoke(COMMAND_CHANNELS.SESSION_OPEN_IN_NEW_WINDOW, {
          sessionId: session.id,
          simpleMode: true,
        }).catch((err: unknown) =>
          toastError(
            `打开简易窗口失败:${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      },
    },
    {
      hidden: !showExplorer,
      label: '在文件管理器中显示',
      onSelect: () => {
        invoke(COMMAND_CHANNELS.SYSTEM_SHOW_IN_EXPLORER, {
          path: explorerPath,
        }).catch((err: unknown) =>
          toastError(
            `打开 Explorer 失败:${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      },
    },
    {
      label: '复制信息',
      submenu: [
        {
          label: '当前目录',
          onSelect: () => copyToClipboard(session.currentCwd, 'cwd'),
        },
        {
          label: '初始目录',
          onSelect: () => copyToClipboard(session.originalCwd, '初始路径'),
        },
        {
          label: `PID${session.pid > 0 ? ` (${session.pid})` : ''}`,
          disabled: session.pid <= 0,
          ...(session.pid <= 0 ? { hint: '进程已退出，无 PID' } : {}),
          onSelect: () => copyToClipboard(String(session.pid), 'PID'),
        },
      ],
    },
    { divider: true, label: '' },
    {
      label: '关闭',
      danger: true,
      disabled: isOther,
      onSelect: () => {
        if (deps.onClose) {
          deps.onClose(session.id);
          return;
        }
        invoke(COMMAND_CHANNELS.SESSION_CLOSE, {
          sessionId: session.id,
        }).catch((err: unknown) =>
          toastError(
            `关闭失败:${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      },
    },
  ];
}
