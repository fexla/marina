/**
 * @file src/main/smoke-interactive.ts
 * @purpose 交互级冒烟测试 harness。**仅在 MARINA_SMOKE_INTERACTIVE=1 时**
 *   被 main/index.ts 装载,生产路径完全不引入。
 *
 * @背景
 * scripts/smoke-launch.mjs 只验证 main 起得来、preload 不爆。但起来之后
 * 用户能不能正常用,完全不知道 — 本次 OSC-3/4 / PER-2 race 都属于"程序
 * 起来了但行为错"层面,smoke-launch 抓不到。
 *
 * 本 harness 走真实 IPC 链路:第一个 BrowserWindow did-finish-load 后,
 * webContents.executeJavaScript 注入一段测试脚本,脚本里调
 *   window.api.invoke('cmd:session:create', ...)
 *   window.api.on('evt:session:output', ...)
 *   window.api.invoke('cmd:session:send-input', ...)
 * 端到端验证"PTY echo 唯一 marker 能在 N 秒内回来"。结果通过自定义
 * IPC channel 'smoke:report' 回报给 main,main 写 stdout 后 app.exit
 * 退出码 = 0/1。
 *
 * @能抓
 * - 本次 OSC-3/4 渲染丢内容(echo marker 被 OSC parser 误吞)
 * - 本次 PER-2 race(双写不影响 marker 命中,但能抓 emit 完全不到 renderer)
 * - 一般 IPC handler 注册失败 / preload bridge 漏方法 / session-create 失败
 * - PTY spawn 失败 / sendInput 失败 / sessionOutput 通路断
 *
 * @不抓
 * - 纯 UI / 视觉问题(xterm 渲染、css 样式等 — 需 Playwright DOM 断言)
 * - 多窗口 / 多 session 并发场景
 * - 输入法 / 复制粘贴 / 拖放等用户交互
 *
 * @对应文档章节: AGENTS.md 5.3 必测项的"端到端冒烟"补强
 */
