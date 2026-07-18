/**
 * @file src/main/git-service.test.ts
 * @purpose 验证 v0.3.0 GitService 的安全模式(owner 校验、SSH 拒绝、路径越界防护)、
 *   动态 LayoutNode 判定(evaluateAvailability)、porcelain v2 解析、以及 diff 写入
 *   临时文件后正确交给 FilePanelService。
 *
 * @关键策略:
 * - runGit(调系统 git 二进制)是 §5.4 定义的"第三方库 wrapper",不测真 spawn。
 *   用 vi.spyOn 替换 runGit 返回固定 stdout,测上层组装逻辑。
 * - parsePorcelainV2 是纯函数,单独 export 测各种行格式。
 * - 所有 fs 操作走临时目录(对齐 file-tree-service.test.ts 模式)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FilePanelService } from './file-panel-service';
import {
  GitService,
  parsePorcelainV2,
  type GitStatusSnapshot,
} from './git-service';

interface SessionEntry {
  pathId: string;
  currentCwd: string;
  ownerWindowId: string | null;
}

describe('GitService', () => {
  let baseDir: string;
  let repoDir: string;
  let nonRepoDir: string;
  let workspaceDir: string;
  let sessions: Record<string, SessionEntry>;
  let filePanelService: FilePanelService;
  let service: GitService;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'marina-git-'));
    repoDir = join(baseDir, 'repo');
    nonRepoDir = join(baseDir, 'non-repo');
    workspaceDir = join(baseDir, 'workspace');
    await Promise.all([mkdir(repoDir), mkdir(nonRepoDir), mkdir(workspaceDir)]);
    // 造一个真 .git 目录让 findRepoRoot 命中(evaluateAvailability 只 stat .git)。
    await mkdir(join(repoDir, '.git'));
    sessions = {
      s1: { pathId: repoDir, currentCwd: repoDir, ownerWindowId: 'owner-1' },
      s2: { pathId: nonRepoDir, currentCwd: nonRepoDir, ownerWindowId: 'owner-2' },
      ssh1: { pathId: 'ssh:profile-x', currentCwd: '/home/x', ownerWindowId: 'owner-ssh' },
    };
    filePanelService = new FilePanelService();
    filePanelService.attachSessionLookup({ get: (id) => sessions[id] ?? null });
    service = new GitService(
      { get: (id) => sessions[id] ?? null },
      { getPathForSession: (id) => (id === 's1' || id === 's2' ? workspaceDir : null) },
      filePanelService,
    );
    service.setRuntimeConfig({ enableGitPanel: true, gitBinaryPath: '' });
  });

  afterEach(async () => {
    await filePanelService.stop();
    await rm(baseDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // ── evaluateAvailability(动态 LayoutNode 判定)──────────────────────
  it('evaluateAvailability:enableGitPanel=false 时返回 disabled', async () => {
    service.setRuntimeConfig({ enableGitPanel: false, gitBinaryPath: '' });
    const cwdReal = await realpath(repoDir);
    const r = await service.evaluateAvailability(cwdReal, 'local');
    expect(r).toEqual({ available: false, reason: 'disabled' });
  });

  it('evaluateAvailability:SSH session 返回 ssh-unsupported(不 realpath 远端路径)', async () => {
    const r = await service.evaluateAvailability('/home/x/proj', 'ssh');
    expect(r).toEqual({ available: false, reason: 'ssh-unsupported' });
  });

  it('evaluateAvailability:cwd 不在仓库内返回 not-a-repo', async () => {
    const cwdReal = await realpath(nonRepoDir);
    const r = await service.evaluateAvailability(cwdReal, 'local');
    expect(r).toEqual({ available: false, reason: 'not-a-repo' });
  });

  it('evaluateAvailability:cwd 在仓库内返回 available(只 stat .git,不 spawn git)', async () => {
    const cwdReal = await realpath(repoDir);
    const r = await service.evaluateAvailability(cwdReal, 'local');
    expect(r).toEqual({ available: true });
  });

  // ── 安全:owner / SSH / 路径越界 ────────────────────────────────────
  it('getStatus:拒绝非 owner 的 requester', async () => {
    await expect(service.getStatus('s1', 'other-window')).rejects.toMatchObject({
      code: 'NotOwner',
    });
  });

  it('getStatus:不存在的 session 抛 SessionMissing', async () => {
    await expect(service.getStatus('nope', 'owner-1')).rejects.toMatchObject({
      code: 'SessionMissing',
    });
  });

  it('getStatus:SSH session 返回 ssh-unsupported(不抛错,由 UI 表现为 tab 不出现)', async () => {
    const r = await service.getStatus('ssh1', 'owner-ssh');
    expect(r).toEqual({ unavailable: 'ssh-unsupported' });
  });

  it('getStatus:disable 时返回 disabled', async () => {
    service.setRuntimeConfig({ enableGitPanel: false, gitBinaryPath: '' });
    const r = await service.getStatus('s1', 'owner-1');
    expect(r).toEqual({ unavailable: 'disabled' });
  });

  it('getStatus:非 repo 返回 not-a-repo', async () => {
    const r = await service.getStatus('s2', 'owner-2');
    expect(r).toEqual({ unavailable: 'not-a-repo' });
  });

  // ── getStatus 组装逻辑(用 spy 替换 runGit,不 spawn 真 git)────────
  it('getStatus:repo 内时调 runGit 并把 porcelain v2 解析为分组', async () => {
    // porcelain v2 标准样本:含 modified/added/deleted/renamed/untracked/conflict。
    const sample =
      '1 .M N... 100644 100644 100644 aaaa bbbb modified.txt\0' +
      '1 A. N... 000000 100644 100644 0000 cccc added.txt\0' +
      '1 .D N... 100644 000000 000000 dddd 0000 deleted.txt\0' +
      '2 RM N... 100644 100644 100644 eeee ffff R100 new.txt\told.txt\0' +
      '? untracked.txt\0' +
      'u UU N... 100644 100644 100644 100644 g1 g2 g3 conflict.txt\0';
    const spy = vi
      .spyOn(service as unknown as { runGit: (...a: never[]) => Promise<unknown> }, 'runGit')
      .mockResolvedValue({ stdout: Buffer.from(sample, 'utf8'), stderr: '', exitCode: 0 });
    const r = (await service.getStatus('s1', 'owner-1')) as GitStatusSnapshot;
    expect(spy).toHaveBeenCalled();
    const tones = r.groups.map((g) => g.tone);
    expect(tones).toContain('modified');
    expect(tones).toContain('added');
    expect(tones).toContain('deleted');
    expect(tones).toContain('renamed');
    expect(tones).toContain('untracked');
    expect(tones).toContain('conflict');
    // conflict 置顶
    expect(r.groups[0]?.tone).toBe('conflict');
    const renamed = r.groups.find((g) => g.tone === 'renamed')?.entries[0];
    expect(renamed?.relativePath).toBe('new.txt');
    expect(renamed?.oldPath).toBe('old.txt');
  });

  // ── openDiff:写临时文件 + 走 FilePanelService ─────────────────────
  it('openDiff:把 diff 写入 workspace/__marina_diff__ 并交给 FilePanelService', async () => {
    // 让单文件 status 查询返回 modified,走 git diff HEAD 分支(不再触发 --no-index)
    const statusSample = '1 .M N... 100644 100644 100644 aaaa bbbb modified.txt\0';
    const diffText = 'diff --git a/modified.txt b/modified.txt\n+hello\n';
    const spy = vi
      .spyOn(service as unknown as { runGit: (...a: never[]) => Promise<unknown> }, 'runGit')
      // 第一次:status 单文件查;第二次:git diff HEAD --
      .mockResolvedValueOnce({ stdout: Buffer.from(statusSample, 'utf8'), stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: Buffer.from(diffText, 'utf8'), stderr: '', exitCode: 0 });

    const snap = await service.openDiff('s1', 'owner-1', 'modified.txt');

    expect(spy).toHaveBeenCalledTimes(2);
    expect(snap.files).toHaveLength(1);
    const opened = snap.files[0]!;
    // 临时文件落在 workspace/__marina_diff__/ 下,扩展名 .diff → detectFileKind 归类
    expect(opened.path).toContain('__marina_diff__');
    expect(opened.path.endsWith('.diff')).toBe(true);
    expect(opened.name.endsWith('.diff')).toBe(true);
  });

  it('openDiff:拒绝 .. 路径(防越界读仓库外文件)', async () => {
    await expect(
      service.openDiff('s1', 'owner-1', '../external/secret.txt'),
    ).rejects.toMatchObject({ code: 'OutsideRepoRoot' });
  });

  it('openDiff:拒绝绝对路径', async () => {
    await expect(
      service.openDiff('s1', 'owner-1', resolve(repoDir, 'x.txt')),
    ).rejects.toMatchObject({ code: 'InvalidPath' });
  });

  it('openDiff:SSH 直接拒绝(不进入 spawn)', async () => {
    await expect(service.openDiff('ssh1', 'owner-ssh', 'x.txt')).rejects.toMatchObject({
      code: 'SshUnsupported',
    });
  });

  it('openDiff:非 owner 拒绝', async () => {
    await expect(service.openDiff('s1', 'intruder', 'x.txt')).rejects.toMatchObject({
      code: 'NotOwner',
    });
  });

  // ── onSessionDestroyed:不抛、幂等 ─────────────────────────────────
  it('onSessionDestroyed:对无 watcher 的 session 调用也不抛', () => {
    expect(() => service.onSessionDestroyed('never-existed')).not.toThrow();
  });
});

// ── parsePorcelainV2 纯函数单测(不依赖 service 实例)─────────────────
describe('parsePorcelainV2', () => {
  it('空输入返回空数组', () => {
    expect(parsePorcelainV2('')).toEqual([]);
  });

  it('正确解析 untracked 行(? 前缀)', () => {
    const r = parsePorcelainV2('? new.txt\0');
    expect(r.find((g) => g.tone === 'untracked')?.entries[0]?.relativePath).toBe('new.txt');
  });

  it('正确解析 renamed 行(含 old\\tnew)', () => {
    const input = '2 RM N... 100644 100644 100644 aaaa bbbb R100 dest.txt\tsrc.txt\0';
    const r = parsePorcelainV2(input);
    const renamed = r.find((g) => g.tone === 'renamed')?.entries[0];
    expect(renamed?.relativePath).toBe('dest.txt');
    expect(renamed?.oldPath).toBe('src.txt');
  });

  it('正确解析 conflict 行(u 前缀)', () => {
    const input =
      'u UU N... 100644 100644 100644 100644 g1 g2 g3 conflict.txt\0';
    const r = parsePorcelainV2(input);
    expect(r.find((g) => g.tone === 'conflict')?.entries[0]?.relativePath).toBe('conflict.txt');
  });

  it('忽略 ! (ignored) 行与未知行', () => {
    const input = '! ignored.log\0xxx unknown\0';
    expect(parsePorcelainV2(input)).toEqual([]);
  });

  it('conflict 分组在输出中置顶', () => {
    const input =
      '? untracked.txt\0' +
      '1 .M N... 100644 100644 100644 a b modified.txt\0' +
      'u UU N... 100644 100644 100644 0000 100644 100644 g1 g2 g3 c.txt\0';
    const r = parsePorcelainV2(input);
    expect(r[0]?.tone).toBe('conflict');
  });
});
