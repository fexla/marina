import { logger } from '../logger';

/**
 * @file runtime-lifecycle-coordinator.ts
 * @purpose 统一编排 session 生命周期事件(ownerChanged / exited / destroyed)到各 service
 *   的资源清理,把原来散在 wireEventBroadcasts(IPC 层)和 SessionManager.destroySession 的
 *   清理调用集中到一个独立、可单测的模块。
 *
 * @关键设计:
 * - 独立订阅 SessionManager 事件,不依赖 IPC 已安装 —— wireEventBroadcasts 只保留广播
 *   (broadcastEvent),清理职责完全转移到这里。这样 session 生命周期的资源回收可脱离 IPC
 *   上下文单独测试。
 * - 注册式扩展:各 service 通过 register({ onOwnerChanged?, onExited?, onDestroyed? })
 *   声明自己的清理回调。M2 拆出的 SessionWorkspaceCoordinator / PiSessionCoordinator 同样
 *   注册,自动加入清理链 —— 新增 service 不用改 coordinator 核心,只在 index.ts 注册。
 * - 单 handler 抛错被 try/catch 隔离 + log,不影响其他 handler(各 service 清理相互独立)。
 *
 * @对应文档:架构整改 M1(见 docs/架构整改-M1M2M3整体设计.md 决策 2)。
 */

const MODULE = 'RuntimeLifecycleCoordinator';

/**
 * 各 service 注册的清理回调(均可选 —— 只实现自己关心的 lifecycle event)。
 */
export interface SessionLifecycleHandlers {
  /** owner 切换:清旧 demand,新 owner 按绝对 UI 状态重新上报 HOT/WARM。 */
  onOwnerChanged?: (sessionId: string) => void;
  /** PTY 进程退出:停 watcher / 轮询(exited 快照仍保留,只是不再后台扫描)。 */
  onExited?: (sessionId: string) => void;
  /** session 真销毁:释放 watcher / timer / view lease / workspace 等全部资源。 */
  onDestroyed?: (sessionId: string) => void;
}

/**
 * SessionManager 事件源的最小接口(只为解耦 + 可单测)。SessionManager 天然满足。
 */
export interface SessionLifecycleEventSource {
  on(
    event: 'sessionOwnerChanged' | 'sessionExited' | 'sessionDestroyed',
    listener: (e: { sessionId: string }) => void,
  ): unknown;
}

export class RuntimeLifecycleCoordinator {
  private readonly handlers: SessionLifecycleHandlers[] = [];

  constructor(sessionManager: SessionLifecycleEventSource) {
    // 三个 lifecycle event 各自分发到注册的 handler。emit 是同步的(EventEmitter),
    // SessionManager.destroySession emit sessionDestroyed 时这里立即处理,可靠。
    sessionManager.on('sessionOwnerChanged', (e) => this.dispatch('onOwnerChanged', e.sessionId));
    sessionManager.on('sessionExited', (e) => this.dispatch('onExited', e.sessionId));
    sessionManager.on('sessionDestroyed', (e) => this.dispatch('onDestroyed', e.sessionId));
    logger.info(MODULE, 'initialized, subscribed to session lifecycle events');
  }

  /**
   * 注册一组清理回调。推荐在 index.ts 组装期调用,把所有 service 的清理集中声明。
   * 顺序即注册顺序(与原 wireEventBroadcasts 内联调用顺序保持一致)。
   */
  register(handlers: SessionLifecycleHandlers): void {
    this.handlers.push(handlers);
  }

  private dispatch(kind: keyof SessionLifecycleHandlers, sessionId: string): void {
    for (const h of this.handlers) {
      const fn = h[kind];
      if (!fn) continue;
      try {
        fn(sessionId);
      } catch (err) {
        // 单个 service 清理失败不阻断其他 service(它们相互独立),只记 error 日志
        // 便于排查。原 wireEventBroadcasts 内联时一个抛错会中断后续清理 + 广播,
        // 这里隔离后广播(wireEventBroadcasts)和其它清理都不受影响。
        logger.error(
          MODULE,
          `${String(kind)} handler failed sid=${sessionId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
}