import { app, ipcMain, type BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MAX_WAIT_FIRST_WINDOW_MS = 8000;
const TEST_TIMEOUT_MS =
  process.env['MARINA_SMOKE_TERMINAL_DECK'] === '1' ||
  process.env['MARINA_SMOKE_FILE_VIEWER_SCROLL'] === '1' ||
  process.env['MARINA_SMOKE_FILE_VIEWER_HTML'] === '1'
    ? 22_000
    : 12_000;

interface SmokeReport {
  pass: boolean;
  reason: string;
  durationMs: number;
}

/**
 * 装载 harness。**只在 MARINA_SMOKE_INTERACTIVE=1 时被调用**。
 *
 * @param getFirstWindow 拿当前第一个(且只有一个,smoke 模式下不开多窗)
 *   BrowserWindow 的 getter。main 启动期 createWindowFromFactory 后窗口
 *   就在了,但 contents 加载是异步的,因此这里轮询等 first window 出现。
 */
export function installSmokeInteractiveHarness(getFirstWindow: () => BrowserWindow | null): void {
  const t0 = Date.now();
  let finished = false;
  const finish = (pass: boolean, reason: string): void => {
    if (finished) return;
    finished = true;
    const ms = Date.now() - t0;
    // stdout 单行 token,外部 scripts/smoke-interactive.mjs 据此判断结果
    process.stdout.write(`[smoke-interactive] ${pass ? 'PASS' : 'FAIL'} ${ms}ms — ${reason}\n`);
    // 给 stdout flush + Electron 内部清理一点时间再退
    setTimeout(() => app.exit(pass ? 0 : 1), 100);
  };

  // ipcMain 用 once 是因为 smoke 只跑一次,接到 report 立刻退;再来的 report
  // 走 fallback handler(理论上不该有)
  //
  // 注:preload 的 window.api.invoke(channel, payload) 会把 payload 包成
  // CommandEnvelope { windowId, requestId, payload },因此 handler 拿到的
  // 是 envelope,需要 .payload 取实际报告。
  interface ReportEnvelope {
    windowId?: string;
    requestId?: string;
    payload: SmokeReport;
  }
  ipcMain.handleOnce(
    'smoke:report',
    async (_e, envelope: ReportEnvelope): Promise<{ ok: true }> => {
      const report = envelope?.payload ?? (envelope as unknown as SmokeReport);
      finish(report.pass, report.reason);
      return { ok: true };
    },
  );

  // 轮询等 first window did-finish-load,注入测试脚本
  let pollIv: NodeJS.Timeout | null = null;
  let injected = false;
  const tryInject = (): void => {
    if (injected) return;
    const win = getFirstWindow();
    if (!win || win.isDestroyed()) return;
    injected = true;
    if (pollIv) {
      clearInterval(pollIv);
      pollIv = null;
    }
    // did-finish-load 后再注入 — 此时 preload 已建好 window.api
    const wc = win.webContents;
    // 把 renderer 的 console.log / warn / error 全转到 main stdout,
    // smoke 失败时 stack trace 可见
    wc.on('console-message', (_e, level, message, line, sourceId) => {
      process.stdout.write(`[renderer console L${level} ${sourceId}:${line}] ${message}\n`);
    });
    wc.on('render-process-gone', (_e, details) => {
      finish(false, `render-process-gone: ${JSON.stringify(details)}`);
    });
    const inject = (): void => {
      const script =
        process.env['MARINA_SMOKE_FILE_VIEWER_HTML'] === '1'
          ? buildFileViewerHtmlTestScript()
          : process.env['MARINA_SMOKE_FILE_VIEWER_SCROLL'] === '1'
            ? buildFileViewerScrollTestScript()
            : process.env['MARINA_SMOKE_TERMINAL_DECK'] === '1'
              ? buildTerminalDeckTestScript()
              : buildTestScript();
      wc.executeJavaScript(script, true).catch((err) => {
        finish(false, `executeJavaScript failed: ${err?.message ?? String(err)}`);
      });
    };
    if (wc.isLoading()) {
      wc.once('did-finish-load', inject);
    } else {
      inject();
    }
  };
  pollIv = setInterval(tryInject, 50);
  setTimeout(() => {
    if (pollIv) {
      clearInterval(pollIv);
      pollIv = null;
    }
    if (!injected) {
      finish(
        false,
        `${MAX_WAIT_FIRST_WINDOW_MS}ms 内 first BrowserWindow 未出现,main 启动流程异常`,
      );
    }
  }, MAX_WAIT_FIRST_WINDOW_MS);
}

/**
 * 注入到 renderer 的测试脚本。返回 string,在 webContents 上下文里 eval。
 *
 * 关键设计:
 * - 用唯一 random token + 'ECHO' 后缀,避免被 banner / shell prompt 的
 *   其他字符干扰
 * - 用 atob 解码 base64 输出,纯字符串比对(不依赖 xterm.write 实际渲染)
 * - 同步注册 evt:session:output listener,再触发 create — 不漏 banner 字节
 * - 容忍 PowerShell readline 回显:命中 token 任意一次即算通过
 *   (echo 命令的 readline 回显 + 执行后输出至少有一次)
 * - try/catch 兜底,任何步骤抛错都 report FAIL
 */
function buildTestScript(): string {
  // 注:这里返回的是一段 IIFE,会在 renderer 全局上下文执行。
  // 不能用 TS 语法 — 必须是合法 JS。eslint 关掉(模板字符串里)。
  // TOKEN 在 main 端生成,渲染端 substitute,避免 renderer 端依赖 crypto。
  const TOKEN = `SMOKE_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  return `
(async () => {
  var t0 = Date.now();
  var captured = '';
  var off = null;
  var done = false;
  function report(pass, reason) {
    if (done) return;
    done = true;
    try { off && off(); } catch (_) {}
    try {
      window.api.invoke('smoke:report', {
        pass: pass,
        reason: reason,
        durationMs: Date.now() - t0,
      });
    } catch (e) {
      console.error('[smoke] report invoke failed', e);
    }
  }
  try {
    if (!window.api || typeof window.api.invoke !== 'function' || typeof window.api.on !== 'function') {
      return report(false, 'preload bridge 缺失 — window.api.invoke / .on 不可用');
    }

    // 创建 session — pathId 缺省时 SessionManager 用 homedir 起 shell
    var createRes = await window.api.invoke('cmd:session:create', {
      cols: 80,
      rows: 24,
    });
    if (!createRes || !createRes.session || !createRes.session.id) {
      return report(false, 'session-create 返回异常: ' + JSON.stringify(createRes));
    }
    var sid = createRes.session.id;

    // 订阅输出(必须在 send-input 之前注册,避免漏字节)
    off = window.api.on('evt:session:output', function (p) {
      if (!p || p.sessionId !== sid) return;
      try {
        captured += atob(p.data);
      } catch (e) { /* ignore base64 异常 */ }
      if (captured.indexOf('${TOKEN}') >= 0) {
        report(true, 'PTY round-trip ok — token "${TOKEN}" 在 ' + (Date.now() - t0) + 'ms 内回环, captured=' + captured.length + ' bytes');
      }
    });

    // 等 shell prompt 起来(PowerShell profile 加载可能花 500-1500ms)
    await new Promise(function (r) { setTimeout(r, 1500); });

    // 发 echo TOKEN + 回车;data 走 base64
    var cmd = 'echo ${TOKEN}\\r';
    var b64 = btoa(cmd);
    var sendRes = await window.api.invoke('cmd:session:send-input', {
      sessionId: sid,
      data: b64,
    });
    if (!sendRes || sendRes.accepted !== true) {
      return report(false, 'send-input 被拒: ' + JSON.stringify(sendRes));
    }

    // 8s 兜底超时
    setTimeout(function () {
      if (done) return;
      var tail = captured.slice(-200);
      // 用 JSON.stringify 让控制字符可见
      report(false, '8s 内未在 sessionOutput 看到 token "${TOKEN}", 末 200 字节=' + JSON.stringify(tail));
    }, 8000);
  } catch (err) {
    report(false, 'exception: ' + (err && err.message ? err.message : String(err)));
  }
})();
`;
}

/**
 * 真实 Electron 终端 deck 冒烟:验证 A→B→A 使用同一个 xterm viewport DOM,
 * 且 A parked(owner=null)期间仍收到输出、滚动位置不被拉到底。
 * 启用:MARINA_SMOKE_INTERACTIVE=1 + MARINA_SMOKE_TERMINAL_DECK=1。
 */
function buildTerminalDeckTestScript(): string {
  return `
(async () => {
  var t0 = Date.now();
  var done = false;
  function report(pass, reason) {
    if (done) return;
    done = true;
    window.api.invoke('smoke:report', {
      pass: pass,
      reason: reason,
      durationMs: Date.now() - t0,
    }).catch(function () {});
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  async function waitFor(fn, label, timeout) {
    var end = Date.now() + (timeout || 8000);
    while (Date.now() < end) {
      var value = fn();
      if (value) return value;
      await sleep(40);
    }
    throw new Error('waitFor timeout: ' + label);
  }
  async function create(name) {
    var res = await window.api.invoke('cmd:session:create', { cols: 80, rows: 24 });
    if (!res || !res.session || !res.session.id) throw new Error('create failed');
    await window.api.invoke('cmd:session:rename', {
      sessionId: res.session.id,
      newDisplayName: name,
    });
    return res.session.id;
  }
  async function send(sid, text) {
    var res = await window.api.invoke('cmd:session:send-input', {
      sessionId: sid,
      data: btoa(text),
    });
    if (!res || res.accepted !== true) throw new Error('send rejected: ' + JSON.stringify(res));
  }
  try {
    var a = await create('DECK_A');
    var aSlot = await waitFor(function () {
      return document.querySelector('.terminal-deck-slot[data-session-id="' + a + '"][data-terminal-active="true"]');
    }, 'A active slot');
    var aViewport = await waitFor(function () {
      return aSlot.querySelector('.xterm-viewport');
    }, 'A viewport');

    var capturedA = '';
    var offA = window.api.on('evt:session:output', function (payload) {
      if (payload && payload.sessionId === a) {
        try { capturedA += atob(payload.data); } catch (_) {}
      }
    });
    await sleep(1500);
    await send(a, '1..140 | ForEach-Object { Write-Output ("DECK_INIT_" + $_) }\\r');
    await waitFor(function () {
      return capturedA.indexOf('DECK_INIT_140') >= 0;
    }, 'A PTY output token');
    // xterm 6 使用自绘 scrollbar,原生 viewport.scrollTop 恒定。smoke 通过
    // TerminalView 的临时 CustomEvent 调公开 scrollLines,再读纯数值 data attr。
    window.dispatchEvent(
      new CustomEvent('marina:smoke-terminal-scroll', {
        detail: { sessionId: a, lines: -40 },
      }),
    );
    await waitFor(function () {
      var host = aSlot.querySelector('.terminal-host');
      return (
        host &&
        Number(host.dataset.baseY) > 0 &&
        Number(host.dataset.viewportY) < Number(host.dataset.baseY)
      );
    }, 'A scrolled above bottom');
    var aHost = aSlot.querySelector('.terminal-host');
    var topBefore = Number(aHost.dataset.viewportY);
    var baseBefore = Number(aHost.dataset.baseY);

    // 先排入大量 A 输出,立刻创建 B 令 A owner=null。后续 A 输出必须走 parked view。
    await send(
      a,
      '1..40 | ForEach-Object { Write-Output ("DECK_BG_" + $_); Start-Sleep -Milliseconds 25 }\\r',
    );
    var b = await create('DECK_B');
    await waitFor(function () {
      return document.querySelector('.terminal-deck-slot[data-session-id="' + b + '"][data-terminal-active="true"]');
    }, 'B active slot');
    await waitFor(function () {
      return capturedA.indexOf('DECK_BG_40') >= 0;
    }, 'A parked output token');
    await waitFor(function () {
      return Number(aHost.dataset.baseY) > baseBefore;
    }, 'A parked xterm parsed output');

    if (!aViewport.isConnected) throw new Error('A viewport DOM was destroyed after switching to B');
    var parkedTop = Number(aHost.dataset.viewportY);
    if (parkedTop !== topBefore) {
      throw new Error('A viewport moved while parked: before=' + topBefore + ' after=' + parkedTop);
    }

    var aItem = Array.from(document.querySelectorAll('.session-item')).find(function (item) {
      var name = item.querySelector('.session-name');
      return name && name.textContent === 'DECK_A';
    });
    if (!aItem) throw new Error('A sidebar item not found');
    aItem.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    var activeA = await waitFor(function () {
      return document.querySelector('.terminal-deck-slot[data-session-id="' + a + '"][data-terminal-active="true"]');
    }, 'A reactivated');
    await sleep(250);
    var viewportAfter = activeA.querySelector('.xterm-viewport');
    if (viewportAfter !== aViewport) throw new Error('A viewport node identity changed on A→B→A');
    var topAfter = Number(activeA.querySelector('.terminal-host').dataset.viewportY);
    if (topAfter !== topBefore) {
      throw new Error('A viewport not preserved on return: before=' + topBefore + ' after=' + topAfter);
    }
    try { offA && offA(); } catch (_) {}
    report(true, 'TerminalDeck preserved xterm node + viewportY and consumed parked output');
  } catch (err) {
    report(false, 'terminal-deck exception: ' + (err && err.stack ? err.stack : String(err)));
  }
})();
`;
}

/**
 * 真实 Electron 文件预览滚动冒烟：覆盖用户实际的三条切换路径——
 * panel tab、同 session 文件 tab、终端 session。每次返回 Markdown 都断言
 * .file-panel-body 的真实 scrollTop，而不是只断言 store 里的数字。
 *
 * 启用:MARINA_SMOKE_INTERACTIVE=1 + MARINA_SMOKE_FILE_VIEWER_SCROLL=1。
 */
function buildFileViewerScrollTestScript(): string {
  const projectRoot = JSON.stringify(resolve(process.cwd()));
  const markdownPath = JSON.stringify(resolve(process.cwd(), 'AGENTS.md'));
  const secondMarkdownPath = JSON.stringify(resolve(process.cwd(), 'README.md'));
  const textPath = JSON.stringify(resolve(process.cwd(), 'src/renderer/styles/global.css'));
  // fixture 只写 smoke 独占 userData；外层 runner 退出后递归删除，不碰项目/用户数据。
  const diffFixturePath = resolve(app.getPath('userData'), 'file-scroll-fixture.diff');
  const diffRows = Array.from(
    { length: 260 },
    (_, index) => ` context_${index + 1}_${'long_column_'.repeat(24)}`,
  );
  writeFileSync(
    diffFixturePath,
    [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,260 +1,260 @@',
      ...diffRows,
    ].join('\n'),
    'utf8',
  );
  const diffPath = JSON.stringify(diffFixturePath);
  return `
(async () => {
  var t0 = Date.now();
  var done = false;
  var projectRoot = ${projectRoot};
  var markdownPath = ${markdownPath};
  var secondMarkdownPath = ${secondMarkdownPath};
  var textPath = ${textPath};
  var diffPath = ${diffPath};
  function report(pass, reason) {
    if (done) return;
    done = true;
    window.api.invoke('smoke:report', {
      pass: pass,
      reason: reason,
      durationMs: Date.now() - t0,
    }).catch(function () {});
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  async function waitFor(fn, label, timeout) {
    var end = Date.now() + (timeout || 8000);
    while (Date.now() < end) {
      var value = fn();
      if (value) return value;
      await sleep(40);
    }
    throw new Error('waitFor timeout: ' + label);
  }
  async function create(name, pathId) {
    var res = await window.api.invoke('cmd:session:create', {
      pathId: pathId,
      cols: 80,
      rows: 24,
    });
    if (!res || !res.session || !res.session.id) throw new Error('create failed');
    await window.api.invoke('cmd:session:rename', {
      sessionId: res.session.id,
      newDisplayName: name,
    });
    return res.session.id;
  }
  async function show(sid, path, command) {
    var result = await window.api.invoke(command, { sessionId: sid, path: path });
    if (!result) throw new Error(command + ' returned empty response for ' + path);
    return result;
  }
  async function markdownBody(path, label) {
    return waitFor(function () {
      var body = document.querySelector('.file-panel-body[data-viewer-kind="markdown"]');
      if (!body || body.dataset.viewerPath !== path) return null;
      if (!body.querySelector('.markdown-body, .file-markdown-viewer')) return null;
      if (body.scrollHeight <= body.clientHeight + 400) return null;
      return body;
    }, label);
  }
  async function setAndSave(element, top, left) {
    // 先发真实用户意图信号；hook 会据此取消尚未结束的双 RAF restore fence。
    element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: top }));
    element.scrollTop = top;
    element.scrollLeft = left || 0;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
    await waitFor(function () {
      return Math.abs(element.scrollTop - top) <= 2 && Math.abs(element.scrollLeft - (left || 0)) <= 2;
    }, 'scroll=' + top + ',' + (left || 0));
    await sleep(220); // > useFileViewerScroll 120ms trailing debounce
  }
  async function expectRestored(path, top, label) {
    return waitFor(function () {
      var body = document.querySelector('.file-panel-body[data-viewer-kind="markdown"]');
      return body && body.dataset.viewerPath === path && Math.abs(body.scrollTop - top) <= 2
        ? body
        : null;
    }, label);
  }
  try {
    var bookmark = await window.api.invoke('cmd:bookmark:add', {
      path: projectRoot,
      displayName: 'SMOKE_PROJECT',
    });
    if (!bookmark || !bookmark.bookmark || !bookmark.bookmark.id) {
      throw new Error('bookmark:add failed: ' + JSON.stringify(bookmark));
    }
    // Session pathId 的协议值就是规范化绝对路径；Bookmark.id 是持久化记录 UUID，
    // 不能当 cwd 使用。
    var pathId = projectRoot;
    var a = await create('SCROLL_A', pathId);
    await show(a, markdownPath, 'cmd:file-panel:open');
    var body = await markdownBody(markdownPath, 'initial markdown');
    await setAndSave(body, 720);

    // 1) 切到「文件」面板再回「已打开」。FilePanel 会卸载/重挂。
    var filesTab = Array.from(document.querySelectorAll('.panel-dock-tab')).find(function (tab) {
      return tab.title === '文件' || tab.title === 'Files';
    });
    if (!filesTab) throw new Error('Files panel tab not found');
    filesTab.click();
    await waitFor(function () { return document.querySelector('.file-tree-panel'); }, 'file-tree active');
    var openedTab = Array.from(document.querySelectorAll('.panel-dock-tab')).find(function (tab) {
      return tab.title === '已打开' || tab.title === 'Opened';
    });
    if (!openedTab) throw new Error('Opened panel tab not found');
    // 先把 Markdown 内容强制压短：第一次 restore 只能 clamp 到 0。200ms 后放开
    // 触发 ResizeObserver，必须仍以原 saved=720 为目标，不能被程序化 scroll 事件覆盖。
    var delayedLayoutStyle = document.createElement('style');
    delayedLayoutStyle.textContent =
      '.file-markdown-viewer,.markdown-body{height:200px!important;max-height:200px!important;overflow:hidden!important}';
    document.head.appendChild(delayedLayoutStyle);
    openedTab.click();
    await waitFor(function () {
      var delayedBody = document.querySelector('.file-panel-body[data-viewer-kind="markdown"]');
      return delayedBody && delayedBody.dataset.viewerPath === markdownPath &&
        delayedBody.querySelector('.markdown-body, .file-markdown-viewer') &&
        delayedBody.scrollHeight <= delayedBody.clientHeight + 5;
    }, 'markdown constrained before delayed layout');
    await sleep(200);
    delayedLayoutStyle.remove();
    body = await expectRestored(markdownPath, 720, 'restore after delayed panel layout');

    // restore 的双 RAF 尚未执行完就再次卸载，不能把已有 target 覆盖成 0。
    filesTab.click();
    await waitFor(function () { return document.querySelector('.file-tree-panel'); }, 'rapid switch setup');
    openedTab.click();
    await Promise.resolve();
    filesTab.click();
    await waitFor(function () { return document.querySelector('.file-tree-panel'); }, 'rapid unmount');
    openedTab.click();
    body = await expectRestored(markdownPath, 720, 'restore after rapid unmount');

    // 2) 同 kind 文件各自独立：README 首次打开从 0 开始，之后 A/B 各自恢复。
    await show(a, secondMarkdownPath, 'cmd:file-panel:open');
    body = await markdownBody(secondMarkdownPath, 'second markdown');
    await waitFor(function () { return body.scrollTop === 0; }, 'second markdown starts at zero');
    await setAndSave(body, 360);
    await show(a, markdownPath, 'cmd:file-panel:show');
    body = await expectRestored(markdownPath, 720, 'restore first markdown');
    await show(a, secondMarkdownPath, 'cmd:file-panel:show');
    body = await expectRestored(secondMarkdownPath, 360, 'restore second markdown');
    await show(a, markdownPath, 'cmd:file-panel:show');
    body = await expectRestored(markdownPath, 720, 'restore first markdown again');

    // 搜索 active + 无匹配时不会产生后续 scrollIntoView。A→B→A 的 loading clamp
    // 事件仍必须被 identity fence 吞掉；关搜索后两个文件应恢复各自原坐标。
    var dockBody = document.querySelector('.panel-dock-body');
    if (!dockBody) throw new Error('panel dock body not found');
    dockBody.focus();
    window.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, ctrlKey: true, key: 'f' }),
    );
    var searchInput = await waitFor(function () {
      return document.querySelector('.search-bar-input');
    }, 'search input');
    var valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    valueSetter.call(searchInput, '__NO_MATCH_SCROLL_SMOKE__');
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(100);
    await show(a, secondMarkdownPath, 'cmd:file-panel:show');
    await markdownBody(secondMarkdownPath, 'second markdown while search active');
    await show(a, markdownPath, 'cmd:file-panel:show');
    await markdownBody(markdownPath, 'first markdown while search active');
    searchInput = document.querySelector('.search-bar-input');
    if (!searchInput) throw new Error('search input disappeared before close');
    searchInput.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    await waitFor(function () { return !document.querySelector('.search-bar-input'); }, 'search closed');
    body = await expectRestored(markdownPath, 720, 'restore after search-active file switch');
    await show(a, secondMarkdownPath, 'cmd:file-panel:show');
    body = await expectRestored(secondMarkdownPath, 360, 'second markdown survives search switch');
    await show(a, markdownPath, 'cmd:file-panel:show');
    body = await expectRestored(markdownPath, 720, 'first markdown survives search switch');

    // 3) Text 内层 scroller 保存 Y；Diff 内层 scroller 同时保存 X/Y，并恢复 gutter 同步。
    await show(a, textPath, 'cmd:file-panel:open');
    var textScroller = await waitFor(function () {
      var panelBody = document.querySelector('.file-panel-body[data-viewer-kind="text"]');
      if (!panelBody || panelBody.dataset.viewerPath !== textPath) return null;
      var scroller = panelBody.querySelector('.file-text-viewer');
      return scroller && scroller.scrollHeight > scroller.clientHeight + 400 ? scroller : null;
    }, 'text active');
    await setAndSave(textScroller, 640, 0);

    await show(a, diffPath, 'cmd:file-panel:open');
    var diffScroller = await waitFor(function () {
      var panelBody = document.querySelector('.file-panel-body[data-viewer-kind="diff"]');
      if (!panelBody || panelBody.dataset.viewerPath !== diffPath) return null;
      var scroller = panelBody.querySelector('.diff-code-pane');
      return scroller && scroller.scrollHeight > scroller.clientHeight + 400 &&
        scroller.scrollWidth > scroller.clientWidth + 200 ? scroller : null;
    }, 'diff active');
    await setAndSave(diffScroller, 480, 180);

    await show(a, markdownPath, 'cmd:file-panel:show');
    body = await expectRestored(markdownPath, 720, 'restore after file switch');
    await show(a, textPath, 'cmd:file-panel:show');
    await waitFor(function () {
      var panelBody = document.querySelector('.file-panel-body[data-viewer-kind="text"]');
      if (!panelBody || panelBody.dataset.viewerPath !== textPath) return null;
      var scroller = panelBody.querySelector('.file-text-viewer');
      return scroller && Math.abs(scroller.scrollTop - 640) <= 2 ? scroller : null;
    }, 'restore text position');
    await show(a, diffPath, 'cmd:file-panel:show');
    await waitFor(function () {
      var panelBody = document.querySelector('.file-panel-body[data-viewer-kind="diff"]');
      if (!panelBody || panelBody.dataset.viewerPath !== diffPath) return null;
      var scroller = panelBody.querySelector('.diff-code-pane');
      var gutter = panelBody.querySelector('.diff-gutter-pane');
      return scroller && gutter && Math.abs(scroller.scrollTop - 480) <= 2 &&
        Math.abs(scroller.scrollLeft - 180) <= 2 && Math.abs(gutter.scrollTop - 480) <= 2
        ? scroller : null;
    }, 'restore diff X/Y + gutter');
    await show(a, markdownPath, 'cmd:file-panel:show');
    body = await expectRestored(markdownPath, 720, 'restore markdown after text/diff');
    await setAndSave(body, 1080);

    // 4) A → B → A session 切换；返回后恢复 A 当前文件及其位置。
    await create('SCROLL_B', pathId);
    await waitFor(function () {
      return Array.from(document.querySelectorAll('.session-name')).some(function (name) {
        return name.textContent === 'SCROLL_B';
      });
    }, 'B selected');
    var aItem = Array.from(document.querySelectorAll('.session-item')).find(function (item) {
      var name = item.querySelector('.session-name');
      return name && name.textContent === 'SCROLL_A';
    });
    if (!aItem) throw new Error('A sidebar item not found');
    aItem.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    await expectRestored(markdownPath, 1080, 'restore after session switch');

    report(true, 'file viewer scrollTop isolated per file and restored after panel/file/session switches');
  } catch (err) {
    report(false, 'file-viewer-scroll exception: ' + (err && err.stack ? err.stack : String(err)));
  }
})();
`;
}

/**
 * 真实 Electron WebViewer 冒烟(ADR-034):fixture html 经 cmd:file-panel:open
 * 进面板,端到端验证 —— ① iframe 挂载(data-viewer-kind=web)② 产物内联脚本
 * 真实执行(postMessage 回执:证明 scheme 服务 + frame-src 放行 + app CSP 跳过
 * 注入 + 逐响应 CSP 四件事同时成立)③ 源码⇄预览切换往返。
 *
 * fixture 写在 smoke 独占 userData,打开后它本身就是白名单成员(ADR-034 白名单
 * 三条件之一),不碰项目/用户数据。
 *
 * 启用:MARINA_SMOKE_INTERACTIVE=1 + MARINA_SMOKE_FILE_VIEWER_HTML=1。
 */
function buildFileViewerHtmlTestScript(): string {
  const projectRoot = JSON.stringify(resolve(process.cwd()));
  // fixture:内联脚本 postMessage 回执 + 内联 svg,模拟 archify 类产物形态。
  const fixturePath = resolve(app.getPath('userData'), 'web-viewer-fixture.html');
  writeFileSync(
    fixturePath,
    [
      '<!doctype html>',
      '<html><head><meta charset="utf-8"></head>',
      '<body><h1>marina web viewer smoke</h1>',
      '<svg width="10" height="10"><rect width="10" height="10"/></svg>',
      '<script>',
      "parent.postMessage({ marinaSmokeWeb: 'inline-script-ok' }, '*');",
      '</script></body></html>',
    ].join('\n'),
    'utf8',
  );
  const htmlPath = JSON.stringify(fixturePath);
  return `
