/**
 * @file src/renderer/hooks/useDomTextHighlight.ts
 * @purpose 通用「渲染后 DOM 文本查找」hook,用 CSS Custom Highlight API 高亮匹配。
 *
 * @为什么有这个 hook(v0.3.2 / ADR-019):
 *   v0.3.1 有两套查找:useContentSearch(行级 findLineMatches,TextViewer/DiffViewer 用)
 *   + useMarkdownSearch(DOM TreeWalker,MarkdownViewer 用)。v0.3.2 TextViewer 要加
 *   hljs 语法高亮 —— hljs 输出嵌套 span HTML,和行内 <mark> 叠加正是 DiffViewer
 *   当初「行内 mark 不做」的根因。改用 CSS Custom Highlight(DOM 不插 mark,overlay
 *   画高亮)就彻底绕过 span 嵌套问题,且三 viewer(text/diff/markdown)机制统一。
 *
 * @工作原理:
 * - TreeWalker 遍历 containerRef 内所有文本节点(跳过 script/style/skipSelector),
 *   对每个文本节点用 findMatches 找 query 子串,建 Range(单节点内)。
 * - 把所有 Range 注册成 Highlight「marina-viewer-search」(所有匹配,淡底)。
 * - 当前聚焦的 Range 单独注册「marina-viewer-search-current」(深底 + scrollIntoView)。
 * - 监听 marina:panel-search-navigate(LayoutHost SearchBar 上/下)→ current ±1(环形)。
 * - 汇报 marina:panel-search-result 给 LayoutHost(更新 x/N)。
 *
 * @为什么 DOM 上找而非行级文本上找:
 *   hljs 高亮后,一行的字符可能分散在多个 <span> 文本节点里。直接在渲染后 DOM 上
 *   找,天然适配任意 HTML 结构(代码 token / markdown 渲染树),一套逻辑通吃。
 *   极端情况(匹配正好跨 token 边界 = 跨两个文本节点)会拆成两个相邻 Range,仍能高亮,
 *   只是 current 跳转精度在边界处略有偏差 —— 实际无感。
 *
 * @降级:CSS.highlights 不支持时(理论不会,Electron 31 / Chromium 126 ✅),只 scrollIntoView
 *   不高亮,功能不残缺。
 *
 * @对应文档:docs/方案-面板待办-20260719.md A1/A2、docs/方案-面板Ctrl-F搜索-20260719.md
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import { findMatches } from '@shared/text-search';

/** 所有匹配的 Highlight 名(淡底色)。 */
const HIGHLIGHT_ALL = 'marina-viewer-search';
/** 当前聚焦的 Highlight 名(深底色 + scroll 目标)。 */
const HIGHLIGHT_CURRENT = 'marina-viewer-search-current';

interface UseDomTextHighlightParams {
  sessionId: string;
  /** 渲染容器 ref(text/diff/markdown viewer 的根)。 */
  containerRef: RefObject<HTMLElement | null>;
  query: string;
  caseSensitive: boolean;
  active: boolean;
  /** 容器内容变化的「版本号」(内容重渲染时变,触发重算匹配)。 */
  contentVersion: unknown;
  /**
   * 跳过搜索的元素选择器:这些元素内的文本不参与查找(如行号槽、diff 行首 +/- 符号)。
   * TreeWalker 遇到其子节点时 REJECT。undefined = 只跳 script/style。
   */
  skipSelector?: string;
}

