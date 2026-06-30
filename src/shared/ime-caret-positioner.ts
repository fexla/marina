/**
 * @file src/shared/ime-caret-positioner.ts
 * @purpose IME-3 候选框定位修复 — 从外部接管 xterm helper-textarea 的像素定位,
 *   统一治理搜狗 / 微软拼音两种 IME 的「候选框来回跳」与「跑到屏幕右下角」。
 *
 *   根因(用 [IME-POS] 探针实证):xterm 把隐藏的 .xterm-helper-textarea 钉在
 *   「实时 cursor」上,且光标一出视口就 early-return 拒绝定位 → textarea 停在
 *   CSS 默认 left:-9999em 离屏位 → Windows IME 读到无效 caret → 候选框兜底到
 *   屏幕角。两个 IME 走 xterm 两条不同路径,但踩同一个坑:
 *     - 搜狗:不发 composition 事件(探针证实只发 input/isComposing:false),
 *       xterm CompositionHelper 永不激活,textarea 只靠 _syncTextArea(onCursorMove)
 *       定位 → TUI save/restore cursor 期间跟着抖;光标出视口就停在 -9999em。
 *     - 微软拼音:正常发 composition,updateCompositionElements 每帧把 textarea
 *       贴到 live cursor → TUI 重绘期间抖;同样有 isCursorInViewport 离屏守卫。
 *   旧 IME-2 lock(ime-composition-position-lock.ts)只在 compositionstart 锁
 *   buffer.x/y —— 只覆盖微软拼音、不 clamp,治不了搜狗也治不了「右下角」。本模块
 *   取代它。
 *
 *   修法:维护一份「锁定光标快照」{x,y}(视口相对),把 textarea 永远写在
 *   lock×cellSize 并 clamp 进视口。覆盖 _syncTextArea(搜狗 + 非composition)与
 *   包 updateCompositionElements(微软拼音 composition)两个挂钩点,xterm 自己
 *   再也写不出抖动/离屏值。
 *
 * @锁快照策略(不依赖 composition 事件,故搜狗也覆盖):
 *   重新拍快照 — focus / compositionstart / input(且此刻 compositionHelper
 *   未在 composition)。跳过 composition 中的 input(微软拼音中途会发):否则
 *   把 live cursor 抖动重新引进锁。每次锁变更立刻 writePosition() 一次(xterm
 *   在下次 onCursorMove 前不会主动调 _syncTextArea)。
 *
 * @关键设计(Plan agent 验证):
 *   - computeClampedCaretPixels 是纯函数,clamp left∈[0,(cols-1)cellW] /
 *     top∈[0,(rows-1)cellH],保证永不离屏 → 治「右下角」。护栏单测就位。
 *   - writePosition 每次现读 _renderService.dimensions(WebGL addon 在 attach
 *     之后才 load,会改 dimensions);缺失 no-op,不抛。
 *   - updateCompositionElements 的 wrap 保留 IME-2 的 buffer.x/y swap(try/finally):
 *     swap 控制 xterm _compositionView(拼音预览浮层),writePosition 只控 textarea;
 *     不 swap 的话预览文字仍会抖。textarea 最终值以 writePosition 的 clamp/锁为准。
 *   - 覆盖 _syncTextArea 用实例属性覆盖原型方法 — 内部 this._syncTextArea() 全走
 *     我们的实现。textarea 不可见,IME 候选框只用 caret 的 left/top 定位,不看 width,
 *     故 width 用单 cell 宽(不算 CJK 双宽),与 xterm 原实现的差异对 IME 无影响。
 *   - 不需要 rAF:两个同步 hook(_syncTextArea 由 onCursorMove/onResize 触发、
 *     updateCompositionElements 由 onRender 触发)已覆盖每帧;rAF 反而有 last-write
 *     颠倒风险。
 *   - 走 term['_core'] 私有 API(与 xterm-serialize-mode-polyfill / 旧 IME-2 同套
 *     妥协),字段缺失 try/catch + 存在性 guard,失败仅 console.warn 不阻塞 —
 *     退化为 xterm 默认。
 *   - detach 仅在「当前方法===我们的 patch」时还原,不覆盖第三方/未来同位置 patch。
 *
 * @对应文档: 本文件 JSDoc + docs/issues/ime-2-composition-textarea-position-drift.md
 *   (IME-2 背景与本模块如何取代它)
 */

