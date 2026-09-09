/**
 * @file src/main/command-panel-service.ts
 * @purpose 命令面板(v0.3.3 Feature G / ADR-028)—— 第 4 个 dock 面板的后端。
 *
 * @关键设计:
 * - trigger=program-push(与 FilePanelService 同构)。AI 经 `marina run "<cmd>"` /
 *   HTTP POST /run / IPC cmd:command-panel:run 推送**任意命令字符串**。
 * - 执行复用 CodeBlockRunner.run(language='bash', cwd=session.currentCwd)——不经 PTY、
 *   SSH 自动拒绝、shell 路径解析、UTF-8/GBK 解码、生命周期清理全在 CodeBlockRunner。
 * - 多 tab:每 session 一份 {commands[], activeKey}。同 command 字符串去重 upsert
 *   (按 command 派生 key),避免重复 tab。
 * - per-指令刷新由两个独立维度组成:refreshPolicy.scope 决定仅前台还是允许后台，
 *   refreshPolicy.interval 决定手动/5s/30s；后台轮询统一走 BackgroundWorkScheduler。
 * - output 复用 CodeBlockRunner 的内部 'output' 事件，但不向 renderer 转发逐 chunk 流。
 *   entry.output 始终保留最近一次已完成结果；当前 run 写有界 pending buffer，exited 时
 *   原子替换并经 owner-only commandPanelUpdated 广播，取消/被取代则丢弃 pending。
 * - 持久化(D6,套用 ADR-024):command-panel.json,本服务只持内存态,读写委托
 *   workspaceOps(与 FilePanelService 同款注入)。持久化触发由 renderer/上层驱动。
 *
 * @对应文档: ADR-028(docs/方案-命令面板-20260802.md)、ADR-023(CodeBlockRunner)、
 *            ADR-021(后台调度)、ADR-024(workspace 持久化)、附录 I(后台任务规范)。
 *
 * @不要在这里做的事:
 * - 不经 PTY / 不写终端字节流(那是 SessionManager 的职责)。
 * - 不自己 spawn 子进程(委托 CodeBlockRunner,统一执行 + 清理)。
 * - 不把命令正文 / stdout 写进日志或性能报告(隐私:附录 H 红线)。
 * - 不内建 GitHub/map 耦合(map/ticket 只是命令面板的第一个用例,见 ADR-028 哲学边界)。
 */

import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import type {
  CommandEntry,
  CommandExitedPayload,
  CommandPanelSnapshot,
  CommandRefreshInterval,
  CommandRefreshPolicy,
  CommandRunStatus,
} from '@shared/protocol';
import type { CodeBlockError, CodeBlockRunner } from './code-block-runner';
import { logger } from './logger';

const MODULE = 'CommandPanelService';

/** 单条命令输出的字节上限(防失控累积,超出尾部裁切保留最新)。 */
const OUTPUT_MAX_BYTES = 2 * 1024 * 1024;
/** 每 session 指令条数硬上限(溢出 FIFO 丢最旧,防失控累积)。 */
const MAX_COMMANDS_PER_SESSION = 32;
/** 已结束/取消 runId 的短期识别缓存：让同 EventEmitter 链后面的 IPC listener 仍能抑制泄漏。 */
const RECENT_COMMAND_RUN_IDS_MAX = 256;
const RECENT_COMMAND_RUN_ID_TTL_MS = 60_000;

/** 自动刷新间隔 → 毫秒。manual 不注册 scheduler task。 */
const REFRESH_INTERVAL_MS: Readonly<Record<Exclude<CommandRefreshInterval, 'manual'>, number>> = {
  '30s': 30_000,
  '5s': 5_000,
};

/** program-push 后面板挂载会立刻报 HOT；1 秒内只吞这一次调度器重复触发。 */
const DIRECT_RUN_DEDUPE_MS = 1_000;

/** 新指令默认：只在前台刷新，每 30 秒；push 本身仍会立即执行一次。 */
const DEFAULT_REFRESH_POLICY: Readonly<CommandRefreshPolicy> = {
  scope: 'foreground',
  interval: '30s',
};

type LegacyCommandRefreshStrategy =
  | 'foreground'
  | 'background-30s'
  | 'background-5s'
  | 'manual'
  | 'off';

/** v0.3.3 早期混合枚举 → 新的两个独立维度。只用于旧落盘快照迁移。 */
function legacyStrategyToPolicy(strategy: LegacyCommandRefreshStrategy): CommandRefreshPolicy {
  if (strategy === 'background-5s') return { scope: 'background', interval: '5s' };
  if (strategy === 'background-30s') return { scope: 'background', interval: '30s' };
  if (strategy === 'manual' || strategy === 'off') {
    return { scope: 'foreground', interval: 'manual' };
  }
  return { ...DEFAULT_REFRESH_POLICY };
}

