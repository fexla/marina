/**
 * @file src/shared/terminal-path-detector.ts
 * @purpose 从终端单行文本里检测"像文件路径"的串(带斜杠 + 扩展名 + 可选 :行:列),
 *   供 TerminalView 的 xterm link provider 把它们变成可点链接(Feature F / T15)。
 *
 * @关键设计(ADR-027 决策 1):
 * - **STRICT 规则**:必须含至少一个斜杠 + 以点扩展名结尾(`.\w{1,8}`)+ 可选 `:行:列`。
 *   斜杠是"我是路径"的强信号 —— 挡住命令名/变量名/属性访问(`arr.length` 无斜杠不中)。
 *   裸文件名(`README.md`,无斜杠)在本层**不识别** —— 由右键菜单(B 部分,选中即试)兜底。
 *   误识别代价(点错伤信任)远大于漏识别(多一步右键),故从严(22 样本实证,见
 *   docs/prototypes/T14-裸文件名规则对比.md)。
 * - **URL 排除**:虽然运行时 xterm 的 WebLinksAddon 先注册 = 高优先级、intersecting links
 *   机制会去重,这里仍做双保险 —— raw 起点前若落在 `http(s)://` 内则跳过。
 * - **`@` 开头歧义(双候选)**:raw 以 `@` 开头时,既可能是 AI 对话的文件引用标记
 *   (`@src/x.ts` = 引用 src/x.ts),也可能是真有个 `@` 开头的文件名(合法但极罕见)。
 *   字面相同无法区分 → 输出双候选 pathCandidates=[剥@, 带@],点击时逐个试,首个有效为止
 *   (见 linkProvider openPathFromTerminal fallback)。`@` 在路径中间(如 `logo@2x.png`
 *   Retina 图)是合法文件名字符,不触发双候选,单候选即可。
 * - **`~` home 目录**:字符集含 `~`,`~/projects/x.ts` 这类 Shell home 路径可匹配;
 *   main 侧 resolveAndStat 把开头的 `~` 展开成 os.homedir()。
 * - **返回字符 index**(0-based),不是 xterm cell 坐标。linkProvider 调用方负责把字符 index
 *   换算成 1-based cell 列号 —— CJK 全角字符 / emoji 在终端占 2 cell、字符串里只算 1
 *   字符,必须逐 cell 走 getCell().getWidth() 换算,否则下划线/hover 框位置偏左。
 *
 * @对应文档:docs/方案-终端文件路径链接-20260802.md(ADR-027 §决策 1)
 */

/** 检测到的一个文件路径链接。 */
export interface DetectedFileLink {
  /** 完整匹配串(含 `:行:列`,如 `src/x.ts:42:8`;`@` 开头时含 `@`)。 */
  raw: string;
  /** 纯路径(剥掉 `:行:列`,如 `src/x.ts`)。raw 以 `@` 开头时仍**保留** `@`
   *  (如 `@src/x.ts`)——它是 raw 的真实主体,用于 range/展示。点击打开请用
   *  pathCandidates(会给出剥 `@` 的候选),不要直接用本字段打开。 */
  path: string;
  /** 点击时逐个尝试的候选路径数组(优先级从高到低)。raw 以 `@` 开头时为
   *  `[剥@的, 带@的]`(AI 引用是高频场景,排首位);否则为 `[path]` 单元素。
   *  linkProvider 的 openPathFromTerminal 遍历它,首个 cmd:file-panel:open 成功
   *  (resolve 通过)即止,全失败才 toast。利用 openFile 失败在 resolveAndStat 即抛、
   *  零副作用的特性,无需新增探测 IPC。 */
  pathCandidates: string[];
  /** 行号(若有)。 */
  line?: number;
  /** 列号(若有;当前不利用,解析出来备用)。 */
  col?: number;
  /** 在原文的起始字符 index(0-based,含)。 */
  start: number;
  /** 结束字符 index(0-based,不含)。 */
  end: number;
}

/**
 * STRICT 主正则:含斜杠 + 扩展名结尾 + 可选 :行:列。
 * - lookbehind `(?<![\w.])`:起点前驱不能是词字符或点(防止从词中间/点扩展名中间开始)。
 *   括号/引号/空格都可作为合法前驱分隔符(允许 `(src/x.ts` 的 `src` 作起点)。
 * - lookahead `(?=[\S]*\/)`:主体必须含至少一个斜杠(斜杠 = 路径强信号)。
 * - 主体 `[\w./\\@~\u4e00-\u9fff-]+`:只含路径合法字符(字母数字_./\@~ 中文-),
 *   **不含括号/引号/空格/冒号**,所以不会吞 `(src/...` 的 `(`,也不会吞 `:行号`。
 *   `~` 允许任意位置(作首字符 = Shell home 展开 `~/x.ts`;在中间 = 合法文件名字符)。
 * - 结尾 `\.\w{1,8}`:点 + 1~8 位扩展名(宽松形态,不写死白名单,省维护)。
 * - `(?::\d+(?::\d+)?)?`:可选 `:行` 或 `:行:列`。
 */
