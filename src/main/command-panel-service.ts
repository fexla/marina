/**
 * @file src/main/command-panel-service.ts
 * @purpose 命令面板(v0.3.3 Feature G / ADR-027)—— 第 4 个 dock 面板的后端。
 *
 * @关键设计:
 * - trigger=program-push(与 FilePanelService 同构)。AI 经 `marina run "<cmd>"` /
 *   HTTP POST /run / IPC cmd:command-panel:run 推送**任意命令字符串**。
 * - 执行复用 CodeBlockRunner.run(language='bash', cwd=session.currentCwd)——不经 PTY、
 *   SSH 自动拒绝、shell 路径解析、UTF-8/GBK 解码、生命周期清理全在 CodeBlockRunner。
 * - 多 tab:每 session 一份 {commands[], activeKey}。同 command 字符串去重 upsert
 *   (按 command 派生 key),避免重复 tab。
 * - per-指令 刷新策略(D4):foreground(默认,仅前台跑)/ background-30s / background-5s
 *   (后台轮询走 BackgroundWorkScheduler)/ manual / off。
 * - output 实时流复用 CodeBlockRunner 的 'output' 事件 → ipc 转 evt:system:code-block-output
 *   (runId 空间一致,renderer 按 runId 订阅)。本服务只在 exited 时把最终输出拼进 entry.output
 *   + 翻状态机,emit 'commandPanelUpdated'(结构/状态变化,不逐 chunk 广播整个 snapshot)。
 * - 持久化(D6,套用 ADR-024):command-panel.json,本服务只持内存态,读写委托
 *   workspaceOps(与 FilePanelService 同款注入)。持久化触发由 renderer/上层驱动。
 *
 * @对应文档: ADR-027(docs/方案-命令面板-20260802.md)、ADR-023(CodeBlockRunner)、
 *            ADR-021(后台调度)、ADR-024(workspace 持久化)、附录 I(后台任务规范)。
 *
 * @不要在这里做的事:
 * - 不经 PTY / 不写终端字节流(那是 SessionManager 的职责)。
 * - 不自己 spawn 子进程(委托 CodeBlockRunner,统一执行 + 清理)。
 * - 不把命令正文 / stdout 写进日志或性能报告(隐私:附录 H 红线)。
 * - 不内建 GitHub/map 耦合(map/ticket 只是命令面板的第一个用例,见 ADR-027 哲学边界)。
 */

import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import type {
  CommandEntry,
  CommandExitedPayload,
  CommandPanelSnapshot,
  CommandRefreshStrategy,
  CommandRunStatus,
} from '@shared/protocol';
import type { CodeBlockError, CodeBlockRunner } from './code-block-runner';
import type { SessionInfo } from '@shared/types';
import { logger } from './logger';

const MODULE = 'CommandPanelService';

/** 单条命令输出的字节上限(防失控累积,超出尾部裁切保留最新)。 */
const OUTPUT_MAX_BYTES = 2 * 1024 * 1024;
/** 每 session 指令条数硬上限(溢出 FIFO 丢最旧,防失控累积)。 */
const MAX_COMMANDS_PER_SESSION = 32;

/** 后台轮询策略 → 间隔(ms)。foreground/manual/off 不在此表(不注册后台 task)。 */
const BACKGROUND_INTERVAL_MS: Readonly<Record<string, number>> = {
  'background-30s': 30_000,
  'background-5s': 5_000,
};

/** foreground 策略在用户可见时也算 HOT(立即跑一次);后台策略按各自间隔。 */
function strategyToHotInterval(strategy: CommandRefreshStrategy): number | null {
  if (strategy === 'foreground') return 0; // HOT 立即跑
  if (strategy in BACKGROUND_INTERVAL_MS) {
    return BACKGROUND_INTERVAL_MS[strategy as keyof typeof BACKGROUND_INTERVAL_MS]!;
  }
  return null; // manual / off → 不自动跑
}

/** 由 command 字符串派生稳定 key(同 command 去重 upsert)。sha1 截断,非安全用途。 */
export function commandKeyFor(command: string): string {
  return createHash('sha1').update(command, 'utf8').digest('hex').slice(0, 16);
}

/** 由 command 截断生成默认展示标题。 */
function defaultTitleFor(command: string): string {
  const trimmed = command.trim();
  const firstLine = trimmed.split('\n')[0] ?? trimmed;
  return firstLine.length > 40 ? firstLine.slice(0, 37) + '…' : firstLine;
}

