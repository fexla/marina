/**
 * @file markdown-heading-sections.ts
 * @purpose 在 react-markdown 的 remark seam 内为标题分配稳定 id，把 H1-H6
 *   重组为全层级递归嵌套的可折叠章节，并注入左侧目录结构。
 *
 * @关键设计:
 * - 只改 Markdown AST，不碰渲染后的 DOM；React 始终拥有完整节点树，避免手工包裹
 *   sibling 后让 reconciliation 失真。
 * - 单调栈重组：每个标题的章节覆盖到下一个 level ≤ 自身的标题；更深的章节嵌在
 *   更浅的章节内，details 原生支持任意深度嵌套（H1-H6 全部可折叠）。
 * - 层级跳跃（如 H1 后直接 H3）时，深层标题归入最近的更浅标题，与阅读语义一致。
 * - 目录列出 H1-H6 并暴露最大深度。
 * - 插件只由有 fileContext 的 MarkdownDocument 启用；命令面板不会出现目录/折叠。
 *
 * @对应功能:Markdown 标题折叠、左侧目录、show-in-marina --heading。
 *
 * @不要在这里做的事:
 * - 不保存 open/collapsed 状态；那是 MarkdownDocument 的 L1 view state。
 * - 不渲染按钮或主题样式；这里只产出语义结构，React/CSS 负责交互与视觉。
 */
import { createMarkdownHeadingIdFactory } from '@shared/markdown-heading';

interface MarkdownAstData {
  hName?: string;
  hProperties?: Record<string, unknown>;
}

interface MarkdownAstPosition {
  start: { line: number; column: number; offset?: number };
  end: { line: number; column: number; offset?: number };
}

interface MarkdownAstNode {
  type: string;
  depth?: number;
  value?: string;
  alt?: string;
  identifier?: string;
  label?: string;
  children?: MarkdownAstNode[];
  data?: MarkdownAstData;
  /** remark-parse 默认携带源码位置；手工构造的节点可能没有。 */
  position?: MarkdownAstPosition;
}

interface MarkdownAstRoot extends MarkdownAstNode {
  type: 'root';
  children: MarkdownAstNode[];
}

type MarkdownHeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

interface OutlineHeading {
  id: string;
  text: string;
  level: MarkdownHeadingLevel;
}

/** react-markdown remark plugin：每次 parse 以新 slugger 处理一个完整文档。 */
export function remarkMarinaHeadingSections(): (tree: unknown) => void {
  return (tree: unknown): void => {
    if (!isRoot(tree)) return;

    const nextId = createMarkdownHeadingIdFactory();
    const footnoteNumbers = collectFootnoteNumbers(tree);
    walkHeadings(tree, (heading) => {
      const text = plainText(heading, footnoteNumbers);
      const id = nextId(text);
      heading.data = {
        ...heading.data,
        hProperties: {
          ...heading.data?.hProperties,
          id,
          'data-markdown-heading-id': id,
          'data-markdown-heading-level': heading.depth,
          'data-markdown-heading-text': text,
        },
      };
    });

    const outline: OutlineHeading[] = [];
    for (const child of tree.children) {
      if (!isOutlineHeading(child)) continue;
      const id = String(child.data?.hProperties?.id ?? 'section');
      const text = String(
        child.data?.hProperties?.['data-markdown-heading-text'] ??
          plainText(child, footnoteNumbers),
      );
      outline.push({ id, text: normalizeLabel(text, id), level: child.depth });
    }

    if (outline.length === 0) return;
    const maxLevel = outline.reduce((maximum, heading) => Math.max(maximum, heading.level), 1);

    const structured = structureHeadingSections(tree.children);
    tree.children = [
      elementNode('div', { className: ['markdown-heading-layout'] }, [
        elementNode(
          'nav',
          {
            className: ['markdown-heading-rail'],
            'data-marina-heading-rail': 'true',
            'data-markdown-heading-max-level': maxLevel,
            'aria-label': 'Markdown headings',
          },
          outline.map((heading) =>
            elementNode(
              'a',
              {
                className: ['markdown-heading-rail-link'],
                href: `#${heading.id}`,
                title: heading.text,
                'data-markdown-heading-id': heading.id,
                'data-markdown-heading-level': heading.level,
              },
              [{ type: 'text', value: heading.text }],
            ),
          ),
        ),
        elementNode(
          'div',
          { className: ['markdown-heading-content'], 'data-marina-heading-content': 'true' },
          structured,
        ),
      ]),
    ];
  };
}

/** 单个章节的折叠行数追踪：details 属性引用 + 覆盖范围的首末源码行。 */
interface CollapsedLinesEntry {
  hProperties: Record<string, unknown>;
  startLine: number;
  endLine: number;
}

/**
 * 把平铺的 AST 重组为 H1-H6 全层级嵌套的 details 章节（单调栈）。
 *
 * 规则：标题 T 的章节覆盖其后所有内容，直到遇到 level ≤ T.level 的下一个标题
 * （它属于 T 的祖先或前驱兄弟）。栈保存当前打开的章节链：遇到新标题时弹出
 * 所有 level ≥ 新标题的章节，再把新章节挂到栈顶（无栈则挂根）。
 * 首个标题之前的内容留在根级，不属于任何 section。
 *
 * 重组同时统计每个章节覆盖的源码行数（标题行 → 子树最后一行的行差），写入
 * details 的 data-markdown-heading-collapsed-count。summary 据此渲染
 * “N 行已折叠”提示——折叠态的可感知性不能只靠 13px chevron 的 90° 旋转，
 * 收起量是更重要的 affordance（同 GitHub collapsed lines 提示）。
 */
