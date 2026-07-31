/*
 * @file code-block-run-cache.ts
 * @purpose 保存 Markdown 代码块运行的 L1 工作态(运行中 / 输出 / 退出码),使
 *   MarkdownCodeBlock 卸载重挂后仍能恢复,并在组件不在场时继续接收流式事件。
 *
 * @关键设计:
 * - identity = sessionId + 文档路径 + Markdown 源位置 + 代码摘要。同一 terminal
 *   切走再切回命中同一条;换 session/cwd 不共享,文档代码变化也不复用旧输出。
 * - 全局事件桥在 renderer 生命周期内只安装一次。组件卸载只退订 store listener,
 *   不退订 IPC,所以运行到一半切 terminal 不丢 output/exited 事件。
 * - 这是类似 fileViewerScroll 的 L1 工作态:跨组件重挂保留,应用重启可丢。输出
 *   可能含路径/token/命令结果,禁止写 localStorage/main 日志或持久化文件。
 * - Map 最多 128 条、单条输出最多 2Mi 字符;只淘汰非 running 条目。main 同时
 *   运行上限是 64,因此不会为腾缓存而遗失存活任务的 runId。
 * - runId 返回前的极早 output/exited 放进有界 pending,attachRun 后补入,避免
 *   spawn 很快输出时 IPC event 先于 invoke response 的竞态。
 *
 * @对应文档章节:AGENTS.md 附录 G(L1 工作态)、附录 H(隐私/有界缓存);
 *   docs/方案-markdown代码块执行-20260731.md。
 *
 * @不要在这里做的事:
 * - 不保存命令正文,cache key 只存非可逆摘要。
 * - 不在组件 unsubscribe 时停止进程;停止只能由用户按钮或窗口关闭触发。
 * - 不把输出写日志、localStorage 或 main 持久化。
 */
import { useCallback, useSyncExternalStore } from 'react';
import {
  EVENT_CHANNELS,
  type CodeBlockExitedPayload,
  type CodeBlockOutputPayload,
} from '@shared/protocol';

export type CodeBlockRunState = 'idle' | 'running' | 'exited';

export interface CodeBlockRunSnapshot {
  state: CodeBlockRunState;
  runId: string | null;
  output: string;
  exitCode: number | null;
}

type CacheEntry = CodeBlockRunSnapshot;

interface PendingRunEvents {
  output: string;
  exited: CodeBlockExitedPayload | null;
}

const MAX_CACHE_ENTRIES = 128;
const MAX_PENDING_RUNS = 64;
const MAX_OUTPUT_CHARS = 2 * 1024 * 1024;
const TRUNCATED_PREFIX = '[marina] earlier output truncated / 前部输出已截断\n';

const EMPTY_SNAPSHOT: CodeBlockRunSnapshot = Object.freeze({
  state: 'idle',
  runId: null,
  output: '',
  exitCode: null,
});

const entries = new Map<string, CacheEntry>();
const listeners = new Map<string, Set<() => void>>();
const runToKey = new Map<string, string>();
const pendingByRunId = new Map<string, PendingRunEvents>();
let eventBridgeInstalled = false;