(async () => {
  var t0 = Date.now();
  var done = false;
  var projectRoot = ${projectRoot};
  var htmlPath = ${htmlPath};
  function report(pass, reason) {
    if (done) return;
    done = true;
    window.api.invoke('smoke:report', {
      pass: pass,
      reason: reason,
      durationMs: Date.now() - t0,
    }).catch(function () {});
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  async function waitFor(fn, label, timeout) {
    var end = Date.now() + (timeout || 8000);
    while (Date.now() < end) {
      var value = fn();
      if (value) return value;
      await sleep(40);
    }
    throw new Error('waitFor timeout: ' + label);
  }
  // 先同步挂 message 监听再开文件 —— sandbox iframe 的 postMessage 回执不能丢
  var inlineScriptOk = false;
  window.addEventListener('message', function (event) {
    if (event.data && event.data.marinaSmokeWeb === 'inline-script-ok') inlineScriptOk = true;
  });
  function webBody() {
    return document.querySelector('.file-panel-body[data-viewer-kind="web"]');
  }
  function webFrame() {
    var body = webBody();
    return body ? body.querySelector('.file-web-viewer-frame') : null;
  }
  try {
    await window.api.invoke('cmd:bookmark:add', {
      path: projectRoot,
      displayName: 'SMOKE_PROJECT',
    });
    var res = await window.api.invoke('cmd:session:create', {
      pathId: projectRoot,
      cols: 80,
      rows: 24,
    });
    if (!res || !res.session || !res.session.id) throw new Error('create failed');
    var sid = res.session.id;

    var opened = await window.api.invoke('cmd:file-panel:open', {
      sessionId: sid,
      path: htmlPath,
    });
    if (!opened) throw new Error('file-panel:open returned empty');

    var frame = await waitFor(webFrame, 'web iframe mounted');
    if (frame.getAttribute('sandbox') !== 'allow-scripts allow-downloads') {
      throw new Error('unexpected sandbox attr: ' + frame.getAttribute('sandbox'));
    }

    // 端到端核心断言:产物内联脚本真实执行(四层条件同时成立才会发生)
    await waitFor(function () { return inlineScriptOk; }, 'inline script postMessage receipt');

    // 工具条：切换钮恒定位 [0](预览 3 钮：切换/重载/浏览器；源码 2 钮：切换/浏览器)
    var tools = webBody().querySelectorAll('.file-web-viewer-tool');
    if (tools.length < 3) throw new Error('preview toolbar buttons < 3');
    tools[0].click();
    await waitFor(function () {
      var body = webBody();
      return body && body.querySelector('.file-text-viewer') && !body.querySelector('.file-web-viewer-frame');
    }, 'source mode shows TextViewer without iframe');
    var sourceTools = webBody().querySelectorAll('.file-web-viewer-tool');
    if (sourceTools.length !== 2) throw new Error('source toolbar buttons != 2');
    sourceTools[0].click();
    await waitFor(webFrame, 'back to preview iframe');
    await waitFor(function () { return inlineScriptOk; }, 'still ok', 1000);

    report(true, 'web viewer: iframe mounted + inline script executed + source toggle roundtrip');
  } catch (err) {
    report(false, 'file-viewer-html exception: ' + (err && err.stack ? err.stack : String(err)));
  }
})();
`;
}

/**
 * 全局兜底超时 — 哪怕注入脚本 / report 全挂,这里也保证进程 N 秒后退。
 * 由 main/index.ts 在装载 harness 时调一次。
 */
export function installSmokeGlobalTimeout(): void {
  setTimeout(() => {
    process.stdout.write(
      `[smoke-interactive] FAIL ${TEST_TIMEOUT_MS}ms — 全局超时 (harness 未在窗口期内 report)\n`,
    );
    app.exit(1);
  }, TEST_TIMEOUT_MS);
}
