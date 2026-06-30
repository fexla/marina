/**
 * @file src/shared/ime-caret-positioner.test.ts
 * @purpose IME-3 候选框定位修复的护栏单测。
 *
 *   覆盖两条逻辑:
 *   1. 纯函数 computeClampedCaretPixels —— clamp 边界(治「右下角」离屏)
 *   2. attachImeCaretPositioner —— 锁快照策略、_syncTextArea 覆盖、
 *      updateCompositionElements wrap(swap 不变式 + try/finally)、detach 防御
 *
 *   同 ime-composition-position-lock.test.ts / ime-textarea-workaround.test.ts:
 *   renderer 不写测试(AGENTS.md 5.1),核心逻辑沉 shared 才能加护栏;用 fake
 *   textarea/core/compositionHelper 喂 duck-typed 接口,不引 jsdom。
 */
import { describe, it, expect } from 'vitest';
import {
  attachImeCaretPositioner,
  computeClampedCaretPixels,
  type CoreLike,
  type TextareaLike,
  type CompositionHelperLike,
  type BufferServiceLike,
  type RenderServiceLike,
} from './ime-caret-positioner';

// ---- fakes ----

class FakeTextarea implements TextareaLike {
  style = {
    left: '',
    top: '',
    width: '',
    height: '',
    lineHeight: '',
    zIndex: '',
  };
  private focusL = new Set<() => void>();
  private startL = new Set<() => void>();
  private inputL = new Set<() => void>();

  addEventListener(
    type: 'focus' | 'compositionstart' | 'input',
    listener: () => void,
  ): void {
    if (type === 'focus') this.focusL.add(listener);
    else if (type === 'compositionstart') this.startL.add(listener);
    else this.inputL.add(listener);
  }
  removeEventListener(
    type: 'focus' | 'compositionstart' | 'input',
    listener: () => void,
  ): void {
    if (type === 'focus') this.focusL.delete(listener);
    else if (type === 'compositionstart') this.startL.delete(listener);
    else this.inputL.delete(listener);
  }
  fireFocus(): void {
    this.focusL.forEach((f) => f());
  }
  fireStart(): void {
    this.startL.forEach((f) => f());
  }
  fireInput(): void {
    this.inputL.forEach((f) => f());
  }
  listenerCount(): number {
    return this.focusL.size + this.startL.size + this.inputL.size;
  }
}

interface Fakes {
  textarea: FakeTextarea;
  bufferService: BufferServiceLike;
  renderService: RenderServiceLike;
  core: CoreLike;
  compositionHelper: CompositionHelperLike & { isComposing: boolean };
  origSyncCalls: number;
  observed: Array<{ x: number; y: number; skipRecurse: boolean | undefined }>;
}

function makeFakes(opts?: {
  cellW?: number;
  cellH?: number;
  cols?: number;
  rows?: number;
  withCompositionHelper?: boolean;
  withDimensions?: boolean;
}): Fakes {
  const cellW = opts?.cellW ?? 10;
  const cellH = opts?.cellH ?? 20;
  const cols = opts?.cols ?? 80;
  const rows = opts?.rows ?? 24;
  const bufferService: BufferServiceLike = {
    buffer: { x: 0, y: 0 },
    cols,
    rows,
  };
  const renderService: RenderServiceLike = opts?.withDimensions
    ? { dimensions: { css: { cell: { width: cellW, height: cellH } } } }
    : {};
  const observed: Array<{
    x: number;
    y: number;
    skipRecurse: boolean | undefined;
  }> = [];
  const compositionHelper = {
    isComposing: false,
    updateCompositionElements(skipRecurse?: boolean): void {
      observed.push({
        x: bufferService.buffer.x,
        y: bufferService.buffer.y,
        skipRecurse,
      });
    },
  };
  const origSyncCalls = { n: 0 };
  const core: CoreLike = {
    _syncTextArea: (): void => {
      origSyncCalls.n++;
    },
    _renderService: renderService,
    _bufferService: bufferService,
  };
  return {
    textarea: new FakeTextarea(),
    bufferService,
    renderService,
    core,
    // 测试里常要改 isComposing / 拿 observed,做成可变对象
    compositionHelper: opts?.withCompositionHelper
      ? compositionHelper
      : (undefined as unknown as Fakes['compositionHelper']),
    get origSyncCalls(): number {
      return origSyncCalls.n;
    },
    observed,
  };
}