/** FNV-1a 32-bit:只用于内存 identity,不是安全/持久化哈希。 */
function hashCode(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * 构造稳定且不含命令正文的运行状态 identity。
 */
export function createCodeBlockRunKey(
  sessionId: string,
  documentPath: string,
  sourcePosition: string | number,
  code: string,
): string {
  return `${sessionId}\0${documentPath}\0${String(sourcePosition)}\0${code.length}:${hashCode(code)}`;
}

function appendBounded(previous: string, next: string): string {
  if (!next) return previous;
  const combined = previous + next;
  if (combined.length <= MAX_OUTPUT_CHARS) return combined;
  const keep = Math.max(0, MAX_OUTPUT_CHARS - TRUNCATED_PREFIX.length);
  return TRUNCATED_PREFIX + combined.slice(-keep);
}

function notify(key: string): void {
  for (const listener of listeners.get(key) ?? []) listener();
}

function removeEntry(key: string): void {
  const entry = entries.get(key);
  if (entry?.runId) runToKey.delete(entry.runId);
  entries.delete(key);
  notify(key);
}

/** LRU 淘汰只选已结束条目;running 永不因 renderer 缓存预算被遗失。 */
function enforceEntryLimit(): void {
  while (entries.size > MAX_CACHE_ENTRIES) {
    let candidate: string | null = null;
    for (const [key, entry] of entries) {
      if (entry.state !== 'running') {
        candidate = key;
        break;
      }
    }
    if (candidate === null) return;
    removeEntry(candidate);
  }
}

function publish(key: string, snapshot: CodeBlockRunSnapshot): void {
  // delete + set 把最近更新条目移到 Map 尾部,淘汰无需排序。
  entries.delete(key);
  entries.set(key, snapshot);
  enforceEntryLimit();
  notify(key);
}

function rememberPending(runId: string, update: (pending: PendingRunEvents) => void): void {
  const pending = pendingByRunId.get(runId) ?? { output: '', exited: null };
  update(pending);
  pendingByRunId.delete(runId);
  pendingByRunId.set(runId, pending);
  while (pendingByRunId.size > MAX_PENDING_RUNS) {
    const oldest = pendingByRunId.keys().next().value as string | undefined;
    if (!oldest) break;
    pendingByRunId.delete(oldest);
  }
}

function handleOutput(payload: CodeBlockOutputPayload): void {
  const key = runToKey.get(payload.runId);
  const entry = key ? entries.get(key) : undefined;
  if (!key || !entry || entry.runId !== payload.runId) {
    rememberPending(payload.runId, (pending) => {
      pending.output = appendBounded(pending.output, payload.data);
    });
    return;
  }
  publish(key, { ...entry, output: appendBounded(entry.output, payload.data) });
}

function handleExited(payload: CodeBlockExitedPayload): void {
  const key = runToKey.get(payload.runId);
  const entry = key ? entries.get(key) : undefined;
  if (!key || !entry || entry.runId !== payload.runId) {
    rememberPending(payload.runId, (pending) => {
      pending.exited = payload;
    });
    return;
  }
  runToKey.delete(payload.runId);
  publish(key, {
    ...entry,
    state: 'exited',
    exitCode: payload.exitCode,
  });
}

/** 安装窗口级 IPC 事件桥。故意不随任何 MarkdownCodeBlock 卸载。 */
function ensureEventBridge(): void {
  if (eventBridgeInstalled) return;
  eventBridgeInstalled = true;
  window.api.on<CodeBlockOutputPayload>(EVENT_CHANNELS.CODE_BLOCK_OUTPUT, handleOutput);
  window.api.on<CodeBlockExitedPayload>(EVENT_CHANNELS.CODE_BLOCK_EXITED, handleExited);
}

function subscribe(key: string, listener: () => void): () => void {
  ensureEventBridge();
  // remount/切回即视为一次访问,把已存在结果移到 LRU 尾部;对象引用不变,
  // useSyncExternalStore 不会因此产生额外渲染。
  const entry = entries.get(key);
  if (entry) {
    entries.delete(key);
    entries.set(key, entry);
  }
  const keyListeners = listeners.get(key) ?? new Set<() => void>();
  keyListeners.add(listener);
  listeners.set(key, keyListeners);
  return () => {
    keyListeners.delete(listener);
    if (keyListeners.size === 0) listeners.delete(key);
  };
}

function getSnapshot(key: string): CodeBlockRunSnapshot {
  return entries.get(key) ?? EMPTY_SNAPSHOT;
}

/** React 组件订阅某个代码块的外部运行状态。 */
export function useCodeBlockRunSnapshot(key: string): CodeBlockRunSnapshot {
  const subscribeForKey = useCallback((listener: () => void) => subscribe(key, listener), [key]);
  const getForKey = useCallback(() => getSnapshot(key), [key]);
  return useSyncExternalStore(subscribeForKey, getForKey, () => EMPTY_SNAPSHOT);
}

/** 新执行开始:清空上次结果并先进入 running,runId 稍后由 IPC response 绑定。 */
export function beginCodeBlockRun(key: string): void {
  ensureEventBridge();
  const previous = entries.get(key);
  if (previous?.runId) runToKey.delete(previous.runId);
  publish(key, { state: 'running', runId: null, output: '', exitCode: null });
}

/** 把 main 返回的 runId 绑定到 cache key,并回放 response 之前到达的早期事件。 */
export function attachCodeBlockRun(key: string, runId: string): void {
  ensureEventBridge();
  const entry = entries.get(key) ?? {
    state: 'running' as const,
    runId: null,
    output: '',
    exitCode: null,
  };
  if (entry.runId) runToKey.delete(entry.runId);
  runToKey.set(runId, key);
  publish(key, { ...entry, state: 'running', runId });

  const pending = pendingByRunId.get(runId);
  if (!pending) return;
  pendingByRunId.delete(runId);
  if (pending.output) handleOutput({ runId, stream: 'stdout', data: pending.output });
  if (pending.exited) handleExited(pending.exited);
}

/** IPC 启动失败也作为一次已结束结果显示,便于用户清除或重试。 */
export function failCodeBlockRun(key: string, message: string): void {
  const previous = entries.get(key);
  if (previous?.runId) runToKey.delete(previous.runId);
  publish(key, {
    state: 'exited',
    runId: null,
    output: message,
    exitCode: -1,
  });
}

/** 清除已结束结果。running 时拒绝,避免 UI 丢失仍存活任务的 stop 句柄。 */
export function clearCodeBlockRun(key: string): boolean {
  const entry = entries.get(key);
  if (!entry) return true;
  if (entry.state === 'running') return false;
  removeEntry(key);
  return true;
}
