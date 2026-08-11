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
 *   「主 pi 对话」,subagent 等临时子 session 的事件全部忽略,不污染主终端。
 * - 依赖:SessionWorkspaceCoordinator(做 workspace 操作)+ PiSessionHooks(状态副作用)
 *   + PiSettingsSource(读 settings.piIntegration)。全程不碰 ManagedSession。
 *
 * @对应文档章节:v0.3.3 ADR-028 + M2 设计(pi 业务层独立)
 *
 * @不要在这里做的事:
 * - 不要碰 ManagedSession / markActive / emitStateChanged(那是 SessionManager 的 hooks)
 * - 不要持久化映射(内存态,workspace 走 retentionDays 回收)
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
  /** pi 对话名 → 终端显示名(受 manuallyRenamed 保护)。 */
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

  constructor(
    private readonly workspaceCoordinator: SessionWorkspaceCoordinator,
    private readonly settingsManager: PiSettingsSource,
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
       */
      workspaceId?: string | null;
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
    // 其事件全部忽略 —— 子 agent 是临时辅助,不该污染主终端的 workspace/名字/状态
    // (实测:子 agent 的 name_changed 会把终端名改成 "subagent-worker-xxx")。
    //
    // 规则(纯靠 piSessionId 比对,不依赖任何第三方 subagent package 的 env 约定):
    //   - currentMain===null(初始 / 旧主已 session_shutdown):接受,session_start 据此
    //     绑定新主;零星的其它事件也接受(启动竞态,无害)。
    //   - 否则 piSessionId!==currentMain:子 agent 事件,忽略。
    //   - 合法主切换(/new /resume /fork /重启 pi)前 pi 必先发 session_shutdown 清空
    //     主绑定,随后的 session_start 才能绑定新主 → 「关闭 pi 或 /new 后新 pi 正常工作」。
    const currentMainPiSid = this.sessionToPiSession.get(sessionId) ?? null;
    if (currentMainPiSid !== null && payload.piSessionId !== currentMainPiSid) {
      logger.info(
        'PiSessionCoordinator',
        `pi-event 忽略(子agent) sid=${sessionId} piSid=${payload.piSessionId} main=${currentMainPiSid} event=${payload.event}`,
      );
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
        // 终端状态分层:创建 AgentStateGetter 并 bind —— stateGetter 换成 agent
        // getter,字节流检测旁路。pi 的 working/settled 经 getter 权威驱动状态。
        const agentGetter = new AgentStateGetter();
        this.agentGetters.set(sessionId, agentGetter);
        this.hooks?.bindAgent(sessionId, agentGetter);
        // 返回 { workspaceId }：新建的 workspace id 交回 bridge 存进对话 entry
        // (appendEntry),下次 resume 同一对话时 bridge 读出随事件带上 → Marina 切回。
        return await this.handlePiConversationSwitch(
          sessionId,
          payload.reason ?? 'startup',
          settings,
          payload.workspaceId ?? null,
        );
      }

      case 'session_shutdown':
        // pi 进程要退出了。workspace 按现有生命周期(Marina session 销毁时 release)；
        // 这里不提前 release(与销毁路径竞争)。
        this.sessionToPiSession.delete(sessionId);
        this.hooks?.onPiAgentChanged(sessionId, false);
        // 终端状态分层:unbind agent getter → stateGetter 回退到 byteStream fallback,
        // 字节流检测恢复(接管终态判断)。
        this.hooks?.unbindAgent(sessionId);
        this.agentGetters.delete(sessionId);
        break;

      case 'agent_working': {
        // pi 重新开始工作 → agent getter 标记 working(getter 权威),
        // SessionManager 清 hasUnviewedWork + applyState(getter → active)。
        const getter = this.agentGetters.get(sessionId);
        getter?.onWorking();
        this.hooks?.notifyAgentWorking(sessionId);
        break;
      }

      case 'agent_settled': {
        // pi 这轮完成 → agent getter 标记 settled(getter → idle,立即,agent 权威),
        // SessionManager applyState + 标 hasUnviewedWork(未看)。
        const getter = this.agentGetters.get(sessionId);
        getter?.onSettled();
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
   * pi 对话切换的核心。workspace 绑定**存在 pi 对话的 entry 里**(bridge 用
   * pi.appendEntry 存,跨重启稳定),Marina 侧不再持有 piSession→workspace 映射。
   *
   * - new/fork → 建新 workspace,返回 workspaceId(交回 bridge 存进 entry)。
   * - resume/startup → bridge 从 entry 读出 workspaceId 随事件带上(payloadWorkspaceId):
   *   还活着(getRecord≠null)就切回 + 重建面板;被回收/首访/缺失则新建,返回新 id。
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
  ): Promise<{ workspaceId?: string } | void> {
    if (!this.workspaceCoordinator.isWorkspaceEnabled()) return; // 未启用 workspace(测试/禁用)→ 跳过
    const wantsNew = reason === 'new' || reason === 'fork';
    const wantsResume = reason === 'resume' || reason === 'startup';

    if (wantsNew && settings.enabled && settings.newConversationCreatesWorkspace) {
      return await this.createAndBindPiWorkspace(sessionId);
    }
    if (wantsResume && settings.enabled && settings.resumeSwitchesWorkspace) {
      // bridge 从对话 entry 恢复的 workspaceId。还活着就切回;被回收/首访/缺失则新建。
      if (payloadWorkspaceId && this.workspaceCoordinator.getRecord(payloadWorkspaceId)) {
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
      return await this.createAndBindPiWorkspace(sessionId);
    }
    // reload / 未知 reason / 开关关闭 → 不动 workspace。
  }

  /**
   * 建新 workspace 并绑定到 session(pi 对话)。返回 workspaceId——交回 bridge 存进
   * pi 对话的 marina-workspace entry,下次 resume 同一对话时 bridge 读出带上 → 切回。
   * workspace 创建失败不阻塞 pi;返回 void(bridge 不更新 entry,下次 resume 会重试)。
   */
  private async createAndBindPiWorkspace(
    sessionId: string,
  ): Promise<{ workspaceId: string } | void> {
    if (!this.workspaceCoordinator.isWorkspaceEnabled()) return;
    try {
      const created = await this.workspaceCoordinator.createForSession(sessionId);
      // 触发文件面板重建(新 workspace 无快照 → onWorkspaceSwitched 清空 files,
      // 符合 new 语义)。
      this.workspaceSwitchedNotify?.(sessionId);
      logger.info(
        'PiSessionCoordinator',
        `pi-new-workspace: sid=${sessionId} ws=${created.workspaceId}`,
      );
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
    // 终端状态分层:防御性 unbind(session 销毁时若 pi 仍在 bind,回退 getter)。
    // SessionManager.destroySession 会清 managed,unbind 无害(session 不存在则 no-op)。
    if (this.agentGetters.has(sessionId)) {
      this.hooks?.unbindAgent(sessionId);
      this.agentGetters.delete(sessionId);
    }
  }
}
