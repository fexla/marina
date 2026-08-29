#!/usr/bin/node
/**
 * [DEBUG-shift2] Synthetic pi-like TUI workload.
 * Renders an Ink-style frame: bordered box, full-width separators, header,
 * status line (periodic redraw ~500ms like pi's clock/spinner), input line
 * that repaints on every keystroke (like pi's input box).
 * Speaks raw ANSI on stdout; reads stdin keystrokes.
 * Also emits OSC 0 title updates (exercises Marina's OSC parser path).
 */
const ESC = '\x1b';
const sgr = (...n) => `${ESC}[${n.join(';')}m`;
const goto = (y, x) => `${ESC}[${y};${x}H`;

let cols = parseInt(process.env.COLUMNS || process.argv[2] || '110', 10);
let rows = parseInt(process.env.LINES || process.argv[3] || '30', 10);
let typed = '';
let tick = 0;

const draw = () => {
  const w = cols;
  let out = `${ESC}[2J${ESC}[H`;
  // top border
  out += `┌${'─'.repeat(Math.max(0, w - 2))}┐\r\n`;
  out += `│ ${sgr(1, 36)}✻ pi${sgr(0)}  synth-workload  ${new Date().toISOString().slice(11, 19)} ${' '.repeat(Math.max(0, w - 38))}│\r\n`;
  out += `├${'─'.repeat(Math.max(0, w - 2))}┤\r\n`;
  // body lines (leave room: 3 header + 4 footer + input)
  const body = Math.max(1, rows - 9);
  for (let i = 0; i < body; i++) {
    out += `│ ${'·'.repeat(Math.max(0, w - 4))}│\r\n`;
  }
  out += `├${'─'.repeat(Math.max(0, w - 2))}┤\r\n`;
  out += `│ status ${String(tick % 1000).padStart(4, '0')} ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ idle ${' '.repeat(Math.max(0, w - 30))}│\r\n`;
  out += `│ ${'─'.repeat(Math.max(0, w - 4))}│\r\n`;
  const inputText = typed.length > w - 12 ? typed.slice(-(w - 12)) : typed;
  out += `│ ❯ ${inputText}█${' '.repeat(Math.max(0, w - 6 - inputText.length))}│\r\n`;
  out += `└${'─'.repeat(Math.max(0, w - 2))}┘`;
  // cursor back to input position (absolute addressing, like Ink)
  out += goto(rows, 5 + Math.min(inputText.length, w - 10));
  process.stdout.write(out);
};

process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  for (const ch of d) {
    if (ch === '\r') { typed = ''; }              // Enter: just clear (no agent turn)
    else if (ch === '\u007f' || ch === '\b') { typed = typed.slice(0, -1); }
    else if (ch >= ' ') { typed += ch; }
    else if (ch === '\u0003') { process.exit(0); } // Ctrl+C
  }
  draw();
});

process.on('SIGWINCH', () => { /* node sets COLUMNS/LINES env? read from stdout */ });

draw();
setInterval(() => {
  tick++;
  // periodic status-line repaint only (cursor addressing), like pi's clock
  process.stdout.write(goto(rows - 2, 3) + `status ${String(tick % 1000).padStart(4, '0')} ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ idle` + goto(rows, 5 + Math.min(typed.length, cols - 10)));
  if (tick % 40 === 0) process.stdout.write(`${ESC}]0;pi synth ${tick % 400}${ESC}\\`);
}, 500);
