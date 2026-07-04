/**
 * @file src/shared/terminal-keybindings.test.ts
 * @purpose 护栏单测 — 确保 terminal-keybindings.ts 的 binding table 与
 *   matchKeybinding 行为符合 spec §7.2.2 的清单。
 *
 *   不测真实 KeyboardEvent / xterm — 这是纯函数,只测匹配逻辑边界。
 *   行为正确性的另一半(dispatch 后的副作用)在 TerminalView.tsx 内由
 *   integration / e2e 覆盖。
 */
import { describe, expect, it } from 'vitest';
import {
  matchKeybinding,
  TERMINAL_KEYBINDINGS,
  type KeyEventLike,
  type KeybindingContext,
} from './terminal-keybindings';

function ev(
  partial: Partial<KeyEventLike> & { key: string },
): KeyEventLike {
  return {
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...partial,
  };
}

const noSearch: KeybindingContext = { searchVisible: false };
const inSearch: KeybindingContext = { searchVisible: true };

describe('matchKeybinding — 复制', () => {
  it('Ctrl+C → copy-or-sigint (不关心选区,选区判定在 dispatch 端)', () => {
    const m = matchKeybinding(ev({ ctrlKey: true, key: 'c' }), noSearch);
    expect(m?.id).toBe('copy-ctrl-c');
    expect(m?.action).toBe('copy-or-sigint');
  });

  it('Cmd+C → copy-or-sigint (macOS 等价)', () => {
    const m = matchKeybinding(ev({ metaKey: true, key: 'c' }), noSearch);
    expect(m?.id).toBe('copy-ctrl-c');
  });

  it('Ctrl+Shift+C → copy-and-clear', () => {
    const m = matchKeybinding(
      ev({ ctrlKey: true, shiftKey: true, key: 'C' }),
      noSearch,
    );
    expect(m?.id).toBe('copy-shift-c');
    expect(m?.action).toBe('copy-and-clear');
  });

  it('Ctrl+Insert → copy-and-clear', () => {
    const m = matchKeybinding(
      ev({ ctrlKey: true, key: 'Insert' }),
      noSearch,
    );
    expect(m?.id).toBe('copy-insert');
    expect(m?.action).toBe('copy-and-clear');
  });
});

describe('matchKeybinding — 粘贴', () => {
  it('Ctrl+V → consume-for-paste (capture listener 实际接管)', () => {
    const m = matchKeybinding(ev({ ctrlKey: true, key: 'v' }), noSearch);
    expect(m?.id).toBe('paste-ctrl-v');
    expect(m?.action).toBe('consume-for-paste');
  });

  it('Ctrl+Shift+V → consume-for-paste', () => {
    const m = matchKeybinding(
      ev({ ctrlKey: true, shiftKey: true, key: 'V' }),
      noSearch,
    );
    expect(m?.id).toBe('paste-shift-v');
  });

  it('Shift+Insert(无 Ctrl) → consume-for-paste', () => {
    const m = matchKeybinding(
      ev({ shiftKey: true, key: 'Insert' }),
      noSearch,
    );
    expect(m?.id).toBe('paste-shift-insert');
  });
});

describe('matchKeybinding — 搜索', () => {
  it('Ctrl+F → open-search', () => {
    const m = matchKeybinding(ev({ ctrlKey: true, key: 'f' }), noSearch);
    expect(m?.id).toBe('open-search');
  });

  it('Cmd+F → open-search (macOS 等价)', () => {
    const m = matchKeybinding(ev({ metaKey: true, key: 'F' }), noSearch);
    expect(m?.id).toBe('open-search');
  });

  it('Ctrl+Shift+F → 不匹配(spec 未列出,避免误吃)', () => {
    expect(
      matchKeybinding(
        ev({ ctrlKey: true, shiftKey: true, key: 'f' }),
        noSearch,
      ),
    ).toBeNull();
  });

  it('Esc 在搜索栏可见时 → close-search', () => {
    const m = matchKeybinding(ev({ key: 'Escape' }), inSearch);
    expect(m?.id).toBe('close-search');
  });

  it('Esc 在搜索栏不可见时 → 不匹配(透传给 PTY,vim 等需要)', () => {
    expect(matchKeybinding(ev({ key: 'Escape' }), noSearch)).toBeNull();
  });
});

describe('matchKeybinding — 修饰键守护', () => {
  it('Ctrl+Alt+C → 不匹配(spec 不允许 Alt 修饰)', () => {
    expect(
      matchKeybinding(
        ev({ ctrlKey: true, altKey: true, key: 'c' }),
        noSearch,
      ),
    ).toBeNull();
  });

  it('裸 C → 不匹配(无 mod)', () => {
    expect(matchKeybinding(ev({ key: 'c' }), noSearch)).toBeNull();
  });

  it('Alt+F → 不匹配(spec 不允许 Alt+F 唤搜索)', () => {
    expect(
      matchKeybinding(ev({ altKey: true, key: 'f' }), noSearch),
    ).toBeNull();
  });

  it('裸 Insert → 不匹配(spec 未列出,透传给 PTY)', () => {
    expect(matchKeybinding(ev({ key: 'Insert' }), noSearch)).toBeNull();
  });
});

describe('TERMINAL_KEYBINDINGS — 表结构', () => {
  it('每个 binding 都有唯一 id', () => {
    const ids = TERMINAL_KEYBINDINGS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每个 binding 都有非空 spec / description', () => {
    for (const b of TERMINAL_KEYBINDINGS) {
      expect(b.spec.length).toBeGreaterThan(0);
      expect(b.description.length).toBeGreaterThan(0);
    }
  });

  it('match.key 全部小写 (matchKeybinding 内 toLowerCase 后比较)', () => {
    for (const b of TERMINAL_KEYBINDINGS) {
      expect(b.match.key).toBe(b.match.key.toLowerCase());
    }
  });

  it('清单覆盖 spec §7.2.2 全部 8 个键位', () => {
    // 防止未来误删某条;增加新条目时同步更新这个数字
    expect(TERMINAL_KEYBINDINGS.length).toBe(8);
  });
});
