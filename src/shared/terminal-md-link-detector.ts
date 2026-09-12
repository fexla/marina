/**
 * @file src/shared/terminal-md-link-detector.ts
 * @purpose 从终端文本(跨折行拼接后的窗口文本)里检测 `[label](href)` 形态的
 *   markdown 链接,供 TerminalView 的 link provider 把它变成可点链接
 *   (方案-终端可交互链接-20260912)。
 *
 * @为什么需要它(pi TUI 之外的第二通道):pi 的交互式输出由 bridge transformer
 *   在源文本层处理(display-only,渲染成 OSC 8);但终端里还有大量**裸 markdown
 *   文本**——`pi -p` 打印模式、`cat 一个 .md 文件`、其它工具输出。本检测器让
 *   这些场景的 []() 也可点,点击路由(marina:show/run、本地路径、http)与
 *   markdown 面板 / OSC 8 链接同源(terminal-link-router.ts)。
 *
 * @规则(与 markdown 面板的解析语义对齐,刻意比完整 CommonMark 简化):
 * - 只认行内链接 `[label](href)`;引用式 `[label][ref]` 不认(终端里无引用定义)。
 * - 图片 `![alt](src)` **不认**(与 bridge transformer 的不透明段规则一致)。
 * - label 允许转义的括号字符(`\]` 等);href 允许一层嵌套括号
 *   (`(https://a/(b))`),与 marked 的链接解析同规则。
 * - `#anchor` href 照样返回(终端无文档内导航语义,由调用方/路由层过滤或 no-op)。
 * - 返回**拼接文本上的字符 index**(0-based, [start, end)),不含 xterm cell
 *   坐标 —— 调用方负责跨行 buffer 位置映射(terminal-line-window.ts 的
 *   mapStrIdx)。
 *
 * @对应文档:docs/方案-终端可交互链接-20260912.md。
 */

/** 检测到的一个 markdown 链接。 */
export interface DetectedMdLink {
  /** label 原文(含转义字符,终端 buffer 里显示的就是它)。 */
  label: string;
  /** href 原值(可能是 https: / marina: / 相对路径 / #anchor)。 */
  href: string;
  /** 整个 `[..](..)` span 起始字符 index(0-based,含)。 */
  start: number;
  /** 结束字符 index(0-based,不含)。 */
  end: number;
}

/**
 * 行内链接正则。label 与 href 的形态:
 * 1. `(?<!!)` 单字符 lookbehind:起点 `[` 的前驱不能是 `!` —— 排除图片语法
 *    `![alt](src)`(`x![a](b)` 的 `[` 前同样恰是 `!`,lookbehind 判定正确)。
 * 2. label:`(?:[^\\[\]]|\\.)*` 任意非方括号/反斜杠字符 + 反斜杠转义对
 *   (字符类内 `[` 无需转义、`]` 需要)。
 * 3. href 三种形态(交替,按优先级):
 *    a. 标准:`(?:[^()\s]|\([^\s()]*\))+`(无空格,允许一层嵌套括号,同 marked);
 *    b. 尖括号包裹:`<[^<>\n]*>`(CommonMark 标准的目标含空格写法,href 取内侧);
 *    c. 宽容 marina:`marina:[^()]*?`(lazy)—— 目标以 `marina:` 开头时允许裸空格。
 *       scheme 锚定使误报面≈零(须出现字面 `](marina:`);lazy 让尾部 title
 *       (`"..."`)留给可选 title 段。这是**终端显示层专用**的宽容(markdown
 *       面板/react-markdown 仍按标准解析),为的是模型常写的
 *       `[运行](marina:run gh issue list)` 自然形态也能点 —— 勘误③(20260913)。
 *       注意 `marina run xxx`(无冒号)不是 scheme,任何形态都不认。
 */
const MD_LINK_RE =
  /(?<!!)\[((?:[^\\[\]]|\\.)*)\]\(\s*(?:<([^<>\n]*)>|((?:[^()\s]|\([^\s()]*\))+)|(marina:[^()]*?))\s*(?:"[^"]*")?\)/g;

/**
 * 从文本里检测所有 `[label](href)` 行内链接。
 *
 * @param text 终端窗口文本(单行或跨折行拼接后;检测器不关心拼接方式)
 * @returns 按出现顺序的链接数组;空数组 = 无
 *
 * @示例
 * detectMdLinks('see [docs](a.md)') → [{ label: 'docs', href: 'a.md', start: 4, end: 17 }]
 * detectMdLinks('![img](a.png)') → []  // 图片排除
 * detectMdLinks('[wikipedia](https://a/(b))') → href 含一层嵌套括号,完整保留
 * detectMdLinks('[x](<a b.md>)') → href 'a b.md'(尖括号形态)
 * detectMdLinks('[运行](marina:run gh issue list)') → href 原样(宽容形态)
 * detectMdLinks('[x](marina run y)') → []  // 无冒号不是 scheme,不认
 */
export function detectMdLinks(text: string): DetectedMdLink[] {
  const results: DetectedMdLink[] = [];
  MD_LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MD_LINK_RE.exec(text)) !== null) {
    // href 三选一:尖括号内侧 > 标准串 > 宽容 marina(交替顺序即优先级)。
    const href = m[2] ?? m[3] ?? m[4] ?? '';
    if (href.length === 0) continue;
    results.push({
      label: m[1]!,
      href,
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return results;
}
