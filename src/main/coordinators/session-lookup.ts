/**
 * @file session-lookup.ts
 * @purpose M2:workspace / pi coordinator 对 SessionManager 的最小只读依赖接口。
 *
 * @关键设计:
 * - 沿用 FilePanelService 的 FilePanelSessionLookup 模式:coordinator 不持有
 *   SessionManager 具体类,只依赖本接口(SessionManager 天然满足),既破除循环
 *   依赖又便于单测注入 mock。
 * - hasSession 与 getSessionPathId 分开:pi 事件入站要区分「session 不存在」
 *   (静默丢弃,见 ADR-028)与「存在但无 pathId」;workspace 的 pathScope 解析
 *   把「不存在」当 SessionNotFound 抛(保持与 SessionManager 原行为一致)。
 *
 * @对应文档章节:M2 设计决策 5(统一 SessionLookup)
 *
 * @不要在这里做的事:
 * - 不要加写操作(owner 变更/绑定写入在各自 coordinator,不走本接口)
 */
export interface SessionLookup {
  /** session 是否存在(pi 事件入站的 session 不存在守卫)。 */
  hasSession(sessionId: string): boolean;
  /** session 的 pathId(workspace 的 pathScope)。session 不存在返 null。 */
  getSessionPathId(sessionId: string): string | null;
}
