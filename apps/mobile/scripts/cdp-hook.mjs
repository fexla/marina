#!/usr/bin/env node
/**
 * @file apps/mobile/scripts/cdp-hook.mjs
 * @purpose 手机 WebView 的页面级异常/拒绝钩子:用 Page.addScriptToEvaluateOnNewDocument
 *   在下个文档起点注入 window.onerror + unhandledrejection 捕获器(带完整堆栈,
 *   存 window.__uncaught),供事后 Runtime.evaluate 读取。解决 CDP
 *   exceptionThrown 在部分场景不给堆栈的问题。
 *   用法: node cdp-hook.mjs install   # 注入(对下一个文档生效)
 *         node cdp-eval.mjs "JSON.stringify(window.__uncaught)"
 */
const mode = process.argv[2] ?? 'install';
const list = await (await fetch('http://localhost:9222/json')).json();
const page = list.find((p) => p.type === 'page');
if (!page) throw new Error('no debuggable page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
const HOOK = `
window.__uncaught = [];
window.addEventListener('error', (e) => {
  window.__uncaught.push({ kind: 'error', msg: String(e.message), stack: e.error && e.error.stack ? String(e.error.stack) : '', at: Date.now() });
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  window.__uncaught.push({ kind: 'rejection', msg: r && r.message ? String(r.message) : String(r), stack: r && r.stack ? String(r.stack) : '', at: Date.now() });
});
`;
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('CDP timeout')), 8000);
  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        id: 1,
        method: 'Page.addScriptToEvaluateOnNewDocument',
        params: { source: HOOK },
      }),
    );
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id === 1) {
      clearTimeout(timer);
      resolve(msg.result ?? msg.error);
      ws.close();
    }
  };
  ws.onerror = (e) => reject(e);
});
console.log(mode, JSON.stringify(result));