// ---- 纯函数 ----

describe('computeClampedCaretPixels', () => {
  it('视口内 cell 原样返回 lock×cell', () => {
    expect(computeClampedCaretPixels({ x: 3, y: 4 }, 10, 20, 80, 24)).toEqual({
      left: 30,
      top: 80,
    });
  });

  it('{0,0} 返回 {0,0}', () => {
    expect(computeClampedCaretPixels({ x: 0, y: 0 }, 10, 20, 80, 24)).toEqual({
      left: 0,
      top: 0,
    });
  });

  it('x≥cols clamp 到 (cols-1)*cellW', () => {
    const r = computeClampedCaretPixels({ x: 999, y: 0 }, 10, 20, 80, 24);
    expect(r.left).toBe(79 * 10);
    expect(r.top).toBe(0);
  });

  it('y≥rows clamp 到 (rows-1)*cellH', () => {
    const r = computeClampedCaretPixels({ x: 0, y: 999 }, 10, 20, 80, 24);
    expect(r.left).toBe(0);
    expect(r.top).toBe(23 * 20);
  });

  it('cellW/cellH 为 0 退化为 {0,0},不抛', () => {
    expect(computeClampedCaretPixels({ x: 5, y: 5 }, 0, 0, 80, 24)).toEqual({
      left: 0,
      top: 0,
    });
  });

  it('cols/rows ≤0 时上界退化为 0,left/top 都被 clamp 到 0', () => {
    expect(computeClampedCaretPixels({ x: 5, y: 5 }, 10, 20, 0, 0)).toEqual({
      left: 0,
      top: 0,
    });
  });
});

// ---- attach 行为 ----

