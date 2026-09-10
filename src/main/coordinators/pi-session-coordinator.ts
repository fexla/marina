/**
 * @file pi-session-coordinator.ts
 * @purpose M2:pi 集成业务层(主 piSessionId 锁定 + reason 分发 + pi↔workspace 映射),
 * 从 SessionManager 拆出。状态副作用经 hooks 回调驱动 SessionManager 状态机。
 *
 * @关键设计:
 * - 分两层拆:pi 业务层(本文件)管「谁的主对话、要不要动 workspace」;状态副作用
 *   (isPiAgent / piWorking / hasUnviewedWork / displayName)经 PiSessionHooks 回调
 *   给 SessionManager 实现,它有自己的 ManagedSession 上下文,不用把状态机内部
 *   暴露给 coordinator(封装不破)。
 * - 主 piSessionId 锁定(v0.3.3 ADR-028):每个 Marina terminal 同一时刻只绑定一个
 *   「主 pi 对话」,subagent 等临时子 session 的 workspace/名字事件全部忽略,
 *   不污染主终端。
 * - subagent 聚合状态(v0.3.4,重开 方案-20260817 的 L3,开发者 2026-09-10 裁决):
 *   子 session 事件不再纯丢弃 —— workspace/名字污染照旧拦截,但**工作状态聚合**:
 *   终端「工作中」= 主 agent 在干 ∨ 任一注册子 agent 在干。前台(task 工具阻塞)子
 *   agent 期间主 agent 本就未 settled,天然覆盖;本聚合真正修的是**后台/async 子
 *   agent**(工具立即返回、主 agent 可先 settled)导致的错显空闲。全部收工时走
 *   既有 notifyAgentSettled 路径(idle + hasUnviewedWork,语义与主 agent 收工一致:
 *   Marina 只关心「pi 进程树是否在工作、是否干完了用户还没看」)。
 * - 依赖:SessionWorkspaceCoordinator(做 workspace 操作)+ PiSessionHooks(状态副作用)
 *   + PiSettingsSource(读 settings.piIntegration)。全程不碰 ManagedSession。
 *
 * @对应文档章节:v0.3.3 ADR-028 + v0.3.4 subagent 聚合(方案-pibridge-fork与子会话
 *   适配-20260817 第 3.3 节 L3)+ M2 设计(pi 业务层独立)
 *
 * @不要在这里做的事:
 * - 不要碰 ManagedSession / markActive / emitStateChanged(那是 SessionManager 的 hooks)
 * - 不要持久化映射(内存态,workspace 走 retentionDays 回收)
 * - 不要把子 agent 事件放进 workspace/名字决策(ADR-028 防污染不动摇,只聚合状态)
 */
import { logger } from '../logger';
import type { Settings } from '@shared/types';
import { AgentStateGetter } from '../state-getters/agent-state-getter';
import type { SessionLookup } from './session-lookup';
import type { SessionWorkspaceCoordinator } from './session-workspace-coordinator';

/**
 * pi 事件 → SessionManager 状态副作用的回调接口。SessionManager 实现(它有
 * ManagedSession 上下文);PiSessionCoordinator 只通知意图,幂等判断/当前值判断
 * 留在 SessionManager 的 hooks 里。
 */
export interface PiSessionHooks {
  /** pi 身份声明/退出:isPiAgent 翻转为 true/false(幂等,仅变化时 emit)。 */
  onPiAgentChanged(sessionId: string, isPiAgent: boolean): void;
  /** pi 对话名 → agent 标题槽(ADR-032;优先级高于裸 OSC 的 program 槽)。 */
  onPiName(sessionId: string, name: string | null): void;
  // ── agent 状态机集成(终端状态分层:agent getter 接管,字节流 fallback 旁路)──
  /** agent 绑定(session_start):SessionManager 把 stateGetter 换成传入的 agent getter。 */
  bindAgent(sessionId: string, getter: AgentStateGetter): void;
  /** agent 解绑(session_shutdown):stateGetter 回退到 byteStream fallback。 */
  unbindAgent(sessionId: string): void;
  /** agent 开始工作:Coordinator 已先调 getter.onWorking();这里清 hasUnviewedWork + applyState。 */
  notifyAgentWorking(sessionId: string): void;
  /** agent 这轮完成:Coordinator 已先调 getter.onSettled();这里 applyState + 标 hasUnviewedWork。 */
  notifyAgentSettled(sessionId: string): void;
}

/** PiSessionCoordinator 对 settings 的最小依赖:只读 piIntegration(破循环 + 可测)。 */
export interface PiSettingsSource {
  get(): { piIntegration: Settings['piIntegration'] };
}

