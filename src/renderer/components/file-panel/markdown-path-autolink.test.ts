/**
 * @file markdown-path-autolink.test.ts
 * @purpose 验证裸 Windows 盘符路径 → 可点链接的 AST 变换,以及一个端到端
 *   ReactMarkdown 渲染(插件 + marinaUrlTransform 组合)回归。
 *
 * @关键设计:
 * - AST 断言用手工 mdast 黑盒(同 markdown-heading-sections.test.ts 骨架),
 *   不渲染 React/DOM(AGENTS.md §5.1:UI 不测)。
 * - 端到端用例直接采用用户报告的原始行("read D:\\...\\v20_f3.png"),
 *   用 react-dom/server 静态渲染断言 <a href> —— 这是该 bug 的用户可见契约。
 *
 * @背景(2026-08 用户报告):裸路径无链接语法,Markdown 不会自动识别;
 *   前一修复只解决了 [x](D:\\...) 链接被消毒剥空的问题。
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { describe, expect, it } from 'vitest';

import { marinaUrlTransform } from './markdown-url-transform';
import { remarkMarinaPathAutolink } from './markdown-path-autolink';

interface TestNode {
  type: string;
  depth?: number;
  value?: string;
  url?: string;
  children?: TestNode[];
}

const text = (value: string): TestNode => ({ type: 'text', value });
const paragraph = (...children: TestNode[]): TestNode => ({ type: 'paragraph', children });
const root = (...children: TestNode[]): TestNode => ({ type: 'root', children });

interface CollectedLink {
  url: string;
  label: string;
}

/** 收集树里全部 link(url+label)与 link 子树之外的纯文本。 */
function collect(node: TestNode, links: CollectedLink[] = [], texts: string[] = []): {
  links: CollectedLink[];
  texts: string[];
} {
  if (node.type === 'link') {
    links.push({ url: node.url ?? '', label: (node.children ?? []).map((c) => c.value ?? '').join('') });
    return { links, texts };
  }
  if (node.type === 'text' && typeof node.value === 'string') texts.push(node.value);
  for (const child of node.children ?? []) collect(child, links, texts);
  return { links, texts };
}

const run = (tree: TestNode): { links: CollectedLink[]; texts: string[] } => {
  remarkMarinaPathAutolink()(tree);
  return collect(tree);
};

describe('裸盘符路径 → link(用户报告形态)', () => {
  it('用户原始行:read D:\\...\\v20_f3.png', () => {
    const path = 'D:\\data\\projects\\forgame\\common\\CharacterMarbleIdle_Parallels\\p3\\Assets\\Temp\\v20_f3.png';
    const { links, texts } = run(root(paragraph(text(` read ${path}`))));
    expect(links).toEqual([{ url: path, label: path }]);
    expect(texts).toEqual([' read ']);
  });

  it('正斜杠形态 D:/fwd/x.png', () => {
    const { links } = run(root(paragraph(text('看 D:/fwd/x.png 的结果'))));
    expect(links).toEqual([{ url: 'D:/fwd/x.png', label: 'D:/fwd/x.png' }]);
  });

  it('一段多个路径', () => {
    const { links, texts } = run(root(paragraph(text('输入 D:\\a.png 与 D:/b.png 即可'))));
    expect(links).toEqual([
      { url: 'D:\\a.png', label: 'D:\\a.png' },
      { url: 'D:/b.png', label: 'D:/b.png' },
    ]);
    expect(texts).toEqual(['输入 ', ' 与 ', ' 即可']);
  });

  it('行首路径(空边界)', () => {
    const { links } = run(root(paragraph(text('D:\\a.png 已生成'))));
    expect(links).toEqual([{ url: 'D:\\a.png', label: 'D:\\a.png' }]);
  });
});

describe('尾部句读剥离', () => {
  it.each([
    ['结果在 D:\\a.png。', 'D:\\a.png', '。'],
    ['结果在 D:\\a.png,', 'D:\\a.png', ','],
    ['(见 D:\\a.png)', 'D:\\a.png', ')'],
    ['路径是 D:\\a.png;', 'D:\\a.png', ';'],
  ])('%s → 链接不含句读', (line, expectedUrl, trailing) => {
    const { links, texts } = run(root(paragraph(text(line))));
    expect(links).toEqual([{ url: expectedUrl, label: expectedUrl }]);
    expect(texts.join('')).toContain(trailing);
  });
});

describe('不误伤', () => {
  it('URL 中段的 /D:/ 不是边界,不切', () => {
    const { links } = run(root(paragraph(text('看 https://e.com/D:/x/y.png 或 http://D:/z'))));
    expect(links).toEqual([]);
  });

  it('C:无分隔符不识别', () => {
    const { links } = run(root(paragraph(text('盘符 C: 上下文'))));
    expect(links).toEqual([]);
  });

  it('手写链接的 label 不二次嵌套', () => {
    const linkNode: TestNode = {
      type: 'link',
      url: 'D:\\a.png',
      children: [text('这个文件 D:\\b.png 的入口')],
    };
    const tree = root(paragraph(linkNode));
    const { links } = run(tree);
    expect(links).toEqual([{ url: 'D:\\a.png', label: '这个文件 D:\\b.png 的入口' }]);
  });

  it('标题内路径不自动链接(与折叠 toggle 抢事件)', () => {
    const heading: TestNode = { type: 'heading', depth: 2, children: [text('读 D:\\a.png')] };
    const tree = root(heading, paragraph(text('正文 D:\\b.png')));
    const { links } = run(tree);
    expect(links).toEqual([{ url: 'D:\\b.png', label: 'D:\\b.png' }]);
  });

  it('嵌套在 details 结构(headingSections 产物)内的段落仍被处理', () => {
    const inner = paragraph(text('正文 D:\\a.png'));
    const tree = root({
      type: 'marina-details',
      children: [
        { type: 'marina-summary', children: [{ type: 'heading', depth: 1, children: [text('章 D:\\h.png')] }] },
        inner,
      ],
    });
    const { links } = run(tree);
    expect(links).toEqual([{ url: 'D:\\a.png', label: 'D:\\a.png' }]);
  });

  it('无路径时 children 数组身份不变(零扰动)', () => {
    const para = paragraph(text('普通文本,没有路径'));
    const before = para.children;
    remarkMarinaPathAutolink()(root(para));
    expect(para.children).toBe(before);
  });
});

describe('端到端:ReactMarkdown + marinaUrlTransform', () => {
  it('用户原始行渲染出可点链接(href 为 %5C 编码形态,label 保留原始反斜杠)', () => {
    const path = 'D:\\data\\projects\\forgame\\common\\CharacterMarbleIdle_Parallels\\p3\\Assets\\Temp\\v20_f3.png';
    const encodedHref = path.replace(/\\/g, '%5C');
    const html = renderToStaticMarkup(
      React.createElement(
        ReactMarkdown,
        { remarkPlugins: [remarkGfm, remarkMarinaPathAutolink], urlTransform: marinaUrlTransform },
        ` read ${path}`,
      ),
    );
    expect(html).toContain(`<a href="${encodedHref}">${path}</a>`);
  });

  it('句尾中文句读不进 href', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        ReactMarkdown,
        { remarkPlugins: [remarkGfm, remarkMarinaPathAutolink], urlTransform: marinaUrlTransform },
        '结果在 D:\\a\\b.png。',
      ),
    );
    expect(html).toContain('<a href="D:%5Ca%5Cb.png">D:\\a\\b.png</a>');
    expect(html).toContain('。</p>');
  });
});
