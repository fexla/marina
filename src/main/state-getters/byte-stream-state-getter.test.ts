import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ByteStreamStateGetter } from './byte-stream-state-getter';

/**
 * ByteStreamStateGetter 单测:把原埋在 SessionManager.handlePtyData 里的
 * quiet 窗口 + lastSignificantByte 判断抽出来独立测,不用造 PTY 时序。
 */
describe('ByteStreamStateGetter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeGetter(opts: { graceMs?: number; resizeMs?: number; inputMs?: number; thresholdMs?: number } = {}) {
    return new ByteStreamStateGetter(
      opts.graceMs ?? 1500,
      opts.resizeMs ?? 500,
      opts.inputMs ?? 200,
      () => opts.thresholdMs ?? 3000,
    );
  }

  it('startupGrace 期内 onByte 不点亮 → idle(BETA-008:新建终端不闪绿)', () => {
    const g = makeGetter({ graceMs: 1500 }); // graceUntil=1500
    g.onByte(); // now=0,grace 内
    expect(g.getState()).toBe('idle');
  });

  it('startupGrace 过期后 onByte 点亮 → active', () => {
    const g = makeGetter({ graceMs: 1500 });
    vi.setSystemTime(1600); // 过 grace
    g.onByte();
    expect(g.getState()).toBe('active');
  });

  it('resize quiet 窗口内 onByte 不点亮(CP-3:ConPTY/SIGWINCH 重绘不闪绿)', () => {
    const g = makeGetter({ graceMs: 0, resizeMs: 500 });
    vi.setSystemTime(100); // 过 grace(graceMs=0 → graceUntil=0)
    g.onResize(); // resizeQuietUntil=600
    g.onByte(); // now=100 < 600,quiet
    expect(g.getState()).toBe('idle');
    // quiet 过期后字节点亮
    vi.setSystemTime(601);
    g.onByte();
    expect(g.getState()).toBe('active');
  });

  it('input echo quiet 窗口内 onByte 不点亮(普通键 echo / TUI 重绘不闪)', () => {
    const g = makeGetter({ graceMs: 0, inputMs: 200 });
    vi.setSystemTime(100);
    g.onInput(false); // 普通键,inputQuietUntil=300
    g.onByte(); // now=100 < 300,quiet
    expect(g.getState()).toBe('idle');
  });

  it('Enter onInput 关闭 quiet(CUR-1:紧随的真实命令输出立即 active)', () => {
    const g = makeGetter({ graceMs: 0, inputMs: 200 });
    vi.setSystemTime(100);
    g.onInput(true); // Enter → inputQuietUntil=0
    g.onByte(); // quiet 已关,字节点亮
    expect(g.getState()).toBe('active');
  });

  it('onByte 点亮后,过 threshold → idle(idle 定时器到期语义)', () => {
    const g = makeGetter({ graceMs: 0, thresholdMs: 3000 });
    vi.setSystemTime(1000);
    g.onByte(); // 点亮,lastSignificantByte=1000
    expect(g.getState()).toBe('active');
    // 阈值内仍 active
    vi.setSystemTime(3999);
    expect(g.getState()).toBe('active');
    // 过阈值 → idle
    vi.setSystemTime(4001);
    expect(g.getState()).toBe('idle');
  });

  it('从未 onByte → idle(初始 idle,BETA-008)', () => {
    const g = makeGetter({ graceMs: 0 });
    vi.setSystemTime(10000);
    expect(g.getState()).toBe('idle');
  });

  it('getThresholdMs 运行时读:settings 变化生效(不快照)', () => {
    let threshold = 3000;
    const g = new ByteStreamStateGetter(0, 500, 200, () => threshold);
    vi.setSystemTime(1000);
    g.onByte();
    vi.setSystemTime(3500); // 距字节 2500ms < 3000 → active
    expect(g.getState()).toBe('active');
    threshold = 1000; // settings 变化
    expect(g.getState()).toBe('idle'); // 现在 2500 > 1000 → idle
  });
});