export function useDomTextHighlight({
  sessionId,
  containerRef,
  query,
  caseSensitive,
  active,
  contentVersion,
  skipSelector,
}: UseDomTextHighlightParams): void {
  const [currentIndex, setCurrentIndex] = useState(0);
  // ranges 用 ref(不触发渲染,DOM 定位用)。navigate 时改 currentIndex 触发 effect。
  const rangesRef = useRef<Range[]>([]);

  const effectiveQuery = active && query.length > 0 ? query : '';

  // 算匹配 Range(query / caseSensitive / 内容 / skipSelector 变化时重算)。
  useEffect(() => {
    const container = containerRef.current;
    rangesRef.current = [];
    if (!container || !effectiveQuery) {
      clearHighlights();
      setCurrentIndex(0);
      return;
    }
    const ranges: Range[] = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style') return NodeFilter.FILTER_REJECT;
        // 跳过行号槽 / diff 符号等「非内容」文本(它们不应参与查找,否则会误匹配)。
        if (skipSelector && parent.closest(skipSelector)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = node.textContent ?? '';
      for (const [start, end] of findMatches(text, effectiveQuery, caseSensitive)) {
        try {
          const r = new Range();
          r.setStart(node, start);
          r.setEnd(node, end);
          ranges.push(r);
        } catch {
          // 越界(setStart/end 超过 node 长度)→ 跳过这个匹配,防御性。
        }
      }
    }
    rangesRef.current = ranges;
    setCurrentIndex(0);
    applyHighlights(ranges, 0);
  }, [effectiveQuery, caseSensitive, contentVersion, containerRef, skipSelector]);

  // 汇报 matches/current 给 LayoutHost(SearchBar x/N)。
  useEffect(() => {
    if (!active) return; // 关闭时不汇报(LayoutHost 自己清零)
    const len = rangesRef.current.length;
    window.dispatchEvent(
      new CustomEvent('marina:panel-search-result', {
        detail: { sessionId, matches: len, current: len === 0 ? 0 : currentIndex + 1 },
      }),
    );
  }, [active, sessionId, currentIndex, effectiveQuery, contentVersion]);

  // 监听导航(LayoutHost SearchBar 上/下)。
  useEffect(() => {
    const onNavigate = (e: Event): void => {
      const detail = (e as CustomEvent<{ sessionId: string; direction: 'next' | 'previous' }>)
        .detail;
      if (!detail || detail.sessionId !== sessionId) return;
      const len = rangesRef.current.length;
      if (len === 0) return;
      setCurrentIndex((prev) => {
        const next = detail.direction === 'next' ? (prev + 1) % len : (prev - 1 + len) % len;
        applyHighlights(rangesRef.current, next);
        scrollToRange(rangesRef.current[next]);
        return next;
      });
    };
    window.addEventListener('marina:panel-search-navigate', onNavigate);
    return () => window.removeEventListener('marina:panel-search-navigate', onNavigate);
  }, [sessionId]);

  // current 变化 → scrollIntoView(初次算匹配时也滚到第一个)。
  useEffect(() => {
    if (!effectiveQuery) return;
    const ranges = rangesRef.current;
    if (ranges.length === 0) return;
    scrollToRange(ranges[currentIndex] ?? ranges[0]);
  }, [currentIndex, effectiveQuery]);

  // 卸载时清理高亮,避免泄漏。
  useEffect(() => {
    return () => clearHighlights();
  }, []);
}

/** 把所有匹配 + 当前注册到 CSS Custom Highlight。 */
function applyHighlights(ranges: Range[], currentIndex: number): void {
  const H = (globalThis as { Highlight?: unknown }).Highlight;
  const CSSH = (CSS as { highlights?: Map<string, unknown> }).highlights;
  if (typeof H === 'undefined' || !CSSH) return; // 不支持 → 不高亮,不报错
  try {
    const all = ranges.length > 0 ? new (H as new (...r: Range[]) => object)(...ranges) : null;
    if (all) CSSH.set(HIGHLIGHT_ALL, all);
    else CSSH.delete(HIGHLIGHT_ALL);
    const cur =
      currentIndex >= 0 && ranges[currentIndex]
        ? new (H as new (...r: Range[]) => object)(ranges[currentIndex])
        : null;
    if (cur) CSSH.set(HIGHLIGHT_CURRENT, cur);
    else CSSH.delete(HIGHLIGHT_CURRENT);
  } catch {
    /* Highlight 构造/注册失败 → 静默,查找仍可 scrollIntoView */
  }
}

function clearHighlights(): void {
  const CSSH = (CSS as { highlights?: Map<string, unknown> }).highlights;
  if (!CSSH) return;
  CSSH.delete(HIGHLIGHT_ALL);
  CSSH.delete(HIGHLIGHT_CURRENT);
}

function scrollToRange(range: Range | undefined): void {
  if (!range) return;
  try {
    range.startContainer.parentElement?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
  } catch {
    /* ignore */
  }
}