/**
 * 已注册 subagent 子会话的跟踪状态。
 *
 * pi-subagents 的子 agent 是独立 pi 子进程(spawn 时继承 TERMINAL_ID/MARINA env,
 * bridge 照常发事件),Marina 侧靠 child piSessionId 区分。
 */
interface TrackedChildAgent {
  /** 该子 agent 当前是否在干(bridge 的 agent_working / agent_settled 驱动)。 */
  working: boolean;
  /** 最后一次收到该子任意事件的时间戳(ms)。泄露回收依据,见 CHILD_STALE_MS。 */
  lastEventAt: number;
}

/**
 * 每个 Marina terminal 的 pi 聚合状态(主 agent + subagent 子进程)。
 * 「终端工作中」= mainWorking ∨ 任一 child.working —— Marina 只关心 pi 进程树
 * 是否在工作,不区分是谁在干(2026-09-10 开发者裁决)。
 */
interface TerminalPiAggregate {
  /** 主 pi 对话的 agent 是否 working。 */
  mainWorking: boolean;
  /**
   * 主 pi 已 session_shutdown 但仍有子 agent 在干 → teardown(unbind/isPiAgent=false)
   * 延迟到子排空。期间子事件继续驱动状态;若用户在终端里起新 pi(session_start),
   * 该标志清除(新主接管,延迟 teardown 取消)。
   */
  mainGone: boolean;
  /** 已注册子会话(child piSessionId → 状态)。注册 = 事件被主锁拦截过 session_start。 */
  children: Map<string, TrackedChildAgent>;
}

/**
 * 子 agent 泄露回收宽限期:超过此时长无任何事件的注册子视为已死,直接移除。
 *
 * 为什么需要:子进程被 hard-kill(超时强杀/崩溃)不会发 session_shutdown,
 * working 子会永远卡住「工作中」。为什么是 15 分钟而不是更短:单个 agent turn
 * 期间(working → settled 之间)bridge 不发任何事件,思考/工具重的子 agent 单轮
 * 超过 10 分钟并不罕见 —— TTL 太短会把活着的子误判成死(状态错翻 idle)。15 分钟
 * 是「最长静默 turn」与「卡死状态的最长忍受时间」的折中,误判的代价只是提前
 * idle(真 settled 事件随后到达时按未注册忽略,不会二次翻转)。
 */
const CHILD_STALE_MS = 15 * 60_000;

/** 泄露回收扫描间隔(生产 sweeper;测试直接调 sweepStaleChildren)。 */
const CHILD_SWEEP_INTERVAL_MS = 60_000;

export class PiSessionCoordinator {
  /**
   * v0.3.3 ADR-028：Marina sessionId → 当前活跃 pi 对话 id 的反查(主锁)。
   * 用于 session 销毁 / pi 退出时清理 piSessionToWorkspace。
   */
  private readonly sessionToPiSession = new Map<string, string>();
  private hooks: PiSessionHooks | null = null;
  private lookup: SessionLookup | null = null;
  /**
   * workspace 切换完成后的 notify 回调(由 index.ts 闭合为 filePanelService
   * .onWorkspaceSwitched)。pi resume 切回 / new/fork 新建 workspace 后调它,触发
   * 文件面板重建 + 快照恢复(否则 resume 后原打开文件不恢复)。null = 未注入(测试)→
   * 跳过,workspace 映射仍正确,只是文件面板不同步重建。
   */
  private workspaceSwitchedNotify: ((sessionId: string) => void) | null = null;
  /**
   * 每个 pi 会话的 AgentStateGetter(session_start 创建,session_shutdown/销毁删除)。
   * PiCoordinator 持有引用以调 onWorking/onSettled(更新 getter),状态应用经
   * SessionManager 的 notifyAgentWorking/notifyAgentSettled(applyState)。
   */
  private readonly agentGetters = new Map<string, AgentStateGetter>();
  /**
   * 每个 Marina terminal 的 pi 聚合状态(subagent 聚合,v0.3.4)。session_start(main)
   * 懒创建;session_shutdown(main) 无 working 子时删除;销毁时无条件删。
   */
  private readonly aggregates = new Map<string, TerminalPiAggregate>();
  /** 泄露回收 sweeper(懒启动:首个子注册时起,全排空时停;unref 不阻塞退出)。 */
  private sweeperTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly workspaceCoordinator: SessionWorkspaceCoordinator,
    private readonly settingsManager: PiSettingsSource,
    /** 可注入时钟(测试泄露回收);生产缺省 Date.now。 */
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** 注入 SessionManager 实现的 hooks(状态副作用)。 */
  attachHooks(hooks: PiSessionHooks): void {
    this.hooks = hooks;
  }

