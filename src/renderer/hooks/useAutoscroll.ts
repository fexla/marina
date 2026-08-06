/**
 * @file src/renderer/hooks/useAutoscroll.ts
 * @purpose 浏览器风格的「中键自动滚动」:点一下中键(松手)进入自动滚动模式,
 *          在点击处显示一个带上下箭头的圆圈图标,鼠标上下/左右移动即持续自动滚动
 *          (离图标越远滚得越快),再次点击中键或按任意键退出。
 *
 * @为什么自实现而非用 Chromium 原生:
 *   Chromium 确有内置 middle-click autoscroll,但在 Electron 应用里是否默认触发、
 *   对自定义 overflow:auto 容器的行为、以及那个内置圆圈光标的可见性,都不可控且
 *   无法由代码确保跨 viewer 一致。自实现能让 text/markdown/diff/image/unknown
 *   所有查看器行为统一,图标用主题色适配明暗主题,退出时机完全可控。
 *
 * @交互模型(对齐 Chrome / Edge / Firefox 的中键自动滚动):
 *   1. 在容器内按下中键(button===1)→ 进入 autoscroll,锚点=按下坐标。
 *   2. 显示圆圈图标(fixed 定位在锚点,不随滚动移动)。
 *   3. 鼠标移动(无需按键):dx/dy = 当前坐标 - 锚点。死区(≈图标半径)内不滚;
 *      超出死区按比例持续滚动(越远越快),上下滚垂直、左右滚水平。
 *   4. 退出:再次按下中键 / 按下任意键 / 窗口失焦 / 页面隐藏。
 *
 * @关键设计:
 * - mousedown 必须 preventDefault:既阻止 Chromium 原生 autoscroll 光标,也阻止
 *   中键触发的「自动滚动默认行为 / 链接后台打开」等副作用。stopPropagation 避免
 *   冒泡到上层可能存在的其它中键处理。
 * - mousemove / 退出事件绑 window,避免鼠标移出容器边缘就中断(移出再移回仍连续)。
 * - 滚动用 requestAnimationFrame 驱动(不是每次 mousemove 直接 scrollBy):mousemove
 *   只更新目标速度,RAF 按帧消费 → 即使鼠标停住不动也持续匀速滚(这是浏览器手感
 *   的关键;逐事件 scroll 会在鼠标停下时立刻停,不符合 autoscroll 语义)。
 * - 速度曲线:超出死区后 speed = (|offset| - deadZone) * factor,clamp 到上限。
 *   factor / 上限经手感受控,可调。
 * - 退出后必须:取消 RAF、移除图标 DOM、解绑 window 监听,避免泄漏。
 *
 * @副作用:
 * - 往 document.body 临时插入一个 .marina-autoscroll-indicator 元素(图标)。
 * - 临时给容器设 cursor:var(--marina-autoscroll-cursor, ns-resize),退出还原。
 * - 不改容器 scroll 之外的 DOM / 业务状态。
 *
 * @不在这里做的事:
 * - 不处理触控板 / 触屏(那些用系统原生手势)。
 * - 不处理 Ctrl+滚轮缩放(另一个交互)。
 * - 不接管滚轮事件(滚轮仍走浏览器原生滚动;autoscroll 期间滚轮行为交给用户习惯)。
 *
 * @对应文档:本 hook 替换原 useMiddleClickPan(按住中键拖动平移)。需求来源:
 *   用户反馈「已打开」面板期望中键进入「上下移动的模式」,即浏览器风格 autoscroll。
 */
import { useEffect, type RefObject } from 'react';

/** 死区半径(px):鼠标在锚点此距离内不滚动,避免图标正中微抖动触发滚动。 */
const DEAD_ZONE = 14;
/** 速度系数:每超出死区 1px,每帧滚动 SPEED_FACTOR 像素。手感可调。 */
const SPEED_FACTOR = 0.45;
/** 每帧最大滚动像素(防鼠标拉到边缘时滚动过快难以控制)。 */
const MAX_SPEED_PER_FRAME = 60;

/**
 * @param containerRef 滚动容器的 ref。中键在该容器(或其子元素)内按下时触发。
 *   ref.current 为 null 时 hook 空转。
 */
