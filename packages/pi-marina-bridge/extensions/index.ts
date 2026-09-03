/**
 * @file packages/pi-marina-bridge/extensions/index.ts
 * @purpose 把 pi 的对话/工作生命周期事件转发给 Marina main，让 Marina 据此
 *   (a) 自动绑定 pi 对话 ↔ workspace（切对话即切 workspace）；
 *   (b) 精准化侧栏指示灯（pi 工作完成但未查看 → 警告色）；
 *   (c) 把 pi 对话名反映到 Marina 终端显示名。
 *
 * @设计(ADR-028)：本 extension 是**哑转发器**。
 *   - 检测注入的 Marina env（MARINA_SERVICE / MARINA_TOKEN / TERMINAL_ID）；
 *   - 订阅 pi 事件 → POST 到 MARINA_SERVICE 的 /pi-session-event；
 *   - **不读 Marina 设置、不做 workspace 决策**——决策全在 Marina 侧
 *     （settings.piIntegration 控制做不做）。
 *   - 非 Marina 环境（env 缺失）→ 完全 no-op，可安全全局安装。
 *
 * @事件映射：
 *   pi session_start   {reason}     → event=session_start   (workspace 绑定/切换 + 身份声明)
 *   pi session_shutdown{reason}     → event=session_shutdown (reason=quit → 清 pi 身份)
 *   pi agent_start                   → event=agent_working   (清"未查看"标记)
 *   pi agent_settled                 → event=agent_settled   (设"未查看"标记)
 *   pi session_before_compact        → event=agent_working   (压缩=工作,覆盖可能的 settled)
 *   pi session_compact {willRetry}   → event=agent_settled   (仅 willRetry=false;overflow retry 保持 working)
 *   pi session_info_changed {name}   → event=name_changed    (更新终端显示名)
 *
 * @fork/子会话适配(方案-pibridge-fork与子会话适配-20260817,开发者裁决):
 *   - 绑定读法 = 当前分支(leaf→root)最近 entry,纯函数拆到 ./binding.ts。
 *   - session_start 额外上报亲缘:parentSessionFile(header.parentSession,fork/clone
 *     /子会话文件的父文件路径)+ parentBinding(父文件最后追加的绑定 = 父对话
 *     当前 workspace)。Marina 用它做 fork 继承与「继承绑定不共享」判定。
 *   - 不监听 session_tree(裁决 2:/tree 不处理,同文件=同对话=同 workspace)。
 *
 * @不在这里做的事：
 *   - 不直接操作 Marina workspace（Marina 的 SessionManager 决策）。
 *   - 不阻塞 pi：除 session_start(需要响应里的 workspaceId)外,事件入后台
 *     promise 链保序发送,handler 立刻返回(pi 的 ExtensionRunner 串行 await
 *     每个 handler,见 enqueuePost 注释——曾因 await POST 导致 Marina 卡时 pi 连锁卡死)。
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  MARINA_WORKSPACE_CUSTOM_TYPE,
  readBranchWorkspaceId,
  readLastWorkspaceBinding,
} from './binding';

/** Marina 注入终端子进程的 env 名（见 Marina session-manager.ts env 注入）。 */
const ENV_SERVICE = 'MARINA_SERVICE';
const ENV_TOKEN = 'MARINA_TOKEN';
const ENV_TERMINAL = 'TERMINAL_ID';

/** HTTP 端点路径（见 Marina file-panel-service.ts handle()）。 */
const ENDPOINT_PATH = '/pi-session-event';

// MARINA_WORKSPACE_CUSTOM_TYPE 常量与绑定读取纯函数已拆到 ./binding.ts(可单测,
// 被 Marina 仓的 src/main/pi-bridge-binding.test.ts 相对路径 import)。

/** 转发的事件类型（与 Marina PiEventOps.applyPiSessionEvent 对齐）。 */
type PiBridgeEvent =
  | 'session_start'
  | 'session_shutdown'
  | 'agent_working'
  | 'agent_settled'
  | 'name_changed';

/**
 * 读 Marina env。三者齐全才算"在 Marina 终端里"。
 * MARINA_SERVICE 是 HTTP base URL（如 http://127.0.0.1:19999）。
 */
function readMarinaEnv(): { baseUrl: string; token: string; terminal: string } | null {
  const baseUrl = process.env[ENV_SERVICE];
  const token = process.env[ENV_TOKEN];
  const terminal = process.env[ENV_TERMINAL];
  if (!baseUrl || !token || !terminal) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ''), token, terminal };
}

