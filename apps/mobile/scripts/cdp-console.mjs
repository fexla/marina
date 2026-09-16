#!/usr/bin/env node
/**
 * @file apps/mobile/scripts/cdp-console.mjs
 * @purpose 手机 WebView 的控制台/异常监听工具:adb forward 后挂 Log+Runtime
 *   域,把 console 调用与未捕获异常实时打出来,持续监听直到 Ctrl+C 或
 *   durationMs 到点。调试专用,不进任何构建链。
 *   用法: node cdp-console.mjs [durationMs=15000]
 */
const durationMs = Number(process.argv[2] ?? 15000);
const list = await (await fetch('http://localhost:9222/json')).json();
const page = list.find((p) => p.type === 'page');
if (!page) throw new Error('no debuggable page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
ws.onopen = () => {
  ws.send(JSON.stringify({ id: 1, method: 'Log.enable' }));
  ws.send(JSON.stringify({ id: 2, method: 'Runtime.enable' }));
  console.log(`[cdp-console] listening for ${durationMs}ms ...`);
};
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ');
    console.log(`[console.${msg.params.type}] ${text}`);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    const frames = (d.stackTrace?.callFrames ?? [])
      .slice(0, 6)
      .map((f) => `${f.functionName || '<anon>'}@${f.url.split('/').pop()}:${f.lineNumber + 1}`)
      .join(' <- ');
    console.log(
      `[exception] ${d.text} ${d.exception?.description ?? ''} | ${frames}`.slice(0, 800),
    );
  } else if (msg.method === 'Log.entryAdded') {
    const e = msg.params.entry;
    console.log(`[log.${e.level}] ${e.source}: ${e.text} url=${e.url ?? ''}`.slice(0, 500));
  }
};
ws.onerror = (e) => {
  console.error('[cdp-console] ws error', e.message ?? e);
  process.exit(1);
};
setTimeout(() => {
  console.log('[cdp-console] done');
  process.exit(0);
}, durationMs);
