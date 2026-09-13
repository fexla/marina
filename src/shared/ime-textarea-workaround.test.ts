/**
 * @file src/shared/ime-textarea-workaround.test.ts
 * @purpose IME-1 workaround 护栏测试 — 防止未来 xterm 升级 / TerminalView
 *   重构时悄悄删掉 compositionend 兜底清空。
 *
 *   注意:这不是"复现 bug 的测试"。中文 IME 在终端里冲刷一大段历史的根因
 *   在 @xterm/xterm CompositionHelper 的内部 race(详见
 *   docs/issues/ime-1-*.md),依赖 OS 级 IME 行为 + setTimeout(0) 嵌套时序,
 *   在 Node 环境里既复现不出来也没有意义。这里只测我们写的 workaround
 *   "**还在生效**" — 即:
 *   1. compositionend 触发后,延迟内 textarea 没被立即清空(不能抢在
 *      xterm 自己的 substring 读取窗口之前,否则会吞输入)
 *   2. 延迟到期后 textarea.value 被清空
 *   3. 多次 compositionend 快速触发不会累计 setTimeout 风暴
 *   4. detach 后不再清空
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  attachImeCompositionEndCleaner,
  type AttachOptions,
  type ImeTextareaLike,
} from './ime-textarea-workaround';

/**
 * Fake textarea — 只实现 workaround 需要的 surface:
 * - value 读写
 * - addEventListener / removeEventListener('compositionend', ...)
 * - dispatch() 手动触发事件,模拟 IME 提交
 */
class FakeTextarea implements ImeTextareaLike {
  value = '';
  private listeners = new Set<() => void>();

  addEventListener(type: 'compositionend', listener: () => void): void {
    if (type !== 'compositionend') return;
    this.listeners.add(listener);
  }

  removeEventListener(type: 'compositionend', listener: () => void): void {
    if (type !== 'compositionend') return;
    this.listeners.delete(listener);
  }

  /** 模拟浏览器触发 compositionend */
  dispatch(): void {
    for (const l of this.listeners) l();
  }

  /** 测试辅助:listener 还在挂着的数量 */
  listenerCount(): number {
    return this.listeners.size;
  }
}

describe('attachImeCompositionEndCleaner (IME-1 workaround 护栏)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('compositionend 触发后,延迟内 textarea 不被立即清空 (不能抢 xterm 的 substring 窗口)', () => {
    const ta = new FakeTextarea();
    ta.value = '历史累积的一大段中文'.repeat(20);
    attachImeCompositionEndCleaner(ta, { delayMs: 16 });

    ta.dispatch();

    // 同步路径不能清空 — 否则会把当次 IME 输入也吞掉
    expect(ta.value.length).toBeGreaterThan(0);

    // 即使过了一点点,只要没到 delayMs 也不能清
    vi.advanceTimersByTime(15);
    expect(ta.value.length).toBeGreaterThan(0);
  });

  it('延迟到期后 textarea.value 被清空', () => {
    const ta = new FakeTextarea();
    ta.value = '历史累积';
    attachImeCompositionEndCleaner(ta, { delayMs: 16 });

    ta.dispatch();
    vi.advanceTimersByTime(16);

    expect(ta.value).toBe('');
  });

  it('默认延迟为 16ms', () => {
    const ta = new FakeTextarea();
    ta.value = 'x';
    attachImeCompositionEndCleaner(ta);

    ta.dispatch();
    vi.advanceTimersByTime(15);
    expect(ta.value).toBe('x');
    vi.advanceTimersByTime(1);
    expect(ta.value).toBe('');
  });

  it('连续多次 compositionend 不累积 setTimeout 风暴 (后到的覆盖前面 pending 的)', () => {
    const ta = new FakeTextarea();
    attachImeCompositionEndCleaner(ta, { delayMs: 16 });

    // 5 次快速 compositionend(连按 5 个标点)
    for (let i = 0; i < 5; i++) {
      ta.value = `累积_${i}`;
      ta.dispatch();
      vi.advanceTimersByTime(5); // 远小于 16,模拟"还没清就来下一个"
    }

    // 这里 5 个 setTimeout 应该被合并成"最后一个"
    // 距最后一次 dispatch 已过 5ms,再等 11ms 应清空
    vi.advanceTimersByTime(11);
    expect(ta.value).toBe('');
  });

  it('detach 后不再清空,且没有泄漏 listener', () => {
    const ta = new FakeTextarea();
    ta.value = '保留';
    const detach = attachImeCompositionEndCleaner(ta, { delayMs: 16 });
    expect(ta.listenerCount()).toBe(1);

    detach();
    expect(ta.listenerCount()).toBe(0);

    // detach 后再 dispatch 不会清空
    ta.dispatch();
    vi.advanceTimersByTime(100);
    expect(ta.value).toBe('保留');
  });

  it('detach 时已 pending 的清空也会被取消 (避免组件 unmount 后还在改 textarea)', () => {
    const ta = new FakeTextarea();
    ta.value = '保留';
    const detach = attachImeCompositionEndCleaner(ta, { delayMs: 16 });

    ta.dispatch(); // 排了一个 pending
    vi.advanceTimersByTime(10); // 还没到期
    detach(); // 这时 detach
    vi.advanceTimersByTime(100); // 让原本的 pending"假装到期"

    // pending 应被 clearTimeout 取消,textarea 保留原值
    expect(ta.value).toBe('保留');
  });

  it('支持注入自定义 timer (生产代码用 window.setTimeout,测试用 fake — 此处验证 injection 路径本身)', () => {
    const ta = new FakeTextarea();
    ta.value = 'x';

    const fakeSetTimeout = vi.fn(
      (fn: () => void, _ms: number) => setTimeout(fn, 0) as unknown as number,
    );
    const fakeClearTimeout = vi.fn((h: number) =>
      clearTimeout(h as unknown as ReturnType<typeof setTimeout>),
    );

    attachImeCompositionEndCleaner(ta, {
      delayMs: 16,
      // mock 的断言目标直接取 AttachOptions 字段类型:TimeoutHandle 在
      // DOM/Node 双端解析出不同联合(见 ime-textarea-workaround.ts 定义注释),
      // 写死任何一端的形状都会在另一端逆变打架。
      setTimeoutFn: fakeSetTimeout as unknown as NonNullable<AttachOptions['setTimeoutFn']>,
      clearTimeoutFn: fakeClearTimeout as unknown as NonNullable<
        AttachOptions['clearTimeoutFn']
      >,
    });

    ta.dispatch();
    expect(fakeSetTimeout).toHaveBeenCalledTimes(1);
    expect(fakeSetTimeout.mock.calls[0]?.[1]).toBe(16);
  });
});
