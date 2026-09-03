// [DEBUG-shift3] probe: launch win-unpacked Marina, screenshot + geometry dump via CDP.
// Usage: node scripts/debug-shift-layout-probe.cjs [exePath] [withEnv(0/1)] [tag]
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const http = require('node:http');
const fs = require('node:fs');
const WebSocket = require('ws');

const exe = process.argv[2] || resolve(__dirname, '../release/0.3.3-dev.12/win-unpacked/Marina.exe');
const withEnv = process.argv[3] === '1';
const tag = process.argv[4] || (withEnv ? 'env' : 'plain');

const PORT = 48190 + Math.floor(Math.random() * 50);
const userDataDir = mkdtempSync(join(tmpdir(), `marina-lp-${tag}-`));
// 可选:把指定 settings.json 复制进临时 profile 复现用户配置(只读源,不写回)
if (process.argv[5]) {
  fs.copyFileSync(process.argv[5], join(userDataDir, 'settings.json'));
  console.log(`[${tag}] seeded settings.json from ${process.argv[5]}`);
}
const outDir = resolve(__dirname, '../tmp-layout-probe');
fs.mkdirSync(outDir, { recursive: true });

const child = spawn(exe, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`], {
  env: { ...process.env, ...(withEnv ? { MARINA_SHIFT_CAPTURE: '1' } : {}), MARINA_SMOKE_INTERACTIVE: process.argv[6] === 'smoke' ? '1' : '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
console.log(`[${tag}] spawned PID=${child.pid} port=${PORT} userData=${userDataDir}`);
// 硬看门狗:2 分钟无论如何退出(防止脚本悬挂遗留进程)
setTimeout(() => { console.log(`[${tag}] WATCHDOG force-exit`); try { process.kill(child.pid); } catch {} process.exit(3); }, 120_000).unref();
let appLog = '';
child.stdout.on('data', d => { appLog += d; });
child.stderr.on('data', d => { appLog += d; });

const getJson = (path) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path }, r => {
    let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let targets = null;
  for (let i = 0; i < 45; i++) { await sleep(1000); try { targets = await getJson('/json/list'); break; } catch {} }
  if (!targets) { console.log('RESULT tag=' + tag + ' FAIL cdp-never-up'); child.kill(); process.exit(1); }

  // attach to the FIRST app page (skip devtools)
  let ws = null, pageUrl = '';
  for (let i = 0; i < 30 && !ws; i++) {
    const pages = (await getJson('/json/list')).filter(t => t.type === 'page' && !t.url.startsWith('devtools:'));
    for (const p of pages) {
      const w = new WebSocket(p.webSocketDebuggerUrl, { perMessageDeflate: false });
      await new Promise(res => w.once('open', res));
      // must be the marina app (file:// ... index.html), not an error page
      if (p.url.includes('index.html')) { ws = w; pageUrl = p.url; break; }
      w.close();
    }
    if (!ws) await sleep(1000);
  }
  if (!ws) { console.log('RESULT tag=' + tag + ' FAIL no-app-page'); child.kill(); process.exit(1); }
  console.log(`[${tag}] attached: ${pageUrl.slice(-60)}`);

  let msgId = 0;
  const pending = new Map();
  ws.on('message', raw => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++msgId;
    const to = setTimeout(() => { pending.delete(id); rej(new Error('cdp-timeout ' + method)); }, 15_000);
    pending.set(id, (m) => { clearTimeout(to); res(m); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const geometryExpression = `(() => {
    const r = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.left), y: Math.round(b.top) }; };
    return JSON.stringify({
      innerW: window.innerWidth, innerH: window.innerHeight, dpr: window.devicePixelRatio,
      appRoot: r('.app-root'), appBody: r('.app-body'), root: r('#root'), body: r('body'),
      mainPane: r('.main-pane'), terminalHost: r('.terminal-host'), termEl: r('.xterm'),
      screen: r('.xterm-screen'), viewport: r('.xterm-viewport'),
      settingsLayer: r('.settings-layer'),
      bodyChildren: [...document.body.children].map(c => c.tagName + '.' + [...c.classList].join('.')).join(','),
      cssLoaded: (() => { for (const s of document.styleSheets) { try { if (s.cssRules.length > 100) return true; } catch {} } return false; })(),
    }, null, 1);
  })()`;
  const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value;

  // give app 6s to settle layout (smoke 模式再等 session 建完)
  await sleep(process.argv[6] === 'smoke' ? 15000 : 6000);

  // 探测渲染线程是否响应(带恢复重试:首次超时后再等 20s 重试一次)
  let geom = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { geom = await ev(geometryExpression); break; }
    catch (e) {
      console.log(`[${tag}] renderer evaluate attempt ${attempt} FAILED (${e.message})${attempt === 1 ? ' — retry in 20s' : ''}`);
      if (attempt === 1) await sleep(20000);
    }
  }
  if (!geom) {
    console.log(`[${tag}] RENDERER WEDGED — keeping userData for evidence: ${userDataDir}`);
    child.kill();
    await sleep(2500); try { process.kill(child.pid); } catch {}
    process.exit(2);
  }
  console.log(`[${tag}] GEOMETRY:\n${geom}`);

  await send('Page.enable').catch(() => {});
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const png = Buffer.from(shot.result.data, 'base64');
  const pngPath = join(outDir, `layout-${tag}.png`);
  fs.writeFileSync(pngPath, png);
  console.log(`[${tag}] screenshot: ${pngPath} (${png.length} bytes)`);

  child.kill();
  await sleep(2500);
  // Windows 上 child.kill() 可能只终止主进程;按精确 PID 补刀(仅本脚本 spawn 的进程)
  try { process.kill(child.pid); } catch {}
  try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  process.exit(0);
})().catch(e => { console.error(e); child.kill(); process.exit(1); });
