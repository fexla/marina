/**
 * @file terminal-state-getter.ts
 * @purpose 终端 active/idle 状态判断的抽象(拉取模型)。
 *
 * @关键设计:
 * - SessionManager 持有当前 getter(byteStream fallback 或 agent),在事件点
 *   (字节 / resize / 输入 / idle 定时器)调 onXxx 通知 getter、随后调 getState()
 *   拉取状态并应用(applyState)。状态判断职责彻底从 SessionManager 搬出。
 * - 两种实现是**同级抽象**,不是"主 + 旁路开关":
 *   - ByteStreamStateGetter(fallback):字节流启发式 + quiet 窗口。无 agent 时用。
 *   - AgentStateGetter(pi / claude-code / codex):agent 主动报告 working/settled。权威。
 * - 有 agent 绑定时字节流完全旁路(agent getter 的 onByte 是 no-op),settled
 *   立刻 idle 且不闪(字节尾巴不触发 active)。
 * - idle 定时器 + BETA-006 LLM 复核留 SessionManager(调度 + active→idle 守卫,
 *   只对 byteStream getter 生效)。getter 只管纯启发式判断,不碰定时器/LLM。
 *
 * @对应文档章节:软件定义书 8.3 节(状态机)+ 终端状态分层设计(workspace 文档)
 *
 * @不要在这里做的事:
 * - 不要起定时器(idle 定时器归 SessionManager)
 * - 不要调 LLM(BETA-006 复核归 SessionManager)
 * - 不要直接改 SessionInfo.state(由 SessionManager.applyState 应用 getter 返回值)
 */
import type { SessionState } from '@shared/types';

/**
 * 终端状态判断抽象。事件输入(onXxx)和状态判断(getState)分离:
 * SessionManager 在事件点调 onXxx 通知 getter,随后调 getState() 拉取并应用。
 */
export interface TerminalStateGetter {
  /** 字节到达。ByteStream 走 quiet 窗口判断;Agent 忽略(agent 不因字节变状态)。*/
  onByte(): void;
  /** resize 发生。ByteStream 设 resize quiet;Agent 忽略。*/
  onResize(): void;
  /**
   * 用户输入(sendInput)。ByteStream 设 input echo quiet;Agent 忽略。
   * @param isEnter 是否 Enter(含 \r 或 \n)。Enter 关闭 input quiet(CUR-1:让紧随
   *   的真实命令输出立即触发 active,不等 200ms quiet 窗口)。
   */
  onInput(isEnter: boolean): void;
  /**
   * 拉取当前状态。纯读,基于 getter 内部时间状态判断,无副作用。
   * SessionManager.applyState 调此方法,与当前 SessionInfo.state 比对后决定是否 emit。
   */
  getState(): SessionState;
}
