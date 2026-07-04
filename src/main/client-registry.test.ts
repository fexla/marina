/**
 * @file src/main/client-registry.test.ts
 * @purpose ClientRegistry 单测:覆盖 add/remove/get/has/list/count、
 *   broadcast(全发 + 单 client 失败隔离)、sendTo(定向 + 找不到静默)、
 *   onClose 回调(正常 + 抛错不影响 registry)、重复注册报错。
 *
 * @测试策略:用 fake ClientTransport(收集 send 调用到数组)替代真实 webContents/WS,
 *   纯逻辑验证,无 electron / ws 依赖。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventEnvelope } from '../shared/protocol';
import { ClientRegistry, type ClientTransport } from './client-registry';

/** 造一个 fake transport:记录所有 send 调用,可注入可抛错的 send。 */
function makeFake(
  clientId: string,
  opts: { sendThrows?: boolean; onClose?: () => void } = {},
): ClientTransport & { calls: Array<{ channel: string; envelope: unknown }> } {
  const calls: Array<{ channel: string; envelope: unknown }> = [];
  // exactOptionalPropertyTypes:true 下,onClose 不能赋 undefined 值,
  // 用条件展开:属性要么存在(有值)要么不存在。
  const t = {
    clientId,
    send(channel: string, envelope: EventEnvelope) {
      if (opts.sendThrows) throw new Error(`fake send throw for ${clientId}`);
      calls.push({ channel, envelope });
    },
    ...(opts.onClose ? { onClose: opts.onClose } : {}),
    calls,
  };
  return t satisfies ClientTransport & { calls: typeof calls };
}

describe('ClientRegistry — 基础 CRUD', () => {
  let r: ClientRegistry;
  beforeEach(() => {
    r = new ClientRegistry();
  });

  it('add 后 get/has/count 正确', () => {
    const t = makeFake('w1');
    r.add(t);
    expect(r.has('w1')).toBe(true);
    expect(r.get('w1')).toBe(t);
    expect(r.count()).toBe(1);
  });

  it('get 未注册返回 undefined; has 返回 false', () => {
    expect(r.get('nope')).toBeUndefined();
    expect(r.has('nope')).toBe(false);
  });

  it('list 返回快照数组,后续 add 不影响已返回数组', () => {
    r.add(makeFake('w1'));
    const list = r.list();
    r.add(makeFake('w2'));
    expect(list).toHaveLength(1);
    expect(r.list()).toHaveLength(2);
  });

  it('remove 后 get 返回 undefined,count 递减', () => {
    r.add(makeFake('w1'));
    r.remove('w1');
    expect(r.has('w1')).toBe(false);
    expect(r.count()).toBe(0);
  });

  it('remove 未注册的 clientId 幂等(静默返回)', () => {
    expect(() => r.remove('never-added')).not.toThrow();
  });
});

describe('ClientRegistry — 重复注册', () => {
  it('重复 add 同 clientId 抛错(本地窗口编号异常 / WS 握手未查重的兜底)', () => {
    const r = new ClientRegistry();
    r.add(makeFake('w1'));
    expect(() => r.add(makeFake('w1'))).toThrow(/已注册/);
    expect(r.count()).toBe(1); // 第二次 add 失败,不应改变 registry
  });
});

describe('ClientRegistry — onClose 回调', () => {
  it('remove 触发 onClose', () => {
    const r = new ClientRegistry();
    const onClose = vi.fn();
    r.add(makeFake('w1', { onClose }));
    r.remove('w1');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('onClose 抛错不影响 registry(remove 仍完成,count 正确)', () => {
    const r = new ClientRegistry();
    const boom = vi.fn(() => {
      throw new Error('onClose boom');
    });
    r.add(makeFake('w1', { onClose: boom }));
    expect(() => r.remove('w1')).not.toThrow();
    expect(r.count()).toBe(0);
  });

  it('remove 未注册的 clientId 不触发任何 onClose', () => {
    const r = new ClientRegistry();
    const onClose = vi.fn();
    r.add(makeFake('w1', { onClose }));
    r.remove('w2'); // 不存在
    expect(onClose).not.toHaveBeenCalled();
    expect(r.count()).toBe(1);
  });
});

describe('ClientRegistry — broadcast', () => {
  it('broadcast 发给所有已注册 client,channel + payload 正确', () => {
    const r = new ClientRegistry();
    const a = makeFake('a');
    const b = makeFake('b');
    const c = makeFake('c');
    r.add(a);
    r.add(b);
    r.add(c);
    r.broadcast('evt:test', { hello: 'world' });
    for (const t of [a, b, c]) {
      expect(t.calls).toHaveLength(1);
      expect(t.calls[0]!.channel).toBe('evt:test');
      expect(t.calls[0]!.envelope).toMatchObject({
        payload: { hello: 'world' },
      });
    }
  });

  it('每次 broadcast 生成新的 eventId / timestamp(事件去重的基础)', () => {
    const r = new ClientRegistry();
    const a = makeFake('a');
    r.add(a);
    r.broadcast('evt:x', { n: 1 });
    r.broadcast('evt:x', { n: 2 });
    const e1 = a.calls[0]!.envelope as { eventId: string; timestamp: number };
    const e2 = a.calls[1]!.envelope as { eventId: string; timestamp: number };
    expect(e1.eventId).not.toBe(e2.eventId);
    expect(e2.timestamp).toBeGreaterThanOrEqual(e1.timestamp);
  });

  it('单个 client send 抛错不拖垮其他 client(尽力发语义)', () => {
    const r = new ClientRegistry();
    const a = makeFake('a');
    const boom = makeFake('boom', { sendThrows: true });
    const c = makeFake('c');
    r.add(a);
    r.add(boom);
    r.add(c);
    expect(() => r.broadcast('evt:x', {})).not.toThrow();
    expect(a.calls).toHaveLength(1); // boom 失败不影响 a、c
    expect(c.calls).toHaveLength(1);
  });

  it('broadcast 给空 registry 不报错', () => {
    const r = new ClientRegistry();
    expect(() => r.broadcast('evt:x', {})).not.toThrow();
  });
});

describe('ClientRegistry — sendTo', () => {
  it('sendTo 定向发给指定 clientId,其他 client 收不到', () => {
    const r = new ClientRegistry();
    const a = makeFake('a');
    const b = makeFake('b');
    r.add(a);
    r.add(b);
    r.sendTo('a', 'evt:private', { only: 'a' });
    expect(a.calls).toHaveLength(1);
    expect(a.calls[0]!.envelope).toMatchObject({ payload: { only: 'a' } });
    expect(b.calls).toHaveLength(0);
  });

  it('sendTo 未注册 clientId 静默返回(对应原 sendEventTo destroyed window 的 guard)', () => {
    const r = new ClientRegistry();
    expect(() => r.sendTo('nope', 'evt:x', {})).not.toThrow();
  });

  it('sendTo 目标 send 抛错被吞(与 broadcast 同策略:尽力发,WS/webContents 瞬时失败不拖垮调用方)', () => {
    const r = new ClientRegistry();
    r.add(makeFake('boom', { sendThrows: true }));
    expect(() => r.sendTo('boom', 'evt:x', {})).not.toThrow();
  });
});