  /** 注入 SessionManager 的只读 session 查询(session 不存在守卫)。 */
  attachSessionLookup(lookup: SessionLookup): void {
    this.lookup = lookup;
  }

  /**
   * 注入 workspace 切换 notify 回调(index.ts 闭合为 filePanelService.onWorkspaceSwitched)。
   * pi 切换 workspace(resume 切回 / new 新建)后调它,触发文件面板重建 + 快照恢复。
   */
  attachWorkspaceSwitchNotify(cb: (sessionId: string) => void): void {
    this.workspaceSwitchedNotify = cb;
  }

  /**
   * 处理 pi package 转发的事件。所有 pi 业务决策集中于此,调用方(file-panel-service
   * HTTP /pi-session-event)不需要理解事件语义。fire-and-forget:失败只 log,不抛
   * (不能阻塞 pi)。
   *
   * @param sessionId Marina session id(= body.terminal = env.TERMINAL_ID)
   * @param payload 已校验的事件体(由 HTTP handler 解析)
   */
  async handlePiSessionEvent(
    sessionId: string,
    payload: {
      piSessionId: string;
      event:
        | 'session_start'
        | 'session_shutdown'
        | 'agent_working'
        | 'agent_settled'
        | 'name_changed';
      reason?: string;
      name?: string | null;
      /**
       * v0.3.3 ADR-028:bridge 从 pi 对话的 marina-workspace entry 恢复出的
       * workspaceId(resume 时带上)。Marina 据此切回原 workspace;缺失/已回收则新建,
       * 新建的 workspaceId 经返回值交回 bridge 存入 entry(跨重启稳定)。
       *
       * v0.3.4 起为 branch-aware(当前分支最近的 entry,不是全文件第一个)。
       */
      workspaceId?: string | null;
      /**
       * fork/子会话亲缘(方案 20260817):本对话文件的来源(父会话文件路径,
       * header.parentSession)。fork/clone/pi-subagents 子会话才有。
       */
      parentSessionFile?: string | null;
      /** 父对话当前 workspace(bridge 读父文件最后一条绑定 entry)。 */
      parentBinding?: string | null;
    },
  ): Promise<{ workspaceId?: string } | void> {
    if (!this.lookup?.hasSession(sessionId)) {
      // 竞态：session 刚销毁或 terminal id 伪造。静默丢弃(pi 不该被卡)。
      logger.warn(
        'PiSessionCoordinator',
        `applyPiSessionEvent: session not found sid=${sessionId} event=${payload.event}`,
      );
      return;
    }
    // v0.3.3 ADR-028「主 piSessionId 锁定」:每个 Marina terminal 同一时刻只绑定
    // 一个「主 pi 对话」。subagent tool 等机制起的临时子 session 有独立 piSessionId,
    // 其 workspace/名字事件全部忽略 —— 子 agent 是临时辅助,不该污染主终端的
    // workspace/名字/状态(实测:子 agent 的 name_changed 会把终端名改成 "subagent-worker-xxx")。
    //
    // 规则(纯靠 piSessionId 比对,不依赖任何第三方 subagent package 的 env 约定):
    //   - currentMain===null(初始 / 旧主已 session_shutdown)且非注册子:接受,session_start
    //     据此绑定新主;零星的其它事件也接受(启动竞态,无害)。
    //   - 否则 piSessionId!==currentMain:子 agent 事件,交给 handleChildAgentEvent
    //     (v0.3.4:workspace/名字照旧拦截,工作状态进聚合)。
    //   - 合法主切换(/new /resume /fork /重启 pi)前 pi 必先发 session_shutdown 清空
    //     主绑定,随后的 session_start 才能绑定新主 → 「关闭 pi 或 /new 后新 pi 正常工作」。
    //   - 注册过的子永不升级为主:主 shutdown 后(currentMain null),已注册子的
    //     session_start 仍按子处理,防止后台子 agent 把自己绑成主对话抢 workspace。
    const currentMainPiSid = this.sessionToPiSession.get(sessionId) ?? null;
    const term = this.aggregates.get(sessionId);
    const isRegisteredChild = term?.children.has(payload.piSessionId) ?? false;
    if (
      (currentMainPiSid !== null && payload.piSessionId !== currentMainPiSid) ||
      isRegisteredChild
    ) {
      this.handleChildAgentEvent(sessionId, payload, term);
      return;
    }
    const settings = this.settingsManager.get().piIntegration;
    logger.info(
      'PiSessionCoordinator',
      `pi-event sid=${sessionId} piSid=${payload.piSessionId} event=${payload.event} reason=${payload.reason ?? '-'}`,
    );

    switch (payload.event) {
      case 'session_start': {
        // 声明 pi 身份(无论开关，isPiAgent 总是准确反映“终端在跑 pi”)。
        this.hooks?.onPiAgentChanged(sessionId, true);
        this.sessionToPiSession.set(sessionId, payload.piSessionId);
        const term = this.ensureTerm(sessionId);
        // 新主接管:若旧主 shutdown 时因子 agent 未排空而延迟了 teardown,现在取消
        // (teardown 责任移交给「新主自己的 session_shutdown」)。
        term.mainGone = false;
        // 亲缘可见性(方案 20260817 L1):fork/子会话文件带 parentSessionFile,
        // 记进日志供诊断(谁是谁的儿子、父 workspace 是哪个)。
        if (payload.parentSessionFile) {
          logger.info(
            'PiSessionCoordinator',
            `pi-lineage: sid=${sessionId} piSid=${payload.piSessionId} parent=${payload.parentSessionFile} parentWs=${payload.parentBinding ?? '-'}`,
          );
        }
        // 终端状态分层:AgentStateGetter bind —— stateGetter 换成 agent getter,
        // 字节流检测旁路。聚合 working(后台子 agent 跨主切换仍在干)时种子为
        // working,bind 后 applyState 立即拉到 active,不闪 idle。getter 已存在
        // (旧主延迟 teardown 保留的)则复用,种子 onWorking 幂等。
        this.ensureAgentBound(sessionId, this.isAggregateWorking(term));
        // 返回 { workspaceId }：新建的 workspace id 交回 bridge 存进对话 entry
        // (appendEntry),下次 resume 同一对话时 bridge 读出随事件带上 → Marina 切回。
        return await this.handlePiConversationSwitch(
          sessionId,
          payload.reason ?? 'startup',
          settings,
          payload.workspaceId ?? null,
          payload.parentBinding ?? null,
        );
      }

      case 'session_shutdown': {
        // pi 进程要退出了。workspace 按现有生命周期(Marina session 销毁时 release)；
        // 这里不提前 release(与销毁路径竞争)。
        this.sessionToPiSession.delete(sessionId);
        const term = this.ensureTerm(sessionId);
        const anyChildWorking = [...term.children.values()].some((c) => c.working);
        if (anyChildWorking) {
          // 后台/async 子 agent 还在干 → 状态机继续由子事件驱动,teardown 延迟到
          // 子排空(fireAggregateFallingEdge 里补)。此刻不发 settled —— 工作没完。
          term.mainGone = true;
          term.mainWorking = false;
          logger.info(
            'PiSessionCoordinator',
            `pi 主退出但子agent仍在干,延迟 teardown sid=${sessionId} children=${term.children.size}`,
          );
        } else {
          // 无子在干:与旧行为一致,立即 teardown(isPiAgent=false + 回退字节流)。
          this.teardownAgentBinding(sessionId, term);
        }
        break;
      }

      case 'agent_working': {
        // pi 重新开始工作 → 主槽置 working。聚合原已 working(后台子 agent 在干)时
        // getter.onWorking / notifyAgentWorking 幂等(状态不变,hasUnviewedWork 已清)。
        const getter = this.agentGetters.get(sessionId);
        // 无 agent 绑定的游离事件(teardown 后迟到的子事件 / 乱序):没有可驱动的
        // 状态机,忽略。不存在「Marina 重启后 pi 还在」(session 不持久化,重启即
        // 全灭),所以游离 working 一定是噪声。
        if (!getter) break;
        this.ensureTerm(sessionId).mainWorking = true;
        getter.onWorking();
        this.hooks?.notifyAgentWorking(sessionId);
        break;
      }

      case 'agent_settled': {
        // 主 agent 这轮完成。聚合语义下「真收工」= 主 + 所有子都空闲:后台子 agent
        // 仍在干时抑制 settled(状态保持 active;hasUnviewedWork 等子排空时由下降沿
        // 统一标 —— 「干完了用户还没看」以整棵 pi 进程树为准)。
        const getter = this.agentGetters.get(sessionId);
        if (!getter) break; // 游离 settled(同上),忽略 —— 防止幻影 hasUnviewedWork
        const term = this.ensureTerm(sessionId);
        term.mainWorking = false;
        if (this.isAggregateWorking(term)) {
          logger.info('PiSessionCoordinator', `agent_settled 抑制(子agent仍在干) sid=${sessionId}`);
          break;
        }
        getter.onSettled();
        this.hooks?.notifyAgentSettled(sessionId);
        break;
      }

      case 'name_changed':
        // pi 对话名 → 终端显示名(受 manuallyRenamed 保护)。
        this.hooks?.onPiName(sessionId, payload.name ?? null);
        break;
    }
  }

