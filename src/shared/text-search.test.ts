/**
 * @file text-search.test.ts
 * @purpose 文本搜索纯函数单测。
 */
import { describe, expect, it } from 'vitest';
import { findMatches, highlightSegments, matchText } from './text-search';

describe('matchText', () => {
  it('空 query 匹配一切', () => {
    expect(matchText('anything', '', false)).toBe(true);
    expect(matchText('', '', false)).toBe(true);
  });
  it('子串匹配(大小写不敏感)', () => {
    expect(matchText('Hello World', 'world', false)).toBe(true);
    expect(matchText('Hello World', 'WORLD', false)).toBe(true);
    expect(matchText('Hello World', 'lo wo', false)).toBe(true);
  });
  it('大小写敏感', () => {
    expect(matchText('Hello World', 'world', true)).toBe(false);
    expect(matchText('Hello World', 'World', true)).toBe(true);
  });
  it('无匹配', () => {
    expect(matchText('Hello', 'xyz', false)).toBe(false);
  });
  it('空 text 非空 query 不匹配', () => {
    expect(matchText('', 'x', false)).toBe(false);
  });
});

describe('findMatches', () => {
  it('返回所有不重叠区间', () => {
    expect(findMatches('foofoofoo', 'foo', false)).toEqual([
      [0, 3],
      [3, 6],
      [6, 9],
    ]);
  });
  it('重叠 query 不重叠返回(aba)', () => {
    // 'ababa' 搜 'aba':匹配 [0,3],下一从 3 搜 → [3,6]?不,'ababa'[3:]='ba' 无 a 开头
    // 实际 [0,3] 后 from=3,indexOf('aba',3)='ababa'.indexOf('aba',3)=-1 → 只 1 个
    expect(findMatches('ababa', 'aba', false)).toEqual([[0, 3]]);
  });
  it('大小写不敏感', () => {
    expect(findMatches('aAaA', 'aa', false)).toEqual([
      [0, 2],
      [2, 4],
    ]);
  });
  it('无匹配返回空', () => {
    expect(findMatches('hello', 'x', false)).toEqual([]);
  });
  it('空 query 返回空', () => {
    expect(findMatches('hello', '', false)).toEqual([]);
  });
});

describe('highlightSegments', () => {
  it('无 query 返回单段', () => {
    expect(highlightSegments('hello', '', false)).toEqual([{ text: 'hello', match: false }]);
  });
  it('无匹配返回单段', () => {
    expect(highlightSegments('hello', 'x', false)).toEqual([{ text: 'hello', match: false }]);
  });
  it('切分匹配与普通段', () => {
    expect(highlightSegments('foobar', 'ob', false)).toEqual([
      { text: 'fo', match: false },
      { text: 'ob', match: true },
      { text: 'ar', match: false },
    ]);
  });
  it('多匹配切分', () => {
    expect(highlightSegments('a1a1', 'a', false)).toEqual([
      { text: 'a', match: true },
      { text: '1', match: false },
      { text: 'a', match: true },
      { text: '1', match: false },
    ]);
  });
  it('匹配在开头', () => {
    expect(highlightSegments('abc', 'ab', false)).toEqual([
      { text: 'ab', match: true },
      { text: 'c', match: false },
    ]);
  });
  it('匹配在末尾', () => {
    expect(highlightSegments('abc', 'bc', false)).toEqual([
      { text: 'a', match: false },
      { text: 'bc', match: true },
    ]);
  });
  it('全匹配', () => {
    expect(highlightSegments('abc', 'abc', false)).toEqual([{ text: 'abc', match: true }]);
  });
});