describe('attachImeCaretPositioner', () => {
  it('focus 后 writePosition 把 left/top/width/height/lineHeight/zIndex 全写上', () => {
    const f = makeFakes({ withDimensions: true, withCompositionHelper: true });
    f.bufferService.buffer.x = 3;
    f.bufferService.buffer.y = 4;
    attachImeCaretPositioner({
      textarea: f.textarea,
      core: f.core,
      compositionHelper: f.compositionHelper,
      bufferService: f.bufferService,
      renderService: f.renderService,
    });
    f.textarea.fireFocus();
    expect(f.textarea.style.left).toBe('30px'); // 3*10
    expect(f.textarea.style.top).toBe('80px'); // 4*20
    expect(f.textarea.style.width).toBe('10px');
    expect(f.textarea.style.height).toBe('20px');
    expect(f.textarea.style.lineHeight).toBe('20px');
    expect(f.textarea.style.zIndex).toBe('-5');
  });

  it('dimensions 缺失时 writePosition no-op(style 不动)', () => {
    const f = makeFakes({ withDimensions: false, withCompositionHelper: true });
    f.bufferService.buffer.x = 3;
    attachImeCaretPositioner({
      textarea: f.textarea,
      core: f.core,
      compositionHelper: f.compositionHelper,
      bufferService: f.bufferService,
      renderService: f.renderService,
    });
    f.textarea.fireFocus();
    expect(f.textarea.style.left).toBe('');
    expect(f.textarea.style.top).toBe('');
  });

  it('focus 从当前 buffer.x/y 拍锁', () => {
    const f = makeFakes({ withDimensions: true, withCompositionHelper: true });
    attachImeCaretPositioner({
      textarea: f.textarea,
      core: f.core,
      compositionHelper: f.compositionHelper,
      bufferService: f.bufferService,
      renderService: f.renderService,
    });
    f.bufferService.buffer.x = 7;
    f.bufferService.buffer.y = 2;
    f.textarea.fireFocus();
    expect(f.textarea.style.left).toBe('70px');
    expect(f.textarea.style.top).toBe('40px');
  });

  it('compositionstart 重新拍锁', () => {
    const f = makeFakes({ withDimensions: true, withCompositionHelper: true });
    attachImeCaretPositioner({
      textarea: f.textarea,
      core: f.core,
      compositionHelper: f.compositionHelper,
      bufferService: f.bufferService,
      renderService: f.renderService,
    });
    f.bufferService.buffer.x = 1;
    f.textarea.fireFocus();
    f.bufferService.buffer.x = 9; // 光标移动
    f.textarea.fireStart();
    expect(f.textarea.style.left).toBe('90px'); // 重锁到新位置
  });

  it('input(非 composition)重新拍锁;composition 中(isComposing=true)不重锁', () => {
    const f = makeFakes({ withDimensions: true, withCompositionHelper: true });
    attachImeCaretPositioner({
      textarea: f.textarea,
      core: f.core,
      compositionHelper: f.compositionHelper,
      bufferService: f.bufferService,
      renderService: f.renderService,
    });
    f.bufferService.buffer.x = 2;
    f.textarea.fireFocus();
    expect(f.textarea.style.left).toBe('20px');

    // 非 composition 的 input → 重锁到新光标
    f.bufferService.buffer.x = 6;
    f.textarea.fireInput();
    expect(f.textarea.style.left).toBe('60px');

    // composition 中的 input → 不重锁,位置停在 60px
    f.compositionHelper.isComposing = true;
    f.bufferService.buffer.x = 50;
    f.textarea.fireInput();
    expect(f.textarea.style.left).toBe('60px');
  });

  it('_syncTextArea 被覆盖:调用它不触达原实现(origSync 调用数 0)', () => {
    const f = makeFakes({ withDimensions: true, withCompositionHelper: true });
    attachImeCaretPositioner({
      textarea: f.textarea,
      core: f.core,
      compositionHelper: f.compositionHelper,
      bufferService: f.bufferService,
      renderService: f.renderService,
    });
    f.bufferService.buffer.x = 4;
    f.core._syncTextArea(); // 模拟 xterm onCursorMove 触发
    expect(f.origSyncCalls).toBe(0); // 原实现完全被取代
    expect(f.textarea.style.left).toBe('40px'); // 走 writePosition
  });

  it('_syncTextArea 在 lock 未拍时先从 live buffer 拍一次再定位', () => {
    const f = makeFakes({ withDimensions: true, withCompositionHelper: true });
    attachImeCaretPositioner({
      textarea: f.textarea,
      core: f.core,
      compositionHelper: f.compositionHelper,
      bufferService: f.bufferService,
      renderService: f.renderService,
    });
    // 不 fire focus,直接 _syncTextArea(term.open 后首次 cursorMove 可能在 focus 前)
    f.bufferService.buffer.x = 8;
    f.bufferService.buffer.y = 1;
    f.core._syncTextArea();
    expect(f.textarea.style.left).toBe('80px');
    expect(f.textarea.style.top).toBe('20px');
  });

  it('updateCompositionElements wrap:orig 看到被 swap 成 lock 的 buffer.x/y,调完还原,之后 textarea 被 writePosition', () => {
    const f = makeFakes({ withDimensions: true, withCompositionHelper: true });
    attachImeCaretPositioner({
      textarea: f.textarea,
      core: f.core,
      compositionHelper: f.compositionHelper,
      bufferService: f.bufferService,
      renderService: f.renderService,
    });
    // compositionstart 在 {5,2} 拍锁
    f.bufferService.buffer.x = 5;
    f.bufferService.buffer.y = 2;
    f.textarea.fireStart();
    // 此刻 live cursor 已被 TUI 挪到 {30,30}(抖动)
    f.bufferService.buffer.x = 30;
    f.bufferService.buffer.y = 30;
    f.textarea.style.left = '';
    // composition 每帧调 updateCompositionElements
    f.compositionHelper.updateCompositionElements();
    expect(f.observed).toEqual([{ x: 5, y: 2, skipRecurse: undefined }]); // orig 看到锁值
    // buffer.x/y 已被还原成 live 值,不污染 xterm 状态
    expect(f.bufferService.buffer.x).toBe(30);
    expect(f.bufferService.buffer.y).toBe(30);
    // textarea 被 writePosition 钉回锁位置
    expect(f.textarea.style.left).toBe('50px');
    expect(f.textarea.style.top).toBe('40px');
  });

  it('updateCompositionElements wrap:orig 抛异常时 buffer.x/y 仍被还原(try/finally 不变式)', () => {
    // 用一个 orig 会抛的独立 fake —— orig 必须在 attach 捕获它之前就会抛。
    const bufferService: BufferServiceLike = {
      buffer: { x: 0, y: 0 },
      cols: 80,
      rows: 24,
    };
    const renderService: RenderServiceLike = {
      dimensions: { css: { cell: { width: 10, height: 20 } } },
    };
    const compositionHelper = {
      isComposing: false,
      updateCompositionElements(): void {
        throw new Error('boom');
      },
    };
    const core: CoreLike = {
      _syncTextArea: (): void => undefined,
      _renderService: renderService,
      _bufferService: bufferService,
    };
    const textarea = new FakeTextarea();
    attachImeCaretPositioner({
      textarea,
      core,
      compositionHelper,
      bufferService,
      renderService,
    });
    // compositionstart 在 {5,2} 拍锁
    bufferService.buffer.x = 5;
    bufferService.buffer.y = 2;
    textarea.fireStart();
    // live cursor 挪到 {30,30}
    bufferService.buffer.x = 30;
    bufferService.buffer.y = 30;
    // 调 wrap —— orig 抛,但 wrap 的 try/finally 必须先把 buffer.x/y 还原
    expect(() => compositionHelper.updateCompositionElements()).toThrow('boom');
    expect(bufferService.buffer.x).toBe(30); // 还原成 live 值,不卡在锁值 5
    expect(bufferService.buffer.y).toBe(30);
  });

  it('detach:还原 _syncTextArea 与 updateCompositionElements、拆掉全部 listener、lock 清空', () => {
    const f = makeFakes({ withDimensions: true, withCompositionHelper: true });
    const origSyncRef = f.core._syncTextArea;
    const origUpdateRef = f.compositionHelper.updateCompositionElements;
    const detach = attachImeCaretPositioner({
      textarea: f.textarea,
      core: f.core,
      compositionHelper: f.compositionHelper,
      bufferService: f.bufferService,
      renderService: f.renderService,
    });
    expect(f.core._syncTextArea).not.toBe(origSyncRef); // 已被覆盖
    expect(f.compositionHelper.updateCompositionElements).not.toBe(
      origUpdateRef,
    );
    detach();
    expect(f.core._syncTextArea).toBe(origSyncRef); // 还原
    expect(f.compositionHelper.updateCompositionElements).toBe(origUpdateRef);
    expect(f.textarea.listenerCount()).toBe(0); // listener 全拆
    // detach 后再 fire focus 不应再 writePosition(lock 已清)
    f.textarea.style.left = '';
    f.bufferService.buffer.x = 9;
    f.textarea.fireFocus();
    expect(f.textarea.style.left).toBe('');
  });

  it('detach 不覆盖第三方后挂的 _syncTextArea(当前!==patched 时跳过还原)', () => {
    const f = makeFakes({ withDimensions: true, withCompositionHelper: true });
    const detach = attachImeCaretPositioner({
      textarea: f.textarea,
      core: f.core,
      compositionHelper: f.compositionHelper,
      bufferService: f.bufferService,
      renderService: f.renderService,
    });
    const thirdParty = (): void => undefined;
    f.core._syncTextArea = thirdParty; // 第三方覆盖
    detach();
    expect(f.core._syncTextArea).toBe(thirdParty); // 没被我们还原覆盖
  });

  it('compositionHelper 缺失:只挂 _syncTextArea,搜狗路径仍工作(不抛)', () => {
    const f = makeFakes({ withDimensions: true, withCompositionHelper: false });
    expect(() =>
      attachImeCaretPositioner({
        textarea: f.textarea,
        core: f.core,
        // compositionHelper 不传
        bufferService: f.bufferService,
        renderService: f.renderService,
      }),
    ).not.toThrow();
    f.bufferService.buffer.x = 6;
    f.textarea.fireFocus();
    expect(f.textarea.style.left).toBe('60px');
  });
});
