#!/usr/bin/env node
/**
 * @file scripts/analyze-performance-report.mjs
 * @purpose 分析 Marina 性能飞行记录器产出的一份报告 JSON，输出结构化诊断。
 *
 * 用法：
 *   node scripts/analyze-performance-report.mjs [report.json | 目录 | --latest]
 *
 *   - 传一份 .json 路径 → 分析它
 *   - 传一个目录 → 自动找该目录下最新的 run-*.json
 *   - 传 --latest 或省略 → 找默认 portable/正式版 userData 下的 performance-reports
 *     (%APPDATA%\Marina (portable)\performance-reports、%APPDATA%\Marina\performance-reports)
 *
 * @关键设计:
 * - 纯 Node 内置模块 (fs/path/os)，零新依赖
 * - 只读、不改报告；输出全部打印到 stdout，可重定向到文件
 * - 诊断维度：吞吐健康 / 背压事件 / stall↔流量相关性 / 瓶颈定位 / 内存健康 / 隐私自检
 *
 * @对应文档章节: docs/方案-性能诊断-20260722.md §6
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── 工具 ────────────────────────────────────────────────────────────
const BURST_THRESHOLD = 1024 * 1024; // 1 MiB/s，与 performance-diagnostics.ts PTY_BURST_BYTES_PER_SECOND 对齐
const SLOW_DISPATCH_MS = 5; // sessionOutput dispatch 单次超过此值记为“慢发送”（背压信号）

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}
function fmtRate(bps) {
  if (!Number.isFinite(bps) || bps <= 0) return '0 B/s';
  if (bps < 1024) return `${Math.round(bps)} B/s`;
  if (bps < 1024 ** 2) return `${(bps / 1024).toFixed(1)} KiB/s`;
  if (bps < 1024 ** 3) return `${(bps / 1024 ** 2).toFixed(1)} MiB/s`;
  return `${(bps / 1024 ** 3).toFixed(2)} GiB/s`;
}
function fmtMs(ms) {
  if (!Number.isFinite(ms)) return '-';
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  return `${ms.toFixed(1)} ms`;
}
function fmtDur(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
}
function pct(n) {
  return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '-';
}
function pad(s, w) {
  s = String(s);
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

// ── 定位报告 ────────────────────────────────────────────────────────
function isReport(name) {
  return /^run-\d{8}T\d{6}Z-[0-9a-f]{8}\.json$/.test(name);
}

function findLatestInDir(dir) {
  if (!existsSync(dir)) return null;
  let best = null;
  let bestMtime = -1;
  for (const name of readdirSync(dir)) {
    if (!isReport(name)) continue;
    const full = join(dir, name);
    const m = statSync(full).mtimeMs;
    if (m > bestMtime) {
      bestMtime = m;
      best = full;
    }
  }
  return best;
}

function resolveReport(arg) {
  if (!arg || arg === '--latest') {
    const candidates = [
      join(homedir(), 'AppData', 'Roaming', 'Marina (portable)', 'performance-reports'),
      join(homedir(), 'AppData', 'Roaming', 'Marina', 'performance-reports'),
      join(process.env.APPDATA || '', 'Marina (portable)', 'performance-reports'),
      join(process.env.APPDATA || '', 'Marina', 'performance-reports'),
      join(process.cwd(), 'performance-reports'),
    ];
    for (const dir of candidates) {
      const f = findLatestInDir(dir);
      if (f) return f;
    }
    throw new Error(
      `未在任何默认目录找到报告。请传入 .json 路径，例如：\n` +
        `  node scripts/analyze-performance-report.mjs "%APPDATA%\\Marina (portable)\\performance-reports\\run-xxx.json"`,
    );
  }
  const st = statSync(arg);
  if (st.isDirectory()) {
    const f = findLatestInDir(arg);
    if (!f) throw new Error(`目录 ${arg} 下没有 run-*.json 报告。`);
    return f;
  }
  return arg;
}

// ── 诊断 ────────────────────────────────────────────────────────────
function analyze(r) {
  const out = [];
  const warn = [];
  const ok = [];

  out.push(`═══ Marina 性能报告诊断 ═══`);
  out.push(`runId     ${r.runId}`);
  out.push(
    `版本      ${r.appVersion}  (${r.platform} ${r.arch} / Node ${r.nodeVersion} / Electron ${r.electronVersion})`,
  );
  out.push(`开始      ${r.startedAt}`);
  out.push(`生成      ${r.generatedAt}${r.endedAt ? `  结束 ${r.endedAt}` : ''}`);
  out.push(`状态      ${r.finalized ? '✅ 正常结束' : '⚠️  运行中 / 异常退出（finalized=false）'}`);
  out.push(`持续      ${fmtDur(r.durationMs)}  采样 ${r.summary.sampleCount} 次`);
  out.push('');

  // ── 1. 吞吐健康 ─────────────────────────────────────────────
  const totalBytes = r.counters['pty.outputBytes'] ?? 0;
  const totalChunks = r.counters['pty.outputChunks'] ?? 0;
  const avgRate = r.durationMs > 0 ? (totalBytes * 1000) / r.durationMs : 0;
  const peakRate = r.summary.peakPtyBytesPerSecond ?? 0;
  const burst = r.summary.ptyBurstWindows ?? 0;
  const peakPending = r.gauges['pty.peakPendingEmitBytes'] ?? 0;

  out.push(`── 1. PTY 数据吞吐 ──`);
  out.push(`  总输出        ${fmtBytes(totalBytes)}  (${totalChunks} chunks)`);
  out.push(`  全程平均速率  ${fmtRate(avgRate)}`);
  out.push(
    `  单窗口峰值    ${fmtRate(peakRate)}  (突发窗口 ${burst} 次，阈值 ${fmtRate(BURST_THRESHOLD)})`,
  );
  out.push(`  8ms 合并吸收  单次峰值 ${fmtBytes(peakPending)}`);

  if (peakRate >= 10 * 1024 * 1024) {
    warn.push(
      `单窗口吞吐峰值 ${fmtRate(peakRate)} 很高（>=10 MiB/s），可能是一次性 cat/编译输出，留意是否触发背压。`,
    );
  }
  if (peakPending > 512 * 1024) {
    warn.push(
      `8ms 合并窗口单次吸收 ${fmtBytes(peakPending)} 较大，说明远端曾在 8ms 内刷出大量字节。`,
    );
  }
  if (burst > 0 && peakRate < BURST_THRESHOLD) {
    // 不该发生（burst 基于 peakRate 同阈值），信息性提示
  }
  if (totalBytes === 0) {
    ok.push('本次运行无 PTY 输出，吞吐维度不适用。');
  } else {
    const burstRatio = r.summary.sampleCount > 0 ? burst / r.summary.sampleCount : 0;
    if (burstRatio < 0.05)
      ok.push(`突发窗口占比 ${(burstRatio * 100).toFixed(1)}%，以平稳流为主。`);
    else warn.push(`突发窗口占比 ${(burstRatio * 100).toFixed(1)}%，重流较频繁。`);
  }
  out.push('');

  // ── 2. 背压事件 ──────────────────────────────────────────────
  const dispatch = r.operationHeatmap.find((o) => o.name === 'pty.sessionOutputDispatch');
  out.push(`── 2. 背压信号 (sessionOutput IPC 发送) ──`);
  if (!dispatch || dispatch.count === 0) {
    out.push(`  暂无 sessionOutput 发送采样（无 owner 窗口或无输出）。`);
  } else {
    const slowBucket =
      (dispatch.buckets?.lt250 ?? 0) +
      (dispatch.buckets?.lt500 ?? 0) +
      (dispatch.buckets?.lt1000 ?? 0) +
      (dispatch.buckets?.lt5000 ?? 0) +
      (dispatch.buckets?.gte5000 ?? 0);
    out.push(`  发送次数      ${dispatch.count}`);
    out.push(
      `  平均 ${fmtMs(dispatch.averageMs)}  近似p95 ${fmtMs(dispatch.approximateP95Ms)}  最大 ${fmtMs(dispatch.maxMs)}  错误 ${dispatch.errors}`,
    );
    out.push(`  >=${SLOW_DISPATCH_MS}ms 慢发送   约 ${slowBucket} 次 (粗略：>=250ms bucket 之和)`);
    if (dispatch.maxMs >= SLOW_DISPATCH_MS) {
      warn.push(
        `sessionOutput 单次发送最大 ${fmtMs(dispatch.maxMs)} 超过 ${SLOW_DISPATCH_MS}ms：renderer(xterm 解析/GC)可能跟不上 = 背压。`,
      );
    } else {
      ok.push(`sessionOutput 发送最大 ${fmtMs(dispatch.maxMs)} 健康，无明显背压。`);
    }
  }
  out.push('');

  // ── 3. stall ↔ 流量相关性 ───────────────────────────────────
  out.push(`── 3. main event-loop stall 与流量相关性 ──`);
  const stalls = r.recentStalls ?? [];
  out.push(
    `  stall: >=100ms ${r.summary.stallCount100Ms}  >=250ms ${r.summary.stallCount250Ms}  >=1000ms ${r.summary.stallCount1000Ms}  最大 ${fmtMs(r.summary.maxStallMs)}`,
  );
  if (stalls.length === 0) {
    ok.push('无 >=100ms stall。');
  } else {
    // 把每条 stall 的近窗口速率排序，找流量相关
    const withTraffic = stalls.filter((s) => (s.ptyBytesPerSecond ?? 0) > 0);
    const hotStalls = stalls.filter(
      (s) => (s.ptyBytesPerSecond ?? 0) >= 256 * 1024 || (s.activeOperations?.length ?? 0) > 0,
    );
    out.push(`  有近窗口速率记录的 stall: ${withTraffic.length}/${stalls.length}`);
    out.push(`  “高流量 或 有活跃操作” 的 stall: ${hotStalls.length}`);
    // 列最相关的 5 条
    const top = [...stalls]
      .sort((a, b) => (b.ptyBytesPerSecond ?? 0) - (a.ptyBytesPerSecond ?? 0))
      .slice(0, 5);
    out.push(`  最可能与流量相关的 stall (按近窗口速率排序):`);
    out.push(
      `    ${pad('启动后ms', 12)}${pad('drift', 9)}${pad('CPU%', 8)}${pad('近PTY速率', 14)}活跃操作`,
    );
    for (const s of top) {
      out.push(
        `    ${pad(s.atMs, 12)}${pad(fmtMs(s.driftMs), 9)}${pad(s.mainCpuPercent, 8)}${pad(fmtRate(s.ptyBytesPerSecond ?? 0), 14)}${(s.activeOperations ?? []).join(', ') || '无'}`,
      );
    }
    if (hotStalls.length >= Math.max(1, Math.ceil(stalls.length * 0.3))) {
      warn.push(
        `多数 stall 伴随流量突发或活跃操作，stall 很可能与 PTY/IPC 背压相关，而非无关抖动。`,
      );
    } else {
      ok.push('多数 stall 既无高流量也无活跃操作，更像与终端吞吐无关的系统抖动。');
    }
  }
  out.push('');

  // ── 4. 瓶颈定位 (operation heatmap) ─────────────────────────
  out.push(`── 4. 操作热力图 (按总耗时排序 top 10) ──`);
  const ops = [...(r.operationHeatmap ?? [])]
    .map((o) => ({ ...o, total: o.totalMs }))
    .sort((a, b) => b.total - a.total);
  if (ops.length === 0) {
    out.push('  暂无操作采样。');
  } else {
    out.push(
      `    ${pad('操作', 38)}${pad('次数', 8)}${pad('错误', 6)}${pad('总ms', 10)}${pad('均ms', 9)}${pad('p95', 8)}${pad('最大', 9)}`,
    );
    for (const o of ops.slice(0, 10)) {
      out.push(
        `    ${pad(o.name.slice(0, 36), 38)}${pad(o.count, 8)}${pad(o.errors, 6)}${pad(o.total.toFixed(0), 10)}${pad(o.averageMs.toFixed(1), 9)}${pad(o.approximateP95Ms.toFixed(0), 8)}${pad(o.maxMs.toFixed(0), 9)}`,
      );
    }
    const worst = ops[0];
    if (worst && worst.total > 0) {
      out.push(
        `  耗时占比最高：${worst.name} (总 ${worst.total.toFixed(0)} ms${worst.errors > 0 ? `，${worst.errors} 错误` : ''})`,
      );
    }
  }
  out.push('');

  // ── 5. 内存健康 ─────────────────────────────────────────────
  out.push(`── 5. 内存健康 ──`);
  out.push(`  main RSS 峰值       ${fmtBytes(r.summary.peakRssBytes)}`);
  out.push(`  Electron WS 峰值    ${fmtBytes((r.summary.peakElectronWorkingSetKb ?? 0) * 1024)}`);
  if (r.latestSample) {
    out.push(
      `  最近 main RSS/heap  ${fmtBytes(r.latestSample.rssBytes)} / ${fmtBytes(r.latestSample.heapUsedBytes)}`,
    );
  }
  out.push(
    `  windows=${r.gauges['runtime.windows'] ?? '-'} sessions=${r.gauges['runtime.sessionsTotal'] ?? '-'} (live ${r.gauges['runtime.sessionsLive'] ?? '-'})`,
  );
  if (r.summary.peakRssBytes > 600 * 1024 * 1024) {
    warn.push(
      `main RSS 峰值 ${fmtBytes(r.summary.peakRssBytes)} 偏高（>600 MiB），长期运行需关注。`,
    );
  }
  out.push('');

  // ── 6. 隐私自检 ─────────────────────────────────────────────
  out.push(`── 6. 隐私自检 (自动报告不应含路径/命令/终端内容) ──`);
  const blob = JSON.stringify(r);
  const hits = [];
  for (const needle of [
    homedir(),
    'Administrator',
    '\\\\Users\\\\',
    'C:\\\\',
    'D:\\\\',
    'AppData',
    '.git',
    'password',
    'token',
  ]) {
    if (needle && blob.includes(needle)) hits.push(needle);
  }
  // metric name 是否含动态高基数（路径/扩展名/ID）
  const dynamicNames = Object.keys(r.counters)
    .concat(Object.keys(r.gauges))
    .concat((r.operationHeatmap ?? []).map((o) => o.name))
    .filter(
      (n) =>
        /[\/]/.test(n) ||
        /.(?:ts|js|py|json)/i.test(n) ||
        /session[_:-][0-9a-f]{8,}/i.test(n) ||
        /win[d]?[_:-]?d{4,}/i.test(n),
    );
  if (hits.length === 0 && dynamicNames.length === 0) {
    ok.push('✅ 未发现路径/用户名/命令泄露；metric name 均为固定低基数。');
  } else {
    if (hits.length) warn.push(`报告中出现疑似隐私关键字：${hits.join(', ')}`);
    if (dynamicNames.length)
      warn.push(`疑似动态/高基数 metric name：${dynamicNames.slice(0, 5).join(', ')}`);
  }
  out.push('');

  // ── 总结 ────────────────────────────────────────────────────
  out.push(`═══ 诊断总结 ═══`);
  out.push(`✅ 健康项 (${ok.length})：`);
  for (const s of ok) out.push(`   + ${s}`);
  if (warn.length) {
    out.push(`⚠️  需关注 (${warn.length})：`);
    for (const s of warn) out.push(`   ! ${s}`);
  } else {
    out.push(`⚠️  需关注：无`);
  }

  return out.join('\n') + '\n';
}

// ── main ────────────────────────────────────────────────────────────
function main() {
  const arg = process.argv[2];
  let path;
  try {
    path = resolveReport(arg);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  }
  const raw = readFileSync(path, 'utf8');
  let report;
  try {
    report = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(
      `解析 JSON 失败 (${path}): ${e instanceof Error ? e.message : String(e)}\n`,
    );
    process.exit(3);
  }
  process.stdout.write(`分析报告: ${path}\n\n`);
  process.stdout.write(analyze(report));
}

main();
