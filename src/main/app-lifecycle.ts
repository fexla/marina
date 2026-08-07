/**
 * @file src/main/app-lifecycle.ts
 * @purpose 全局应用退出状态(isQuitting)的单一事实源。
 *
 * @关键设计:
 * - 只存"应用是否进入退出流程"这一个布尔状态 + setter/getter,零副作用
 * - 从 index.ts 拆出:ipc.ts / tray.ts 需要在 APP_QUIT / 托盘"完全退出"时
 *   标记 isQuitting,原来反向 import './index' 形成静态循环 import
 *   (index ⇄ ipc、index ⇄ tray),导致 ipc.test.ts 必须 vi.mock('./index')
 *   打断。拆出后 ipc/tray/index 三方都 import 本模块,循环消除
 * - ESM 导入 binding 只读,index.ts 内部不能直接给 isQuitting 赋值,
 *   统一走 setQuitting();读取统一走 getIsQuitting()
 *
 * @对应文档章节:软件定义书.md 8.1、9.2.1(退出流程);AGENTS.md 检查点 1/2
 *
 * @不要在这里做的事:
 * - 不要实现 quiesce 状态机 / 退出编排(running→quiescing→flushing→stopped)
 *   —— 那是后续 AppLifecycleController 设计决策的范畴,现在只保留原布尔语义
 * - 不要放 session / store / window 管理逻辑(各自 manager 的职责)
 * - 不要加第二个"退出标志",本模块是 isQuitting 的唯一事实源
 */
let isQuitting = false;

/** 标记应用进入退出流程。由 APP_QUIT IPC 与托盘"完全退出"路径调用。 */
export function setQuitting(): void {
  isQuitting = true;
}

/** 查询应用是否已进入退出流程。index.ts 的 close 拦截 / before-quit 分支读取。 */
export function getIsQuitting(): boolean {
  return isQuitting;
}
