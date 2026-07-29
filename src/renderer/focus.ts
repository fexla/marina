/**
 * @file src/renderer/focus.ts
 * @purpose 跨组件焦点归还入口。当 chrome 按钮 / Tab / ContextMenu / Modal
 *   等 UI 副作用让焦点漂离 xterm 时,统一通过 focusTerminalDom() 把焦点
 *   送回 .xterm-helper-textarea。
 *
 * @背景:Marina 主打"鼠标优先",chrome / tab 按钮是日常路径,每次点完都
 *   要让用户能直接打字。Chromium 原生行为是 click 后 :focus 留在 button
 *   上,需要应用层主动归还。审计条目 FOC-2/3/5/6 都是同根问题。
 *
 * @设计选择:
 * - 走 DOM 查询而非 ref 传递 — 跨组件传 termRef 会让 MainPane / WindowChrome
 *   依赖 TerminalView 内部实现,违反 React 组件边界。.xterm-helper-textarea
 *   是 xterm.js 公开的 DOM 接口,稳定 5+ 年。
 * - requestAnimationFrame 包一层 — dispatch 后 React commit 是 microtask,
 *   下一帧才会有最终 DOM 节点。rAF 保证 query 时 React 已经把 TerminalView
 *   挂上去了(尤其是新建 session 后第一次 focus)。
 * - 同时 guard "搜索栏可见": 搜索期间用户的焦点应该留在 search input,
 *   不能被偷走。检测方式 = 看 .terminal-search-input 是否是 activeElement
 *   或父级 .terminal-search-bar 是否存在 + 是其 descendant。简化为查
 *   .terminal-search-bar 存在与否,因为搜索栏 mount 即可见。
 *
 * @调用时机:
 * - Tab handleClick / handleClickBlankTab 末尾 (FOC-2)
 * - WindowChrome callMin / callToggleMax 末尾 (FOC-3)
 * - ContextMenu / Toast / Modal 关闭后 (FOC-5)
 * - MainPane 监听 selectedSessionId 变化的 useEffect (FOC-6)
 *
 * 不调用 (xterm 自管):
 * - TerminalView 内部的 paste/copy/drop/mount (走 TerminalView 自带的
 *   focusTerminal helper,带 termRef 校验,更精确)
 */

/**
 * 把焦点归还给 xterm 的 helper-textarea。
 *
 * - 搜索栏可见时跳过(让用户保持搜索 input 焦点)
 * - 设置视图打开时跳过(让设置页的输入框正常工作)
 * - 没有 .xterm-helper-textarea 时静默(EmptyPathState / 启动期等)
 *
 * 异步 (rAF) — 不要假设调用后下一行代码焦点已就位。
 */
export function focusTerminalDom(): void {
  requestAnimationFrame(() => {
    // 搜索栏存在且 input 在 viewport 内 → 用户正在搜索,不抢焦点
    const searchInput = document.querySelector<HTMLInputElement>(
      '.terminal-search-input',
    );
    if (searchInput && document.activeElement === searchInput) return;
    // Modal 打开时跳过(自绘 Modal 自己管理焦点 trap)
    if (document.querySelector('.app-modal-backdrop')) return;
    // 设置视图打开时跳过(用户在编辑设置)
    if (document.querySelector('.settings-view')) return;
    const ta = document.querySelector<HTMLTextAreaElement>(
      '[data-terminal-active="true"] .xterm-helper-textarea',
    );
    // helper textarea 跟随终端光标放在当前 cursor 行。若用户停在历史位置,
    // 裸 focus() 会让浏览器为“把 textarea 滚进视口”而移动 xterm viewport,
    // 把刚恢复的位置重新拉到底。xterm 自身 focus() 也明确使用同一选项。
    ta?.focus({ preventScroll: true });
  });
}
