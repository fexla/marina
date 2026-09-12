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
 * 行内链接正则。三个部分:
 * 1. `(?<!!)` 单字符 lookbehind:起点 `[` 的前驱不能是 `!` —— 排除图片语法
 *    `![alt](src)`(`x![a](b)` 的 `[` 前同样恰是 `!`,lookbehind 判定正确)。
 * 2. label:`(?:[^\\[\]]|\\.)*` 任意非方括号/反斜杠字符 + 反斜杠转义对
 *   (字符类内 `[` 无需转义、`]` 需要)。
 * 3. href:`(?:[^()\s]|\([^\s()]*\))+` 允许一层嵌套括号(同 marked)。
 */
const MD_LINK_RE =
  /(?<!!)\[((?:[^\\[\]]|\\.)*)\]\(\s*((?:[^()\s]|\([^\s()]*\))+)\s*(?:"[^"]*")?\)/g;

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
 */
export function detectMdLinks(text: string): DetectedMdLink[] {
  const results: DetectedMdLink[] = [];
  MD_LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MD_LINK_RE.exec(text)) !== null) {
    results.push({
      label: m[1]!,
      href: m[2]!,
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return results;
}
