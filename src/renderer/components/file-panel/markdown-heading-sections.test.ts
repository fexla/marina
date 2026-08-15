/**
 * @file markdown-heading-sections.test.ts
 * @purpose 验证 remark seam 的 H1-H6 全层级章节重组（单调栈）与目录注入。
 *
 * @关键设计:
 * - 只测纯 AST 变换，不渲染 React/DOM（AGENTS.md §5.1：UI 不测）。
 * - 通过导出的 remarkMarinaHeadingSections() 黑盒驱动，断言用紧凑 shape 树。
 * - 不复测 slug 具体格式（那是 @shared/markdown-heading.test.ts 的职责），
 *   只断言 id 存在且同文档内唯一。
 *
 * @对应文档章节: AGENTS.md 第 5 章；软件定义书.md Markdown 面板功能。
 */
import { describe, expect, it } from 'vitest';

import { remarkMarinaHeadingSections } from './markdown-heading-sections';

/** 测试用最小 mdast 形状；插件只依赖这些字段（type/depth/value/children/data）。 */
interface TestNode {
  type: string;
  depth?: number;
  value?: string;
  children?: TestNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

const heading = (depth: number, text: string): TestNode => ({
  type: 'heading',
  depth,
  children: [{ type: 'text', value: text }],
});

const paragraph = (text: string): TestNode => ({
  type: 'paragraph',
  children: [{ type: 'text', value: text }],
});

const root = (...children: TestNode[]): TestNode => ({ type: 'root', children });

interface ShapeNode {
  kind: 'section' | 'p' | string;
  id?: string;
  level?: number;
  text?: string;
  children: ShapeNode[];
}

const p = (text: string): ShapeNode => ({ kind: 'p', text, children: [] });

/** 把插件产出的 details/summary 压成可读断言树；非章节节点只保留 kind+文本。 */
function shapeOf(node: TestNode): ShapeNode {
  if (node.type === 'marina-details') {
    const props = node.data?.hProperties ?? {};
    const summary = node.children?.[0];
    const headingNode = summary?.children?.[0];
    return {
      kind: 'section',
      id: String(props['data-markdown-heading-id'] ?? ''),
      level: Number(props['data-markdown-heading-level'] ?? 0),
      text: headingNode?.children?.[0]?.value ?? '',
      children: (node.children ?? []).slice(1).map(shapeOf),
    };
  }
  if (node.type === 'paragraph') return p(node.children?.[0]?.value ?? '');
  return { kind: node.type, children: (node.children ?? []).map(shapeOf) };
}

/** 跑插件并返回 [nav, contentChildren]；layout 包装细节不进入断言。 */
function runPlugin(tree: TestNode): { nav: TestNode; content: ShapeNode[] } {
  remarkMarinaHeadingSections()(tree);
  const layout = tree.children?.[0];
  const nav = layout?.children?.[0];
  const contentDiv = layout?.children?.[1];
  if (!nav || !contentDiv) throw new Error('plugin output missing layout children');
  return { nav, content: (contentDiv.children ?? []).map(shapeOf) };
}

const section = (text: string, level: number, children: ShapeNode[] = []): ShapeNode => ({
  kind: 'section',
  id: `id:${text}`,
  level,
  text,
  children,
});

/** toEqual 前把真实 slug 归一为 id:标题 的稳定占位，避免断言耦合 slug 格式。 */
function normalizeIds(nodes: ShapeNode[]): ShapeNode[] {
  return nodes.map((node) =>
    node.kind === 'section'
      ? { ...node, id: `id:${node.text}`, children: normalizeIds(node.children) }
      : node,
  );
}

/** 深度优先收集全部 section id，用于唯一性断言。 */
function collectIds(nodes: ShapeNode[], into: string[] = []): string[] {
  for (const node of nodes) {
    if (node.kind === 'section' && node.id) into.push(node.id);
    collectIds(node.children, into);
  }
  return into;
}

describe('remarkMarinaHeadingSections — H1-H6 全层级重组', () => {
  it('嵌套与覆盖：每级章节吃掉后续内容直到下一个 ≤ 自身层级的标题', () => {
    const tree = root(
      paragraph('前言'),
      heading(1, 'A'),
      paragraph('A 正文'),
      heading(2, 'A1'),
      paragraph('A1 正文'),
      heading(3, 'A1a'),
      paragraph('A1a 正文'),
      heading(2, 'A2'),
      paragraph('A2 正文'),
      heading(1, 'B'),
      paragraph('B 正文'),
    );
    const { content } = runPlugin(tree);
    expect(normalizeIds(content)).toEqual([
      p('前言'),
      section('A', 1, [
        p('A 正文'),
        section('A1', 2, [p('A1 正文'), section('A1a', 3, [p('A1a 正文')])]),
        section('A2', 2, [p('A2 正文')]),
      ]),
      section('B', 1, [p('B 正文')]),
    ]);
    const ids = collectIds(content);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.length > 0)).toBe(true);
  });

  it('层级跳跃：H1 后直接 H3，H3 归入 H1；随后的 H2 弹出 H3、与 H3 同挂 H1', () => {
    const tree = root(
      heading(1, 'Top'),
      heading(3, 'Deep'),
      paragraph('deep'),
      heading(2, 'Mid'),
      paragraph('mid'),
    );
    const { content } = runPlugin(tree);
    expect(normalizeIds(content)).toEqual([
      section('Top', 1, [section('Deep', 3, [p('deep')]), section('Mid', 2, [p('mid')])]),
    ]);
  });

  it('同级兄弟：H4 连续出现互为兄弟，内容不串节', () => {
    const tree = root(
      heading(2, 'P'),
      heading(4, 'X'),
      paragraph('x1'),
      heading(4, 'Y'),
      paragraph('y1'),
      paragraph('y2'),
    );
    const { content } = runPlugin(tree);
    expect(normalizeIds(content)).toEqual([
      section('P', 2, [section('X', 4, [p('x1')]), section('Y', 4, [p('y1'), p('y2')])]),
    ]);
  });

  it('H5/H6 深层同样获得 section；深标题前的段落留在浅层内', () => {
    const tree = root(heading(5, 'Five'), paragraph('f'), heading(6, 'Six'), paragraph('s'));
    const { content } = runPlugin(tree);
    expect(normalizeIds(content)).toEqual([
      section('Five', 5, [p('f'), section('Six', 6, [p('s')])]),
    ]);
  });

  it('目录 rail 不受影响：列出全部层级并标注最大深度', () => {
    const tree = root(heading(1, 'A'), heading(3, 'C'), heading(2, 'B'));
    const { nav } = runPlugin(tree);
    const props = nav.data?.hProperties ?? {};
    expect(props['data-markdown-heading-max-level']).toBe(3);
    const links = (nav.children ?? []).map((link) => ({
      level: Number(link.data?.hProperties?.['data-markdown-heading-level'] ?? 0),
      href: String(link.data?.hProperties?.href ?? ''),
    }));
    expect(links.map((link) => link.level)).toEqual([1, 3, 2]);
    expect(links.every((link) => link.href.startsWith('#'))).toBe(true);
  });

  it('无标题文档：原样返回，不注入 layout/rail', () => {
    const tree = root(paragraph('only text'));
    remarkMarinaHeadingSections()(tree);
    expect(tree.children?.length).toBe(1);
    expect(tree.children?.[0]?.type).toBe('paragraph');
  });
});
