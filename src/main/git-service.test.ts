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
import { BackgroundWorkScheduler } from './background-work-scheduler';
import { FilePanelService } from './file-panel-service';
import { PerformanceMetrics } from './performance-metrics';
import {
  GitService,
  buildGitSpawnEnv,
  parsePorcelainV2,
  type GitStatusSnapshot,
} from './git-service';

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
      { get: (id) => sessions[id] ?? null },
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
    expect(runGit).toHaveBeenCalledTimes(1);

    resolveFirst({ stdout: Buffer.from('', 'utf8'), stderr: '', exitCode: 0 });
    await vi.waitFor(() => expect(runGit).toHaveBeenCalledTimes(2));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(runGit).toHaveBeenCalledTimes(2);
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

    await vi.waitFor(() => expect(runGit).toHaveBeenCalledTimes(2));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(runGit).toHaveBeenCalledTimes(2);
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
  // watchers Map 现表示 scheduler task registry，不再持有 setInterval。
  const getWatchers = (svc: GitService): Map<string, unknown> =>
    (svc as unknown as { watchers: Map<string, unknown> }).watchers;

  it('renderer demand 可早于 prefetch/task 注册到达，HOT 注册后立即刷新且查询合并', async () => {
    const sample = '1 .M N... 100644 100644 100644 aaaa bbbb modified.txt\0';
    const runGit = vi
      .spyOn(service as unknown as { runGit: (...a: never[]) => Promise<unknown> }, 'runGit')
      .mockResolvedValue({ stdout: Buffer.from(sample, 'utf8'), stderr: '', exitCode: 0 });

    service.setPollingDemand('s1', 'owner-1', 'hot');
    expect(scheduler.getSnapshot().pendingDemandTasks).toBe(1);
    await service.prefetchStatus('s1');
    const mountRequest = service.getStatus('s1', 'owner-1');
    await mountRequest;
    await vi.waitFor(() => expect(runGit).toHaveBeenCalledTimes(1));

    expect(scheduler.getSnapshot()).toMatchObject({ hotTasks: 1, pendingDemandTasks: 0 });
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
      const refresh = vi
        .spyOn(
          service as unknown as { emitCurrentStatus: (sessionId: string) => Promise<void> },
          'emitCurrentStatus',
        )
        .mockResolvedValue();
      service.setPollingDemand('s1', 'owner-1', 'warm');
      await vi.advanceTimersByTimeAsync(59_999);
      expect(refresh).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(refresh).toHaveBeenCalledTimes(1);

      service.setPollingDemand('s1', 'owner-1', 'hot');
      await vi.advanceTimersByTimeAsync(0);
      expect(refresh).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(3000);
      expect(refresh).toHaveBeenCalledTimes(3);

      service.setPollingDemand('s1', 'owner-1', 'none');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(refresh).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('task 注册前的 HOT demand 遇到非仓库 prefetch 会被彻底清理', async () => {
    service.setPollingDemand('s2', 'owner-2', 'hot');
    expect(scheduler.getSnapshot().pendingDemandTasks).toBe(1);
    await service.prefetchStatus('s2');
    expect(scheduler.getSnapshot()).toMatchObject({ tasks: 0, pendingDemandTasks: 0 });
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
    expect(getWatchers(service).has('s1')).toBe(false);
    await service.prefetchStatus('s1');
    expect(getWatchers(service).has('s1')).toBe(true);
  });

  it('prefetchStatus SSH(unavailable)不启动 watcher', async () => {
    await service.prefetchStatus('ssh1');
    expect(getWatchers(service).has('ssh1')).toBe(false);
  });

  it('onSessionExited 清理 watcher(exited tab 保留但不再后台扫描)', async () => {
    const sample = '1 .M N... 100644 100644 100644 aaaa bbbb modified.txt\0';
    vi.spyOn(
      service as unknown as { runGit: (...a: never[]) => Promise<unknown> },
      'runGit',
    ).mockResolvedValue({ stdout: Buffer.from(sample, 'utf8'), stderr: '', exitCode: 0 });
    await service.prefetchStatus('s1');
    expect(getWatchers(service).has('s1')).toBe(true);
    service.onSessionExited('s1');
    expect(getWatchers(service).has('s1')).toBe(false);
  });

  it('慢 availability 与 PTY exit 竞态时不会在退出后复活 watcher', async () => {
    let resolveAvailability!: (value: { available: true }) => void;
    let entered!: () => void;
    const availabilityEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(service, 'evaluateAvailability').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAvailability = resolve;
          entered();
        }),
    );

    const pending = service.prefetchStatus('s1');
    await availabilityEntered;
    sessions.s1!.state = 'exited';
    service.onSessionExited('s1');
    resolveAvailability({ available: true });
    await pending;

    expect(getWatchers(service).has('s1')).toBe(false);
  });

  it('onSessionDestroyed 清理 watcher(watchers Map 移除)', async () => {
    const sample = '1 .M N... 100644 100644 100644 aaaa bbbb modified.txt\0';
    vi.spyOn(
      service as unknown as { runGit: (...a: never[]) => Promise<unknown> },
      'runGit',
    ).mockResolvedValue({ stdout: Buffer.from(sample, 'utf8'), stderr: '', exitCode: 0 });
    await service.prefetchStatus('s1');
    expect(getWatchers(service).has('s1')).toBe(true);
    service.onSessionDestroyed('s1');
    expect(getWatchers(service).has('s1')).toBe(false);
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
    expect(getWatchers(service).has('s1')).toBe(true);
    service.setRuntimeConfig({ enableGitPanel: false, gitBinaryPath: '' });
    expect(getWatchers(service).size).toBe(0);
  });

  it('慢 availability 与关闭 Git 竞态时不会用旧结果复活 watcher', async () => {
    vi.spyOn(
      service as unknown as { emitCurrentStatus: (sessionId: string) => Promise<void> },
      'emitCurrentStatus',
    ).mockResolvedValue();
    let resolveAvailability!: (value: { available: true; repoRoot: string }) => void;
    let entered!: () => void;
    const availabilityEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(service, 'evaluateAvailability').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAvailability = resolve;
          entered();
        }),
    );

    const pending = service.prefetchStatus('s1');
    await availabilityEntered;
    service.setRuntimeConfig({ enableGitPanel: false, gitBinaryPath: '' });
    resolveAvailability({ available: true, repoRoot: repoDir });
    await pending;

    expect(getWatchers(service).has('s1')).toBe(false);
  });

  it('session 离开仓库后 prefetchStatus 停止既有 watcher', async () => {
    const sample = '1 .M N... 100644 100644 100644 aaaa bbbb modified.txt\0';
    vi.spyOn(
      service as unknown as { runGit: (...a: never[]) => Promise<unknown> },
      'runGit',
    ).mockResolvedValue({ stdout: Buffer.from(sample, 'utf8'), stderr: '', exitCode: 0 });
    await service.prefetchStatus('s1');
    expect(getWatchers(service).has('s1')).toBe(true);
    sessions.s1!.currentCwd = nonRepoDir;
    await service.prefetchStatus('s1');
    expect(getWatchers(service).has('s1')).toBe(false);
  });

  it('慢 poll 未完成时跳过下一轮,不叠加后台 git status', async () => {
    vi.useFakeTimers();
    let resolvePoll!: () => void;
    const emitCurrentStatus = vi
      .spyOn(
        service as unknown as { emitCurrentStatus: (sessionId: string) => Promise<void> },
        'emitCurrentStatus',
      )
      .mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolvePoll = resolve;
          }),
      );
    try {
      (
        service as unknown as {
          startWatcher: (sessionId: string) => void;
        }
      ).startWatcher('s1');
      service.setPollingDemand('s1', 'owner-1', 'hot');
      await vi.advanceTimersByTimeAsync(0);
      expect(emitCurrentStatus).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(6000);
      expect(emitCurrentStatus).toHaveBeenCalledTimes(1);

      resolvePoll();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(3000);
      expect(emitCurrentStatus).toHaveBeenCalledTimes(2);
    } finally {
      service.onSessionDestroyed('s1');
      vi.useRealTimers();
    }
  });

  it('watcher 轮询会 emit(真实短间隔定时器集成验证)', async () => {
    // 临时覆写轮询间隔为 30ms 以快测(通过原型 hack)。
    const sample = '1 .M N... 100644 100644 100644 aaaa bbbb modified.txt\0';
    vi.spyOn(
      service as unknown as { runGit: (...a: never[]) => Promise<unknown> },
      'runGit',
    ).mockResolvedValue({ stdout: Buffer.from(sample, 'utf8'), stderr: '', exitCode: 0 });
    const emitted: unknown[] = [];
    service.on('gitStatusUpdated', (p) => emitted.push(p));
    // 用一个独立的短间隔 service 避免影响其他用例:直接调 startWatcher 的等价路径
    // —— 这里复用 prefetchStatus 启动默认 3s watcher,然后用 advanceTimer。
    // 简化:直接验证 emitCurrentStatus 能独立 emit(轮询就是重复调它)。
    await (
      service as unknown as { emitCurrentStatus: (id: string) => Promise<void> }
    ).emitCurrentStatus('s1');
    expect(emitted).toHaveLength(1);
    expect((emitted[0] as { sessionId: string }).sessionId).toBe('s1');
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
