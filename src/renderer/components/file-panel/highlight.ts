/**
 * @file src/renderer/components/file-panel/highlight.ts
 * @purpose 共享的 highlight.js 语法高亮封装,供 TextViewer / DiffViewer 复用。
 *
 * @为什么抽出来(ADR-019 / v0.3.2):
 *   v0.3.0 把 hljs 栈(registration + EXT_TO_HLJS + 每行 highlight)实现在 DiffViewer,
 *   v0.3.2 TextViewer 也要语法高亮(开发者反馈「打开文件没高亮」)。两处重复这套栈
 *   既浪费包体积(模块级 registerLanguage 重复执行)又不一致。抽成单一模块:
 *   - registration 全局一次(模块加载时)
 *   - detectLanguageByExt(ext) / detectLanguageFromPath(pathLine) 统一映射
 *   - highlightLine(text, lang) 统一单行高亮(返回 HTML,供 dangerouslySetInnerHTML)
 *
 * @按需 import(包体积控制):
 *   core + diff(元数据行)+ 11 代码语言(ts/js/py/json/bash/yaml/markdown/xml/c/cpp/cs)。
 *   每个语言 ~3-8KB,共 ~50KB(gzip ~18KB),覆盖 ~95% 代码;未注册语言回退 'diff'。
 *
 * @逐行 highlight(非整段):
 *   对每行单独 hljs.highlight,产出独立 HTML(无跨行 span),可安全包进 <div>。
 *   多行 token(块注释/模板字符串)在单行内会降级为普通文本(不报错,仅少着色),
 *   这是行级渲染的固有取舍 —— 对 diff 行级语义天然吻合,对 TextViewer 绝大多数
 *   场景(每行 token 完整)无影响。
 *
 * @安全:hljs 输出只含 <span class="hljs-...">text</span>,无 <script>/事件/js:URL。
 *   CSP style-src 'unsafe-inline' 已含,这里不用 inline style(纯 class + 外部 CSS)。
 *
 * @对应文档:docs/方案-面板待办-20260719.md A1、docs/方案-diff高亮-20260719.md
 */
import hljs from 'highlight.js/lib/core';
// 按需 import:core + diff(元数据行)+ 11 代码语言(内容行)。不全量,控包体积。
import diffLanguage from 'highlight.js/lib/languages/diff';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
import xml from 'highlight.js/lib/languages/xml';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';

// 模块级注册一次(整个 renderer 进程共享)。registerLanguage 幂等。
hljs.registerLanguage('diff', diffLanguage);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('json', json);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('c', c);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('csharp', csharp);

/**
 * 扩展名(小写)→ hljs 语言名。未命中 → undefined → 调用方回退 'diff'。
 *
 * 故意用显式表而非 hljs 自动检测:auto-detect 有歧义(如 .h 可能是 C/C++/ObjC)
 * 且性能差(对每个候选语言跑一遍)。显式表确定 + 快,覆盖高频场景即可。
 */
const EXT_TO_HLJS: Record<string, string> = {
  // TypeScript / JavaScript
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  // Python
  py: 'python',
  pyw: 'python',
  // 配置 / 数据
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'yaml', // toml 无独立语言,yaml 近似着色够用
  ini: 'bash', // ini 近似 bash 注释风格
  // Shell
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  // 文档
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  // 标记(XML 含 HTML)
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  // C 系
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  cs: 'csharp',
  // 日志 / 纯文本(不查表 → 回退,保持纯黑白也可,但给个合理着色)
  log: 'bash', // 日志里常有 [INFO] 这种,bash 的 comment/variable 风格近似
};

/**
 * 按扩展名查 hljs 语言。
 * @param ext 不含点的扩展名(小写)。如 'ts'。
 * @returns 语言名,或 undefined(未命中 → 调用方回退)。
 */
export function detectLanguageByExt(ext: string): string | undefined {
  return EXT_TO_HLJS[ext.toLowerCase()];
}

/**
 * 从文件路径(绝对或相对,任意分隔符)解析出 hljs 语言。
 * @param filePath 如 'src/foo.ts' 或 'C:\\proj\\bar.json'
 * @returns 语言名,或 undefined(无扩展名 / 未命中)。
 */
export function detectLanguageFromPath(filePath: string): string | undefined {
  if (!filePath) return undefined;
  // 取最后一段(去 query/hash:foo.ts?v=1 → foo.ts)
  const lastSegment = filePath.split(/[\\/]/).pop() ?? filePath;
  const baseName = lastSegment.split('?')[0]?.split('#')[0] ?? lastSegment;
  const dotIdx = baseName.lastIndexOf('.');
  // dotIdx<=0:无扩展名 或 .隐藏文件(dot 在首位);末尾点 → 无扩展名
  if (dotIdx <= 0 || dotIdx === baseName.length - 1) return undefined;
  const ext = baseName.slice(dotIdx + 1);
  return EXT_TO_HLJS[ext.toLowerCase()];
}

/**
 * 从 diff 文件路径行(`+++ b/foo.ts` 或 `--- a/foo.ts`)提取扩展名并查表。
 * @returns hljs 语言名,或 undefined(未命中 → 调用方回退 'diff')。
 *
 * 形态:
 *   +++ b/src/foo.ts      ← git 默认前缀 a/ b/
 *   +++ /dev/null         ← 新增/删除文件的空端
 *   +++ "src/path with space.ts"  ← 路径含空格时 git 加引号
 */
export function detectLanguageFromPathLine(line: string): string | undefined {
  const m = /^(?:\+\+\+|---)\s+[ab]\/?(.*)$/.exec(line);
  if (!m || m[1] === undefined) return undefined;
  let rest = m[1].trim();
  // 去引号(git 对含空格的路径加引号)
  if (rest.startsWith('"') && rest.endsWith('"')) {
    rest = rest.slice(1, -1);
  }
  return detectLanguageFromPath(rest);
}

/**
 * 对单行文本做语法高亮,返回 HTML 字符串(供 dangerouslySetInnerHTML)。
 *
 * @param text 单行文本(已去掉行首符号,如 diff 的 +/-)。
 * @param lang hljs 语言名;未注册会回退 'diff'(纯行级,无 token 着色)。
 * @returns hljs 产出的 HTML。text 为空时返回空串(viewer 用 ' ' 占位防塌陷)。
 */
export function highlightLine(text: string, lang: string): string {
  if (!text) return '';
  try {
    return hljs.highlight(text, { language: lang }).value;
  } catch {
    // 语言未注册(理论不会,EXT_TO_HLJS 只返回已注册的)→ 回退 diff。
    try {
      return hljs.highlight(text, { language: 'diff' }).value;
    } catch {
      return ''; // 双保险,hljs 彻底失败也不崩
    }
  }
}
