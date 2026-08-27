/**
 * @file src/renderer/components/file-panel/markdown-url-transform.test.ts
 * @purpose 回归:Windows 盘符绝对路径链接不再被 react-markdown 消毒剥空,
 *   危险协议照旧剥空。
 *
 * 背景(2026-08-23 用户报告,renderToStaticMarkup 实测复现):
 *   [图](D:\a\b.png) 与 [页](C:\Users\...\m.html) 都渲染成 <a href=""> 点击无反应。
 *   根因:defaultUrlTransform 把 "C:"/"D:" 当未知 URL 协议(第一个 : 在任何
 *   / ? # 之前且不在 https?/mailto 白名单)→ href 剥空。且 micromark 会把目标里
 *   的反斜杠编码成 %5C,上游实际收到 "C:%5CUsers%5C..." 形态。
 *   下面「放行」用例的值直接采用 micromark 实测输出,防止只测到不会出现的
 *   原始反斜杠形态而漏掉真实路径。
 */
import { describe, expect, it } from 'vitest';
import { marinaUrlTransform } from './markdown-url-transform';

describe('marinaUrlTransform:Windows 盘符绝对路径原样放行', () => {
  it.each([
    // micromark 实测输出形态(反斜杠已编码为 %5C)
    'D:%5Cdata%5Cprojects%5Cforgame%5Ccrown_f3.png',
    'C:%5CUsers%5CAdministrator%5CAppData%5CLocal%5CTemp%5Carchify-demo%5Cmanager-memory.html',
    // 正斜杠形态(micromark 不动它)
    'D:/data/projects/forgame/crown_f3.png',
    // 原始反斜杠形态(防御:调用方可能拿到未编码字符串)
    'D:\\data\\crown_f3.png',
    // 小写盘符
    'c:%5CUsers%5Cx.png',
  ])('%s → 原样放行', (url) => {
    expect(marinaUrlTransform(url)).toBe(url);
  });
});

describe('marinaUrlTransform:危险/未支持协议仍剥空(与上游一致)', () => {
  it.each([
    ['javascript:alert(1)'],
    ['data:text/html,<script>'],
    ['vbscript:msgbox'],
    // file:// main 端未处理,保持上游剥空(用户应写裸路径)
    ['file:///D:/x.png'],
  ])('%s → 剥空', (url) => {
    expect(marinaUrlTransform(url)).toBe('');
  });
});

describe('marinaUrlTransform:常规 URL 与相对路径不受影响', () => {
  it.each([
    ['https://example.com/a?b=1#c'],
    ['mailto:a@b.c'],
    ['#anchor'],
    ['./design-notes.md'],
    ['../src/main.ts'],
    // UNC 路径(无冒号,上游本就按相对路径放行;main 端 decode 后 resolve 成 UNC)
    ['%5Csrv%5Cshare%5Cx.png'],
  ])('%s → 原样放行', (url) => {
    expect(marinaUrlTransform(url)).toBe(url);
  });
});
