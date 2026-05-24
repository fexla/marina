/**
 * @file src/shared/ui-overlay-stack.test.ts
 * @purpose 护栏单测 — overlay 栈的 push / pop / isTop / 乱序 pop 边界。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetOverlayStackForTesting,
  hasAnyOverlay,
  isTopOverlay,
  pushOverlay,
  topOverlayId,
} from './ui-overlay-stack';

beforeEach(() => {
  __resetOverlayStackForTesting();
});

describe('UiOverlayStack — 基础', () => {
  it('空栈时 hasAnyOverlay 为 false, top 为 null', () => {
    expect(hasAnyOverlay()).toBe(false);
    expect(topOverlayId()).toBeNull();
  });

  it('push 后 hasAnyOverlay 为 true, top 是 push 的 id', () => {
    const a = pushOverlay();
    expect(hasAnyOverlay()).toBe(true);
    expect(topOverlayId()).toBe(a.id);
    expect(isTopOverlay(a.id)).toBe(true);
  });

  it('单次 push + pop 后栈空', () => {
    const a = pushOverlay();
    a.pop();
    expect(hasAnyOverlay()).toBe(false);
    expect(isTopOverlay(a.id)).toBe(false);
  });
});

describe('UiOverlayStack — 嵌套', () => {
  it('后 push 的是栈顶, 先 push 的不是', () => {
    const a = pushOverlay();
    const b = pushOverlay();
    expect(isTopOverlay(b.id)).toBe(true);
    expect(isTopOverlay(a.id)).toBe(false);
    expect(topOverlayId()).toBe(b.id);
  });

  it('栈顶 pop 后, 之前的成为新栈顶', () => {
    const a = pushOverlay();
    const b = pushOverlay();
    b.pop();
    expect(isTopOverlay(a.id)).toBe(true);
    expect(topOverlayId()).toBe(a.id);
  });
});

describe('UiOverlayStack — 乱序 pop 容忍', () => {
  it('中间 overlay 先 pop 不影响其他 overlay', () => {
    const a = pushOverlay();
    const b = pushOverlay();
    const c = pushOverlay();
    b.pop(); // 中间被 pop
    expect(isTopOverlay(c.id)).toBe(true);
    expect(isTopOverlay(a.id)).toBe(false);
    c.pop();
    expect(isTopOverlay(a.id)).toBe(true);
  });

  it('重复 pop 同一 id 是 no-op (idempotent)', () => {
    const a = pushOverlay();
    a.pop();
    a.pop();
    expect(hasAnyOverlay()).toBe(false);
  });
});

describe('UiOverlayStack — id 唯一性', () => {
  it('每次 push 返回的 id 都不同', () => {
    const ids = new Set<number>();
    for (let i = 0; i < 10; i++) {
      ids.add(pushOverlay().id);
    }
    expect(ids.size).toBe(10);
  });
});
