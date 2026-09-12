/**
 * @file src/renderer/terminal-link-tooltip.ts
 * @purpose 终端链接(OSC 8 / []())hover 时在 xterm 元素内挂一个轻量 DOM tooltip
 *   (方案-终端可交互链接-20260912)。xterm 对 OSC 8 只有下划线 + 指针光标,
 *   没有内置 tooltip;官方 typings 建议的模式是「在 Terminal.element 里建元素
 *   并加 xterm-hover class」(该 class 让鼠标事件不被 xterm linkifier 二次处理)。
 *
 * @为什么必须有:bridge transformer 会把超长 URL 的 label 缩短成「域名+尾段」,
 *   marina:run 链接点击直接执行(ADR-035 无确认)—— tooltip 是唯一「点击前
 *   看到完整目标」的知情通道。
 *
 * @实现约束:
 * - 只用 textContent 写内容(不 innerHTML,零注入面);
 * - pointer-events:none —— tooltip 永不吞鼠标、不会顶掉 leave 回调造成闪烁;
 * - 单例:每次 show 先移除旧节点;term dispose 时节点随宿主一起移除。
 */
import type { Terminal } from '@xterm/xterm';

const TOOLTIP_CLASS = 'marina-terminal-link-tooltip';

/** 显示(或移动)tooltip。host 不可用(term 未 open/dispose 中)时静默 no-op。 */
export function showTerminalLinkTooltip(
  term: Terminal,
  event: { clientX: number; clientY: number },
  text: string,
): void {
  const host = term.element;
  if (!host) return;
  hideTerminalLinkTooltip(term);
  const tip = document.createElement('div');
  tip.className = `xterm-hover ${TOOLTIP_CLASS}`;
  tip.textContent = text;
  host.appendChild(tip);
  // 相对 xterm 元素定位;clamp 到容器内,避免贴边溢出。
  const rect = host.getBoundingClientRect();
  const left = event.clientX - rect.left + 12;
  const top = event.clientY - rect.top + 14;
  tip.style.left = `${Math.max(4, left)}px`;
  tip.style.top = `${Math.max(4, top)}px`;
}

/** 移除当前 tooltip(linkHandler.leave / click 后调用)。 */
export function hideTerminalLinkTooltip(term: Terminal): void {
  term.element?.querySelectorAll(`.${TOOLTIP_CLASS}`).forEach((el) => el.remove());
}
