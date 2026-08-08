/**
 * @file byte-stream-state-getter.ts
 * @purpose 字节流启发式状态判断(fallback getter)。无 agent 绑定时用。
 *
 * @关键设计:
 * - 封装原 SessionManager 的 quiet 窗口逻辑(resize / startupGrace / inputEcho)
 *   + lastSignificantByte 判断。语义不变,只是从 SessionManager 搬进来,使其
 *   独立可测(原来埋在 handlePtyData 里,测起来要造 PTY 时序)。
 * - onByte:过三种 quiet 窗口才更新 lastSignificantByte(quiet 内字节不点亮)。
 * - getState:startupGrace 期 → idle(BETA-008);lastSignificantByte 近期
 *   (< threshold)→ active;否则 idle。
 * - idle 阈值通过 getThresholdMs 函数读(运行时从 settings 读,settings 变化生效),
 *   不在构造时快照 — 否则用户改 activeIdleThresholdSeconds 要重建 getter。
 *
 * @对应文档章节:CP-3 勘误 #3(resize quiet)/ M1-I(startup grace)/ INPUT_QUIET_MS
 *   (input echo quiet)/ CUR-1(Enter 关闭 quiet)/ BETA-008(grace 期 idle)
 *
 * @不要在这里做的事:
 * - 不要起 idle 定时器(归 SessionManager,到期调 getState 判 idle)
 * - 不要调 LLM(BETA-006 复核归 SessionManager)
 */
import type { SessionState } from '@shared/types';
import type { TerminalStateGetter } from './terminal-state-getter';

export class ByteStreamStateGetter implements TerminalStateGetter {
  /** 过 quiet 窗口的最后一次字节时间戳(ms epoch)。0 = 从未有有效字节。*/
  private lastSignificantByte = 0;
  /** resize quiet 窗口截止 ts。0 = 无窗口(从未 resize)。*/
  private resizeQuietUntil = 0;
  /** 启动 grace 截止 ts。构造时 = now + graceMs。*/
  private readonly startupGraceUntil: number;
  /** input echo quiet 窗口截止 ts。0 = 无窗口。*/
  private inputQuietUntil = 0;

  /**
   * @param graceMs 启动 grace 窗口(ms),构造时 startupGraceUntil = now + graceMs
   * @param resizeQuietMs resize quiet 窗口(ms),onResize 时延展
   * @param inputQuietMs input echo quiet 窗口(ms),onInput(普通键)时延展
   * @param getThresholdMs 读 idle 阈值(ms)的函数 — 运行时从 settings 读,变化生效
   */
  constructor(
    graceMs: number,
    private readonly resizeQuietMs: number,
    private readonly inputQuietMs: number,
    private readonly getThresholdMs: () => number,
  ) {
    this.startupGraceUntil = Date.now() + graceMs;
  }

  onByte(): void {
    const now = Date.now();
    // 三种 quiet 窗口内的字节不更新 lastSignificantByte(不点亮状态):
    //   - startupGrace(M1-I):session 初创 grace 内的 banner/prompt
    //   - resizeQuiet(CP-3 勘误 #3 v2):ConPTY/SIGWINCH 重绘
    //   - inputEchoQuiet(抖动源 C/E):sendInput 后的 echo / TUI 重绘
    if (
      now >= this.startupGraceUntil &&
      now >= this.resizeQuietUntil &&
      now >= this.inputQuietUntil
    ) {
      this.lastSignificantByte = now;
    }
  }

  onResize(): void {
    this.resizeQuietUntil = Date.now() + this.resizeQuietMs;
  }

  onInput(isEnter: boolean): void {
    // CUR-1:Enter(\r/\n)关闭 input quiet,让紧随的真实命令输出立即触发 active
    //   (不等 200ms quiet 窗口,否则用户视角"按 Enter 后命令延迟一拍才显示在跑")。
    //   普通按键(箭头键 / Ctrl-X 等)延展 quiet 窗口(它们是 echo / TUI 重绘源)。
    if (isEnter) {
      this.inputQuietUntil = 0;
    } else {
      this.inputQuietUntil = Date.now() + this.inputQuietMs;
    }
  }

  getState(): SessionState {
    const now = Date.now();
    // BETA-008:startupGrace 期内强制 idle(banner/prompt 不点亮,新建终端不闪绿)。
    if (now < this.startupGraceUntil) return 'idle';
    // 近期有有效字节(过 quiet 的)→ active;阈值无字节 → idle。
    if (
      this.lastSignificantByte > 0 &&
      now - this.lastSignificantByte < this.getThresholdMs()
    ) {
      return 'active';
    }
    return 'idle';
  }
}
