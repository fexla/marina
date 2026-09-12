/**
 * @file command-panel-service.test.ts
 * @purpose 守护 CommandPanelService 的核心契约(AGENTS.md §5 状态机 + 核心管理器):
 *   - runCommand:同 command 去重 upsert + 总是切 active + 立即跑 + spawn 前请求激活
 *   - closeCommand/showCommand/updateRefreshPolicy:tab 管理与两维刷新策略
 *   - 'commandPanelUpdated' 事件 emit(结构/状态变化)
 *   - output/exited 事件按 runId 路由回 entry(只处理自己的 runId)
 *   - SSH 拒绝(透传 CodeBlockError('SshUnsupported'))
 *   - onSessionDestroyed/onWindowClosed 清理
 *
 *   不起真 CodeBlockRunner(它 spawn 子进程,AGENTS.md 9.3),用 EventEmitter fake。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  CommandPanelService,
  commandKeyFor,
  type CommandPanelSessionLookup,
  type CommandPanelSnapshotData,
  type CommandScheduler,
} from './command-panel-service';
import { CodeBlockError } from './code-block-runner';
import { BackgroundWorkScheduler } from './background-work-scheduler';

/**
 * Fake CodeBlockRunner:满足 CommandPanelService.attachRunner 用到的
 * on('output'/'exited') + run() + stop()。测试通过 emitOutput/emitExited 驱动。
 */
