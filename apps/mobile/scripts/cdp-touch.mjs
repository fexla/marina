#!/usr/bin/env node
/**
 * @file apps/mobile/scripts/cdp-touch.mjs
 * @purpose 手机 WebView 的 CDP 触摸模拟工具:按住→(可选)移动→抬起,时序
 *   精确可控 —— adb input swipe 无法表达「长按 450ms 后再开始移动」这类
 *   序列,而触屏长按=右键 / 长按激活拖拽(dnd-kit delay)的验证正需要它。
 *   坐标是 CSS px(CDP Input 域即页面视口坐标,无需乘密度)。
 *   调试专用,不进任何构建链。
 *   用法: node cdp-touch.mjs '<json>'
 *   json 字段:{ x, y, x2?, y2?, holdMs?, moveMs?, steps? }
 *     x,y    按下点(CSS px)
 *     x2,y2  移动终点(省略 = 原地长按)
 *     holdMs 按住不动时长(默认 0;长按右键用 600,长按拖拽用 450)
 *     moveMs 移动耗时(默认 250)
 *     steps  移动插值步数(默认 10)
 */
const spec = JSON.parse(process.argv[2] ?? '{}');
const { x, y } = spec;
if (typeof x !== 'number' || typeof y !== 'number') {
  console.error('usage: node cdp-touch.mjs \'{"x":100,"y":200,"x2":300,"holdMs":450}\'');
  process.exit(1);
}
const x2 = typeof spec.x2 === 'number' ? spec.x2 : x;
const y2 = typeof spec.y2 === 'number' ? spec.y2 : y;
const holdMs = spec.holdMs ?? 0;
const moveMs = spec.moveMs ?? 250;
const steps = spec.steps ?? 10;

const list = await (await fetch('http://localhost:9222/json')).json();
const page = list.find((p) => p.type === 'page');
if (!page) throw new Error('no debuggable page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 8000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  }
};

await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
if (holdMs > 0) await sleep(holdMs);
if (x2 !== x || y2 !== y) {
  for (let i = 1; i <= steps; i++) {
    await sleep(moveMs / steps);
    await send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + ((x2 - x) * i) / steps, y: y + ((y2 - y) * i) / steps }],
    });
  }
}
await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
console.log(
  `touch done: (${x},${y}) hold=${holdMs}ms${x2 !== x || y2 !== y ? ` move->(${x2},${y2}) ${moveMs}ms` : ''}`,
);
ws.close();
