/**
 * @file src/renderer/hooks/useMarkdownSearch.ts
 * @purpose markdown 渲染后的 DOM 文本节点查找(CSS Custom Highlight API)。
 *
 * @关键设计:
 * - markdown 渲染后是 HTML(非源码行),不能按行查找。用 TreeWalker 遍历所有
 *   文本节点,对匹配区间创建 Range。
 * - 高亮用 CSS Custom Highlight API(::highlight(name)),不改 DOM → 不和 React
 *   重渲染冲突。Chromium 105+ 支持(Marina Electron 31 / Chromium 126 ✅)。
 * - 两个 Highlight registry:
 *     · marina-md-search:所有匹配(淡色底)
 *     · marina-md-search-current:当前聚焦(深色底,scrollIntoView 目标)
 * - 协议同 useContentSearch:监听 marina:panel-search-navigate,
 *   汇报 marina:panel-search-result。
 *
 * @降级:CSS.highlights 不支持时(理论上不会,Electron 31 足够新),只 scrollIntoView,
 *   不高亮。功能不残缺。
 *
 * @对应文档:docs/方案-面板Ctrl-F搜索-20260719.md §3.3B markdown
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import { findMatches } from '@shared/text-search';

interface UseMarkdownSearchParams {
  sessionId: string;
  /** 渲染容器 ref(ReactMarkdown 输出的根)。 */
  containerRef: RefObject<HTMLElement | null>;
  query: string;
  caseSensitive: boolean;
  active: boolean;
  /** 容器内容变化的"版本号"(markdown 重新渲染时递增,触发重算匹配)。 */
  contentVersion: unknown;
}

export function useMarkdownSearch({
  sessionId,
  containerRef,
  query,
  caseSensitive,
  active,
  contentVersion,
}: UseMarkdownSearchParams): void {
  const [currentIndex, setCurrentIndex] = useState(0);
  // ranges 用 ref(不触发渲染,DOM 定位用)。navigate 时改 currentIndex 触发 effect。
  const rangesRef = useRef<Range[]>([]);

  const effectiveQuery = active && query.length > 0 ? query : '';

  // 算匹配 Range(query / caseSensitive / 内容 变化时重算)。
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
        // 跳过 script/style/代码块(可选:代码块也搜?当前搜,保持简单)
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style') return NodeFilter.FILTER_REJECT;
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
  }, [effectiveQuery, caseSensitive, contentVersion, containerRef]);

  // 汇报 matches/current 给 LayoutHost(SearchBar x/N)。
  useEffect(() => {
    if (!active) return;
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
    if (all) CSSH.set('marina-md-search', all);
    else CSSH.delete('marina-md-search');
    const cur =
      currentIndex >= 0 && ranges[currentIndex]
        ? new (H as new (...r: Range[]) => object)(ranges[currentIndex])
        : null;
    if (cur) CSSH.set('marina-md-search-current', cur);
    else CSSH.delete('marina-md-search-current');
  } catch {
    /* Highlight 构造/注册失败 → 静默,查找仍可 scrollIntoView */
  }
}

function clearHighlights(): void {
  const CSSH = (CSS as { highlights?: Map<string, unknown> }).highlights;
  if (!CSSH) return;
  CSSH.delete('marina-md-search');
  CSSH.delete('marina-md-search-current');
}

function scrollToRange(range: Range | undefined): void {
  if (!range) return;
  // scrollIntoView 对 Range 的支持:getBoundingClientRect 拿位置后 scroll。
  const rect = range.getBoundingClientRect();
  if (rect.top === 0 && rect.height === 0) return; // 空 range
  // 找最近的可滚动祖先,scrollIntoView center。
  try {
    range.startContainer.parentElement?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
  } catch {
    /* ignore */
  }
}
