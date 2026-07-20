/**
 * @file src/renderer/components/file-panel/DiffViewer.tsx
 * @purpose 渲染 unified diff,做「双层高亮」:外层 diff 行色(add=绿底/del=红底/
 *   hunk=蓝/meta=淡灰),内层代码语法高亮(从 +++ b/foo.ts 推断语言,对 +/- 行的
 *   内容部分用该语言 highlight.js 着色)。
 *
 * @v0.3.2 改造(A1/A2/A4):
 *   - hljs 栈抽到共享 highlight.ts(TextViewer 也用),本文件只消费。
 *   - 文件内查找改用 useDomTextHighlight(CSS Custom Highlight overlay)——补上 v0.3.1
 *     刻意没做的「行内字符高亮」。overlay 不改 DOM,与 hljs span 嵌套互不干扰,
 *     是绕过当初难题的正确方案。详见 useDomTextHighlight.ts 头注。
 *
 * @v0.3.3 布局对齐 TextViewer(行号槽 + grid 双列 + 水平滚动):
 *   - 加行号槽:从 hunk header @@ -a,b +c,d @@ 解析行号(ctx 用 new-side、del 用
 *     old-side、add 用 new-side),对齐 GitHub/VS Code。v0.3.2 时刻意没加,本批补齐。
 *   - DOM 改三段:gutter(行号+符号,sticky left:0 水平滚动钉住)+ body(white-space:pre)。
 *   - 行号 background:inherit 跟随行底色(add 绿/del 红/hunk 蓝),挡住横向滚过来的代码。
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
 * @逐行 highlight(非整段):对每行单独 hljs.highlight,产出独立 HTML(无跨行 span)。
 *   多语言场景下,context/+/- 行用「推断的代码语言」,header/hunk/meta/nl 行用 diff 语言。
 *
 * @安全:hljs 输出只含 <span class="hljs-...">text</span>,无 <script>/事件/js:URL。
 *   CSP style-src 'unsafe-inline' 已含,这里不用 inline style(纯 class + 外部 CSS)。
 *   diff 内容来自 GitService 受控文件(非用户任意输入),双重保险。
 *
 * @不做(刻意克制,对齐 §13.2 / 方案-diff高亮-20260719.md §5.2):
 * - 词级 intra-line word diff(LCS,GitHub 默认也不开)
 * - 并排 side-by-side 视图(IDE 级能力,滑向 Git GUI)
 *
 * @对应文档:docs/方案-diff高亮-20260719.md(方案 B 双层高亮)、ADR-017、ADR-019
 */
import { useMemo, useRef } from 'react';
import type { OpenedFile } from '@shared/types';
import type { PanelSearchProps } from '../layout/panel-registry';
import { useFileContent } from './useFileContent';
import { useDomTextHighlight } from '../../hooks/useDomTextHighlight';
import { useMiddleClickPan } from '../../hooks/useMiddleClickPan';
import { useTranslation } from '../LanguageProvider';
import { highlightLine, detectLanguageFromPathLine } from './highlight';

/** 行视觉种类(外层 diff 行色,由行首字符决定)。 */
type DiffRowKind = 'header' | 'meta' | 'hunk' | 'add' | 'del' | 'nl' | 'ctx';

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

/** 大文件客户端兜底(A6):超此行数只渲染头部。 */
const MAX_RENDER_ROWS = 50000;

interface DiffRow {
  key: number;
  kind: DiffRowKind;
  /** 文件行号(v0.3.3):代码行按 hunk 行号计数;元数据/header/hunk/nl 行为 null(不显示)。
   * ctx 行用 new-side 行号,del 行用 old-side 行号(add 用 new-side),对齐 GitHub/VS Code。 */
  lineNum: number | null;
  /** 行内 HTML(hljs 产出),仅供 dangerouslySetInnerHTML 消费。 */
  html: string;
}

/**
 * 把整段 diff 文本切成 DiffRow[]。逐行 highlight,跟踪当前块的语言(遇 +++ b/path 切换),
 * 并按 hunk header @@ -a,b +c,d @@ 维护 old/new 双侧行号计数器(v0.3.3 行号槽)。
 *
 * 语言选择规则:
 * - header / hunk / meta / nl 行:用 'diff' 语言(它们是 diff 元数据,不是代码)
 * - add / del / ctx 行:用当前块推断的代码语言(未推断出则回退 'diff')
 *
 * 行号规则(unified diff):
 * - 遇 @@ -oldStart,oldLen +newStart,newLen @@:oldLn=oldStart,newLn=newStart
 * - ctx 行(行首空格):显示 newLn,然后 oldLn++、newLn++
 * - del 行(-):显示 oldLn,然后 oldLn++
 * - add 行(+):显示 newLn,然后 newLn++
 * - header/hunk/meta/nl:无行号(null)
 *
 * 单文件 diff:开头一个 +++ b/foo.ts 设定全块语言。
 * 多文件 diff:每个 diff --git 块重新解析 +++ b/... 切换。
 */
