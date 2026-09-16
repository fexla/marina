/**
 * @file src/renderer/mobile.ts
 * @purpose 移动端(Android WebView 壳,ADR-042)的响应式判定 + 软键盘视口
 *   适配 + 三页手势导航(左栏 / 终端 / 右面板,用户裁决 2026-09-14)。
 *
 * @布局判定(用户裁决 2026-09-14「平板交互」):
 * - 原生壳(有 MarinaNative 桥)里**方向就是布局**:竖屏 = 移动布局
 *   (三页手势,同手机),横屏 = 桌面布局(三栏,同 PC)。不按宽度判 ——
 *   平板竖屏 CSS 宽可到 900+(如 Pixel Tablet ~915px),宽度断点够不到。
 * - 非原生(桌面 Electron 窗口 / 手机浏览器)按宽度断点:窄屏或
 *   「横屏矮窗」走移动布局。桌面窗口缩到极窄抽屉化是合理行为。
 * - CSS 侧(apps/mobile/src/mobile.css)不再自带媒体查询门,统一消费
 *   useMobileLayoutClass 挂的 html.marina-mobile 类 —— 判定单源在此,
 *   旋转 / 缩放窗口时类和 JS 布局分支同帧翻转。
 *
 * @关键设计:
 * - useSyncExternalStore:matchMedia 变化时重渲染,SSR/无 window 环境返回 false。
 * - useMobileViewportFix:Android WebView 沉浸模式下系统不 resize layout
 *   viewport(实测 innerHeight 恒 914,visualViewport 被键盘压到 537),必须
 *   自己把 visualViewport.height 写成 CSS 变量供布局消费,否则软键盘弹起时
 *   终端输入行被键盘盖住(2026-09-14 真机确认)。原生壳里横屏(桌面布局)
 *   也启用 —— 软键盘照样弹,输入行照样要避让。
 *
 * @不要在这里做的事:
 * - 不要在这里实现具体 UI 的切换逻辑(那属于 App/LayoutHost;本文件只提供
 *   「水平滑动手势」的检测原语)
 */

import { useEffect } from 'react';
import { useSyncExternalStore } from 'react';

/**
 * 是否运行在 Android 原生壳(MainActivity 注入的 MarinaNative JS 桥)。
 * 用它而不是 Capacitor 全局对象:这是我们自己的桥,壳里必然存在、
 * 壳外(桌面 Electron / 手机浏览器)必然不存在;且类型不依赖 Capacitor 包。
 */
export function isNativeShell(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as { MarinaNative?: unknown }).MarinaNative !== 'undefined'
  );
}

/**
 * 非原生环境的宽度断点(原生壳不用,见文件头):
 * 1. max-width: 900px —— 窄窗口 / 竖屏手机浏览器;
 * 2. (max-height: 500px) and (orientation: landscape) —— 横屏手机浏览器
 *    (如 914x411),否则会落进桌面布局,侧栏常驻 280px 挤压终端。
 */
const WIDTH_QUERY = '(max-width: 900px), (max-height: 500px) and (orientation: landscape)';
const PORTRAIT_QUERY = '(orientation: portrait)';

const widthMedia =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(WIDTH_QUERY)
    : null;
const portraitMedia =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(PORTRAIT_QUERY)
    : null;

function subscribe(callback: () => void): () => void {
  widthMedia?.addEventListener('change', callback);
  portraitMedia?.addEventListener('change', callback);
  return () => {
    widthMedia?.removeEventListener('change', callback);
    portraitMedia?.removeEventListener('change', callback);
  };
}

/**
 * 当前视口是否走移动布局(抽屉侧栏/底部辅助键条/三页手势)。
 * 判定双源见文件头:原生壳 = 方向,其余 = 宽度断点。
 */
export function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => {
      if (isNativeShell()) return portraitMedia?.matches ?? false;
      return widthMedia?.matches ?? false;
    },
    () => false,
  );
}

/**
 * 把「移动布局」落到 <html> 的 marina-mobile 类上 —— mobile.css 全部
 * 移动适配规则以这个类为门(不再用媒体查询,见文件头)。App 层调用一次,
 * 和 useIsMobile 同源,旋转 / 缩放时同步翻转。
 */
export function useMobileLayoutClass(isMobile: boolean): void {
  useEffect(() => {
    document.documentElement.classList.toggle('marina-mobile', isMobile);
  }, [isMobile]);
}

