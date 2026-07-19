/**
 * @file src/shared/text-search.ts
 * @purpose 文本搜索匹配纯函数,供 renderer 各面板过滤 / 文件内查找复用。
 *
 * @关键设计:
 * - 纯函数,无副作用,便于单测(后端协议:这类工具放 shared)。
 * - 大小写不敏感默认(对齐终端搜索 + VS Code 默认)。
 * - 不支持正则(对齐终端,保持一致;正则记 BACKLOG)。
 *
 * @对应文档:docs/方案-面板Ctrl-F搜索-20260719.md §3.3
 */

/**
 * 判断 text 是否包含 query(子串匹配)。
 *
 * @param text 待搜文本
 * @param query 查询串(空串 = 匹配一切)
 * @param caseSensitive 大小写敏感
 */
export function matchText(text: string, query: string, caseSensitive: boolean): boolean {
  if (!query) return true;
  if (!text) return false;
  return caseSensitive
    ? text.includes(query)
    : text.toLowerCase().includes(query.toLowerCase());
}

/**
 * 找出 text 中所有 query 出现的区间 [start, end)(用于 <mark> 高亮)。
 *
 * @returns 升序、不重叠的区间数组。无匹配返回空数组。
 */
export function findMatches(text: string, query: string, caseSensitive: boolean): Array<[number, number]> {
  if (!query) return [];
  if (!text) return [];
  const ranges: Array<[number, number]> = [];
  const needle = caseSensitive ? query : query.toLowerCase();
  const haystack = caseSensitive ? text : text.toLowerCase();
  let from = 0;
  while (from <= haystack.length) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    ranges.push([idx, idx + needle.length]);
    from = idx + needle.length; // 不重叠:跳过本次匹配
  }
  return ranges;
}

/**
 * 把 text 按 query 匹配区间切分,返回「普通段 + 匹配段」序列,供渲染高亮。
 *
 * 例:highlightSegments('foobar', 'ob', false) →
 *   [{text:'fo', match:false}, {text:'ob', match:true}, {text:'ar', match:false}]
 *
 * 无 query 或无匹配时返回单段 [{text, match:false}]。
 */
export interface TextSegment {
  text: string;
  match: boolean;
}

export function highlightSegments(
  text: string,
  query: string,
  caseSensitive: boolean,
): TextSegment[] {
  if (!query) return [{ text, match: false }];
  const ranges = findMatches(text, query, caseSensitive);
  if (ranges.length === 0) return [{ text, match: false }];
  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), match: false });
    segments.push({ text: text.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
  return segments;
}
