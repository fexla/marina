/**
 * @file src/shared/protocol.test.ts
 * @purpose 协议常量的烟雾测试,主要目的是验证 Vitest 配置 + alias + TS 编译链路
 *   全部跑通,作为 CP-1 项目初始化阶段的"框架可用性"基线测试。
 *
 * @对应文档章节: AGENTS.md 5.3 (协议类必测)
 *
 * @CP-1 阶段:
 * 这里只断言不会变的常量。真正的 IPC schema 测试在 CP-2 起,handler 注册
 * 后才有意义。
 */
import { describe, expect, it } from 'vitest';
import {
  COMMAND_CHANNELS,
  EVENT_CHANNELS,
  PROTOCOL_VERSION,
  type CommandEnvelope,
  type EventEnvelope,
} from './protocol';

describe('protocol constants', () => {
  it('PROTOCOL_VERSION is a positive integer', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });

  it('all command channels start with cmd: prefix', () => {
    for (const channel of Object.values(COMMAND_CHANNELS)) {
      expect(channel).toMatch(/^cmd:[a-z-]+:[a-z-]+$/);
    }
  });

  it('all event channels start with evt: prefix', () => {
    // v1.3 起 domain 允许 kebab-case(与 cmd 一致,为容纳 explorer-integration)
    for (const channel of Object.values(EVENT_CHANNELS)) {
      expect(channel).toMatch(/^evt:[a-z-]+:[a-z-]+$/);
    }
  });

  it('command and event channel names are unique', () => {
    const all = [...Object.values(COMMAND_CHANNELS), ...Object.values(EVENT_CHANNELS)];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('envelope shapes (compile-time)', () => {
  // 这些断言主要为编译期类型检查;运行时行为只是 sanity check。
  it('CommandEnvelope has windowId / requestId / payload', () => {
    const envelope: CommandEnvelope<{ foo: number }> = {
      windowId: 'w1',
      requestId: 'r1',
      payload: { foo: 42 },
    };
    expect(envelope.payload.foo).toBe(42);
  });

  it('EventEnvelope has eventId / timestamp / payload', () => {
    const envelope: EventEnvelope<string> = {
      eventId: 'e1',
      timestamp: Date.now(),
      payload: 'hello',
    };
    expect(typeof envelope.timestamp).toBe('number');
    expect(envelope.payload).toBe('hello');
  });
});
