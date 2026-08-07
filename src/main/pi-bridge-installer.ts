/**
 * @file pi-bridge-installer.ts
 * @purpose 把内置的 pi-marina-bridge package 安装为 pi 的扩展，让通过 Marina 打开
 *   的 pi 自动把对话/工作生命周期事件转发回 Marina（ADR-028）。
 *
 * @关键设计(仿 skill-installer.ts)：
 * - 内置 package 是唯一来源（extraResources 打包），不安装用户提供的任意目录。
 * - 安装 = 复制 package 到用户目录稳定位置 + spawn `pi install` 让 pi 自己写
 *   settings.json 的 packages 数组。**不重新实现 pi 的 settings 格式**，复用 pi
 *   自己的安装逻辑（包升级、路径解析、去重都交给 pi）。
 * - 稳定位置 = `~/.pi/agent/packages/pi-marina-bridge`：app 升级会换 install 目录
 *   （Program Files 路径变），引用 app 资源路径会失效；复制到用户目录一份则不受
 *   app 升级影响。全局与项目级安装共用这同一份物理副本，区别仅在写哪个 settings.json。
 * - pi 没装（resolveExecutable 返回 null）→ 抛 PiNotInstalled，UI 引导用户先装 pi
 *   （方案 A：没 pi 不让装 package，因为装了也没用）。
 * - 已装检测：读目标 settings.json 的 packages 数组是否已含稳定位置路径，已含
 *   则幂等返回 alreadyInstalled=true，不重复 spawn（避免 packages 数组出现重复条目）。
 *
 * @对应文档章节: ADR-028、docs/方案-pi对话绑定workspace-20260805.md（问题 7）。
 *
 * @不要在这里做的事:
 * - 不安装任意用户提供的 package 源（只装内置的 pi-marina-bridge）。
 * - 不解析/重写 pi 的 settings.json 业务字段（只读 packages 数组做已装判断）。
 * - 不在 pi 未安装时静默失败（必须明确抛 PiNotInstalled 让 UI 引导）。
 */
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { logger } from './logger';

const MODULE = 'PiBridgeInstaller';
export const PI_BRIDGE_PACKAGE_NAME = 'pi-marina-bridge' as const;

export type PiBridgeInstallScope = 'global' | 'project';

export interface PiBridgeInstallRequest {
  scope: PiBridgeInstallScope;
  /** scope='project' 时必填：项目根目录（收藏路径）。global 忽略。 */
  projectPath?: string;
}

export interface PiBridgeInstallResult {
  /** 是否已是已安装状态（本次未实际写入）。 */
  alreadyInstalled: boolean;
  /** package 被复制到的稳定位置绝对路径。 */
  packageDir: string;
  /** 写入的 pi settings.json 路径（全局或项目级）。 */
  settingsFile: string;
  /** pi install 子进程退出码（0=成功）。alreadyInstalled 时为 null。 */
  exitCode: number | null;
}

/** pi 未安装时抛此错误，UI 据此引导用户先装 pi。 */
export class PiNotInstalledError extends Error {
  constructor() {
    super(
      `[${MODULE}] pi (@earendil-works/pi-coding-agent) 未在 PATH 上找到。` +
        '请先安装 pi：npm i -g @earendil-works/pi-coding-agent，再安装 pi 集成 package。',
    );
    this.name = 'PiNotInstalledError';
  }
}

export interface PiBridgeInstallerOptions {
  /** 内置 pi-marina-bridge package 目录（dev=源码，packaged=extraResources）。 */
  sourceDir: string;
  /** 用户 home 目录（算 ~/.pi/agent）。 */
  homeDir: string;
  /**
   * 解析 pi 可执行文件路径，返回 null=未安装。由 index.ts 绑定 PlatformAdapter
   * .resolveExecutable('pi', env)（AGENTS.md §8.1：平台 API 走 adapter）。
   */
  resolvePi: () => string | null;
  /**
   * 执行 `pi install ...`。可 mock（测试）。默认实现 spawn pi，继承 process.env，
   * 捕获 stdout/stderr 用于错误诊断。
   */
  runPiInstall?: (args: string[], cwd: string) => Promise<number>;
}

/**
 * 安装 pi-marina-bridge 为 pi 扩展（全局或项目级）。
 */
export class PiBridgeInstaller {
  private readonly sourceDir: string;
  private readonly homeDir: string;
  private readonly resolvePi: () => string | null;
  private readonly runPiInstall: (args: string[], cwd: string) => Promise<number>;

  constructor(options: PiBridgeInstallerOptions) {
    this.sourceDir = resolve(options.sourceDir);
    this.homeDir = resolve(options.homeDir);
    this.resolvePi = options.resolvePi;
    this.runPiInstall = options.runPiInstall ?? ((args, cwd) => defaultRunPiInstall(args, cwd));
  }

  /** pi 是否已安装（UI 据此决定按钮可用性）。 */
  isPiInstalled(): boolean {
    return this.resolvePi() !== null;
  }

  /** pi-marina-bridge 是否已装到全局 settings.json（UI 状态显示用）。读失败=false。 */
  async isGloballyInstalled(): Promise<boolean> {
    return this.isAlreadyInstalled(this.getGlobalSettingsFile(), this.getStablePackageDir());
  }

  /** package 复制到的稳定位置：~/.pi/agent/packages/pi-marina-bridge。 */
  getStablePackageDir(): string {
    return join(this.homeDir, '.pi', 'agent', 'packages', PI_BRIDGE_PACKAGE_NAME);
  }