/** 终端 session 查询接口(破除与 SessionManager 的循环依赖,与 FilePanelService 同款)。 */
export interface CommandPanelSessionLookup {
  get(sessionId: string): { currentCwd: string; pathId: string; ownerWindowId: string | null } | null;
}

/** 后台调度器抽象(只用到命令面板需要的子集,便于测试 mock)。 */
export interface CommandScheduler {
  registerTask(
    key: string,
    definition: {
      run: () => Promise<void>;
      hotIntervalMs: number;
      warmIntervalMs: number;
      onError?: (e: unknown) => void;
    },
  ): void;
  unregisterTask(key: string): void;
  setDemand(key: string, consumerId: string, level: 'none' | 'warm' | 'hot'): void;
  clearTaskDemands(key: string): void;
}

/** 持久化委托(workspaceOps 子集;未注入则纯内存,持久化由上层在适当时机驱动)。 */
export interface CommandPanelWorkspaceOps {
  /** 读 command-panel 快照(bind 恢复 / 首次拉取用)。 */
  readCommandSnapshot(workspaceId: string): Promise<CommandPanelSnapshotData | null>;
  /** 写 command-panel 快照(debounce 由上层管)。 */
  writeCommandSnapshot(workspaceId: string, data: CommandPanelSnapshotData): Promise<void>;
}

/** command-panel.json 的磁盘 schema(仿 file-panel.json,见 ADR-024 §4)。 */
export interface CommandPanelSnapshotData {
  version: 1;
  commands: CommandEntry[];
  activeKey: string | null;
}

interface CommandPanelState {
  commands: CommandEntry[];
  activeKey: string | null;
}

/** 'commandPanelUpdated' 事件载荷。requestActivation 仅推送新指令时 true(让 renderer 自动切到该 tab)。 */
export interface CommandPanelUpdateEvent {
  sessionId: string;
  snapshot: CommandPanelSnapshot;
  /** 是否请求 renderer 把 active 切到本次涉及的 commandKey(推送新指令时 true)。 */
  requestActivation: boolean;
  /** 本次涉及的 commandKey(供 renderer 精确更新,无则 null)。 */
  commandKey: string | null;
}

/** runId → {sessionId, key} 反查,用于把 CodeBlockRunner 的事件路由回 entry。 */
interface RunRoute {
  sessionId: string;
  key: string;
}

/**
 * 命令面板后端服务。单例(与 FilePanelService 同生命周期,index.ts 组装)。
 *
 * 状态机(CommandRunStatus):
 *   idle --run--> running --exit 0--> exited
 *                       --exit !=0 / spawn 失败--> error
 *   exited/error --重跑--> running
 * foreground 策略的指令切走面板时 main 不主动停跑(让进行中的跑完),只是下次不自动跑。
 */
export class CommandPanelService extends EventEmitter {
  private readonly panels = new Map<string, CommandPanelState>();
  /** runId → 路由(谁发起的、哪条指令)。run 结束(close)后清理。 */
  private readonly runRoutes = new Map<string, RunRoute>();
  private lookup: CommandPanelSessionLookup | null = null;
  private runner: CodeBlockRunner | null = null;
  private scheduler: CommandScheduler | null = null;
  private workspaceOps: CommandPanelWorkspaceOps | null = null;

  /** 注入 session 查询(破循环依赖)。index.ts 组装后调。 */
  attachSessionLookup(lookup: CommandPanelSessionLookup): void {
    this.lookup = lookup;
  }

  /** 注入执行内核(CodeBlockRunner)。output/exited 事件在此订阅一次。 */
  attachRunner(runner: CodeBlockRunner): void {
    if (this.runner === runner) return;
    this.runner = runner;
    // 订阅 output/exited:只处理属于命令面板的 runId(在 runRoutes 里)。
    // 其余 runId(markdown 代码块的)被忽略,不干扰 code-block-run-cache。
    runner.on('output', (e: { runId: string; stream: 'stdout' | 'stderr'; data: string }) => {
      const route = this.runRoutes.get(e.runId);
      if (!route) return; // 不是命令面板的 run
      this.handleOutput(route, e.stream, e.data);
    });
    runner.on(
      'exited',
      (e: { runId: string; exitCode: number | null; signal: string | null }) => {
        const route = this.runRoutes.get(e.runId);
        if (!route) return;
        this.handleExited(e.runId, route, e.exitCode, e.signal);
      },
    );
  }

