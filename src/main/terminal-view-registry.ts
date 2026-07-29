/**
 * @file terminal-view-registry.ts
 * @purpose 管理每个 session 唯一的「已挂载终端视图」租约,让非 owner 的隐藏
 * TerminalView 继续接收 PTY 输出,从而在同窗口切换时保留真实 xterm viewport。
 *
 * @关键设计:
 * - interactive owner 仍由 SessionManager 管理,本类绝不授予输入/resize 权限。
 * - 每个 session 最多一个 view lease。attach 会替换旧 lease并返回旧视图是否
 *   连续收到过全部输出；false 时 renderer 必须丢弃缓存并走一次完整 replay。
 * - owner 与 view 是同一 client 时只发一次。owner 是别的 client 时只发 owner,
 *   并把旧 view 标记 discontinuous,避免以后静默复用缺字节的缓存。
 * - owner=null 时,连续 view 是唯一输出目标；无 view 仍由 main headless 保存真值。
 *
 * @对应文档章节:软件定义书.md 8.4(owner 单焦点语义)。本类只是只读视图缓存,
 * 不改变「一个 session 最多一个 interactive owner」。
 *
 * @不要在这里做的事:
 * - 不要保存 PTY 内容/路径/session 标题；这里只存低体积 client/view 标识。
 * - 不要广播 PTY；单 session 单 view lease 是内存/带宽硬上限。
 * - 不要把 view 当 owner 放行输入、resize、文件或 Git 命令。
 */

interface TerminalViewLease {
  clientId: string;
  viewId: string;
  /** false 表示该视图错过了至少一块 owner 输出,再次 attach 必须 replay。 */
  continuous: boolean;
}

export interface AttachTerminalViewResult {
  /** true:同一 view lease 从未漏输出,可直接复用原 xterm/viewport。 */
  continuous: boolean;
}

export class TerminalViewRegistry {
  private readonly leases = new Map<string, TerminalViewLease>();

  /**
   * 挂载/激活一个终端视图。调用方必须先验证 client 是该 session 当前 owner。
   * 同一 session/client/viewId 重挂返回此前连续性；替换租约返回 false。
   */
  attach(sessionId: string, clientId: string, viewId: string): AttachTerminalViewResult {
    const previous = this.leases.get(sessionId);
    const continuous =
      previous?.clientId === clientId &&
      previous.viewId === viewId &&
      previous.continuous;
    this.leases.set(sessionId, { clientId, viewId, continuous: true });
    return { continuous: continuous === true };
  }

  /** 仅匹配当前 viewId 的 detach 才生效,防止旧组件 cleanup 删掉新租约。 */
  detach(sessionId: string, clientId: string, viewId: string): void {
    const current = this.leases.get(sessionId);
    if (current?.clientId === clientId && current.viewId === viewId) {
      this.leases.delete(sessionId);
    }
  }

  /** session 销毁时清租约。 */
  removeSession(sessionId: string): void {
    this.leases.delete(sessionId);
  }

  /** 本地窗口关闭 / 远程 client 断线时清其全部租约。 */
  removeClient(clientId: string): void {
    for (const [sessionId, lease] of this.leases) {
      if (lease.clientId === clientId) this.leases.delete(sessionId);
    }
  }

  /**
   * 决定一块 PTY 输出的唯一 renderer 目标。
   * - 有 owner:永远发 owner；若 view 属于别人,标记其已断流。
   * - 无 owner:只发仍连续的 parked view。
   */
  resolveOutputTarget(sessionId: string, ownerClientId: string | null): string | null {
    const lease = this.leases.get(sessionId);
    if (ownerClientId) {
      if (lease && lease.clientId !== ownerClientId) lease.continuous = false;
      return ownerClientId;
    }
    return lease?.continuous ? lease.clientId : null;
  }

  /** 测试/诊断用固定数值；不暴露 sessionId/clientId。 */
  count(): number {
    return this.leases.size;
  }
}
