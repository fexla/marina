// [DEBUG-shift1] runner for debug-shift-probe.html
const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1100, height: 700, show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  await win.loadFile(require('path').join(__dirname, 'debug-shift-probe.html'));
  for (const scenario of ['base', 'scrollbackGrow', 'resizeWider']) {
    const r = await win.webContents.executeJavaScript(`window.__probe('${scenario}')`, true);
    console.log(`\n########## ${scenario} ##########`);
    console.log('cols=' + r.termCols + ' rows=' + r.termRows + ' dpr=' + r.dpr);
    console.log('viewport: ' + JSON.stringify(r.viewport));
    console.log('canvas cssW=' + r.canvasCssW + ' backingW=' + r.canvasBackingW);
    console.log(r.tree);
  }
  app.quit();
}).catch(e => { console.error(e); app.quit(); });