/**
 * 订阅移动端视口变化(键盘开合 + 高度),基线判定逻辑的唯一实现。
 * useMobileViewportFix(App 层)与 TerminalView(键盘弹起滚到底)共用,
 * 避免两处各判各的漂移。返回取消订阅函数。
 */
export function subscribeMobileViewport(handlers: {
  onHeight: (height: number) => void;
  onKeyboardOpen: (open: boolean) => void;
}): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  let baseline: number | null = null;
  const orientationMedia = window.matchMedia('(orientation: landscape)');

  const apply = (): void => {
    if (baseline === null || vv.height > baseline) baseline = vv.height;
    const keyboardOpen = baseline !== null && baseline - vv.height > Math.max(120, baseline * 0.15);
    handlers.onKeyboardOpen(keyboardOpen);
    handlers.onHeight(vv.height);
  };
  const resetBaseline = (): void => {
    baseline = null;
  };

  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  orientationMedia.addEventListener('change', resetBaseline);
  apply();
  return () => {
    vv.removeEventListener('resize', apply);
    vv.removeEventListener('scroll', apply);
    orientationMedia.removeEventListener('change', resetBaseline);
  };
}

/**
 * 软键盘视口适配。移动布局 + 原生壳横屏(桌面布局)都激活 —— 软键盘
 * 两种布局下都会弹,输入行都要避让:
 * - 把 visualViewport.height 写到 :root 的 --marina-mobile-vh(mobile.css 里
 *   app-body 用它作为高度,键盘弹起时整个应用压到键盘上沿);
 * - 键盘开/关时给 <html> 挂/摘 .mobile-keyboard-open 类 —— 供 CSS 调整
 *   不适合浮在键盘上的元素。
 *
 * 键盘开合判定见 subscribeMobileViewport(基线法,兼容沉浸模式与
 * decorFitsSystemWindows=true 的 resize 模式两种壳行为)。
 */
export function useMobileViewportFix(isMobile: boolean): void {
  useEffect(() => {
    if (!isMobile && !isNativeShell()) return;
    const off = subscribeMobileViewport({
      onHeight: (h) => {
        document.documentElement.style.setProperty('--marina-mobile-vh', `${h}px`);
      },
      onKeyboardOpen: (open) => {
        document.documentElement.classList.toggle('mobile-keyboard-open', open);
      },
    });
    return () => {
      off();
      document.documentElement.classList.remove('mobile-keyboard-open');
      document.documentElement.style.removeProperty('--marina-mobile-vh');
    };
  }, [isMobile]);
}

// ── 三页手势导航(左栏 / 终端 / 右面板)────────────────────────────
//
// 用户裁决(2026-09-14):手机比例下左右栏都全屏;终端为中间态,
// 水平滑动切页(左滑→右面板,右滑→左栏;浮层上反向滑回终端),
// 返回键等价于反向滑。层级表见 docs/standards/mobile-interactions.md。

/**
 * 水平滑动手势检测阈值:
 * - 位移 >= 60px 才算一次滑动(躲开点击抖动);
 * - 水平位移须 > 2 倍垂直位移(与 xterm/文件树的垂直滚动区分);
 * - 时长 <= 600ms(慢速拖拽不算翻页,可能是文本选择/精确操作)。
 */
const SWIPE_MIN_DX = 60;
const SWIPE_MAX_MS = 600;

export interface MobileSwipeCallbacks {
  /** 终端主区(无浮层)手指向左滑 → 打开右侧面板 */
  onMainSwipeLeft?: () => void;
  /** 终端主区手指向右滑 → 打开左侧栏抽屉 */
  onMainSwipeRight?: () => void;
  /** 抽屉内手指向左滑 → 关抽屉回终端 */
  onDrawerSwipeLeft?: () => void;
  /** 右侧面板内手指向右滑 → 折叠面板回终端 */
  onDockSwipeRight?: () => void;
}

/**
 * 全局单指水平滑动检测(capture)。按 touchstart 落点判定上下文:
 * 落在抽屉/面板/终端主区分别回调;落点在设置页、modal 等其它浮层时
 * 不触发(closest 自然不命中)。
 *
 * 确认是翻页手势的 touchend 会 preventDefault(非 passive):Chromium 对
 * defaultPrevented 的 touchend 不再合成 mousedown/mouseup/click —— 否则
 * 合成 mousedown 在 touchend 之后到达,xterm 会把焦点抢回 helper-textarea,
 * App 层"离开终端页先 blur 收键盘"的修复被无效化(2026-09-14 真机取证)。
 * 只有已判定为滑动的触摸才拦,点击/垂直滚动照常。
 *
 * 双指(pinch 缩放)不触发:touchstart 时 touches.length !== 1 直接忽略。
 * 返回清理函数。
 */
