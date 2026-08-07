/**
 * @file src/main/app-lifecycle.test.ts
 * @purpose app-lifecycle.ts 退出状态机单测。
 *
 * @关键设计:
 * - 模块级可变 state,测试间用 vi.resetModules() 重载,避免状态泄漏。
 * - 覆盖:初始 running、合法单向转移、非法转移忽略、enterQuiescing 幂等、
 *   setQuitting 语义、getIsQuitting / isQuiescing / getLifecycleState 查询。
 *
 * @对应文档章节:架构复核 H4;AGENTS.md 第 5 章(后端必测)
 *
 * @不要在这里做的事:
 * - 不要测退出编排顺序(那是 index.ts before-quit 的职责,index.ts 被 coverage
 *   排除且依赖完整 Electron app)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AppLifecycleModule from './app-lifecycle';

type LifecycleModule = typeof AppLifecycleModule;

/** 每次重载 app-lifecycle,拿到全新 state。 */
async function freshLifecycle(): Promise<LifecycleModule> {
  vi.resetModules();
  return (await import('./app-lifecycle')) as LifecycleModule;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('app-lifecycle 退出状态机', () => {
  it('初始状态为 running,isQuiescing/getIsQuitting 均为 false', async () => {
    const m = await freshLifecycle();
    expect(m.getLifecycleState()).toBe('running');
    expect(m.isQuiescing()).toBe(false);
    expect(m.getIsQuitting()).toBe(false);
  });

  it('合法单向转移 running→quiescing→flushing→stopped 全部生效', async () => {
    const m = await freshLifecycle();
    m.enterQuiescing();
    expect(m.getLifecycleState()).toBe('quiescing');
    expect(m.isQuiescing()).toBe(true);
    expect(m.getIsQuitting()).toBe(true);

    m.enterFlushing();
    expect(m.getLifecycleState()).toBe('flushing');

    m.enterStopped();
    expect(m.getLifecycleState()).toBe('stopped');
    expect(m.isQuiescing()).toBe(true);
  });

  it('enterQuiescing 幂等:重复调用停留在 quiescing,不再前移', async () => {
    const m = await freshLifecycle();
    m.enterQuiescing();
    m.enterQuiescing();
    m.enterQuiescing();
    expect(m.getLifecycleState()).toBe('quiescing');
  });

  it('非法转移被忽略:running 不能直接进 flushing/stopped', async () => {
    const m = await freshLifecycle();
    m.enterFlushing(); // running→flushing 非法,忽略
    expect(m.getLifecycleState()).toBe('running');
    m.enterStopped(); // running→stopped 非法,忽略
    expect(m.getLifecycleState()).toBe('running');
  });

  it('stopped 后任何转移都被忽略(退出不可逆)', async () => {
    const m = await freshLifecycle();
    m.enterQuiescing();
    m.enterFlushing();
    m.enterStopped();
    m.enterQuiescing(); // 已在 stopped,回退非法
    expect(m.getLifecycleState()).toBe('stopped');
  });

  it('setQuitting 等价于 enterQuiescing(兼容旧调用方语义)', async () => {
    const m = await freshLifecycle();
    m.setQuitting();
    expect(m.getLifecycleState()).toBe('quiescing');
    expect(m.getIsQuitting()).toBe(true);
    expect(m.isQuiescing()).toBe(true);
  });
});
