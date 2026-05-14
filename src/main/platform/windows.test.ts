/**
 * @file src/main/platform/windows.test.ts
 * @purpose 覆盖 WindowsAdapter 的 Explorer 右键集成 reg.exe 调用形态。
 *
 * 关键设计:
 * - 不真的调 reg.exe,通过 __setRunRegImplForTest 注入 mock,断言参数数组形态
 * - 验证 register 先 unregister 再 add 4 个 key,unregister 容忍 not found
 * - 验证 cleanupLegacyExplorerIntegration 删两个 EasyTerm key
 *
 * @对应文档章节: 软件定义书.md 12.2;Explorer 右键集成工作记录
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WindowsAdapter, __setRunRegImplForTest } from './windows';

describe('WindowsAdapter — registerFileManagerIntegration', () => {
  let calls: string[][] = [];

  beforeEach(() => {
    calls = [];
    __setRunRegImplForTest(async (args: string[]) => {
      calls.push(args);
      // 所有调用默认成功
      return { stderr: '', code: 0 };
    });
  });

  afterEach(() => {
    __setRunRegImplForTest(null);
  });

  it('register 先 unregister 两次,再 add 六个 key', async () => {
    const adapter = new WindowsAdapter();
    await adapter.registerFileManagerIntegration('C:\\Program Files\\Marina\\Marina.exe');

    // 2 个 unregister(Directory + Background)+ 6 个 add
    // (2 个 menu 文案 + 2 个 Icon 值 + 2 个 command)
    expect(calls).toHaveLength(8);
    expect(calls.slice(0, 2)).toEqual([
      ['delete', 'HKCU\\Software\\Classes\\Directory\\shell\\Marina', '/f'],
      ['delete', 'HKCU\\Software\\Classes\\Directory\\Background\\shell\\Marina', '/f'],
    ]);
  });

  it('register 写 Icon 字段引用 exe 内嵌图标 ",0"', async () => {
    const adapter = new WindowsAdapter();
    await adapter.registerFileManagerIntegration('C:\\Program Files\\Marina\\Marina.exe');
    // 两个 hive 各一条 Icon
    const iconCalls = calls.filter(
      (a) =>
        a[0] === 'add' &&
        a.includes('/v') &&
        a[a.indexOf('/v') + 1] === 'Icon',
    );
    expect(iconCalls).toHaveLength(2);
    for (const c of iconCalls) {
      const dIdx = c.indexOf('/d');
      expect(c[dIdx + 1]).toBe('C:\\Program Files\\Marina\\Marina.exe,0');
    }
  });

  it('register 写菜单文案 "在 Marina 终端中打开"', async () => {
    const adapter = new WindowsAdapter();
    await adapter.registerFileManagerIntegration('C:\\Marina.exe');
    const menuCall = calls.find(
      (a) =>
        a[0] === 'add' &&
        a[1] === 'HKCU\\Software\\Classes\\Directory\\shell\\Marina' &&
        a.includes('/ve'),
    );
    expect(menuCall).toBeTruthy();
    expect(menuCall).toContain('在 Marina 终端中打开');
  });

  it('Directory\\shell command 用 %1 占位符', async () => {
    const adapter = new WindowsAdapter();
    await adapter.registerFileManagerIntegration('C:\\My App\\Marina.exe');
    const cmdCall = calls.find((a) =>
      a[1]?.endsWith('Directory\\shell\\Marina\\command'),
    );
    expect(cmdCall).toBeTruthy();
    const idx = cmdCall!.indexOf('/d');
    expect(cmdCall![idx + 1]).toBe(
      '"C:\\My App\\Marina.exe" --open-here "%1"',
    );
  });

  it('Directory\\Background\\shell command 用 %V 占位符', async () => {
    const adapter = new WindowsAdapter();
    await adapter.registerFileManagerIntegration('C:\\Marina.exe');
    const cmdCall = calls.find((a) =>
      a[1]?.endsWith('Directory\\Background\\shell\\Marina\\command'),
    );
    expect(cmdCall).toBeTruthy();
    const idx = cmdCall!.indexOf('/d');
    expect(cmdCall![idx + 1]).toBe('"C:\\Marina.exe" --open-here "%V"');
  });

  it('unregister 删两个根 key (Directory + Background)', async () => {
    const adapter = new WindowsAdapter();
    await adapter.unregisterFileManagerIntegration();
    expect(calls).toEqual([
      ['delete', 'HKCU\\Software\\Classes\\Directory\\shell\\Marina', '/f'],
      ['delete', 'HKCU\\Software\\Classes\\Directory\\Background\\shell\\Marina', '/f'],
    ]);
  });

  it('unregister 容忍 not-found (reg.exe exit code 1)', async () => {
    __setRunRegImplForTest(async () => ({
      stderr: 'ERROR: 系统找不到指定的注册表项或值。',
      code: 1,
    }));
    const adapter = new WindowsAdapter();
    // 不应抛错
    await expect(adapter.unregisterFileManagerIntegration()).resolves.toBeUndefined();
  });

  it('register 的 add 失败(非 1)向上抛错', async () => {
    let n = 0;
    __setRunRegImplForTest(async () => {
      n++;
      // 前 2 个 unregister 成功,第 3 个(第一个 add)假装失败
      if (n <= 2) return { stderr: '', code: 0 };
      return { stderr: 'access denied', code: 5 };
    });
    const adapter = new WindowsAdapter();
    await expect(
      adapter.registerFileManagerIntegration('C:\\Marina.exe'),
    ).rejects.toThrow(/code=5/);
  });

  it('cleanupLegacyExplorerIntegration 删两个 EasyTerm key,容忍 not found', async () => {
    __setRunRegImplForTest(async () => ({
      stderr: '系统找不到指定的注册表项或值。',
      code: 1,
    }));
    const adapter = new WindowsAdapter();
    await expect(
      adapter.cleanupLegacyExplorerIntegration(),
    ).resolves.toBeUndefined();
    // 实际调用断言
    const realCalls: string[][] = [];
    __setRunRegImplForTest(async (args) => {
      realCalls.push(args);
      return { stderr: '', code: 0 };
    });
    const a2 = new WindowsAdapter();
    await a2.cleanupLegacyExplorerIntegration();
    expect(realCalls).toEqual([
      ['delete', 'HKCU\\Software\\Classes\\Directory\\shell\\EasyTerm', '/f'],
      [
        'delete',
        'HKCU\\Software\\Classes\\Directory\\Background\\shell\\EasyTerm',
        '/f',
      ],
    ]);
  });
});

// 让 vi 引用不报未使用警告
void vi;
