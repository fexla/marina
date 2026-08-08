/**
 * @file sudo-password-store.test.ts
 * @purpose 守护 SudoPasswordStore 的内存托管契约:
 *   - 纯内存 get/set/has/clear/clearAll 语义。
 *   - has 翻转才 emit changed(重复 set 不重复广播;空串=清除)。
 *   - 密码字符串本身不进任何事件 payload(只回 boolean)。
 *   - 按 profileId 隔离。
 */
import { describe, it, expect, vi } from 'vitest';
import { SudoPasswordStore } from './sudo-password-store';

describe('SudoPasswordStore', () => {
  it('get 未存的 profile 返回 null,has 返回 false', () => {
    const store = new SudoPasswordStore();
    expect(store.has('p1')).toBe(false);
    expect(store.get('p1')).toBeNull();
  });

  it('set 后 has/get 生效,按 profile 隔离', () => {
    const store = new SudoPasswordStore();
    store.set('p1', 'hunter2');
    expect(store.has('p1')).toBe(true);
    expect(store.get('p1')).toBe('hunter2');
    expect(store.has('p2')).toBe(false);
    expect(store.get('p2')).toBeNull();
    expect(store.size()).toBe(1);
  });

  it('首次 set 触发 changed(has=true),重复 set 同 profile 不再广播', () => {
    const store = new SudoPasswordStore();
    const onChange = vi.fn();
    store.on('changed', onChange);
    store.set('p1', 'a');
    store.set('p1', 'b');
    store.set('p2', 'c');
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenNthCalledWith(1, 'p1', true);
    expect(onChange).toHaveBeenNthCalledWith(2, 'p2', true);
  });

  it('clear 已存的 profile 触发 changed(has=false),未存的不广播', () => {
    const store = new SudoPasswordStore();
    store.set('p1', 'x');
    const onChange = vi.fn();
    store.on('changed', onChange);
    store.clear('p2'); // 未存,静默
    store.clear('p1'); // 已存,广播 has=false
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('p1', false);
    expect(store.has('p1')).toBe(false);
    expect(store.get('p1')).toBeNull();
  });

  it('set 空串等价清除(不存空密码,避免 has 误判)', () => {
    const store = new SudoPasswordStore();
    store.set('p1', 'real');
    const onChange = vi.fn();
    store.on('changed', onChange);
    store.set('p1', '');
    expect(store.has('p1')).toBe(false);
    expect(onChange).toHaveBeenCalledWith('p1', false);
  });

  it('set 空 profileId 抛错', () => {
    const store = new SudoPasswordStore();
    expect(() => store.set('', 'x')).toThrow(/sshProfileId/);
  });

  it('clearAll 逐条 emit changed', () => {
    const store = new SudoPasswordStore();
    store.set('p1', 'a');
    store.set('p2', 'b');
    const onChange = vi.fn();
    store.on('changed', onChange);
    store.clearAll();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(store.size()).toBe(0);
    expect(store.has('p1')).toBe(false);
  });

  it('overwrite 已存 profile 不广播但更新值', () => {
    const store = new SudoPasswordStore();
    store.set('p1', 'old');
    const onChange = vi.fn();
    store.on('changed', onChange);
    store.set('p1', 'new');
    expect(onChange).not.toHaveBeenCalled();
    expect(store.get('p1')).toBe('new');
  });
});
