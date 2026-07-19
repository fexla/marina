/**
 * @file src/renderer/hooks/useContentSearch.ts
 * @purpose 文件内查找的协调 hook:算匹配行 + 维护 current + 导航事件 + scrollIntoView。
 *
 * @关键设计:
 * - 匹配算法在 shared/find-line-matches(单测覆盖),本 hook 只做 wiring。
 * - current 索引(0..matches-1)随 query 变化重置为 0(从头开始)。
 * - 导航通过 window CustomEvent「marina:panel-search-navigate」触发(LayoutHost
 *   SearchBar 的上/下按钮 dispatch);本 hook 监听 → current ± 1(环形)。
 * - 匹配结果通过「marina:panel-search-result」汇报给 LayoutHost(更新 x/N 显示)。
 * - scrollIntoView:当 current 变化,定位到 container 内 [data-line="N"] 元素。
 *
 * @不在这里做的事:
 * - 不做行内高亮渲染(那在 viewer,用 highlightSegments + matchLineMap)
 * - 不做正则(对齐终端)
 *
 * @对应文档:docs/方案-面板Ctrl-F搜索-20260719.md §3.3B
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { findLineMatches, type LineMatch } from '@shared/find-line-matches';

interface UseContentSearchParams {
  sessionId: string;
  /** 滚动容器的 ref(查找的行在这个容器内)。 */
  containerRef: RefObject<HTMLElement | null>;
  /** 文件按行切分(0-based 索引 = 行号)。 */
  lines: readonly string[];
  /** 查询串(空 = 不查找)。 */
  query: string;
  caseSensitive: boolean;
  /** 搜索栏是否激活(关闭时不查找,清状态)。 */
  active: boolean;
}

export interface ContentSearchResult {
  /** 匹配行列表(供 viewer 渲染行内高亮)。 */
  matches: LineMatch[];
  /** 当前聚焦的匹配行(0..matches.length-1),无匹配时 -1。 */
  currentIndex: number;
}

export function useContentSearch({
  sessionId,
  containerRef,
  lines,
  query,
  caseSensitive,
  active,
}: UseContentSearchParams): ContentSearchResult {
  // 只有 active + 非空 query 才算匹配(避免无谓计算)。
  const effectiveQuery = active && query.length > 0 ? query : '';
  const matches = useMemo(
    () => findLineMatches(lines, effectiveQuery, caseSensitive),
    [lines, effectiveQuery, caseSensitive],
  );
  // current 索引:query 变化时重置为 0(effectiveQuery 在依赖里,变化即重置)。
  const [currentIndex, setCurrentIndex] = useState(0);
  useEffect(() => {
    setCurrentIndex(0);
  }, [effectiveQuery, caseSensitive]);

  // 汇报 matches/current 给 LayoutHost(SearchBar 显示 x/N)。
  useEffect(() => {
    if (!active) return; // 关闭时不汇报(LayoutHost 自己清零)
    window.dispatchEvent(
      new CustomEvent('marina:panel-search-result', {
        detail: {
          sessionId,
          matches: matches.length,
          // 无匹配时 current 显示 0(避免显示 -1/0);有匹配时 1-based
          current: matches.length === 0 ? 0 : currentIndex + 1,
        },
      }),
    );
  }, [active, sessionId, matches.length, currentIndex]);

  // 监听导航事件(LayoutHost SearchBar 上/下 dispatch)。
  // 用 ref 读最新 matches.length(避免 effect 频繁重订阅)。
  const matchesLenRef = useRef(matches.length);
  matchesLenRef.current = matches.length;
  useEffect(() => {
    const onNavigate = (e: Event): void => {
      const detail = (e as CustomEvent<{ sessionId: string; direction: 'next' | 'previous' }>)
        .detail;
      if (!detail || detail.sessionId !== sessionId) return;
      const len = matchesLenRef.current;
      if (len === 0) return;
      setCurrentIndex((prev) => {
        if (detail.direction === 'next') return (prev + 1) % len;
        return (prev - 1 + len) % len;
      });
    };
    window.addEventListener('marina:panel-search-navigate', onNavigate);
    return () => window.removeEventListener('marina:panel-search-navigate', onNavigate);
  }, [sessionId]);

  // 当前匹配变化 → scrollIntoView。behavior=smooth 提升跳转体感(VS Code 同款)。
  useEffect(() => {
    if (matches.length === 0) return;
    const target = matches[currentIndex];
    if (!target) return;
    const container = containerRef.current;
    if (!container) return;
    const el = container.querySelector(`[data-line="${target.lineIndex}"]`);
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [matches, currentIndex, containerRef]);

  return {
    matches,
    currentIndex: matches.length === 0 ? -1 : currentIndex,
  };
}
