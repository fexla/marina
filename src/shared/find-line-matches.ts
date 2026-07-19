/**
 * @file src/shared/find-line-matches.ts
 * @purpose 文件内查找:给定行数组 + query,返回每行的匹配区间(供行内高亮 + 跳转)。
 *
 * @关键设计:
 * - 纯函数,便于单测(后端协议:工具放 shared)。
 * - 复用 findMatches 做行内区间计算。
 * - 返回结构:行号 → 区间数组。只含匹配行(无匹配行不在 Map 中)。
 * - 匹配行序号(供 current 索引跳转):matchLineIndices = [...Map.keys()] 升序。
 *
 * @对应文档:docs/方案-面板Ctrl-F搜索-20260719.md §3.3B
 */
import { findMatches } from './text-search';

export interface LineMatch {
  /** 行号(0-based)。 */
  lineIndex: number;
  /** 该行的匹配区间(供 <mark> 高亮)。 */
  ranges: Array<[number, number]>;
}

/**
 * 算出所有含 query 的行及其匹配区间。
 *
 * @param lines 文件按行切分的数组(0-based 索引 = 行号)
 * @param query 查询串(空串 = 无匹配,返回空数组)
 * @param caseSensitive 大小写敏感
 * @returns 匹配行列表(按 lineIndex 升序)
 */
export function findLineMatches(
  lines: readonly string[],
  query: string,
  caseSensitive: boolean,
): LineMatch[] {
  if (!query) return [];
  const result: LineMatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    const ranges = findMatches(lines[i] ?? '', query, caseSensitive);
    if (ranges.length > 0) {
      result.push({ lineIndex: i, ranges });
    }
  }
  return result;
}
