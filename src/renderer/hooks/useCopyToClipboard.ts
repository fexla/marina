/**
 * @file src/renderer/hooks/useCopyToClipboard.ts
 * @purpose 抽离"写剪贴板 + toast 反馈"的重复样板(P2-11)。
 *
 *   早期 Sidebar PathItem / Sidebar SessionItem / MainPane Tab 各自重写
 *   过一份 copyToClipboard,逻辑完全一致(走 writeClipboardText,成功弹
 *   绿色 toast,失败弹红色 toast)。这里收敛成一个 hook,保证行为一致 +
 *   后续要换 toast 文案 / 加遥测 / 改 hint 都只改一处。
 *
 *   语义:返回一个 (text, label) => void 的同步触发函数,内部 fire-and-forget。
 *   失败不抛错,只用 toast 提示 — 复制路径几乎不会失败,出错也只是 UX 降级。
 */
import { useCallback } from 'react';
import { writeClipboardText } from '../clipboard';
import { useToast } from '../components/Toast';

export function useCopyToClipboard(): (text: string, label: string) => void {
  const toast = useToast();
  return useCallback(
    (text: string, label: string): void => {
      void writeClipboardText(text).then((ok) => {
        toast.push(
          ok
            ? { kind: 'success', message: `已复制 ${label}` }
            : { kind: 'error', message: '复制失败' },
        );
      });
    },
    [toast],
  );
}
