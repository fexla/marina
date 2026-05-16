// [BETA-019 DEBUG] 临时调试模块 — 定位"Claude Code 运行一段时间后输出区出现闪烁光标"。
//
// 假设(经代码静态分析得出):xterm.js 内部 `coreService.isCursorHidden` 被某段
// non-`?25l` escape 序列翻回 false。最强候选是 DECSTR (`\x1b[!p`) 或 RIS
// (`\x1b c`) — 见 xterm InputHandler.ts:2693 / fullReset。Claude Code 启动时
// 发 `?25l` 让 isCursorHidden=true,运行中某次 reset 把它翻回 false,从此光标
// 显示并 blink,直到窗口重启重建 Terminal 实例(isCursorHidden 重新由 ?25l 设回)。
//
// 本文件以最小侵入暴露当前活动 Terminal 实例 + 提供 HUD 组件采样所需的字段。
// 一旦定位 root cause、修复完成,本文件 + 引用它的代码可整块删除。
import type { Terminal } from '@xterm/xterm';

const registry = new Map<string, Terminal>();

export function registerTerminal(sessionId: string, term: Terminal): void {
  registry.set(sessionId, term);
}

export function unregisterTerminal(sessionId: string): void {
  registry.delete(sessionId);
}

export function getTerminal(sessionId: string | null | undefined): Terminal | undefined {
  if (!sessionId) return undefined;
  return registry.get(sessionId);
}

export interface CursorSnapshot {
  cursorHidden: boolean | null;
  cursorInitialized: boolean | null;
  blink: boolean | null;
  style: string | null;
  cursorX: number | null;
  cursorY: number | null;
  bufferY: number | null;
}

// 通过 `_core.coreService` 读 xterm 内部状态。xterm 5.x 没把这些字段挂到公开
// API(Terminal.ts:107 自身也直接走 `this._core.coreService.decPrivateModes`),
// 调试期 `as any` 反射访问是公认手段。
export function sampleCursor(term: Terminal | undefined): CursorSnapshot {
  if (!term) {
    return {
      cursorHidden: null,
      cursorInitialized: null,
      blink: null,
      style: null,
      cursorX: null,
      cursorY: null,
      bufferY: null,
    };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const core = (term as any)._core;
  const coreService = core?.coreService;
  const buf = term.buffer?.active;
  return {
    cursorHidden: coreService?.isCursorHidden ?? null,
    cursorInitialized: coreService?.isCursorInitialized ?? null,
    blink: (term.options.cursorBlink as boolean | undefined) ?? null,
    style: (term.options.cursorStyle as string | undefined) ?? null,
    cursorX: buf?.cursorX ?? null,
    cursorY: buf?.cursorY ?? null,
    bufferY: buf?.baseY ?? null,
  };
}
