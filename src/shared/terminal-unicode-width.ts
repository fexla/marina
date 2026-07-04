/**
 * @file src/shared/terminal-unicode-width.ts
 * @purpose 在 renderer xterm 与 main headless xterm 上启用同一套现代 Unicode
 *   宽度规则,避免远端/WSL TUI 在 emoji/CJK 混排时发生列宽分歧。
 *
 * @关键设计:
 * - xterm 5.5 默认 UnicodeV6 会把很多 emoji 当 1 列;Linux/WSL/SSH 侧
 *   ncurses/Rust/Go TUI 常按更新的 wcwidth 把这些符号当 2 列
 * - 使用 xterm 官方 @xterm/addon-unicode11,不在 Marina 内自维护 Unicode 表
 * - renderer 与 headless replay 都必须启用同一 provider,否则重挂回放会
 *   与 live 渲染在光标位置上再次分叉
 *
 * @对应文档章节: 软件定义书.md 5.1.4 终端体验
 */
import { Unicode11Addon } from '@xterm/addon-unicode11';

const UNICODE11_VERSION = '11';

export interface UnicodeWidthTerminal {
  loadAddon(addon: Unicode11Addon): void;
  unicode?: {
    activeVersion: string;
  };
}

/**
 * 启用 xterm 官方 Unicode 11 宽度表。
 *
 * @returns true 表示已切到 Unicode 11;false 表示当前终端对象缺少 unicode API。
 */
export function activateMarinaUnicodeWidth(term: UnicodeWidthTerminal): boolean {
  if (!term.unicode) return false;
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = UNICODE11_VERSION;
  return true;
}