  /**
   * 子 agent 事件处理(主锁拦截后不再纯丢弃,v0.3.4)。
   *
   * 职责边界:workspace/名字污染照旧拦截(ADR-028 不动摇)——本方法**只**维护
   * 聚合工作状态:注册子会话、跟踪 working/settled、状态变更后经
   * applyAggregateTransition 在边沿上通知(上升沿 → active + 清未看标记;下降沿
   * → idle + 标 hasUnviewedWork,与主 agent 收工同一路径)。
   *
   * 注册时机:子 session_start 被主锁拦截即注册(working=false);若 agent_working
   * 先于注册到达(启动竞态),兜底注册。session_shutdown 注销。未注册子的
   * settled/shutdown(已回收/乱序)无状态可改,忽略(防重复下降沿)。
   *
   * @param term 聚合状态;guard 分支保证非 null(锁存在 ⟹ session_start 已建)。
   */
  private handleChildAgentEvent(
    sessionId: string,
    payload: {
      piSessionId: string;
      event:
        | 'session_start'
        | 'session_shutdown'
        | 'agent_working'
        | 'agent_settled'
        | 'name_changed';
      parentSessionFile?: string | null;
    },
    term: TerminalPiAggregate | undefined,
  ): void {
    if (!term) return; // 防御:主从未 start(理论不可达,guard 已保证)
    const piSid = payload.piSessionId;
    switch (payload.event) {
      case 'session_start': {
        // 注册/刷新(子进程重试同一会话文件 → 同 piSid 重复 start,重置即可)。
        term.children.set(piSid, { working: false, lastEventAt: this.now() });
        this.ensureSweeper();
        logger.info(
          'PiSessionCoordinator',
          `subagent 注册 sid=${sessionId} piSid=${piSid} parent=${payload.parentSessionFile ?? '-'} children=${term.children.size}`,
        );
        break;
      }
      case 'agent_working': {
        const wasWorking = this.isAggregateWorking(term);
        const child = term.children.get(piSid);
        if (child) {
          child.working = true;
          child.lastEventAt = this.now();
        } else {
          // 竞态兜底:working 先于 start 到达(或 start 被 Marina 重启吞掉)。
          // 不注册则该子的 settled 也无从跟踪,状态机会漏边沿。
          term.children.set(piSid, { working: true, lastEventAt: this.now() });
          this.ensureSweeper();
        }
        this.applyAggregateTransition(sessionId, term, wasWorking);
        break;
      }
      case 'agent_settled': {
        const child = term.children.get(piSid);
        if (!child) break; // 未注册 → 无状态可改
        const wasWorking = this.isAggregateWorking(term);
        child.working = false;
        child.lastEventAt = this.now();
        this.applyAggregateTransition(sessionId, term, wasWorking);
        break;
      }
      case 'session_shutdown': {
        // 子进程退出。working=true 的子被 kill(没发 settled)也可能构成下降沿。
        if (!term.children.has(piSid)) break;
        const wasWorking = this.isAggregateWorking(term);
        term.children.delete(piSid);
        this.applyAggregateTransition(sessionId, term, wasWorking);
        this.maybeStopSweeper();
        break;
      }
      case 'name_changed': {
        // 语义仍忽略(ADR-028:name_changed 会把终端名改成 "subagent-worker-xxx"),
        // 但它证明子进程活着 → 刷新 lastEventAt,免费的泄露防护 keep-alive。
        const child = term.children.get(piSid);
        if (child) child.lastEventAt = this.now();
        break;
      }
    }
  }

