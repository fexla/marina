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

const MAX_WAIT_FIRST_WINDOW_MS = 8000;
const TEST_TIMEOUT_MS =
  process.env['MARINA_SMOKE_TERMINAL_DECK'] === '1' ? 22_000 : 12_000;

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
export function installSmokeInteractiveHarness(
  getFirstWindow: () => BrowserWindow | null,
): void {
  const t0 = Date.now();
  let finished = false;
  const finish = (pass: boolean, reason: string): void => {
    if (finished) return;
    finished = true;
    const ms = Date.now() - t0;
    // stdout 单行 token,外部 scripts/smoke-interactive.mjs 据此判断结果
    process.stdout.write(
      `[smoke-interactive] ${pass ? 'PASS' : 'FAIL'} ${ms}ms — ${reason}\n`,
    );
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
      process.stdout.write(
        `[renderer console L${level} ${sourceId}:${line}] ${message}\n`,
      );
    });
    wc.on('render-process-gone', (_e, details) => {
      finish(false, `render-process-gone: ${JSON.stringify(details)}`);
    });
    const inject = (): void => {
      const script =
        process.env['MARINA_SMOKE_TERMINAL_DECK'] === '1'
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
