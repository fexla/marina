// [BETA-019 DEBUG] HUD 组件 — 嵌在标题栏中间,250ms 轮询当前活动 session 的
// xterm 内部 cursor 状态。复现"运行一段时间出现闪烁光标"时,直接看 HUD 上的
// `hide:` 字段在哪一刻从 T 翻到 F,即定位 root cause(是 ?25h、DECSTR 还是 RIS)。
//
// 本组件 + beta019-cursor-hud.ts 完成定位后可整体删除。
import { useEffect, useRef, useState } from 'react';
import { useAppState } from '../store';
import { getTerminal, sampleCursor, type CursorSnapshot } from '../debug/beta019-cursor-hud';

interface HudState {
  snap: CursorSnapshot;
  hideFlips: number;          // isCursorHidden 跳变次数(true↔false)
  lastFlipAt: number | null;  // 最后一次跳变时刻(ms since mount)
  lastFlipFromTo: string;     // 最后一次跳变方向,如 "T→F"
}

export function Beta019CursorHud(): JSX.Element | null {
  const state = useAppState();
  const sessionId = state.selectedSessionId;
  const session = sessionId ? state.sessions.get(sessionId) : undefined;

  const [hud, setHud] = useState<HudState>({
    snap: {
      cursorHidden: null,
      cursorInitialized: null,
      blink: null,
      style: null,
      cursorX: null,
      cursorY: null,
      bufferY: null,
    },
    hideFlips: 0,
    lastFlipAt: null,
    lastFlipFromTo: '',
  });

  // 用 ref 保存"上一次的 hidden 值"和"组件 mount 时刻",跨 setInterval 回调可见
  const lastHiddenRef = useRef<boolean | null>(null);
  const mountedAtRef = useRef<number>(Date.now());

  // session 切换时重置翻转计数(新 Terminal 实例,前一个的计数无意义)
  useEffect(() => {
    lastHiddenRef.current = null;
    mountedAtRef.current = Date.now();
    setHud((h) => ({ ...h, hideFlips: 0, lastFlipAt: null, lastFlipFromTo: '' }));
  }, [sessionId]);

  useEffect(() => {
    const id = window.setInterval(() => {
      const term = getTerminal(sessionId);
      const snap = sampleCursor(term);
      const prev = lastHiddenRef.current;
      const cur = snap.cursorHidden;
      let flipped = false;
      let flipFromTo = '';
      if (prev !== null && cur !== null && prev !== cur) {
        flipped = true;
        flipFromTo = `${prev ? 'T' : 'F'}→${cur ? 'T' : 'F'}`;
      }
      lastHiddenRef.current = cur;
      setHud((h) => ({
        snap,
        hideFlips: flipped ? h.hideFlips + 1 : h.hideFlips,
        lastFlipAt: flipped ? Date.now() - mountedAtRef.current : h.lastFlipAt,
        lastFlipFromTo: flipped ? flipFromTo : h.lastFlipFromTo,
      }));
    }, 250);
    return () => window.clearInterval(id);
  }, [sessionId]);

  if (!sessionId) return null;

  const { snap, hideFlips, lastFlipAt, lastFlipFromTo } = hud;
  const hideStr = snap.cursorHidden === null ? '?' : snap.cursorHidden ? 'T' : 'F';
  // 正常态光标应隐藏 → hide=T 是绿色;hide=F 在 TUI 输出时就是 bug 现象 → 红色
  const hideColor = snap.cursorHidden === false ? '#ff5d9e' : snap.cursorHidden === true ? '#9ccfd8' : '#888';
  const flipsColor = hideFlips > 1 ? '#ff5d9e' : '#888';
  const blinkStr = snap.blink === null ? '?' : snap.blink ? 'T' : 'F';
  const styleStr = snap.style ?? '?';
  const xy = `${snap.cursorX ?? '?'},${snap.cursorY ?? '?'}`;
  const flipAt = lastFlipAt === null ? '—' : `${(lastFlipAt / 1000).toFixed(1)}s`;
  const sessState = session?.state ?? '?';

  return (
    <div
      className="titlebar-drag"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 8px',
        fontFamily: 'Consolas, monospace',
        fontSize: 11,
        color: '#aaa',
        userSelect: 'none',
        whiteSpace: 'nowrap',
      }}
      title="[BETA-019 DEBUG] xterm cursor 状态实时采样。hide=T 是正常(光标隐藏),hide=F 表示 ?25l 被翻回 → bug。flips>1 说明运行中发生过翻转,记下 flipAt 看是哪个时刻。"
    >
      <span>BETA-019</span>
      <span>
        hide:<span style={{ color: hideColor, fontWeight: 600 }}>{hideStr}</span>
      </span>
      <span>blink:{blinkStr}</span>
      <span>style:{styleStr}</span>
      <span>xy:[{xy}]</span>
      <span>
        flips:<span style={{ color: flipsColor, fontWeight: 600 }}>{hideFlips}</span>
        {lastFlipFromTo && <span style={{ color: '#888' }}>({lastFlipFromTo}@{flipAt})</span>}
      </span>
      <span>state:{sessState}</span>
    </div>
  );
}
