/**
 * @file src/shared/terminal-md-link-detector.test.ts
 * @purpose 测 terminal-md-link-detector.ts 的 []() 检测(方案-终端可交互链接-20260912)。
 *   跨折行拼接由 terminal-line-window.ts 负责,这里只测「给一段文本,检测对不对」。
 */
import { describe, expect, it } from 'vitest';
import { detectMdLinks } from './terminal-md-link-detector';

describe('detectMdLinks 基础', () => {
  it('行内链接:label + href 提取,index 覆盖整段 [..](..)', () => {
    const text = 'see [docs](a.md) end';
    const links = detectMdLinks(text);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ label: 'docs', href: 'a.md' });
    expect(text.slice(links[0]!.start, links[0]!.end)).toBe('[docs](a.md)');
  });

  it('marina: 动作链接(percent-encoded)原样提取', () => {
    const href = 'marina:show%20%22a%20b.md%22%20--line%2042';
    const links = detectMdLinks(`click [打开](${href})`);
    expect(links[0]!.href).toBe(href);
  });

  it('多个链接按序返回;label 允许空', () => {
    const links = detectMdLinks('[a](1.md) mid [b](2.md) and [](3.md)');
    expect(links.map((l) => l.href)).toEqual(['1.md', '2.md', '3.md']);
  });

  it('图片 ![alt](src) 排除(与 bridge transformer 不透明段规则一致)', () => {
    expect(detectMdLinks('![shot](pic.png)')).toEqual([]);
    // 但普通链接紧跟 ! 后面(非紧贴 [)不受影响
    expect(detectMdLinks('Hi! [docs](a.md)')).toHaveLength(1);
  });

  it('#anchor 返回(调用方过滤/路由 no-op)—— 检测层不做语义过滤', () => {
    expect(detectMdLinks('[节](#sec-1)')).toHaveLength(1);
  });

  it('href 含一层嵌套括号完整保留(marked 同规则)', () => {
    expect(detectMdLinks('[wiki](https://a/(b))')).toEqual([
      { label: 'wiki', href: 'https://a/(b)', start: 0, end: 21 },
    ]);
  });

  it('label 含转义方括号', () => {
    const links = detectMdLinks('[a \\[x\\] b](u.md)');
    expect(links[0]!.label).toBe('a \\[x\\] b');
    expect(links[0]!.href).toBe('u.md');
  });

  it('title 后缀 [a](u "t") 认,href 不含 title', () => {
    const links = detectMdLinks('[a](u.md "提示")');
    expect(links[0]!.href).toBe('u.md');
    expect(links[0]!.end).toBe('[a](u.md "提示")'.length);
  });
});

describe('detectMdLinks 排除项', () => {
  it('引用式 [a][ref] 不认(终端无引用定义)', () => {
    expect(detectMdLinks('[a][ref]')).toEqual([]);
  });

  it('未闭合语法(流式半截)不认', () => {
    expect(detectMdLinks('[docs](a.md')).toEqual([]);
    expect(detectMdLinks('[docs](')).toEqual([]);
  });

  it('裸 [] 与 () 之间有空格/无后续括号时不认', () => {
    expect(detectMdLinks('array[i] (x) code')).toEqual([]);
    expect(detectMdLinks('fn call() later')).toEqual([]);
  });

  it('array[i](x) 紧贴形态会命中 —— 与 CommonMark/marked 行为一致(已知取舍)', () => {
    // markdown 里 array[i](x) 本来就会渲染成链接;检测器保持同语义,不为
    // 终端场景收紧(误点代价 = 路径不存在 toast,可接受)。
    expect(detectMdLinks('array[i](x)')).toHaveLength(1);
  });

  it('空文本 / 无链接文本 → []', () => {
    expect(detectMdLinks('')).toEqual([]);
    expect(detectMdLinks('plain text only')).toEqual([]);
  });
});
