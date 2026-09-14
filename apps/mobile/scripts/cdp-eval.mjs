#!/usr/bin/env node
/**
 * @file apps/mobile/scripts/cdp-eval.mjs
 * @purpose 手机 WebView 的 CDP 快捷工具:adb forward 后对页面执行 JS 表达式
 *   并打印结果。调试专用,不进任何构建链。
 *   用法: node cdp-eval.mjs "<js expression>"
 */
const target = process.argv[2];
if (!target) {
  console.error('usage: node cdp-eval.mjs "<expression>"');
  process.exit(1);
}
const list = await (await fetch('http://localhost:9222/json')).json();
const page = list.find((p) => p.type === 'page');
if (!page) throw new Error('no debuggable page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
const id = 1;
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('CDP timeout')), 8000);
  ws.onopen = () => {
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression: target, returnByValue: true, awaitPromise: true },
    }));
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id === id) {
      clearTimeout(timer);
      resolve(msg.result?.result?.value ?? JSON.stringify(msg.result));
      ws.close();
    }
  };
  ws.onerror = (e) => reject(e);
});
console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
