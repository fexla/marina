/**
 * @file src/renderer/hooks/claim-gate.ts
 * @purpose 消除「renderer 乐观接管 orphan session」与「main 端 owner 关系异步更新」之间的 race。
 *
 * @背景(为什么需要这个 gate):
 *   renderer 在接管一个 orphan(无主)session 时做**乐观更新**:本地先 dispatch
 *   owner-changed + select-session(让终端视图立刻切换、不闪烁),再异步发
 *   SESSION_CLAIM。SESSION_CLAIM 的 main 端 handler 先同步提交 owner
 *   (claimOwner),再返回(REPLAY-1 后已不再序列化 scrollback,只剩 O(1) lastSeq)。
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
 *     (已持有 / 常规切换),立即返回 { ok: true }。
 *
 * @生命周期:
 *   - claim 完成(resolve 或 reject)后从 Map 清除。waitForClaim **返回结果对象**:
 *     resolve → { ok: true };reject → { ok: false }。面板据此决定是否发请求,
 *     claim 失败时中止(不发 IPC),避免命中 NotOwner 后还要渲染错误态。
 *   - 用「同序号校验」删除:只有当前 inflight 仍是自己时才删,避免一个迟到的
 *     旧 claim completion 误删掉更新的 in-flight claim。
 *
 * @为什么从「吞 reject 成 void」改成「返回 {ok}」(2026-08-01):
 *   旧契约把 claim 失败也 resolve 成 void,面板 await 后无条件发请求,于是失败的
 *   claim 照样触发 NotOwner 错误 —— 截图里的「文件导航不可用」就是这么来的。
 *   失败的语义必须能让面板感知,否则 gate 只挡住了「成功但未就位」的 race,没挡住
 *   「失败后还硬发」的 race。各调用方(MainPane / Sidebar / useCloseSession / App)
 *   仍各自保留对**原始** claim 的 catch/rollback,gate 的 {ok} 只给面板用。
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
 * claim 的最终结果,供面板决定是否发数据请求。
 * - `{ ok: true }`:claim 成功(或本就无 in-flight claim,即 session 已被本窗口持有),
 *   面板可以安全发请求。
 * - `{ ok: false }`:claim 失败(SessionAlreadyOwned / SessionNotFound / 传输 reject 等),
 *   面板**必须中止**请求 —— 失败的 claim 不会让 main 端 owner 就位,硬发只会命中
 *   NotOwner 然后渲染错误态。失败后果由各调用方的 rollback + 组件卸载处理。
 */
export interface ClaimOutcome {
  ok: boolean;
}

/**
 * per-session 的 in-flight claim promise。值**永不 reject**(registerClaim 内部
 * 已把 reject 转成 `{ ok: false }`),所以 waitForClaim 的调用方无需 try/catch,
 * 只需检查返回的 `outcome.ok`。
 */
const inflight = new Map<string, Promise<ClaimOutcome>>();

/**
 * 把一个 SESSION_CLAIM 的 promise 登记进 gate。
 *
 * @param sessionId 被接管的 session
 * @param claim invoke(SESSION_CLAIM) 返回的 promise
 * @returns 包装后的 promise(永不 reject,失败转成 { ok: false }),供 waitForClaim 等待
 */
function registerClaim(sessionId: string, claim: Promise<unknown>): Promise<ClaimOutcome> {
  // 把 resolve / reject 都转成 ClaimOutcome,永不 reject。
  // 调用方(MainPane / Sidebar / App / useCloseSession)各自保留对**原始** claim
  // 的 catch/rollback,这里不影响它们 — 它们仍能拿到原始 rejection。
  const settled: Promise<ClaimOutcome> = claim.then(
    () => ({ ok: true }),
    () => ({ ok: false }),
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
 * 若该 session 正在被 claim,等到 claim 完成;否则立即返回 `{ ok: true }`。
 *
 * 面板首次数据请求(FileTreePanel / GitPanel / useGitPollingDemand)在发 IPC 前
 * 调一次,保证 main 端 owner 已就位,消除 NotOwner race。返回 `outcome.ok` 区分
 * 成败:失败时面板应中止请求,不要发注定 NotOwner 的 IPC。
 *
 * 常规切换(已持有 / mine variant)无 in-flight claim,返回 `{ ok: true }`。
 */
export function waitForClaim(sessionId: string): Promise<ClaimOutcome> {
  return inflight.get(sessionId) ?? Promise.resolve({ ok: true });
}

/**
 * 统一的 orphan 接管入口:invoke SESSION_CLAIM 并登记进 gate。
 *
 * 所有接管 orphan session 的路径(MainPane tab 点击 / Sidebar 点击 /
 * useCloseSession 续看 / App 启动恢复)都应改用本函数,而不是直接
 * window.api.invoke(SESSION_CLAIM),这样 gate 覆盖全部接管路径,不会漏。
 *
 * 返回**原始** invoke promise(保留 rejection),调用方据此做各自的
 * then(乐观更新补发)/ catch(rollback)。gate 的等待用的是内部转成 {ok} 的副本,
 * 两者互不影响。
 */
export function claimSession(sessionId: string): Promise<ClaimSessionResponse> {
  const claim = window.api.invoke(
    COMMAND_CHANNELS.SESSION_CLAIM,
    { sessionId },
  );
  // 登记进 gate(用原始 claim,registerClaim 内部再包一层转 {ok} 的副本)。
  registerClaim(sessionId, claim);
  return claim;
}

/** @internal 测试专用:清空 in-flight gate。生产代码不要调。 */
export function _resetClaimGateForTest(): void {
  inflight.clear();
}