const STRICT_PATH_RE = /(?<![\w.])(?=[\S]*\/)[\w./\\@~\u4e00-\u9fff-]+\.\w{1,8}(?::\d+(?::\d+)?)?/g;

/**
 * 把 raw 拆成 path / line / col。
 * - 组1 = 纯路径(主体 + 扩展名);组2 = 行;组3 = 列(可选)。
 */
const PATH_PARTS_RE = /^([\w./\\@~\u4e00-\u9fff-]+\.\w{1,8})(?::(\d+)(?::(\d+))?)?$/;

/**
 * 从一行终端文本里检测所有"像文件路径"的串。
 *
 * @param line 终端单行文本(xterm `buffer.active.getLine(n).translateToString(true)` 的结果)
 * @returns 检测到的链接数组(按出现顺序);空数组 = 本行无路径
 *
 * @示例
 * detectFileLinks('at src/main/ipc.ts:1867:22') →
 *   [{ raw: 'src/main/ipc.ts:1867:22', path: 'src/main/ipc.ts', pathCandidates: ['src/main/ipc.ts'],
 *      line: 1867, col: 22, start: 3, end: 28 }]
 * detectFileLinks('see @src/x.ts:42') →  // AI 引用标记 @
 *   [{ raw: '@src/x.ts:42', path: '@src/x.ts', pathCandidates: ['src/x.ts', '@src/x.ts'], line: 42, ... }]
 * detectFileLinks('see assets/logo@2x.png') →  // @ 在中间(Retina 图)= 合法文件名,单候选
 *   [{ path: 'assets/logo@2x.png', pathCandidates: ['assets/logo@2x.png'], ... }]
 * detectFileLinks('edit ~/projects/x.ts') →  // ~ home 展开
 *   [{ path: '~/projects/x.ts', pathCandidates: ['~/projects/x.ts'], ... }]
 * detectFileLinks('see README.md') → []  // 裸文件名无斜杠,不识别(由右键菜单兜底)
 * detectFileLinks('https://example.com/a') → []  // URL 排除
 */
export function detectFileLinks(line: string): DetectedFileLink[] {
  const results: DetectedFileLink[] = [];
  // 复位 lastIndex(正则是 /g 全局态,函数可能被多次调用)
  STRICT_PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STRICT_PATH_RE.exec(line)) !== null) {
    const raw = m[0];
    const start = m.index;
    // URL 双保险:raw 起点前若落在 http(s) 协议内(raw 是 URL 的一部分),跳过。
    // 两种形态:① before 以 `https:` 结尾(raw 从 `//` 开始,即 `https:` + `//example.com`);
    //          ② before 以 `https://...` 结尾(raw 是 URL 后续路径段,如 `localhost:3000/x`)。
    const before = line.slice(0, start);
    if (/https?:$/.test(before) || /https?:\/\/\S*$/.test(before)) {
      continue;
    }
    // 拆 path / line / col(理论上必匹配,防御性判断)
    const parts = raw.match(PATH_PARTS_RE);
    if (!parts) continue;
    const path = parts[1]!;
    const lineNum = parts[2] ? Number(parts[2]) : undefined;
    const colNum = parts[3] ? Number(parts[3]) : undefined;
    // 条件构造:exactOptionalPropertyTypes 下不能给可选字段显式赋 undefined,
    // 故 line/col 仅在有值时展开进对象。
    // pathCandidates:raw 以 @ 开头时双候选[剥@, 带@](AI 引用高频排首),否则单候选[path]。
    // 剥 @ 只剥开头一个;@ 在中间(logo@2x.png)不触发,isAtPrefixed 为 false。
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

/**
 * 从任意文本串(右键选区、光标下词)解析出 path + 可选 line/col。
 * 与 detectFileLinks 不同:本函数**不要求斜杠**(裸文件名 `README.md` 也认),
 * 因为调用方是用户主动选中(B 部分「选中即试」),意图明确,误识别无所谓。
 * 处理:trim → 取首行 → 剥末尾 `:行` / `:行:列`。
 *
 * @示例
 * parsePathWithLineCol('  src/x.ts:42:8  ') → { path: 'src/x.ts', line: 42, col: 8 }
 * parsePathWithLineCol('README.md') → { path: 'README.md' }
 * parsePathWithLineCol('src/a.ts\nsrc/b.ts') → { path: 'src/a.ts' }(多行取首行)
 */
export function parsePathWithLineCol(text: string): {
  path: string;
  line?: number;
  col?: number;
} {
  const firstLine = text.trim().split('\n')[0]!.trim();
  const m = firstLine.match(/^(.+?)(?::(\d+))?(?::(\d+))?$/);
  if (!m) return { path: firstLine };
  const path = m[1]!;
  const line = m[2] ? Number(m[2]) : undefined;
  const col = m[3] ? Number(m[3]) : undefined;
  const result: { path: string; line?: number; col?: number } = { path };
  if (line !== undefined) result.line = line;
  if (col !== undefined) result.col = col;
  return result;
}
