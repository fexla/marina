/**
 * @file terminal-view-registry.test.ts
 * @purpose 验证终端视图租约的连续性、单目标输出与生命周期清理。
 */
import { describe, expect, it } from 'vitest';
import { TerminalViewRegistry } from './terminal-view-registry';

describe('TerminalViewRegistry', () => {
  it('同一 view 重挂保持 continuous；替换 client/view 要求 replay', () => {
    const registry = new TerminalViewRegistry();
    expect(registry.attach('s1', 'w1', 'v1')).toEqual({ continuous: false });
    expect(registry.attach('s1', 'w1', 'v1')).toEqual({ continuous: true });
    expect(registry.attach('s1', 'w1', 'v2')).toEqual({ continuous: false });
    expect(registry.attach('s1', 'w2', 'v3')).toEqual({ continuous: false });
    expect(registry.count()).toBe(1);
  });

  it('ownerless 输出发 parked view；有 owner 时只发 owner', () => {
    const registry = new TerminalViewRegistry();
    registry.attach('s1', 'w1', 'v1');
    expect(registry.resolveOutputTarget('s1', null)).toBe('w1');
    expect(registry.resolveOutputTarget('s1', 'w1')).toBe('w1');
    expect(registry.resolveOutputTarget('s1', 'w2')).toBe('w2');
  });

  it('别的 owner 收过输出后旧 view 变 discontinuous', () => {
    const registry = new TerminalViewRegistry();
    registry.attach('s1', 'w1', 'v1');
    expect(registry.resolveOutputTarget('s1', 'w2')).toBe('w2');
    // 旧 view 再激活必须得 false,renderer 据此销毁并完整 replay。
    expect(registry.attach('s1', 'w1', 'v1')).toEqual({ continuous: false });
    // attach 后从此刻重新连续。
    expect(registry.attach('s1', 'w1', 'v1')).toEqual({ continuous: true });
  });

  it('旧 view cleanup 不会删掉替代它的新租约', () => {
    const registry = new TerminalViewRegistry();
    registry.attach('s1', 'w1', 'old');
    registry.attach('s1', 'w1', 'new');
    registry.detach('s1', 'w1', 'old');
    expect(registry.resolveOutputTarget('s1', null)).toBe('w1');
  });

  it('按 session/client 显式清理', () => {
    const registry = new TerminalViewRegistry();
    registry.attach('s1', 'w1', 'v1');
    registry.attach('s2', 'w1', 'v2');
    registry.attach('s3', 'w2', 'v3');
    registry.removeSession('s1');
    expect(registry.count()).toBe(2);
    registry.removeClient('w1');
    expect(registry.count()).toBe(1);
    expect(registry.resolveOutputTarget('s3', null)).toBe('w2');
  });
});
