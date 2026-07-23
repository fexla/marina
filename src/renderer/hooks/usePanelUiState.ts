/**
 * @file src/renderer/hooks/usePanelUiState.ts
 * @purpose 把 panel-ui-cache(L1 组件外缓存)封装成一个可直接替代 useState 的 hook,
 *   让面板"切走再切回,工作态还在"变成一行替换。
 *
 * @关键设计:
 * - 行为对齐 useState:返回 [state, setState],setState 支持值或 updater 函数。
 * - mount 时:useState 的 initializer 先读缓存,命中用缓存(恢复旧态),未命中用
 *   `initial`(可为值或惰性工厂函数)。这就是"切回来秒回原状态"。
 * - 每次 setState:同步写缓存(非 unmount 时序列化 —— 避免严格模式 / 快速切换漏跑)。
 * - **不依赖 useEffect 写缓存**:state 变化即写,无需副作用,无竞态。
 *
 * @为什么 sessionId / panelId 变化时不用 effect 重读:
 * LayoutHost 用 `<ActivePanel key={panelId-sessionId}>` 渲染,sessionId 或 panelId
 * 变化 = key 变化 = React 卸载旧组件、挂载新组件 = useState 重新跑 initializer =
 * 自然读新 (sessionId, panelId) 的缓存。所以无需额外 effect 处理 props 变化。
 *
 * @对应文档章节: docs/方案-面板UI状态与缩进统一-20260721.md §2.1;ADR-019。
 *
 * @不要在这里做的事:
 * - 不持久化到 localStorage(那是 L2 usePanelPreference 的职责)。
 * - 不做跨组件广播(本 hook 是面板私有态的存取,不是全局 store)。
 */
import { useCallback, useState } from 'react';
import { getPanelUiState, setPanelUiState } from '@shared/panel-ui-cache';

/**
 * 面板 UI 工作态的 useState 替代品。语义与 useState 一致,额外把状态镜像到
 * 组件外缓存,使面板卸载/重挂后状态可恢复。
 *
 * @param sessionId 当前 session(LayoutHost 按 session 隔离面板态)
 * @param panelId   面板标识(如 'file-tree' / 'git')—— 同一 session 不同面板互不干扰
 * @param initial   未命中缓存时的初值;可为值或 `() => T` 惰性工厂(同 useState)
 * @returns [state, setState] —— setState 同样接受值或 `(prev) => next`
 *
 * @example
 *   const [directories, setDirectories] = usePanelUiState<DirectoryStates>(
 *     sessionId, 'file-tree', {},
 *   );
 */
export function usePanelUiState<T>(
  sessionId: string,
  panelId: string,
  initial: T | (() => T),
): [T, (next: T | ((prev: T) => T)) => void] {
  const [state, setState] = useState<T>(() => {
    const cached = getPanelUiState<T>(sessionId, panelId);
    if (cached !== undefined) return cached;
    return typeof initial === 'function' ? (initial as () => T)() : initial;
  });

  const update = useCallback(
    (next: T | ((prev: T) => T)) => {
      setState((prev) => {
        const value =
          typeof next === 'function' ? (next as (prev: T) => T)(prev) : next;
        // 同步落缓存:切走面板时缓存已是最新,无需 unmount effect。
        setPanelUiState(sessionId, panelId, value);
        return value;
      });
    },
    [sessionId, panelId],
  );

  return [state, update];
}
