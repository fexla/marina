/**
 * @file session-workspace-coordinator.ts
 * @purpose M2:管理 session 的临时展示工作区(workspace)资源,从 SessionManager 拆出。
 *
 * @关键设计:
 * - workspace 是三方共用的独立资源:CLI/IPC workspace 命令(经 ipc.ts /
 *   file-panel HTTP)、createSession(为每个新 session 建初始 workspace)、
 *   pi 对话切换(PiSessionCoordinator)都消费它。它不专属 pi,也不属于
 *   session 状态机 → 独立成 coordinator。
 * - 持有 workspaceManager(SessionWorkspaceManager 实例)与 sessionId→workspaceId
 *   绑定映射(运行时真值源,v0.3.3 ADR-024)。workspaceId 与 sessionId 解耦。
 * - 沿用 FilePanelService 的 attachSessionLookup 模式:查 session 的 pathId 走
 *   SessionLookup 接口(SessionManager 实现),不持具体类,破循环依赖 + 可测。
 *
 * @对应文档章节:软件定义书 workspace 相关 + v0.3.3 ADR-024
 *
 * @不要在这里做的事:
 * - 不要碰 session 状态机(piWorking/isPiAgent/idle 检测是 SessionManager 职责)
 * - 不要持久化 workspace(内存态,走 SessionWorkspaceManager 的 retentionDays 回收)
 */
import { logger } from '../logger';
import type { SessionWorkspaceSource } from '../session-manager';
import type { SessionLookup } from './session-lookup';

/**
 * M2:workspace 资源协调器。从 SessionManager 的 workspace 方法群(L1593-1762)
 * 与 createSession/destroySession 内联逻辑搬移,语义/返回/错误码保持等价。
 */
export class SessionWorkspaceCoordinator {
  /** v0.3.3 ADR-024:sessionId → workspaceId 的运行时绑定映射(真值源)。 */
  private readonly sessionWorkspaceBindings = new Map<string, string>();
  private lookup: SessionLookup | null = null;

  constructor(private readonly workspaceManager: SessionWorkspaceSource | null) {}

  /** 注入 SessionManager 的只读 session 查询(破循环依赖)。 */
  attachSessionLookup(lookup: SessionLookup): void {
    this.lookup = lookup;
  }

  /** workspace 功能是否启用(未注入 SessionWorkspaceManager → 禁用)。 */
  isWorkspaceEnabled(): boolean {
    return this.workspaceManager !== null;
  }

  // ──────────────────────────────────────────────────────────────
  // 读取
  // ──────────────────────────────────────────────────────────────

  /**
   * 当前 session 绑定的 workspaceId（运行时真值）。CLI `workspace`/`bind` 等
   * 按 TERMINAL_ID → session → 此方法 → workspaceId → dir。无 workspace 返回 null。
   */
  getWorkspaceIdForSession(sessionId: string): string | null {
    return this.sessionWorkspaceBindings.get(sessionId) ?? null;
  }

  /**
   * 当前 session 绑定的 workspace 绝对路径。供 FileTreeService/GitService 的
   * workspaceLookup 代理调用（sessionId → workspaceId → dir）。
   */
  getWorkspacePathForSession(sessionId: string): string | null {
    const wsId = this.sessionWorkspaceBindings.get(sessionId);
    if (!wsId || !this.workspaceManager) return null;
    return this.workspaceManager.getPathForWorkspace(wsId);
  }

  // ──────────────────────────────────────────────────────────────
  // 生命周期(createSession / destroySession 委托)
  // ──────────────────────────────────────────────────────────────

  /**
   * 为 session 创建初始 workspace 并记录绑定(v0.3.3 ADR-024)。
   * createSession 在 PTY spawn 前调用;返回 {workspaceId, dir},env.MARINA_WORKSPACE
   * 由 createSession 设置(coordinator 不碰 env)。
   *
   * @throws code='WorkspaceCreateFailed' 创建失败(数据目录权限/磁盘满/UUID 冲突)
   */
  async createForSession(sessionId: string): Promise<{ workspaceId: string; dir: string }> {
    if (!this.workspaceManager) {
      throw Object.assign(new Error('workspace manager not configured'), {
        code: 'WorkspaceNotConfigured',
      });
    }
    try {
      const created = await this.workspaceManager.create();
      this.sessionWorkspaceBindings.set(sessionId, created.workspaceId);
      return created;
    } catch (err) {
      throw Object.assign(
        new Error(
          `无法为 sessionId="${sessionId}" 创建临时展示工作区。` +
            `可能原因: (1) Marina 数据目录无写入权限; (2) 磁盘空间不足; ` +
            `(3) 上次异常退出遗留目录与 UUID 冲突。原始错误: ${
              err instanceof Error ? err.message : String(err)
            }`,
        ),
        { code: 'WorkspaceCreateFailed' },
      );
    }
  }

