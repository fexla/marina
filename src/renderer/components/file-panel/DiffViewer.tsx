/**
 * @file src/renderer/components/file-panel/DiffViewer.tsx
 * @purpose 渲染 unified diff,做「双层高亮」:外层 diff 行色(add=绿底/del=红底/
 *   hunk=蓝/meta=淡灰),内层代码语法高亮(从 +++ b/foo.ts 推断语言,对 +/- 行的
 *   内容部分用该语言 highlight.js 着色)。
 *
 * @双层高亮原理(对齐 GitHub / VS Code / GitLab):
 *   diff --git a/foo.ts b/foo.ts      ← header(diff 元数据,diff 语言着色)
 *   @@ -1,3 +1,4 @@                   ← hunk(diff 元数据)
 *    const x = 1;                     ← ctx(代码语法着色)
 *   -const old = 2;                   ← del(红底 + 代码语法着色)
 *   +const newVal = 3;                ← add(绿底 + 代码语法着色)
 *   行底色 + token 色共存:外层 .diff-line-add 控制背景,内层 .hljs-keyword/string/number
 *   控制 token 前景色。两层正交,互不覆盖。
 *
 * @语言推断:
 * - 解析 `+++ b/path/to/file.ext`(新文件路径)→ 取扩展名 → 查 EXT_TO_HLJS。
 * - 一个 diff 可含多文件(multi-file diff),每个 `diff --git` 块重新推断。
 * - 未命中映射表的语言 → 回退 'diff' 语言(只有行级着色,无 token 着色,与旧版一致)。
 *
 * @按需 import(包体积控制):
 * - 注册 11 个高频语言:ts/js/py/json/bash/yaml/markdown/xml/c/cpp/cs(覆盖 ~95% 代码 diff)。
 * - 每个语言 ~3-8KB,11 个共 ~50KB(gzip ~18KB),远小于全量 ~600KB。
 * - 未注册语言走 diff 回退,功能不残缺,只是少 token 着色。
 *
 * @逐行 highlight(非整段):
 * - 对每行单独 hljs.highlight,产出的 HTML 独立(无跨行 span),可安全包 <div>。
 * - 多语言场景下,context/+/- 行用「推断的代码语言」,header/hunk/meta/nl 行用 diff 语言。
 *
 * @安全:hljs 输出只含 <span class="hljs-...">text</span>,无 <script>/事件/javascript: URL。
 *   CSP 已含 style-src 'unsafe-inline',且这里不用 inline style(纯 class + 外部 CSS)。
 *   diff 内容来自 GitService 受控文件(非用户任意输入),双重保险。
 *
 * @不做(刻意克制,对齐 §13.2 / 方案-diff高亮-20260719.md §5.2):
 * - 词级 intra-line word diff(LCS,GitHub 默认也不开)
 * - 并排 side-by-side 视图(IDE 级能力,滑向 Git GUI)
 * - 行号 gutter / 折叠未变上下文
 *
 * @对应文档:docs/方案-diff高亮-20260719.md(方案 B 双层高亮)、ADR-017
 */
import { useMemo } from 'react';
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
import type { OpenedFile } from '@shared/types';
import { useFileContent } from './useFileContent';
import { useTranslation } from '../LanguageProvider';

// 模块级注册一次。registerLanguage 幂等,重复调用会被 hljs 去重。
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

interface ViewerProps {
  sessionId: string;
  file: OpenedFile;
}

/** 行视觉种类(外层 diff 行色,由行首字符决定)。 */
type DiffRowKind = 'header' | 'meta' | 'hunk' | 'add' | 'del' | 'nl' | 'ctx';

/**
 * 扩展名 → hljs 语言名映射。未命中 → undefined → 回退 'diff'(仅行级着色)。
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
};

/**
 * 从 diff 文件路径行(`+++ b/foo.ts` 或 `--- a/foo.ts`)提取扩展名并查表。
 * @returns hljs 语言名,或 undefined(未命中 → 调用方回退 'diff')。
 */
function detectLanguageFromPathLine(line: string): string | undefined {
  // +++ b/src/foo.ts  或  +++ /dev/null(新增/删除文件的空端)
  // +++ "src/path with space.ts"(路径含空格时 git 加引号)
  const m = /^(?:\+\+\+|---)\s+[ab]\/?(.*)$/.exec(line);
  if (!m || m[1] === undefined) return undefined;
  let rest = m[1].trim();
  // 去引号(git 对含空格的路径加引号)
  if (rest.startsWith('"') && rest.endsWith('"')) {
    rest = rest.slice(1, -1);
  }
  // 取最后一段的扩展名(去 query/hash:foo.ts?v=1 → foo.ts)
  const lastSegment = rest.split('/').pop() ?? rest;
  const baseName = lastSegment.split('?')[0]?.split('#')[0] ?? lastSegment;
  const dotIdx = baseName.lastIndexOf('.');
  if (dotIdx <= 0 || dotIdx === baseName.length - 1) return undefined;
  const ext = baseName.slice(dotIdx + 1).toLowerCase();
  return EXT_TO_HLJS[ext];
}