/** 兼容缺少 refreshPolicy 的 v1 落盘快照，并拒绝损坏枚举污染 scheduler。 */
function normalizeRefreshPolicy(entry: {
  refreshPolicy?: CommandRefreshPolicy;
  strategy?: LegacyCommandRefreshStrategy;
}): CommandRefreshPolicy {
  const policy = entry.refreshPolicy;
  const validScope = policy?.scope === 'foreground' || policy?.scope === 'background';
  const validInterval =
    policy?.interval === 'manual' || policy?.interval === '5s' || policy?.interval === '30s';
  if (policy && validScope && validInterval) return { ...policy };
  return legacyStrategyToPolicy(entry.strategy ?? 'foreground');
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
  get(
    sessionId: string,
  ): { currentCwd: string; pathId: string; ownerWindowId: string | null } | null;
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
  removeConsumer(consumerId: string): void;
}

/** 命令面板快照的磁盘 schema(仿 file-panel.json,见 ADR-024 §4)。
 * 持久化委托(attachWorkspaceOps)尚未接线上层,但 restore/export 已实现,
 * 上层接线时直接调即可。 */
export interface CommandPanelSnapshotData {
  version: 2;
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
  generation: number;
}

/** pending/active run 的发起 client；owner 转移后关闭旧窗口仍必须取消它发起的进程。 */
interface RunOrigin extends RunRoute {
  clientId: string;
}

/**
 * 一次尚未完成的 run 的候选结果。entry.output 始终保留最近一次已完成结果，
 * 当前轮 stdout/stderr 先写这里，只有 exited 才原子提交，避免刷新期间内容闪空。
 */
