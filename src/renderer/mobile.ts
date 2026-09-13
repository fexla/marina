/**
 * @file src/renderer/mobile.ts
 * @purpose 移动端(Android WebView 壳,ADR-042)的响应式判定 hook。共享 renderer
 *   在窄屏(< 900px)走抽屉侧栏布局 —— 断点与 apps/mobile/src/mobile.css 的
 *   媒体查询保持一致。
 *
 * @关键设计:
 * - 桌面 Electron 窗口同样命中此断点时也走移动布局(响应式语义与 CSS 媒体查询
 *   一致;把桌面窗口缩到极窄时抽屉化反而是合理行为)。
 * - useSyncExternalStore:matchMedia 变化时重渲染,SSR/无 window 环境返回 false。
 *
 * @不要在这里做的事:
 * - 不要在这里堆更多「移动端行为开关」(那属于具体组件;本文件只回答
 *   「现在是不是窄屏」这一个事实问题)
 */

import { useSyncExternalStore } from 'react';

const QUERY = '(max-width: 900px)';

const media =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(QUERY)
    : null;

function subscribe(callback: () => void): () => void {
  media?.addEventListener('change', callback);
  return () => media?.removeEventListener('change', callback);
}

/** 当前视口是否为窄屏(移动布局)。断点 900px,与 mobile.css 同步维护。 */
export function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => media?.matches ?? false,
    () => false,
  );
}
