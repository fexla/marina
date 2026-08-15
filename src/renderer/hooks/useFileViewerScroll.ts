/**
 * @file useFileViewerScroll.ts
 * @purpose 保存/恢复右侧文件预览的真实 DOM scrollTop/scrollLeft。
 *
 * @关键设计:
 * - 位置是一等 renderer view state,写入 AppState.fileViewerScroll；不用模块级 Map。
 * - identity = sessionId + OpenedFile.path + kind。切文件/面板/session remount 后恢复。
 * - scroll 事件 120ms trailing debounce,unmount/identity 变化立即 flush。
 * - 异步内容用双 RAF + ResizeObserver fence；当前内容太短时等待布局增长(最多 4s)。
 * - wheel/mouse/touch/key、非空搜索或标题导航出现后取消待恢复，绝不和新的
 *   scrollIntoView 抢；标题跳转在下一帧反写当前位置，watcher 刷新也不会回到旧位置。
 *
 * @不要在这里做的事:
 * - 不持久化到 localStorage/main；这是重启可丢的 L1 工作态。
 * - 不规范化 path；OpenedFile.path 是 main 的唯一身份。
 * - 不保存 Markdown 内每个 pre/table 的局部横向滚动。
 */
import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { FileKind } from '@shared/types';
import { useAppDispatch, useAppStateRef } from '../store';

const SAVE_DEBOUNCE_MS = 120;
const RESTORE_DEADLINE_MS = 4000;

/** Markdown 外部标题跳转在 scrollIntoView 前发出，显式取消仍在等待布局的旧位置恢复。 */
export const FILE_VIEWER_PROGRAMMATIC_NAVIGATION_EVENT =
  'marina:file-viewer-programmatic-navigation';

export interface FileViewerNavigationResult {
  requestId: string;
  found: boolean;
}

interface UseFileViewerScrollOptions {
  sessionId: string;
  path: string;
  kind: FileKind;
  /** 必须指向真正拥有 overflow 的元素。 */
  scrollRef: RefObject<HTMLElement | null>;
  /** 内容尺寸变化的观察目标；省略时观察 scroll element 自身。 */
  layoutRef?: RefObject<HTMLElement | null>;
  /** 内容/图片已可布局。false 时不监听、不恢复。 */
  ready: boolean;
  /** mtime/content generation；变化时重新执行恢复 fence。 */
  restoreVersion: unknown;
  /** 非空搜索正在主导 scrollIntoView 时不恢复旧位置。 */
  searchActive?: boolean;
  /** 当前一次性标题请求。只有 resultRef 确认命中后才可压制旧位置恢复。 */
  navigationRequestId?: string;
  /** 子 MarkdownDocument 在自己的 layout effect 中同步写入命中结果。 */
  navigationResultRef?: RefObject<FileViewerNavigationResult | null>;
  /** Diff 用于把 gutter.scrollTop 同步到恢复后的 body。 */
  onApply?: (scrollTop: number, scrollLeft: number) => void;
}

