/**
 * @file src/renderer/ui-overlay-stack.ts
 * @purpose React hook 包装 — overlay 栈在 React 组件里的使用入口。
 *   命令式核心(push / pop / isTop / 测试 reset)在 `@shared/ui-overlay-stack`,
 *   见那里的头部 JSDoc 了解完整模型与不变式。
 */
import { useEffect, useRef } from 'react';
import { isTopOverlay, pushOverlay } from '@shared/ui-overlay-stack';

// 命令式 API 透出 — Modal/ContextMenu 等组件如需手动控制可直接调
export {
  hasAnyOverlay,
  isTopOverlay,
  pushOverlay,
  topOverlayId,
} from '@shared/ui-overlay-stack';

/**
 * React hook — `active` 为 true 时 push,false / unmount 时自动 pop。
 *
 * 用法:
 * ```ts
 * const { isTop } = useOverlayRegistration(!!modal);
 * useEffect(() => {
 *   const onKey = (e: KeyboardEvent) => {
 *     if (!isTop()) return; // 我不是栈顶,让上层吃
 *     // ... handle Esc
 *   };
 *   window.addEventListener('keydown', onKey);
 *   return () => window.removeEventListener('keydown', onKey);
 * }, [isTop]);
 * ```
 *
 * 注意 isTop 是 getter,不是值 — keydown listener 每次触发时实时查栈状态。
 */
export function useOverlayRegistration(active: boolean): {
  isTop: () => boolean;
} {
  const idRef = useRef<number | null>(null);
  useEffect(() => {
    if (!active) return undefined;
    const reg = pushOverlay();
    idRef.current = reg.id;
    return () => {
      reg.pop();
      idRef.current = null;
    };
  }, [active]);
  return {
    isTop: () => idRef.current !== null && isTopOverlay(idRef.current),
  };
}
