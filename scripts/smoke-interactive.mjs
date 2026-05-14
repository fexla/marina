#!/usr/bin/env node
/**
 * @file scripts/smoke-interactive.mjs
 * @purpose 交互级冒烟 — spawn marina-app 完整跑一次 PTY 来回验证。
 *
 * @关系
 * scripts/smoke-launch.mjs  → 只验证 main 起得来、preload 不爆 (5s 内)
 * scripts/smoke-interactive.mjs (本文件)  → 起来之后真实 IPC 创建 session +
 *                                            喂 input + 收 PTY 输出 + 比对 (20s 内)
 *
 * smoke-launch 是 smoke-interactive 的子集 — 这里若 PASS,smoke-launch
 * 必定也 PASS。但 smoke-launch 跑得快(5s)、依赖少(不起 PTY),适合
 * 极早期回归拦截;smoke-interactive 跑得慢但能抓行为类回归
 * (本次 OSC-3/4 渲染丢内容 / PER-2 race emit 漏失等)。
 *
 * @工作流
 * 1. 在 OS temp 下建一个独占 user-data-dir,避免污染开发者的 marina 配置
 * 2. spawn electron out/main/index.js
 *      --user-data-dir=<tmp>
 *      env MARINA_SMOKE_INTERACTIVE=1  →  触发 main/smoke-interactive harness
 * 3. main 启动后注入 renderer 测试脚本(详见 src/main/smoke-interactive.ts),
 *    脚本 IPC 创建 session + 喂 'echo TOKEN\\r' + 等 8s 验证 PTY 输出含 TOKEN
 * 4. main 通过 stdout 输出 "[smoke-interactive] PASS/FAIL ..." 行
 * 5. 子进程退出码 0/1
 * 6. 本脚本回收 tmp 目录、根据子进程退出码退出
 *
 * @用法
 *   npm run build:unpack    # 先 build
 *   npm run smoke:interactive
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const mainEntry = resolve(projectRoot, 'out/main/index.js');

if (!existsSync(mainEntry)) {
  console.error(
    `[smoke-interactive] out/main/index.js 不存在 — 先跑 \`npm run build:unpack\` 或 \`npm run build\``,
  );
  process.exit(1);
}

const require = createRequire(import.meta.url);
const electronPath = require('electron');
if (typeof electronPath !== 'string') {
  console.error('[smoke-interactive] electron 模块未返回可执行路径,环境异常');
  process.exit(1);
}

// 独立 user-data-dir,避免污染开发者本机 marina 配置;每次跑用新目录,
// 跑完清理。
const userDataDir = mkdtempSync(join(tmpdir(), 'marina-smoke-'));
console.log(`[smoke-interactive] user-data-dir=${userDataDir}`);
console.log(`[smoke-interactive] entry=${mainEntry}`);
console.log(`[smoke-interactive] electron=${electronPath}`);

// 总超时,比 main harness 内部超时(12s)宽 8s,留给子进程清理空间
const OUTER_TIMEOUT_MS = 20_000;

let resolved = false;
let timeoutHandle = null;
let reportSeen = null; // 'PASS' | 'FAIL' | null

function cleanup() {
  // Windows 上 Electron 进程退干净需要点时间(单实例 lockfile / chromium
  // 缓存句柄都没释放)。重试几次,每次间隔 200ms,失败就静默忽略 —
  // tmp 目录 OS 自己会回收,smoke 结果不受影响。
  let attempts = 0;
  const tryRm = () => {
    try {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 });
    } catch (e) {
      attempts += 1;
      if (attempts < 5) {
        setTimeout(tryRm, 200);
      }
      // 5 次都失败就放弃,不打 warning(干扰主流程结果信号)
    }
  };
  tryRm();
}

function finish(code, reason) {
  if (resolved) return;
  resolved = true;
  if (timeoutHandle) clearTimeout(timeoutHandle);
  try {
    if (!child.killed) {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
      }
    }
  } catch {
    /* ignore */
  }
  cleanup();
  console.log(`[smoke-interactive] ${code === 0 ? 'PASS' : 'FAIL'} — ${reason}`);
  process.exit(code);
}

function inspectChunk(chunk, stream) {
  const text = chunk.toString('utf8');
  // 镜像到本进程 stdout 便于排查
  process.stdout.write(`[${stream}] ${text}`);
  // 抓 main/smoke-interactive.ts finish() 写的标记行
  // 形如:[smoke-interactive] PASS 1342ms — ...
  const passMatch = text.match(/\[smoke-interactive\]\s+PASS\b[^\n]*/);
  const failMatch = text.match(/\[smoke-interactive\]\s+FAIL\b[^\n]*/);
  if (passMatch && !reportSeen) {
    reportSeen = 'PASS';
    finish(0, passMatch[0]);
  } else if (failMatch && !reportSeen) {
    reportSeen = 'FAIL';
    finish(1, failMatch[0]);
  }
  // preload-error 类致命错误也直接 fail(harness 还没装就出问题了)
  if (/preload-error/i.test(text) && !reportSeen) {
    reportSeen = 'FAIL';
    finish(1, 'preload-error — main 启动前就异常,harness 没机会跑');
  }
}

const child = spawn(
  electronPath,
  [
    mainEntry,
    `--user-data-dir=${userDataDir}`,
    '--disable-gpu',
    '--no-sandbox',
  ],
  {
    cwd: projectRoot,
    env: {
      ...process.env,
      MARINA_SMOKE_INTERACTIVE: '1',
      FORCE_COLOR: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  },
);

child.stdout.on('data', (c) => inspectChunk(c, 'stdout'));
child.stderr.on('data', (c) => inspectChunk(c, 'stderr'));
child.on('error', (err) => finish(1, `spawn 失败: ${err.message}`));
child.on('exit', (code, signal) => {
  if (resolved) return;
  // 子进程退出但 stdout 没看到 PASS/FAIL 行 → 异常退出
  finish(1, `子进程退出 code=${code} signal=${signal} 但未见 PASS/FAIL 报告`);
});

timeoutHandle = setTimeout(() => {
  finish(1, `外层 ${OUTER_TIMEOUT_MS}ms 总超时`);
}, OUTER_TIMEOUT_MS);
