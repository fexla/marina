/**
 * @file pi-bridge-installer.test.ts
 * @purpose 验证 pi-marina-bridge package 的全局/项目级安装：pi 检测、复制到稳定
 *   位置、spawn pi install、已装幂等、source 缺失、pi 未装引导。
 *
 * @安全约束:所有目录均为测试临时目录；resolvePi/runPiInstall 全 mock，不会真的
 *   调用系统 pi 或触碰用户 ~/.pi。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createTempDataDir, removeTempDataDir } from './persistence';
import { PiBridgeInstaller, PiNotInstalledError } from './pi-bridge-installer';

describe('PiBridgeInstaller', () => {
  let root: string;
  let source: string;
  let home: string;
  let project: string;
  /** 记录 spawn 调用，便于断言参数。 */
  let spawnCalls: { args: string[]; cwd: string }[];
  /** 控制 spawn 返回的退出码；默认 0。 */
  let spawnExitCode: number;
  /** 控制 pi 是否"已装"。 */
  let piOnPath: boolean;

  function makeInstaller(): PiBridgeInstaller {
    return new PiBridgeInstaller({
      sourceDir: source,
      homeDir: home,
      resolvePi: () => (piOnPath ? '/fake/pi' : null),
      runPiInstall: async (args, cwd) => {
        spawnCalls.push({ args, cwd });
        return spawnExitCode;
      },
    });
  }

  beforeEach(async () => {
    root = await createTempDataDir('marina-pi-bridge-installer-');
    source = join(root, 'source', 'pi-marina-bridge');
    home = join(root, 'home');
    project = join(root, 'project');
    await fs.mkdir(source, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    // 内置 package 源至少要有 package.json + extensions/index.ts。
    await fs.writeFile(
      join(source, 'package.json'),
      JSON.stringify({
        name: '@marina/pi-marina-bridge',
        pi: { extensions: ['./extensions/index.ts'] },
      }),
      'utf8',
    );
    await fs.mkdir(join(source, 'extensions'), { recursive: true });
    await fs.writeFile(
      join(source, 'extensions', 'index.ts'),
      'export default function(){}',
      'utf8',
    );
    spawnCalls = [];
    spawnExitCode = 0;
    piOnPath = true;
  });

  afterEach(async () => {
    await removeTempDataDir(root);
  });

  it('pi 未安装 → 抛 PiNotInstalledError，不复制不 spawn', async () => {
    piOnPath = false;
    const installer = makeInstaller();
    await expect(installer.install({ scope: 'global' })).rejects.toBeInstanceOf(
      PiNotInstalledError,
    );
    expect(spawnCalls).toHaveLength(0);
    expect(installer.isPiInstalled()).toBe(false);
  });

  it('全局安装：复制 package 到 ~/.pi/agent/packages + spawn pi install <path>', async () => {
    const installer = makeInstaller();
    const r = await installer.install({ scope: 'global' });
    expect(r.alreadyInstalled).toBe(false);
    // 稳定位置含 package 内容
    const stable = join(home, '.pi', 'agent', 'packages', 'pi-marina-bridge');
    expect(r.packageDir).toBe(stable);
    expect(await fs.readFile(join(stable, 'package.json'), 'utf8')).toContain('pi-marina-bridge');
    // spawn 参数：全局不带 -l，cwd=home
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.args).toEqual(['install', stable]);
    expect(spawnCalls[0]!.cwd).toBe(home);
    // 写入的 settings 是全局
    expect(r.settingsFile).toBe(join(home, '.pi', 'agent', 'settings.json'));
  });

  it('项目级安装：spawn pi install -l <path>，cwd=project', async () => {
    const installer = makeInstaller();
    const r = await installer.install({ scope: 'project', projectPath: project });
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.args).toEqual(['install', '-l', r.packageDir]);
    expect(spawnCalls[0]!.cwd).toBe(project);
    expect(r.settingsFile).toBe(join(project, '.pi', 'settings.json'));
  });

  it('项目级安装缺 projectPath → 抛错', async () => {
    const installer = makeInstaller();
    await expect(installer.install({ scope: 'project' })).rejects.toThrow(/project path/);
    expect(spawnCalls).toHaveLength(0);
  });

  it('已装幂等：全局 settings.json 的 packages 已含稳定路径 → 不 spawn', async () => {
    const installer = makeInstaller();
    // 先正常装一次（spawn 会在真实 fs 写不了 settings.json，但模拟已装：手写 settings.json）
    const stable = installer.getStablePackageDir();
    const settingsFile = installer.getGlobalSettingsFile();
    await fs.mkdir(join(settingsFile, '..'), { recursive: true });
    await fs.writeFile(settingsFile, JSON.stringify({ packages: [stable] }), 'utf8');
    const r = await installer.install({ scope: 'global' });
    expect(r.alreadyInstalled).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(spawnCalls).toHaveLength(0); // 已装，不重复 spawn
  });

  it('isGloballyInstalled：读全局 settings.json packages 判定', async () => {
    const installer = makeInstaller();
    expect(await installer.isGloballyInstalled()).toBe(false);
    const settingsFile = installer.getGlobalSettingsFile();
    await fs.mkdir(join(settingsFile, '..'), { recursive: true });
    await fs.writeFile(
      settingsFile,
      JSON.stringify({ packages: [installer.getStablePackageDir()] }),
      'utf8',
    );
    expect(await installer.isGloballyInstalled()).toBe(true);
  });

  it('source 缺失 → 抛错（提示 packaging 问题）', async () => {
    await fs.rm(source, { recursive: true, force: true });
    const installer = makeInstaller();
    await expect(installer.install({ scope: 'global' })).rejects.toThrow(/source unavailable/i);
  });

  it('pi install 非零退出 → 抛错带诊断', async () => {
    spawnExitCode = 1;
    const installer = makeInstaller();
    await expect(installer.install({ scope: 'global' })).rejects.toThrow(/exited with code 1/);
  });

  it('重装刷新：稳定位置先清再复制（不残留旧文件）', async () => {
    const installer = makeInstaller();
    await installer.install({ scope: 'global' });
    const stable = installer.getStablePackageDir();
    // 模拟旧版本残留一个文件
    await fs.writeFile(join(stable, 'OLD-leftover.txt'), 'old', 'utf8');
    // 清掉 settings.json 的已装标记，强制再装一次
    await fs.rm(installer.getGlobalSettingsFile(), { force: true });
    await installer.install({ scope: 'global' });
    await expect(fs.stat(join(stable, 'OLD-leftover.txt'))).rejects.toThrow(); // 旧文件被清
    expect(await fs.readFile(join(stable, 'package.json'), 'utf8')).toContain('pi-marina-bridge');
  });

  // ── ensureUpToDate:启动自动升级(方案 20260817 Q5)────────────────

  it('内置版本新于稳定目录 → 重拷内容,不 spawn pi install', async () => {
    const installer = makeInstaller();
    // 先以 v0.3.3 安装一次。
    await fs.writeFile(
      join(source, 'package.json'),
      JSON.stringify({ name: '@marina/pi-marina-bridge', version: '0.3.3' }),
      'utf8',
    );
    await installer.install({ scope: 'global' });
    const spawnCountAfterInstall = spawnCalls.length;
    // 内置源升到 v0.3.4(app 升级带来的新 bridge)。
    await fs.writeFile(
      join(source, 'package.json'),
      JSON.stringify({ name: '@marina/pi-marina-bridge', version: '0.3.4' }),
      'utf8',
    );
    const refreshed = await installer.ensureUpToDate();
    expect(refreshed).toBe(true);
    const stablePkg = JSON.parse(
      await fs.readFile(join(installer.getStablePackageDir(), 'package.json'), 'utf8'),
    ) as { version: string };
    expect(stablePkg.version).toBe('0.3.4');
    // 路径引用没变 → 不得重复 spawn pi install(settings 无需改写)。
    expect(spawnCalls.length).toBe(spawnCountAfterInstall);
  });

  it('版本一致 → no-op(false),不重写稳定目录', async () => {
    const installer = makeInstaller();
    await fs.writeFile(
      join(source, 'package.json'),
      JSON.stringify({ name: '@marina/pi-marina-bridge', version: '0.3.4' }),
      'utf8',
    );
    await installer.install({ scope: 'global' });
    // 稳定目录里放一个标记文件:版本一致时不得被动过。
    await fs.writeFile(join(installer.getStablePackageDir(), 'MARKER.txt'), 'keep', 'utf8');
    await expect(installer.ensureUpToDate()).resolves.toBe(false);
    await expect(
      fs.stat(join(installer.getStablePackageDir(), 'MARKER.txt')),
    ).resolves.toBeTruthy();
  });

  it('从未安装(稳定目录不存在且 settings 无引用) → 不预装,保持 false', async () => {
    const installer = makeInstaller();
    await fs.writeFile(
      join(source, 'package.json'),
      JSON.stringify({ name: '@marina/pi-marina-bridge', version: '0.3.4' }),
      'utf8',
    );
    await expect(installer.ensureUpToDate()).resolves.toBe(false);
    await expect(fs.stat(installer.getStablePackageDir())).rejects.toThrow(); // 没碰 ~/.pi
    expect(spawnCalls).toEqual([]);
  });

  it('稳定目录存在但内容损坏(无 package.json) → 重建', async () => {
    const installer = makeInstaller();
    await fs.writeFile(
      join(source, 'package.json'),
      JSON.stringify({ name: '@marina/pi-marina-bridge', version: '0.3.4' }),
      'utf8',
    );
    // 稳定目录存在但空(模拟中断/损坏)。目录存在即视为装过 → 修复重建。
    await fs.mkdir(installer.getStablePackageDir(), { recursive: true });
    await expect(installer.ensureUpToDate()).resolves.toBe(true);
    const stablePkg = JSON.parse(
      await fs.readFile(join(installer.getStablePackageDir(), 'package.json'), 'utf8'),
    ) as { version: string };
    expect(stablePkg.version).toBe('0.3.4');
  });
});