  /**
   * 聚合状态边沿通知。只在 wasWorking ≠ 当前聚合值时触发(调用方传**变更前**的值):
   *
   * - 上升沿(idle → working):典型 = 主 agent 收工后,后台子 agent 开干。getter
   *   置 working(缺失则重建 bind,见 ensureAgentBound)+ notifyAgentWorking
   *   (active + 清 hasUnviewedWork)。
   * - 下降沿(working → idle):主 + 所有子全空闲 = 「真收工」。getter settled +
   *   notifyAgentSettled(idle + 标 hasUnviewedWork,SessionManager 侧判断用户
   *   是否在看)。若主 pi 已退(mainGone)→ 补做延迟 teardown。
   *
   * 无边沿时静默(幂等):重复 settled/working 不重复 notify,避免把用户已查看
   * 后清掉的 hasUnviewedWork 又被乱序事件标回去。
   */
  private applyAggregateTransition(
    sessionId: string,
    term: TerminalPiAggregate,
    wasWorking: boolean,
  ): void {
    const nowWorking = this.isAggregateWorking(term);
    if (nowWorking === wasWorking) return;
    if (nowWorking) {
      // getter 理论必在:child 分支可达 ⟹ 注册过子 ⟹ 主 session_start 建过 getter
      // 且尚未 teardown(teardown 会把聚合条目一起删)。防御性 ?. 不破坏该假设。
      this.agentGetters.get(sessionId)?.onWorking();
      this.hooks?.notifyAgentWorking(sessionId);
      logger.info('PiSessionCoordinator', `聚合开干(子agent拉起) sid=${sessionId}`);
      return;
    }
    const getter = this.agentGetters.get(sessionId);
    getter?.onSettled();
    this.hooks?.notifyAgentSettled(sessionId);
    logger.info('PiSessionCoordinator', `聚合收工(主+子全空闲) sid=${sessionId}`);
    if (term.mainGone) this.teardownAgentBinding(sessionId, term);
  }