  /**
   * 为 session 克隆一个已有 workspace 作为它的新 workspace(pi /fork 继承,方案
   * 20260817 裁决 1):复制源的面板快照 + 受管文件,绑定到新 id。fork 后的新对话
   * 拿到父对话 workspace 的完整副本,但不与父共享(裁决 3)。
   *
   * 源 workspace 不存在(刚被回收)时抛 WorkspaceNotFound——调用方
   * (PiSessionCoordinator)应捕获并退回 createForSession(空 workspace)。
   */
  async cloneForSession(
    sessionId: string,
    sourceWorkspaceId: string,
  ): Promise<{ workspaceId: string; dir: string }> {
    if (!this.workspaceManager) {
      throw Object.assign(new Error('workspace manager not configured'), {
        code: 'WorkspaceNotConfigured',
      });
    }
    const created = await this.workspaceManager.cloneWorkspace(sourceWorkspaceId);
    this.sessionWorkspaceBindings.set(sessionId, created.workspaceId);
    return created;
  }

  /**
   * PTY spawn 失败时撤销刚创建的 workspace(不保留,等保留期没意义)。
   * 内部 try/catch,失败只 warn(不阻塞主流程)。
   */
  async discardForSession(sessionId: string): Promise<void> {
    const wsId = this.sessionWorkspaceBindings.get(sessionId) ?? null;
    if (!wsId || !this.workspaceManager) return;
    try {
      await this.workspaceManager.discard(wsId);
      this.sessionWorkspaceBindings.delete(sessionId);
    } catch (cleanupErr) {
      logger.warn(
        'SessionWorkspaceCoordinator',
        `workspace discard failed after spawn failure sid=${sessionId}: ${
          cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
        }`,
      );
    }
  }

