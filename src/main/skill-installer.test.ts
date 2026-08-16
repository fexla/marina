/**
 * @file skill-installer.test.ts
 * @purpose 验证内置 show-in-marina skill 的项目级安装目录、冲突预检与覆盖边界。
 *
 * @安全约束:所有源与项目目录均为测试临时目录；不会触碰用户的 .pi/.claude/.agents。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createTempDataDir, removeTempDataDir } from './persistence';
import { SkillInstaller } from './skill-installer';

const SKILL = 'show-in-marina';

describe('SkillInstaller', () => {
  let root: string;
  let project: string;
  let source: string;
  let installer: SkillInstaller;

  beforeEach(async () => {
    root = await createTempDataDir('marina-skill-installer-');
    project = join(root, 'project');
    source = join(root, 'source', SKILL);
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(
      source + '/SKILL.md',
      '---\nname: show-in-marina\ndescription: test\n---\n',
      'utf8',
    );
    await fs.writeFile(source + '/helper.txt', 'helper', 'utf8');
    installer = new SkillInstaller({ sourceDir: source });
  });

  afterEach(async () => {
    await removeTempDataDir(root);
  });

  it('按三个工具的官方项目级发现目录复制完整 skill 包', async () => {
    const result = await installer.install({
      projectPath: project,
      targets: ['pi', 'claude', 'codex'],
    });

    expect(result.conflicts).toEqual([]);
    expect(result.installed.map((item) => item.target).sort()).toEqual(['claude', 'codex', 'pi']);
    await expect(
      fs.readFile(join(project, '.pi', 'skills', SKILL, 'SKILL.md'), 'utf8'),
    ).resolves.toContain('name: show-in-marina');
    await expect(
      fs.readFile(join(project, '.claude', 'skills', SKILL, 'helper.txt'), 'utf8'),
    ).resolves.toBe('helper');
    await expect(
      fs.readFile(join(project, '.agents', 'skills', SKILL, 'SKILL.md'), 'utf8'),
    ).resolves.toContain('description: test');
  });

  it('先返回全部冲突而不做部分安装，覆盖确认后才替换', async () => {
    const piDir = join(project, '.pi', 'skills', SKILL);
    await fs.mkdir(piDir, { recursive: true });
    await fs.writeFile(join(piDir, 'SKILL.md'), 'old skill', 'utf8');

    const preflight = await installer.install({ projectPath: project, targets: ['pi', 'claude'] });
    expect(preflight.installed).toEqual([]);
    expect(preflight.conflicts).toEqual([{ target: 'pi', destination: piDir }]);
    await expect(fs.access(join(project, '.claude', 'skills', SKILL))).rejects.toThrow();

    const installed = await installer.install({
      projectPath: project,
      targets: ['pi', 'claude'],
      overwrite: true,
    });
    expect(installed.conflicts).toEqual([]);
    await expect(fs.readFile(join(piDir, 'SKILL.md'), 'utf8')).resolves.toContain(
      'description: test',
    );
    await expect(
      fs.access(join(project, '.claude', 'skills', SKILL, 'SKILL.md')),
    ).resolves.toBeUndefined();
  });

  it('拒绝空 targets、非目录目标和不完整内置资源', async () => {
    await expect(installer.install({ projectPath: project, targets: [] })).rejects.toThrow(
      'Select at least one',
    );

    const file = join(root, 'not-a-project.txt');
    await fs.writeFile(file, 'x', 'utf8');
    await expect(installer.install({ projectPath: file, targets: ['pi'] })).rejects.toThrow(
      'not a directory',
    );

    const broken = new SkillInstaller({ sourceDir: join(root, 'missing', SKILL) });
    await expect(broken.install({ projectPath: project, targets: ['pi'] })).rejects.toThrow(
      'Built-in skill source is unavailable',
    );
  });
});

describe('SkillInstaller — syncManagedSkills 启动刷新', () => {
  let root: string;
  let project: string;
  let source: string;
  let installer: SkillInstaller;

  beforeEach(async () => {
    root = await createTempDataDir('marina-skill-sync-');
    project = join(root, 'project');
    source = join(root, 'source', SKILL);
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(source + '/SKILL.md', '# v2 SKILL with --heading\n', 'utf8');
    await fs.writeFile(source + '/marina.ps1', '# v2 ps1 heading-aware\n', 'utf8');
    installer = new SkillInstaller({ sourceDir: source });
  });

  afterEach(async () => {
    await removeTempDataDir(root);
  });

  /** 模拟一个月前旧版 install 出去的副本：四文件齐全但内容是 v1（无 heading）。 */
  async function writeStaleCopy(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'SKILL.md'), '# v1 SKILL no heading\n', 'utf8');
    await fs.writeFile(join(dir, 'marina.ps1'), '# v1 ps1\n', 'utf8');
    await fs.writeFile(join(dir, 'marina.sh'), '# v1 sh\n', 'utf8');
    await fs.writeFile(join(dir, 'marina.cmd'), '# v1 cmd\n', 'utf8');
  }

  it('签名匹配的旧副本被刷新为最新内置内容', async () => {
    await fs.mkdir(project, { recursive: true });
    const piDir = join(project, '.pi', 'skills', SKILL);
    await writeStaleCopy(piDir);

    const result = await installer.syncManagedSkills([project]);
    expect(result.refreshed).toEqual([piDir]);
    expect(result.skipped).toBe(2); // claude/codex 目标不存在 → 跳过不新建
    await expect(fs.readFile(join(piDir, 'SKILL.md'), 'utf8')).resolves.toContain('--heading');
    await expect(fs.readFile(join(piDir, 'marina.ps1'), 'utf8')).resolves.toContain(
      'heading-aware',
    );
    // 旧副本里的历史文件（源里已不存在）不得残留：整体替换而非合并。
    await expect(fs.access(join(piDir, 'marina.sh'))).rejects.toThrow();
  });

  it('三个目标目录都不存在时不新建任何目录', async () => {
    await fs.mkdir(project, { recursive: true });
    const before = await fs.readdir(project);
    const result = await installer.syncManagedSkills([project]);
    expect(result.refreshed).toEqual([]);
    expect(result.skipped).toBe(3);
    expect(await fs.readdir(project)).toEqual(before);
  });

  it('签名不匹配（用户自建同名目录，无 marina.ps1）不动一字节', async () => {
    await fs.mkdir(project, { recursive: true });
    const handMade = join(project, '.pi', 'skills', SKILL);
    await fs.mkdir(handMade, { recursive: true });
    await fs.writeFile(join(handMade, 'SKILL.md'), '# my own hand-written skill\n', 'utf8');

    const result = await installer.syncManagedSkills([project]);
    expect(result.refreshed).toEqual([]);
    await expect(fs.readFile(join(handMade, 'SKILL.md'), 'utf8')).resolves.toContain(
      'hand-written',
    );
  });

  it('收藏路径不存在/非字符串只计数不抛', async () => {
    const result = await installer.syncManagedSkills([
      join(root, 'gone'),
      '',
      42 as unknown as string,
    ]);
    expect(result.refreshed).toEqual([]);
    expect(result.skipped).toBeGreaterThanOrEqual(6);
  });
});