  /** 全局 pi settings.json：~/.pi/agent/settings.json。 */
  getGlobalSettingsFile(): string {
    return join(this.homeDir, '.pi', 'agent', 'settings.json');
  }

  /** 项目级 pi settings.json：<project>/.pi/settings.json。 */
  getProjectSettingsFile(projectPath: string): string {
    return join(resolve(projectPath), '.pi', 'settings.json');
  }

  /**
   * 安装 pi-marina-bridge。
   *
   * @throws PiNotInstalledError pi 未安装。
   * @throws Error source 缺失 / project 路径无效 / pi install 非零退出。
   */
  async install(request: PiBridgeInstallRequest): Promise<PiBridgeInstallResult> {
    if (!this.isPiInstalled()) {
      throw new PiNotInstalledError();
    }
    const projectPath =
      request.scope === 'project' ? this.validateProjectPath(request.projectPath) : undefined;
    await this.validateSource();

    // 1) 复制 package 到稳定位置（幂等：先清再复制，保证内容随 app 升级刷新）。
    const packageDir = this.getStablePackageDir();
    await fs.rm(packageDir, { recursive: true, force: true, maxRetries: 3 });
    await fs.mkdir(resolve(packageDir, '..'), { recursive: true });
    await fs.cp(this.sourceDir, packageDir, { recursive: true, force: false, errorOnExist: true });
    logger.info(MODULE, `copied package to stable dir=${packageDir}`);

    // 2) 目标 settings.json（读它做已装判断 + 返回路径）。
    const settingsFile =
      request.scope === 'project'
        ? this.getProjectSettingsFile(projectPath!)
        : this.getGlobalSettingsFile();

    // 3) 已装检测：packages 数组已含稳定位置路径 → 幂等返回，不重复 spawn。
    if (await this.isAlreadyInstalled(settingsFile, packageDir)) {
      logger.info(MODULE, `already installed in ${settingsFile}; skip spawn`);
      return { alreadyInstalled: true, packageDir, settingsFile, exitCode: null };
    }

    // 4) spawn pi install。全局:pi install <path>;项目级:pi install -l <path>(cwd=project)。
    const args =
      request.scope === 'project' ? ['install', '-l', packageDir] : ['install', packageDir];
    const cwd = request.scope === 'project' ? resolve(projectPath!) : this.homeDir;
    logger.info(MODULE, `spawn pi ${args.join(' ')} (cwd=${cwd})`);
    const exitCode = await this.runPiInstall(args, cwd);
    if (exitCode !== 0) {
      throw new Error(
        `[${MODULE}] \`pi ${args.join(' ')}\` exited with code ${exitCode}. ` +
          'Possible causes: (1) pi version too old (no `install` command); ' +
          '(2) settings.json 权限/损坏; (3) package 目录被占用。' +
          'See pi stderr in Marina logs.',
      );
    }
    logger.info(MODULE, `installed scope=${request.scope} settings=${settingsFile}`);
    return { alreadyInstalled: false, packageDir, settingsFile, exitCode };
  }

  /** 读 settings.json，检查 packages 数组是否已含 packageDir 路径。损坏/缺失=未装。 */
  private async isAlreadyInstalled(settingsFile: string, packageDir: string): Promise<boolean> {
    try {
      const raw = await fs.readFile(settingsFile, 'utf8');
      const parsed = JSON.parse(raw) as { packages?: unknown };
      const packages = Array.isArray(parsed.packages) ? parsed.packages : [];
      const target = packageDir.replace(/[\\/]+$/, '');
      return packages.some(
        (entry) => typeof entry === 'string' && entry.replace(/[\\/]+$/, '') === target,
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      logger.warn(
        MODULE,
        `isAlreadyInstalled: settings.json unreadable (${settingsFile}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }

  private validateProjectPath(rawPath: string | undefined): string {
    if (!rawPath || typeof rawPath !== 'string') {
      throw new Error(`[${MODULE}] project install requires a project path.`);
    }
    return resolve(rawPath);
  }

  private async validateSource(): Promise<void> {
    const manifest = join(this.sourceDir, 'package.json');
    try {
      const stat = await fs.stat(manifest);
      if (!stat.isFile()) throw new Error('not a file');
    } catch (err) {
      throw new Error(
        `[${MODULE}] Built-in pi-marina-bridge source unavailable at "${this.sourceDir}". ` +
          `Expected "${manifest}". Possible causes: packaging omitted the resource or the install is damaged. ` +
          `Reinstall Marina. Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * 默认的 `pi install` 执行器：spawn pi，继承 process.env（用户装的 CLI 都在 PATH），
 * 不注入 MARINA_SERVICE/TERMINAL_ID（安装是一次性命令，不是常驻终端，见 code-block-runner
 * 同款决策）。stdout/stderr 收集后写日志，便于诊断 pi install 失败。
 */
function defaultRunPiInstall(args: string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('pi', args, {
      cwd,
      env: { ...process.env },
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => {
      stdout += d;
    });
    child.stderr?.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (err) => {
      reject(
        new Error(
          `[${MODULE}] Failed to spawn \`pi ${args.join(' ')}\`: ${
            err instanceof Error ? err.message : String(err)
          }. Is pi on PATH?`,
        ),
      );
    });
    child.on('close', (code) => {
      if (stdout.trim()) logger.info(MODULE, `pi stdout: ${stdout.trim().slice(0, 500)}`);
      if (stderr.trim()) logger.warn(MODULE, `pi stderr: ${stderr.trim().slice(0, 500)}`);
      resolve(code ?? -1);
    });
  });
}
