/**
 * @file src/renderer/hooks/usePanelSearchShortcut.ts
 * @purpose 监听全局 Ctrl+F,打开 dock 面板共享搜索栏。
 *
 * @关键设计:
 * - window 级 capture-phase keydown。capture 阶段先于 xterm / input 的 keydown,
 *   但终端的 Ctrl+F 走 xterm.attachCustomKeyEventHandler(在 xterm 内部消化,不
 *   冒泡到 window)—— 所以终端有焦点时本 hook 收不到 Ctrl+F,行为正确(终端搜终端的)。
 * - 焦点在 input/textarea/contenteditable 时不拦截(用户可能在表单输入,避免误触);
 *   但搜索栏自己的 input 不在此限(打开后能正常输入)。
 * - 调用 onOpen 打开搜索(父级 setState visible=true + 聚焦 input)。
 *
 * @不在这里做的事:
 * - 不处理 Esc/Enter(那在 SearchBar 组件的 onKeyDown 里)
 * - 不决定搜哪个面板(那是 LayoutHost 按 activePanelId 决定的)
 *
 * @对应文档:docs/方案-面板Ctrl-F搜索-20260719.md §3.1
 */
import { useEffect } from 'react';

/**
 * @param enabled 是否启用快捷键(搜索栏已打开时可禁用,避免重复触发;或简易模式禁用)
 * @param onOpen Ctrl+F 触发时调用(打开搜索栏 + 聚焦)
 */
export function usePanelSearchShortcut(enabled: boolean, onOpen: () => void): void {
  useEffect(() => {
    if (!enabled) return undefined;
    const handler = (e: KeyboardEvent): void => {
      // 只认 Ctrl+F(不认 Cmd+F:Windows 产品。macOS 留待跨平台时加)
      if (!(e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key === 'f')) return;
      // 焦点在可编辑元素时不拦截(用户在表单/搜索栏输入)
      const active = document.activeElement;
      if (active instanceof HTMLElement) {
        const tag = active.tagName.toLowerCase();
        if (
          tag === 'input' ||
          tag === 'textarea' ||
          tag === 'select' ||
          active.isContentEditable
        ) {
          return;
        }
      }
      e.preventDefault();
      e.stopPropagation();
      onOpen();
    };
    // capture 阶段:先于目标元素。如果终端 xterm 没吃 Ctrl+F(如焦点在 dock),
    // 本监听先拿到。
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [enabled, onOpen]);
}
