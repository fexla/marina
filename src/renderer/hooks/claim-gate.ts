/**
 * @file src/renderer/hooks/claim-gate.ts
 * @purpose 消除「renderer 乐观接管 orphan session」与「main 端 owner 关系异步更新」之间的 race。
 *
 * @背景(为什么需要这个 gate):
 *   renderer 在接管一个 orphan(无主)session 时做**乐观更新**:本地先 dispatch
 *   owner-changed + select-session(让终端视图立刻切换、不闪烁),再异步发
 *   SESSION_CLAIM。但 SESSION_CLAIM 的 main 端 handler 内部要 await
 *   getScrollbackForReplay()(drain parser + 序列化 scrollback),非 ms 级,
 *   所以故意 fire-and-forget 并行化以保切换即时性。
 *
 *   副作用(本 gate 修复的 bug):面板(FileTreePanel / GitPanel / GitPollingDemand)
 *   在 select 触发的 React 重挂里**立刻**发数据请求,而此刻 main 端
 *   session.ownerWindowId 还是 null(claim 还在 IPC 往返中) → 命中
 *   requireOwner 的 `ownerWindowId !== requesterId` → 抛 NotOwner →
 *   用户看到「文件导航不可用 / Git 变更不可用」。
 *
 *   关键:getScrollbackForReplay 免 owner 校验,所以**终端视图切换不受影响**,
 *   只有面板的数据请求会 race。因此修复只 gate 面板请求,不动终端即时性。
 *
 * @机制:
 *   - 任何发起 SESSION_CLAIM 的路径都应改用 claimSession():它 invoke 的同时把
 *     该 promise 登记进本模块的 inflight Map。
 *   - 面板首次数据请求前 await waitForClaim(sessionId):若该 session 正在被 claim,
 *     等 claim 完成(main 端 owner 已就位)再发,从根消除 race;若不在 claim 中
 *     (已持有 / 别人持有 / 常规切换),立即返回。
 *
 * @生命周期:
 *   - claim 完成(resolve 或 reject)后从 Map 清除。claim 失败也算 settled:
 *     面板 await 不会抛(gate 内部吞掉 reject);失败后果由各调用方的
 *     rollback(把本地 owner 改回) + 组件卸载处理。
 *   - 用「同序号校验」删除:只有当前 inflight 仍是自己时才删,避免一个迟到的
 *     旧 claim completion 误删掉更新的 in-flight claim。
 *
 * @对应文档:软件定义书.md §8.4 owner 模型;ADR-005(一窗口一 owner);
 *   docs/tmp/notowner-fix-plan-2026-07-24.md(方案 C)。
 *
 * @不要在这里做的事:
 *   - 不要在这里改 owner 语义(接管仍由 SESSION_CLAIM IPC 驱动,本文件只 gate 时序)。
 *   - 不要把 inflight 塞进 store(claim 是瞬时态,进 store 会污染 reducer/reselect,
 *     且面板用模块级 await 更自然)。
 */
import { COMMAND_CHANNELS, type ClaimSessionResponse } from '@shared/protocol';

/**
 * per-session 的 in-flight claim promise。值**永不 reject**(registerClaim 内部
 * 已把 reject 转成 resolve),所以 waitForClaim 的调用方无需 try/catch。
 * claim 失败时该 promise 也会 resolve,面板随后发的请求会自然拿到 NotOwner
 * (但此时 rollback 通常已卸载面板,请求不会真正发出)。
 */
const inflight = new Map<string, Promise<void>>();

/**
 * 把一个 SESSION_CLAIM 的 promise 登记进 gate。
 *
 * @param sessionId 被接管的 session
 * @param claim invoke(SESSION_CLAIM) 返回的 promise
 * @returns 包装后的 promise(永不 reject),供 waitForClaim 等待
 */
function registerClaim(sessionId: string, claim: Promise<unknown>): Promise<void> {
  // 吞掉 reject:gate 只代表「main 端 owner 关系已 settle」,不论成败。
  // 调用方(MainPane / Sidebar / App / useCloseSession)各自保留对**原始** claim
  // 的 catch/rollback,这里不影响它们 — 它们仍能拿到原始 rejection。
  const settled: Promise<void> = claim.then(
    () => undefined,
    () => undefined,
  );
  inflight.set(sessionId, settled);
  // 只有当前 inflight 仍是自己时才删,避免迟到的旧 completion 覆盖新 claim。
  settled.finally(() => {
    if (inflight.get(sessionId) === settled) {
      inflight.delete(sessionId);
    }
  });
  return settled;
}

/**
 * 若该 session 正在被 claim,等到 claim 完成;否则立即返回。
 *
 * 面板首次数据请求(FileTreePanel / GitPanel / useGitPollingDemand)在发 IPC 前
 * 调一次,保证 main 端 owner 已就位,消除 NotOwner race。
 */
export function waitForClaim(sessionId: string): Promise<void> {
  return inflight.get(sessionId) ?? Promise.resolve();
}

/**
 * 统一的 orphan 接管入口:invoke SESSION_CLAIM 并登记进 gate。
 *
 * 所有接管 orphan session 的路径(MainPane tab 点击 / Sidebar 点击 /
 * useCloseSession 续看 / App 启动恢复)都应改用本函数,而不是直接
 * window.api.invoke(SESSION_CLAIM),这样 gate 覆盖全部接管路径,不会漏。
 *
 * 返回**原始** invoke promise(保留 rejection),调用方据此做各自的
 * then(乐观更新补发)/ catch(rollback)。gate 的等待用的是内部吞 reject 的副本。
 */
export function claimSession(sessionId: string): Promise<ClaimSessionResponse> {
  const claim = window.api.invoke<{ sessionId: string }, ClaimSessionResponse>(
    COMMAND_CHANNELS.SESSION_CLAIM,
    { sessionId },
  );
  // 登记进 gate(用原始 claim,registerClaim 内部再包一层吞 reject 的副本)。
  registerClaim(sessionId, claim);
  return claim;
}

/** @internal 测试专用:清空 in-flight gate。生产代码不要调。 */
export function _resetClaimGateForTest(): void {
  inflight.clear();
}
