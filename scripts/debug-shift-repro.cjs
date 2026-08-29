// [DEBUG-shift2] runner: auto-repro loop for the terminal left-shift glitch.
// Usage: npx electron scripts/debug-shift-repro.cjs [sim|pi|shell] [minutes] [targetDpr]
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');

const mode = process.argv[2] || 'sim';
const minutes = parseFloat(process.argv[3] || '5');
const targetDpr = parseFloat(process.argv[4] || '1.15');

let pty = null;
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1100, height: 700, show: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  const baseDprPromise = win.webContents.executeJavaScript('window.devicePixelRatio');
  win.webContents.on('console-message', (_e, _lvl, msg) => {
    console.log(String(msg).slice(0, 6000));
  });
  win.webContents.on('render-process-gone', (_e, d) => console.log('[runner] RENDER GONE', d.reason));

  // ── PTY in main (node-pty ConPTY needs worker threads) ──
  const { spawn } = require('node-pty');
  ipcMain.on('pty-spawn', (_e, { mode: m, cols, rows }) => {
    const cwd = os.tmpdir();
    let file, args;
    if (m === 'sim') { file = process.execPath; args = [path.resolve(__dirname, 'debug-shift-tui-sim.mjs'), String(cols), String(rows)]; }
    else if (m === 'pi') { file = 'cmd.exe'; args = ['/c', 'pi']; }
    else { file = 'powershell.exe'; args = ['-NoLogo']; }
    pty = spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env: process.env });
    console.log(`[runner] pty spawned mode=${m} pid=${pty.pid}`);
    pty.onData(d => win.webContents.send('pty-out', d));
    pty.onExit(({ exitCode }) => win.webContents.send('pty-exit', exitCode));
  });
  ipcMain.on('pty-in', (_e, d) => { try { pty && pty.write(d); } catch {} });
  ipcMain.on('pty-resize', (_e, { cols, rows }) => { try { pty && pty.resize(cols, rows); } catch {} });
  ipcMain.on('pty-kill', () => { try { pty && pty.kill(); } catch {} });

  await win.loadFile(path.join(__dirname, 'debug-shift-repro.html'), {
    query: { mode },
  });
  const baseDpr = await baseDprPromise;
  win.webContents.setZoomFactor(1); // reset any persisted zoom first
  const zoom = targetDpr / baseDpr;
  win.webContents.setZoomFactor(zoom);
  const eff = await win.webContents.executeJavaScript('window.devicePixelRatio');
  console.log(`[runner] mode=${mode} minutes=${minutes} baseDpr=${baseDpr} zoom=${zoom.toFixed(3)} effectiveDpr=${eff}`);

  win.webContents.on('console-message', () => {}); // keep single listener; logs above

  setTimeout(() => { console.log('[runner] time up, exiting'); app.quit(); }, minutes * 60_000);
  win.on('closed', () => app.quit());
}).catch(e => { console.error(e); app.quit(); });