  /**
   * session 销毁时回收其 workspace(release,按保留期回收)并删绑定映射。
   * release 是同步 void,失败只 warn(SessionManager.destroySession 同步调用)。
   */
  onSessionDestroyed(sessionId: string): void {
    const wsId = this.sessionWorkspaceBindings.get(sessionId) ?? null;
    try {
      if (wsId) {
        // 共享防护(方案 20260817 裁决 3):同一对话文件可以在多个 Marina 终端里
        // 打开(跨终端 /resume 同一 id),此时多个 session 绑同一 workspace——
        // 「同文件=同对话=同 workspace」允许共享。但任一终端关闭就 release 会把
        // 还在被占用的工作区推进回收倒计时,保留期一到另一终端的面板内容蒸发。
        // 因此只有**最后一个**占用者销毁时才 release。
        const stillInUse = [...this.sessionWorkspaceBindings.entries()].some(
          ([sid, boundWs]) => sid !== sessionId && boundWs === wsId,
        );
        if (stillInUse) {
          logger.info(
            'SessionWorkspaceCoordinator',
            `skip release: ws=${wsId} still bound by other session(s) (destroying sid=${sessionId})`,
          );
        } else {
          this.workspaceManager?.release(wsId);
        }
      }
    } catch (err) {
      // 工作区元数据失败不能阻塞主 session 销毁；manager 会在下次启动根据
      // manifest 重试回收，日志保留足够诊断信息。
      logger.warn(
        'SessionWorkspaceCoordinator',
        `workspace release failed sid=${sessionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    this.sessionWorkspaceBindings.delete(sessionId);
  }

  // ──────────────────────────────────────────────────────────────
  // workspace 编排(CLI/IPC workspace 命令)
  // ──────────────────────────────────────────────────────────────

  /**
   * v0.3.3 ADR-024:bind = upsert(orchestration 层)。sessionId→pathScope(=pathId),
   * currentWorkspaceId 从绑定映射取。成功后更新绑定(切到目标 workspace)。
   * @throws 'SessionNotFound' / workspace manager 的 InvalidName|NameConflict|WorkspaceNotFound。
   */
  async bindWorkspace(
    sessionId: string,
    name: string,
    forceNew: boolean,
  ): Promise<
    | { kind: 'created'; workspaceId: string; dir: string }
    | { kind: 'switched'; workspaceId: string; dir: string; createdAt: number; fileCount: number }
  > {
    if (!this.workspaceManager) {
      throw Object.assign(new Error('workspace manager not configured'), {
        code: 'WorkspaceNotConfigured',
      });
    }
    const pathId = this.lookup?.getSessionPathId(sessionId) ?? null;
    if (pathId === null) {
      throw Object.assign(new Error(`session not found: ${sessionId}`), {
        code: 'SessionNotFound',
      });
    }
    const currentWsId = this.sessionWorkspaceBindings.get(sessionId);
    if (!currentWsId) {
      throw Object.assign(new Error(`session has no workspace binding: ${sessionId}`), {
        code: 'WorkspaceNotFound',
      });
    }
    // pathScope = session.pathId(本地目录或 ssh:profileId:path)。
    const result = await this.workspaceManager.bind(currentWsId, name, pathId, forceNew);
    if (result.kind === 'switched') {
      // 切到已存在 workspace:旧临时 release(若是未命名临时)、更新绑定。
      const oldRecord = this.workspaceManager.getRecord(currentWsId);
      if (oldRecord && !oldRecord.pinned) {
        this.workspaceManager.release(currentWsId);
      }
      this.sessionWorkspaceBindings.set(sessionId, result.workspaceId);
    }
    return result;
  }

  /** 列当前 session 的 pathScope 下的命名 workspace。 */
  async listWorkspaces(sessionId: string): Promise<
    Array<{
      workspaceId: string;
      name: string | null;
      createdAt: number;
      closedAt: number | null;
      pinned: boolean;
      pathScope: string | null;
      fileCount: number;
    }>
  > {
    if (!this.workspaceManager) return [];
    const pathId = this.lookup?.getSessionPathId(sessionId) ?? null;
    if (pathId === null) {
      throw Object.assign(new Error(`session not found: ${sessionId}`), {
        code: 'SessionNotFound',
      });
    }
    return this.workspaceManager.list(pathId);
  }

  /**
   * new:把当前 session 切到一个新空临时 workspace(原命名 pinned 不动)。
   * 更新绑定;旧临时(未命名)release。
   */
  async switchToNewWorkspace(sessionId: string): Promise<{ workspaceId: string; dir: string }> {
    if (!this.workspaceManager) {
      throw Object.assign(new Error('workspace manager not configured'), {
        code: 'WorkspaceNotConfigured',
      });
    }
    const oldWsId = this.sessionWorkspaceBindings.get(sessionId);
    const created = await this.workspaceManager.switchToNew();
    // 旧临时(未命名)release;命名 pinned 的不删(等 unpin/到期)。
    if (oldWsId) {
      const oldRecord = this.workspaceManager.getRecord(oldWsId);
      if (oldRecord && !oldRecord.pinned) {
        this.workspaceManager.release(oldWsId);
      }
    }
    this.sessionWorkspaceBindings.set(sessionId, created.workspaceId);
    return created;
  }

  /**
   * unpin:剥 name+pinned。name 省略=当前绑定 workspace。occupied 由当前 session
   * 是否仍绑定该 workspace 判断。成功后若是当前 workspace,不解除占用(unpin 只退回收态)。
   */
  async unpinWorkspace(
    sessionId: string,
    name: string | null,
  ): Promise<{ workspaceId: string } | null> {
    if (!this.workspaceManager) return null;
    const pathId = this.lookup?.getSessionPathId(sessionId) ?? null;
    if (pathId === null) {
      throw Object.assign(new Error(`session not found: ${sessionId}`), {
        code: 'SessionNotFound',
      });
    }
    let wsId: string | null;
    if (name) {
      wsId = this.workspaceManager.resolveByName(name.trim(), pathId);
    } else {
      wsId = this.sessionWorkspaceBindings.get(sessionId) ?? null;
    }
    if (!wsId) return null;
    // occupied = 当前 session 是否仍绑定此 workspace。
    const occupied = this.sessionWorkspaceBindings.get(sessionId) === wsId;
    await this.workspaceManager.unpin(wsId, occupied);
    return { workspaceId: wsId };
  }

  /** 读当前 session 绑定 workspace 的文件面板快照(bind 恢复用)。 */
  async readWorkspaceSnapshot(sessionId: string): Promise<unknown> {
    if (!this.workspaceManager) return null;
    const wsId = this.sessionWorkspaceBindings.get(sessionId);
    if (!wsId) return null;
    return this.workspaceManager.readSnapshot(wsId);
  }

  /** 写当前 session 绑定 workspace 的文件面板快照(renderer debounce 触发)。 */
  async writeWorkspaceSnapshot(sessionId: string, data: unknown): Promise<void> {
    if (!this.workspaceManager) return;
    const wsId = this.sessionWorkspaceBindings.get(sessionId);
    if (!wsId) return;
    await this.workspaceManager.writeSnapshot(wsId, data);
  }

  // ──────────────────────────────────────────────────────────────
  // PiSessionCoordinator 专用(pi 对话切换的 workspace 操作)
  // ──────────────────────────────────────────────────────────────

  /** 取 workspace record(判断 pinned / 是否还被 manifest 持有)。pi resume 判定用。 */
  getRecord(workspaceId: string): {
    name: string | null;
    createdAt: number;
    closedAt: number | null;
    pinned: boolean;
    pathScope: string | null;
  } | null {
    return this.workspaceManager?.getRecord(workspaceId) ?? null;
  }

  /** 把 session 的 workspace 绑定指向已存在的 workspace(pi resume 切回)。 */
  switchSessionToWorkspace(sessionId: string, workspaceId: string): void {
    this.sessionWorkspaceBindings.set(sessionId, workspaceId);
  }
}
