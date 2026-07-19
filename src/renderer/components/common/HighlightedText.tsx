/**
 * @file src/renderer/components/common/HighlightedText.tsx
 * @purpose 把 text 按查询切分,匹配片段包 <mark>。供列表过滤高亮复用。
 *
 * @关键设计:
 * - 纯展示组件,切分逻辑用 shared/highlightSegments(单测覆盖)。
 * - <mark> 是语义标签,屏幕阅读器会读出"highlighted",无障碍友好。
 * - 无 query 时直接返回原 text(不产生多余 DOM)。
 */
import { highlightSegments } from '@shared/text-search';

export interface HighlightedTextProps {
  text: string;
  query: string;
  caseSensitive: boolean;
}

export function HighlightedText({ text, query, caseSensitive }: HighlightedTextProps): JSX.Element {
  if (!query) return <>{text}</>;
  const segments = highlightSegments(text, query, caseSensitive);
  return (
    <>
      {segments.map((seg, i) =>
        seg.match ? <mark key={i}>{seg.text}</mark> : <span key={i}>{seg.text}</span>,
      )}
    </>
  );
}
