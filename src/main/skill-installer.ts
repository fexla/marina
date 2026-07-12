/**
 * @file skill-installer.ts
 * @purpose 将 Marina 内置的 show-in-marina skill 安装到用户选中的本地项目，供
 *   Pi、Claude Code 或 Codex 自动发现。
 *
 * @关键设计:
 * - 收藏路径是安装目标项目根目录；内置 skill 是唯一来源，用户无需另选文件。
 * - 三个目标使用各自的官方项目级发现目录：.pi/skills、.claude/skills、
 *   .agents/skills；复制而非符号链接，项目可独立提交、打包和迁移。
 * - 先完整预检冲突，避免“Pi 装成功、Claude 因已有目录失败”的半完成状态。
 *
 * @对应文档章节: Pi docs/skills.md、Claude Code skills docs、OpenAI Codex skills docs。
 *
 * @不要在这里做的事:
 * - 不安装任意用户提供的脚本或目录（降低从 UI 写入不可信代码的风险）。
 * - 不删除项目目录以外的内容；覆盖仅作用于同名受管 skill 目录，且必须由 UI
 *   二次确认后通过 overwrite=true 显式授权。
 */
import { promises as fs } from 'node:fs';
import { basename, join, resolve, relative } from 'node:path';
import { logger } from './logger';

const MODULE = 'SkillInstaller';
export const MARINA_SKILL_NAME = 'show-in-marina' as const;

export type SkillInstallTarget = 'pi' | 'claude' | 'codex';

export interface SkillInstallRequest {
  /** 收藏路径对应的本地项目根目录。 */
  projectPath: string;
  targets: SkillInstallTarget[];
  /** false 时任一目标已存在就只返回 conflicts，不改磁盘。 */
  overwrite?: boolean;
}

export interface SkillInstallConflict {
  target: SkillInstallTarget;
  destination: string;
}

export interface SkillInstallResult {
  installed: Array<{ target: SkillInstallTarget; destination: string }>;
  conflicts: SkillInstallConflict[];
}

export interface SkillInstallerOptions {
  /** 内置 show-in-marina skill 的目录，测试传临时目录。 */
  sourceDir: string;
}

const TARGET_DIRS: Record<SkillInstallTarget, readonly string[]> = {
  pi: ['.pi', 'skills'],
  claude: ['.claude', 'skills'],
  codex: ['.agents', 'skills'],
};

/**
 * 复制内置 show-in-marina skill 到项目级 agent skill 目录。
 */
export class SkillInstaller {
  private readonly sourceDir: string;

  constructor(options: SkillInstallerOptions) {
    this.sourceDir = resolve(options.sourceDir);
  }

  /**
   * 预检并安装选中的目标。
   *
   * @returns overwrite=false 且有冲突时 installed=[]、conflicts 非空；调用方应向
   * 用户显示覆盖确认，再以 overwrite=true 重试同一 request。
   */
  async install(request: SkillInstallRequest): Promise<SkillInstallResult> {
    const targets = normalizeTargets(request.targets);
    const projectPath = await this.validateProjectPath(request.projectPath);
    await this.validateSource();

    const destinations = targets.map((target) => ({
      target,
      destination: this.destinationFor(projectPath, target),
    }));
    const conflicts: SkillInstallConflict[] = [];
    for (const item of destinations) {
      if (await pathExists(item.destination)) conflicts.push(item);
    }
    if (conflicts.length > 0 && !request.overwrite) {
      logger.info(
        MODULE,
        `install preflight conflicts project=${projectPath} count=${conflicts.length}`,
      );
      return { installed: [], conflicts };
    }

    const installed: SkillInstallResult['installed'] = [];
    for (const item of destinations) {
      if (await pathExists(item.destination)) {
        // overwrite 只会删除 destinationFor() 算出的 <project>/.{agent}/skills/
        // show-in-marina；never trust a renderer-supplied destination string.
        await fs.rm(item.destination, { recursive: true, force: true, maxRetries: 3 });
      }
      await fs.mkdir(resolve(item.destination, '..'), { recursive: true });
      await fs.cp(this.sourceDir, item.destination, {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
      installed.push(item);
      logger.info(MODULE, `installed target=${item.target} destination=${item.destination}`);
    }
    return { installed, conflicts: [] };
  }

  /** Pi / Claude / Codex 的项目级安装目标，供 UI 预览与测试复用。 */
  destinationFor(projectPath: string, target: SkillInstallTarget): string {
    const root = resolve(projectPath);
    const destination = resolve(root, ...TARGET_DIRS[target], MARINA_SKILL_NAME);
    const pathFromRoot = relative(root, destination);
    if (pathFromRoot === '' || pathFromRoot.startsWith('..')) {
      throw new Error(
        `[${MODULE}] Refused destination outside selected project. project="${root}" ` +
          `target="${target}" destination="${destination}".`,
      );
    }
    return destination;
  }

  private async validateProjectPath(rawPath: string): Promise<string> {
    if (!rawPath || typeof rawPath !== 'string') {
      throw new Error(`[${MODULE}] Cannot install skill: project path is empty or not a string.`);
    }
    const projectPath = resolve(rawPath);
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(projectPath);
    } catch (err) {
      throw new Error(
        `[${MODULE}] Cannot install skill into "${projectPath}": path does not exist or is inaccessible. ` +
          `Choose an accessible local bookmarked folder. Original error: ${
            err instanceof Error ? err.message : String(err)
          }`,
      );
    }
    if (!stat.isDirectory()) {
      throw new Error(
        `[${MODULE}] Cannot install skill into "${projectPath}": selected bookmark is not a directory.`,
      );
    }
    return projectPath;
  }

  private async validateSource(): Promise<void> {
    const manifest = join(this.sourceDir, 'SKILL.md');
    try {
      const stat = await fs.stat(manifest);
      if (!stat.isFile()) throw new Error('not a file');
    } catch (err) {
      throw new Error(
        `[${MODULE}] Built-in skill source is unavailable at "${this.sourceDir}". ` +
          `Expected "${manifest}". Possible causes: packaging omitted the skills resource or the install is damaged. ` +
          `Reinstall Marina and check logs. Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (basename(this.sourceDir) !== MARINA_SKILL_NAME) {
      throw new Error(
        `[${MODULE}] Built-in skill source directory must be "${MARINA_SKILL_NAME}", ` +
          `received "${basename(this.sourceDir)}". Refusing an unexpected source directory.`,
      );
    }
  }
}

function normalizeTargets(input: SkillInstallTarget[]): SkillInstallTarget[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error(`[${MODULE}] Select at least one target: Pi, Claude Code, or Codex.`);
  }
  const unique = [...new Set(input)];
  for (const target of unique) {
    if (!(target in TARGET_DIRS)) {
      throw new Error(`[${MODULE}] Unsupported skill target "${String(target)}".`);
    }
  }
  return unique;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}