  /** 聚合 working = 主 agent 在干 ∨ 任一注册子 agent 在干。 */
  private isAggregateWorking(term: TerminalPiAggregate): boolean {
    return term.mainWorking || [...term.children.values()].some((c) => c.working);
  }

  /** 懒创建终端聚合条目(session_start / 主 agent 事件路径共用)。 */
  private ensureTerm(sessionId: string): TerminalPiAggregate {
    let term = this.aggregates.get(sessionId);
    if (!term) {
      term = { mainWorking: false, mainGone: false, children: new Map() };
      this.aggregates.set(sessionId, term);
    }
    return term;
  }

  /**
   * 确保该终端有已 bind 的 AgentStateGetter(仅 session_start 主路径使用)。
   * 已存在(旧主延迟 teardown 保留的)则复用;不存在则创建并 bind —— seedWorking
   * 时先 onWorking 再 bind,让 bindAgent 的立即 applyState 拉到 active,不闪 idle。
   */
  private ensureAgentBound(sessionId: string, seedWorking: boolean): AgentStateGetter {
    let getter = this.agentGetters.get(sessionId);
    if (getter) {
      if (seedWorking) getter.onWorking();
      return getter;
    }
    getter = new AgentStateGetter();
    if (seedWorking) getter.onWorking();
    this.agentGetters.set(sessionId, getter);
    this.hooks?.bindAgent(sessionId, getter);
    return getter;
  }

  /**
   * agent 绑定 teardown:unbind(回退字节流 getter)+ 撤 pi 身份 + 删 getter +
   * 删聚合条目。主 shutdown 无 working 子时立即调;延迟场景(mainGone)在子排空
   * 的下降沿补调。幂等:重复调无害(hooks 对不存在的 managed 是 no-op)。
   */
  private teardownAgentBinding(sessionId: string, term: TerminalPiAggregate): void {
    this.hooks?.unbindAgent(sessionId);
    this.hooks?.onPiAgentChanged(sessionId, false);
    this.agentGetters.delete(sessionId);
    this.aggregates.delete(sessionId);
    if (term.children.size > 0) {
      // children 非空仍 teardown(仅当无 working 子):注册表随条目一起清,
      // 之后这些子的零星事件回到「currentMain===null 且未注册」的既有路径(无害)。
      logger.info(
        'PiSessionCoordinator',
        `teardown 丢弃 idle 子注册 sid=${sessionId} children=${term.children.size}`,
      );
    }
    this.maybeStopSweeper();
  }

  /**
   * 泄露回收:移除超过 CHILD_STALE_MS 无任何事件的注册子(hard-kill 的子进程
   * 不会发 session_shutdown,不回收则终端永远卡「工作中」)。若移除的是最后一个
   * working 子且主不在干 → 构成聚合下降沿(走 settled + 可能的延迟 teardown)。
   * 误判代价有限:活着的子被误回收后,它后续的 settled/shutdown 按未注册忽略,
   * 不会二次翻转状态;唯一影响是 turn 极长时状态提前 idle。
   *
   * 生产由 sweeper 定时调;测试直接调(注入时钟控时间)。
   */
  sweepStaleChildren(): void {
    for (const [sessionId, term] of this.aggregates) {
      for (const [piSid, child] of term.children) {
        if (this.now() - child.lastEventAt < CHILD_STALE_MS) continue;
        const wasWorking = this.isAggregateWorking(term);
        term.children.delete(piSid);
        logger.info(
          'PiSessionCoordinator',
          `subagent 泄露回收 sid=${sessionId} piSid=${piSid}(${Math.round(CHILD_STALE_MS / 60000)}min 无事件)`,
        );
        this.applyAggregateTransition(sessionId, term, wasWorking);
      }
      // 防御:mainGone 且子已清空但没经过下降沿(最后一个子是 idle 移除)→ 补
      // teardown。正常路径在 applyAggregateTransition 的下降沿里已处理。
      if (term.mainGone && term.children.size === 0 && this.aggregates.has(sessionId)) {
        this.teardownAgentBinding(sessionId, term);
      }
    }
    this.maybeStopSweeper();
  }