export function attachMobileSwipeNavigation(callbacks: MobileSwipeCallbacks): () => void {
  let startX = 0;
  let startY = 0;
  let startedAt = 0;
  let context: 'drawer' | 'dock' | 'main' | 'other' | null = null;

  const onTouchStart = (e: TouchEvent): void => {
    const t = e.touches[0];
    if (!t || e.touches.length !== 1) {
      context = null;
      return;
    }
    startX = t.clientX;
    startY = t.clientY;
    startedAt = Date.now();
    const el = e.target instanceof Element ? e.target : null;
    if (el?.closest('.mobile-sidebar-drawer')) context = 'drawer';
    else if (el?.closest('.panel-dock')) context = 'dock';
    else if (el?.closest('.terminal-workspace')) context = 'main';
    else context = 'other';
  };

  const onTouchEnd = (e: TouchEvent): void => {
    const ctx = context;
    context = null;
    if (!ctx || ctx === 'other') return;
    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    if (Date.now() - startedAt > SWIPE_MAX_MS) return;
    if (Math.abs(dx) < SWIPE_MIN_DX || Math.abs(dx) <= 2 * Math.abs(dy)) return;
    // 判定为翻页手势:吞掉合成鼠标事件(见函数注释),再通知回调。
    e.preventDefault();
    if (ctx === 'main') {
      if (dx < 0) callbacks.onMainSwipeLeft?.();
      else callbacks.onMainSwipeRight?.();
    } else if (ctx === 'drawer') {
      if (dx < 0) callbacks.onDrawerSwipeLeft?.();
    } else if (ctx === 'dock') {
      if (dx > 0) callbacks.onDockSwipeRight?.();
    }
  };

  const onTouchCancel = (): void => {
    context = null;
  };

  window.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
  // touchend 非 passive(判定为手势时 preventDefault 吞合成鼠标事件)且保持
  // capture:先于 xterm 等目标层监听器执行,不受它们 stopPropagation 影响。
  window.addEventListener('touchend', onTouchEnd, { capture: true, passive: false });
  window.addEventListener('touchcancel', onTouchCancel, { capture: true, passive: true });
  return () => {
    window.removeEventListener('touchstart', onTouchStart, { capture: true });
    window.removeEventListener('touchend', onTouchEnd, { capture: true });
    window.removeEventListener('touchcancel', onTouchCancel, { capture: true });
  };
}

/**
 * ── 触屏长按 = 右键(用户裁决 2026-09-14)──────────────────────────
 *
 * 触屏没有鼠标右键,PC 端所有右键菜单(收藏分组 / 终端 / 文件树 / 终端链接)
 * 在触屏上的等价入口是「长按不动」。实现方式是**合成一个真的 contextmenu
 * DOM 事件**派发到触点元素上 —— 桌面端的 onContextMenu 处理链(React 委托 +
 * 各组件自己的 handlers)原样复用,单一真相源,不另建一套触屏菜单。
 *
 * 规则(与 dnd-kit 拖拽的关系见下):
 * - 单指按住 ≥500ms 且位移 ≤10px → 派发 contextmenu;
 * - 按住期间移动 >10px(滑动/滚动)→ 取消,不弹菜单;
 * - 500ms 内抬起(点按)→ 无事发生;
 * - 输入框(input/textarea/contenteditable)不接管 —— 那里的长按是系统
 *   文本选择/粘贴菜单,不能抢;
 * - dnd-kit 可拖元素([aria-roledescription="sortable"],分组/路径/session 行)
 *   跳过 —— 那里的长按语义由 Sidebar 的 TouchSensor 延迟激活接管:
 *   长按后移动 = 拖拽,长按后不动抬起 = 零位移 onDragEnd → 那边自己派发
 *   contextmenu(见 Sidebar.handleDragEnd)。两边都管会双弹。
 *
 * 菜单弹出后的抬手:长按弹出菜单时手指正压在菜单上,抬起会合成 click 落在
 * 菜单项上造成误触 —— touchend preventDefault(非 passive)吞掉这次合成
 * click,用户下一次独立点按才是真正的选择。
 *
 * WebView 原生长按兜底:Chromium 对长按可能自己合成 contextmenu,与本实现
 * 同拍双发 —— 去重集中在 dispatchSyntheticContextMenu 出口(标记 + 时间窗,
 * 见其注释),两条合成路径(全局长按 / dnd 零位移释放)共用。
 */
