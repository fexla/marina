/**
 * @file src/renderer/hooks/useMiddleClickPan.ts
 * @purpose 鼠标中键按住拖动 → 平移滚动容器(上下 + 左右),即「手型工具 / auto-scroll」。
 *
 * @为什么单独一个 hook:
 *   TextViewer / DiffViewer / MarkdownViewer 三个滚动容器都要支持中键拖动(与浏览器 /
 *   VS Code / Acrobat 等通用软件一致),逻辑相同,抽成 hook 复用。开发者反馈此前无法用
 *   中键拖动面板,本 hook 补齐。
 *
 * @关键设计:
 * - 只响应 button===1(中键)。左键/右键不动(左键是选中文本,右键是菜单)。
 * - mousedown 记录起点 {clientX, clientY, scrollLeft, scrollTop},设 cursor:grabbing。
 *   preventDefault + stopPropagation 阻止浏览器原生「中键自动滚动」光标(Windows 上
 *   默认会出现那个圆形滚动光标并接管滚轮)—— auxclick/mousedown button=1 必须拦掉。
 * - mousemove(仅在 panning 中)按鼠标位移反方向滚动:scrollLeft = start - dx。
 *   绑定到 window 而非容器,避免鼠标移出容器边缘就丢失拖动(拖出再拖回仍连续)。
 * - mouseup(任意键)/ blur / visibilitychange(hidden) → 停止。避免切窗口后仍卡在
 *   panning 状态、cursor 不恢复。
 * - cursor 恢复:mouseup 还原容器原 cursor。pointer-events 不动(继续可选中文本)。
 *
 * @副作用:
 * - 临时改 container.style.cursor(开始 grabbing,结束还原原值)。
 * - 不改 scroll 之外的 DOM / 状态。
 *
 * @不在这里做的事:
 * - 不处理 Ctrl+滚轮缩放(那是另一个交互,暂未做)。
 * - 不处理触控板双指平移(系统/Chromium 原生已支持横向滚动)。
 *
 * @对应文档:docs/计划-代码查看器布局与交互修复-20260720.md 阶段 2
 */
import { useEffect, type RefObject } from 'react';

/**
 * @param containerRef 滚动容器的 ref(TextViewer/DiffViewer/MarkdownViewer 的根)。
 *   ref.current 为 null 时 hook 空转(组件卸载或未挂载)。
 */
export function useMiddleClickPan<T extends HTMLElement>(
  containerRef: RefObject<T | null>,
): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    // 拖动起点快照:记录 mousedown 瞬间的鼠标坐标 + 容器滚动位置。
    let start: { x: number; y: number; left: number; top: number } | null = null;
    // 记录拖动前容器原 cursor,松开后还原(避免覆盖组件自己设的 cursor)。
    let prevCursor: string = '';

    const onMouseDown = (e: MouseEvent): void => {
      if (e.button !== 1) return; // 只认中键
      const el = containerRef.current;
      if (!el) return;
      e.preventDefault(); // 阻止原生中键自动滚动光标
      e.stopPropagation();
      start = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
      prevCursor = el.style.cursor;
      el.style.cursor = 'grabbing';
    };

    const onMouseMove = (e: MouseEvent): void => {
      if (!start) return;
      const el = containerRef.current;
      if (!el) return;
      // 鼠标向右下移动 → 内容向右下「跟随」(反方向滚动量)。与浏览器/Acrobat 手型一致。
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      el.scrollLeft = start.left - dx;
      el.scrollTop = start.top - dy;
    };

    const stop = (): void => {
      if (!start) return;
      start = null;
      const el = containerRef.current;
      if (el) el.style.cursor = prevCursor;
    };

    // mousedown 绑容器(只在容器内按下才触发);mousemove/up 绑 window(拖出容器也连续)。
    container.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', stop);
    window.addEventListener('blur', stop);
    document.addEventListener('visibilitychange', stop);

    return () => {
      container.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', stop);
      window.removeEventListener('blur', stop);
      document.removeEventListener('visibilitychange', stop);
    };
  }, [containerRef]);
}