/**
 * 单次 fire-and-forget POST。失败只 log，不抛——pi 对话流转不能被 Marina 的
 * workspace/状态操作阻塞，Marina 处理失败也不该让 pi 卡住（ADR-028 fire-and-forget）。
 */
/** 单次 POST。返回解析后的响应 body(session_start 用它拿 workspaceId),失败返 null。 */
async function postEvent(
  env: { baseUrl: string; token: string; terminal: string },
  piSessionId: string,
  event: PiBridgeEvent,
  extra: {
    reason?: string;
    name?: string | null;
    workspaceId?: string | null;
    /** fork/子会话亲缘(方案 20260817):父会话文件路径 + 父对话当前 workspace。 */
    parentSessionFile?: string | null;
    parentBinding?: string | null;
  } = {},
): Promise<{ workspaceId?: string } | null> {
  const url = `${env.baseUrl}${ENDPOINT_PATH}`;
  const body: Record<string, unknown> = { terminal: env.terminal, piSessionId, event };
  if (extra.reason !== undefined) body.reason = extra.reason;
  if (extra.name !== undefined) body.name = extra.name;
  if (extra.workspaceId !== undefined && extra.workspaceId !== null)
    body.workspaceId = extra.workspaceId;
  if (extra.parentSessionFile !== undefined && extra.parentSessionFile !== null)
    body.parentSessionFile = extra.parentSessionFile;
  if (extra.parentBinding !== undefined && extra.parentBinding !== null)
    body.parentBinding = extra.parentBinding;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.token}`,
      },
      body: JSON.stringify(body),
      // loopback 请求不需要 keepalive；给个合理超时避免悬挂（Marina 不通时快速失败）。
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) {
      console.warn(
        `[marina-bridge] /pi-session-event ${event} → HTTP ${resp.status} ${resp.statusText}`,
      );
      return null;
    }
    return (await resp.json().catch(() => null)) as { workspaceId?: string } | null;
  } catch (err) {
    // 离线 / Marina 未运行 / 端点不存在(旧版 Marina)→ 静默降级,pi 继续正常工作。
    // 超时单独标注:AbortSignal.timeout 只是客户端不再等响应,Marina 忙时请求
    // 通常仍已送达并被处理(实测 2026-09-03:main 被 workspace 清理风暴拖慢,
    // agent_settled 3s 超时,但事件在 +3.5s 后照常到达并生效)——避免误判为"事件丢了"。
    const isTimeout = err instanceof Error && err.name === 'TimeoutError';
    console.warn(
      `[marina-bridge] failed to post ${event}${
        isTimeout ? ' (timeout — Marina busy; event usually still delivered)' : ''
      }: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