  /** 注入后台调度器(BackgroundWorkScheduler)。未注入则后台轮询策略降级为不自动跑。 */
  attachScheduler(scheduler: CommandScheduler): void {
    this.scheduler = scheduler;
  }

  /** 注入持久化委托(workspaceOps 子集,ADR-024)。 */
  attachWorkspaceOps(ops: CommandPanelWorkspaceOps): void {
    this.workspaceOps = ops;
  }

  // ──────────────────────────────────────────────────────────────────
  // 状态读取
  // ──────────────────────────────────────────────────────────────────

  /** 返回某 session 的命令面板快照(无则空快照)。 */
  getSnapshot(sessionId: string): CommandPanelSnapshot {
    const state = this.panels.get(sessionId);
    if (!state) return { commands: [], activeKey: null };
    return { commands: state.commands.map((c) => ({ ...c })), activeKey: state.activeKey };
  }

  // ──────────────────────────────────────────────────────────────────
  // 核心操作
  // ──────────────────────────────────────────────────────────────────

  /**
   * 推送/重跑一条指令。同 command 字符串去重 upsert(复用 key),避免重复 tab。
   * upsert 后立即跑一次(无论策略;策略只影响后续自动重跑)。
   *
   * @throws 'SessionMissing' session 不存在
   * @throws 'CommandEmpty' command 为空
   * @throws CodeBlockError('SshUnsupported'|'ShellMissing'|'SpawnFailed'|'CodeTooLarge')
   *   透传自 CodeBlockRunner(SSH/cwd/shell 失败)。
   */
  async runCommand(
    sessionId: string,
    command: string,
    title: string | null = null,
    requestingClientId: string | null = null,
  ): Promise<CommandPanelSnapshot> {
    const cmd = command.trim();
    if (!cmd) throw new CommandPanelError('CommandEmpty', 'command 不能为空');

    const session = this.lookup?.get(sessionId);
    if (!session) {
      throw new CommandPanelError(
        'SessionMissing',
        `session 不存在: ${sessionId}。可能已销毁或未注入 lookup。`,
      );
    }

    const key = commandKeyFor(cmd);
    const state = this.ensureState(sessionId);
    const existingIdx = state.commands.findIndex((c) => c.key === key);
    const isNew = existingIdx < 0;

    // upsert entry
    const entry: CommandEntry =
      existingIdx >= 0
        ? { ...state.commands[existingIdx]!, command: cmd, title: title ?? state.commands[existingIdx]!.title }
        : {
            key,
            command: cmd,
            title: title ?? defaultTitleFor(cmd),
            strategy: 'foreground',
            lastRunId: null,
            lastExitCode: null,
            status: 'idle',
            output: '',
            lastRunAt: null,
          };
    if (existingIdx >= 0) state.commands[existingIdx] = entry;
    else {
      state.commands.push(entry);
      // 溢出 FIFO 丢最旧
      while (state.commands.length > MAX_COMMANDS_PER_SESSION) state.commands.shift();
    }
    // 推新指令时自动切 active 到它
    if (isNew) state.activeKey = key;

    logger.info(
      MODULE,
      `runCommand: sid=${sessionId} key=${key} new=${isNew} status=${entry.status}`,
    );

    // 同步注册/刷新后台 task(策略非 foreground/manual/off 时)
    this.syncSchedulerTask(sessionId, entry, session.ownerWindowId ?? sessionId);

    // 立即跑一次(无论策略 —— 推送即跑,策略只管后续自动重跑)
    await this.spawnRun(sessionId, entry, session, requestingClientId);

    return this.getSnapshot(sessionId);
  }

