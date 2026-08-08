import { describe, it, expect } from 'vitest';
import { AgentStateGetter } from './agent-state-getter';

describe('AgentStateGetter', () => {
  it('默认 idle(agent 刚绑定、还没 working)', () => {
    const g = new AgentStateGetter();
    expect(g.getState()).toBe('idle');
  });

  it('onWorking → active', () => {
    const g = new AgentStateGetter();
    g.onWorking();
    expect(g.getState()).toBe('active');
  });

  it('onSettled → 立刻 idle(agent 权威,不等字节流阈值)', () => {
    const g = new AgentStateGetter();
    g.onWorking();
    expect(g.getState()).toBe('active');
    g.onSettled();
    expect(g.getState()).toBe('idle');
  });

  it('onByte/onResize/onInput 是 no-op:字节流完全旁路(agent 接管)', () => {
    const g = new AgentStateGetter();
    g.onWorking();
    g.onByte();
    g.onResize();
    g.onInput(false);
    g.onInput(true);
    expect(g.getState()).toBe('active'); // 字节/resize/输入都没改变 working
    g.onSettled();
    expect(g.getState()).toBe('idle');
  });

  it('settled 后字节尾巴不触发 active(agent getter 忽略字节,不闪)', () => {
    const g = new AgentStateGetter();
    g.onWorking();
    g.onSettled(); // idle
    g.onByte(); // 字节尾巴
    g.onByte();
    expect(g.getState()).toBe('idle'); // 仍 idle,字节被忽略
  });
});
