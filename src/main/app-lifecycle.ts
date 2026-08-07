/**
 * @file src/main/app-lifecycle.ts
 * @purpose 应用生命周期状态的单一事实源:退出状态机(running→quiescing→flushing→stopped)。
 *
 * @关键设计:
 * - 显式状态机:`running`(正常运行)→ `quiescing`(已关门,拒绝新工作)→
 *   `flushing`(正在 flush 持久化)→ `stopped`(退出收尾完成)。
 *   转移:enterQuiescing→enterFlushing→enterStopped,单调单向,不允许回退。
 * - 从 index.ts 拆出:ipc.ts / tray.ts 需要在 APP_QUIT / 托盘"完全退出"时
 *   标记退出,原来反向 import './index' 形成静态循环 import
 *   (index ⇄ ipc、index ⇄ tray),导致 ipc.test.ts 必须 vi.mock('./index')
 *   打断。拆出后 ipc/tray/index 三方都 import 本模块,循环消除。
 * - 保留原布尔语义兼容:setQuitting() 映射到 enterQuiescing();
 *   getIsQuitting() 等价于 state !== 'running'。旧调用方(ipc.ts APP_QUIT、
 *   tray 退出菜单、index 的 window-all-closed/before-quit)无需改动语义。
 * - transport gate 读 isQuiescing():IPC handler / WS dispatch / HTTP 在
 *   quiescing 后拒绝新工作,确保"先关门再拆"——这是架构复核 H4 的核心:
 *   1 秒 flush 预算本身不是问题,"预算期间仍接受新工作"才是。
 *
 * @对应文档章节:软件定义书.md 8.1、9.2.1(退出流程);架构复核 H4;ADR-029 同批
 *
 * @不要在这里做的事:
 * - 不要放退出编排逻辑(先停 WS/HTTP 再 shutdown session 再 flush 的顺序是
 *   index.ts before-quit 的职责,本模块只存状态 + 转移)
 * - 不要放 session / store / window 管理逻辑(各自 manager 的职责)
 * - 不要加第二个"退出标志",本模块是生命周期状态的唯一事实源
 * - 不要实现 stopped → running 的回退(退出不可逆,设计如此)
 */
export type AppLifecycleState = 'running' | 'quiescing' | 'flushing' | 'stopped';

let state: AppLifecycleState = 'running';

/** 状态转移合法性表:allowedTransitions[from] = 可达的 to 集合。 */
const ALLOWED_TRANSITIONS: Record<AppLifecycleState, ReadonlySet<AppLifecycleState>> = {
  running: new Set(['quiescing']),
  quiescing: new Set(['flushing']),
  flushing: new Set(['stopped']),
  stopped: new Set(),
};

/**
 * 原子转移。非法转移(running→flushing、stopped 后再转等)静默忽略并返回 false。
 * 主进程单线程事件循环,无锁;幂等设计保证重复调用无害。
 */
function transition(to: AppLifecycleState): boolean {
  if (!ALLOWED_TRANSITIONS[state].has(to)) return false;
  state = to;
  return true;
}

/** 进入 quiescing(关门拒绝新工作)。running→quiescing,幂等。 */
export function enterQuiescing(): void {
  transition('quiescing');
}

/** 进入 flushing(持久化收尾)。quiescing→flushing,幂等。 */
export function enterFlushing(): void {
  transition('flushing');
}

/** 进入 stopped(退出收尾完成)。flushing→stopped,幂等。 */
export function enterStopped(): void {
  transition('stopped');
}

/** 标记应用进入退出流程。由 APP_QUIT IPC 与托盘"完全退出"路径调用。 */
export function setQuitting(): void {
  enterQuiescing();
}

/** 查询应用是否已进入退出流程。index.ts 的 close 拦截 / before-quit 分支读取。 */
export function getIsQuitting(): boolean {
  return state !== 'running';
}

/** 查询当前生命周期状态。 */
export function getLifecycleState(): AppLifecycleState {
  return state;
}

/** transport gate 用:quiescing 及之后(flushing/stopped)拒绝新工作。 */
export function isQuiescing(): boolean {
  return state !== 'running';
}