  /** 关闭某条指令 tab。停其进行中的 run + 注销后台 task。 */
  closeCommand(sessionId: string, commandKey: string): CommandPanelSnapshot {
    const state = this.panels.get(sessionId);
    if (!state) return this.getSnapshot(sessionId);
    const idx = state.commands.findIndex((c) => c.key === commandKey);
    if (idx < 0) return this.getSnapshot(sessionId);

    const removed = state.commands[idx]!;
    // 停进行中的 run
    if (removed.lastRunId) {
      const route = this.runRoutes.get(removed.lastRunId);
      if (route) {
        this.runner?.stop(removed.lastRunId);
        this.runRoutes.delete(removed.lastRunId);
      }
    }
    // 注销后台 task
    this.unregisterSchedulerTask(sessionId, commandKey);

    state.commands.splice(idx, 1);
    if (state.activeKey === commandKey) {
      state.activeKey = state.commands[0]?.key ?? null;
    }
    logger.info(MODULE, `closeCommand: sid=${sessionId} key=${commandKey}`);
    this.emitUpdated(sessionId, { requestActivation: false, commandKey });
    return this.getSnapshot(sessionId);
  }

  /** 切 active(点 tab),不改指令列表。 */
  showCommand(sessionId: string, commandKey: string): CommandPanelSnapshot {
    const state = this.panels.get(sessionId);
    if (!state) return this.getSnapshot(sessionId);
    if (!state.commands.some((c) => c.key === commandKey)) return this.getSnapshot(sessionId);
    state.activeKey = commandKey;
    this.emitUpdated(sessionId, { requestActivation: false, commandKey });
    return this.getSnapshot(sessionId);
  }

  /** 改某条指令的刷新策略(per-指令,D4)。同步注册/注销后台 task。 */
  setStrategy(
    sessionId: string,
    commandKey: string,
    strategy: CommandRefreshStrategy,
  ): CommandPanelSnapshot {
    const state = this.panels.get(sessionId);
    if (!state) return this.getSnapshot(sessionId);
    const entry = state.commands.find((c) => c.key === commandKey);
    if (!entry || entry.strategy === strategy) return this.getSnapshot(sessionId);
    entry.strategy = strategy;
    const session = this.lookup?.get(sessionId);
    this.syncSchedulerTask(sessionId, entry, session?.ownerWindowId ?? sessionId);
    logger.info(MODULE, `setStrategy: sid=${sessionId} key=${commandKey} strategy=${strategy}`);
    this.emitUpdated(sessionId, { requestActivation: false, commandKey });
    return this.getSnapshot(sessionId);
  }

  // ──────────────────────────────────────────────────────────────────
  // 后台轮询(demand 由 renderer 上报:面板可见+聚焦=HOT,切走=NONE)
  // ──────────────────────────────────────────────────────────────────

