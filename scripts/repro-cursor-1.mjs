#!/usr/bin/env node
// scripts/repro-cursor-1.mjs
//
// CURSOR-1 / BETA-019 复现脚本(根治后保留作回归测试)。
//
// 验证 state-replay 架构在 scrollback 超 2MB 的 alt-buffer 场景下,renderer
// 重挂时能否正确恢复 alt-buffer + cursor 隐藏状态。
//
// 用法:
//   1. Marina 任意 tab 内 `node scripts/repro-cursor-1.mjs`
//   2. 等进度条满(画面进入稳态)
//   3. 关 Marina 窗口 → 从托盘 / 任务栏重开 → 切回该 tab
//
// 期望(CURSOR-1 修复后):画面完整重现 + 光标继续隐藏。
// 期望(CURSOR-1 修复前):画面错乱 + 闪烁可见光标。
//
// 退出方式:
//   - Ctrl+C / SIGINT/TERM/HUP → cleanup() → 恢复光标 + 退 alt-buffer
//   - 任何未捕获异常 → 'exit' handler 兜底
//   - 到达 3MB 后用 setInterval 保活,防止 Node 事件循环空了自然退出而留下
//     脏终端状态(没发 ?1049l → 用户卡在 alt-buffer)

const TARGET_BYTES = 3 * 1024 * 1024;
const FRAME_INTERVAL_MS = 50; // 20fps — 慢到肉眼能看清,但还够快
const PAD_COLS = 78;

if (!process.stdout.isTTY) {
  console.error('repro-cursor-1: stdout 不是 TTY,本脚本必须在终端里跑');
  process.exit(1);
}

let totalBytes = 0;
let stopped = false;
let frame = 0;
let keepaliveInterval = null;

function write(s) {
  process.stdout.write(s);
  totalBytes += Buffer.byteLength(s, 'utf8');
}

function cleanup() {
  if (stopped) return;
  stopped = true;
  if (keepaliveInterval !== null) {
    clearInterval(keepaliveInterval);
    keepaliveInterval = null;
  }
  // 必发的两条:?25h 显光标、?1049l 退 alt-buffer。不发的话 PowerShell 接管后
  // 下一行 prompt 会落在 alt-buffer 里,光标仍隐藏,用户卡死(本脚本初版的 bug)。
  process.stdout.write('\x1b[?25h\x1b[?1049l');
  process.stdout.write(
    `repro-cursor-1: emitted ${totalBytes.toLocaleString()} bytes total\n`,
  );
}

// 信号路径
process.on('SIGINT', () => {
  cleanup();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(0);
});
process.on('SIGHUP', () => {
  cleanup();
  process.exit(0);
});
// 兜底:timer 链断 / uncaughtException 等自然退出
process.on('exit', cleanup);

// ── 一次性 setup:进 alt-buffer + 隐光标 ──
// 只发一次,模拟 Claude Code / Codex 真实行为。如果 Marina scrollback 截断
// 把这两条字节裁掉,重挂时 xterm 落不到 alt-buffer + cursor 仍可见 + blink。
write('\x1b[?1049h');
write('\x1b[?25l');

const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function rainbow(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const r = (Math.sin((frame + i) * 0.08) * 127 + 128) | 0;
    const g = (Math.sin((frame + i) * 0.08 + 2) * 127 + 128) | 0;
    const b = (Math.sin((frame + i) * 0.08 + 4) * 127 + 128) | 0;
    out += `\x1b[38;2;${r};${g};${b}m${text[i]}`;
  }
  return out + '\x1b[0m';
}

function progressBar(current, target, width) {
  const filled = Math.min(width, Math.floor((current / target) * width));
  return (
    '\x1b[1;32m' +
    '█'.repeat(filled) +
    '\x1b[0;90m' +
    '░'.repeat(width - filled) +
    '\x1b[0m'
  );
}

function drawFrame() {
  if (stopped) return;

  let buf = '';

  // 第一帧画 static 指南(行 1-10),后续帧不再触碰这些行,所以可读。
  if (frame === 0) {
    buf += '\x1b[H\x1b[2J';
    buf += '\x1b[1;36m  CURSOR-1 / BETA-019 复现脚本\x1b[0m\r\n';
    buf += '\x1b[37m  ───────────────────────────────\x1b[0m\r\n';
    buf += '\r\n';
    buf +=
      '  脚本只发一次 \x1b[33m?1049h\x1b[0m + \x1b[33m?25l\x1b[0m,然后刷 alt-screen 帧把\r\n';
    buf += '  Marina scrollback 推过 2MB。等下方进度条满,画面进入稳态。\r\n';
    buf += '\r\n';
    buf += '  操作步骤:\r\n';
    buf += '    1. 等进度条满\r\n';
    buf +=
      '    2. \x1b[1m关 Marina 窗口\x1b[0m → 从托盘 / 任务栏重开 → 切回此 tab\r\n';
    buf += '    3. 验证画面完整重现 + 光标继续隐藏\r\n';
    buf += '\r\n';
  }

  // 进度行(行 12,只更新这一行,可读)
  const pct = Math.min(100, Math.floor((totalBytes / TARGET_BYTES) * 100));
  buf += '\x1b[12;1H\x1b[K';
  buf += `  ${spinner[frame % spinner.length]}  `;
  buf += progressBar(totalBytes, TARGET_BYTES, 40);
  buf += `  \x1b[1m${(totalBytes / 1024).toFixed(0).padStart(5)}\x1b[0m / ${(TARGET_BYTES / 1024).toFixed(0)} KB  \x1b[2m(${pct}%)\x1b[0m`;

  // 字节灌注区(行 14-18):每行 truecolor SGR + UTF-8 横线,凑字节量。
  // 主体可读区(行 1-11)完全不动,只这五行随帧缓慢变色,视觉确认在干活。
  for (let r = 0; r < 5; r++) {
    buf += `\x1b[${14 + r};1H\x1b[K`;
    buf += rainbow(`  ${'─'.repeat(PAD_COLS)}`);
  }

  write(buf);
  frame++;

  if (totalBytes >= TARGET_BYTES) {
    // 稳态终屏:盖掉进度区,显示完成 + 操作提示
    let final = '';
    final += '\x1b[12;1H\x1b[K';
    final += `  \x1b[1;32m✓ Emitted ${(totalBytes / 1024).toFixed(0)} KB (> 2MB Marina scrollback cap)\x1b[0m`;
    final += '\x1b[14;1H\x1b[K';
    final += '\x1b[15;1H\x1b[K  \x1b[37m现在试一下:\x1b[0m';
    final +=
      '\x1b[16;1H\x1b[K    \x1b[1m关闭 Marina 窗口\x1b[0m,从托盘 / 任务栏重新打开,切回此 tab';
    final += '\x1b[17;1H\x1b[K';
    final += '\x1b[18;1H\x1b[K  CURSOR-1 修复正确 → 画面完整 + 光标仍隐藏';
    final +=
      '\x1b[19;1H\x1b[K  按 \x1b[1mCtrl+C\x1b[0m 退出(自动恢复光标 + 退 alt-buffer)';
    // 清掉彩虹灌注行
    for (let r = 0; r < 5; r++) {
      final += `\x1b[${21 + r};1H\x1b[K`;
    }
    write(final);

    // 保活:让事件循环不空,防止 Node 自然退出而留下脏终端状态。
    // SIGINT 走 cleanup → process.exit() 是唯一退出路径。
    keepaliveInterval = setInterval(() => {}, 1000);
    return;
  }

  setTimeout(drawFrame, FRAME_INTERVAL_MS);
}

drawFrame();
