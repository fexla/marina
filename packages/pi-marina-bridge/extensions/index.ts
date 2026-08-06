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
 *   pi session_info_changed {name}   → event=name_changed    (更新终端显示名)
 *
 * @不在这里做的事：
 *   - 不直接操作 Marina workspace（Marina 的 SessionManager 决策）。
 *   - 不缓存/聚合事件（fire-and-forget，每事件独立 POST）。
 *   - 不阻塞 pi：POST 失败只 log，不抛。
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** Marina 注入终端子进程的 env 名（见 Marina session-manager.ts env 注入）。 */
const ENV_SERVICE = 'MARINA_SERVICE';
const ENV_TOKEN = 'MARINA_TOKEN';
const ENV_TERMINAL = 'TERMINAL_ID';

/** HTTP 端点路径（见 Marina file-panel-service.ts handle()）。 */
const ENDPOINT_PATH = '/pi-session-event';

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
async function postEvent(
  env: { baseUrl: string; token: string; terminal: string },
  piSessionId: string,
  event: PiBridgeEvent,
  extra: { reason?: string; name?: string | null } = {},
): Promise<void> {
  const url = `${env.baseUrl}${ENDPOINT_PATH}`;
  const body: Record<string, unknown> = { terminal: env.terminal, piSessionId, event };
  if (extra.reason !== undefined) body.reason = extra.reason;
  if (extra.name !== undefined) body.name = extra.name;
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
    }
  } catch (err) {
    // 离线 / Marina 未运行 / 端点不存在（旧版 Marina）→ 静默降级，pi 继续正常工作。
    console.warn(
      `[marina-bridge] failed to post ${event}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export default function (pi: ExtensionAPI): void {
  const env = readMarinaEnv();
  if (!env) {
    // 非 Marina 环境：完全 no-op。不订阅任何事件，零开销。
    // 这是 package 可安全全局安装的关键——在普通终端里跑 pi 不会产生任何副作用。
    return;
  }

  pi.on('session_start', async (event, ctx) => {
    const piSessionId = ctx.sessionManager.getSessionId();
    if (!piSessionId) return; // 内存对话（无文件）→ 无法稳定标识，跳过。
    await postEvent(env, piSessionId, 'session_start', { reason: event.reason });
  });

  pi.on('session_shutdown', async (event, ctx) => {
    const piSessionId = ctx.sessionManager.getSessionId();
    if (!piSessionId) return;
    await postEvent(env, piSessionId, 'session_shutdown', { reason: event.reason });
  });

  // agent_start：pi 开始处理用户请求 → 通知 Marina "working"（清旧的"未查看"标记）。
  pi.on('agent_start', async (_event, ctx) => {
    const piSessionId = ctx.sessionManager.getSessionId();
    if (!piSessionId) return;
    await postEvent(env, piSessionId, 'agent_working');
  });

  // agent_settled：pi 这轮彻底完成（无自动重试/压缩/续跑）→ 通知 Marina "settled"。
  // 用 settled 而非 agent_end：后者之后可能还有自动重试，settled 才是真"干完了"。
  pi.on('agent_settled', async (_event, ctx) => {
    const piSessionId = ctx.sessionManager.getSessionId();
    if (!piSessionId) return;
    await postEvent(env, piSessionId, 'agent_settled');
  });

  // 对话名变更 → 反映到 Marina 终端显示名（受 manuallyRenamed 保护，由 Marina 决定）。
  pi.on('session_info_changed', async (event, ctx) => {
    const piSessionId = ctx.sessionManager.getSessionId();
    if (!piSessionId) return;
    await postEvent(env, piSessionId, 'name_changed', { name: event.name ?? null });
  });
}
