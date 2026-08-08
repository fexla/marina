import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { RuntimeLifecycleCoordinator } from './runtime-lifecycle-coordinator';

// SessionManager 是 EventEmitter,测试用裸 EventEmitter 作最小事件源(满足
// SessionLifecycleEventSource 的结构子类型)。
function makeBus(): EventEmitter {
  return new EventEmitter();
}

describe('RuntimeLifecycleCoordinator', () => {
  it('sessionOwnerChanged → 只调 onOwnerChanged', () => {
    const bus = makeBus();
    const coord = new RuntimeLifecycleCoordinator(bus);
    const ownerChanged = vi.fn();
    const exited = vi.fn();
    const destroyed = vi.fn();
    coord.register({ onOwnerChanged: ownerChanged, onExited: exited, onDestroyed: destroyed });

    bus.emit('sessionOwnerChanged', { sessionId: 's1' });

    expect(ownerChanged).toHaveBeenCalledWith('s1');
    expect(exited).not.toHaveBeenCalled();
    expect(destroyed).not.toHaveBeenCalled();
  });

  it('sessionExited → 只调 onExited', () => {
    const bus = makeBus();
    const coord = new RuntimeLifecycleCoordinator(bus);
    const ownerChanged = vi.fn();
    const exited = vi.fn();
    const destroyed = vi.fn();
    coord.register({ onOwnerChanged: ownerChanged, onExited: exited, onDestroyed: destroyed });

    bus.emit('sessionExited', { sessionId: 's2' });

    expect(exited).toHaveBeenCalledWith('s2');
    expect(ownerChanged).not.toHaveBeenCalled();
    expect(destroyed).not.toHaveBeenCalled();
  });

  it('sessionDestroyed → 只调 onDestroyed', () => {
    const bus = makeBus();
    const coord = new RuntimeLifecycleCoordinator(bus);
    const destroyed = vi.fn();
    coord.register({ onDestroyed: destroyed });

    bus.emit('sessionDestroyed', { sessionId: 's3' });

    expect(destroyed).toHaveBeenCalledWith('s3');
  });

  it('未注册的可选 handler 不报错(空 handlers 对象)', () => {
    const bus = makeBus();
    const coord = new RuntimeLifecycleCoordinator(bus);
    coord.register({});

    expect(() => bus.emit('sessionDestroyed', { sessionId: 's4' })).not.toThrow();
  });

  it('多次 register 的 handler 都被调用(注册顺序)', () => {
    const bus = makeBus();
    const coord = new RuntimeLifecycleCoordinator(bus);
    const order: string[] = [];
    coord.register({ onDestroyed: (sid) => order.push(`a:${sid}`) });
    coord.register({ onDestroyed: (sid) => order.push(`b:${sid}`) });

    bus.emit('sessionDestroyed', { sessionId: 's5' });

    expect(order).toEqual(['a:s5', 'b:s5']);
  });

  it('单个 handler 抛错不阻断后续 handler(隔离 + 继续)', () => {
    const bus = makeBus();
    const coord = new RuntimeLifecycleCoordinator(bus);
    const throwing = vi.fn(() => {
      throw new Error('boom');
    });
    const after = vi.fn();
    coord.register({ onDestroyed: throwing });
    coord.register({ onDestroyed: after });

    expect(() => bus.emit('sessionDestroyed', { sessionId: 's6' })).not.toThrow();
    expect(throwing).toHaveBeenCalledWith('s6');
    expect(after).toHaveBeenCalledWith('s6');
  });

  it('同一 lifecycle event 多 handler + 混合其他事件互不干扰', () => {
    const bus = makeBus();
    const coord = new RuntimeLifecycleCoordinator(bus);
    const log: string[] = [];
    coord.register({
      onOwnerChanged: (sid) => log.push(`owner:${sid}`),
      onDestroyed: (sid) => log.push(`destroyed:${sid}`),
    });
    // 这个只关心 exited
    coord.register({ onExited: (sid) => log.push(`exited:${sid}`) });

    bus.emit('sessionOwnerChanged', { sessionId: 's7' });
    bus.emit('sessionExited', { sessionId: 's7' });
    bus.emit('sessionDestroyed', { sessionId: 's7' });

    expect(log).toEqual(['owner:s7', 'exited:s7', 'destroyed:s7']);
  });
});
