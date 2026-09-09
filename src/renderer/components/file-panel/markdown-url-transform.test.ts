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
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { marinaUrlTransform } from './markdown-url-transform';
import { parseMarinaLinkHref } from '@shared/marina-link';

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

describe('marinaUrlTransform:marina: 动作链接原样放行(v0.3.3 ADR-035)', () => {
  it.each([
    // micromark 实测形态:裸目标里空格必须 %20
    ['marina:show%20issue-42.md'],
    ['marina:run%20gh%20issue%20list'],
    // 引号/花括号等 punctuation 也会被部分编码,统一原样透传给 main 解码
    ['marina:show%20%22my%20report.md%22'],
    // 原始空格形态(<> 包裹的链接目标,防御调用方拿到未编码字符串)
    ['marina:run "git status"'],
    // scheme 大小写不敏感
    ['MARINA:show a.md'],
    // 中文参数(原样,不编码)
    ['marina:show 报告.md'],
  ])('%s → 原样放行', (url) => {
    expect(marinaUrlTransform(url)).toBe(url);
  });

  it.each([
    // 伪前缀:marinax: 不是 marina scheme,上游按未知协议剥空
    ['marinax:show a.md'],
    ['marina-javascript:evil'],
  ])('%s → 仍剥空(不误放行)', (url) => {
    expect(marinaUrlTransform(url)).toBe('');
  });
});

describe('marina: 动作链接全链:micromark 归一化 × 消毒 × 解析(v0.3.3 ADR-035)', () => {
  /**
   * 用真实 micromark 管线(remark-parse → remark-rehype)取 hast href,再过
   * marinaUrlTransform + parseMarinaLinkHref。防「只测手写的 href 形态」假阳性:
   * 引号 / <> 包裹 / %20 / 大小写这些写法,经过 micromark 归一化后长什么样、
   * 能否活着走完三层,这里整链钉死。AI 按 skill 文档写的每种合法形态都必须绿。
   */
  async function hrefOf(md: string): Promise<string | null> {
    const proc = unified().use(remarkParse).use(remarkRehype);
    const tree = await proc.run(proc.parse(md));
    let href: string | null = null;
    interface HastNode {
      tagName?: string;
      properties?: { href?: unknown };
      children?: HastNode[];
    }
    (function walk(n: HastNode): void {
      if (n.tagName === 'a' && n.properties?.href !== undefined) href = String(n.properties.href);
      for (const child of n.children ?? []) walk(child);
    })(tree as HastNode);
    return href;
  }

  it.each([
    // [markdown 源文, 期望 kind|参数|heading/title]
    //
    // ⚠ CommonMark 硬约束(决定合法写法):裸链接目标不容任何空白。
    // marina: 的参数几乎必含空格,所以标准写法是 <> 包裹(推荐,可读)或全 %20。
    // 裸目标 + 字面空格的两种失败形态见下方两个负例。
    ['[x](<marina:show issue-42.md>)', 'show|issue-42.md|'],
    // %20 形态(裸目标,无空白字符)
    ['[x](marina:show%20my%20report.md)', 'show|my report.md|'],
    // <> 内引号被 micromark 编码为 %22,解码后还原
    ['[x](<marina:show "my report.md">)', 'show|my report.md|'],
    ['[x](<marina:show my report.md>)', 'show|my report.md|'],
    // --heading 多词值必须引号(否则第二个词会拼进路径)
    ['[x](<marina:show a.md --heading "Verification Steps">)', 'show|a.md|Verification Steps'],
    // scheme 大小写不敏感
    ['[x](<MARINA:SHOW a.md>)', 'show|a.md|'],
    // run + --title(必须写在命令前)+ 引号值
    ['[x](<marina:run --title "PRs" gh pr list>)', 'run|gh pr list|PRs'],
    // 非 ascii 参数
    ['[x](<marina:show 报告.md>)', 'show|报告.md|'],
    // Windows 盘符 + %5C 编码 + 文件名含空格(裸目标,全 %XX 转义)
    ['[x](marina:show%20D:%5Cws%5Cissue%2042.md)', 'show|D:\\ws\\issue 42.md|'],
    // 命令自身的 flag 原样保留(<> 包裹形态)
    ['[x](<marina:run gh issue list --limit 5>)', 'run|gh issue list --limit 5|'],
    // 同上,%20 形态
    ['[x](marina:run%20gh%20issue%20list%20--limit%205)', 'run|gh issue list --limit 5|'],
  ])('%s', async (md, expected) => {
    const href = await hrefOf(md);
    expect(href, 'micromark 应产出 <a href>').not.toBeNull();
    const transformed = marinaUrlTransform(href!);
    expect(transformed, '消毒层不得剥空/改写 marina: href').toBe(href);
    const parsed = parseMarinaLinkHref(transformed);
    expect(parsed.ok, parsed.ok ? '' : parsed.error).toBe(true);
    if (!parsed.ok) return;
    const actual =
      parsed.command.kind === 'show'
        ? `show|${parsed.command.path}|${parsed.command.heading ?? ''}`
        : `run|${parsed.command.command}|${parsed.command.title ?? ''}`;
    expect(actual).toBe(expected);
  });

  it('裸目标 + 字面空格 + 未引号尾段 → 整体不是链接(渲染为纯文本,不会静默错义)', async () => {
    // [x](marina:show issue-42.md) 是非法裸目标:目标在第一个空格截断,剩余
    // "issue-42.md" 既不是引号 title,链接整体解析失败 → href 为 null。
    // skill 文档因此要求参数含空格时用 <> 包裹或 %20。
    expect(await hrefOf('[x](marina:show issue-42.md)')).toBeNull();
  });

  it('裸目标 + 字面空格 + 引号尾段 → 被当 link title 截断,点击报「需要路径」', async () => {
    // [x](marina:show "my report.md"):引号段恰好是合法 title 语法,链接成立但
    // href 只剩 marina:show —— 点击显式报错,失败模式可自纠(toast 提示写法)。
    const href = await hrefOf('[x](marina:show "my report.md")');
    expect(href).toBe('marina:show');
    const parsed = parseMarinaLinkHref(marinaUrlTransform(href!));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('需要一个文件路径');
  });

  it('伪前缀 marinax: 全链剥空(不会误当 marina: 动作)', async () => {
    const href = await hrefOf('[x](<marinax:show a.md>)');
    expect(href).toBe('marinax:show%20a.md');
    expect(marinaUrlTransform(href!)).toBe('');
  });
});