export default function (pi: ExtensionAPI): void {
  const env = readMarinaEnv();
  if (!env) {
    // 非 Marina 环境：完全 no-op。不订阅任何事件，零开销。
    // 这是 package 可安全全局安装的关键——在普通终端里跑 pi 不会产生任何副作用。
    return;
  }

  /**
   * 后台发送队列:promise 链串行化,保证事件按发生顺序送达 Marina(working 必须先于
   * settled,否则 Marina 侧栏状态会错)。
   *
   * 为什么不能直接 await postEvent(pi 卡死修复,2026-09-03):pi 的
   * ExtensionRunner.emit 对每个 handler 是串行 await(见 pi 源码
   * dist/core/extensions/runner.js)。handler 里 await 一个可能 3s 超时的 HTTP
   * POST,会把 pi 自己的主流程一起拖住——agent_settled 后常紧跟
   * session_before_compact + session_compact(2~3 个事件串行),Marina 卡顿时
   * pi 的收尾路径连续阻塞 10s+,TUI 完全无响应,只能退出重开(用户实测)。
   * 入队后 handler 立刻返回,pi 永不被 Marina 的快慢拖累。
   *
   * session_start 是例外:它需要响应里的 workspaceId(appendEntry 存回对话),
   * 必须等结果;且它发生在 pi 启动/resume 时,用户对这几秒的敏感度低。
   */
  let postQueue: Promise<unknown> = Promise.resolve();
  /** 入队发送(保序、不阻塞 pi handler)。postEvent 内部 catch 一切错误,链不会 reject。 */
  function enqueuePost(
    piSessionId: string,
    event: PiBridgeEvent,
    extra: Parameters<typeof postEvent>[3],
  ): void {
    postQueue = postQueue.then(() => postEvent(env, piSessionId, event, extra));
  }

  pi.on('session_start', async (event, ctx) => {
    const piSessionId = ctx.sessionManager.getSessionId();
    if (!piSessionId) return; // 内存对话（无文件）→ 无法稳定标识，跳过。
    // 当前分支(leaf→root)最近的绑定 entry(branch-aware,见 binding.ts;旧的
    // 全文件 first-match 会永久命中最老的死绑定 → 每次 resume 新建空 workspace)。
    const knownWorkspaceId = readBranchWorkspaceId(ctx.sessionManager);
    // 亲缘(裁决 1/3):header.parentSession = 本文件来源(fork/clone 复制 /
    // pi-subagents 子会话)。读父文件最后追加的绑定 = 父对话当前 workspace。
    // 失败(父文件已清理/旧版 pi 无 getHeader)→ null,Marina 按无亲缘处理。
    let parentSessionFile: string | null = null;
    let parentBinding: string | null = null;
    try {
      const header = ctx.sessionManager.getHeader?.() as
        | { parentSession?: unknown }
        | undefined;
      if (header && typeof header.parentSession === 'string' && header.parentSession) {
        parentSessionFile = header.parentSession;
        parentBinding = await readLastWorkspaceBinding(parentSessionFile);
      }
    } catch (err) {
      console.warn(
        `[marina-bridge] read parent lineage failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const resp = await postEvent(env, piSessionId, 'session_start', {
      reason: event.reason,
      workspaceId: knownWorkspaceId,
      parentSessionFile,
      parentBinding,
    });
    // Marina 新建了 workspace(返回 workspaceId)→ 存进对话 entry,下次 resume 能切回。
    // 切回已有(resp 无 workspaceId)不重写(entry 里已是同一个)。
    if (resp?.workspaceId && resp.workspaceId !== knownWorkspaceId) {
      try {
        pi.appendEntry(MARINA_WORKSPACE_CUSTOM_TYPE, { workspaceId: resp.workspaceId });
      } catch (err) {
        console.warn(
          `[marina-bridge] appendEntry(${MARINA_WORKSPACE_CUSTOM_TYPE}) failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  });

  pi.on('session_shutdown', async (event, ctx) => {
    const piSessionId = ctx.sessionManager.getSessionId();
    if (!piSessionId) return;
    enqueuePost(piSessionId, 'session_shutdown', { reason: event.reason });
  });

  // agent_start：pi 开始处理用户请求 → 通知 Marina "working"（清旧的"未查看"标记）。
  pi.on('agent_start', async (_event, ctx) => {
    const piSessionId = ctx.sessionManager.getSessionId();
    if (!piSessionId) return;
    enqueuePost(piSessionId, 'agent_working', {});
  });

  // agent_settled：pi 这轮彻底完成（无自动重试/压缩/续跑）→ 通知 Marina "settled"。
  // 用 settled 而非 agent_end：后者之后可能还有自动重试，settled 才是真"干完了"。
  pi.on('agent_settled', async (_event, ctx) => {
    const piSessionId = ctx.sessionManager.getSessionId();
    if (!piSessionId) return;
    enqueuePost(piSessionId, 'agent_settled', {});
  });

  // session_before_compact：pi 开始压缩上下文（threshold/overflow/manual）→ 通知
  // Marina "working"。压缩是实打实的工作，且 threshold 压缩常发生在 agent_settled
  // 之后——若不监听，压缩全程 Marina 停在 settled(idle)，与用户体感「还在工作」矛盾。
  // 复用 agent_working 信号：Marina 只需 working/settled 二态，不需区分压缩。
  pi.on('session_before_compact', async (_event, ctx) => {
    const piSessionId = ctx.sessionManager.getSessionId();
    if (!piSessionId) return;
    enqueuePost(piSessionId, 'agent_working', {});
  });

  // session_compact：压缩完成。overflow 压缩 willRetry=true（被中断的 turn 要重试）
  // → 不发，保持 working，等随后的 agent_start(retry)；threshold/manual willRetry=false
  // （无后续工作）→ settled，压缩完若没新工作则 idle。
  pi.on('session_compact', async (event, ctx) => {
    const piSessionId = ctx.sessionManager.getSessionId();
    if (!piSessionId) return;
    if (event.willRetry) return; // overflow 会 retry(agent_start),保持 working
    enqueuePost(piSessionId, 'agent_settled', {});
  });

  // 对话名变更 → 反映到 Marina 终端显示名（受 manuallyRenamed 保护，由 Marina 决定）。
  pi.on('session_info_changed', async (event, ctx) => {
    const piSessionId = ctx.sessionManager.getSessionId();
    if (!piSessionId) return;
    enqueuePost(piSessionId, 'name_changed', { name: event.name ?? null });
  });
}
