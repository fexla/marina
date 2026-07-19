/**
 * @file src/renderer/components/file-panel/TextViewer.tsx
 * @purpose 以等宽行级 <div> 显示文本/源码文件。
 *   v0.3.1:改行级渲染(原整块 <pre>)以支持 Ctrl+F 文件内查找 + 跳转行。
 *   超过 main 端 MAX_READ_TEXT_BYTES 的尾部被截断,显示截断标记。
 */
import { useMemo, useRef } from 'react';
import type { OpenedFile } from '@shared/types';
import type { PanelSearchProps } from '../layout/panel-registry';
import { useFileContent } from './useFileContent';
import { useContentSearch } from '../../hooks/useContentSearch';
import { useTranslation } from '../LanguageProvider';

interface ViewerProps {
  sessionId: string;
  file: OpenedFile;
  /** v0.3.1:dock 级搜索状态(C3 文件内查找)。 */
  search: PanelSearchProps;
}

export function TextViewer({ sessionId, file, search }: ViewerProps): JSX.Element {
  const { tx } = useTranslation();
  const content = useFileContent(sessionId, file.path, file.mtimeMs);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // 行级查找:把 text 按 \n 切分后交给 hook。useMemo 避免每次渲染重新 split
  // (split 是 O(n),且 lines 引用稳定让 hook 的 matches useMemo 不重算)。
  const lines = useMemo(
    () => (content?.kind === 'text' ? splitLines(content.text) : EMPTY_LINES),
    [content],
  );
  const { matches, currentIndex } = useContentSearch({
    sessionId,
    containerRef,
    lines,
    query: search.query,
    caseSensitive: search.caseSensitive,
    active: search.visible,
  });
  // 匹配行 lineIndex → 在 matches 数组的下标(快速判断某行是否是当前聚焦行)。
  const currentLine = currentIndex >= 0 ? matches[currentIndex]?.lineIndex : undefined;

  if (!content) {
    return <div className="file-viewer-loading">{tx('加载中…', 'Loading…')}</div>;
  }
  if (content.kind !== 'text') {
    return (
      <div className="file-viewer-error">
        {content.kind === 'unknown'
          ? content.message
          : tx('内容类型不匹配', 'content kind mismatch')}
      </div>
    );
  }

  return (
    <div className="file-text-viewer" ref={containerRef}>
      {lines.map((line, i) => {
        const match = matches.find((m) => m.lineIndex === i);
        const isCurrent = i === currentLine;
        return (
          <div
            key={i}
            data-line={i}
            className={`file-text-line${isCurrent ? ' search-current' : ''}`}
          >
            {match ? (
              // 匹配行:按区间切分高亮。加 search-match class 让匹配段加底色。
              renderHighlighted(line, match.ranges)
            ) : (
              <span className="file-text-line-content">{line || '\u00a0'}</span>
            )}
          </div>
        );
      })}
      {content.truncated && (
        <div className="file-truncated-mark">
          {tx('…(文件过大,仅显示前 2MB)', '…(file too large, showing first 2MB only)')}
        </div>
      )}
    </div>
  );
}

const EMPTY_LINES: readonly string[] = [];

/** 按 \n 切分,保留空行(行数 = split 结果)。trailing \n 产生末尾空行被忽略。 */
function splitLines(text: string): string[] {
  if (!text) return [''];
  const lines = text.split('\n');
  // 文件末尾的单一 \n 会产生一个空末行,去掉它(与编辑器行号一致)。
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** 按 ranges 把行渲染成「普通段 + <mark class=search-match>」序列。 */
function renderHighlighted(line: string, ranges: Array<[number, number]>): JSX.Element {
  const segments = highlightSegmentsFromRanges(line, ranges);
  return (
    <span className="file-text-line-content">
      {segments.map((seg, i) =>
        seg.match ? (
          <mark key={i} className="search-match">
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </span>
  );
}

/** 用现成区间切分(避免重复算 findMatches,直接用 hook 给的 ranges)。 */
function highlightSegmentsFromRanges(
  text: string,
  ranges: Array<[number, number]>,
): Array<{ text: string; match: boolean }> {
  const segments: Array<{ text: string; match: boolean }> = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), match: false });
    segments.push({ text: text.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
  return segments;
}
