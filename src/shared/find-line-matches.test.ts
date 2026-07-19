/**
 * @file find-line-matches.test.ts
 */
import { describe, expect, it } from 'vitest';
import { findLineMatches } from './find-line-matches';

describe('findLineMatches', () => {
  it('空 query 返回空', () => {
    expect(findLineMatches(['foo', 'bar'], '', false)).toEqual([]);
  });

  it('返回所有匹配行 + 区间', () => {
    const lines = ['hello world', 'no match', 'world peace', 'say world'];
    const result = findLineMatches(lines, 'world', false);
    expect(result).toEqual([
      { lineIndex: 0, ranges: [[6, 11]] },
      { lineIndex: 2, ranges: [[0, 5]] },
      { lineIndex: 3, ranges: [[4, 9]] },
    ]);
  });

  it('一行多匹配', () => {
    const lines = ['foo foo foo'];
    const result = findLineMatches(lines, 'foo', false);
    expect(result).toEqual([{ lineIndex: 0, ranges: [[0, 3], [4, 7], [8, 11]] }]);
  });

  it('大小写敏感', () => {
    const lines = ['Hello hello HELLO'];
    expect(findLineMatches(lines, 'hello', true)).toEqual([{ lineIndex: 0, ranges: [[6, 11]] }]);
    expect(findLineMatches(lines, 'hello', false)).toHaveLength(1);
    const r = findLineMatches(lines, 'hello', false)[0];
    if (r) expect(r.ranges).toHaveLength(3);
  });

  it('空行不匹配', () => {
    expect(findLineMatches(['', '', 'x'], 'x', false)).toEqual([{ lineIndex: 2, ranges: [[0, 1]] }]);
  });
});