// ---- duck-typed 接口(既能挂真实 xterm 实例,也能在 vitest 里喂 fake)----

export interface Lock {
  x: number;
  y: number;
}
export interface Pixels {
  left: number;
  top: number;
}

export interface BufferLike {
  x: number;
  y: number;
}
export interface BufferServiceLike {
  buffer: BufferLike;
  cols: number;
  rows: number;
}
export interface RenderServiceLike {
  // dimensions 可能在 renderer attach 前缺失;WebGL load 后会变,故每次现读。
  dimensions?: { css: { cell: { width: number; height: number } } };
}
export interface CompositionHelperLike {
  updateCompositionElements(skipRecurse?: boolean): void;
  /** xterm ICompositionHelper 暴露的只读 composition 状态;搜狗路径永为 false/undefined。 */
  readonly isComposing?: boolean;
}
/** xterm CoreBrowserTerminal 的最小子集:覆盖 _syncTextArea,读 _renderService/_bufferService。 */
export interface CoreLike {
  _syncTextArea: () => void;
  _renderService?: RenderServiceLike;
  _bufferService?: BufferServiceLike;
}
/** HTMLTextAreaElement 的事件 + style 最小子集。listener 全用 () => void 与现有 IME 模块同模式。 */
export interface TextareaLike {
  style: {
    left: string;
    top: string;
    width: string;
    height: string;
    lineHeight: string;
    zIndex: string;
  };
  addEventListener(type: 'focus', listener: () => void): void;
  addEventListener(type: 'compositionstart', listener: () => void): void;
  addEventListener(type: 'input', listener: () => void): void;
  removeEventListener(
    type: 'focus' | 'compositionstart' | 'input',
    listener: () => void,
  ): void;
}

export interface AttachImeCaretPositionerDeps {
  textarea: TextareaLike;
  core: CoreLike;
  /** 缺失则只挂 _syncTextArea(搜狗路径仍工作,跳过 composition wrap)。 */
  compositionHelper?: CompositionHelperLike;
  bufferService: BufferServiceLike;
  renderService: RenderServiceLike;
}

/**
 * 纯函数:把锁定光标快照 + cell 尺寸 + cols/rows 算成 textarea 的 left/top 像素,
 * 并 clamp 进视口。clamp 保证永不离屏(治「右下角」兜底)。
 *
 * cols/rows/cellW/cellH 非正时退化为 0 上界,不抛。
 */
export function computeClampedCaretPixels(
  lock: Lock,
  cellW: number,
  cellH: number,
  cols: number,
  rows: number,
): Pixels {
  const maxLeft = Math.max(0, (cols - 1) * cellW);
  const maxTop = Math.max(0, (rows - 1) * cellH);
  return {
    left: Math.max(0, Math.min(lock.x * cellW, maxLeft)),
    top: Math.max(0, Math.min(lock.y * cellH, maxTop)),
  };
}

/**
 * 接管 helper-textarea 定位。返回 detach。
 *
 * 接 attach 之后:
 * - focus / compositionstart / input(非 composition) → 拍锁 + 立刻 writePosition
 * - core._syncTextArea 被覆盖成 writePosition(搜狗 + 非composition 微软拼音每帧走这)
 * - compositionHelper.updateCompositionElements 被包:IM2 buffer.x/y swap 稳预览浮层
 *   + orig 返回后 writePosition 给 textarea 上 clamp/锁(微软拼音 composition 每帧走这)
 *
 * detach 之后:listener 拆掉、两个方法还原(仅当仍是我们的 patch)、lock 清空。
 */