export function useFileViewerScroll({
  sessionId,
  path,
  kind,
  scrollRef,
  layoutRef,
  ready,
  restoreVersion,
  searchActive = false,
  navigationRequestId,
  navigationResultRef,
  onApply,
}: UseFileViewerScrollOptions): void {
  const dispatch = useAppDispatch();
  const stateRef = useAppStateRef();
  const onApplyRef = useRef(onApply);
  onApplyRef.current = onApply;
  const navigationRestoreBlockRef = useRef<{
    sessionId: string;
    path: string;
    kind: FileKind;
    restoreVersion: unknown;
  } | null>(null);
  const existingBlock = navigationRestoreBlockRef.current;
  if (
    existingBlock &&
    (existingBlock.sessionId !== sessionId ||
      existingBlock.path !== path ||
      existingBlock.kind !== kind ||
      !Object.is(existingBlock.restoreVersion, restoreVersion))
  ) {
    navigationRestoreBlockRef.current = null;
  }

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return undefined;
    if (!ready) {
      // 同一个外层 scroller 会复用给不同 Markdown/Image 文件。上一 identity 的
      // layout cleanup 已在本 callback 之前 flush；loading 期立即归零，防止新文件
      // 首次挂载时继承旧文件 DOM 的 scrollTop。
      element.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      return undefined;
    }

    const navigationResult = navigationResultRef?.current;
    if (navigationRequestId !== undefined && navigationResult?.requestId === navigationRequestId) {
      navigationRestoreBlockRef.current = navigationResult.found
        ? { sessionId, path, kind, restoreVersion }
        : null;
    }
    const navigationOwnsInitialScroll =
      navigationRestoreBlockRef.current?.sessionId === sessionId &&
      navigationRestoreBlockRef.current.path === path &&
      navigationRestoreBlockRef.current.kind === kind &&
      Object.is(navigationRestoreBlockRef.current.restoreVersion, restoreVersion);

    let disposed = false;
    let userIntervened = false;
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    let restoreFrame1: number | null = null;
    let restoreFrame2: number | null = null;
    let restoreTimer: ReturnType<typeof setTimeout> | null = null;
    let settleFrame: number | null = null;
    let observer: ResizeObserver | null = null;
    let latest: { scrollTop: number; scrollLeft: number } | null = null;
    // identity 切换时，旧容器的异步 scroll 事件可能落到新 effect。至少等双 RAF
    // fence 完成；有 saved target 时等 restore scroll 事件过一帧后才开放 capture。
    let suppressAutomaticScroll = true;
    // scrollTo 产生的 scroll 事件是异步的。记录目标坐标，capture 据此区分
    // “恢复动作”与用户/搜索真实滚动，避免布局尚短时把 saved=1000 覆盖成 clamp=200。
    let programmaticRestore: { scrollTop: number; scrollLeft: number } | null = null;

    const flush = (): void => {
      if (!latest) return;
      dispatch({
        type: 'view/file-viewer-scroll',
        sessionId,
        path,
        kind,
        scrollTop: latest.scrollTop,
        scrollLeft: latest.scrollLeft,
      });
      latest = null;
    };

    const capture = (): void => {
      const observed = {
        scrollTop: Math.max(0, element.scrollTop),
        scrollLeft: Math.max(0, element.scrollLeft),
      };
      const matchesRestore =
        programmaticRestore !== null &&
        Math.abs(observed.scrollTop - programmaticRestore.scrollTop) <= 1 &&
        Math.abs(observed.scrollLeft - programmaticRestore.scrollLeft) <= 1;
      if (suppressAutomaticScroll || matchesRestore) {
        if (matchesRestore) programmaticRestore = null;
        return;
      }
      programmaticRestore = null;
      latest = observed;
      if (saveTimer !== null) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = null;
        flush();
      }, SAVE_DEBOUNCE_MS);
    };

    const cancelPendingRestore = (): void => {
      userIntervened = true;
      suppressAutomaticScroll = false;
      programmaticRestore = null;
      observer?.disconnect();
      observer = null;
      if (restoreTimer !== null) {
        clearTimeout(restoreTimer);
        restoreTimer = null;
      }
    };

    const releaseAutomaticScrollSuppression = (captureCurrent = false): void => {
      if (settleFrame !== null) cancelAnimationFrame(settleFrame);
      // scrollTo 的原生 scroll 事件在下一 animation frame 前派发；再开放 capture
      // 可避免 A 的尾部事件被复用同一 outer element 的 B effect 当成用户滚动。
      settleFrame = requestAnimationFrame(() => {
        settleFrame = null;
        suppressAutomaticScroll = false;
        programmaticRestore = null;
        if (captureCurrent) {
          // 初次 mount 时子组件的标题 layout effect 早于本 hook，事件监听尚未安装。
          // 下一帧直接采样最终坐标并同步 L1，后续 watcher generation 只会恢复这里。
          latest = {
            scrollTop: Math.max(0, element.scrollTop),
            scrollLeft: Math.max(0, element.scrollLeft),
          };
          flush();
        }
      });
    };

    element.addEventListener('scroll', capture, { passive: true });
    for (const eventName of ['wheel', 'mousedown', 'touchstart', 'keydown'] as const) {
      element.addEventListener(eventName, cancelPendingRestore, { passive: true });
    }
    element.addEventListener(FILE_VIEWER_PROGRAMMATIC_NAVIGATION_EVENT, cancelPendingRestore);

    if (searchActive || navigationOwnsInitialScroll) {
      // 搜索的 smooth scroll 在 passive effect 后跨多帧发生。标题导航则可能在本
      // parent layout effect 安装监听前已完成，因此下一帧主动采样其最终位置。
      releaseAutomaticScrollSuppression(navigationOwnsInitialScroll);
    } else {
      const deadline = Date.now() + RESTORE_DEADLINE_MS;
      const apply = (): void => {
        if (disposed || userIntervened) return;
        // 在 fence 当下读 live store；旧 viewer cleanup 可能晚于新 viewer render。
        const saved = stateRef.current.fileViewerScroll.get(sessionId)?.get(path);
        if (!saved || saved.kind !== kind) {
          observer?.disconnect();
          observer = null;
          if (restoreTimer !== null) clearTimeout(restoreTimer);
          restoreTimer = null;
          releaseAutomaticScrollSuppression();
          return;
        }
        const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
        const maxLeft = Math.max(0, element.scrollWidth - element.clientWidth);
        const targetTop = Math.min(saved.scrollTop, maxTop);
        const targetLeft = Math.min(saved.scrollLeft, maxLeft);
        programmaticRestore = { scrollTop: targetTop, scrollLeft: targetLeft };
        element.scrollTo({ top: targetTop, left: targetLeft, behavior: 'auto' });
        onApplyRef.current?.(targetTop, targetLeft);

        const reached = saved.scrollTop <= maxTop + 1 && saved.scrollLeft <= maxLeft + 1;
        if (reached || Date.now() >= deadline) {
          observer?.disconnect();
          observer = null;
          if (restoreTimer !== null) clearTimeout(restoreTimer);
          restoreTimer = null;
          releaseAutomaticScrollSuppression();
        }
      };

      restoreFrame1 = requestAnimationFrame(() => {
        restoreFrame2 = requestAnimationFrame(() => {
          if (disposed || userIntervened) return;
          const observed = layoutRef?.current ?? element;
          observer = new ResizeObserver(apply);
          observer.observe(observed);
          restoreTimer = setTimeout(apply, RESTORE_DEADLINE_MS);
          apply();
        });
      });
    }

    return () => {
      disposed = true;
      element.removeEventListener('scroll', capture);
      for (const eventName of ['wheel', 'mousedown', 'touchstart', 'keydown'] as const) {
        element.removeEventListener(eventName, cancelPendingRestore);
      }
      element.removeEventListener(FILE_VIEWER_PROGRAMMATIC_NAVIGATION_EVENT, cancelPendingRestore);
      observer?.disconnect();
      if (restoreFrame1 !== null) cancelAnimationFrame(restoreFrame1);
      if (restoreFrame2 !== null) cancelAnimationFrame(restoreFrame2);
      if (restoreTimer !== null) clearTimeout(restoreTimer);
      if (settleFrame !== null) cancelAnimationFrame(settleFrame);
      if (saveTimer !== null) clearTimeout(saveTimer);
      // 不重读 DOM：mutation 可能已把复用容器 clamp 到 0。只有真实 scroll
      // capture 留下的 pending 值需要立即 flush；已 debounce 的值早已在 store。
      flush();
    };
  }, [
    dispatch,
    kind,
    layoutRef,
    navigationRequestId,
    navigationResultRef,
    path,
    ready,
    restoreVersion,
    scrollRef,
    searchActive,
    sessionId,
    stateRef,
  ]);
}
