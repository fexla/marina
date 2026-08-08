/**
 * @file agent-state-getter.ts
 * @purpose agent 权威状态判断(pi / claude-code / codex 绑定时用)。
 *
 * @关键设计:
 * - agent 主动报告 working/settled,这是**权威**状态信号 —— 不走字节流启发式。
 * - onByte/onResize/onInput 全 no-op:agent 接管时字节流完全旁路,settled 立刻
 *   idle 且不闪(字节尾巴不触发 active,因为 onByte 是 no-op)。
 * - working/settled 是 agent 专有方法(不在基础 TerminalStateGetter 接口),
 *   由对应 Coordinator(pi / claude-code / codex)直接调 —— 它们持有 getter 引用。
 *
 * @对应文档章节:v0.3.3 ADR-028(pi 终端状态)+ 终端状态分层设计(workspace 文档)
 *
 * @不要在这里做的事:
 * - 不要因字节变状态(字节是 fallback 启发式,agent 权威时不参与)
 */
import type { SessionState } from '@shared/types';
import type { TerminalStateGetter } from './terminal-state-getter';

export class AgentStateGetter implements TerminalStateGetter {
  /** agent 是否正在工作。working → active,settled → idle。*/
  private working = false;

  // 字节 / resize / 输入事件全部忽略:agent 接管时字节流完全旁路。
  // 签名带 isEnter 以匹配接口(AgentStateGetter 忽略它 — agent 不因输入变状态)。
  onByte(): void {}
  onResize(): void {}
  onInput(_isEnter: boolean): void {}

  /** agent 开始工作 → 状态 active。由对应 Coordinator 调。*/
  onWorking(): void {
    this.working = true;
  }

  /** agent 这轮完成(settled)→ 状态 idle(立刻,agent 权威)。由对应 Coordinator 调。*/
  onSettled(): void {
    this.working = false;
  }

  getState(): SessionState {
    return this.working ? 'active' : 'idle';
  }
}
