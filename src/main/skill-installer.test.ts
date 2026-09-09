/**
 * @file skill-installer.test.ts
 * @purpose 验证内置 show-in-marina skill 的项目级安装目录、冲突预检与覆盖边界。
 *   v0.3.3(方案 20260909)起只测 claude/codex 目标 —— pi 的 skill 由
 *   pi-marina-bridge 在 Marina 终端内自动注入,不再手动安装(pi-bridge-inject.test.ts)。
 *
 * @安全约束:所有源与项目目录均为测试临时目录；不会触碰用户的 .claude/.agents。
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

  it('按两个工具的官方项目级发现目录复制完整 skill 包', async () => {
    const result = await installer.install({
      projectPath: project,
      targets: ['claude', 'codex'],
    });

    expect(result.conflicts).toEqual([]);
    expect(result.installed.map((item) => item.target).sort()).toEqual(['claude', 'codex']);
    await expect(
      fs.readFile(join(project, '.claude', 'skills', SKILL, 'helper.txt'), 'utf8'),
    ).resolves.toBe('helper');
    await expect(
      fs.readFile(join(project, '.agents', 'skills', SKILL, 'SKILL.md'), 'utf8'),
    ).resolves.toContain('description: test');
    // pi 目标已移除:绝不能再写 .pi/skills(bridge 注入的同名 skill 会被它遮蔽)。
    await expect(fs.access(join(project, '.pi', 'skills', SKILL))).rejects.toThrow();
  });

  it('先返回全部冲突而不做部分安装，覆盖确认后才替换', async () => {
    const claudeDir = join(project, '.claude', 'skills', SKILL);
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(join(claudeDir, 'SKILL.md'), 'old skill', 'utf8');

    const preflight = await installer.install({
      projectPath: project,
      targets: ['claude', 'codex'],
    });
    expect(preflight.installed).toEqual([]);
    expect(preflight.conflicts).toEqual([{ target: 'claude', destination: claudeDir }]);
    await expect(fs.access(join(project, '.agents', 'skills', SKILL))).rejects.toThrow();

    const installed = await installer.install({
      projectPath: project,
      targets: ['claude', 'codex'],
      overwrite: true,
    });
    expect(installed.conflicts).toEqual([]);
    await expect(fs.readFile(join(claudeDir, 'SKILL.md'), 'utf8')).resolves.toContain(
      'description: test',
    );
    await expect(
      fs.access(join(project, '.agents', 'skills', SKILL, 'SKILL.md')),
    ).resolves.toBeUndefined();
  });

  it('拒绝已移除的 pi 目标、空 targets、非目录目标和不完整内置资源', async () => {
    // pi 目标 0.3.3 起不再存在:旧 UI/脚本误传 'pi' 应报错而不是静默安装。
    await expect(
      installer.install({ projectPath: project, targets: ['pi'] as never[] }),
    ).rejects.toThrow('Unsupported skill target');

    await expect(installer.install({ projectPath: project, targets: [] })).rejects.toThrow(
      'Select at least one',
    );

    const file = join(root, 'not-a-project.txt');
    await fs.writeFile(file, 'x', 'utf8');
    await expect(installer.install({ projectPath: file, targets: ['claude'] })).rejects.toThrow(
      'not a directory',
    );

    const broken = new SkillInstaller({ sourceDir: join(root, 'missing', SKILL) });
    await expect(broken.install({ projectPath: project, targets: ['claude'] })).rejects.toThrow(
      'Built-in skill source is unavailable',
    );
  });
});
