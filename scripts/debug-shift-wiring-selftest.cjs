// [DEBUG-shift2] end-to-end wiring self-test for the shift-capture instrumentation.
// Launches the unpacked Marina with MARINA_SHIFT_CAPTURE=1 + smoke-interactive
// session creation, then via CDP injects an artificial horizontal overflow into
// .xterm-viewport and verifies that logs/shift-capture-*.log + *.png appear.
const { spawn } = require('node:child_process');
const { mkdtempSync, readdirSync, existsSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const http = require('node:http');

const projectRoot = resolve(__dirname, '..');
const exe = join(projectRoot, 'release', '0.3.3-dev.12', 'win-unpacked', 'Marina.exe');
if (!existsSync(exe)) { console.error('unpack exe missing:', exe); process.exit(1); }

const userDataDir = mkdtempSync(join(tmpdir(), 'marina-shiftcap-'));
const PORT = 48191;
const child = spawn(exe, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userDataDir}`,
], {
  env: {
    ...process.env,
    MARINA_SHIFT_CAPTURE: '1',
    MARINA_SMOKE_INTERACTIVE: '1', // creates a real session for us
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', d => process.stdout.write('[app] ' + d));
child.stderr.on('data', d => process.stdout.write('[app-err] ' + d));

const getJson = (path) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path }, r => {
    let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function cdpSend(ws, id, method, params) {
  ws.send(JSON.stringify({ id, method, params }));
}

(async () => {
  // wait for CDP endpoint
  let targets = null;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    try { targets = await getJson('/json/list'); break; } catch {}
  }
  if (!targets) { console.error('FAIL: CDP never came up'); child.kill(); process.exit(1); }
  console.log(`CDP up, ${targets.length} targets`);

  // wait for a terminal-host to exist (session created by smoke harness)
  let pageWs = null;
  const WebSocket = require('ws');
  for (let i = 0; i < 45; i++) {
    const pages = (await getJson('/json/list')).filter(t => t.type === 'page' && !t.url.startsWith('devtools:'));
    for (const p of pages) {
      const ws = new WebSocket(p.webSocketDebuggerUrl, { perMessageDeflate: false });
      await new Promise(res => ws.once('open', res));
      const hasTerm = await new Promise(res => {
        const id = Math.floor(Math.random() * 1e6);
        const onMsg = (raw) => { const m = JSON.parse(raw); if (m.id === id) { ws.off('message', onMsg); res(m.result?.result?.value); } };
        ws.on('message', onMsg);
        cdpSend(ws, id, 'Runtime.evaluate', { expression: `!!document.querySelector('.terminal-host .xterm')`, returnByValue: true });
      });
      if (hasTerm) { pageWs = ws; break; } else ws.close();
    }
    if (pageWs) break;
    await sleep(1000);
  }
  if (!pageWs) { console.error('FAIL: no terminal found in any page'); child.kill(); process.exit(1); }
  console.log('terminal-host found');

  // inject artificial horizontal overflow into .xterm-viewport
  const evalOn = (expr) => new Promise(res => {
    const id = Math.floor(Math.random() * 1e6);
    const onMsg = (raw) => { const m = JSON.parse(raw); if (m.id === id) { pageWs.off('message', onMsg); res(m.result); } };
    pageWs.on('message', onMsg);
    cdpSend(pageWs, id, 'Runtime.evaluate', { expression: expr, returnByValue: true });
  });

  const vp = await evalOn(`(() => {
    const vp = document.querySelector('.terminal-host .xterm-viewport');
    if (!vp) return 'no-viewport';
    const d = document.createElement('div');
    d.style.width = '99999px'; d.style.height = '1px';
    vp.appendChild(d);
    return 'injected sw=' + vp.scrollWidth + ' cw=' + vp.clientWidth;
  })()`);
  console.log('inject result:', JSON.stringify(vp));

  // wait for detector (250ms poll + report) then check logs
  const logsDir = join(userDataDir, 'logs');
  let ok = false;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    if (existsSync(logsDir)) {
      const files = readdirSync(logsDir);
      const logF = files.filter(f => f.startsWith('shift-capture') && f.endsWith('.log'));
      const pngF = files.filter(f => f.startsWith('shift-capture') && f.endsWith('.png'));
      if (logF.length) {
        console.log('SHIFT-CAPTURE LOG WRITTEN:', logF);
        if (pngF.length) console.log('SCREENSHOT WRITTEN:', pngF);
        ok = true; break;
      }
    }
  }
  console.log(ok ? 'WIRING SELF-TEST: PASS' : 'WIRING SELF-TEST: FAIL (no capture fired)');
  child.kill();
  await sleep(1500);
  try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); child.kill(); process.exit(1); });
