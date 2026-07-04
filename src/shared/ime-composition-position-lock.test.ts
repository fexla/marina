/**
 * @file src/shared/ime-composition-position-lock.test.ts
 * @purpose IME-2 workaround 护栏测试 — 防止未来 xterm 升级 / TerminalView
 *   重构时悄悄删掉位置锁定 patch,或破坏 swap-restore 的不变式。
 *
 *   这不是「复现 bug 的测试」。IME 候选框跟 spinner 跳的根因在
 *   @xterm/xterm CompositionHelper 把 updateCompositionElements 挂在 onRender
 *   + setTimeout(0) 自递归(详见 docs/issues/ime-2-*.md),需要 OS 级 IME +
 *   真实 TUI 重绘才能在视觉上看到漂移,Node 环境复现不出来也没有意义。
 *
 *   这里测的是我们写的 patch「**还在生效**」 — 即:
 *   1. compositionstart 后,被 patch 的 updateCompositionElements 看到的
 *      buffer.x/y 是锁定快照,不是实时值
 *   2. compositionend 后立刻解锁,后续调用看到实时值
 *   3. swap-restore 在 origUpdate 内同步完成,且即使抛异常也还原(否则
 *      xterm 下次正常 render 看到的 cursor 位置就错了)
 *   4. detach 后侦听器拆掉,helper 上的方法还原为原版
 *   5. fallback 路径:helper / bufferService 字段缺失时 attach 失败但不崩
 *      —— 在 TerminalView 调用端覆盖(本测试不直接测,因为 attach 签名
 *      要求字段已经传进来,字段是否存在的判定在 renderer 侧)
 */
import { describe, expect, it } from 'vitest';
import {
  attachImeCompositionPositionLock,
  type BufferServiceLike,
  type CompositionHelperLike,
  type CompositionTextareaLike,
} from './ime-composition-position-lock';

/**
 * Fake textarea — 只支持 compositionstart / compositionend 的 listener 集合。
 */
class FakeTextarea implements CompositionTextareaLike {
  private starts = new Set<() => void>();
  private ends = new Set<() => void>();

  addEventListener(
    type: 'compositionstart' | 'compositionend',
    listener: () => void,
  ): void {
    (type === 'compositionstart' ? this.starts : this.ends).add(listener);
  }

  removeEventListener(
    type: 'compositionstart' | 'compositionend',
    listener: () => void,
  ): void {
    (type === 'compositionstart' ? this.starts : this.ends).delete(listener);
  }

  fireStart(): void {
    for (const l of this.starts) l();
  }
  fireEnd(): void {
    for (const l of this.ends) l();
  }

  listenerCount(): number {
    return this.starts.size + this.ends.size;
  }
}

/**
 * 构造 fake bufferService + fake compositionHelper,
 * helper.update 内部模仿 xterm 真实行为:读 bufferService.buffer.x/y 写下 spy。
 */
function makeFakes(initialX: number, initialY: number) {
  const bufferService: BufferServiceLike = {
    buffer: { x: initialX, y: initialY },
  };

  /** 每次 update 被调用时,记录此刻 helper 看到的 buffer.x/y */
  const observed: Array<{
    x: number;
    y: number;
    skipRecurse: boolean | undefined;
  }> = [];

  const helper: CompositionHelperLike = {
    updateCompositionElements(skipRecurse?: boolean): void {
      observed.push({
        x: bufferService.buffer.x,
        y: bufferService.buffer.y,
        skipRecurse,
      });
    },
  };

  return { bufferService, helper, observed };
}

