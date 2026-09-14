/**
 * @file TerminalAuxBar.tsx
 * @purpose 移动端(Android WebView 壳,ADR-042 决策 4)终端辅助键条:软键盘
 *   没有物理键的 Esc / Tab / 方向 / Ctrl 组合等,没有这排键触屏终端基本不可用。
 *
 * @关键设计:
 * - 键条对「当前活跃 session」生效,由 MainPane 渲染在 .terminal-workspace
 *   底部(不进 TerminalDeck —— deck-slot 是 absolute inset:0 会盖住它)。
 * - 发送路径与 xterm onData 等价:字节序列 → base64 → SESSION_SEND_INPUT
 *   (backend-data)。不经过 xterm —— 输入回显靠 PTY 返回的字节流,直发 IPC
 *   与物理键完全同路,因此 parked/inactive 不会误收(我们只在 active 时渲染)。
 * - 方向键发 CSI 序列(\x1b[A 等)。vi 等应用程序光标模式(DECCKNM)下应为
 *   \x1bOA —— v1 先发 CSI(绝大多数 shell/REPL 场景正确),应用程序模式
 *   差异随触屏选择/滚动一起在后续打磨。
 * - 双指缩放字号(= 桌面 Ctrl+滚轮的触屏等价)也挂在本组件:对 Deck 根元素
 *   监听 touch,写 SETTINGS_UPDATE_APPEARANCE —— 外观归客户端(ADR-029),
 *   远程窗口改本机字号不能写 daemon。写后经 local-control 事件 → store →
 *   TerminalView 的 fontSize effect 自动 re-fit,闭环不碰 xterm 实例。
 *
 * @不要在这里做的事:
 * - 不要发未在 KEYS 表里的序列(键集与 ADR-042 决策 4 的触屏键承诺对齐)
 * - 不要在桌面布局渲染(调用方 useIsMobile 已 guard)
 */

import { useCallback, useEffect, useRef } from 'react';
import { COMMAND_CHANNELS } from '@shared/protocol';
import { useAppState } from '../store';

/** 键条布局(从左到右,横向滚动)。seq 是发给 PTY 的原始字节。 */
interface AuxKeyDef {
  label: string;
  seq: string;
  /** aria 用的人读名 */
  name: string;
}

const KEYS: readonly AuxKeyDef[] = [
  { label: 'Esc', seq: '\x1b', name: 'Escape' },
  { label: 'Tab', seq: '\t', name: 'Tab' },
  { label: '↑', seq: '\x1b[A', name: '上方向' },
  { label: '↓', seq: '\x1b[B', name: '下方向' },
  { label: '←', seq: '\x1b[D', name: '左方向' },
  { label: '→', seq: '\x1b[C', name: '右方向' },
  { label: 'PgUp', seq: '\x1b[5~', name: '上翻页' },
  { label: 'PgDn', seq: '\x1b[6~', name: '下翻页' },
  { label: 'Home', seq: '\x1b[H', name: '行首' },
  { label: 'End', seq: '\x1b[F', name: '行尾' },
  { label: 'Ctrl+C', seq: '\x03', name: '中断' },
  { label: 'Ctrl+D', seq: '\x04', name: 'EOF' },
  { label: 'Ctrl+Z', seq: '\x1a', name: '挂起' },
  { label: 'Ctrl+L', seq: '\x0c', name: '清屏' },
];

/** 与桌面 Ctrl+滚轮(M1-I)相同的字号上下限。 */
const FONT_MIN = 8;
const FONT_MAX = 24;

/**
 * 双指捏合累计变化超过该比例才 ±1px —— 阈值太小会因触点抖动连跳,
 * 太大则调一格要张合很大。1.12 对应约两指张开 12%。
 */
const PINCH_STEP_RATIO = 1.12;

export function TerminalAuxBar({ sessionId }: { sessionId: string }): JSX.Element {
  const sendKey = useCallback(
    (seq: string) => {
      // 键序列均为单字节 ASCII,直接 btoa(与 TerminalView 的
      // encodeStringToBase64 小串路径等价;那里的大串分片逻辑对本表无意义)。
      window.api
        .invoke(COMMAND_CHANNELS.SESSION_SEND_INPUT, {
          sessionId,
          data: btoa(
            Array.from(new TextEncoder().encode(seq))
              .map((b) => String.fromCharCode(b))
              .join(''),
          ),
        })
        .catch((err: unknown) =>
          console.error('[TerminalAuxBar] send-key failed', err),
        );
    },
    [sessionId],
  );

  return (
    <div className="terminal-aux-bar" role="toolbar" aria-label="终端辅助键">
      {KEYS.map((k) => (
        <button
          key={k.label}
          type="button"
          className="terminal-aux-key"
          onClick={() => sendKey(k.seq)}
          aria-label={k.name}
          title={k.name}
        >
          {k.label}
        </button>
      ))}
    </div>
  );
}

