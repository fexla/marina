/**
 * @file src/renderer/mobile.ts
 * @purpose 移动端(Android WebView 壳,ADR-042)的响应式判定 + 软键盘视口适配。
 *   共享 renderer 在窄屏或「横屏矮窗」走抽屉侧栏布局 —— 断点与
 *   apps/mobile/src/mobile.css 的媒体查询保持一致(两处同步维护)。
 *
 * @关键设计:
 * - 桌面 Electron 窗口同样命中断点时也走移动布局(响应式语义与 CSS 媒体查询
 *   一致;把桌面窗口缩到极窄时抽屉化反而是合理行为)。
 * - useSyncExternalStore:matchMedia 变化时重渲染,SSR/无 window 环境返回 false。
 * - useMobileViewportFix:Android WebView 沉浸模式下系统不 resize layout
 *   viewport(实测 innerHeight 恒 914,visualViewport 被键盘压到 537),必须
 *   自己把 visualViewport.height 写成 CSS 变量供布局消费,否则软键盘弹起时
 *   终端输入行被键盘盖住(2026-09-14 真机确认)。
 *
 * @不要在这里做的事:
 * - 不要在这里堆更多「移动端行为开关」(那属于具体组件;本文件只回答
 *   「现在是不是移动布局」「软键盘占掉多少视口」这两个事实问题)
 */

import { useEffect } from 'react';
import { useSyncExternalStore } from 'react';

/**
 * 移动布局断点:
 * 1. max-width: 900px —— 竖屏手机 / 竖屏平板;
 * 2. (max-height: 500px) and (orientation: landscape) —— 横屏手机(如
 *    914x411)。不命中此条时横屏手机会落进桌面布局,侧栏常驻 280px 挤压
 *    终端(2026-09-14 真机确认);平板横屏(高 > 500)保持桌面布局。
 */
const QUERY = '(max-width: 900px), (max-height: 500px) and (orientation: landscape)';

const media =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(QUERY)
    : null;

function subscribe(callback: () => void): () => void {
  media?.addEventListener('change', callback);
  return () => media?.removeEventListener('change', callback);
}

/** 当前视口是否走移动布局(抽屉侧栏/底部辅助键条)。断点与 mobile.css 同步维护。 */
export function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => media?.matches ?? false,
    () => false,
  );
}

/**
 * 软键盘视口适配。仅移动布局下激活:
 * - 把 visualViewport.height 写到 :root 的 --marina-mobile-vh(mobile.css 里
 *   .app-body.mobile 用它作为高度,键盘弹起时整个应用压到键盘上沿);
 * - 键盘开/关(innerHeight 与 visualViewport.height 差 > 120px,阈值躲开
 *   系统手势条/圆角的几十像素偏差)时给 <html> 挂/摘 .mobile-keyboard-open
 *   类 —— 供 CSS 隐藏浮球等不适合浮在键盘上的元素。
 *
 * 同时监听 resize + scroll:Android 键盘弹出伴随 visualViewport 滚动,
 * 只听 resize 会漏掉半开状态。
 */
export function useMobileViewportFix(isMobile: boolean): void {
  useEffect(() => {
    if (!isMobile) return;
    const vv = window.visualViewport;
    // 桌面 Electron 没有 visualViewport(或不可信),保持原布局。
    if (!vv) return;

    const apply = (): void => {
      const keyboardOpen = window.innerHeight - vv.height > 120;
      document.documentElement.classList.toggle('mobile-keyboard-open', keyboardOpen);
      document.documentElement.style.setProperty('--marina-mobile-vh', `${vv.height}px`);
    };
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    apply();
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
      document.documentElement.classList.remove('mobile-keyboard-open');
      document.documentElement.style.removeProperty('--marina-mobile-vh');
    };
  }, [isMobile]);
}