function structureHeadingSections(children: MarkdownAstNode[]): MarkdownAstNode[] {
  const result: MarkdownAstNode[] = [];
  // 栈元素同时记录章节节点的 heading level，避免从 hProperties 里反解析；
  // entry 指向行数追踪条目（栈上章节的活跃引用）。已弹栈的章节不再吸收
  // 后续内容——它的覆盖范围在边界标题处已经关闭。
  const stack: { node: MarkdownAstNode; level: number; entry: CollapsedLinesEntry }[] = [];
  const tracked: CollapsedLinesEntry[] = [];

  const owner = (): MarkdownAstNode | null => {
    const top = stack[stack.length - 1];
    return top ? top.node : null;
  };

  for (const child of children) {
    if (isHeading(child)) {
      while (stack.length > 0 && stack[stack.length - 1]!.level >= child.depth) {
        stack.pop();
      }
      const section = sectionNode(child);
      const parent = owner();
      if (parent?.children) parent.children.push(section);
      else result.push(section);
      stack.push({
        node: section,
        level: child.depth,
        entry: {
          // 行数提示最终渲染在 summary 里(summary 组件读自身节点属性),
          // 因此挂在 summary 的 hProperties 上而不是 details 的。
          hProperties: (section.children![0]!.data!.hProperties ??= {}),
          startLine: child.position?.start.line ?? 0,
          endLine: child.position?.start.line ?? 0,
        },
      });
      tracked.push(stack[stack.length - 1]!.entry);
      continue;
    }

    const parent = owner();
    if (parent?.children) parent.children.push(child);
    else result.push(child);
    const endLine = child.position?.end.line;
    if (endLine !== undefined && endLine > 0) {
      // 只更新栈上（仍打开）的章节链:它们包含这个子内容。
      for (const frame of stack) {
        if (endLine > frame.entry.endLine) frame.entry.endLine = endLine;
      }
    }
  }

  for (const entry of tracked) {
    const collapsedLines = Math.max(0, entry.endLine - entry.startLine);
    if (collapsedLines >= 1) {
      entry.hProperties['data-markdown-heading-collapsed-count'] = String(collapsedLines);
    }
  }

  return result;
}

function sectionNode(heading: MarkdownAstNode): MarkdownAstNode {
  const id = String(heading.data?.hProperties?.id ?? 'section');
  // isHeading 只保证 depth 是 number；remark 规范内是 1-6，越界值夹回 1 保持类名合法。
  // 走局部变量窄化后再断言字面量联合，避免直接在三元里拿 number 赋 MarkdownHeadingLevel。
  const depth = heading.depth ?? 1;
  const level = (depth >= 1 && depth <= 6 ? depth : 1) as MarkdownHeadingLevel;
  return elementNode(
    'details',
    {
      className: ['markdown-heading-section', `markdown-heading-section-level-${level}`],
      'data-marina-heading-section': 'true',
      'data-markdown-heading-id': id,
      'data-markdown-heading-level': level,
    },
    [
      elementNode(
        'summary',
        {
          className: ['markdown-heading-summary'],
          'data-markdown-heading-id': id,
        },
        [heading],
      ),
    ],
  );
}

function elementNode(
  hName: string,
  hProperties: Record<string, unknown>,
  children: MarkdownAstNode[],
): MarkdownAstNode {
  return {
    type: `marina-${hName}`,
    data: { hName, hProperties },
    children,
  };
}

function isRoot(value: unknown): value is MarkdownAstRoot {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as MarkdownAstNode).type === 'root' &&
    Array.isArray((value as MarkdownAstNode).children)
  );
}

function isHeading(node: MarkdownAstNode): node is MarkdownAstNode & { depth: number } {
  return node.type === 'heading' && typeof node.depth === 'number';
}

function isOutlineHeading(
  node: MarkdownAstNode,
): node is MarkdownAstNode & { depth: MarkdownHeadingLevel } {
  return isHeading(node) && node.depth >= 1 && node.depth <= 6;
}

/** 按文档源顺序遍历所有深度的标题，保证 DOM fallback 与 AST id 去重顺序一致。 */
function walkHeadings(
  node: MarkdownAstNode,
  visit: (heading: MarkdownAstNode & { depth: number }) => void,
): void {
  if (isHeading(node)) visit(node);
  for (const child of node.children ?? []) walkHeadings(child, visit);
}

function collectFootnoteNumbers(root: MarkdownAstNode): Map<string, number> {
  const numbers = new Map<string, number>();
  walkNodes(root, (node) => {
    if (node.type !== 'footnoteReference') return;
    const key = node.identifier ?? node.label;
    if (key && !numbers.has(key)) numbers.set(key, numbers.size + 1);
  });
  return numbers;
}

function walkNodes(node: MarkdownAstNode, visit: (node: MarkdownAstNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walkNodes(child, visit);
}

/** 近似最终可见/可访问标题文字，并把 footnote marker 映射为渲染时的 1-based 序号。 */
function plainText(node: MarkdownAstNode, footnoteNumbers: ReadonlyMap<string, number>): string {
  if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? '';
  if (node.type === 'footnoteReference') {
    const key = node.identifier ?? node.label;
    return key ? String(footnoteNumbers.get(key) ?? key) : '';
  }
  if (node.type === 'break') return ' ';
  if (node.type === 'html') return '';
  if (typeof node.value === 'string') return node.value;
  return (node.children ?? []).map((child) => plainText(child, footnoteNumbers)).join('');
}

function normalizeLabel(text: string, fallback: string): string {
  return text.trim().replace(/\s+/gu, ' ') || fallback;
}
