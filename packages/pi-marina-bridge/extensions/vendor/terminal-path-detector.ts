/**
 * @file packages/pi-marina-bridge/extensions/vendor/terminal-path-detector.ts
 * @purpose **Vendored** from Marina 仓 `src/shared/terminal-path-detector.ts`
 *   (只取 linkify 用到的 detectFileLinks 部分)。bridge 包安装在
 *   `~/.pi/agent/packages/` 下独立于 Marina 运行,无法 import Marina 的 src,
 *   故复制一份;两边规则必须保持一致 —— 由 Marina 仓的
 *   `src/main/pi-bridge-linkify.test.ts` 的「一致性对照」测试守护:
 *   同一批样本跑两份实现,输出必须全等。**改 Marina 侧正则时同步改这里**,
 *   否则终端 buffer 检测与 pi transformer 检测行为分叉。
 *
 * @规则(STRICT,ADR-027 决策 1,详见原文件注释):
 * - 必须含至少一个斜杠 + 以 `.扩展名` 结尾 + 可选 `:行:列`;
 * - 裸文件名(`README.md`)不识别;`@` 开头双候选(AI 引用 vs 真文件名);
 * - URL 双保险:匹配起点前落在 `http(s)://` 内则跳过;
 * - 返回字符 index(0-based),不含 xterm cell 坐标换算。
 */

/** 检测到的一个文件路径链接(字段语义与 Marina 原版一致)。 */
export interface DetectedFileLink {
  /** 完整匹配串(含 `:行:列`;`@` 开头时含 `@`)。 */
  raw: string;
  /** 纯路径(剥掉 `:行:列`;`@` 开头时保留)。 */
  path: string;
  /** 点击时逐个尝试的候选路径(剥 @ 优先);本包用 pathCandidates[0] 生成 marina:show。 */
  pathCandidates: string[];
  /** 行号(若有)。 */
  line?: number;
  /** 列号(若有)。 */
  col?: number;
  /** 起始字符 index(0-based,含)。 */
  start: number;
  /** 结束字符 index(0-based,不含)。 */
  end: number;
}

const STRICT_PATH_RE = /(?<![\w.])(?=[\S]*\/)[\w./\\@~\u4e00-\u9fff-]+\.\w{1,8}(?::\d+(?::\d+)?)?/g;

const PATH_PARTS_RE = /^([\w./\\@~\u4e00-\u9fff-]+\.\w{1,8})(?::(\d+)(?::(\d+))?)?$/;

export function detectFileLinks(line: string): DetectedFileLink[] {
  const results: DetectedFileLink[] = [];
  STRICT_PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STRICT_PATH_RE.exec(line)) !== null) {
    const raw = m[0];
    const start = m.index;
    const before = line.slice(0, start);
    if (/https?:$/.test(before) || /https?:\/\/\S*$/.test(before)) {
      continue;
    }
    const parts = raw.match(PATH_PARTS_RE);
    if (!parts) continue;
    const path = parts[1]!;
    const lineNum = parts[2] ? Number(parts[2]) : undefined;
    const colNum = parts[3] ? Number(parts[3]) : undefined;
    const isAtPrefixed = path.startsWith('@');
    const link: DetectedFileLink = {
      raw,
      path,
      pathCandidates: isAtPrefixed ? [path.slice(1), path] : [path],
      start,
      end: start + raw.length,
      ...(lineNum !== undefined ? { line: lineNum } : {}),
      ...(colNum !== undefined ? { col: colNum } : {}),
    };
    results.push(link);
  }
  return results;
}
