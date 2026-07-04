/**
 * @file src/main/platform/index.test.ts
 * @purpose 验证 getPlatformAdapter 的分发逻辑:Windows 返回 WindowsAdapter,
 *   macOS / Linux throw 带"Contributions welcome"提示,未知平台 throw。
 *
 * @关键设计:
 * - 测试通过 Object.defineProperty 临时覆盖 process.platform
 *   (Node 20 上是 getter,但 configurable 仍 true)
 * - 每个 case 测完用 __setPlatformAdapterForTest(null) 重置缓存
 *
 * @对应文档章节: 软件定义书.md 12 (跨平台策略);AGENTS.md 8.1
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __setPlatformAdapterForTest, getPlatformAdapter } from './index';
import { WindowsAdapter } from './windows';

const originalPlatform = process.platform;

function setPlatform(value: NodeJS.Platform | string): void {
  Object.defineProperty(process, 'platform', {
    value,
    configurable: true,
    writable: false,
  });
}

describe('getPlatformAdapter', () => {
  beforeEach(() => {
    __setPlatformAdapterForTest(null);
  });

  afterEach(() => {
    __setPlatformAdapterForTest(null);
    setPlatform(originalPlatform);
  });

  it('Windows 返回 WindowsAdapter 实例', () => {
    setPlatform('win32');
    const adapter = getPlatformAdapter();
    expect(adapter).toBeInstanceOf(WindowsAdapter);
  });

  it('macOS throw 带 "Contributions welcome" 提示', () => {
    setPlatform('darwin');
    expect(() => getPlatformAdapter()).toThrow(
      /macOS.*not implemented.*Contributions welcome/,
    );
  });

  it('Linux 返回 LinuxAdapter,lifecycleModel=no-persistence (BETA-003a)', () => {
    setPlatform('linux');
    const adapter = getPlatformAdapter();
    expect(adapter).toBeDefined();
    expect(adapter.lifecycleModel).toBe('no-persistence');
  });

  it('未知平台 throw 带平台名', () => {
    setPlatform('aix' as NodeJS.Platform);
    expect(() => getPlatformAdapter()).toThrow(/Unsupported.*"aix"/);
  });

  it('Windows 上重复调用返回同一实例 (缓存)', () => {
    setPlatform('win32');
    const a = getPlatformAdapter();
    const b = getPlatformAdapter();
    expect(a).toBe(b);
  });

  it('__setPlatformAdapterForTest 替换缓存的 adapter', () => {
    const fakeAdapter = {
      lifecycleModel: 'no-persistence' as const,
      detectShells: async () => [],
      resolveExecutable: (commandName: string) => commandName,
      buildShellLaunchParams: () => ({ args: [], env: {} }),
      registerFileManagerIntegration: async () => {},
      unregisterFileManagerIntegration: async () => {},
      getProcessCwd: async () => null,
      setAutoStart: async () => {},
      isAutoStartEnabled: async () => false,
      getRefreshedPath: () => process.env.PATH ?? '',
      normalizeSpawnEnv: (env: Record<string, string>) => env,
      getDefaultBookmarkSeeds: () => [],
    };
    __setPlatformAdapterForTest(fakeAdapter);
    setPlatform('linux'); // linux 正常会 throw
    // 但因为已经设置了 fake,getPlatformAdapter 应直接返回 fake 而不分发
    const got = getPlatformAdapter();
    expect(got).toBe(fakeAdapter);
  });

  it('__setPlatformAdapterForTest(null) 后再次走分发逻辑', () => {
    const fakeAdapter = {
      lifecycleModel: 'no-persistence' as const,
      detectShells: async () => [],
      resolveExecutable: (commandName: string) => commandName,
      buildShellLaunchParams: () => ({ args: [], env: {} }),
      registerFileManagerIntegration: async () => {},
      unregisterFileManagerIntegration: async () => {},
      getProcessCwd: async () => null,
      setAutoStart: async () => {},
      isAutoStartEnabled: async () => false,
      getRefreshedPath: () => process.env.PATH ?? '',
      normalizeSpawnEnv: (env: Record<string, string>) => env,
      getDefaultBookmarkSeeds: () => [],
    };
    __setPlatformAdapterForTest(fakeAdapter);
    expect(getPlatformAdapter()).toBe(fakeAdapter);

    __setPlatformAdapterForTest(null);
    setPlatform('linux');
    // BETA-003a:Linux 现在有真实实现,不再 throw;构造出 LinuxAdapter 即可
    const got = getPlatformAdapter();
    expect(got).toBeDefined();
    expect(got.lifecycleModel).toBe('no-persistence');
  });
});
