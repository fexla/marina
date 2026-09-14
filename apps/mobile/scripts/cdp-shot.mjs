#!/usr/bin/env node
/**
 * @file apps/mobile/scripts/cdp-shot.mjs
 * @purpose 手机 WebView 的 CDP 截图工具:在 Node 侧直接向 DevTools 协议发
 *   Page.captureScreenshot,保存 PNG。截图必须走 Node 侧 WebSocket ——
 *   Runtime.evaluate 在页面上下文执行,页面里连不上 PC 的 9222。
 *   用法: node cdp-shot.mjs <output.png>
 */
const out = process.argv[2];
if (!out) {
  console.error('usage: node cdp-shot.mjs <output.png>');
  process.exit(1);
}
const list = await (await fetch('http://localhost:9222/json')).json();
const page = list.find((p) => p.type === 'page');
if (!page) throw new Error('no debuggable page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
const shot = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('CDP timeout')), 10000);
  ws.onopen = () => {
    ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }));
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id === 1) {
      clearTimeout(timer);
      if (msg.result?.data) resolve(Buffer.from(msg.result.data, 'base64'));
      else reject(new Error('screenshot failed: ' + JSON.stringify(msg).slice(0, 200)));
      ws.close();
    }
  };
  ws.onerror = (e) => reject(e);
});
await import('node:fs').then((fs) => fs.writeFileSync(out, shot));
console.log('saved', out, shot.length, 'bytes');
