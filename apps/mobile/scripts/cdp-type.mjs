#!/usr/bin/env node
/**
 * @file apps/mobile/scripts/cdp-type.mjs
 * @purpose 手机 WebView 的 CDP 键盘输入工具:Input.dispatchKeyEvent 合成真实
 *   按键(比 DOM 事件保真,xterm 的 keydown 路径能收到)。先 focus xterm 的
 *   隐藏 textarea,再逐字符发送。
 *   用法: node cdp-type.mjs "文本" [--enter]
 */
const text = process.argv[2] ?? '';
const withEnter = process.argv.includes('--enter');
if (!text && !withEnter) {
  console.error('usage: node cdp-type.mjs "text" [--enter]');
  process.exit(1);
}
const list = await (await fetch('http://localhost:9222/json')).json();
const page = list.find((p) => p.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 0;
const send = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    const timer = setTimeout(() => reject(new Error('timeout ' + method)), 5000);
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === id) {
        clearTimeout(timer);
        ws.removeEventListener('message', onMsg);
        resolve(m.result);
      }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });

await new Promise((r) => (ws.onopen = r));
await send('Runtime.evaluate', {
  expression: "document.querySelector('.xterm-helper-textarea')?.focus()",
});
for (const ch of text) {
  await send('Input.dispatchKeyEvent', { type: 'char', text: ch });
}
if (withEnter) {
  await send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
}
ws.close();
console.log('typed:', JSON.stringify(text), withEnter ? '+Enter' : '');
