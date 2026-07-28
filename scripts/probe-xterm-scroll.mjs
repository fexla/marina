/**
 * @file scripts/probe-xterm-scroll.mjs
 * @purpose 实测 xterm 滚动原语,验证「切换终端记住滚动位置」用的字段/方法正确。
 *
 * @背景:TerminalView 的滚动位置记忆曾用 buf.baseY 存「视口顶部行」,
 *   实测发现 baseY = ybase(滚动历史总量,恒定,不随拖动变),导致存的值恒等于
 *   底部、scrollToLine 永远到底,记忆完全失效。正确字段是 buf.viewportY
 *   (视口顶部行)。本脚本用 @xterm/headless 复现并验证修复。
 *
 * @跑法:node scripts/probe-xterm-scroll.mjs
 *   预期最后一步 matchesSaved=true(viewportY 精确恢复)。
 *
 * @不要在这里改业务逻辑;这是诊断脚本,保留供未来排查同类问题。
 */
import pkg from '@xterm/headless';
const { Terminal } = pkg;

const term = new Terminal({ cols: 80, rows: 10, scrollback: 1000 });
// xterm write 是异步排队,必须用 write('', cb) 当 drain fence 才能读到真实 buffer。
const drain = () => new Promise((resolve) => term.write('', resolve));

for (let i = 0; i < 50; i++) term.writeln(`line ${i}`);
await drain();

const buf = () => term.buffer.active;
const log = [];

// 写完 50 行:baseY(=ybase)与 viewportY 在底部相等,但二者语义不同。
log.push({ step: 'at-bottom', baseY: buf().baseY, viewportY: buf().viewportY, length: buf().length });

// 滚上去 5 行:viewportY 应变化、baseY 不应变化(ybase 是历史总量)。
const target = buf().viewportY - 5;
term.scrollToLine(target);
await drain();
log.push({ step: 'scrolled-up-5', baseY: buf().baseY, viewportY: buf().viewportY, target });

const savedViewportY = buf().viewportY;
const savedAtBottom = buf().viewportY + term.rows >= buf().length;

// 模拟 replay fence:先到底,再用 scrollToLine(savedViewportY) 恢复。
term.scrollToBottom();
await drain();
term.scrollToLine(savedViewportY);
await drain();

log.push({
  step: 'restored',
  baseY: buf().baseY,
  viewportY: buf().viewportY,
  savedViewportY,
  savedAtBottom,
  matchesSaved: buf().viewportY === savedViewportY,
});

term.dispose();
console.log(JSON.stringify(log, null, 2));