/** 按行首字符判定行的视觉种类(diff 元数据 vs 代码内容)。 */
function classifyLine(line: string): DiffRowKind {
  if (line.startsWith('\\ ')) return 'nl';
  if (line.startsWith('@@')) return 'hunk';
  // file header:注意 +++ 必须在 + 之前判,--- 必须在 - 之前判
  if (line.startsWith('diff --git') || line.startsWith('--- ') || line.startsWith('+++ ')) {
    return 'header';
  }
  if (
    line.startsWith('index ') ||
    line.startsWith('similarity ') ||
    line.startsWith('dissimilarity ') ||
    line.startsWith('rename ') ||
    line.startsWith('copy ') ||
    line.startsWith('new file ') ||
    line.startsWith('deleted file ') ||
    line.startsWith('old mode ') ||
    line.startsWith('new mode ') ||
    line.startsWith('new simlink ') ||
    line.startsWith('deleted simlink ') ||
    line.startsWith('old tree ') ||
    line.startsWith('new tree ') ||
    line.startsWith('Binary files ')
  ) {
    return 'meta';
  }
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}

/** 行首符号(add=+, del=-, 其余=空格槽保持对齐)。 */
function signFor(kind: DiffRowKind): string {
  switch (kind) {
    case 'add':
      return '+';
    case 'del':
      return '-';
    default:
      return ' ';
  }
}

interface DiffRow {
  key: number;
  kind: DiffRowKind;
  /** 行内 HTML(hljs 产出),仅供 dangerouslySetInnerHTML 消费。 */
  html: string;
  /** 去掉行首 +/-/空格 后的纯文本(兜底/调试用)。 */
  text: string;
}

/**
 * 把整段 diff 文本切成 DiffRow[]。逐行 highlight,跟踪当前块的语言(遇 +++ b/path 切换)。
 *
 * 语言选择规则:
 * - header / hunk / meta / nl 行:用 'diff' 语言(它们是 diff 元数据,不是代码)
 * - add / del / ctx 行:用当前块推断的代码语言(未推断出则回退 'diff')
 *
 * 单文件 diff:开头一个 +++ b/foo.ts 设定全块语言。
 * 多文件 diff:每个 diff --git 块重新解析 +++ b/... 切换。
 * 新增文件(/dev/null → 新文件)或删除文件:只一端有路径,仍能推断。
 */
function buildRows(text: string): DiffRow[] {
  const lines = text.split('\n');
  let currentLang = 'diff'; // 默认 diff 语言(纯行级,无 token)
  return lines.map((line, i) => {
    const kind = classifyLine(line);
    // 遇文件头行(+++ b/path 或 --- a/path)更新当前语言。优先 +++(新文件),
    // 但删除文件的 diff 只有 --- a/path 有真实路径(+++ 是 /dev/null),两者都尝试。
    if (kind === 'header') {
      const detected = detectLanguageFromPathLine(line);
      if (detected) {
        currentLang = detected;
      } else if (line.startsWith('+++ ') || line.startsWith('--- ')) {
        // /dev/null 或无法识别扩展名 → 回退 diff 语言(本块不再尝试代码高亮)
        currentLang = 'diff';
      }
    }
    // 选语言:代码行用 currentLang,元数据行强制 diff。
    const lang = kind === 'add' || kind === 'del' || kind === 'ctx' ? currentLang : 'diff';
    // 去掉行首 +/-/空格 后喂给 hljs(符号由 signFor 单独渲染,复制不带符号)。
    const stripped =
      kind === 'add' || kind === 'del' || kind === 'ctx' ? line.replace(/^[+\-\\ ]/, '') : line;
    let html: string;
    try {
      html = hljs.highlight(stripped, { language: lang }).value;
    } catch {
      // 语言未注册(理论不会发生,EXT_TO_HLJS 只返回已注册的)→ 回退 diff。
      html = hljs.highlight(stripped, { language: 'diff' }).value;
    }
    return { key: i, kind, html, text: stripped };
  });
}

export function DiffViewer({ sessionId, file }: ViewerProps): JSX.Element {
  const { tx } = useTranslation();
  const content = useFileContent(sessionId, file.path, file.mtimeMs);

  // content 变化才重算。典型 diff < 500 行,逐行 highlight 总 < 50ms 无感。
  const rowsOrNull = useMemo(() => {
    if (!content || content.kind !== 'diff') return null;
    return buildRows(content.text);
  }, [content]);

  if (!content) {
    return <div className="file-viewer-loading">{tx('加载中…', 'Loading…')}</div>;
  }
  if (content.kind !== 'diff') {
    return (
      <div className="file-viewer-error">
        {content.kind === 'unknown'
          ? content.message
          : tx('内容类型不匹配', 'content kind mismatch')}
      </div>
    );
  }
  const rows = rowsOrNull as DiffRow[];

  return (
    <pre className="diff-viewer">
      {rows.map((row) => (
        <div key={row.key} className={`diff-line diff-line-${row.kind}`}>
          <span className="diff-line-sign">{signFor(row.kind)}</span>
          {/* hljs 输出只含 class span,无脚本/事件,安全。来源是 GitService 受控文件。 */}
          <span
            className="diff-line-body"
            dangerouslySetInnerHTML={{ __html: row.html || ' ' }}
          />
        </div>
      ))}
      {content.truncated && (
        <span className="file-truncated-mark">
          {'\n'}
          {tx('…(diff 过大,仅显示前 2MB)', '…(diff too large, showing first 2MB only)')}
        </span>
      )}
    </pre>
  );
}