const LONG_PRESS_MS = 500;
const LONG_PRESS_CANCEL_PX = 10;

/**
 * 供 Sidebar 的零位移拖拽收尾复用:在触点派发 contextmenu(长按=右键)。
 *
 * 去重(关键,2026-09-14 真机取证):WebView 对长按会**自己合成一个原生
 * contextmenu**(按住 ~500ms 时派发),而 dnd 路径的合成事件在**抬手时**才
 * 派发 —— 原生先到、我们后到,双发把菜单"开又关"。时间窗去重兜不住长按
 * (按多久都行),所以按**手势**去重:一次触摸手势只放行第一个 contextmenu
 * (无论原生还是我们的合成),后续的一律吞;touchstart 重置。鼠标输入不参与
 * (每个右键都是独立事件,桌面语义不变)。全局层与 dnd 路径共用此出口。
 */
type SyntheticCtxEvent = MouseEvent & { __marinaSyntheticCtx?: boolean };
let lastInputWasTouch = false;
let gestureCtxFired = false;
let ctxDedupeInstalled = false;

function installCtxDedupe(): void {
  if (ctxDedupeInstalled) return;
  ctxDedupeInstalled = true;
  // 输入类型判定用 pointerdown 的 pointerType,不能用 touchstart+mousedown
  // 互补(踩过):Chromium 长按会在原生 contextmenu 前合成一个 mousedown,
  // 把 lastInputWasTouch 错误重置,去重链整个失效(真机取证:双发依旧)。
  // pointerdown 每次接触只发一次且类型无合成歧义。
  window.addEventListener(
    'pointerdown',
    (e) => {
      lastInputWasTouch = e.pointerType === 'touch';
      gestureCtxFired = false;
    },
    { capture: true, passive: true },
  );
  window.addEventListener(
    'contextmenu',
    (e) => {
      if (!lastInputWasTouch) return; // 鼠标右键:独立事件,不去重
      if (gestureCtxFired && !(e as SyntheticCtxEvent).__marinaSyntheticCtx) {
        // 本手势已表达过长按菜单(原生先到 / 我们先发)—— 后到的吞掉。
        e.stopImmediatePropagation();
        e.preventDefault();
        return;
      }
      gestureCtxFired = true;
    },
    { capture: true },
  );
}

export function dispatchSyntheticContextMenu(clientX: number, clientY: number): void {
  installCtxDedupe();
  if (lastInputWasTouch && gestureCtxFired) return; // 原生已先行,不重复表达
  const el = document.elementFromPoint(clientX, clientY);
  const ev = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
  }) as SyntheticCtxEvent;
  ev.__marinaSyntheticCtx = true;
  el?.dispatchEvent(ev);
}