function makeFakeRunner() {
  const bus = new EventEmitter();
  let runCounter = 0;
  let nextRunGate: Promise<void> | null = null;
  const runs = new Map<string, { sessionId: string; command: string; stopped: boolean }>();
  const runner = {
    on: (event: string, cb: (...a: unknown[]) => void) => bus.on(event, cb),
    run: vi.fn(
      async (input: { sourceSessionId: string; code: string; requestingClientId: string }) => {
        // SSH 模拟:命令含 'ssh:' 视为 SSH session(真实 CodeBlockRunner 按 pathId 判)
        runCounter++;
        const runId = `run-${runCounter}`;
        runs.set(runId, {
          sessionId: input.sourceSessionId,
          command: input.code,
          stopped: false,
        });
        const gate = nextRunGate;
        nextRunGate = null;
        if (gate) await gate;
        return { runId };
      },
    ),
    stop: vi.fn((runId: string) => {
      const r = runs.get(runId);
      if (r) r.stopped = true;
    }),
    removeSession: vi.fn(),
    removeClient: vi.fn(),
    // 测试驱动:模拟 CodeBlockRunner 的 output/exited 事件
    emitOutput: (runId: string, stream: 'stdout' | 'stderr', data: string) =>
      bus.emit('output', { runId, clientId: 'c1', stream, data }),
    emitExited: (runId: string, exitCode: number | null, signal: string | null) =>
      bus.emit('exited', { runId, clientId: 'c1', exitCode, signal }),
    deferNextRun: () => {
      let release!: () => void;
      nextRunGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    _runs: runs,
  };
  return runner;
}

function makeLookup(
  sessions: Record<string, { currentCwd: string; pathId: string; ownerWindowId: string | null }> = {
    s1: { currentCwd: '/tmp', pathId: 'local-1', ownerWindowId: 'w1' },
  },
): CommandPanelSessionLookup {
  return {
    get: (sid) => sessions[sid] ?? null,
  };
}

type FakeTaskDefinition = Parameters<CommandScheduler['registerTask']>[1];

function makeFakeScheduler(): CommandScheduler & {
  tasks: Map<string, FakeTaskDefinition>;
  demands: Map<string, string>;
} {
  const tasks = new Map<string, FakeTaskDefinition>();
  const demands = new Map<string, string>();
  return {
    tasks,
    demands,
    registerTask: vi.fn((key, def) => {
      tasks.set(key, def);
    }),
    unregisterTask: vi.fn((key) => {
      tasks.delete(key);
      demands.delete(key);
    }),
    setDemand: vi.fn((key, _consumerId, level) => {
      demands.set(key, level);
    }),
    clearTaskDemands: vi.fn((key) => {
      demands.delete(key);
    }),
    // fake 不保存 per-consumer map；窗口关闭时清空即可覆盖本测试需要的语义。
    removeConsumer: vi.fn(() => {
      demands.clear();
    }),
  };
}

describe('CommandPanelService', () => {
  let svc: CommandPanelService;
  let runner: ReturnType<typeof makeFakeRunner>;
  let scheduler: ReturnType<typeof makeFakeScheduler>;

  beforeEach(() => {
    svc = new CommandPanelService();
    runner = makeFakeRunner();
    scheduler = makeFakeScheduler();
    svc.attachSessionLookup(makeLookup());
    svc.attachRunner(runner as unknown as Parameters<CommandPanelService['attachRunner']>[0]);
    svc.attachScheduler(scheduler);
  });

  describe('runCwd(ADR-036:命令输出相对路径的解析基准)', () => {
    it('spawn 时记录 session 当前 cwd,getRunCwd 可查', async () => {
      const snap = await svc.runCommand('s1', 'ls');
      runner.emitOutput('r-1', 'stdout', 'out');
      runner.emitExited('r-1', 0, null);
      expect(snap.commands[0]!.runCwd).toBe('/tmp');
      expect(svc.getRunCwd('s1', snap.commands[0]!.key)).toBe('/tmp');
    });

    it('重跑时 runCwd 跟随最新 cwd(终端 cd 后刷新,基准更新)', async () => {
      const snap1 = await svc.runCommand('s1', 'pwd');
      runner.emitOutput('r-1', 'stdout', '/tmp');
      runner.emitExited('r-1', 0, null);
      expect(snap1.commands[0]!.runCwd).toBe('/tmp');

      // 换 lookup 模拟 cd,再 push 同命令(upsert 复用 entry,立即重跑)
      const sessions2 = { s1: { currentCwd: '/other', pathId: 'local-1', ownerWindowId: 'w1' } };
      svc.attachSessionLookup(makeLookup(sessions2));
      await svc.runCommand('s1', 'pwd');
      runner.emitOutput('r-2', 'stdout', '/other');
      runner.emitExited('r-2', 0, null);
      expect(svc.getRunCwd('s1', snap1.commands[0]!.key)).toBe('/other');
    });

    it('未知指令 / 未知 session 返回 null(调用方回退 session 当前 cwd)', () => {
      expect(svc.getRunCwd('s1', 'nope')).toBeNull();
      expect(svc.getRunCwd('ghost', 'x')).toBeNull();
    });
  });

  describe('runCommand', () => {
    it('推送新指令:加入列表 + 切 active + 立即跑 + emit updated', async () => {
      const events: unknown[] = [];
      svc.on('commandPanelUpdated', (e) => events.push(e));

      const snap = await svc.runCommand('s1', 'echo hello', null, 'w1');

      expect(snap.commands).toHaveLength(1);
      expect(snap.commands[0]!.command).toBe('echo hello');
      expect(snap.commands[0]!.refreshPolicy).toEqual({
        scope: 'foreground',
        interval: '30s',
      });
      expect(snap.activeKey).toBe(snap.commands[0]!.key);
      expect(snap.commands[0]!.status).toBe('running');
      expect(runner.run).toHaveBeenCalledWith({
        sourceSessionId: 's1',
        language: 'bash',
        code: 'echo hello',
        requestingClientId: 'w1',
        sudo: false,
      });
      // 激活事件在 spawn 前发出(长命令先跳面板看 running 占位);完成态 emit 是 false。
      expect(events.length).toBeGreaterThanOrEqual(1);
      const firstEvt = events[0] as { requestActivation: boolean };
      expect(firstEvt.requestActivation).toBe(true);
      const lastEvt = events[events.length - 1] as { requestActivation: boolean };
      expect(lastEvt.requestActivation).toBe(false);
    });

    it('同 command 去重 upsert:不新增 tab,复用 key', async () => {
      await svc.runCommand('s1', 'git status', null, 'w1');
      await svc.runCommand('s1', 'git status', null, 'w1');
      const snap = svc.getSnapshot('s1');
      expect(snap.commands).toHaveLength(1);
      expect(runner.run).toHaveBeenCalledTimes(2); // 但跑了两次(重跑)
    });

    it('重推已存在指令:切回该 tab + 请求激活(与 openFile 等价 show 对齐)', async () => {
      const events: unknown[] = [];
      svc.on('commandPanelUpdated', (e) => events.push(e));
      await svc.runCommand('s1', 'git status', null, 'w1');
      await svc.runCommand('s1', 'echo other', null, 'w1'); // active 被新指令抢走
      expect(svc.getSnapshot('s1').activeKey).toBe(commandKeyFor('echo other'));
      events.length = 0;

      await svc.runCommand('s1', 'git status', null, 'w1'); // 重推已存在指令

      const snap = svc.getSnapshot('s1');
      expect(snap.commands).toHaveLength(2); // 不新增 tab
      expect(snap.activeKey).toBe(commandKeyFor('git status')); // 但跳回它的 tab
      const firstEvt = events[0] as { requestActivation: boolean };
      expect(firstEvt.requestActivation).toBe(true);
    });

    it('pending spawn 被并发重跑取代后不得回写或混入输出', async () => {
      const releaseFirst = runner.deferNextRun();
      const firstRun = svc.runCommand('s1', 'echo hello', null, 'w1');
      expect(runner.run).toHaveBeenCalledTimes(1);

      await svc.runCommand('s1', 'echo hello', null, 'w1');
      expect(svc.getSnapshot('s1').commands[0]!.lastRunId).toBe('run-2');

      releaseFirst();
      await firstRun;
      expect(runner.stop).toHaveBeenCalledWith('run-1');

      runner.emitOutput('run-1', 'stdout', 'stale\n');
      runner.emitOutput('run-2', 'stdout', 'latest\n');
      runner.emitExited('run-2', 0, null);
      expect(svc.getSnapshot('s1').commands[0]!.output).toBe('latest\n');
    });

    it('同步启动失败后建立 HOT demand 不得立即重复尝试', async () => {
      svc.setDemand('s1', 'w1', 'hot');
      runner.run.mockRejectedValueOnce(new CodeBlockError('SpawnFailed', 'boom'));
      await svc.runCommand('s1', 'broken', null, 'w1');
      const key = commandKeyFor('broken');
      await scheduler.tasks.get(`command-panel:s1:${key}`)!.run();
      expect(runner.run).toHaveBeenCalledTimes(1);
    });

    it('超过 32 条时 FIFO 淘汰同步停止 run 并注销 scheduler task', async () => {
      for (let i = 0; i < 33; i++) await svc.runCommand('s1', `cmd-${i}`, null, 'w1');
      const snap = svc.getSnapshot('s1');
      const firstKey = commandKeyFor('cmd-0');
      expect(snap.commands).toHaveLength(32);
      expect(snap.commands.some((entry) => entry.key === firstKey)).toBe(false);
      expect(scheduler.tasks.has(`command-panel:s1:${firstKey}`)).toBe(false);
      expect(runner.stop).toHaveBeenCalledWith('run-1');
    });

    it('空 command 抛 CommandEmpty', async () => {
      await expect(svc.runCommand('s1', '   ', null, 'w1')).rejects.toThrow();
    });

    it('session 不存在抛 SessionMissing', async () => {
      await expect(svc.runCommand('nope', 'echo x', null, 'w1')).rejects.toThrow();
    });

    it('SSH 拒绝:透传 CodeBlockError(SshUnsupported)→ 状态 error', async () => {
      runner.run.mockRejectedValueOnce(new CodeBlockError('SshUnsupported', 'ssh not supported'));
      const events: unknown[] = [];
      svc.on('commandPanelUpdated', (e) => events.push(e));
      await svc.runCommand('s1', 'echo ssh', null, 'w1');
      const snap = svc.getSnapshot('s1');
      expect(snap.commands[0]!.status).toBe('error');
      expect(snap.commands[0]!.output).toContain('SshUnsupported');
    });

    it('远程 sudo 缺密码:SudoPasswordRequired → awaiting-sudo-password 态(非 error)', async () => {
      runner.run.mockRejectedValueOnce(
        new CodeBlockError('SudoPasswordRequired', 'SSH profile "prod" 尚未录入 sudo 密码'),
      );
      await svc.runCommand('s1', 'apt update', null, 'w1', true);
      const snap = svc.getSnapshot('s1');
      const entry = snap.commands[0]!;
      expect(entry.status).toBe('awaiting-sudo-password');
      expect(entry.sudo).toBe(true);
      // 输出含密码提示,且不当作普通失败(无 ⚠ 执行失败 前缀)
      expect(entry.output).toContain('sudo 密码');
      expect(entry.output).not.toContain('执行失败');
      // runner 收到 sudo:true
      expect(runner.run).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'apt update', sudo: true }),
      );
    });
  });

  describe('output/exited 事件路由', () => {
    it('output 累积进 entry.output;exited 翻状态机(exit 0 → exited)', async () => {
      const snap1 = await svc.runCommand('s1', 'echo hello', null, 'w1');
      const runId = snap1.commands[0]!.lastRunId!;
      runner.emitOutput(runId, 'stdout', 'hello\n');
      runner.emitExited(runId, 0, null);
      const snap2 = svc.getSnapshot('s1');
      expect(snap2.commands[0]!.output).toBe('hello\n');
      expect(snap2.commands[0]!.status).toBe('exited');
      expect(snap2.commands[0]!.lastExitCode).toBe(0);
      expect(snap2.commands[0]!.lastRunId).toBeNull(); // exited 后清 runId
      expect(svc.isCommandPanelRun(runId)).toBe(true); // 同事件链后续 IPC listener 仍能识别
      expect(svc.isCommandPanelRun('markdown-run')).toBe(false);
    });

    it('重跑期间保留已完成结果，退出后再原子替换', async () => {
      const first = await svc.runCommand('s1', 'echo hello', null, 'w1');
      const firstRunId = first.commands[0]!.lastRunId!;
      runner.emitOutput(firstRunId, 'stdout', 'old result\n');
      runner.emitExited(firstRunId, 0, null);

      const second = await svc.runCommand('s1', 'echo hello', null, 'w1');
      const secondRunId = second.commands[0]!.lastRunId!;
      expect(svc.getSnapshot('s1').commands[0]).toMatchObject({
        status: 'running',
        output: 'old result\n',
        lastExitCode: 0,
      });

      runner.emitOutput(secondRunId, 'stdout', 'new result\n');
      // 当前轮 stdout/stderr 只进 pending buffer；完成前不得让旧 Markdown 闪空或半更新。
      expect(svc.getSnapshot('s1').commands[0]!.output).toBe('old result\n');

      runner.emitExited(secondRunId, 0, null);
      expect(svc.getSnapshot('s1').commands[0]).toMatchObject({
        status: 'exited',
        output: 'new result\n',
      });
    });

    it('重跑成功但没有输出时，完成后用空结果替换旧内容', async () => {
      const first = await svc.runCommand('s1', 'echo hello', null, 'w1');
      const firstRunId = first.commands[0]!.lastRunId!;
      runner.emitOutput(firstRunId, 'stdout', 'old result\n');
      runner.emitExited(firstRunId, 0, null);

      const second = await svc.runCommand('s1', 'echo hello', null, 'w1');
      const secondRunId = second.commands[0]!.lastRunId!;
      expect(svc.getSnapshot('s1').commands[0]).toMatchObject({
        status: 'running',
        output: 'old result\n',
        lastExitCode: 0,
      });
      runner.emitExited(secondRunId, 0, null);

      expect(svc.getSnapshot('s1').commands[0]).toMatchObject({
        status: 'exited',
        output: '',
        lastExitCode: 0,
      });

      const third = await svc.runCommand('s1', 'echo hello', null, 'w1');
      // output 为空仍可能代表“上一轮已完成且无输出”，不能退化成首次运行占位。
      expect(svc.getSnapshot('s1').commands[0]).toMatchObject({
        status: 'running',
        output: '',
        lastExitCode: 0,
      });
      runner.emitExited(third.commands[0]!.lastRunId!, 0, null);
    });

    it('重跑被窗口关闭取消时丢弃 pending 输出并保留旧结果', async () => {
      const first = await svc.runCommand('s1', 'echo hello', null, 'w1');
      const firstRunId = first.commands[0]!.lastRunId!;
      runner.emitOutput(firstRunId, 'stdout', 'old result\n');
      runner.emitExited(firstRunId, 0, null);

      const second = await svc.runCommand('s1', 'echo hello', null, 'w1');
      const secondRunId = second.commands[0]!.lastRunId!;
      runner.emitOutput(secondRunId, 'stdout', 'partial replacement\n');
      svc.onWindowClosed('w1');
      // 模拟 stop 后仍迟到的 exited；generation/route 清理必须挡住它。
      runner.emitExited(secondRunId, 1, 'SIGTERM');

      expect(svc.getSnapshot('s1').commands[0]).toMatchObject({
        status: 'idle',
        output: 'old result\n',
      });
    });

    it('非零退出码 → 状态 error', async () => {
      const snap1 = await svc.runCommand('s1', 'false', null, 'w1');
      const runId = snap1.commands[0]!.lastRunId!;
      runner.emitExited(runId, 1, null);
      expect(svc.getSnapshot('s1').commands[0]!.status).toBe('error');
    });

    it('只处理自己的 runId(忽略不认识的 runId)', async () => {
      await svc.runCommand('s1', 'echo a', null, 'w1');
      // 模拟别的 run(markdown 代码块)的 output,不应影响命令面板
      runner.emitOutput('unknown-run', 'stdout', 'noise');
      const snap = svc.getSnapshot('s1');
      expect(snap.commands[0]!.output).toBe(''); // 未被污染
    });
  });

  describe('closeCommand / showCommand / setStrategy', () => {
    it('closeCommand:移除 tab + 切 active 到剩余第一个', async () => {
      await svc.runCommand('s1', 'cmd-a', null, 'w1');
      await svc.runCommand('s1', 'cmd-b', null, 'w1');
      const keyA = commandKeyFor('cmd-a');
      const snap = svc.closeCommand('s1', keyA);
      expect(snap.commands).toHaveLength(1);
      expect(snap.commands[0]!.command).toBe('cmd-b');
      expect(snap.activeKey).toBe(snap.commands[0]!.key);
    });

    it('showCommand:切 active 不改列表', async () => {
      await svc.runCommand('s1', 'cmd-a', null, 'w1');
      await svc.runCommand('s1', 'cmd-b', null, 'w1');
      const keyA = commandKeyFor('cmd-a');
      const snap = svc.showCommand('s1', keyA);
      expect(snap.activeKey).toBe(keyA);
      expect(snap.commands).toHaveLength(2);
    });

    it('前后台范围与刷新间隔 patch 可独立修改', async () => {
      await svc.runCommand('s1', 'cmd-a', null, 'w1');
      const key = commandKeyFor('cmd-a');

      let snap = svc.updateRefreshPolicy('s1', key, { scope: 'background' });
      expect(snap.commands[0]!.refreshPolicy).toEqual({
        scope: 'background',
        interval: '30s',
      });
      expect(scheduler.tasks.get(`command-panel:s1:${key}`)).toMatchObject({
        hotIntervalMs: 30_000,
        warmIntervalMs: 30_000,
      });

      snap = svc.updateRefreshPolicy('s1', key, { interval: '5s' });
      expect(snap.commands[0]!.refreshPolicy).toEqual({
        scope: 'background',
        interval: '5s',
      });
      expect(scheduler.tasks.get(`command-panel:s1:${key}`)).toMatchObject({
        hotIntervalMs: 5_000,
        warmIntervalMs: 5_000,
      });

      svc.updateRefreshPolicy('s1', key, { interval: 'manual' });
      expect(scheduler.tasks.has(`command-panel:s1:${key}`)).toBe(false);
    });

    it('真实 scheduler 建立首次 HOT 时不重复 run，到 interval 后才刷新', async () => {
      vi.useFakeTimers();
      const realScheduler = new BackgroundWorkScheduler({ maxConcurrent: 1 });
      const realSvc = new CommandPanelService();
      const realRunner = makeFakeRunner();
      try {
        realSvc.attachSessionLookup(makeLookup());
        realSvc.attachRunner(
          realRunner as unknown as Parameters<CommandPanelService['attachRunner']>[0],
        );
        realSvc.attachScheduler(realScheduler);
        const initial = await realSvc.runCommand('s1', 'cmd-a', null, 'w1');
        realRunner.emitExited(initial.commands[0]!.lastRunId!, 0, null);

        realSvc.setDemand('s1', 'w1', 'hot');
        await vi.advanceTimersByTimeAsync(0);
        expect(realRunner.run).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(30_000);
        expect(realRunner.run).toHaveBeenCalledTimes(2);
      } finally {
        realScheduler.shutdown();
        vi.useRealTimers();
      }
    });

    it('WARM 等待接近 interval 时切 HOT 会立即刷新，不重置整段 interval', async () => {
      vi.useFakeTimers();
      const realScheduler = new BackgroundWorkScheduler({ maxConcurrent: 1 });
      const realSvc = new CommandPanelService();
      const realRunner = makeFakeRunner();
      try {
        realSvc.attachSessionLookup(makeLookup());
        realSvc.attachRunner(
          realRunner as unknown as Parameters<CommandPanelService['attachRunner']>[0],
        );
        realSvc.attachScheduler(realScheduler);
        const initial = await realSvc.runCommand('s1', 'cmd-a', null, 'w1');
        realRunner.emitExited(initial.commands[0]!.lastRunId!, 0, null);
        realSvc.updateRefreshPolicy('s1', commandKeyFor('cmd-a'), { scope: 'background' });

        await vi.advanceTimersByTimeAsync(29_000);
        realSvc.setDemand('s1', 'w1', 'hot');
        await vi.advanceTimersByTimeAsync(0);
        expect(realRunner.run).toHaveBeenCalledTimes(2);
      } finally {
        realScheduler.shutdown();
        vi.useRealTimers();
      }
    });

    it('foreground 只刷新当前可见 tab，background 在隐藏时保持 WARM', async () => {
      await svc.runCommand('s1', 'cmd-a', null, 'w1');
      await svc.runCommand('s1', 'cmd-b', null, 'w1');
      const keyA = commandKeyFor('cmd-a');
      const keyB = commandKeyFor('cmd-b');
      svc.updateRefreshPolicy('s1', keyB, { scope: 'background' });

      svc.showCommand('s1', keyA);
      svc.setDemand('s1', 'w1', 'hot');
      expect(scheduler.demands.get(`command-panel:s1:${keyA}`)).toBe('hot');
      expect(scheduler.demands.get(`command-panel:s1:${keyB}`)).toBe('warm');

      svc.showCommand('s1', keyB);
      expect(scheduler.demands.get(`command-panel:s1:${keyA}`)).toBe('none');
      expect(scheduler.demands.get(`command-panel:s1:${keyB}`)).toBe('hot');

      svc.setDemand('s1', 'w1', 'none');
      expect(scheduler.demands.get(`command-panel:s1:${keyA}`)).toBe('none');
      expect(scheduler.demands.get(`command-panel:s1:${keyB}`)).toBe('warm');
    });
  });

  describe('onSessionDestroyed / owner / client lifecycle', () => {
    it('onSessionDestroyed:清空该 session 状态', async () => {
      await svc.runCommand('s1', 'cmd-a', null, 'w1');
      svc.onSessionDestroyed('s1');
      expect(svc.getSnapshot('s1').commands).toHaveLength(0);
    });

    it('旧 owner 的 cleanup 不得覆盖新 owner 的 HOT demand', async () => {
      const sessions = {
        s1: { currentCwd: '/tmp', pathId: 'local-1', ownerWindowId: 'w1' as string | null },
      };
      const localSvc = new CommandPanelService();
      const localScheduler = makeFakeScheduler();
      localSvc.attachSessionLookup(makeLookup(sessions));
      localSvc.attachRunner(
        runner as unknown as Parameters<CommandPanelService['attachRunner']>[0],
      );
      localSvc.attachScheduler(localScheduler);
      await localSvc.runCommand('s1', 'cmd-a', null, 'w1');
      const taskKey = `command-panel:s1:${commandKeyFor('cmd-a')}`;
      localSvc.setDemand('s1', 'w1', 'hot');

      sessions.s1.ownerWindowId = 'w2';
      localSvc.onSessionOwnerChanged('s1');
      localSvc.setDemand('s1', 'w2', 'hot');
      localSvc.setDemand('s1', 'w1', 'none');

      expect(localScheduler.demands.get(taskKey)).toBe('hot');
    });

    it('run 由 A 发起、owner 转给 B 后关闭 A，B 看到 idle 且迟到 exited 不翻 error', async () => {
      const sessions = {
        s1: { currentCwd: '/tmp', pathId: 'local-1', ownerWindowId: 'w1' as string | null },
      };
      const localSvc = new CommandPanelService();
      const localRunner = makeFakeRunner();
      localSvc.attachSessionLookup(makeLookup(sessions));
      localSvc.attachRunner(
        localRunner as unknown as Parameters<CommandPanelService['attachRunner']>[0],
      );
      localSvc.attachScheduler(makeFakeScheduler());
      const running = await localSvc.runCommand('s1', 'cmd-a', null, 'w1');
      const runId = running.commands[0]!.lastRunId!;

      sessions.s1.ownerWindowId = 'w2';
      localSvc.onSessionOwnerChanged('s1');
      localSvc.onWindowClosed('w1');
      expect(localSvc.getSnapshot('s1').commands[0]!.status).toBe('idle');
      expect(localRunner.stop).toHaveBeenCalledWith(runId);

      localRunner.emitExited(runId, 1, null);
      expect(localSvc.getSnapshot('s1').commands[0]!.status).toBe('idle');
    });

    it('窗口/client 消失会从 scheduler 移除 consumer', async () => {
      await svc.runCommand('s1', 'cmd-a', null, 'w1');
      svc.setDemand('s1', 'w1', 'hot');
      svc.removeDemandConsumer('w1');
      expect(scheduler.removeConsumer).toHaveBeenCalledWith('w1');
    });
  });

  describe('restoreSnapshot / exportSnapshot', () => {
    it('export 后 restore 能恢复列表(但重置 runId/status)', async () => {
      await svc.runCommand('s1', 'cmd-a', null, 'w1');
      const data = svc.exportSnapshot('s1')!;
      expect(data.commands).toHaveLength(1);

      svc.onSessionDestroyed('s1');
      expect(svc.getSnapshot('s1').commands).toHaveLength(0);

      svc.restoreSnapshot('s1', data);
      const snap = svc.getSnapshot('s1');
      expect(snap.commands).toHaveLength(1);
      expect(snap.commands[0]!.command).toBe('cmd-a');
      expect(snap.commands[0]!.status).toBe('idle'); // 恢复后重置
      expect(snap.commands[0]!.lastRunId).toBeNull();
    });

    it('旧快照的混合 strategy 会迁移成独立 refreshPolicy', () => {
      const key = commandKeyFor('cmd-a');
      const legacy = {
        version: 1,
        commands: [
          {
            key,
            command: 'cmd-a',
            title: 'cmd-a',
            strategy: 'background-5s',
            lastRunId: null,
            lastExitCode: 0,
            status: 'exited',
            output: 'old',
            lastRunAt: 1,
          },
        ],
        activeKey: key,
      } as unknown as CommandPanelSnapshotData;

      svc.restoreSnapshot('s1', legacy);
      expect(svc.getSnapshot('s1').commands[0]!.refreshPolicy).toEqual({
        scope: 'background',
        interval: '5s',
      });
    });

    it('restoreSnapshot(null) 清空', async () => {
      await svc.runCommand('s1', 'cmd-a', null, 'w1');
      svc.restoreSnapshot('s1', null);
      expect(svc.getSnapshot('s1').commands).toHaveLength(0);
    });
  });

  describe('onWorkspaceSwitched(ADR-039:pi resume 切回 workspace 恢复命令页)', () => {
    /** 造一份「磁盘快照」形态(与 manager.sanitizeSnapshot 输出同构)。 */
    const makeDiskSnapshot = (commands: unknown[], activeKey: string | null) => ({
      openedFiles: [],
      activeFilePath: null,
      scroll: {},
      runs: [],
      commandPanel: { version: 2, commands, activeKey },
    });

    it('快照含 commandPanel → 恢复条目(output 保留/status idle)+ emit 一次', async () => {
      const key = commandKeyFor('git status');
      const commands = [
        {
          key,
          command: 'git status',
          title: 'status',
          refreshPolicy: { scope: 'background', interval: '5s' },
          lastRunId: 'stale-run',
          lastExitCode: 0,
          status: 'exited',
          output: '# 历史输出',
          lastRunAt: 1,
        },
      ];
      const events: Array<{ requestActivation: boolean; commands: number }> = [];
      svc.on('commandPanelUpdated', (e) =>
        events.push({ requestActivation: e.requestActivation, commands: e.snapshot.commands.length }),
      );
      svc.attachWorkspaceOps({
        readSnapshotForSession: async () =>
          makeDiskSnapshot(commands, key) as Awaited<
            ReturnType<Parameters<CommandPanelService['attachWorkspaceOps']>[0]['readSnapshotForSession']>
          >,
      });

      await svc.onWorkspaceSwitched('s1');

      const snap = svc.getSnapshot('s1');
      expect(snap.commands).toHaveLength(1);
      expect(snap.commands[0]!.output).toBe('# 历史输出'); // 离开时的页面原样还回
      expect(snap.commands[0]!.status).toBe('idle'); // runId 已失效,重置
      expect(snap.commands[0]!.lastRunId).toBeNull();
      expect(snap.activeKey).toBe(key);
      expect(events).toEqual([{ requestActivation: false, commands: 1 }]);
      // background 策略恢复 scheduler task(resume 后轮询继续)。
      expect(scheduler.tasks.has(`command-panel:s1:${key}`)).toBe(true);
    });

    it('快照无 commandPanel(旧格式/新空 workspace)→ 清空现有命令并广播空态', async () => {
      await svc.runCommand('s1', 'cmd-a', null, 'w1');
      expect(svc.getSnapshot('s1').commands).toHaveLength(1);
      svc.attachWorkspaceOps({
        readSnapshotForSession: async () =>
          ({ openedFiles: [], activeFilePath: null, scroll: {}, runs: [] }) as never,
      });

      const events: number[] = [];
      svc.on('commandPanelUpdated', (e) => events.push(e.snapshot.commands.length));
      await svc.onWorkspaceSwitched('s1');

      expect(svc.getSnapshot('s1').commands).toHaveLength(0);
      expect(events).toEqual([0]); // 空态也要广播(renderer 才会清掉旧对话的 tab)
    });

    it('读快照抛错 → 降级清空,不抛(与文件侧降级语义一致)', async () => {
      await svc.runCommand('s1', 'cmd-a', null, 'w1');
      svc.attachWorkspaceOps({
        readSnapshotForSession: async () => {
          throw new Error('disk io boom');
        },
      });
      await expect(svc.onWorkspaceSwitched('s1')).resolves.toBeUndefined();
      expect(svc.getSnapshot('s1').commands).toHaveLength(0);
    });

    it('未注入 workspaceOps → 清空(no-op 读,不抛)', async () => {
      await svc.runCommand('s1', 'cmd-a', null, 'w1');
      await expect(svc.onWorkspaceSwitched('s1')).resolves.toBeUndefined();
      expect(svc.getSnapshot('s1').commands).toHaveLength(0);
    });
  });

  describe('commandKeyFor', () => {
    it('同 command 同 key(稳定)', () => {
      expect(commandKeyFor('echo hello')).toBe(commandKeyFor('echo hello'));
    });
    it('不同 command 不同 key', () => {
      expect(commandKeyFor('a')).not.toBe(commandKeyFor('b'));
    });
  });
});
