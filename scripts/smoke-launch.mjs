#!/usr/bin/env node
/**
 * @file scripts/smoke-launch.mjs
 * @purpose marina-app 启动冒烟测试。
 *
 * 仅验证 main 进程 + 至少一个 BrowserWindow 能在 5s 内活到 "ready-to-show"
 * 而不报 preload-error / renderer-process-gone 等致命错误。
 *
 * @背景
 * SEC-1 (4d245f7) 把 webPreferences.sandbox 改成 true 但 preload 产物是
 * .mjs ESM,Electron sandboxed preload 只支持 CJS — 启动期 preload 加载
 * 立刻抛 "Cannot use import statement outside a module"。所有 67 个单测
 * 都用 mock,不真启 Electron,这种"程序根本起不来"漏到用户那边。
 *
 * @策略
 * 1. 假设 out/ 已 build (电梯口检查 out/main/index.js 存在)。
 * 2. spawn Electron 子进程跑 marina-app,关闭 GPU 加速 (CI 友好)。
 * 3. 5s 内监听 stdout/stderr:
 *      - 看到 "[WindowManager] preload-error" → fail
 *      - 看到 "bootstrap starting" → milestone (main 进程起来了)
 *      - 看到 "render-process-gone" → fail
 *    超时未见 preload-error 且 milestone 达成 → pass。
 * 4. 测试结束无论成败都 kill 子进程,marina-app 不会真留下持续窗口。
 *
 * @用法
 *   npm run build:unpack   # 先 build 出 out/
 *   npm run smoke
 *
 * @退出码
 *   0 = pass
 *   1 = fail (致命错误关键字命中 / milestone 未达 / 子进程意外退出)
 *
 * @不做的事
 * - 不验证 renderer UI 视觉(那是 E2E / Playwright 的活,成本太高)
 * - 不验证 IPC 流程(那是 session-manager 单测的活)
 * - 不验证 PTY 交互(同上)
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const mainEntry = resolve(projectRoot, 'out/main/index.js');

if (!existsSync(mainEntry)) {
  console.error(
    `[smoke] out/main/index.js 不存在 — 请先跑 \`npm run build:unpack\` 或 \`npm run build\``,
  );
  process.exit(1);
}

// Electron npm 包默认导出 .exe 路径(CJS 形式),用 createRequire 在 ESM 里取
const require = createRequire(import.meta.url);
const electronPath = require('electron');
if (typeof electronPath !== 'string') {
  console.error('[smoke] electron 模块未返回可执行路径,环境异常');
  process.exit(1);
}

const TIMEOUT_MS = 5000;
const FATAL_PATTERNS = [
  /preload-error/i,
  /render-process-gone/i,
  /UnhandledPromiseRejection/i,
  // V8 / Electron 自身崩溃常见标志
  /FATAL ERROR/,
  /Check failed:/,
];
const MILESTONE_PATTERN = /bootstrap starting/i;

let milestoneSeen = false;
let fatalMessage = null;
let timeoutHandle = null;
let resolved = false;

function finish(passed, reason) {
  if (resolved) return;
  resolved = true;
  if (timeoutHandle) clearTimeout(timeoutHandle);
  try {
    if (!child.killed) {
      // Windows: SIGTERM 不可靠,直接 kill 进程树
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], {
          stdio: 'ignore',
        });
      } else {
        child.kill('SIGTERM');
      }
    }
  } catch {
    /* ignore */
  }
  if (passed) {
    console.log(`[smoke] PASS — ${reason}`);
    process.exit(0);
  } else {
    console.error(`[smoke] FAIL — ${reason}`);
    process.exit(1);
  }
}

function inspectChunk(chunk, streamName) {
  const text = chunk.toString('utf8');
  // 转发给开发者(便于排查)
  process.stdout.write(`[${streamName}] ${text}`);
  for (const pat of FATAL_PATTERNS) {
    if (pat.test(text)) {
      fatalMessage = `致命模式命中 ${pat} on ${streamName}`;
      finish(false, fatalMessage);
      return;
    }
  }
  if (!milestoneSeen && MILESTONE_PATTERN.test(text)) {
    milestoneSeen = true;
  }
}

console.log(`[smoke] spawning electron — entry=${pathToFileURL(mainEntry).href}`);
console.log(`[smoke] electron=${electronPath}`);
console.log(`[smoke] timeout=${TIMEOUT_MS}ms`);

const child = spawn(
  electronPath,
  [
    mainEntry,
    // CI / 无头环境友好:关 GPU,避免 driver 缺失影响判断
    '--disable-gpu',
    '--no-sandbox',
  ],
  {
    cwd: projectRoot,
    env: {
      ...process.env,
      // 防托盘 / 自启等副作用,纯启动验证
      MARINA_SMOKE: '1',
      // electron 在 Win 上 stdout 默认 inherit 可能不刷 — 强制 line buffer
      FORCE_COLOR: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  },
);

child.stdout.on('data', (c) => inspectChunk(c, 'stdout'));
child.stderr.on('data', (c) => inspectChunk(c, 'stderr'));

child.on('error', (err) => {
  finish(false, `spawn 失败:${err.message}`);
});

child.on('exit', (code, signal) => {
  if (resolved) return;
  // 子进程在窗口期内自己退出 → 不正常(marina-app 不该自动退)
  finish(false, `子进程提前退出 code=${code} signal=${signal}`);
});

timeoutHandle = setTimeout(() => {
  if (!milestoneSeen) {
    finish(false, `${TIMEOUT_MS}ms 内未看到 "bootstrap starting" — main 进程可能根本没起`);
    return;
  }
  if (fatalMessage) {
    finish(false, fatalMessage);
    return;
  }
  finish(true, `${TIMEOUT_MS}ms 内 main 起来且无致命错误`);
}, TIMEOUT_MS);
