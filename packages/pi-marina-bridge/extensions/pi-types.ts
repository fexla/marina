/**
 * @file packages/pi-marina-bridge/extensions/pi-types.ts
 * @purpose 本 bridge 用到的 pi ExtensionAPI **最小结构化类型**。本地声明而非
 *   `import type from '@earendil-works/pi-coding-agent'`,因为 Marina 仓不安装
 *   pi 依赖(pi 是用户机器上的独立 CLI,Marina 只复制 package 目录过去)——
 *   远端 import 在 Marina 仓 typecheck 里是 TS2307,并级联出十几个
 *   implicit-any(48ec329 时已存在,本文件随方案 20260909 一并修掉)。
 *
 * @设计:
 * - 只声明我们**实际使用**的面:`pi.on` 的 9 个事件重载 + handler 里读到的
 *   event/ctx 字段。字段比真实 API 少没关系(结构化类型只要求覆盖使用面),
 *   但已用字段必须与真实 API 一致 —— 对照 pi 源码
 *   dist/core/extensions/types.d.ts(0.84.4)逐个核对过。
 * - jiti 加载 extension 时擦除全部类型,本文件零运行时影响。
 * - 真实完整定义升级 pi 后如需新事件,先来这里补结构,再在 index.ts 订阅。
 */
import type { BindingSessionManagerLike } from './binding';

/* ── 事件 payload(只含本 bridge 读取的字段) ───────────────────────── */

export interface SessionStartEvent {
  type: 'session_start';
  reason: 'startup' | 'reload' | 'new' | 'resume' | 'fork';
}

export interface SessionShutdownEvent {
  type: 'session_shutdown';
  reason: 'quit' | 'reload' | 'new' | 'resume' | 'fork';
}

export interface SessionInfoChangedEvent {
  type: 'session_info_changed';
  name: string | undefined;
}

export interface SessionCompactEvent {
  type: 'session_compact';
  /** overflow 压缩被中断的 turn 会自动重试。 */
  willRetry: boolean;
}

/** 空事件(agent_start / agent_settled / session_before_compact 只有 type)。 */
export interface MarkerOnlyEvent {
  type: 'agent_start' | 'agent_settled' | 'session_before_compact';
}

export interface ResourcesDiscoverEvent {
  type: 'resources_discover';
  cwd: string;
  reason: 'startup' | 'reload';
}

export interface ResourcesDiscoverResult {
  skillPaths?: string[];
  promptPaths?: string[];
  themePaths?: string[];
}

export interface BeforeAgentStartEvent {
  type: 'before_agent_start';
  prompt: string;
  /** 当前链上的完整系统提示词(含更早 handler 的修改)。 */
  systemPrompt: string;
}

export interface BeforeAgentStartResult {
  /** 替换本轮系统提示词(链式:后续 handler 在此基础上继续)。 */
  systemPrompt: string;
}

/* ── ctx(只含本 bridge 读取的字段) ────────────────────────────────── */

export interface ExtensionContext {
  /** 会话管理器:sessionId / header / branch 读取(结构见 binding.ts)。 */
  sessionManager: BindingSessionManagerLike & {
    getSessionId(): string | null;
    /** 旧版 pi 可能没有;亲缘读取已做了可选探测。 */
    getHeader?(): unknown;
  };
}

/** handler 统一形状:可同步/异步,返回值(若有)由 pi 合并。 */
export type ExtensionHandler<E, R = void> = (
  event: E,
  ctx: ExtensionContext,
) => Promise<R | undefined> | R | undefined;

/** 本 bridge 消费的 ExtensionAPI 切片。 */
export interface ExtensionAPI {
  /** 向当前对话分支追加 custom entry(session_start 存回 Marina 分配的 workspaceId)。 */
  appendEntry(customType: string, data: unknown): void;
  on(event: 'session_start', handler: ExtensionHandler<SessionStartEvent>): void;
  on(event: 'session_shutdown', handler: ExtensionHandler<SessionShutdownEvent>): void;
  on(event: 'agent_start', handler: ExtensionHandler<MarkerOnlyEvent>): void;
  on(event: 'agent_settled', handler: ExtensionHandler<MarkerOnlyEvent>): void;
  on(event: 'session_before_compact', handler: ExtensionHandler<MarkerOnlyEvent>): void;
  on(event: 'session_compact', handler: ExtensionHandler<SessionCompactEvent>): void;
  on(event: 'session_info_changed', handler: ExtensionHandler<SessionInfoChangedEvent>): void;
  on(
    event: 'resources_discover',
    handler: ExtensionHandler<ResourcesDiscoverEvent, ResourcesDiscoverResult>,
  ): void;
  on(
    event: 'before_agent_start',
    handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartResult>,
  ): void;
}