export function attachImeCaretPositioner(
  deps: AttachImeCaretPositionerDeps,
): () => void {
  const { textarea, core, compositionHelper, bufferService, renderService } =
    deps;
  let lock: Lock | null = null;

  const cellSize = (): { w: number; h: number } | null => {
    const cell = renderService.dimensions?.css?.cell;
    if (
      !cell ||
      typeof cell.width !== 'number' ||
      typeof cell.height !== 'number'
    ) {
      return null;
    }
    return { w: cell.width, h: cell.height };
  };

  const snapshotLock = (): void => {
    const b = bufferService.buffer;
    if (typeof b.x === 'number' && typeof b.y === 'number') {
      lock = { x: b.x, y: b.y };
    }
  };

  // 把 textarea 写到 lock×cellSize 并 clamp 进视口;dimensions 缺失或 lock 未拍则 no-op。
  // width/height/lineHeight/zIndex 一并写(我们完全取代了 _syncTextArea,要保持 textarea 尺寸)。
  const writePosition = (): void => {
    if (lock === null) return;
    const cs = cellSize();
    if (cs === null) return;
    const { left, top } = computeClampedCaretPixels(
      lock,
      cs.w,
      cs.h,
      bufferService.cols,
      bufferService.rows,
    );
    const s = textarea.style;
    s.left = `${left}px`;
    s.top = `${top}px`;
    s.width = `${cs.w}px`;
    s.height = `${cs.h}px`;
    s.lineHeight = `${cs.h}px`;
    s.zIndex = '-5';
  };

  // 锁变更:拍快照 + 立刻定位(xterm 在下次 cursorMove 前不会主动调 _syncTextArea)。
  const relockAndWrite = (): void => {
    snapshotLock();
    writePosition();
  };

  const onFocus = (): void => relockAndWrite();
  const onCompositionStart = (): void => relockAndWrite();
  const onInput = (): void => {
    // 跳过 composition 中的 input(微软拼音中途发) — 否则把 live cursor 抖动重新
    // 引进锁。用 compositionHelper.isComposing 判(xterm 权威状态),不用事件 flag,
    // 避开跨 IME 事件形态差异(搜狗 input 的 isComposing 本就是 false)。
    if (compositionHelper?.isComposing === true) return;
    relockAndWrite();
  };

  textarea.addEventListener('focus', onFocus);
  textarea.addEventListener('compositionstart', onCompositionStart);
  textarea.addEventListener('input', onInput);

  // ---- 挂钩点 1:覆盖 core._syncTextArea(搜狗 + 非composition 微软拼音)----
  // 实例属性覆盖原型方法;内部 this._syncTextArea() 全走这里。不调原实现 ——
  // 我们完全接管非 composition 的 textarea 定位(原实现的 live-cursor 抖动 /
  // isCursorInViewport 离屏 early-return 正是要消除的)。lock 未拍时先从 live
  // buffer 拍一次(覆盖 term.open 后、首次 focus 前就有 cursorMove 的情况)。
  const origSync = core._syncTextArea;
  const patchedSync = (): void => {
    if (lock === null) snapshotLock();
    writePosition();
  };
  core._syncTextArea = patchedSync;

  // ---- 挂钩点 2:包 compositionHelper.updateCompositionElements(微软拼音 composition)----
  // 保留 IME-2 的 buffer.x/y swap(try/finally)稳 _compositionView 预览浮层;
  // orig 返回后再 writePosition() 给 textarea 上 clamp/锁(orig 用 live cursor,
  // 既会抖、isCursorInViewport false 时还会留 -9999em,都被 writePosition 覆盖)。
  let detachCompositionWrap: (() => void) | null = null;
  if (
    compositionHelper &&
    typeof compositionHelper.updateCompositionElements === 'function'
  ) {
    const origUpdate = compositionHelper.updateCompositionElements;
    const patchedUpdate = function (skipRecurse?: boolean): void {
      if (lock === null) snapshotLock();
      if (lock === null) {
        // dimensions 没准备好等极端情况:退化为原行为,不阻塞 xterm 自身 composition。
        origUpdate.call(compositionHelper, skipRecurse);
        return;
      }
      const buf = bufferService.buffer;
      const realX = buf.x;
      const realY = buf.y;
      buf.x = lock.x;
      buf.y = lock.y;
      try {
        origUpdate.call(compositionHelper, skipRecurse);
      } finally {
        buf.x = realX;
        buf.y = realY;
      }
      writePosition();
    };
    compositionHelper.updateCompositionElements = patchedUpdate;
    detachCompositionWrap = (): void => {
      if (compositionHelper.updateCompositionElements === patchedUpdate) {
        compositionHelper.updateCompositionElements = origUpdate;
      }
    };
  }

  return (): void => {
    textarea.removeEventListener('focus', onFocus);
    textarea.removeEventListener('compositionstart', onCompositionStart);
    textarea.removeEventListener('input', onInput);
    if (core._syncTextArea === patchedSync) {
      core._syncTextArea = origSync;
    }
    detachCompositionWrap?.();
    lock = null;
  };
}