/**
 * 双指缩放终端字号。返回一个 ref,调用方挂到终端容器(MainPane 的
 * .terminal-workspace);内部在 effect 里用**原生 addEventListener(passive:
 * false)** 监听 —— 不用 React onTouch*:React 合成 touch 在部分 WebView 下
 * preventDefault 时机不可靠,双指会被浏览器手势管道吃掉,原生 passive:false
 * 才能稳定抢到事件(CDP 合成手势下实测 React 路径收不到 touchmove)。
 *
 * 手势:两指按下记初始距离/字号;滑动中按比值取步进(每跨 PINCH_STEP_RATIO
 * 倍 ±1px);松手清零。写 SETTINGS_UPDATE_APPEARANCE 走 150ms trailing
 * debounce —— 与桌面 wheel 的防抖同思路,避免缩放期间事件风暴。
 */
export function usePinchFontSize(enabled: boolean): React.RefObject<HTMLDivElement> {
  const state = useAppState();
  const baseFontSize = state.settings.appearance?.terminalFontSize ?? 13;
  const ref = useRef<HTMLDivElement>(null);

  // ref 镜像:effect 闭包要读最新字号,不重挂 listener
  const pinchRef = useRef<{ startDist: number; startFont: number } | null>(null);
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingFontRef = useRef<number | null>(null);
  const baseFontRef = useRef(baseFontSize);
  baseFontRef.current = baseFontSize;

  const writeDebounced = useCallback((size: number) => {
    pendingFontRef.current = size;
    if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
    writeTimerRef.current = setTimeout(() => {
      writeTimerRef.current = null;
      const settled = pendingFontRef.current;
      pendingFontRef.current = null;
      if (settled === null) return;
      // ADR-029:外观归客户端机器。远程窗口里改字号写【本机】local-control,
      // 不是所连 daemon(桌面 wheel 走 SETTINGS_UPDATE 写 daemon 是历史路径,
      // 移动端按正确归属走)。
      void window.api.invoke(COMMAND_CHANNELS.SETTINGS_UPDATE_APPEARANCE, {
        partial: { terminalFontSize: settled },
      });
    }, 150);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return undefined;

    const distance = (e: TouchEvent): number | null => {
      const a = e.touches[0];
      const b = e.touches[1];
      if (!a || !b) return null;
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    };

    const onTouchStart = (e: TouchEvent): void => {
      const d = distance(e);
      if (d === null || d < 10) return; // 两指几乎重合,视为误触
      pinchRef.current = { startDist: d, startFont: baseFontRef.current };
    };

    const onTouchMove = (e: TouchEvent): void => {
      const pinch = pinchRef.current;
      if (!pinch) return;
      const d = distance(e);
      if (d === null) return;
      // pinch 进行中阻止滚动/缩放默认行为(xterm scrollback 不应跟着动)
      e.preventDefault();
      const ratio = d / pinch.startDist;
      // 相对捏合起始字号的倍率,每跨过 PINCH_STEP_RATIO 倍 ±1px:
      // 张开 ratio>1 → 步数 = floor(log(ratio)/log(1.12)),
      // 捏小 ratio<1 → 步数 = -floor(log(1/ratio)/log(1.12))。
      const steps =
        ratio >= 1
          ? Math.floor(Math.log(ratio) / Math.log(PINCH_STEP_RATIO))
          : -Math.floor(Math.log(1 / ratio) / Math.log(PINCH_STEP_RATIO));
      const target = Math.max(FONT_MIN, Math.min(FONT_MAX, pinch.startFont + steps));
      if (target !== pinch.startFont || pendingFontRef.current !== null) {
        writeDebounced(target);
      }
    };

    const onTouchEnd = (e: TouchEvent): void => {
      if (e.touches.length < 2) {
        pinchRef.current = null;
      }
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [enabled, writeDebounced]);

  return ref;
}
