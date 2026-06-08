/**
 * @file src/shared/terminal-unicode-width.test.ts
 * @purpose 护栏测试:Marina 必须在 renderer/headless xterm 上启用官方
 *   Unicode 11 宽度表,否则 cc-switch 等 emoji/CJK TUI 会列宽错位。
 */
import { describe, expect, it } from 'vitest';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { activateMarinaUnicodeWidth } from './terminal-unicode-width';

describe('activateMarinaUnicodeWidth', () => {
  it('loads Unicode11Addon and switches xterm activeVersion to 11', () => {
    const loaded: unknown[] = [];
    const term = {
      unicode: { activeVersion: '6' },
      loadAddon(addon: unknown) {
        loaded.push(addon);
      },
    };

    const activated = activateMarinaUnicodeWidth(term);

    expect(activated).toBe(true);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toBeInstanceOf(Unicode11Addon);
    expect(term.unicode.activeVersion).toBe('11');
  });

  it('returns false for terminal-like objects without unicode API', () => {
    const loaded: unknown[] = [];
    const term = {
      loadAddon(addon: unknown) {
        loaded.push(addon);
      },
    };

    expect(activateMarinaUnicodeWidth(term)).toBe(false);
    expect(loaded).toHaveLength(0);
  });
});