  /**
   * renderer 上报 demand(面板可见性/聚焦变化)。per-指令 task 各自的 demand。
   * consumerId = ownerWindowId(窗口关闭时 removeConsumer 兜底)。
   */
  setDemand(sessionId: string, level: 'none' | 'warm' | 'hot'): void {
    if (!this.scheduler) return;
    const state = this.panels.get(sessionId);
    if (!state) return;
    const session = this.lookup?.get(sessionId);
    const consumerId = session?.ownerWindowId ?? sessionId;
    for (const entry of state.commands) {
      const taskKey = this.schedulerTaskKey(sessionId, entry.key);
      if (!entry.strategy || entry.strategy === 'manual' || entry.strategy === 'off') continue;
      // foreground 策略:只有 HOT(可见)才跑;后台策略:HOT 立即/WARM 按间隔。
      if (entry.strategy === 'foreground') {
        this.scheduler.setDemand(taskKey, consumerId, level === 'hot' ? 'hot' : 'none');
      } else {
        this.scheduler.setDemand(taskKey, consumerId, level);
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // 生命周期清理
  // ──────────────────────────────────────────────────────────────────

  /** session 真正销毁(SessionManager 调):清状态 + 停 run + 注销 task。 */
  onSessionDestroyed(sessionId: string): void {
    const state = this.panels.get(sessionId);
    if (!state) return;
    for (const entry of state.commands) {
      if (entry.lastRunId && this.runRoutes.has(entry.lastRunId)) {
        this.runner?.stop(entry.lastRunId);
        this.runRoutes.delete(entry.lastRunId);
      }
      this.unregisterSchedulerTask(sessionId, entry.key);
    }
    this.panels.delete(sessionId);
    logger.info(MODULE, `onSessionDestroyed: sid=${sessionId} cleared`);
  }

  /** 发起窗口关闭:杀掉它发起的、仍属于命令面板的 run(防向已销毁 webContents 推事件)。 */
  onWindowClosed(windowId: string): void {
    for (const [runId, route] of this.runRoutes) {
      const session = this.lookup?.get(route.sessionId);
      if (session?.ownerWindowId === windowId) {
        this.runner?.stop(runId);
        this.runRoutes.delete(runId);
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // 持久化委托(读写 command-panel.json,ADR-024)
  // ──────────────────────────────────────────────────────────────────

  /** 用快照数据恢复某 session 的命令面板(bind 切换/首次拉取,上层调)。 */
  restoreSnapshot(sessionId: string, data: CommandPanelSnapshotData | null): void {
    if (!data || !Array.isArray(data.commands)) {
      this.panels.delete(sessionId);
      return;
    }
    const state = this.ensureState(sessionId);
    state.commands = data.commands.slice(0, MAX_COMMANDS_PER_SESSION).map((c) => ({
      ...c,
      // 恢复后所有指令重置为 idle/无进行中 run(runId 已失效)
      status: 'idle' as CommandRunStatus,
      lastRunId: null,
    }));
    state.activeKey = data.activeKey && state.commands.some((c) => c.key === data.activeKey)
      ? data.activeKey
      : (state.commands[0]?.key ?? null);
    logger.info(MODULE, `restoreSnapshot: sid=${sessionId} commands=${state.commands.length}`);
  }

  /** 导出某 session 的快照(写盘用,上层 debounce 调)。 */
  exportSnapshot(sessionId: string): CommandPanelSnapshotData | null {
    const state = this.panels.get(sessionId);
    if (!state) return null;
    return {
      version: 1,
      commands: state.commands.map((c) => ({ ...c })),
      activeKey: state.activeKey,
    };
  }

  // ──────────────────────────────────────────────────────────────────
  // 内部
  // ──────────────────────────────────────────────────────────────────

  private ensureState(sessionId: string): CommandPanelState {
    let state = this.panels.get(sessionId);
    if (!state) {
      state = { commands: [], activeKey: null };
      this.panels.set(sessionId, state);
    }
    return state;
  }

  /** 调 CodeBlockRunner 跑一次,登记路由,翻状态机。 */
  private async spawnRun(
    sessionId: string,
    entry: CommandEntry,
    session: { currentCwd: string; pathId: string },
    requestingClientId: string | null,
  ): Promise<void> {
    if (!this.runner) {
      logger.warn(MODULE, 'spawnRun: runner 未注入,跳过执行');
      return;
    }
    // 清旧 runId 路由(若有进行中的)
    if (entry.lastRunId) {
      this.runRoutes.delete(entry.lastRunId);
      entry.lastRunId = null;
    }
    entry.status = 'running';
    this.emitUpdated(sessionId, { requestActivation: false, commandKey: entry.key });

    try {
      const { runId } = await this.runner.run({
        sourceSessionId: sessionId,
        language: 'bash',
        code: entry.command,
        requestingClientId: requestingClientId ?? sessionId,
      });
      entry.lastRunId = runId;
      entry.lastRunAt = Date.now();
      this.runRoutes.set(runId, { sessionId, key: entry.key });
    } catch (err) {
      // SSH/Shell/Spawn/CodeTooLarge —— 透传 CodeBlockError 的 code 到状态机
      entry.status = 'error';
      const code = (err as CodeBlockError)?.code ?? 'SpawnFailed';
      entry.output = `⚠ 执行失败(${code}): ${err instanceof Error ? err.message : String(err)}`;
      entry.lastExitCode = null;
      this.emitUpdated(sessionId, { requestActivation: false, commandKey: entry.key });
      logger.warn(MODULE, `spawnRun failed: sid=${sessionId} key=${entry.key} code=${code}`, err);
    }
  }

  /** 处理 CodeBlockRunner 的 output 事件(属于命令面板的 run)。 */
  private handleOutput(route: RunRoute, _stream: 'stdout' | 'stderr', data: string): void {
    const state = this.panels.get(route.sessionId);
    if (!state) return;
    const entry = state.commands.find((c) => c.key === route.key);
    if (!entry) return;
    // 拼接最终输出(实时流靠 renderer 订阅 code-block-output,这里只累积最终值)。
    // 累积而非替换:stdout/stderr 交错按到达顺序拼。
    entry.output = appendTruncated(entry.output, data, OUTPUT_MAX_BYTES);
    // output chunk 不 emit updated(避免逐 chunk 广播整个 snapshot);exited 时统一发。
  }

  /** 处理 CodeBlockRunner 的 exited 事件(属于命令面板的 run)。 */
  private handleExited(
    runId: string,
    route: RunRoute,
    exitCode: number | null,
    signal: string | null,
  ): void {
    const state = this.panels.get(route.sessionId);
    if (!state) {
      this.runRoutes.delete(runId);
      return;
    }
    const entry = state.commands.find((c) => c.key === route.key);
    if (!entry) {
      this.runRoutes.delete(runId);
      return;
    }
    entry.lastExitCode = exitCode;
    entry.status = exitCode === 0 ? 'exited' : 'error';
    if (entry.status === 'error' && !entry.output) {
      entry.output = `⚠ 退出码 ${exitCode ?? 'null'}${signal ? ` (signal ${signal})` : ''}`;
    }
    // 清 runId 路由(exited 后 runId 失效)。entry.lastRunId 可能已被新 run 覆盖,
    // 只在仍指向本次 runId 时清(避免误清新 run 的路由)。
    this.runRoutes.delete(runId);
    if (entry.lastRunId === runId) entry.lastRunId = null;
    this.emitUpdated(route.sessionId, { requestActivation: false, commandKey: route.key });
    logger.info(
      MODULE,
      `exited: sid=${route.sessionId} key=${route.key} exit=${exitCode ?? 'null'} status=${entry.status}`,
    );
  }

  private emitUpdated(
    sessionId: string,
    opts: { requestActivation: boolean; commandKey: string | null },
  ): void {
    const snapshot = this.getSnapshot(sessionId);
    const evt: CommandPanelUpdateEvent = {
      sessionId,
      snapshot,
      requestActivation: opts.requestActivation,
      commandKey: opts.commandKey,
    };
    this.emit('commandPanelUpdated', evt);
  }

  // ── 后台调度 task 管理 ─────────────────────────────────────────────

  private schedulerTaskKey(sessionId: string, commandKey: string): string {
    return `command-panel:${sessionId}:${commandKey}`;
  }

  /** 按策略注册/刷新/注销后台 task。foreground/manual/off 不注册(或注销已有)。 */
  private syncSchedulerTask(
    sessionId: string,
    entry: CommandEntry,
    consumerId: string,
  ): void {
    if (!this.scheduler) return;
    const taskKey = this.schedulerTaskKey(sessionId, entry.key);
    const hot = strategyToHotInterval(entry.strategy);
    if (hot === null) {
      // manual/off:注销已有 task(foreground 也算 hot=0,不进这)
      this.scheduler.unregisterTask(taskKey);
      return;
    }
    const interval = BACKGROUND_INTERVAL_MS[entry.strategy];
    const warmMs = entry.strategy === 'foreground' ? 0 : (interval ?? 30_000);
    this.scheduler.registerTask(taskKey, {
      hotIntervalMs: hot,
      warmIntervalMs: warmMs,
      run: async () => {
        const session = this.lookup?.get(sessionId);
        if (!session) return;
        await this.spawnRun(sessionId, entry, session, session.ownerWindowId ?? sessionId);
      },
      onError: (e) => logger.warn(MODULE, `scheduler task error: ${taskKey}`, e),
    });
  }

  private unregisterSchedulerTask(sessionId: string, commandKey: string): void {
    this.scheduler?.unregisterTask(this.schedulerTaskKey(sessionId, commandKey));
  }
}

/** 拼接 + 超限尾部裁切(保留最新)。 */
function appendTruncated(existing: string, chunk: string, maxBytes: number): string {
  const next = existing + chunk;
  // 按 UTF-8 字节估算超限则裁切(取尾部 maxBytes 字节的近似:按字符 slice)。
  // 精确字节裁切成本高且无必要(展示用),这里按字符数近似(maxBytes/3 保守)。
  const maxChars = Math.floor(maxBytes / 3);
  if (next.length > maxChars) {
    return next.slice(next.length - maxChars);
  }
  return next;
}

/** 命令面板域错误(与 CodeBlockError 对称,供 ipc 映射 HTTP/IPC 错误码)。 */
export class CommandPanelError extends Error {
  constructor(
    public readonly code: 'SessionMissing' | 'CommandEmpty',
    message: string,
  ) {
    super(message);
    this.name = 'CommandPanelError';
  }
}

// 暴露 exited payload 类型给 ipc 层引用(虽然复用 code-block 事件,但便于文档化)。
export type { CommandExitedPayload };