describe('attachImeCompositionPositionLock (IME-2 workaround 护栏)', () => {
  it('非 composition 期间,patched update 看到的是实时 buffer.x/y', () => {
    const ta = new FakeTextarea();
    const { bufferService, helper, observed } = makeFakes(10, 5);
    attachImeCompositionPositionLock(ta, helper, bufferService);

    // 模拟 xterm 渲染若干帧 — 期间 cursor 移动(TUI 重绘)
    helper.updateCompositionElements();
    bufferService.buffer.x = 20;
    helper.updateCompositionElements();
    bufferService.buffer.y = 99;
    helper.updateCompositionElements();

    expect(observed).toEqual([
      { x: 10, y: 5, skipRecurse: undefined },
      { x: 20, y: 5, skipRecurse: undefined },
      { x: 20, y: 99, skipRecurse: undefined },
    ]);
  });

  it('compositionstart 后,后续 update 看到的是锁定快照,不随 buffer 变化', () => {
    const ta = new FakeTextarea();
    const { bufferService, helper, observed } = makeFakes(3, 7);
    attachImeCompositionPositionLock(ta, helper, bufferService);

    ta.fireStart(); // 拍快照:x=3, y=7

    // 模拟 TUI 一路重绘把 cursor 推到角落
    bufferService.buffer.x = 80;
    bufferService.buffer.y = 0;
    helper.updateCompositionElements();

    bufferService.buffer.x = 50;
    bufferService.buffer.y = 24;
    helper.updateCompositionElements(true);

    expect(observed).toEqual([
      { x: 3, y: 7, skipRecurse: undefined },
      { x: 3, y: 7, skipRecurse: true },
    ]);
  });

  it('swap-restore:origUpdate 调完之后 buffer.x/y 立刻被还原,不污染 xterm 自己的状态', () => {
    const ta = new FakeTextarea();
    const { bufferService, helper } = makeFakes(40, 12);
    attachImeCompositionPositionLock(ta, helper, bufferService);

    ta.fireStart();
    // composition 之后 TUI 又推了 cursor
    bufferService.buffer.x = 78;
    bufferService.buffer.y = 1;

    helper.updateCompositionElements();

    // 关键不变式:helper 调完之后,buffer.x/y 必须回到 78/1(实时值),
    // 不能留着 40/12(锁定值),否则 xterm 下一次普通渲染看到的 cursor 错位
    expect(bufferService.buffer.x).toBe(78);
    expect(bufferService.buffer.y).toBe(1);
  });

  it('compositionend 立刻解锁,之后 update 看到实时 buffer.x/y', () => {
    const ta = new FakeTextarea();
    const { bufferService, helper, observed } = makeFakes(1, 1);
    attachImeCompositionPositionLock(ta, helper, bufferService);

    ta.fireStart();
    bufferService.buffer.x = 50;
    bufferService.buffer.y = 10;
    helper.updateCompositionElements(); // 锁定:看到 1/1

    ta.fireEnd();
    helper.updateCompositionElements(); // 解锁:看到 50/10

    expect(observed).toEqual([
      { x: 1, y: 1, skipRecurse: undefined },
      { x: 50, y: 10, skipRecurse: undefined },
    ]);
  });

  it('嵌套 compositionstart:第二次 start 用 newer 快照(虽然 IME 一般不会嵌套,但行为要可预测)', () => {
    const ta = new FakeTextarea();
    const { bufferService, helper, observed } = makeFakes(0, 0);
    attachImeCompositionPositionLock(ta, helper, bufferService);

    bufferService.buffer.x = 5;
    bufferService.buffer.y = 5;
    ta.fireStart(); // 快照 1:5/5

    bufferService.buffer.x = 99;
    bufferService.buffer.y = 99;
    helper.updateCompositionElements(); // 看到 5/5

    bufferService.buffer.x = 30;
    bufferService.buffer.y = 30;
    ta.fireStart(); // 快照覆盖:30/30

    bufferService.buffer.x = 77;
    helper.updateCompositionElements(); // 看到 30/30

    expect(observed).toEqual([
      { x: 5, y: 5, skipRecurse: undefined },
      { x: 30, y: 30, skipRecurse: undefined },
    ]);
  });

  it('origUpdate 抛异常时,buffer.x/y 仍被还原(try/finally 不变式)', () => {
    const ta = new FakeTextarea();
    const bufferService: BufferServiceLike = { buffer: { x: 10, y: 10 } };
    const helper: CompositionHelperLike = {
      updateCompositionElements(): void {
        throw new Error('boom');
      },
    };
    attachImeCompositionPositionLock(ta, helper, bufferService);

    ta.fireStart(); // 锁定 10/10
    bufferService.buffer.x = 50;
    bufferService.buffer.y = 50;

    expect(() => helper.updateCompositionElements()).toThrow('boom');

    // 即使抛了,buffer.x/y 也要回到实时值 50/50,不能卡在锁定值 10/10
    expect(bufferService.buffer.x).toBe(50);
    expect(bufferService.buffer.y).toBe(50);
  });

  it('detach 后:method 还原为原版 + listener 全部拆掉', () => {
    const ta = new FakeTextarea();
    const { bufferService, helper, observed } = makeFakes(0, 0);
    const origRef = helper.updateCompositionElements;

    const detach = attachImeCompositionPositionLock(ta, helper, bufferService);
    expect(ta.listenerCount()).toBe(2);
    expect(helper.updateCompositionElements).not.toBe(origRef); // 已被 patch

    detach();
    expect(ta.listenerCount()).toBe(0);
    expect(helper.updateCompositionElements).toBe(origRef); // 还原

    // detach 后即便手动 fire start,也不影响后续 update — 因为现在是原版
    ta.fireStart();
    bufferService.buffer.x = 7;
    helper.updateCompositionElements();
    expect(observed).toEqual([{ x: 7, y: 0, skipRecurse: undefined }]);
  });

  it('detach 时如果方法已被第三方覆盖,不强行还原(防止覆盖第三方 patch)', () => {
    const ta = new FakeTextarea();
    const { bufferService, helper } = makeFakes(0, 0);
    const origRef = helper.updateCompositionElements;
    const detach = attachImeCompositionPositionLock(ta, helper, bufferService);

    // 模拟第三方在我们之上又 patch 了一层
    const thirdPartyPatch = function (): void {
      /* third-party */
    };
    helper.updateCompositionElements = thirdPartyPatch;

    detach();
    // 我们不能把它还原成 origRef,否则把第三方 patch 抹掉了
    expect(helper.updateCompositionElements).toBe(thirdPartyPatch);
    expect(helper.updateCompositionElements).not.toBe(origRef);
  });

  it('compositionend 在 start 之前(异常顺序):locked 始终 null,patched update 等同原实现', () => {
    const ta = new FakeTextarea();
    const { bufferService, helper, observed } = makeFakes(11, 22);
    attachImeCompositionPositionLock(ta, helper, bufferService);

    ta.fireEnd(); // start 还没来,locked 仍是 null,无副作用
    helper.updateCompositionElements();

    bufferService.buffer.x = 33;
    helper.updateCompositionElements();

    expect(observed).toEqual([
      { x: 11, y: 22, skipRecurse: undefined },
      { x: 33, y: 22, skipRecurse: undefined },
    ]);
  });
});