  /** 懒启动泄露回收 sweeper(首个子注册时;unref 不阻塞进程退出/测试)。 */
  private ensureSweeper(): void {
    if (this.sweeperTimer) return;
    this.sweeperTimer = setInterval(() => this.sweepStaleChildren(), CHILD_SWEEP_INTERVAL_MS);
    this.sweeperTimer.unref?.();
  }

  /** 全部终端无注册子 → 停 sweeper(零空闲开销)。 */
  private maybeStopSweeper(): void {
    if (!this.sweeperTimer) return;
    const anyChildren = [...this.aggregates.values()].some((t) => t.children.size > 0);
    if (!anyChildren) {
      clearInterval(this.sweeperTimer);
      this.sweeperTimer = null;
    }
  }

  /**
   * pi 对话切换的核心。workspace 绑定**存在 pi 对话的 entry 里**(bridge 用
   * pi.appendEntry 存,跨重启稳定),Marina 侧不再持有 piSession→workspace 映射。
   *
   * 分支语义(方案 20260817 裁决 1/3):
   * - new → 建新空 workspace(新对话,无继承)。
   * - fork → 建新 workspace 并**继承**父对话当前 workspace 的快照副本
   *   (copy-on-fork;继承源优先 parentBinding,缺失时回退 payload 带的分支内
   *   继承 entry)。fork 拿到副本后与父互不共享。
   * - resume/startup → branch-aware 绑定还活着就切回(同文件共享,裁决 3);
   *   但若该绑定是从父文件**继承来的**(payload == parentBinding,fork/clone
   *   首次激活且从未有自己的 workspace),则不共享父的,而是克隆一份并返回新 id
   *   (bridge 落 entry 后,后续 resume 都回到自己的);被回收/缺失则新建。
   * - reload / 未知 reason / 开关关闭 → 不动 workspace。
   *
   * 之前用 piSessionId 当内存映射 key,但实测 pi resume 同一对话时 piSessionId 会变
   * (见日志:019fefb0→010fdf2e),映射永远 miss → 每次都建新空 workspace → 文件不恢复。
   * 改用 pi 对话 entry 存绑定,resume 天然恢复(跟对话文件走)。
   */
  private async handlePiConversationSwitch(
    sessionId: string,
    reason: string,
    settings: Settings['piIntegration'],
    payloadWorkspaceId: string | null,
    parentBinding: string | null,
  ): Promise<{ workspaceId?: string } | void> {
    if (!this.workspaceCoordinator.isWorkspaceEnabled()) return; // 未启用 workspace(测试/禁用)→ 跳过
    const wantsNew = reason === 'new' || reason === 'fork';
    const wantsResume = reason === 'resume' || reason === 'startup';

    if (wantsNew && settings.enabled && settings.newConversationCreatesWorkspace) {
      // fork 继承(裁决 1):优先父对话的**当前** workspace(parentBinding,bridge
      // 从父文件尾读出);缺失(旧版 bridge/父文件已清理)时回退 payload 里的
      // 继承 entry(fork 复制路径上的绑定,fork 点位置的父 workspace)。两者都
      // 指向不存在的 workspace 时退化为空新建。
      // /new 不继承:新对话就是全新开始。
      const inheritFrom = reason === 'fork' ? (parentBinding ?? payloadWorkspaceId) : null;
      return await this.createAndBindPiWorkspace(sessionId, inheritFrom);
    }
    if (wantsResume && settings.enabled && settings.resumeSwitchesWorkspace) {
      if (payloadWorkspaceId && this.workspaceCoordinator.getRecord(payloadWorkspaceId)) {
        // fork 血统首次激活(裁决 3:fork 不共享父 workspace):branch-aware 绑定
        // 与父的当前绑定相等 → 这个 entry 是从父文件复制来的继承品,不是本对话
        // 自己的(自己的 entry 在首次激活时就会被新 id 覆盖更新)。克隆一份作为
        // 起点,返回新 id 让 bridge 落 entry —— 之后 resume 走上面的普通切回分支。
        // 典型触发:CLI `pi --fork`(冷启动 reason=startup)/ fork 时 Marina 离线
        // 没能返回新 id / newConversationCreatesWorkspace 关闭期间的 fork。
        if (parentBinding && payloadWorkspaceId === parentBinding) {
          const cloned = await this.createAndBindPiWorkspace(sessionId, payloadWorkspaceId);
          logger.info(
            'PiSessionCoordinator',
            `pi-resume: fork-lineage first activation, clone instead of share ` +
              `sid=${sessionId} src=${payloadWorkspaceId} → ${cloned?.workspaceId ?? '?'}`,
          );
          return cloned;
        }
        // 普通切回:同文件=同对话=同 workspace(裁决 3 允许共享;跨终端同文件
        // 的 release 安全由 SessionWorkspaceCoordinator 的最后占用者防护保证)。
        this.workspaceCoordinator.switchSessionToWorkspace(sessionId, payloadWorkspaceId);
        // 触发文件面板重建 + 快照恢复(否则 resume 后原打开文件不恢复)。
        this.workspaceSwitchedNotify?.(sessionId);
        logger.info(
          'PiSessionCoordinator',
          `pi-resume: switch back sid=${sessionId} ws=${payloadWorkspaceId}`,
        );
        return; // 切回已有,不返回 workspaceId(bridge entry 里已有同一个)
      }
      // 被回收 / 首访 / entry 缺失 → 新建,返回新 id 让 bridge 更新 entry。
      return await this.createAndBindPiWorkspace(sessionId, null);
    }
    // reload / 未知 reason / 开关关闭 → 不动 workspace。
  }