export function useAutoscroll<T extends HTMLElement>(
  containerRef: RefObject<T | null>,
): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    // autoscroll 运行态:锚点坐标 + 滌当前速度(px/frame,x/y 可正可负)+ RAF id +
    // 容器原 cursor(退出还原)+ 图标元素。
    let anchor: { x: number; y: number } | null = null;
    let velocity = { x: 0, y: 0 };
    let rafId = 0;
    let prevCursor = '';
    let indicator: HTMLDivElement | null = null;

    /** 是否真正处于 autoscroll(锚点已建立 + 图标已显示)。 */
    const active = (): boolean => anchor !== null;

    /**
     * 创建并插入圆圈图标。fixed 定位在锚点:不随容器滚动移动,符合浏览器行为
     * (图标是「参考点」,内容在它下方滚动)。挂 document.body 避免被容器
     * overflow 裁切 / 被容器 transform 影响。SVG 用 currentColor,颜色由
     * .marina-autoscroll-indicator 的 color(主题文本色)决定,明暗主题都可见。
     */
    const showIndicator = (x: number, y: number): void => {
      indicator = document.createElement('div');
      indicator.className = 'marina-autoscroll-indicator';
      indicator.style.left = `${x}px`;
      indicator.style.top = `${y}px`;
      indicator.innerHTML = INDICATOR_SVG;
      document.body.appendChild(indicator);
    };

    const hideIndicator = (): void => {
      if (indicator) {
        indicator.remove();
        indicator = null;
      }
    };

    /**
     * 每帧消费 velocity 滚动容器。逐帧而非逐事件,使鼠标停下时仍匀速滚动。
     * 到达边界( scrollTop=0 或 max)时浏览器自然停,velocity 不强制清零——
     * 鼠标移回死区会重新算 velocity,符合预期。
     */
    const tick = (): void => {
      const el = containerRef.current;
      if (!el || !active()) return;
      if (velocity.x !== 0) el.scrollLeft += velocity.x;
      if (velocity.y !== 0) el.scrollTop += velocity.y;
      rafId = requestAnimationFrame(tick);
    };

    /** 根据 dx/dy(相对锚点)重算 velocity。死区内归零。 */
    const recomputeVelocity = (clientX: number, clientY: number): void => {
      if (!anchor) return;
      const dx = clientX - anchor.x;
      const dy = clientY - anchor.y;
      velocity = {
        x: applyCurve(dx),
        y: applyCurve(dy),
      };
    };

    const enter = (e: MouseEvent): void => {
      // 进入即记录锚点、显图标、绑 move、起 RAF、换 cursor。
      anchor = { x: e.clientX, y: e.clientY };
      velocity = { x: 0, y: 0 };
      showIndicator(e.clientX, e.clientY);
      const el = containerRef.current;
      if (el) {
        prevCursor = el.style.cursor;
        el.style.cursor = 'var(--marina-autoscroll-cursor, ns-resize)';
      }
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(tick);
    };

    const exit = (): void => {
      if (!active()) return;
      anchor = null;
      velocity = { x: 0, y: 0 };
      cancelAnimationFrame(rafId);
      rafId = 0;
      hideIndicator();
      const el = containerRef.current;
      if (el) el.style.cursor = prevCursor;
    };

    // —— 事件处理 ——————————————————————————————————————————

    const onMouseDown = (e: MouseEvent): void => {
      if (e.button !== 1) return; // 只认中键
      const el = containerRef.current;
      if (!el) return;
      e.preventDefault(); // 阻止原生 autoscroll 光标 + 中键默认行为
      e.stopPropagation();
      if (active()) {
        // 已在 autoscroll 中再次按中键 → 退出(浏览器即此行为)。
        exit();
        return;
      }
      enter(e);
    };

    const onMouseMove = (e: MouseEvent): void => {
      if (!active()) return;
      recomputeVelocity(e.clientX, e.clientY);
    };

    // 浏览器 autoscroll:按任意键退出。这里监听 keydown(capture 阶段,避免被终端
    // 焦点逻辑吞掉);ESC / 方向键等一律退出。不 preventDefault——退出是副作用,
    // 不应改变该按键的原本含义。
    const onKeyDown = (): void => {
      if (active()) exit();
    };

    const onBlur = (): void => {
      if (active()) exit();
    };

    const onVisibilityChange = (): void => {
      if (document.hidden && active()) exit();
    };

    container.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      // 卸载时务必清理:取消 RAF、移除图标、解绑全部监听,杜绝泄漏与悬挂状态。
      // 用 effect 顶部捕获的 container(而非 containerRef.current):cleanup 时
      //  ref.current 可能已被 React 重置为 null,导致 cursor 无法还原。
      cancelAnimationFrame(rafId);
      hideIndicator();
      if (prevCursor) container.style.cursor = prevCursor;
      container.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [containerRef]);
}

/**
 * 把「相对锚点的偏移量」映射成「每帧滚动像素」。死区内 0;超出死区线性增长,
 * 封顶 MAX_SPEED_PER_FRAME。返回值带方向(正=向右/下,负=向左/上)。
 */
function applyCurve(offset: number): number {
  const abs = Math.abs(offset);
  if (abs <= DEAD_ZONE) return 0;
  const speed = (abs - DEAD_ZONE) * SPEED_FACTOR;
  const clamped = Math.min(speed, MAX_SPEED_PER_FRAME);
  return offset >= 0 ? clamped : -clamped;
}

/**
 * autoscroll 圆圈图标 SVG:外圈圆 + 上/下三角箭头 + 左/右三角箭头 + 中心圆点。
 * fill/stroke 用 currentColor,颜色随 .marina-autoscroll-indicator 的 color
 * (主题文本色)变化。viewBox 40×40,rendered 尺寸由 CSS 控制。
 */
const INDICATOR_SVG = `<svg viewBox="0 0 40 40" aria-hidden="true" focusable="false">
  <circle cx="20" cy="20" r="13" fill="none" stroke="currentColor" stroke-width="2"/>
  <polygon points="20,3 14,12 26,12" fill="currentColor"/>
  <polygon points="20,37 14,28 26,28" fill="currentColor"/>
  <polygon points="3,20 12,14 12,26" fill="currentColor"/>
  <polygon points="37,20 28,14 28,26" fill="currentColor"/>
  <circle cx="20" cy="20" r="2.5" fill="currentColor"/>
</svg>`;
