/**
 * @file src/shared/ime-textarea-workaround.ts
 * @purpose IME-1 workaround — 在 xterm 的 helper-textarea 上挂 compositionend
 *   监听,延迟清空 textarea.value,根治"中文 IME 按标点冲刷一大段历史"。
 *
 *   根因在 @xterm/xterm 的 CompositionHelper:整个 xterm 只在按 Enter (CR) 或
 *   Ctrl+C (ETX) 时清 textarea,中文 IME 用户长时间不按 Enter 时 helper-textarea
 *   会累到几百几千字符;再叠加 compositionend 用 substring(start) 取从开头到
 *   textarea 末尾,以及 keydown 229 + replace diff 等多条 race 路径,
 *   就会把历史累积一起取出送给 onData。详见 docs/issues/ime-1-*.md。
 *
 *   workaround 思路:每次 compositionend 之后延迟 16ms(一帧)清空 textarea,
 *   把"textarea 累积历史"这个根因断掉,所有三条 race 路径都会失效:
 *   - 路径 1(嵌套 finalize):每次 end 后清空 → 下次 start 从 0 开始
 *   - 路径 2(kd229 + replace diff):oldValue 是清空后的状态,diff 算的是真新增
 *   - 路径 3(_dataAlreadySent 错乱):substring(start) 即使 start 算错,
 *     textarea 也只有本次内容
 *
 * @关键设计:
 * - 提取成纯函数 + duck-typed 接口,既能在 renderer 里挂到真实
 *   HTMLTextAreaElement,也能在 vitest 里用 fake textarea 跑护栏测试
 *   (AGENTS.md 5.1 — renderer 不写测试,所以核心逻辑必须沉到 shared)
 * - 延迟必须晚于 xterm 自己的 setTimeout(0) 读取 substring 窗口;0ms 会抢在
 *   xterm 之前清空,把当次输入也吞掉。16ms(~1 帧)是经验保守值
 * - 函数返回 detach,组件 unmount 时调用即可清理 listener
 * - setTimeout 注入是为了测试能用 vi.useFakeTimers() 控制时序;
 *   生产代码传默认 setTimeout
 *
 * @对应文档章节: docs/issues/ime-1-chinese-ime-stale-textarea-flush.md
 *   "Workaround 方案 → 第二步"
 */

/**
 * Duck-typed 接口,匹配 HTMLTextAreaElement 的最小子集 +
 * Node 环境下用 fake 实现喂给单测。
 */
export interface ImeTextareaLike {
  value: string;
  addEventListener(type: 'compositionend', listener: () => void): void;
  removeEventListener(type: 'compositionend', listener: () => void): void;
}

/**
 * 兼容 window.setTimeout 和 Node setTimeout 的返回类型。
 * 显式写 number 联合:Electron web 构建只加载 DOM lib(返回 number),Android
 * web 构建(apps/mobile)的类型图会同时看到 DOM + Node 两个 setTimeout 重载,
 * ReturnType 只取最后一个重载,两端会解析出不同结果(ADR-042 踩坑)。
 */
type TimeoutHandle = ReturnType<typeof setTimeout> | number;

export interface AttachOptions {
  /**
   * compositionend 触发后多少毫秒清空 textarea.value。
   * 必须晚于 xterm CompositionHelper 自己的 setTimeout(0) 读取 substring 窗口,
   * 否则会把当次输入也吞掉。默认 16ms(~1 帧)。
   */
  delayMs?: number;
  /**
   * 注入 setTimeout / clearTimeout,方便单测用 fake timers 控制时序。
   */
  setTimeoutFn?: (fn: () => void, ms: number) => TimeoutHandle;
  clearTimeoutFn?: (handle: TimeoutHandle) => void;
}

/**
 * 在 textarea 上挂 compositionend 兜底清空。返回 detach 函数。
 *
 * 多次 compositionend 快速触发时,后到的 cleanup 会覆盖前一个 pending 的
 * setTimeout — 避免连续 IME 提交产生 setTimeout 风暴。
 */
export function attachImeCompositionEndCleaner(
  textarea: ImeTextareaLike,
  options: AttachOptions = {},
): () => void {
  const delayMs = options.delayMs ?? 16;
  const setT = options.setTimeoutFn ?? setTimeout;
  const clearT = options.clearTimeoutFn ?? clearTimeout;

  let pending: TimeoutHandle | null = null;

  const listener = (): void => {
    if (pending !== null) {
      clearT(pending);
    }
    pending = setT(() => {
      pending = null;
      textarea.value = '';
    }, delayMs);
  };

  textarea.addEventListener('compositionend', listener);

  return () => {
    textarea.removeEventListener('compositionend', listener);
    if (pending !== null) {
      clearT(pending);
      pending = null;
    }
  };
}