interface PendingRunOutput {
  generation: number;
  output: string;
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
  /** Renderer 按 client 上报可见性；stale 旧 owner 的 NONE 不得覆盖新 owner。 */
  private readonly panelDemandLevels = new Map<string, Map<string, 'warm' | 'hot'>>();
  /** 每个 session 当前应用到 scheduler 的 owner，owner 变化时清旧 task demand。 */
  private readonly demandConsumers = new Map<string, string>();
  /** pending runner.run 尚未返回 runId 时也可由新 run/close 通过 generation 使其失效。 */
  private readonly runGenerations = new Map<string, number>();
  /** runKey → 当前轮候选输出；有界累积，完成前不进入 renderer 快照。 */
  private readonly pendingRunOutputs = new Map<string, PendingRunOutput>();
  /** 最近一次 program-push/立即刷新开始时间；只用于吞掉紧随其后的首次 HOT 重复 run。 */
  private readonly lastDirectRunAt = new Map<string, number>();
  /** runKey → 发起 client；在 runner.run 返回 runId 前也存在。 */
  private readonly runOrigins = new Map<string, RunOrigin>();
  /** 已退出/取消的命令 runId 短期 tombstone；IPC exited listener 同步识别后不外发。 */
  private readonly recentCommandRunIds = new Map<string, number>();
  private nextRunGeneration = 0;
  private lookup: CommandPanelSessionLookup | null = null;
  private runner: CodeBlockRunner | null = null;
  private scheduler: CommandScheduler | null = null;

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
    runner.on('exited', (e: { runId: string; exitCode: number | null; signal: string | null }) => {
      const route = this.runRoutes.get(e.runId);
      if (!route) return;
      this.handleExited(e.runId, route, e.exitCode, e.signal);
    });
  }

  /** 注入后台调度器(BackgroundWorkScheduler)。已有恢复态也在这里补注册。 */
  attachScheduler(scheduler: CommandScheduler): void {
    this.scheduler = scheduler;
    for (const [sessionId, state] of this.panels) {
      for (const entry of state.commands) this.syncSchedulerTask(sessionId, entry);
      this.applySchedulerDemand(sessionId);
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // 状态读取
  // ──────────────────────────────────────────────────────────────────

  /** 返回某 session 的命令面板快照(无则空快照)。 */
  getSnapshot(sessionId: string): CommandPanelSnapshot {
    const state = this.panels.get(sessionId);
    if (!state) return { commands: [], activeKey: null };
    return {
      commands: state.commands.map((c) => ({
        ...c,
        refreshPolicy: { ...normalizeRefreshPolicy(c) },
      })),
      activeKey: state.activeKey,
    };
  }

  // ──────────────────────────────────────────────────────────────────
  // 核心操作
  // ──────────────────────────────────────────────────────────────────

  /**
   * 推送/重跑一条指令。同 command 字符串去重 upsert(复用 key),避免重复 tab。
   * upsert 后立即跑一次(无论策略;策略只影响后续自动重跑)。
   *
   * @激活语义 与 file-panel openFile 对齐:无论 isNew,都切 activeKey 到该指令
   * 并在 spawn 前发 requestActivation=true 事件(跳面板看 running 占位,不是等
   * 跑完才跳)。后台调度器自动刷新不走这里(spawnRun 直跑),不会抢激活。
   *
   * @throws 'SessionMissing' session 不存在
   * @throws 'CommandEmpty' command 为空
   * @throws CodeBlockError(SshProfileMissing|ShellMissing|SpawnFailed|CodeTooLarge|
   *   SudoPasswordRequired|SshAuthUnavailable|SshExecFailed)透传自 CodeBlockRunner。
   *   注:SudoPasswordRequired 在 spawnRun 内被拦为 awaiting-sudo-password 态,不抛到这里。
   */
  async runCommand(
    sessionId: string,
    command: string,
    title: string | null = null,
    requestingClientId: string | null = null,
    sudo: boolean = false,
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

    // upsert entry。sudo 是参数权威(刷新走 spawnRun 直读 entry.sudo,不经这里)。
    const entry: CommandEntry =
      existingIdx >= 0
        ? {
            ...state.commands[existingIdx]!,
            command: cmd,
            title: title ?? state.commands[existingIdx]!.title,
            refreshPolicy: normalizeRefreshPolicy(state.commands[existingIdx]!),
            sudo,
          }
        : {
            key,
            command: cmd,
            title: title ?? defaultTitleFor(cmd),
            refreshPolicy: { ...DEFAULT_REFRESH_POLICY },
            lastRunId: null,
            lastExitCode: null,
            status: 'idle',
            output: '',
            lastRunAt: null,
            sudo,
          };
    if (existingIdx >= 0) state.commands[existingIdx] = entry;
    else {
      state.commands.push(entry);
      // 溢出 FIFO 丢最旧时必须同步停 run + 注销 task；只 shift 会留下永久后台任务。
      while (state.commands.length > MAX_COMMANDS_PER_SESSION) {
        const evicted = state.commands.shift();
        if (evicted) this.disposeCommand(sessionId, evicted);
      }
    }
    // 激活语义与 file-panel openFile 对齐(用户反馈 2026-09-09):「已存在则等价
    // show」—— 无论新指令还是已存在指令的重推,都把 activeKey 切到它并请求面板
    // 激活,marina run 与 marina show 行为一致(已在的 tab 也要跳过去看)。
    // 激活事件在 spawn 前发出:长命令先跳面板看到 running 占位,而不是跑完才跳;
    // spawnRun 与完成态的 emit 都是 requestActivation:false,不会覆盖这次激活。
    // 注意:面板 rerun 按钮也走这里,但那时该 tab 本就是 active,激活是幂等 no-op。
    state.activeKey = key;

    logger.info(
      MODULE,
      `runCommand: sid=${sessionId} key=${key} new=${isNew} status=${entry.status}`,
    );
    this.emitUpdated(sessionId, { requestActivation: true, commandKey: key });

    // 先注册 task、再直接跑一次。直接 run 写入 lastRunAt 后才应用 demand，
    // scheduler 的首次 HOT 即使立即触发也会因“距上次不足一个 interval”而跳过，
    // 避免新命令被 program-push 与面板激活各跑一遍。
    this.syncSchedulerTask(sessionId, entry);
    await this.spawnRun(sessionId, entry, requestingClientId);
    // await 期间可能被同 command 新 run 替换或被用户关闭；旧调用不得再发激活事件。
    const currentEntry = this.panels.get(sessionId)?.commands.find((item) => item.key === key);
    if (currentEntry !== entry) return this.getSnapshot(sessionId);
    this.lastDirectRunAt.set(this.commandRunKey(sessionId, key), entry.lastRunAt ?? Date.now());
    this.applySchedulerDemand(sessionId);

    // 完成态快照送达(激活已在 spawn 前发过,这里 requestActivation 恒 false,
    // 避免被 supersede 的旧调用再发激活)。
    this.emitUpdated(sessionId, { requestActivation: false, commandKey: key });

    return this.getSnapshot(sessionId);
  }

  /**
   * v0.3.3 ADR-036:查某条指令最近一次运行时的 cwd(命令输出 Markdown 相对路径
   * 的解析基准,main 端真值)。未找到指令 / 从未运行过(旧快照无 runCwd)返回
   * null,调用方(ipc)回退 session 当前 cwd。只读查询,不发事件。
   */
  getRunCwd(sessionId: string, commandKey: string): string | null {
    const entry = this.panels.get(sessionId)?.commands.find((c) => c.key === commandKey);
    return entry?.runCwd ?? null;
  }

  /** 关闭某条指令 tab。停其进行中的 run + 注销后台 task。 */
  closeCommand(sessionId: string, commandKey: string): CommandPanelSnapshot {
    const state = this.panels.get(sessionId);
    if (!state) return this.getSnapshot(sessionId);
    const idx = state.commands.findIndex((c) => c.key === commandKey);
    if (idx < 0) return this.getSnapshot(sessionId);

    const removed = state.commands[idx]!;
    this.disposeCommand(sessionId, removed);
    state.commands.splice(idx, 1);
    if (state.activeKey === commandKey) {
      state.activeKey = state.commands[0]?.key ?? null;
    }
    this.applySchedulerDemand(sessionId);
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
    // scope=foreground 只允许当前 active tab 拿 HOT；切 tab 必须同步改 demand。
    this.applySchedulerDemand(sessionId);
    this.emitUpdated(sessionId, { requestActivation: false, commandKey });
    return this.getSnapshot(sessionId);
  }

  /**
   * 独立更新运行范围或刷新间隔。patch 在 main 当前真值上合并，两个快速连续的控件请求
   * 不会用 renderer 的旧快照互相覆盖。
   */
  updateRefreshPolicy(
    sessionId: string,
    commandKey: string,
    patch: Partial<CommandRefreshPolicy>,
  ): CommandPanelSnapshot {
    const state = this.panels.get(sessionId);
    if (!state) return this.getSnapshot(sessionId);
    const entry = state.commands.find((c) => c.key === commandKey);
    if (!entry) return this.getSnapshot(sessionId);
    if (
      (patch.scope !== undefined && patch.scope !== 'foreground' && patch.scope !== 'background') ||
      (patch.interval !== undefined &&
        patch.interval !== 'manual' &&
        patch.interval !== '5s' &&
        patch.interval !== '30s')
    ) {
      throw new CommandPanelError(
        'InvalidRefreshPolicy',
        `刷新策略不合法: scope=${String(patch.scope)} interval=${String(patch.interval)}。` +
          'scope 必须是 foreground/background；interval 必须是 manual/5s/30s。',
      );
    }
    const current = normalizeRefreshPolicy(entry);
    const next = { ...current, ...patch };
    if (current.scope === next.scope && current.interval === next.interval) {
      return this.getSnapshot(sessionId);
    }
    entry.refreshPolicy = next;
    this.syncSchedulerTask(sessionId, entry);
    this.applySchedulerDemand(sessionId);
    logger.info(
      MODULE,
      `updateRefreshPolicy: sid=${sessionId} key=${commandKey} scope=${next.scope} interval=${next.interval}`,
    );
    this.emitUpdated(sessionId, { requestActivation: false, commandKey });
    return this.getSnapshot(sessionId);
  }

  // ──────────────────────────────────────────────────────────────────
  // 后台轮询(renderer 只报告可见性；scope 决定隐藏时 NONE 还是 WARM)
  // ──────────────────────────────────────────────────────────────────

  /**
   * 保存某 client 的面板绝对可见性。非 owner 只能发 NONE 做幂等清理，旧 owner 的
   * cleanup 不会覆盖新 owner 已上报的 HOT。
   */
  setDemand(sessionId: string, consumerId: string, level: 'none' | 'warm' | 'hot'): void {
    const ownerWindowId = this.lookup?.get(sessionId)?.ownerWindowId ?? null;
    if (level !== 'none' && ownerWindowId !== consumerId) return;
    let demands = this.panelDemandLevels.get(sessionId);
    if (level === 'none') {
      demands?.delete(consumerId);
      if (demands?.size === 0) this.panelDemandLevels.delete(sessionId);
    } else {
      if (!demands) {
        demands = new Map();
        this.panelDemandLevels.set(sessionId, demands);
      }
      demands.set(consumerId, level);
    }
    this.applySchedulerDemand(sessionId);
  }

  // ──────────────────────────────────────────────────────────────────
  // 生命周期清理
  // ──────────────────────────────────────────────────────────────────

  /** session 真正销毁(SessionManager 调):清状态 + 停 run/pending spawn + 注销 task。 */
  onSessionDestroyed(sessionId: string): void {
    const state = this.panels.get(sessionId);
    if (state) {
      for (const entry of state.commands) this.disposeCommand(sessionId, entry);
      this.panels.delete(sessionId);
    }
    this.panelDemandLevels.delete(sessionId);
    this.demandConsumers.delete(sessionId);
    logger.info(MODULE, `onSessionDestroyed: sid=${sessionId} cleared`);
  }

  /** owner 改变时清该 session 的全部旧 demand；新 owner 挂载后会按绝对状态重报。 */
  onSessionOwnerChanged(sessionId: string): void {
    const state = this.panels.get(sessionId);
    if (state) {
      for (const entry of state.commands) {
        this.scheduler?.clearTaskDemands(this.schedulerTaskKey(sessionId, entry.key));
      }
    }
    this.panelDemandLevels.delete(sessionId);
    this.demandConsumers.delete(sessionId);
  }

  /** 本地窗口/远程 client 消失：只撤 demand，不让 stale cleanup 影响其他 client。 */
  removeDemandConsumer(consumerId: string): void {
    this.scheduler?.removeConsumer(consumerId);
    for (const [sessionId, demands] of this.panelDemandLevels) {
      demands.delete(consumerId);
      if (demands.size === 0) this.panelDemandLevels.delete(sessionId);
    }
    for (const [sessionId, appliedConsumer] of this.demandConsumers) {
      if (appliedConsumer === consumerId) this.demandConsumers.delete(sessionId);
    }
  }

  /**
   * 发起窗口关闭：按 run 的 origin 而非 session 当前 owner 取消。owner 可能已转移给 B，
   * 但 CodeBlockRunner.removeClient(A) 仍会杀 A 启动的进程；这里必须同步把 B 看到的
   * entry 从 running 复位为 idle，且删除 route，避免迟到 exited 又翻成 error。
   */
  onWindowClosed(windowId: string): void {
    for (const origin of [...this.runOrigins.values()]) {
      if (origin.clientId !== windowId) continue;
      const entry = this.panels
        .get(origin.sessionId)
        ?.commands.find((item) => item.key === origin.key);
      if (!entry) continue;
      this.cancelCommandRun(origin.sessionId, entry);
      this.emitUpdated(origin.sessionId, {
        requestActivation: false,
        commandKey: origin.key,
      });
    }
    this.removeDemandConsumer(windowId);
  }

  // ──────────────────────────────────────────────────────────────────
  // 持久化委托(读写 command-panel.json,ADR-024)
  // ──────────────────────────────────────────────────────────────────

  /** 用快照数据恢复某 session 的命令面板(bind 切换/首次拉取,上层调)。 */
  restoreSnapshot(sessionId: string, data: CommandPanelSnapshotData | null): void {
    const previous = this.panels.get(sessionId);
    if (previous) {
      for (const entry of previous.commands) this.disposeCommand(sessionId, entry);
    }
    if (!data || !Array.isArray(data.commands)) {
      this.panels.delete(sessionId);
      return;
    }
    const state = this.ensureState(sessionId);
    state.commands = data.commands.slice(0, MAX_COMMANDS_PER_SESSION).map((c) => {
      const refreshPolicy = normalizeRefreshPolicy(c);
      // v1 快照可能带 legacy strategy；迁移后从内存真值中删除，避免两个字段再漂移。
      const restored = { ...c } as CommandEntry & { strategy?: LegacyCommandRefreshStrategy };
      delete restored.strategy;
      return {
        ...restored,
        refreshPolicy,
        // 恢复后所有指令重置为 idle/无进行中 run(runId 已失效)
        status: 'idle' as CommandRunStatus,
        lastRunId: null,
      };
    });
    state.activeKey =
      data.activeKey && state.commands.some((c) => c.key === data.activeKey)
        ? data.activeKey
        : (state.commands[0]?.key ?? null);
    for (const entry of state.commands) this.syncSchedulerTask(sessionId, entry);
    this.applySchedulerDemand(sessionId);
    logger.info(MODULE, `restoreSnapshot: sid=${sessionId} commands=${state.commands.length}`);
  }

  /** 导出某 session 的快照(写盘用,上层 debounce 调)。 */
  exportSnapshot(sessionId: string): CommandPanelSnapshotData | null {
    const state = this.panels.get(sessionId);
    if (!state) return null;
    return {
      version: 2,
      commands: state.commands.map((c) => ({
        ...c,
        refreshPolicy: { ...normalizeRefreshPolicy(c) },
      })),
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
    requestingClientId: string | null,
  ): Promise<void> {
    if (!this.runner) {
      logger.warn(MODULE, 'spawnRun: runner 未注入,跳过执行');
      return;
    }
    // 同一指令被再次 push 时，新 run 取代旧 run：停已知旧进程；generation 还能覆盖
    // runner.run 尚未返回 runId 的 pending 窗口，旧 Promise 最终返回时会立即 stop。
    this.cancelCommandRun(sessionId, entry);
    const runKey = this.commandRunKey(sessionId, entry.key);
    const generation = ++this.nextRunGeneration;
    const originClientId = requestingClientId ?? sessionId;
    this.runGenerations.set(runKey, generation);
    this.runOrigins.set(runKey, {
      sessionId,
      key: entry.key,
      generation,
      clientId: originClientId,
    });
    // 双缓冲：entry.output 是已提交结果；当前轮单独有界累积。这样 running 快照
    // 仍带旧 Markdown，用户可以继续阅读/选择，exited 时才一次性替换。
    this.pendingRunOutputs.set(runKey, { generation, output: '' });

    // lastExitCode 与 output 同属“最近一次已完成结果”；running 期间保留，既能
    // 区分首次运行和“上次成功但空输出”，也避免刷新开始时丢失完成态信息。
    entry.lastRunAt = Date.now();
    // v0.3.3 ADR-036:记录本次运行的 cwd 真值。命令输出 Markdown 的相对链接/
    // 图片/gallery 以后以它为解析基准 —— 若用“点击时的 currentCwd”,终端 cd 后
    // 旧输出的相对路径会静默漂移(指错文件或 404)。CodeBlockRunner 内部也是读
    // session.currentCwd spawn,这里在 spawn 前同源取一次即可。SSH session 的
    // currentCwd 是远端路径,照存:本地 fs 解析会失败并 toast(与 CLI show 一致)。
    entry.runCwd = this.lookup?.get(sessionId)?.currentCwd ?? entry.runCwd ?? null;
    entry.status = 'running';
    this.emitUpdated(sessionId, { requestActivation: false, commandKey: entry.key });

    try {
      const { runId } = await this.runner.run({
        sourceSessionId: sessionId,
        language: 'bash',
        code: entry.command,
        requestingClientId: originClientId,
        // v0.3.3 远程 sudo:仅 SSH session 生效;runner 据此走 ssh exec + sudo -S。
        sudo: !!entry.sudo,
      });
      if (this.runGenerations.get(runKey) !== generation) {
        this.rememberCommandRunId(runId);
        this.runner.stop(runId);
        return;
      }
      entry.lastRunId = runId;
      this.runRoutes.set(runId, { sessionId, key: entry.key, generation });
    } catch (err) {
      // 已被新 run/close/session destroy 取代的 pending spawn 不得回写旧错误态。
      if (this.runGenerations.get(runKey) !== generation) return;
      this.runGenerations.delete(runKey);
      this.runOrigins.delete(runKey);
      this.pendingRunOutputs.delete(runKey);
      const code = (err as CodeBlockError)?.code ?? 'SpawnFailed';
      // SSH session 的 sudo 命令但未录密码 → 转为 awaiting-sudo-password 态,让 renderer
      // 渲染内联密码输入框;录入后重跑。旧输出保留可见(与 running 同理)。
      if (code === 'SudoPasswordRequired') {
        entry.status = 'awaiting-sudo-password';
        const profileHint = err instanceof Error ? err.message : '';
        entry.output = `🔑 ${profileHint}\n\n在上方输入框录入 sudo 密码后重试。密码仅存在内存,绝不落盘。`;
        entry.lastExitCode = null;
        this.emitUpdated(sessionId, { requestActivation: false, commandKey: entry.key });
        logger.info(MODULE, `spawnRun awaiting-sudo-password: sid=${sessionId} key=${entry.key}`);
        return;
      }
      // SSH/Shell/Spawn/CodeTooLarge —— 到失败确定时才替换旧结果;运行开始到这里
      // 之间旧 Markdown 始终可见，不会因 pending spawn 闪空。
      entry.status = 'error';
      entry.output = `⚠ 执行失败(${code}): ${err instanceof Error ? err.message : String(err)}`;
      entry.lastExitCode = null;
      this.emitUpdated(sessionId, { requestActivation: false, commandKey: entry.key });
      logger.warn(MODULE, `spawnRun failed: sid=${sessionId} key=${entry.key} code=${code}`, err);
    }
  }

  /** 处理 CodeBlockRunner 的 output 事件(属于命令面板的 run)。 */
  private handleOutput(route: RunRoute, _stream: 'stdout' | 'stderr', data: string): void {
    const runKey = this.commandRunKey(route.sessionId, route.key);
    if (this.runGenerations.get(runKey) !== route.generation) return;
    const state = this.panels.get(route.sessionId);
    if (!state) return;
    const entry = state.commands.find((c) => c.key === route.key);
    if (!entry) return;
    const pending = this.pendingRunOutputs.get(runKey);
    if (!pending || pending.generation !== route.generation) return;
    // stdout/stderr 只写当前 generation 的候选缓冲，保留两条 stream 到达顺序。
    // entry.output 不动，因此运行中 renderer 始终展示最近一次完整结果。
    pending.output = appendTruncated(pending.output, data, OUTPUT_MAX_BYTES);
    // output chunk 不 emit updated(避免逐 chunk 广播整个 snapshot);exited 时统一提交。
  }

  /** 处理 CodeBlockRunner 的 exited 事件(属于命令面板的 run)。 */
  private handleExited(
    runId: string,
    route: RunRoute,
    exitCode: number | null,
    signal: string | null,
  ): void {
    // CommandPanelService 的 listener 比 ipc.ts 先注册；先落 tombstone，后续共享
    // code-block exited listener 同一事件循环内即可识别并抑制。
    this.rememberCommandRunId(runId);
    const runKey = this.commandRunKey(route.sessionId, route.key);
    if (this.runGenerations.get(runKey) !== route.generation) {
      this.runRoutes.delete(runId);
      return;
    }
    const state = this.panels.get(route.sessionId);
    if (!state) {
      this.runRoutes.delete(runId);
      this.runGenerations.delete(runKey);
      this.pendingRunOutputs.delete(runKey);
      return;
    }
    const entry = state.commands.find((c) => c.key === route.key);
    if (!entry) {
      this.runRoutes.delete(runId);
      this.runGenerations.delete(runKey);
      this.pendingRunOutputs.delete(runKey);
      return;
    }
    const pending = this.pendingRunOutputs.get(runKey);
    // generation 已在函数入口核对；此时把完整候选结果一次性提交。成功但没有
    // stdout/stderr 也必须提交空串，表示本轮确实替换了旧结果。
    entry.output = pending?.generation === route.generation ? pending.output : '';
    entry.lastExitCode = exitCode;
    entry.status = exitCode === 0 ? 'exited' : 'error';
    if (entry.status === 'error' && !entry.output) {
      entry.output = `⚠ 退出码 ${exitCode ?? 'null'}${signal ? ` (signal ${signal})` : ''}`;
    }
    // 清 runId 路由(exited 后 runId 失效)。entry.lastRunId 可能已被新 run 覆盖,
    // 只在仍指向本次 runId 时清(避免误清新 run 的路由)。
    this.runRoutes.delete(runId);
    this.runGenerations.delete(runKey);
    this.runOrigins.delete(runKey);
    this.pendingRunOutputs.delete(runKey);
    if (entry.lastRunId === runId) entry.lastRunId = null;
    this.emitUpdated(route.sessionId, { requestActivation: false, commandKey: route.key });
    logger.info(
      MODULE,
      `exited: sid=${route.sessionId} key=${route.key} exit=${exitCode ?? 'null'} status=${entry.status}`,
    );
  }

  /**
   * IPC 的共享 CodeBlockRunner listener 用：命令面板输出只经 owner-only snapshot 发送，
   * 不能再按 runner 原始 clientId 把流式内容泄漏给旧 owner。
   */
  isCommandPanelRun(runId: string): boolean {
    if (this.runRoutes.has(runId)) return true;
    const rememberedAt = this.recentCommandRunIds.get(runId);
    if (rememberedAt === undefined) return false;
    if (Date.now() - rememberedAt <= RECENT_COMMAND_RUN_ID_TTL_MS) return true;
    this.recentCommandRunIds.delete(runId);
    return false;
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

  /**
   * 把面板可见性 + 每条独立 policy 映射到 scheduler：
   * - foreground：仅 active tab 且面板 HOT 时为 HOT，其余 NONE；
   * - background：active+可见为 HOT，其余只要仍有 owner 就为 WARM；
   * - manual：task 已注销，不产生 demand。
   */
  private applySchedulerDemand(sessionId: string): void {
    if (!this.scheduler) return;
    const state = this.panels.get(sessionId);
    if (!state) return;
    const consumerId = this.lookup?.get(sessionId)?.ownerWindowId ?? null;
    const previousConsumer = this.demandConsumers.get(sessionId);
    if (!consumerId) {
      for (const entry of state.commands) {
        this.scheduler.clearTaskDemands(this.schedulerTaskKey(sessionId, entry.key));
      }
      this.demandConsumers.delete(sessionId);
      return;
    }
    if (previousConsumer && previousConsumer !== consumerId) {
      for (const entry of state.commands) {
        this.scheduler.clearTaskDemands(this.schedulerTaskKey(sessionId, entry.key));
      }
    }
    this.demandConsumers.set(sessionId, consumerId);

    const panelLevel = this.panelDemandLevels.get(sessionId)?.get(consumerId) ?? 'none';
    for (const entry of state.commands) {
      const policy = normalizeRefreshPolicy(entry);
      entry.refreshPolicy = policy;
      const taskKey = this.schedulerTaskKey(sessionId, entry.key);
      if (policy.interval === 'manual') {
        this.scheduler.setDemand(taskKey, consumerId, 'none');
        continue;
      }
      const activeAndVisible = state.activeKey === entry.key && panelLevel === 'hot';
      const level =
        policy.scope === 'foreground'
          ? activeAndVisible
            ? 'hot'
            : 'none'
          : activeAndVisible
            ? 'hot'
            : 'warm';
      this.scheduler.setDemand(taskKey, consumerId, level);
    }
  }

  /** 按 interval 注册/刷新 task；scope 只在 applySchedulerDemand 决定 demand。 */
  private syncSchedulerTask(sessionId: string, entry: CommandEntry): void {
    if (!this.scheduler) return;
    const taskKey = this.schedulerTaskKey(sessionId, entry.key);
    const policy = normalizeRefreshPolicy(entry);
    entry.refreshPolicy = policy;
    if (policy.interval === 'manual') {
      this.scheduler.unregisterTask(taskKey);
      return;
    }
    const intervalMs = REFRESH_INTERVAL_MS[policy.interval];
    this.scheduler.registerTask(taskKey, {
      hotIntervalMs: intervalMs,
      warmIntervalMs: intervalMs,
      run: async () => {
        const session = this.lookup?.get(sessionId);
        if (!session) return;
        const runKey = this.commandRunKey(sessionId, entry.key);
        const directRunAt = this.lastDirectRunAt.get(runKey);
        if (directRunAt !== undefined) {
          this.lastDirectRunAt.delete(runKey);
          // 只吞 program-push 后紧随的面板 HOT 建 demand；过期后 HOT 仍应立即刷新，
          // 不能把已等待 29s 的 30s WARM timer 再推迟完整 30s。
          if (Date.now() - directRunAt <= DIRECT_RUN_DEDUPE_MS) return;
        }
        // running 不重复跑;awaiting-sudo-password 也不自动刷新(等用户录密码手动重跑,
        // 否则每 interval 重复 SudoPasswordRequired,扰民)。
        if (entry.status === 'running' || entry.status === 'awaiting-sudo-password') return;
        await this.spawnRun(sessionId, entry, session.ownerWindowId ?? sessionId);
      },
      onError: (e) => logger.warn(MODULE, `scheduler task error: ${taskKey}`, e),
    });
  }

  /** run generation 的内部 key；不进入日志/指标。 */
  private commandRunKey(sessionId: string, commandKey: string): string {
    return `${sessionId}:${commandKey}`;
  }

  /** 停已知 run，并让尚未返回 runId 的 Promise 失去写回资格。task 本身保留。 */
  private cancelCommandRun(sessionId: string, entry: CommandEntry): void {
    const runKey = this.commandRunKey(sessionId, entry.key);
    this.runGenerations.delete(runKey);
    this.runOrigins.delete(runKey);
    // cancel / supersede 永不提交半截结果；旧的 entry.output 继续作为最后完整结果。
    this.pendingRunOutputs.delete(runKey);
    this.lastDirectRunAt.delete(runKey);
    if (entry.status === 'running') entry.status = 'idle';
    if (!entry.lastRunId) return;
    this.rememberCommandRunId(entry.lastRunId);
    this.runner?.stop(entry.lastRunId);
    this.runRoutes.delete(entry.lastRunId);
    entry.lastRunId = null;
  }

  /** 记录已结束/取消的 command runId，并按插入顺序保持硬上限。 */
  private rememberCommandRunId(runId: string): void {
    this.recentCommandRunIds.delete(runId);
    this.recentCommandRunIds.set(runId, Date.now());
    while (this.recentCommandRunIds.size > RECENT_COMMAND_RUN_IDS_MAX) {
      const oldest = this.recentCommandRunIds.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.recentCommandRunIds.delete(oldest);
    }
  }

  /** 指令被关闭/FIFO 淘汰/session 销毁时的完整资源回收。 */
  private disposeCommand(sessionId: string, entry: CommandEntry): void {
    this.cancelCommandRun(sessionId, entry);
    this.lastDirectRunAt.delete(this.commandRunKey(sessionId, entry.key));
    this.unregisterSchedulerTask(sessionId, entry.key);
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
    public readonly code: 'SessionMissing' | 'CommandEmpty' | 'InvalidRefreshPolicy',
    message: string,
  ) {
    super(message);
    this.name = 'CommandPanelError';
  }
}

// 暴露 exited payload 类型给 ipc 层引用(虽然复用 code-block 事件,但便于文档化)。
export type { CommandExitedPayload };
