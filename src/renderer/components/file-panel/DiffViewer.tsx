/**
 * @file src/renderer/components/file-panel/DiffViewer.tsx
 * @purpose 渲染 unified diff,用 highlight.js(diff 语言)做行级着色。
 *
 * @关键设计:
 * - 按需 import highlight.js core + diff 语言(避免全量 ~600KB,实际只拉 diff 语法定义 ~2KB)。
 * - 逐行 hljs.highlight(而非整段):每行产出独立 HTML,无跨行 span,可安全包 <div>。
 * - 行级视觉:add=绿底/del=红底/hunk=蓝/meta=淡灰/file-header=粗体;行首 +/- 符号独立
 *   槽(user-select:none → 复制不带符号)。这是 GitHub 默认 diff 视图的等价物。
 * - 行分类由我们自己做(按行首字符),hljs 只负责行内 token 着色(对 diff 几乎只有整行一个 span,
 *   但保留 hljs 是为未来零成本切到带语法着色的代码 diff —— 那时只换 language 参数)。
 * - useMemo 缓存:content 变才重新切行 + 高亮,切 tab/重渲染不重复计算。
 * - 截断:content.truncated 时尾部加淡灰提示(与 TextViewer 一致)。
 *
 * @不做(刻意克制,对齐 §13.2 / 方案-diff高亮-20260719.md §5.2):
 * - 词级 intra-line word diff(LCS,~150 行,GitHub 默认也不开)
 * - 并排 side-by-side 视图(IDE 级能力,滑向 Git GUI)
 * - 行号 gutter / 折叠未变上下文 / 代码语法着色
 *
 * @安全:hljs 输出只含 <span class="hljs-...">text</span>,无 <script>/事件 handler/
 *   javascript: URL。CSP(style-src 'unsafe-inline' 已开,且这里不用 inline style)与
 *   XSS 角度均安全。diff 内容来自 GitService 产出的受控文件(非用户任意输入),双重保险。
 *
 * @对应文档:docs/方案-diff高亮-20260719.md(方案 B)、ADR-017
 */
import { useMemo } from 'react';
import hljs from 'highlight.js/lib/core';
import diffLanguage from 'highlight.js/lib/languages/diff';
import type { OpenedFile } from '@shared/types';
import { useFileContent } from './useFileContent';
import { useTranslation } from '../LanguageProvider';

// 模块级注册一次(diff 语言定义 ~2KB,无副作用,多次 register 会被 hljs 去重)。
hljs.registerLanguage('diff', diffLanguage);

interface ViewerProps {
  sessionId: string;
  file: OpenedFile;
}

/** 行视觉种类(由我们按行首字符决定,与 hljs 的 token 着色正交)。 */
type DiffRowKind = 'header' | 'meta' | 'hunk' | 'add' | 'del' | 'nl' | 'ctx';

/** 按行首字符判定行的视觉种类。与 hljs diff 语言的判定等价,但让我们掌控行底色。 */
function classifyLine(line: string): DiffRowKind {
  // "\ No newline at end of file" — git 的特殊标记行
  if (line.startsWith('\\ ')) return 'nl';
  if (line.startsWith('@@')) return 'hunk';
  // file header:diff --git / --- / +++(注意 +++ 必须在 + 之前判,--- 必须在 - 之前判)
  if (line.startsWith('diff --git') || line.startsWith('--- ') || line.startsWith('+++ ')) {
    return 'header';
  }
  // meta:index / similarity / rename / copy / new file / deleted file / old mode / new mode / Binary files
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
  /** 去掉行首 +/-/空格 后的纯文本(用于无 hljs 样式时的兜底,也方便复制)。 */
  text: string;
}

/**
 * 把整段 diff 文本切成 DiffRow[]。逐行 hljs.highlight 保证每行 HTML 独立,
 * 可安全包进 <div> 而不会有 span 跨界破裂。
 */
function buildRows(text: string): DiffRow[] {
  const lines = text.split('\n');
  return lines.map((line, i) => {
    const kind = classifyLine(line);
    // hljs 对单行 diff 的输出:整行被一个 <span class="hljs-addition|deletion|meta|comment">
    // 包裹,或为纯文本(context 行)。我们对 .value 去掉行首符号字符的 HTML 实体化版本,
    // 但更简单的做法:把去掉行首符号的纯文本喂给 hljs,符号由 signFor 单独渲染。
    const stripped =
      kind === 'add' || kind === 'del' || kind === 'ctx' ? line.replace(/^[+\-\\ ]/, '') : line;
    const html = hljs.highlight(stripped, { language: 'diff' }).value;
    return { key: i, kind, html, text: stripped };
  });
}

export function DiffViewer({ sessionId, file }: ViewerProps): JSX.Element {
  const { tx } = useTranslation();
  const content = useFileContent(sessionId, file.path, file.mtimeMs);

  // content 变化才重算。典型 diff < 500 行,hljs.highlight 单行 <0.1ms,总 <50ms 无感。
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
  // 此处 content.kind === 'diff',rows 由 useMemo 保证非 null(content 变才重算,
  // kind==='diff' 时 buildRows 必返回数组)。断言给 TS 看。
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
