/**
 * @file src/renderer/hooks/usePanelPreference.ts
 * @purpose 把 panel-preferences(L2 跨重启偏好)封装成 hook,让"视图模式 / 活跃 root"
 *   等偏好即改即存、关掉重开仍记得。
 *
 * @关键设计:
 * - 行为对齐 useState:返回 [value, setValue],setValue 支持值或 updater 函数。
 * - mount 时:useState initializer 读 localStorage(含老 key 自动迁移),未命中用 fallback。
 * - 每次 setValue:同步写 localStorage(持久化),无需 effect。
 *
 * @与 usePanelUiState 的区别:
 * - usePanelUiState(L1):跨 mount 保留,重启丢 —— 给"工作态"(展开目录)。
 * - usePanelPreference(L2):跨重启保留 —— 给"偏好"(视图模式)。
 *
 * @对应文档章节: docs/方案-面板UI状态与缩进统一-20260721.md §2.1;ADR-019。
 */
import { useCallback, useState } from 'react';
import { readPanelPreference, writePanelPreference } from '@shared/panel-preferences';

/**
 * 面板偏好的 useState 替代品。语义与 useState 一致,额外把值持久化到 localStorage。
 *
 * @param panelId  面板标识(如 'git' / 'file-tree' / 'sidebar')
 * @param key      偏好键名(如 'viewMode' / 'activeRootId')
 * @param fallback 未命中时的初值(每次 render 都会传,但仅 mount 时用于初始化)
 * @returns [value, setValue] —— setValue 同样接受值或 `(prev) => next`
 *
 * @example
 *   const [viewMode, setViewMode] = usePanelPreference<GitViewMode>(
 *     'git', 'viewMode', 'tree',
 *   );
 */
export function usePanelPreference<T>(
  panelId: string,
  key: string,
  fallback: T,
): [T, (next: T | ((prev: T) => T)) => void] {
  // mount 读 localStorage。fallback 在闭包里,仅初始化用(偏好通常 fallback 是常量)。
  const [value, setValue] = useState<T>(() => readPanelPreference<T>(panelId, key, fallback));

  const update = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const v = typeof next === 'function' ? (next as (prev: T) => T)(prev) : next;
        writePanelPreference(panelId, key, v);
        return v;
      });
    },
    [panelId, key],
  );

  return [value, update];
}
