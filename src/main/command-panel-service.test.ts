/**
 * @file command-panel-service.test.ts
 * @purpose 守护 CommandPanelService 的核心契约(AGENTS.md §5 状态机 + 核心管理器):
 *   - runCommand:同 command 去重 upsert + 新指令切 active + 立即跑
 *   - closeCommand/showCommand/setStrategy:tab 管理与策略
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
  type CommandScheduler,
} from './command-panel-service';
import { CodeBlockError } from './code-block-runner';

/**
 * Fake CodeBlockRunner:满足 CommandPanelService.attachRunner 用到的
 * on('output'/'exited') + run() + stop()。测试通过 emitOutput/emitExited 驱动。
 */
function makeFakeRunner() {
  const bus = new EventEmitter();
  let runCounter = 0;
  const runs = new Map<string, { sessionId: string; command: string; stopped: boolean }>();
  const runner = {
    on: (event: string, cb: (...a: unknown[]) => void) => bus.on(event, cb),
    run: vi.fn(async (input: { sourceSessionId: string; code: string; requestingClientId: string }) => {
      // SSH 模拟:命令含 'ssh:' 视为 SSH session(真实 CodeBlockRunner 按 pathId 判)
      runCounter++;
      const runId = `run-${runCounter}`;
      runs.set(runId, {
        sessionId: input.sourceSessionId,
        command: input.code,
        stopped: false,
      });
      return { runId };
    }),
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

function makeFakeScheduler(): CommandScheduler & { tasks: Map<string, unknown>; demands: Map<string, string> } {
  const tasks = new Map<string, unknown>();
  const demands = new Map<string, string>();
  return {
    tasks,
    demands,
    registerTask: vi.fn((key, def) => {
      tasks.set(key, def);
    }),
    unregisterTask: vi.fn((key) => {
      tasks.delete(key);
    }),
    setDemand: vi.fn((key, consumerId, level) => {
      demands.set(key, level);
    }),
    clearTaskDemands: vi.fn((key) => {
      // clear all demands for this task key (simplified)
      demands.delete(key);
    }),
  };
}

describe('CommandPanelService', () => {
  let svc: CommandPanelService;
  let runner: ReturnType<typeof makeFakeRunner>;

  beforeEach(() => {
    svc = new CommandPanelService();
    runner = makeFakeRunner();
    svc.attachSessionLookup(makeLookup());
    svc.attachRunner(runner as unknown as Parameters<CommandPanelService['attachRunner']>[0]);
    svc.attachScheduler(makeFakeScheduler());
  });

  describe('runCommand', () => {
    it('推送新指令:加入列表 + 切 active + 立即跑 + emit updated', async () => {
      const events: unknown[] = [];
      svc.on('commandPanelUpdated', (e) => events.push(e));

      const snap = await svc.runCommand('s1', 'echo hello', null, 'w1');

      expect(snap.commands).toHaveLength(1);
      expect(snap.commands[0]!.command).toBe('echo hello');
      expect(snap.activeKey).toBe(snap.commands[0]!.key);
      expect(snap.commands[0]!.status).toBe('running');
      expect(runner.run).toHaveBeenCalledWith({
        sourceSessionId: 's1',
        language: 'bash',
        code: 'echo hello',
        requestingClientId: 'w1',
      });
      // 新指令应请求激活(requestActivation)
      expect(events.length).toBeGreaterThanOrEqual(1);
      const lastEvt = events[events.length - 1] as { requestActivation: boolean };
      expect(lastEvt.requestActivation).toBe(true);
    });

    it('同 command 去重 upsert:不新增 tab,复用 key', async () => {
      await svc.runCommand('s1', 'git status', null, 'w1');
      await svc.runCommand('s1', 'git status', null, 'w1');
      const snap = svc.getSnapshot('s1');
      expect(snap.commands).toHaveLength(1);
      expect(runner.run).toHaveBeenCalledTimes(2); // 但跑了两次(重跑)
    });

    it('空 command 抛 CommandEmpty', async () => {
      await expect(svc.runCommand('s1', '   ', null, 'w1')).rejects.toThrow();
    });

    it('session 不存在抛 SessionMissing', async () => {
      await expect(svc.runCommand('nope', 'echo x', null, 'w1')).rejects.toThrow();
    });

    it('SSH 拒绝:透传 CodeBlockError(SshUnsupported)→ 状态 error', async () => {
      runner.run.mockRejectedValueOnce(
        new CodeBlockError('SshUnsupported', 'ssh not supported'),
      );
      const events: unknown[] = [];
      svc.on('commandPanelUpdated', (e) => events.push(e));
      await svc.runCommand('s1', 'echo ssh', null, 'w1');
      const snap = svc.getSnapshot('s1');
      expect(snap.commands[0]!.status).toBe('error');
      expect(snap.commands[0]!.output).toContain('SshUnsupported');
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

    it('setStrategy:改策略', async () => {
      await svc.runCommand('s1', 'cmd-a', null, 'w1');
      const key = commandKeyFor('cmd-a');
      const snap = svc.setStrategy('s1', key, 'background-30s');
      expect(snap.commands[0]!.strategy).toBe('background-30s');
    });
  });

  describe('onSessionDestroyed / onWindowClosed', () => {
    it('onSessionDestroyed:清空该 session 状态', async () => {
      await svc.runCommand('s1', 'cmd-a', null, 'w1');
      svc.onSessionDestroyed('s1');
      expect(svc.getSnapshot('s1').commands).toHaveLength(0);
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

    it('restoreSnapshot(null) 清空', async () => {
      await svc.runCommand('s1', 'cmd-a', null, 'w1');
      svc.restoreSnapshot('s1', null);
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
