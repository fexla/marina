/**
 * @file src/renderer/state/git-status-cache.ts
 * @purpose GitPanel 的组件外缓存,消除面板切换的"几百 ms 等 spawn git"延迟。
 *
 * @背景(AGENTS.md §10 面板切换延迟约束,2026-07-19 增补):
 * LayoutHost 用 `<ActivePanel key={`${activePanelId}-${session.id}`}>` 渲染当前面板,
 * 切走 Git tab = 卸载组件 = useState 里的 snapshot 丢失;切回 = 重新 mount =
 * 重新 spawn git(Windows ConGit 冷启 ~100-300ms)+ IPC 往返,用户感知 200-500ms 卡顿。
 *
 * 解法:把 snapshot 放到模块级 Map(组件生命周期之外),mount 时先读缓存秒显,
 * 后台再静默刷新(loading 态不覆盖已有 snapshot,避免闪烁)。这是"stale-while-
 * revalidate"模式的最小实现。
 *
 * @缓存刷新来源:
 * 1. GitPanel mount 后的 loadStatus() 成功 → setCached
 * 2. ADR-021 main demand-aware task(HOT 3s / WARM 60s)→ evt:git:status-updated
 *    → App 根层常驻 bridge 写缓存（GitPanel 卸载时也不会丢 WARM 结果）
 * 3. Session 销毁事件由根层 bridge clearCachedStatus，避免历史 session 泄漏
 *
 * @不在这里做的事:
 * - 不做 TTL 自动过期:Git 是外部状态,失效只能由 main 端事件告知,时间过期会误清。
 * - 不存 loading/error 态:那些是 UI 瞬态,不该跨 mount 保留(snapshot 才是该留的)。
 * - 不存 untrackedExpanded 等 UI 偏好:那些归 localStorage(与 view-mode 同层)。
 */
import type { GitStatusGroup, GitUnavailableReason } from '@shared/protocol';

/**
 * 缓存条目。snapshot 与 unavailable 互斥(与 GetGitStatusResponse 形状一致)。
 * at 仅用于调试(何时写入),不参与过期判定。
 */
export interface GitStatusCacheEntry {
  /** 正常状态:变更分组。 */
  groups?: GitStatusGroup[];
  truncated?: boolean;
  /** 不可用状态:原因码。 */
  unavailable?: GitUnavailableReason | undefined;
  /** 写入时间戳(ms),调试用。 */
  at: number;
}

const cache = new Map<string, GitStatusCacheEntry>();

/** 读取缓存。未命中返回 undefined(GitPanel 走 loading 态)。 */
export function getCachedStatus(sessionId: string): GitStatusCacheEntry | undefined {
  return cache.get(sessionId);
}

/** 写入缓存(覆盖)。snapshot 与 unavailable 由调用方保证互斥。 */
export function setCachedStatus(sessionId: string, entry: GitStatusCacheEntry): void {
  cache.set(sessionId, entry);
}

/** 清除指定 session 的缓存(session 销毁时调,防内存泄漏)。 */
export function clearCachedStatus(sessionId: string): void {
  cache.delete(sessionId);
}

/** 清除全部(session 切换 / 调试 / 测试用)。 */
export function clearAllCachedStatus(): void {
  cache.clear();
}
