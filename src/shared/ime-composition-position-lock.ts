/**
 * @file src/shared/ime-composition-position-lock.ts
 * @purpose IME-2 workaround — 在 `_core._compositionHelper` 上 monkey-patch
 *   `updateCompositionElements`,让 IME composition 期间 helper-textarea /
 *   compositionView 的位置锁定在 compositionstart 瞬间的 `buffer.x/y`,
 *   不再每帧跟着 TUI 重绘的 cursor 抖动。
 *
 *   根因在 @xterm/xterm CompositionHelper:Terminal 构造里把
 *   `updateCompositionElements()` 注册到 `onRender` 事件 + 内部 setTimeout(0)
 *   自递归,只要 `_isComposing=true` 就每帧 + 每个微任务都把 textarea 贴到
 *   「当前 buffer.x/y」对应的像素位置。Claude Code / aider / vim insert mode
 *   等会反复 save→move→draw→restore cursor 的 TUI,在 1-4 字节之间的瞬时
 *   cursor 位置都会被 xterm 当成「现在该贴的位置」,IME 候选框跟着抖。
 *   详见 docs/issues/ime-2-composition-textarea-position-drift.md。
 *
 *   workaround 思路:进 composition 时拍快照 `{x, y}`,被 patch 过的
 *   updateCompositionElements 在锁定期间把 `bufferService.buffer.x/y`
 *   临时换成快照值,调原实现,再换回来 — finally 保证不污染 xterm 自己的状态。
 *
 * @关键设计:
 * - 提取成纯函数 + duck-typed 接口,既能在 renderer 里挂到真实
 *   `term['_core']._compositionHelper`,也能在 vitest 里用 fake 实现跑护栏测试
 *   (AGENTS.md 5.1 — renderer 不写测试,核心逻辑必须沉到 shared)
 * - 锁定期间 swap-restore `buffer.x/y` 而不是改 patch 内的几何计算 — 这样
 *   xterm 内部任何引用 `buffer.x/y` 的派生位置(textarea.style.top/left/
 *   width/height、compositionView.style.*)都按锁定值算,不会漏掉
 * - swap 必须在 try/finally 内,即使 origUpdate 抛异常也要把 x/y 改回原值,
 *   否则 xterm 下次正常 render 看到的 cursor 位置就错了
 * - detach 时只在「method 仍是我们的 patch」时才还原,避免覆盖第三方/未来同位
 *   置的另一个 patch(防御性,目前没有第三方 patch 这里,但成本极低)
 *
 * @对应文档章节: docs/issues/ime-2-composition-textarea-position-drift.md
 *   "修法" 与 "风险"
 */

/**
 * xterm 的 BufferService.buffer 暴露的最小子集 — 我们需要读写 x/y,
 * 实测 xterm 里这两个是 plain 实例字段(`this.x = 0; this.y = 0` 直接赋值,
 * 不是 getter/setter),所以我们也能直接赋值。
 */
export interface BufferLike {
  x: number;
  y: number;
}

/**
 * xterm 的 IBufferService 暴露的最小子集 — 只关心 `.buffer` 引用。
 * 必须是同一引用而不是 getter,否则 swap-restore 的写值看不到原对象。
 * 实测 xterm 的 buffer getter 返回 active buffer 实例,稳定。
 */
export interface BufferServiceLike {
  buffer: BufferLike;
}

/**
 * xterm 的 ICompositionHelper 暴露的最小子集 — 我们要 patch 这个方法。
 * skipRecurse 是 xterm 内部递归调用时透传的标记,patch 不关心语义,直接转发。
 */
export interface CompositionHelperLike {
  updateCompositionElements(skipRecurse?: boolean): void;
}

/**
 * Duck-typed 接口,匹配 HTMLTextAreaElement 的最小子集。
 * 只挂 compositionstart / compositionend 两个事件,update / keydown 不参与
 * 锁位语义(锁定值在 start 一次性拍快照,end 一次性释放)。
 */
export interface CompositionTextareaLike {
  addEventListener(
    type: 'compositionstart' | 'compositionend',
    listener: () => void,
  ): void;
  removeEventListener(
    type: 'compositionstart' | 'compositionend',
    listener: () => void,
  ): void;
}

/**
 * 在 composition helper 上挂位置锁定 patch,返回 detach 函数。
 *
 * 接 attach 之后,行为:
 * - 非 composition 期间:patch 仅 early-return 转调原实现,与 xterm 默认完全一致
 * - composition 期间:`updateCompositionElements` 内部读到的 `buffer.x/y`
 *   被替换为 compositionstart 瞬间的快照,直到 compositionend 解锁
 *
 * detach 之后:event listener 拆掉,helper 上的方法还原为原版 — 完全恢复 xterm
 * 默认行为。
 */
export function attachImeCompositionPositionLock(
  textarea: CompositionTextareaLike,
  compositionHelper: CompositionHelperLike,
  bufferService: BufferServiceLike,
): () => void {
  let locked: { x: number; y: number } | null = null;

  const onStart = (): void => {
    locked = { x: bufferService.buffer.x, y: bufferService.buffer.y };
  };
  const onEnd = (): void => {
    locked = null;
  };

  textarea.addEventListener('compositionstart', onStart);
  textarea.addEventListener('compositionend', onEnd);

  // 保留 unbound 引用用于 detach 还原 — 否则 detach 后 helper 上挂的是
  // `bind` 包装,跟外部记得的 origRef 不再 ===,后续逻辑(以及测试)区分不开
  // 「还在 patch」与「已还原」。invocation 走 .call(helper, ...) 保证 this 正确。
  const origUpdate = compositionHelper.updateCompositionElements;

  const patchedUpdate = function (skipRecurse?: boolean): void {
    if (!locked) {
      origUpdate.call(compositionHelper, skipRecurse);
      return;
    }
    const buf = bufferService.buffer;
    const realX = buf.x;
    const realY = buf.y;
    buf.x = locked.x;
    buf.y = locked.y;
    try {
      origUpdate.call(compositionHelper, skipRecurse);
    } finally {
      buf.x = realX;
      buf.y = realY;
    }
  };

  compositionHelper.updateCompositionElements = patchedUpdate;

  return (): void => {
    textarea.removeEventListener('compositionstart', onStart);
    textarea.removeEventListener('compositionend', onEnd);
    if (compositionHelper.updateCompositionElements === patchedUpdate) {
      compositionHelper.updateCompositionElements = origUpdate;
    }
    locked = null;
  };
}
