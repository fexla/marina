/**
 * @file src/renderer/terminal-line-window.ts
 * @purpose 终端 link provider 的「跨折行窗口文本」工具:把 buffer 里被软折行
 *   劈开的逻辑行拼回完整文本,并把拼接文本上的字符 index 映射回 buffer 的
 *   (行, 列) 坐标。这是修复「换行导致链接检测不出」的关键(ADR-027 盲区,
 *   方案-终端可交互链接-20260912)—— 自研 provider 原来只读单行,路径被
 *   折行劈断就再也匹配不上 STRICT 正则。
 *
 * @算法出处:逐行移植自 @xterm/addon-web-links 的 LinkComputer
 *   (node_modules/@xterm/addon-web-links/src/WebLinkProvider.ts,
 *   MIT License, © xterm.js authors)。官方 addon 的 http 检测能扛软折行
 *   正是靠这套 _getWindowedLineStrings + _mapStrIdx;改 xterm 版本时若
 *   行为分叉,回头对照上游源码。
 *
 * @窗口规则(上游同款):
 * - 从命中行向上/向下沿 isWrapped 扩展,遇「非 wrapped 行 / 含空白的行 /
 *   累计超 2048 字符」停止 —— 含空白即停保证不会把两个无关词拼到一起。
 * - translateToString(true)(trimRight):行尾 padding 空白不算内容。这会让
 *   字符 index 与 cell 列失去 1:1 对应,mapStrIdx 里按 cell 宽度逐格回走修正
 *   (CJK/emoji 双格宽字符、行尾宽字符占位的 +1 修正都在里面)。
 *
 * @不要在这里做的事:
 * - 不做检测(检测器在 shared:terminal-path-detector / terminal-md-link-detector);
 * - 不持状态(纯函数,terminal 实例传入)。
 */
import type { Terminal } from '@xterm/xterm';

/** 一个跨折行窗口:拼接文本 + 顶行 index(0-based buffer 坐标)。 */
export interface TerminalLineWindow {
  text: string;
  /** 窗口第一行的 buffer 行 index(0-based);text 的字符 0 对应该行行首。 */
  topIndex: number;
}

/**
 * 取 lineIndex 所在逻辑行的完整窗口文本(向上/向下沿折行扩展)。
 * 行不存在(超出 buffer)返回 undefined。
 */
export function getWindowedLine(
  terminal: Terminal,
  lineIndex: number,
): TerminalLineWindow | undefined {
  let line = terminal.buffer.active.getLine(lineIndex);
  if (!line) return undefined;
  let topIdx = lineIndex;
  let bottomIdx = lineIndex;
  const lines: string[] = [];

  const currentContent = line.translateToString(true);

  // 向上扩展:当前行是折行产物(逻辑行中间)才需要;行首含空白也停
  // (上游同款启发式,防把上一条命令的输出拼进来)。
  if (line.isWrapped && currentContent[0] !== ' ') {
    let length = 0;
    while ((line = terminal.buffer.active.getLine(--topIdx)) && length < 2048) {
      const content = line.translateToString(true);
      length += content.length;
      lines.push(content);
      if (!line.isWrapped || content.indexOf(' ') !== -1) {
        break;
      }
    }
    lines.reverse();
  }

  lines.push(currentContent);

  // 向下扩展:仅当下一行也是折行产物。
  let length = 0;
  while ((line = terminal.buffer.active.getLine(++bottomIdx)) && line.isWrapped && length < 2048) {
    const content = line.translateToString(true);
    length += content.length;
    lines.push(content);
    if (content.indexOf(' ') !== -1) {
      break;
    }
  }

  return { text: lines.join(''), topIndex: topIdx };
}

/**
 * 把窗口文本上的字符 index 映射回 buffer 位置。
 *
 * @param startLine 起始 buffer 行(0-based)
 * @param startRow 起始行内的起始列(0-based;从窗口头映射传 0)
 * @param stringIndex 要定位的字符 index(相对 startLine:startRow 处为 0)
 * @returns [lineIndex, columnIndex](均 0-based,column 为「该字符所在 cell」),
 *   查越界(行不存在)返回 [-1, -1]
 */
export function mapStrIdx(
  terminal: Terminal,
  startLine: number,
  startRow: number,
  stringIndex: number,
): [number, number] {
  const buf = terminal.buffer.active;
  const cell = buf.getNullCell();
  let lineIndex = startLine;
  let row = startRow;
  let remaining = stringIndex;
  while (remaining > 0) {
    const line = buf.getLine(lineIndex);
    if (!line) {
      return [-1, -1];
    }
    for (let i = row; i < line.length; i += 1) {
      line.getCell(i, cell);
      const chars = cell.getChars();
      const width = cell.getWidth();
      if (width > 0) {
        remaining -= chars.length || 1;
        // 行尾宽字符占位修正(上游同款):translateToString(true) 的 trimRight
        // 会把折行处宽字符的第二格挤掉一格文本,mapStrIdx 回走时补回来。
        if (i === line.length - 1 && chars === '') {
          const next = buf.getLine(lineIndex + 1);
          if (next && next.isWrapped) {
            next.getCell(0, cell);
            if (cell.getWidth() === 2) {
              remaining += 1;
            }
          }
        }
      }
      if (remaining < 0) {
        return [lineIndex, i];
      }
    }
    lineIndex += 1;
    row = 0;
  }
  return [lineIndex, row];
}
