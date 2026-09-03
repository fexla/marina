// [DEBUG-shift3] probe v2: launch Marina, create a REAL session via window.api
// (mirrors the user's manual action), then dump geometry before/after + screenshot.
// No smoke harness (it self-exits and races the probe).
// Usage: node scripts/debug-shift-layout-probe2.cjs [exePath] [tag]
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const http = require('node:http');
const fs = require('node:fs');
const WebSocket = require('ws');

const exe = process.argv[2] || resolve(__dirname, '../release/0.3.3-dev.12/win-unpacked/Marina.exe');
const tag = process.argv[3] || 'probe2';

const PORT = 48300 + Math.floor(Math.random() * 30);
const userDataDir = mkdtempSync(join(tmpdir(), `marina-p2-${tag}-`));
const outDir = resolve(__dirname, '../tmp-layout-probe');
fs.mkdirSync(outDir, { recursive: true });

const child = spawn(exe, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`], {
  env: { ...process.env },
  stdio: ['ignore', 'pipe', 'pipe'],
});
console.log(`[${tag}] spawned PID=${child.pid} port=${PORT}`);
let appOut = '';
child.stdout.on('data', d => { appOut += d.toString(); });
child.stderr.on('data', d => { appOut += d.toString(); });
setTimeout(() => { console.log(`[${tag}] WATCHDOG force-exit`); try { process.kill(child.pid); } catch {} process.exit(3); }, 150_000).unref();

const getJson = (path) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path }, r => {
    let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let targets = null;
  for (let i = 0; i < 45; i++) { await sleep(1000); try { targets = await getJson('/json/list'); break; } catch {} }
  if (!targets) { console.log('FAIL cdp-never-up'); child.kill(); process.exit(1); }

  let ws = null, pageUrl = '';
  for (let i = 0; i < 40 && !ws; i++) {
    const pages = (await getJson('/json/list')).filter(t => t.type === 'page' && t.url.includes('index.html'));
    for (const p of pages) {
      const w = new WebSocket(p.webSocketDebuggerUrl, { perMessageDeflate: false });
      await new Promise(res => w.once('open', res));
      ws = w; pageUrl = p.url; break;
    }
    if (!ws) await sleep(1000);
  }
  if (!ws) { console.log('FAIL no-app-page'); child.kill(); process.exit(1); }
  console.log(`[${tag}] attached`);

  let msgId = 0;
  const pending = new Map();
  ws.on('message', raw => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  ws.on('close', () => { console.log(`[${tag}] ws closed (app exited?)`); });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++msgId;
    const to = setTimeout(() => { pending.delete(id); rej(new Error('cdp-timeout ' + method)); }, 20_000);
    pending.set(id, (m) => { clearTimeout(to); res(m); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error('page-exception: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 500));
    return r.result?.result?.value;
  };
  await send('Page.enable').catch(() => {});

  const GEOM = `(() => {
    const r = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.left), y: Math.round(b.top) }; };
    return JSON.stringify({
      innerW: window.innerWidth, innerH: window.innerHeight,
      appRoot: r('.app-root'), mainPane: r('.main-pane'), terminalHost: r('.terminal-host'),
      termEl: r('.xterm'), screen: r('.xterm-screen'), viewport: r('.xterm-viewport'), canvas: r('.xterm-screen canvas'),
      nTermHosts: document.querySelectorAll('.terminal-host').length,
      bodyChildren: [...document.body.children].map(c => c.tagName + '.' + [...c.classList].join('.')).join(','),
    });
  })()`;

  const TREE = `(() => {
    const out = [];
    const walk = (el, d) => { const b = el.getBoundingClientRect();
      out.push('  '.repeat(d) + el.tagName + '.' + [...el.classList].join('.') + ' [' + Math.round(b.width) + 'x' + Math.round(b.height) + '@' + Math.round(b.left) + ',' + Math.round(b.top) + ']');
      for (const c of el.children) walk(c, d+1); };
    const host = document.querySelector('.terminal-host');
    if (host) walk(host, 0);
    return out.join('\\n');
  })()`;

  await sleep(5000);
  console.log(`[${tag}] BEFORE-SESSION: ${await ev(GEOM)}`);

  const created = await ev(`window.api.invoke('cmd:session:create', { cols: 120, rows: 30 }).then(r => JSON.stringify({ id: r?.session?.id, ok: !!r?.session }))`);
  console.log(`[${tag}] session-create: ${created}`);
  await sleep(6000);
  console.log(`[${tag}] AFTER-SESSION: ${await ev(GEOM)}`);
  console.log(`[${tag}] TREE-AFTER:\n${await ev(TREE)}`);
  await sleep(6000);
  console.log(`[${tag}] AFTER+12s: ${await ev(GEOM)}`);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const png = Buffer.from(shot.result.data, 'base64');
  const pngPath = join(outDir, `layout-${tag}.png`);
  fs.writeFileSync(pngPath, png);
  console.log(`[${tag}] screenshot: ${pngPath} (${png.length} bytes)`);

  child.kill();
  await sleep(2500); try { process.kill(child.pid); } catch {}
  try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  process.exit(0);
})().catch(e => {
  console.error('PROBE ERROR:', e.message);
  console.log('--- app stdout tail ---');
  console.log(appOut.split('\n').slice(-15).join('\n'));
  try { process.kill(child.pid); } catch {}
  process.exit(1);
});
