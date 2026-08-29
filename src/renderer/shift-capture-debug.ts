/**
 * @file src/renderer/shift-capture-debug.ts
 * @purpose [DEBUG-shift2] 临时诊断:终端内容偶发"整体左移 + 底部滚动条"bug 的
 *          自动捕获器。仅在 MARINA_SHIFT_CAPTURE=1 启动时激活(见 preload)。
 *
 * @背景:用户报告(2026-08-02):pi 空闲时打字/点击终端,内容偶发整体向左
 *        偏移几个字符宽,伴随底部出现(横向)滚动条;下一次按键恢复正常。
 *        已排除:OSC parser 丢字节(模糊测试)、webgl addon 版本错位(逐字节
 *        相同)、窗口级横向溢出(.app-root overflow:hidden)、xterm 自绘横向
 *        滚动条(硬禁用)。剩余最强候选是 .xterm-viewport(overflow-y:scroll
 *        ⇒ overflow-x 计算为 auto)出现水平溢出 —— 但需要现场证据。
 *
 * @工作方式:每 250ms 采样一次 active 终端的 DOM 几何:
 *   1. .xterm-viewport 的 scrollWidth > clientWidth+1(预测的"底部横条"来源)
 *   2. terminal-host 子树里任何 overflow-x ∈ {auto,scroll} 且溢出的元素
 *   3. documentElement 横向溢出(窗口级兜底,理论不可能,防御性保留)
 *   4. .xterm-screen / .xterm-scrollable-element / canvas 的 left/width 相对
 *      滚动基线漂移 > 0.5px(捕捉"内容整体位移"本身,无论何种成因)
 *   异常时:console.warn + 上报 main(logs/shift-capture-*.log + 窗口 PNG 截图),
 *   然后重置基线(继续捕捉下一次)。
 *
 * @结案后删除:本文件 + TerminalView 挂载点 + protocol DEBUG_SHIFT_CAPTURE
 *            + preload shiftCaptureEnabled + main ipc handler。grep: DEBUG-shift2
 */

import type { Terminal } from '@xterm/xterm';
import { COMMAND_CHANNELS } from '@shared/protocol';

/** 上报最小间隔 —— 同一异常持续存在时避免风暴,但 console 逐条打。 */
const REPORT_MIN_INTERVAL_MS = 2000;
/** 采样周期。异常持续到下一次按键(用户可见数秒),250ms 足够密。 */
const POLL_MS = 250;

interface ElementGeo {
  left: number;
  width: number;
  overflowX: string;
  clientWidth: number;
  scrollWidth: number;
}

function readGeo(el: Element | null): ElementGeo | null {
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return {
    left: +rect.left.toFixed(1),
    width: +rect.width.toFixed(1),
    overflowX: cs.overflowX,
    clientWidth: el.clientWidth,
    scrollWidth: el.scrollWidth,
  };
}

function dumpTree(root: HTMLElement): string {
  const out: string[] = [];
  const walk = (el: Element, depth: number): void => {
    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    out.push(
      `${'  '.repeat(depth)}${el.tagName}.${[...el.classList].join('.')} ` +
        `[${Math.round(rect.width)}x${Math.round(rect.height)}@${rect.left.toFixed(1)}] ` +
        `ovX=${cs.overflowX} cw=${el.clientWidth} sw=${el.scrollWidth}`,
    );
    for (const child of el.children) walk(child, depth + 1);
  };
  walk(root, 0);
  return out.join('\n');
}

/**
 * 给一个 active 终端挂检测器。
 *
 * @param container .terminal-host 元素(检测范围)
 * @param term 该 slot 的 xterm 实例(读 cols/rows + onResize 事件)
 * @param sessionId 上报用
 * @returns 卸载函数(unmount / slot 转 parked 时调用)
 */
