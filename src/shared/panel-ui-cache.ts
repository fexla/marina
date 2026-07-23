/**
 * @file src/shared/panel-ui-cache.ts
 * @purpose 面板 UI「工作态」的组件外缓存 —— 让面板被 LayoutHost 卸载后,
 *   其展开目录 / 选中项 / 过滤草稿等"切面板再切回应该还在"的状态不丢失。
 *
 * @关键设计:
 * - 这是面板 UI 状态三层模型的 **L1 层**(见 ADR-019):
 *     L0 瞬态(loading/error)        → 组件 useState,随 mount 生灭
 *     L1 工作态(展开目录/选中项)     → 本模块(跨 mount 保留,重启可丢) ← 这里
 *     L2 偏好(视图模式/活跃 root)    → panel-preferences.ts(跨重启,localStorage)
 * - 数据放模块级 Map(组件生命周期之外),与 git-status-cache.ts 同模式。
 *   mount 时先读缓存恢复,每次写入同步落缓存;切走面板 = 卸载组件,缓存留下;
 *   切回 = 重新 mount,useState 初始化读缓存秒回原状态。
 * - **不改 LayoutHost**:`<ActivePanel key={...}>` 的 lazy mount 机制不动,
 *   面板切换性能契约(<16ms,AGENTS.md §10)不受影响。内存读写零延迟。
 * - 与 git-status-cache.ts 分工:那个缓存的是 **数据 snapshot**(Git status,
 *   由 main 端事件失效,swr 模式);本模块缓存的是 **纯 UI 态**(无外部失效源,
 *   只随 session 销毁清理)。语义不同,各自独立,不合并。
 * - key 维度:`sessionId → panelId → state`。同一 session 的不同面板互不干扰;
 *   切 session 时 LayoutHost 按 sessionId 重挂面板,新 session 读自己的缓存。
 *
 * @对应文档章节: docs/方案-面板UI状态与缩进统一-20260721.md §2.1;ADR-019。
 *
 * @不要在这里做的事:
 * - 不做跨重启持久化(那是 L2 panel-preferences 的职责;重启后工作态清空是刻意的,
 *   避免陈旧展开态误导)。
 * - 不存瞬态(loading/error):那些丢了合理,缓存反而会让"loading 卡住"假象残留。
 * - 不响应式通知:本模块不是 store,面板自己更新自己写入的缓存即可,无需订阅。
 */
/**
 * 缓存结构:`sessionId → (panelId → state)`。
 *
 * 外层 Map 以 session 为隔离边界(session 销毁时 `clearPanelUiState(sessionId)`
 * 一次性回收整个 session 的所有面板态,防内存泄漏)。内层 Map 以 panelId 隔离
 * 同一 session 的不同面板(Files / Git / Opened 等)。
 */
type PanelUiStateMap = Map<string, unknown>;
const cache = new Map<string, PanelUiStateMap>();

/**
 * 读取某 session 某 panel 的缓存 UI 态。未命中返回 undefined(调用方走 initial)。
 *
 * @example
 *   const cached = getPanelUiState<DirectoryStates>(sessionId, 'file-tree');
 *   if (cached) { /* 恢复展开态 *\/ }
 */
export function getPanelUiState<T>(sessionId: string, panelId: string): T | undefined {
  return cache.get(sessionId)?.get(panelId) as T | undefined;
}

/**
 * 写入(覆盖)某 session 某 panel 的缓存 UI 态。
 *
 * 调用时机:每次面板内部 setState 时同步调用(而非 unmount 时一次性序列化)。
 * 理由:unmount effect 在 React 严格模式 / 快速切换下可能漏跑或不及时;
 * 每次 set 同步写最简单可靠,且 Map.set 是 O(1) 无性能负担。
 */
export function setPanelUiState<T>(sessionId: string, panelId: string, state: T): void {
  let panelMap = cache.get(sessionId);
  if (!panelMap) {
    panelMap = new Map();
    cache.set(sessionId, panelMap);
  }
  panelMap.set(panelId, state);
}

/**
 * 清除缓存。
 *
 * - 传 `panelId`:只清该 session 的该面板(面板重置自身时用)。
 * - 不传 `panelId`:清该 session 的**所有**面板(供 SessionManager 在 session
 *   销毁时调用,一次性回收,防陈旧态泄漏到被复用的 sessionId —— 虽然 sessionId
 *   是 UUID 不会复用,但显式回收能控制内存上界,10+ session 长跑不膨胀)。
 */
export function clearPanelUiState(sessionId: string, panelId?: string): void {
  if (panelId === undefined) {
    cache.delete(sessionId);
    return;
  }
  cache.get(sessionId)?.delete(panelId);
}

/** 清除全部缓存(测试 / 调试用)。生产代码不应调用。 */
export function clearAllPanelUiState(): void {
  cache.clear();
}
