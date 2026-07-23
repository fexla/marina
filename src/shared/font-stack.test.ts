/**
 * @file src/shared/font-stack.test.ts
 * @purpose 守护 buildTerminalFontStack 的两条关键不变量(见 font-stack.ts 头注释):
 *   1. 内置 Nerd Font 一定排在通用 `monospace` 之前(否则 PUA 图标会被通用
 *      等宽字体的缺字字形截胡,图标仍是方块)。
 *   2. 用户自定义回退夹在主字体与内置符号字体之间(优先级:主 > 回退 > 内置)。
 *
 *   另覆盖:空值兜底、存量 settings 末尾带裸 monospace 的兼容。
 */
import { describe, expect, it } from 'vitest';
import { BUILTIN_FALLBACK_FONT, DEFAULT_TERMINAL_FONT, buildTerminalFontStack } from './font-stack';

describe('buildTerminalFontStack', () => {
  it('用户主字体为空时回退到默认链', () => {
    const stack = buildTerminalFontStack(undefined, undefined);
    expect(stack).toContain((DEFAULT_TERMINAL_FONT.replace(/'/g, '').split(',')[0] ?? '').trim());
    expect(stack.endsWith('monospace')).toBe(true);
  });

  it('内置 Nerd Font 一定排在通用 monospace 之前(不变量 1)', () => {
    // 无论用户怎么填,内置符号字体都必须在最后的 monospace 前。
    const cases = [
      [undefined, undefined],
      ['Cascadia Mono', undefined],
      ["'Cascadia Mono', Consolas", undefined],
      ['Fira Code', "'Noto Color Emoji'"],
    ] as const;
    for (const [f, fb] of cases) {
      const stack = buildTerminalFontStack(f, fb);
      const nerdIdx = stack.indexOf(BUILTIN_FALLBACK_FONT);
      const monoIdx = stack.lastIndexOf('monospace');
      expect(nerdIdx).toBeGreaterThan(-1);
      expect(monoIdx).toBeGreaterThan(nerdIdx);
    }
  });

  it('用户自定义回退夹在主字体与内置符号字体之间(不变量 2)', () => {
    const stack = buildTerminalFontStack('Cascadia Mono', "'JetBrainsMono Nerd Font'");
    const primaryIdx = stack.indexOf('Cascadia Mono');
    const fallbackIdx = stack.indexOf('JetBrainsMono Nerd Font');
    const nerdIdx = stack.indexOf(BUILTIN_FALLBACK_FONT);
    expect(primaryIdx).toBeLessThan(fallbackIdx);
    expect(fallbackIdx).toBeLessThan(nerdIdx);
  });

  it('用户自定义回退为空时不插入该段', () => {
    const stack = buildTerminalFontStack('Cascadia Mono', '   ');
    // 主字体后应直接是内置符号字体,中间没有多余的空段 / 逗号。
    expect(stack).toBe(`Cascadia Mono, '${BUILTIN_FALLBACK_FONT}', monospace`);
  });

  it('存量 settings 主字体末尾带裸 monospace 时被剥掉并统一补回尾部(不变量 1 不被破坏)', () => {
    // 历史默认值末尾带 monospace;老用户 settings.json 里可能存着这个值。
    const legacy = "'Cascadia Mono', 'JetBrains Mono', monospace";
    const stack = buildTerminalFontStack(legacy, undefined);
    // 内置符号字体必须在最后的 monospace 之前,且不应出现两个连续 monospace。
    const nerdIdx = stack.indexOf(BUILTIN_FALLBACK_FONT);
    const lastMonoIdx = stack.lastIndexOf('monospace');
    expect(lastMonoIdx).toBeGreaterThan(nerdIdx);
    // 全串里 `monospace` 只应出现一次(尾部那个)。
    const monoCount = (stack.match(/monospace/gi) ?? []).length;
    expect(monoCount).toBe(1);
  });

  it('主字体仅一个裸 monospace 时不崩,且内置符号字体仍在它之前', () => {
    const stack = buildTerminalFontStack('monospace', undefined);
    expect(stack).toBe(`'${BUILTIN_FALLBACK_FONT}', monospace`);
  });
});
