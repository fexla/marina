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
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { BackgroundWorkScheduler } from './background-work-scheduler';
import { FilePanelService } from './file-panel-service';
import { PerformanceMetrics } from './performance-metrics';
import {
  GitService,
  buildGitSpawnEnv,
  parsePorcelainV2,
  type GitStatusSnapshot,
} from './git-service';
import { logger } from './logger';

interface SessionEntry {
  pathId: string;
  currentCwd: string;
  ownerWindowId: string | null;
  state: 'active' | 'idle' | 'exited';
}

describe('GitService', () => {
  let baseDir: string;
  let repoDir: string;
  let nonRepoDir: string;
  let workspaceDir: string;
  let sessions: Record<string, SessionEntry>;
  let filePanelService: FilePanelService;
  let scheduler: BackgroundWorkScheduler;
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
      s1: { pathId: repoDir, currentCwd: repoDir, ownerWindowId: 'owner-1', state: 'idle' },
      s2: {
        pathId: nonRepoDir,
        currentCwd: nonRepoDir,
        ownerWindowId: 'owner-2',
        state: 'idle',
      },
      ssh1: {
        pathId: 'ssh:profile-x',
        currentCwd: '/home/x',
        ownerWindowId: 'owner-ssh',
        state: 'idle',
      },
    };
    filePanelService = new FilePanelService();
    filePanelService.attachSessionLookup({ get: (id) => sessions[id] ?? null });
    scheduler = new BackgroundWorkScheduler({ metrics: new PerformanceMetrics() });
    service = new GitService(
      {
        get: (id) => sessions[id] ?? null,
        list: () => Object.entries(sessions).map(([id, s]) => ({ id, ...s })),
      },
      { getPathForSession: (id) => (id === 's1' || id === 's2' ? workspaceDir : null) },
      filePanelService,
      scheduler,
    );
    service.setRuntimeConfig({ enableGitPanel: true, gitBinaryPath: '' });
  });

  afterEach(async () => {
    service.shutdownPolling();
    scheduler.shutdown();
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

  it('NotOwner / SessionMissing 命中时打 warn 日志(诊断面板 race 的关键信号)', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    await expect(service.getStatus('s1', 'other-window')).rejects.toMatchObject({
      code: 'NotOwner',
    });
    expect(warnSpy).toHaveBeenCalledWith('GitService', expect.stringContaining('NotOwner'));
    expect(warnSpy.mock.calls[0]?.[1]).toContain('requester=other-window');
    expect(warnSpy.mock.calls[0]?.[1]).toContain('owner=owner-1');

    await expect(service.getStatus('nope', 'owner-1')).rejects.toMatchObject({
      code: 'SessionMissing',
    });
    expect(warnSpy).toHaveBeenCalledWith('GitService', expect.stringContaining('SessionMissing'));
    warnSpy.mockRestore();
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

  it('同 session+cwd 的并发 getStatus 合并为一个 git 子进程', async () => {
    let resolveRun!: (value: { stdout: Buffer; stderr: string; exitCode: number }) => void;
    const runGit = vi
      .spyOn(service as unknown as { runGit: (...a: never[]) => Promise<unknown> }, 'runGit')
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRun = resolve;
          }),
      );

    const first = service.getStatus('s1', 'owner-1');
    const second = service.getStatus('s1', 'owner-1');
    await vi.waitFor(() => expect(runGit).toHaveBeenCalledTimes(1));
    resolveRun({ stdout: Buffer.from('', 'utf8'), stderr: '', exitCode: 0 });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(runGit).toHaveBeenCalledTimes(1);
  });

  it('同 cwd 查询期间切换 Git 配置会串行重拉，不并发第二个 status', async () => {
    let resolveFirst!: (value: { stdout: Buffer; stderr: string; exitCode: number }) => void;
    const runGit = vi
      .spyOn(service as unknown as { runGit: (...a: never[]) => Promise<unknown> }, 'runGit')
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue({ stdout: Buffer.from('', 'utf8'), stderr: '', exitCode: 0 });

    const first = service.getStatus('s1', 'owner-1');
    await vi.waitFor(() => expect(runGit).toHaveBeenCalledTimes(1));
    service.setRuntimeConfig({ enableGitPanel: true, gitBinaryPath: 'alternate-git' });
    const second = service.getStatus('s1', 'owner-1');
    // repo 级 in-flight：第二个 getStatus 等待第一个进程结束后串行重拉，不并发启第二个。
    expect(runGit).toHaveBeenCalledTimes(1);

    resolveFirst({ stdout: Buffer.from('', 'utf8'), stderr: '', exitCode: 0 });
    // 旧进程结束后用新 revision 串行重拉一次。allow for repo 解析异步。
    await vi.waitFor(() => expect(runGit.mock.calls.length).toBeGreaterThanOrEqual(2));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    // 关键不变量：同 repo 任何时刻最多一个 git status 在跑（串行，不重叠）。
    const inFlight = (service as unknown as { statusInFlight: Map<string, unknown> })
      .statusInFlight;
    expect(inFlight.size).toBeLessThanOrEqual(1);
  });

  it('旧配置 status reject 后若 revision 已变化，等待结束再用新配置串行重试', async () => {
    let rejectFirst!: (error: Error) => void;
    const runGit = vi
      .spyOn(service as unknown as { runGit: (...a: never[]) => Promise<unknown> }, 'runGit')
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockResolvedValue({ stdout: Buffer.from('', 'utf8'), stderr: '', exitCode: 0 });

    const first = service.getStatus('s1', 'owner-1');
    await vi.waitFor(() => expect(runGit).toHaveBeenCalledTimes(1));
    service.setRuntimeConfig({ enableGitPanel: true, gitBinaryPath: 'replacement-git' });
    const second = service.getStatus('s1', 'owner-1');
    rejectFirst(new Error('old binary disappeared'));

    // 旧进程 reject 后用新 revision 串行重拉。
    await vi.waitFor(() => expect(runGit.mock.calls.length).toBeGreaterThanOrEqual(2));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(runGit.mock.calls.length).toBeGreaterThanOrEqual(2);
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
    // 回归保护:命令行**不再**带 --no-optional-locks(改走 env GIT_OPTIONAL_LOCKS=0)。
    //   该 flag 是 git 全局选项,旧代码却放在 status 子命令参数末尾 → status 报
    //   unknown option(exit 129)→ Git 面板误报“干净”(0.3.1-dev.1 引入的回归)。
    //   lock 防护现由 runGit 的 spawn env 注入,由下方专门 test 守护。
    //   spy 的类型是 (...a:never[]),mock.calls 索引不安全,故先转成具体元组数组。
    const calls = spy.mock.calls as unknown as Array<[string, string[]]>;
    const statusCalls = calls.filter(([, args]) => args.includes('status'));
    expect(statusCalls.length).toBeGreaterThan(0);
    for (const [, args] of statusCalls) {
      expect(args.includes('--no-optional-locks')).toBe(false);
    }
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

  // ── runGit env 注入(lock 防护,兼容性修复)─────────────────────────
  it('buildGitSpawnEnv:继承父环境并注入 GIT_OPTIONAL_LOCKS=0', () => {
    // 0.3.1-dev.1 把 git 全局选项 --no-optional-locks 错放在 status 参数末尾,
    // 导致 unknown option(exit 129)→ 面板误报“干净”。runGit 只通过本函数构造
    // env,故纯函数断言即可守护“无位置歧义 + 不抢锁”的契约。
    const env = buildGitSpawnEnv({ PATH: 'C:\\Git\\cmd', CUSTOM: 'kept' });
    expect(env.GIT_OPTIONAL_LOCKS).toBe('0');
    expect(env.PATH).toBe('C:\\Git\\cmd');
    expect(env.CUSTOM).toBe('kept');
  });

  // ── openDiff:写临时文件 + 走 FilePanelService ─────────────────────
  it('openDiff:把 diff 写入 workspace/__marina_diff__ 并交给 FilePanelService', async () => {
    await writeFile(join(repoDir, 'modified.txt'), 'source\n');
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
    // 导航目标由 GitService 的原始请求透传，DiffViewer 不应从展示文本反推。
    expect(opened.origin).toEqual({
      kind: 'git-diff',
      relativePath: 'modified.txt',
      repoIdentity: expect.any(String),
      sourceMissing: false,
    });
  });

  it('openDiff:中文 relativePath 作为来源元数据原样透传，不依赖 Git 引号文本', async () => {
    const relativePath = '目录/中文.ts';
    await mkdir(join(repoDir, '目录'));
    await writeFile(join(repoDir, relativePath), 'source\n');
    const statusSample = `1 .M N... 100644 100644 100644 aaaa bbbb ${relativePath}\0`;
    const diffText = String.raw`diff --git "a/\347\233\256\345\275\225/\344\270\255\346\226\207.ts" "b/\347\233\256\345\275\225/\344\270\255\346\226\207.ts"
--- "a/\347\233\256\345\275\225/\344\270\255\346\226\207.ts"
+++ "b/\347\233\256\345\275\225/\344\270\255\346\226\207.ts"`;
    vi.spyOn(service as unknown as { runGit: (...a: never[]) => Promise<unknown> }, 'runGit')
      .mockResolvedValueOnce({ stdout: Buffer.from(statusSample, 'utf8'), stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: Buffer.from(diffText, 'utf8'), stderr: '', exitCode: 0 });

    const snap = await service.openDiff('s1', 'owner-1', relativePath);

    expect(snap.files[0]?.origin).toEqual({
      kind: 'git-diff',
      relativePath,
      repoIdentity: expect.any(String),
      sourceMissing: false,
    });
  });

  it('openDiff:来源 repo 变化后拒绝把旧 diff 路径解析到新仓库', async () => {
    const relativePath = 'same-name.ts';
    await writeFile(join(repoDir, relativePath), 'original repository\n');
    const statusSample = `1 .M N... 100644 100644 100644 aaaa bbbb ${relativePath}\0`;
    const diffText = `diff --git a/${relativePath} b/${relativePath}\n+changed\n`;
    vi.spyOn(service as unknown as { runGit: (...a: never[]) => Promise<unknown> }, 'runGit')
      .mockResolvedValueOnce({ stdout: Buffer.from(statusSample, 'utf8'), stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: Buffer.from(diffText, 'utf8'), stderr: '', exitCode: 0 });
    const diff = await service.openDiff('s1', 'owner-1', relativePath);
    const repoIdentity = diff.files[0]?.origin?.repoIdentity;
    expect(repoIdentity).toEqual(expect.any(String));

    const otherRepo = join(baseDir, 'other-repo');
    await mkdir(join(otherRepo, '.git'), { recursive: true });
    await writeFile(join(otherRepo, relativePath), 'wrong repository\n');
    sessions.s1!.currentCwd = otherRepo;

    await expect(
      service.openFile('s1', 'owner-1', relativePath, repoIdentity),
    ).rejects.toMatchObject({ code: 'NotARepo' });
  });

  it('openDiff:deleted 变更把 sourceMissing 写入来源元数据', async () => {
    const relativePath = 'gone.ts';
    const statusSample = `1 .D N... 100644 000000 000000 aaaa 0000 ${relativePath}\0`;
    const diffText = `diff --git a/gone.ts b/gone.ts\n--- a/gone.ts\n+++ /dev/null\n`;
    vi.spyOn(service as unknown as { runGit: (...a: never[]) => Promise<unknown> }, 'runGit')
      .mockResolvedValueOnce({ stdout: Buffer.from(statusSample, 'utf8'), stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: Buffer.from(diffText, 'utf8'), stderr: '', exitCode: 0 });

    const snap = await service.openDiff('s1', 'owner-1', relativePath);

    expect(snap.files[0]?.origin).toEqual({
      kind: 'git-diff',
      relativePath,
      repoIdentity: expect.any(String),
      sourceMissing: true,
    });
  });

  it('openDiff:冲突删除也把 sourceMissing 标为 true', async () => {
    const relativePath = 'conflicted-delete.ts';
    const statusSample = `u DU N... 100644 000000 000000 000000 aaaa bbbb cccc ${relativePath}\0`;
    const diffText =
      `diff --git a/${relativePath} b/${relativePath}\n` +
      `deleted file mode 100644\n--- a/${relativePath}\n+++ /dev/null\n`;
    vi.spyOn(service as unknown as { runGit: (...a: never[]) => Promise<unknown> }, 'runGit')
      .mockResolvedValueOnce({ stdout: Buffer.from(statusSample, 'utf8'), stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: Buffer.from(diffText, 'utf8'), stderr: '', exitCode: 0 });

    const snap = await service.openDiff('s1', 'owner-1', relativePath);

    expect(snap.files[0]?.origin?.sourceMissing).toBe(true);
  });

  // ── v0.3.3:二进制文件点击 → 直接按普通方式打开(不产生 diff) ──────────
  it('openDiff:图片文件不走 diff,直接按普通方式打开真实文件', async () => {
    // PNG magic bytes:分支判定只看扩展名,但 FilePanelService 按 kind='image'
    // 会真读内容转 base64,给真实文件头让链路端到端成立。
    await writeFile(
      join(repoDir, 'logo.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
    );
    const spy = vi.spyOn(
      service as unknown as { runGit: (...a: never[]) => Promise<unknown> },
      'runGit',
    );

    const snap = await service.openDiff('s1', 'owner-1', 'logo.png');

    // 分流发生在任何 git 子进程之前:runGit 不应被调用
    expect(spy).not.toHaveBeenCalled();
    const opened = snap.files[0]!;
    expect(opened.path).not.toContain('__marina_diff__');
    expect(opened.path).toBe(await realpath(join(repoDir, 'logo.png')));
    expect(opened.kind).toBe('image');
    // 走 GitService.openFile 同构路径,无 git-diff origin 元数据
    expect(opened.origin).toBeUndefined();
  });

  it('openDiff:未知扩展名的二进制文件同样直接打开(kind=unknown 占位)', async () => {
    await writeFile(join(repoDir, 'bundle.exe'), Buffer.from([0x4d, 0x5a, 0x90, 0x00]));

    const snap = await service.openDiff('s1', 'owner-1', 'bundle.exe');

    const opened = snap.files[0]!;
    expect(opened.path).not.toContain('__marina_diff__');
    expect(opened.path).toBe(await realpath(join(repoDir, 'bundle.exe')));
    expect(opened.kind).toBe('unknown');
  });

  it('openDiff:deleted 的二进制文件保留 diff(工作区无实体,无法直接打开)', async () => {
    // 不写工作区文件:deleted 状态下实体已不存在
    const statusSample = `1 .D N... 100644 000000 000000 aaaa 0000 logo.png\0`;
    const diffText =
      `diff --git a/logo.png b/logo.png\n` +
      `deleted file mode 100644\n` +
      `Binary files a/logo.png and /dev/null differ\n`;
    vi.spyOn(service as unknown as { runGit: (...a: never[]) => Promise<unknown> }, 'runGit')
      .mockResolvedValueOnce({ stdout: Buffer.from(statusSample, 'utf8'), stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: Buffer.from(diffText, 'utf8'), stderr: '', exitCode: 0 });

    const snap = await service.openDiff('s1', 'owner-1', 'logo.png');

    expect(snap.files[0]?.path).toContain('__marina_diff__');
    expect(snap.files[0]?.origin).toMatchObject({
      kind: 'git-diff',
      relativePath: 'logo.png',
      sourceMissing: true,
    });
  });

  it('openDiff:目录条目(如 modified submodule)不回退,仍走 diff', async () => {
    // submodule 在 porcelain v2 里是普通条目(basename 无扩展名 → detectFileKind
    // ='unknown'),但目标是目录;diff 仍能显示 Subproject commit 变更,保留。
    await mkdir(join(repoDir, 'submod'));
    const statusSample = `1 .M N... 160000 160000 160000 aaaa bbbb submod\0`;
    const diffText =
      `diff --git a/submod b/submod\n` +
      `--- a/submod\n+++ b/submod\n` +
      `@@ -1 +1 @@\n-Subproject commit aaa\n+Subproject commit bbb\n`;
    vi.spyOn(service as unknown as { runGit: (...a: never[]) => Promise<unknown> }, 'runGit')
      .mockResolvedValueOnce({ stdout: Buffer.from(statusSample, 'utf8'), stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: Buffer.from(diffText, 'utf8'), stderr: '', exitCode: 0 });

    const snap = await service.openDiff('s1', 'owner-1', 'submod');

    expect(snap.files[0]?.path).toContain('__marina_diff__');
  });

  it('openDiff:拒绝经 symlink/junction 读取仓库外未跟踪文件内容', async () => {
    await writeFile(join(nonRepoDir, 'secret.txt'), 'TOP_SECRET_OUTSIDE');
    const escapedLink = join(repoDir, 'escaped-link');
    try {
      await symlink(nonRepoDir, escapedLink, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
      throw err;
    }
    const relativePath = 'escaped-link/secret.txt';
    vi.spyOn(
      service as unknown as { runGit: (...a: never[]) => Promise<unknown> },
      'runGit',
    ).mockResolvedValueOnce({
      stdout: Buffer.from(`? ${relativePath}\0`, 'utf8'),
      stderr: '',
      exitCode: 0,
    });
    const noIndex = vi
      .spyOn(
        service as unknown as {
          runGitNoIndex: (...a: never[]) => Promise<Buffer>;
        },
        'runGitNoIndex',
      )
      .mockResolvedValue(Buffer.from('+TOP_SECRET_OUTSIDE\n'));

    await expect(service.openDiff('s1', 'owner-1', relativePath)).rejects.toMatchObject({
      code: 'OutsideRepoRoot',
    });
    expect(noIndex).not.toHaveBeenCalled();
  });

  it('openDiff:拒绝 .. 路径(防越界读仓库外文件)', async () => {
    await expect(service.openDiff('s1', 'owner-1', '../external/secret.txt')).rejects.toMatchObject(
      { code: 'OutsideRepoRoot' },
    );
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

  // ── v0.3.3 openDiffByAbsolutePath:「已打开」文件 tab 右键「打开 diff」入口 ──
  // 与 openDiff 的唯一差别:仓库按文件自身位置定位,与 session currentCwd 无关。
  // 这里用 s2(cwd 在 nonRepoDir)打开 repoDir 内的文件,证明仓库不是从 cwd 推的。
  it('openDiffByAbsolutePath:按文件自身位置定位仓库(cwd 不在 repo 也能打开)', async () => {
    await writeFile(join(repoDir, 'modified.txt'), 'source\n');
    const statusSample = '1 .M N... 100644 100644 100644 aaaa bbbb modified.txt\0';
    const diffText = 'diff --git a/modified.txt b/modified.txt\n+hello\n';
    const spy = vi
      .spyOn(service as unknown as { runGit: (...a: never[]) => Promise<unknown> }, 'runGit')
      .mockResolvedValueOnce({ stdout: Buffer.from(statusSample, 'utf8'), stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: Buffer.from(diffText, 'utf8'), stderr: '', exitCode: 0 });

    const snap = await service.openDiffByAbsolutePath(
      's2',
      'owner-2',
      join(repoDir, 'modified.txt'),
    );

    expect(spy).toHaveBeenCalledTimes(2);
    expect(snap.files).toHaveLength(1);
    const opened = snap.files[0]!;
    expect(opened.path).toContain('__marina_diff__');
    expect(opened.origin).toEqual({
      kind: 'git-diff',
      relativePath: 'modified.txt',
      repoIdentity: expect.any(String),
      sourceMissing: false,
    });
  });

  it('openDiffByAbsolutePath:子目录文件换算出 repo 相对路径(平台分隔符)', async () => {
    await mkdir(join(repoDir, 'sub'));
    await writeFile(join(repoDir, 'sub', 'nested.ts'), 'source\n');
    const statusSample = '1 .M N... 100644 100644 100644 aaaa bbbb sub/nested.ts\0';
    const diffText = 'diff --git a/sub/nested.ts b/sub/nested.ts\n+hello\n';
    vi.spyOn(service as unknown as { runGit: (...a: never[]) => Promise<unknown> }, 'runGit')
      .mockResolvedValueOnce({ stdout: Buffer.from(statusSample, 'utf8'), stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: Buffer.from(diffText, 'utf8'), stderr: '', exitCode: 0 });

    const snap = await service.openDiffByAbsolutePath(
      's2',
      'owner-2',
      join(repoDir, 'sub', 'nested.ts'),
    );

    // relativePath 由 canonical repoRoot 派生,期望值用同一 API 计算(不硬编码分隔符)
    const expectedRelative = relative(
      await realpath(repoDir),
      await realpath(join(repoDir, 'sub', 'nested.ts')),
    );
    expect(snap.files[0]?.origin).toMatchObject({
      kind: 'git-diff',
      relativePath: expectedRelative,
    });
  });

  it('openDiffByAbsolutePath:文件不在任何 Git 仓库 → NotARepo', async () => {
    await writeFile(join(nonRepoDir, 'plain.txt'), 'no repo here\n');
    await expect(
      service.openDiffByAbsolutePath('s2', 'owner-2', join(nonRepoDir, 'plain.txt')),
    ).rejects.toMatchObject({ code: 'NotARepo' });
  });

  it('openDiffByAbsolutePath:文件不存在(僵尸 tab 竞态兜底)→ InvalidPath', async () => {
    await expect(
      service.openDiffByAbsolutePath('s1', 'owner-1', join(repoDir, 'vanished.txt')),
    ).rejects.toMatchObject({ code: 'InvalidPath' });
  });

  it('openDiffByAbsolutePath:symlink/junction 目标在仓库外 → 按真实位置判定,不进 diff', async () => {
    // repo 内 link 指向仓库外目录:realpath 把文件解析到真实位置,再从那里找
    // 仓库 → 找不到 → NotARepo。仓库外内容不会借 abs 入口进入 diff。
    await writeFile(join(nonRepoDir, 'secret.txt'), 'TOP_SECRET_OUTSIDE');
    const escapedLink = join(repoDir, 'escaped-link');
    try {
      await symlink(nonRepoDir, escapedLink, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
      throw err;
    }
    const spy = vi.spyOn(
      service as unknown as { runGit: (...a: never[]) => Promise<unknown> },
      'runGit',
    );
    await expect(
      service.openDiffByAbsolutePath('s1', 'owner-1', join(escapedLink, 'secret.txt')),
    ).rejects.toMatchObject({ code: 'NotARepo' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('openDiffByAbsolutePath:SSH 拒绝(不进入任何文件系统访问)', async () => {
    await expect(
      service.openDiffByAbsolutePath('ssh1', 'owner-ssh', resolve(repoDir, 'x.txt')),
    ).rejects.toMatchObject({ code: 'SshUnsupported' });
  });

  it('openDiffByAbsolutePath:非 owner 拒绝', async () => {
    await expect(
      service.openDiffByAbsolutePath('s1', 'intruder', join(repoDir, 'x.txt')),
    ).rejects.toMatchObject({ code: 'NotOwner' });
  });

  // ── v0.3.1 openFile:打开文件本身(不走 diff) ──────────────────────
  it('openFile:resolve 越界后成功打开(返回 snapshot,不走 diff 临时文件)', async () => {
    // openFile 读真实工作区文件(不同于 openDiff 走临时文件),需造实体文件
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(repoDir, 'modified.txt'), 'hello world\n');
    const snap = await service.openFile('s1', 'owner-1', 'modified.txt');
    // 返回 FilePanelSnapshot:activePath 是工作区真实路径(非 __marina_diff__)
    expect(snap.activePath).toBeTruthy();
    expect(snap.activePath).not.toContain('__marina_diff__');
    expect(snap.activePath?.endsWith('modified.txt')).toBe(true);
  });

  it('openFile:拒绝 .. 路径(防越界)', async () => {
    await expect(service.openFile('s1', 'owner-1', '../external/secret.txt')).rejects.toMatchObject(
      {
        code: 'OutsideRepoRoot',
      },
    );
  });

  it('openFile:拒绝经 symlink/junction 逃逸到仓库外', async () => {
    await writeFile(join(nonRepoDir, 'secret.txt'), 'outside');
    const escapedLink = join(repoDir, 'escaped-link');
    try {
      await symlink(nonRepoDir, escapedLink, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
      throw err;
    }

    await expect(
      service.openFile('s1', 'owner-1', 'escaped-link/secret.txt'),
    ).rejects.toMatchObject({ code: 'OutsideRepoRoot' });
    await expect(
      service.resolvePath('s1', 'owner-1', 'escaped-link/secret.txt'),
    ).rejects.toMatchObject({ code: 'OutsideRepoRoot' });
  });

  it('openFile:SSH 拒绝', async () => {
    await expect(service.openFile('ssh1', 'owner-ssh', 'x.txt')).rejects.toMatchObject({
      code: 'SshUnsupported',
    });
  });

  // ── v0.3.1 resolvePath:相对路径 → 绝对路径 ───────────────────────
  it('resolvePath:返回 repoRoot + relativePath 的绝对路径', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(repoDir, 'resolve-target.txt'), 'x');
    const abs = await service.resolvePath('s1', 'owner-1', 'resolve-target.txt');
    expect(abs.endsWith('resolve-target.txt')).toBe(true);
  });

  it('resolvePath:拒绝 .. 路径', async () => {
    await expect(service.resolvePath('s1', 'owner-1', '../x.txt')).rejects.toMatchObject({
      code: 'OutsideRepoRoot',
    });
  });

  it('resolvePath:SSH 拒绝', async () => {
    await expect(service.resolvePath('ssh1', 'owner-ssh', 'x.txt')).rejects.toMatchObject({
      code: 'SshUnsupported',
    });
  });

  // ── onSessionDestroyed:不抛、幂等 ─────────────────────────────────
  it('onSessionDestroyed:对无 watcher 的 session 调用也不抛', () => {
    expect(() => service.onSessionDestroyed('never-existed')).not.toThrow();
  });

  // ── prefetchStatus:ADR-021 起只同步 availability/task，不无条件 spawn ──
  it('prefetchStatus:仓库可用时只注册 COLD task，不在无 UI demand 时跑 git', async () => {
    const runGit = vi.spyOn(
      service as unknown as { runGit: (...a: never[]) => Promise<unknown> },
      'runGit',
    );
    const emitted: unknown[] = [];
    service.on('gitStatusUpdated', (payload) => emitted.push(payload));

    await service.prefetchStatus('s1');

    expect(runGit).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
    expect(scheduler.getSnapshot()).toMatchObject({ tasks: 1, hotTasks: 0, warmTasks: 0 });
  });

  it('prefetchStatus:SSH session emit unavailable,不 throw', async () => {
    const emitted: unknown[] = [];
    service.on('gitStatusUpdated', (p) => emitted.push(p));
    await expect(service.prefetchStatus('ssh1')).resolves.toBeUndefined();
    expect(emitted).toHaveLength(1);
    expect((emitted[0] as { unavailable: string }).unavailable).toBe('ssh-unsupported');
  });

  it('prefetchStatus:session 不存在时不 emit，也不遗留 availability epoch', async () => {
    const emitted: unknown[] = [];
    service.on('gitStatusUpdated', (p) => emitted.push(p));
    await expect(service.prefetchStatus('never-existed')).resolves.toBeUndefined();
    expect(emitted).toHaveLength(0);
    const epochs = (service as unknown as { availabilityEpoch: Map<string, number> })
      .availabilityEpoch;
    expect(epochs.has('never-existed')).toBe(false);
  });

  // ── ADR-021 demand-aware polling task:prefetch 注册,COLD 无 timer,HOT/WARM 动态调度 ──
  // 方案 A 后 watcher 按 repo 去重：sessionRepoKey 记录 session 当前 attach 到哪个 repo。
  const sessionAttachedToRepo = (svc: GitService, sessionId: string): boolean =>
    (svc as unknown as { sessionRepoKey: Map<string, string> }).sessionRepoKey.has(sessionId);
  const pendingDemandCount = (svc: GitService): number =>
    (svc as unknown as { pendingSessionDemand: Map<string, unknown> }).pendingSessionDemand.size;

  it('renderer demand 可早于 prefetch/task 注册到达，HOT 注册后立即刷新且查询合并', async () => {
    const sample = '1 .M N... 100644 100644 100644 aaaa bbbb modified.txt\0';
    const runGit = vi
      .spyOn(service as unknown as { runGit: (...a: never[]) => Promise<unknown> }, 'runGit')
      .mockResolvedValue({ stdout: Buffer.from(sample, 'utf8'), stderr: '', exitCode: 0 });

    service.setPollingDemand('s1', 'owner-1', 'hot');
    expect(pendingDemandCount(service)).toBe(1);
    await service.prefetchStatus('s1');
    const mountRequest = service.getStatus('s1', 'owner-1');
    await mountRequest;
    await vi.waitFor(() => expect(runGit).toHaveBeenCalledTimes(1));

    expect(scheduler.getSnapshot()).toMatchObject({ hotTasks: 1 });
    expect(pendingDemandCount(service)).toBe(0);
    // GitPanel mount 与 HOT immediate 同时到达仍只 spawn 一个 status。
    expect(runGit).toHaveBeenCalledTimes(1);
  });

  it('Git 集成策略为 WARM 60s、HOT 立即后 3s、NONE 停止', async () => {
    vi.useFakeTimers();
    const sample = '1 .M N... 100644 100644 100644 aaaa bbbb modified.txt\0';
    const runGit = vi
      .spyOn(service as unknown as { runGit: (...a: never[]) => Promise<unknown> }, 'runGit')
      .mockResolvedValue({ stdout: Buffer.from(sample, 'utf8'), stderr: '', exitCode: 0 });
    try {
      await service.prefetchStatus('s1');
      expect(runGit).not.toHaveBeenCalled();
      service.setPollingDemand('s1', 'owner-1', 'warm');
      await vi.advanceTimersByTimeAsync(59_999);
      expect(runGit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(runGit).toHaveBeenCalledTimes(1);

      service.setPollingDemand('s1', 'owner-1', 'hot');
      await vi.advanceTimersByTimeAsync(0);
      expect(runGit).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(3000);
      expect(runGit).toHaveBeenCalledTimes(3);

      service.setPollingDemand('s1', 'owner-1', 'none');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runGit).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('task 注册前的 HOT demand 遇到非仓库 prefetch 会被彻底清理', async () => {
    service.setPollingDemand('s2', 'owner-2', 'hot');
    expect(pendingDemandCount(service)).toBe(1);
    await service.prefetchStatus('s2');
    expect(scheduler.getSnapshot()).toMatchObject({ tasks: 0 });
    expect(pendingDemandCount(service)).toBe(0);
  });

  it('polling demand 校验 owner；NONE 在 session 已消失后仍幂等', () => {
    expect(() => service.setPollingDemand('s1', 'not-owner', 'hot')).toThrow('NotOwner');
    delete sessions.s1;
    expect(() => service.setPollingDemand('s1', 'owner-1', 'none')).not.toThrow();
  });

  it('owner 变化清掉旧 HOT demand，task 保留为 COLD 等新 owner 上报', async () => {
    const sample = '1 .M N... 100644 100644 100644 aaaa bbbb modified.txt\0';
    vi.spyOn(
      service as unknown as { runGit: (...a: never[]) => Promise<unknown> },
      'runGit',
    ).mockResolvedValue({ stdout: Buffer.from(sample, 'utf8'), stderr: '', exitCode: 0 });
    await service.prefetchStatus('s1');
    service.setPollingDemand('s1', 'owner-1', 'hot');
    expect(scheduler.getSnapshot().hotTasks).toBe(1);

    sessions.s1!.ownerWindowId = 'owner-2';
    service.onSessionOwnerChanged('s1');
    expect(scheduler.getSnapshot()).toMatchObject({ tasks: 1, hotTasks: 0, warmTasks: 0 });
  });

  it('prefetchStatus 成功(仓库可用)后启动 watcher(watchers Map 含该 session)', async () => {
    const sample = '1 .M N... 100644 100644 100644 aaaa bbbb modified.txt\0';
    vi.spyOn(
      service as unknown as { runGit: (...a: never[]) => Promise<unknown> },
      'runGit',
    ).mockResolvedValue({ stdout: Buffer.from(sample, 'utf8'), stderr: '', exitCode: 0 });
    expect(sessionAttachedToRepo(service, 's1')).toBe(false);
    await service.prefetchStatus('s1');
    expect(sessionAttachedToRepo(service, 's1')).toBe(true);
  });

  it('prefetchStatus SSH(unavailable)不启动 watcher', async () => {
    await service.prefetchStatus('ssh1');
    expect(sessionAttachedToRepo(service, 'ssh1')).toBe(false);
  });

  // ── 方案 A：watcher 按 repo 去重（同 repo 多 session 共享一个 task）─────
  it('同 repo 多个 session 共享一个 polling task（不重复轮询）', async () => {
    const sample = '1 .M N... 100644 100644 100644 aaaa bbbb modified.txt\0';
    const runGit = vi
      .spyOn(service as unknown as { runGit: (...a: never[]) => Promise<unknown> }, 'runGit')
      .mockResolvedValue({ stdout: Buffer.from(sample, 'utf8'), stderr: '', exitCode: 0 });
    sessions.s3 = { pathId: repoDir, currentCwd: repoDir, ownerWindowId: 'owner-3', state: 'idle' };
    const emitted: { sessionId: string }[] = [];
    service.on('gitStatusUpdated', (p: { sessionId: string }) => emitted.push(p));
    await service.prefetchStatus('s1');
    await service.prefetchStatus('s3');
    expect(sessionAttachedToRepo(service, 's1')).toBe(true);
    expect(sessionAttachedToRepo(service, 's3')).toBe(true);
    // scheduler 只注册了 1 个 task（repo 去重）。
    expect(scheduler.getSnapshot().tasks).toBe(1);

    service.setPollingDemand('s1', 'owner-1', 'hot');
    await vi.waitFor(() => expect(runGit).toHaveBeenCalledTimes(1));
    // HOT 轮询只跑一次 git status，fan-out 给两个 session。
    await vi.waitFor(() => {
      const ids = emitted.map((e) => e.sessionId).sort();
      expect(ids).toEqual(['s1', 's3']);
    });
    expect(runGit).toHaveBeenCalledTimes(1); // 同 repo 仍然只一次 spawn
    service.onSessionDestroyed('s3');
    service.onSessionDestroyed('s1');
  });

  it('同 repo 全部 session 退出后 repo task 被注销', async () => {
    const sample = '1 .M N... 100644 100644 100644 aaaa bbbb modified.txt\0';
    vi.spyOn(
      service as unknown as { runGit: (...a: never[]) => Promise<unknown> },
      'runGit',
    ).mockResolvedValue({ stdout: Buffer.from(sample, 'utf8'), stderr: '', exitCode: 0 });
    sessions.s3 = { pathId: repoDir, currentCwd: repoDir, ownerWindowId: 'owner-3', state: 'idle' };
    await service.prefetchStatus('s1');
    await service.prefetchStatus('s3');
    expect(scheduler.getSnapshot().tasks).toBe(1);
    service.onSessionDestroyed('s3'); // 还剩 s1 → task 保留
    expect(scheduler.getSnapshot().tasks).toBe(1);
    service.onSessionDestroyed('s1'); // 全部退出 → 注销
    expect(scheduler.getSnapshot().tasks).toBe(0);
  });

  it('不同 repo 的 session 各自独立 task', async () => {
    const repoDir2 = join(baseDir, 'repo2');
    await mkdir(join(repoDir2, '.git'), { recursive: true });
    sessions.s3 = {
      pathId: repoDir2,
      currentCwd: repoDir2,
      ownerWindowId: 'owner-3',
      state: 'idle',
    };
    const sample = '1 .M N... 100644 100644 100644 aaaa bbbb modified.txt\0';
    vi.spyOn(
      service as unknown as { runGit: (...a: never[]) => Promise<unknown> },
      'runGit',
    ).mockResolvedValue({ stdout: Buffer.from(sample, 'utf8'), stderr: '', exitCode: 0 });
    await service.prefetchStatus('s1');
    await service.prefetchStatus('s3');
    expect(scheduler.getSnapshot().tasks).toBe(2); // 两个 repo 各一个 task
    service.onSessionDestroyed('s3');
    service.onSessionDestroyed('s1');
  });

  it('onSessionExited 清理 watcher(exited tab 保留但不再后台扫描)', async () => {
    const sample = '1 .M N... 100644 100644 100644 aaaa bbbb modified.txt\0';
    vi.spyOn(
      service as unknown as { runGit: (...a: never[]) => Promise<unknown> },
      'runGit',
    ).mockResolvedValue({ stdout: Buffer.from(sample, 'utf8'), stderr: '', exitCode: 0 });
    await service.prefetchStatus('s1');
    expect(sessionAttachedToRepo(service, 's1')).toBe(true);
    service.onSessionExited('s1');
    expect(sessionAttachedToRepo(service, 's1')).toBe(false);
  });

  it('慢 availability 与 PTY exit 竞态时不会在退出后复活 watcher', async () => {
    let resolveRealpath!: (value: string) => void;
    let entered!: () => void;
    const realpathEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(
      service as unknown as { realpathOrThrow: (cwd: string) => Promise<string> },
      'realpathOrThrow',
    ).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRealpath = resolve;
          entered();
        }),
    );

    const pending = service.prefetchStatus('s1');
    await realpathEntered;
    sessions.s1!.state = 'exited';
    service.onSessionExited('s1');
    resolveRealpath(repoDir);
    await pending;

    expect(sessionAttachedToRepo(service, 's1')).toBe(false);
  });

  it('onSessionDestroyed 清理 watcher(watchers Map 移除)', async () => {
    const sample = '1 .M N... 100644 100644 100644 aaaa bbbb modified.txt\0';
    vi.spyOn(
      service as unknown as { runGit: (...a: never[]) => Promise<unknown> },
      'runGit',
    ).mockResolvedValue({ stdout: Buffer.from(sample, 'utf8'), stderr: '', exitCode: 0 });
    await service.prefetchStatus('s1');
    expect(sessionAttachedToRepo(service, 's1')).toBe(true);
    service.onSessionDestroyed('s1');
    expect(sessionAttachedToRepo(service, 's1')).toBe(false);
    const epochs = (service as unknown as { availabilityEpoch: Map<string, number> })
      .availabilityEpoch;
    expect(epochs.has('s1')).toBe(false);
  });

  it('关闭 Git 面板立即清掉全部 watcher', async () => {
    const sample = '1 .M N... 100644 100644 100644 aaaa bbbb modified.txt\0';
    vi.spyOn(
      service as unknown as { runGit: (...a: never[]) => Promise<unknown> },
      'runGit',
    ).mockResolvedValue({ stdout: Buffer.from(sample, 'utf8'), stderr: '', exitCode: 0 });
    await service.prefetchStatus('s1');
    expect(sessionAttachedToRepo(service, 's1')).toBe(true);
    service.setRuntimeConfig({ enableGitPanel: false, gitBinaryPath: '' });
    expect(
      (service as unknown as { sessionRepoKey: Map<string, unknown> }).sessionRepoKey.size,
    ).toBe(0);
  });

  it('慢 availability 与关闭 Git 竞态时不会用旧结果复活 watcher', async () => {
    let resolveRealpath!: (value: string) => void;
    let entered!: () => void;
    const realpathEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(
      service as unknown as { realpathOrThrow: (cwd: string) => Promise<string> },
      'realpathOrThrow',
    ).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRealpath = resolve;
          entered();
        }),
    );

    const pending = service.prefetchStatus('s1');
    await realpathEntered;
    service.setRuntimeConfig({ enableGitPanel: false, gitBinaryPath: '' });
    resolveRealpath(repoDir);
    await pending;

    expect(sessionAttachedToRepo(service, 's1')).toBe(false);
  });

  it('session 离开仓库后 prefetchStatus 停止既有 watcher', async () => {
    const sample = '1 .M N... 100644 100644 100644 aaaa bbbb modified.txt\0';
    vi.spyOn(
      service as unknown as { runGit: (...a: never[]) => Promise<unknown> },
      'runGit',
    ).mockResolvedValue({ stdout: Buffer.from(sample, 'utf8'), stderr: '', exitCode: 0 });
    await service.prefetchStatus('s1');
    expect(sessionAttachedToRepo(service, 's1')).toBe(true);
    sessions.s1!.currentCwd = nonRepoDir;
    await service.prefetchStatus('s1');
    expect(sessionAttachedToRepo(service, 's1')).toBe(false);
  });

  it('慢 poll 未完成时跳过下一轮,不叠加后台 git status', async () => {
    vi.useFakeTimers();
    let resolvePoll!: () => void;
    const runGit = vi
      .spyOn(service as unknown as { runGit: (...a: never[]) => Promise<unknown> }, 'runGit')
      .mockImplementation(
        () =>
          new Promise<unknown>((resolve) => {
            resolvePoll = () =>
              resolve({ stdout: Buffer.from('', 'utf8'), stderr: '', exitCode: 0 });
          }),
      );
    try {
      // attach 到 repo（走 prefetch 路径，不 spawn git）后切 HOT 触发首次轮询。
      await service.prefetchStatus('s1');
      service.setPollingDemand('s1', 'owner-1', 'hot');
      await vi.advanceTimersByTimeAsync(0);
      expect(runGit).toHaveBeenCalledTimes(1);
      // 上一轮 git status 仍未返回；HOT 续排的 3s 后不应再叠第二个 status。
      await vi.advanceTimersByTimeAsync(6000);
      expect(runGit).toHaveBeenCalledTimes(1);

      resolvePoll();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(3000);
      expect(runGit).toHaveBeenCalledTimes(2);
    } finally {
      service.onSessionDestroyed('s1');
      vi.useRealTimers();
    }
  });

  it('watcher 轮询会 emit(真实短间隔定时器集成验证)', async () => {
    vi.useFakeTimers();
    const sample = '1 .M N... 100644 100644 100644 aaaa bbbb modified.txt\0';
    const runGit = vi
      .spyOn(service as unknown as { runGit: (...a: never[]) => Promise<unknown> }, 'runGit')
      .mockResolvedValue({ stdout: Buffer.from(sample, 'utf8'), stderr: '', exitCode: 0 });
    const emitted: unknown[] = [];
    service.on('gitStatusUpdated', (p) => emitted.push(p));
    try {
      await service.prefetchStatus('s1');
      service.setPollingDemand('s1', 'owner-1', 'hot');
      await vi.advanceTimersByTimeAsync(0);
      // HOT 立即触发一次轮询，emit 给 session。
      expect(runGit).toHaveBeenCalledTimes(1);
      expect(emitted).toHaveLength(1);
      expect((emitted[0] as { sessionId: string }).sessionId).toBe('s1');
      await vi.advanceTimersByTimeAsync(3000);
      expect(emitted).toHaveLength(2);
    } finally {
      service.onSessionDestroyed('s1');
      vi.useRealTimers();
    }
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
    const input = 'u UU N... 100644 100644 100644 100644 g1 g2 g3 conflict.txt\0';
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