export function attachShiftCapture(
  container: HTMLElement,
  term: Terminal,
  sessionId: string,
): () => void {
  const ring: string[] = [];
  const log = (m: string): void => {
    const line = `${new Date().toISOString()} ${m}`;
    ring.push(line);
    if (ring.length > 60) ring.shift();
  };
  log(`shift-capture attached sessionId=${sessionId}`);

  const baseline: Record<string, unknown> = {};
  const readSnapshot = (): Record<string, unknown> => ({
    dpr: window.devicePixelRatio,
    cols: term.cols,
    rows: term.rows,
    viewport: readGeo(container.querySelector('.xterm-viewport')),
    scrollable: readGeo(container.querySelector('.xterm-scrollable-element')),
    screen: readGeo(container.querySelector('.xterm-screen')),
    canvas: readGeo(container.querySelector('.xterm-screen canvas')),
    textarea: readGeo(container.querySelector('.xterm-helper-textarea')),
    pageScrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
    vbarClasses: container
      .querySelector('.xterm-scrollbar.xterm-vertical')
      ?.className.toString() ?? null,
    hbarClasses: container
      .querySelector('.xterm-scrollbar.xterm-horizontal')
      ?.className.toString() ?? null,
  });

  let lastReportAt = 0;
  const report = (kind: string, problems: string[]): void => {
    const snapshot = readSnapshot();
    const payload = {
      sessionId,
      kind,
      problems,
      snapshot,
      tree: dumpTree(container).slice(0, 20_000),
      recent: ring.slice(-30),
    };
    // eslint-disable-next-line no-console
    console.warn(`[SHIFT-CAPTURE] kind=${kind} problems=${problems.join('; ')}`, payload);
    const now = Date.now();
    if (now - lastReportAt >= REPORT_MIN_INTERVAL_MS) {
      lastReportAt = now;
      void window.api
        .invoke(COMMAND_CHANNELS.DEBUG_SHIFT_CAPTURE, {
          sessionId,
          kind,
          problems,
          snapshot: { ...snapshot, tree: payload.tree, recent: payload.recent },
        })
        .catch(() => {});
    }
    // 重置基线:异常上报后,后续采样捕捉"恢复"或"下一次漂移"
    Object.assign(baseline, JSON.parse(JSON.stringify(snapshot)));
  };

  const check = (): void => {
    const s = readSnapshot();
    if (!baseline.viewport) {
      Object.assign(baseline, JSON.parse(JSON.stringify(s)));
      return;
    }
    const problems: string[] = [];

    for (const key of ['viewport', 'scrollable', 'screen', 'canvas'] as const) {
      const cur = s[key] as ElementGeo | null;
      const was = baseline[key] as ElementGeo | null;
      if (!cur || !was) continue;
      if (Math.abs(cur.left - was.left) > 0.5) {
        problems.push(`${key}.left ${was.left} -> ${cur.left}`);
      }
      if (Math.abs(cur.width - was.width) > 0.5) {
        problems.push(`${key}.width ${was.width} -> ${cur.width}`);
      }
      if ((cur.overflowX === 'auto' || cur.overflowX === 'scroll') && cur.scrollWidth > cur.clientWidth + 1) {
        problems.push(`${key} H-OVERFLOW sw=${cur.scrollWidth} cw=${cur.clientWidth}`);
      }
    }
    if ((s.pageScrollW as number) > (s.innerW as number) + 1) {
      problems.push(`PAGE H-OVERFLOW scrollW=${s.pageScrollW} innerW=${s.innerW}`);
    }
    if (s.cols !== baseline.cols || s.rows !== baseline.rows) {
      log(`cols/rows ${baseline.cols}x${baseline.rows} -> ${s.cols}x${s.rows}`);
    }
    if (problems.length > 0) {
      report('geometry-anomaly', problems);
    } else {
      Object.assign(baseline, JSON.parse(JSON.stringify(s)));
    }
  };

  const timer = window.setInterval(check, POLL_MS);
  const resizeSub = term.onResize(({ cols, rows }) => {
    log(`term.onResize -> ${cols}x${rows}`);
    // resize 本身合法地改变几何:记事件,重置基线,避免误报
    Object.assign(baseline, JSON.parse(JSON.stringify(readSnapshot())));
  });

  log('detector running');
  return () => {
    window.clearInterval(timer);
    resizeSub.dispose();
  };
}