/** 触屏长按=右键。仅原生壳内挂(App 层调用);返回清理函数。 */
export function attachTouchLongPressContextMenu(): () => void {
  // 去重监听必须此刻就装,不能等第一次派发才懒装(踩过):WebView 的原生
  // contextmenu echo 比我们的合成事件先到(按住 ~500ms vs 抬手时),懒装时
  // 它经过时监听还不存在,手势标记记不上,后到的合成事件就拦不住。
  installCtxDedupe();
  let timer: number | null = null;
  let fired = false;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  // dnd 元素的「拿起就位」反馈:500ms 到点加 .marina-drag-armed,移动/抬起摘除。
  let armTimer: number | null = null;
  let armedEl: Element | null = null;

  const cancelTimer = (): void => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };

  const onTouchStart = (e: TouchEvent): void => {
    cancelTimer();
    fired = false;
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    if (!t) return;
    startX = lastX = t.clientX;
    startY = lastY = t.clientY;
    const el = e.target instanceof Element ? e.target : null;
    // 触摸滚动条([data-marina-touch-overlay],TerminalTouchScroller)豁免 ——
    // 那里按住是拖动语义,弹右键菜单会打断拖动(用户勘误 2026-09-14)。
    if (el?.closest('input, textarea, [contenteditable], [data-marina-touch-overlay]')) {
      return;
    }
    // dnd 可拖元素([aria-roledescription="sortable"]):右键语义由 Sidebar 的
    // TouchSensor 接管(长按零位移 onDragEnd → contextmenu),这里不弹菜单;
    // 但补一个 500ms 的「拿起就位」视觉反馈(marina-drag-armed,与
    // TouchSensor 的 delay 同拍,见 Sidebar.useMarinaDragSensors)—— 没有反馈
    // 时用户不知道拖拽何时可用,"想右键却总在拖"的误感一半来自这里(用户
    // 勘误 2026-09-15)。
    const sortable = el?.closest('[aria-roledescription="sortable"]') ?? null;
    if (sortable) {
      armedEl = sortable;
      armTimer = window.setTimeout(() => {
        armTimer = null;
        if (armedEl) armedEl.classList.add('marina-drag-armed');
      }, LONG_PRESS_MS);
      return;
    }
    timer = window.setTimeout(() => {
      timer = null;
      fired = true;
      dispatchSyntheticContextMenu(lastX, lastY);
    }, LONG_PRESS_MS);
  };

  const clearArmed = (): void => {
    if (armTimer !== null) {
      window.clearTimeout(armTimer);
      armTimer = null;
    }
    if (armedEl) {
      // dnd-kit 拖拽开始后会用 inline transform 接管元素位移,armed 的
      // scale/阴影到那时已被覆盖;这里兜底摘 class,防止拖完残留。
      armedEl.classList.remove('marina-drag-armed');
      armedEl = null;
    }
  };

  const onTouchMove = (e: TouchEvent): void => {
    if (e.touches.length !== 1) {
      cancelTimer();
      clearArmed();
      return;
    }
    const t = e.touches[0];
    if (!t) return;
    lastX = t.clientX;
    lastY = t.clientY;
    if (Math.hypot(lastX - startX, lastY - startY) > LONG_PRESS_CANCEL_PX) {
      cancelTimer();
      clearArmed();
    }
  };

  const onTouchEnd = (e: TouchEvent): void => {
    if (fired) {
      // 吞掉「长按弹菜单后抬手」的合成 click(见函数注释),然后复位。
      e.preventDefault();
      fired = false;
    }
    cancelTimer();
    clearArmed();
  };

  const onTouchCancel = (): void => {
    fired = false;
    cancelTimer();
    clearArmed();
  };

  window.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
  window.addEventListener('touchmove', onTouchMove, { capture: true, passive: true });
  window.addEventListener('touchend', onTouchEnd, { capture: true, passive: false });
  window.addEventListener('touchcancel', onTouchCancel, { capture: true, passive: true });
  return () => {
    window.removeEventListener('touchstart', onTouchStart, { capture: true });
    window.removeEventListener('touchmove', onTouchMove, { capture: true });
    window.removeEventListener('touchend', onTouchEnd, { capture: true });
    window.removeEventListener('touchcancel', onTouchCancel, { capture: true });
  };
}

// ── 设置页返回时的终端自动聚焦抑制(用户勘误 2026-09-14)──────────────
//
// 问题:打开设置会 park 终端(TerminalDeck activeSessionId=null),退出设置
// 时 TerminalView 的 [active] 重激活 effect 会 term.focus() —— 在 Android
// WebView 上这会弹出输入法,但用户只是关个设置,没有表达任何输入意图。
// 键盘应该只在显式 tap 终端画布时出现(mobile-interactions.md §2 既定语义)。
//
// 机制:退出设置前埋一个短时窗(1.5s)标记,重激活 effect 在窗内跳过
// term.focus()。用时间窗而不是一次性 consume:标记的消费者是 effect 的
// rAF 回调,若期间终端根本没被 park(理论不可达)或用户马上新建 session,
// 一次性标记会被 mount 时的 effect 误吃,时间窗的误伤面只有「1.5s 内恰好
// 切了 session 且希望键盘自动弹」这一种,可接受。
let terminalAutoFocusSuppressUntil = 0;

/** 原生壳内退出设置等"非输入意图"路径调用;桌面不调(键盘焦点回归是桌面
 *  关设置的既定好行为,不能回归)。 */
export function suppressNextTerminalAutoFocus(): void {
  terminalAutoFocusSuppressUntil = Date.now() + 1500;
}

/** TerminalView 重激活时查询:窗内返回 true(跳过自动聚焦)。 */
export function terminalAutoFocusSuppressed(): boolean {
  return Date.now() < terminalAutoFocusSuppressUntil;
}

/**
 * 面板开/关导航事件(App 手势层 → LayoutHost)。不复用 'marina-back':
 * back 是层级退出语义,这是显式导航语义;且 App 层不知道 per-session 的
 * dock collapsed 状态(在 backend UI layout 里),只能发事件让 LayoutHost 执行。
 */
export const PANEL_NAV_EVENT = 'marina-panel-nav';
export function dispatchPanelNav(open: boolean): void {
  window.dispatchEvent(new CustomEvent(PANEL_NAV_EVENT, { detail: { open } }));
}
