/**
 * @file src/main/sudo-password-store.ts
 * @purpose v0.3.3 远程 sudo:main 进程内存态 sudo 密码托管(按 SSH profile 隔离)。
 *
 * @关键设计:
 * - **纯内存**。Map<sshProfileId, string>。绝不落盘、绝不序列化、绝不进日志 / 性能
 *   报告 / IPC event payload / process.env(附录 H 隐私红线)。app 退出即释放。
 * - **按 SSH profile 隔离**。sudo 密码属远程用户(host+username),同服务器共享,换
 *   服务器重录。profileId 来自 pathId(`ssh:<profileId>:<remotePath>`),与
 *   SshProfileManager 的 id 一致。
 * - **密码永不出 main**。本模块只提供 get(给 CodeBlockRunner 喂 stdin)/ set(经
 *   masked 输入)/ clear / has(只回 boolean)。对外事件 SUDO_PASSWORD_STATE 也只
 *   带 has:boolean,不带密码。
 * - **信任边界 = main 进程**。与既有 SSH profile 密码(safeStorage 落盘,main 按需
 *   解密)、daemon token(同)同一界。进程被攻破则全泄,sudo 密码不比它们更敏感;
 *   内存内再加密(XOR+随机 key)是表演,v1 不做。
 *
 * @对应文档章节: docs/方案-命令面板远程sudo-20260807.md §5;AGENTS.md 附录 H。
 *
 * @不要在这里做的事:
 * - 不落盘(无 safeStorage、无 JSON store)。
 * - 不把密码写进 logger / performanceDiagnostics / 任何 event payload。
 * - 不把密码放 process.env(子进程经 /proc/PID/environ 可读;喂 stdin 更安全)。
 * - 不回传密码给 renderer(has/state 只回 boolean)。
 */
import { EventEmitter } from 'node:events';

const MODULE = 'SudoPasswordStore';

export interface SudoPasswordStoreEvents {
  /** 密码状态变化(录入/清除)。payload = { sshProfileId, has },不含密码。 */
  changed: (sshProfileId: string, has: boolean) => void;
}

/**
 * sudo 密码内存仓库。EventEmitter 发 'changed' 让 ipc 层广播 SUDO_PASSWORD_STATE。
 *
 * 生命周期:构造后随 main 进程存活;app 退出随内存释放。clearAll() 用于「全部忘记」
 * (如安全敏感场景一键清空)。clear() 单条清除(「忘记密码」按钮)。
 *
 * 密码字符串一旦 clear/overwrite,无法主动 shred(JS string 不可变 + GC 时机不可控);
 * 这是 JS 信任边界下的固有局限,与「不落盘」相比是可接受的残余风险(同 SSH 密码明文
 * 在 main 内存驻留的现状)。
 */
export class SudoPasswordStore extends EventEmitter {
  private readonly passwords = new Map<string, string>();

  /** 该 profile 是否已存密码。renderer 据此显示 🔑 按钮态。 */
  has(sshProfileId: string): boolean {
    return this.passwords.has(sshProfileId);
  }

  /**
   * 取该 profile 的明文密码(给 CodeBlockRunner 喂 ssh stdin → 远程 sudo -S)。
   * 未存返回 null(调用方据此抛 SudoPasswordRequired,让 renderer 弹输入框)。
   */
  get(sshProfileId: string): string | null {
    return this.passwords.get(sshProfileId) ?? null;
  }

  /**
   * 录入密码(经 masked 输入传入)。空串视为清除(与「不存空密码」一致)。
   * emit changed 让 ipc 广播 SUDO_PASSWORD_STATE(has=true)。
   */
  set(sshProfileId: string, password: string): void {
    if (!sshProfileId) {
      throw new Error(`[${MODULE}] set: sshProfileId 不能为空`);
    }
    if (typeof password !== 'string' || password.length === 0) {
      // 空密码无意义,等价清除(避免存空串被 has() 误判为已录入)。
      this.clear(sshProfileId);
      return;
    }
    const had = this.passwords.has(sshProfileId);
    this.passwords.set(sshProfileId, password);
    if (!had) {
      // 只在 has 态翻转时广播;重复录入同 profile 不重复广播(避免 renderer 抖动)。
      this.emit('changed', sshProfileId, true);
    }
  }

  /**
   * 清除该 profile 的密码(「忘记密码」按钮 / 密码判错时主动失效)。
   * emit changed(has=false)。
   */
  clear(sshProfileId: string): void {
    if (this.passwords.delete(sshProfileId)) {
      this.emit('changed', sshProfileId, false);
    }
  }

  /** 一键清空全部(安全敏感场景 / 测试清理)。逐条 emit changed 让 UI 同步。 */
  clearAll(): void {
    for (const id of [...this.passwords.keys()]) {
      this.passwords.delete(id);
      this.emit('changed', id, false);
    }
  }

  /** 已存密码的 profile 数(诊断 / 测试用)。 */
  size(): number {
    return this.passwords.size;
  }
}