function buildRows(text: string): DiffRow[] {
  const lines = text.split('\n');
  let currentLang = 'diff'; // 默认 diff 语言(纯行级,无 token)
  // hunk 行号计数器(null = 还没进第一个 hunk,此时代码行不该出现,但防御性给 null)
  let oldLn: number | null = null;
  let newLn: number | null = null;
  const rows: DiffRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const kind = classifyLine(line);
    // 遇 hunk header @@ -a,b +c,d @@:重置双侧计数器。
    if (kind === 'hunk') {
      const parsed = parseHunkHeader(line);
      oldLn = parsed?.oldStart ?? null;
      newLn = parsed?.newStart ?? null;
    }
    // 遇文件头行(+++ b/path 或 --- a/path)更新当前语言。
    if (kind === 'header') {
      const detected = detectLanguageFromPathLine(line);
      if (detected) {
        currentLang = detected;
      } else if (line.startsWith('+++ ') || line.startsWith('--- ')) {
        // /dev/null 或无法识别扩展名 → 回退 diff 语言(本块不再尝试代码高亮)
        currentLang = 'diff';
      }
    }
    const lang = kind === 'add' || kind === 'del' || kind === 'ctx' ? currentLang : 'diff';
    const stripped =
      kind === 'add' || kind === 'del' || kind === 'ctx' ? line.replace(/^[+\-\\ ]/, '') : line;

    // 行号:ctx 显示 newLn,del 显示 oldLn,add 显示 newLn;计数后递增。
    let lineNum: number | null = null;
    if (kind === 'ctx' && newLn != null) {
      lineNum = newLn;
      oldLn = oldLn != null ? oldLn + 1 : null;
      newLn = newLn + 1;
    } else if (kind === 'del' && oldLn != null) {
      lineNum = oldLn;
      oldLn = oldLn + 1;
    } else if (kind === 'add' && newLn != null) {
      lineNum = newLn;
      newLn = newLn + 1;
    }

    rows.push({ key: i, kind, lineNum, html: highlightLine(stripped, lang) });
  }
  return rows;
}

/**
 * 解析 hunk header `@@ -oldStart,oldLen +newStart,newLen @@` 的 old/new 起始行号。
 * len 省略时默认 1(如 `@@ -5 +5 @@`)。解析失败返回 null(行号计数器保持不变)。
 */
function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  // 形如 @@ -10,7 +10,9 @@ 或 @@ -1 +1 @@(省略 len)。只取首组 -a 和 +c。
  const m = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
  if (!m || m[1] == null || m[2] == null) return null;
  const oldStart = Number(m[1]);
  const newStart = Number(m[2]);
  if (!Number.isFinite(oldStart) || !Number.isFinite(newStart)) return null;
  return { oldStart, newStart };
}

interface ViewerProps {
  sessionId: string;
  file: OpenedFile;
  /** dock 级搜索状态(文件内查找)。 */
  search: PanelSearchProps;
}

export function DiffViewer({ sessionId, file, search }: ViewerProps): JSX.Element {
  const { tx } = useTranslation();
  const content = useFileContent(sessionId, file.path, file.mtimeMs);
  const containerRef = useRef<HTMLPreElement | null>(null);

  const { rows, truncatedClient } = useMemo(() => {
    if (!content || content.kind !== 'diff') return { rows: null, truncatedClient: false };
    const all = buildRows(content.text);
    if (all.length > MAX_RENDER_ROWS) {
      return { rows: all.slice(0, MAX_RENDER_ROWS), truncatedClient: true };
    }
    return { rows: all, truncatedClient: false };
  }, [content]);

  // 文件内查找:CSS Custom Highlight overlay(补 v0.3.1 没做的行内字符高亮)。
  // skipSelector 跳过行首符号 + 行号槽,只搜代码内容。
  useDomTextHighlight({
    sessionId,
    containerRef,
    query: search.query,
    caseSensitive: search.caseSensitive,
    active: search.visible,
    contentVersion: content,
    skipSelector: '.diff-line-sign, .file-line-number',
  });

  // 中键拖动平移(v0.3.3):与 TextViewer 一致,上下左右自动滚动。
  useMiddleClickPan(containerRef);

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
  const displayRows = rows as DiffRow[];

  return (
    <pre className="diff-viewer" ref={containerRef}>
      {displayRows.map((row) => (
        <div key={row.key} data-line={row.key} className={`diff-line diff-line-${row.kind}`}>
          {/* gutter(行号 + 行首符号):sticky left:0 水平滚动时钉住。background:inherit
           * 取所在 .diff-line-* 行底色,挡住横向滚过来的代码。 */}
          <span className="diff-line-gutter">
            {row.lineNum != null && (
              <span className="file-line-number">{row.lineNum}</span>
            )}
            <span className="diff-line-sign">{signFor(row.kind)}</span>
          </span>
          {/* hljs 输出只含 class span,无脚本/事件,安全。来源是 GitService 受控文件。 */}
          <span
            className="diff-line-body"
            dangerouslySetInnerHTML={{ __html: row.html || ' ' }}
          />
        </div>
      ))}
      {(content.truncated || truncatedClient) && (
        <span className="file-truncated-mark">
          {'\n'}
          {truncatedClient
            ? tx(
                `…(diff 过大,仅显示前 ${MAX_RENDER_ROWS} 行)`,
                `…(diff too large, showing first ${MAX_RENDER_ROWS} lines only)`,
              )
            : tx('…(diff 过大,仅显示前 2MB)', '…(diff too large, showing first 2MB only)')}
        </span>
      )}
    </pre>
  );
}