  /**
   * 建/克隆 workspace 并绑定到 session(pi 对话)。返回 workspaceId——交回 bridge
   * 存进 pi 对话的 marina-workspace entry,下次 resume 同一对话时 bridge 读出带上 → 切回。
   *
   * @param inheritFrom 非空且仍存在 → cloneWorkspace(继承快照+文件副本,裁决 1);
   *   否则 create() 新建空 workspace。继承源不存在(刚被回收)→ 退化为空新建,
   *   不算错误(fork 降级可用)。
   * workspace 创建失败不阻塞 pi;返回 void(bridge 不更新 entry,下次 resume 会重试)。
   */
  private async createAndBindPiWorkspace(
    sessionId: string,
    inheritFrom: string | null = null,
  ): Promise<{ workspaceId: string } | void> {
    if (!this.workspaceCoordinator.isWorkspaceEnabled()) return;
    try {
      let created: { workspaceId: string; dir: string };
      if (inheritFrom && this.workspaceCoordinator.getRecord(inheritFrom)) {
        created = await this.workspaceCoordinator.cloneForSession(sessionId, inheritFrom);
        logger.info(
          'PiSessionCoordinator',
          `pi-fork-workspace: sid=${sessionId} inherited from=${inheritFrom} ws=${created.workspaceId}`,
        );
      } else {
        created = await this.workspaceCoordinator.createForSession(sessionId);
        if (inheritFrom) {
          logger.info(
            'PiSessionCoordinator',
            `pi-fork-workspace: inherit source ${inheritFrom} gone, fallback to empty ws=${created.workspaceId}`,
          );
        } else {
          logger.info(
            'PiSessionCoordinator',
            `pi-new-workspace: sid=${sessionId} ws=${created.workspaceId}`,
          );
        }
      }
      // 触发文件面板重建(新 workspace 无快照 → onWorkspaceSwitched 清空 files,
      // 符合 new 语义;克隆时从新 ws 的快照恢复,符合 fork 继承语义)。
      this.workspaceSwitchedNotify?.(sessionId);
      return { workspaceId: created.workspaceId };
    } catch (err) {
      logger.warn(
        'PiSessionCoordinator',
        `pi workspace create failed sid=${sessionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * session 销毁时清理 pi 映射(终端关了，里面的 pi 对话也不复存在)。
   * SessionManager.destroySession 同步调用。
   */
  onSessionDestroyed(sessionId: string): void {
    this.sessionToPiSession.delete(sessionId);
    // subagent 聚合:终端没了,主/子跟踪一起清(子进程可能还活着,但它们的事件
    // 已无处可去 —— lookup.hasSession 会静默丢弃)。
    this.aggregates.delete(sessionId);
    this.maybeStopSweeper();
    // 终端状态分层:防御性 unbind(session 销毁时若 pi 仍在 bind,回退 getter)。
    // SessionManager.destroySession 会清 managed,unbind 无害(session 不存在则 no-op)。
    if (this.agentGetters.has(sessionId)) {
      this.hooks?.unbindAgent(sessionId);
      this.agentGetters.delete(sessionId);
    }
  }
}
