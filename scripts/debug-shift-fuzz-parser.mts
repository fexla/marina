/**
 * [DEBUG-shift1] Differential fuzz: Osc1337Parser must produce identical
 * passthrough bytes regardless of how the stream is split into chunks.
 * Reference = same stream parsed as ONE chunk. Any mismatch = chunk-boundary
 * corruption in the byte transport (would visually corrupt TUI repaints).
 */
import { Osc1337Parser } from '../src/main/osc1337-parser';

// ── deterministic PRNG (xorshift32) ──
let seed = 0x9e3779b9;
function rnd(): number {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed;
}
const pick = <T,>(arr: T[]): T => arr[rnd() % arr.length];

// ── realistic TUI soup generator ──
const TEXT = [
  'hello world ', '你好世界 ', 'π≈3.14 ', '┌─┐│└┘ ', '✻ ✶ ⚡ ', 'abc123 ',
  'e\u0301 combining ', 'ＦＵＬＬＷＩＤＴＨ ', '🎉 emoji ', '\t tab ', '\r\n',
];
const CSI = [
  '\x1b[2J', '\x1b[H', '\x1b[12;40H', '\x1b[1;31m', '\x1b[0m', '\x1b[?25l',
  '\x1b[?25h', '\x1b[10D', '\x1b[5C', '\x1b[K', '\x1b[1;1H', '\x1b[2;3r',
];
const OSC_ST = [
  '\x1b]1337;CurrentDir=C:\\Users\\dev\\proj\x07',
  '\x1b]0;✻ Claude · ~/proj (working…)\x07',
  '\x1b]2;some title\x1b\\',
  '\x1b]133;A\x1b\\', '\x1b]133;D;0\x07',
  // OSC 8 hyperlink (must be passed through intact)
  '\x1b]8;;https://example.com/path?a=b&c=d\x1b\\link text\x1b]8;;\x1b\\',
  '\x1b]8;id=foo;file:///d:/x y/z.txt\x07path\x1b]8;;\x07',
];
const WEIRD = [
  '\x1b',                       // lone ESC at chunk edge
  '\x1b[',                      // CSI split candidate
  '\x1b]',                      // OSC start split candidate
  '\x1b]8;;',                   // OSC-8 prefix split candidate
  '\x07',                       // lone BEL
  '\x1b\\',                     // lone ST
  '\x1bP1;2;3|data\x1b\\',      // DCS
  '\x1b_APC\x1b\\',             // APC
  '\x1b[38;2;10;20;30m',        // truecolor SGR
];

function genStream(len: number): string {
  let s = '';
  while (s.length < len) {
    const r = rnd() % 10;
    if (r < 4) s += pick(TEXT);
    else if (r < 7) s += pick(CSI);
    else if (r < 9) s += pick(OSC_ST);
    else s += pick(WEIRD);
  }
  return s;
}

function runChunked(parser: Osc1337Parser, buf: Buffer, cuts: number[]): Buffer {
  parser.reset();
  const parts: Buffer[] = [];
  let pos = 0;
  const sorted = [...cuts].sort((a, b) => a - b);
  for (const c of sorted) {
    if (c > pos && c <= buf.length) {
      const res = parser.parse(buf.subarray(pos, c));
      if (res.passthrough.length) parts.push(res.passthrough);
      pos = c;
    }
  }
  const res = parser.parse(buf.subarray(pos));
  if (res.passthrough.length) parts.push(res.passthrough);
  return Buffer.concat(parts);
}

let failures = 0;
const N = 3000;
for (let i = 0; i < N; i++) {
  const stream = Buffer.from(genStream(50 + (rnd() % 400)), 'utf8');
  const ref = new Osc1337Parser().parse(stream).passthrough;

  // random chunking
  const nCuts = 1 + (rnd() % 12);
  const cuts = Array.from({ length: nCuts }, () => rnd() % (stream.length + 1));
  const got = runChunked(new Osc1337Parser(), stream, cuts);

  if (!ref.equals(got)) {
    failures++;
    if (failures <= 3) {
      // locate first divergence
      let d = 0;
      while (d < Math.min(ref.length, got.length) && ref[d] === got[d]) d++;
      console.log(`MISMATCH iter=${i} refLen=${ref.length} gotLen=${got.length} firstDiff@${d}`);
      console.log('  ref  ctx:', JSON.stringify(ref.subarray(Math.max(0, d - 30), d + 20).toString('latin1')));
      console.log('  got  ctx:', JSON.stringify(got.subarray(Math.max(0, d - 30), d + 20).toString('latin1')));
      console.log('  src  ctx:', JSON.stringify(stream.subarray(Math.max(0, d - 40), d + 30).toString('latin1')));
      console.log('  cuts:', cuts.join(','));
    }
  }
}
console.log(failures === 0 ? `PASS: ${N} random chunkings byte-identical to single-chunk reference` : `FAIL: ${failures}/${N} chunkings corrupted`);
