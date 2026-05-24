/**
 * @file src/renderer/components/TerminalView.tsx
 * @purpose 把 xterm.js 实例附加到一个已存在的 session,完成双向字节流。
 *   session 由父组件 (Sidebar/MainPane) 通过 cmd:session:create 创建,
 *   TerminalView 只是 session 的"观察窗"。
 *
 * @关键前置条件 (CP-2 勘误后):
 *   props.session.ownerWindowId === myWindowId — 父级 MainPane 已通过
 *   getDisplayableSession 强制保证。"持有=显示"的不变量在此处兑现:
 *   isOwner 永远 true,不存在"接管会话"占位 UI。
 *
 * @关键设计:
 * - 主题颜色与 CSS variables 同步:settings.appearance.theme 变化 → xterm
 *   theme 实时切 (xterm 支持 term.options.theme = newTheme 运行时切换)
 * - 字节流: PTY → main → evt:session:output → atob → xterm.write
 *           xterm.onData → utf8 → base64 → cmd:session:send-input → main
 * - **Scrollback 重放协议** (避免历史与实时输出竞态):
 *   1. mount 时立即注册 output listener,但置于"buffering"模式 (data 进
 *      pending 数组,不直接 write)
 *   2. invoke cmd:session:get-scrollback → 拿到 (data, lastSeq)
 *   3. write scrollback → 把 pending 中 seq > lastSeq 的写入 → 切 listener
 *      为"直接写"模式
 *   4. **视口锚定 + host 整体隐藏 (SCROLL-1 两轮)**:
 *      4a. **fence 锚最终底** — 在第 3 步末尾用 `term.write('', cb)` 作
 *         fence,cb 内调 `term.scrollToBottom()`。**绝不能**在 `.then` 体里
 *         直接调 scrollToBottom — `term.write()` 是异步排队(d.ts:1216:
 *         "callback that fires when the data was processed by the parser"),
 *         此刻 parser 才刚开始消化 writeBuffer,viewport 锚的"底"还在跟着
 *         新行长,用户看到"从上往下刷屏到底部"。fence callback 由 xterm
 *         在 parser drain 后触发。
 *      4b. **host visibility:hidden + inert 防中间帧 + focus 错位**
 *         (2026-05-24,KBD-1 同 PR):仅靠 4a fence 还不够 — 分片 write +
 *         setTimeout(0) yield 之间 xterm RAF 会把"已处理 chunks 的部分
 *         buffer"画到 canvas 上,用户报"刷屏速度快多了但还在抖"。修法:
 *         mount 默认 `hostRevealed=false` → JSX 给 terminal-host 加
 *         visibility:hidden + inert,fence cb 内 scrollToBottom 后再过一帧
 *         RAF 才 setHostRevealed(true) reveal。`visibility:hidden` 保留
 *         layout(fit 仍能算尺寸)+ canvas pixel 继续累积,只跳屏幕
 *         compositing;`inert` 阻止 focus 落入子树,replay 期间用户按键
 *         不会误进 Sidebar/Modal 等其他 focusable 元素(产品决策:replay
 *         100-500ms 内按键不响应是有意为之,符合"切换中"直觉)。reveal
 *         后 useEffect 主动归还 focus 给 helper-textarea,继续可敲。
 *      任何未来改 scrollback 数据源 / 量级 / 视口管理的人都要重读
 *      docs/issues/scroll-1-session-switch-progressive-refresh.md 与
 *      docs/键盘交互规范.md(replay 期间 focus 行为不变式)。
 *   后续到达的 output 直接 term.write,无需去重 (lastSeq 为快照时刻)
 * - 用 sessionId 作 React key,session 切换时强制重建 xterm 实例
 *   (避免 viewport / 滚动状态错乱)
 * - 第一次 fit 后把真实 cols/rows 写回 store.lastTerminalDims,后续
 *   SESSION_CREATE 的初始尺寸用此值,避免 ConPTY spawn-then-resize 的
 *   PowerShell 横幅重画 quirk (用户勘误 #2)
 * - 组件卸载时不调 cmd:session:close (session 跨 mount 存活,
 *   关闭由 Tab × 显式触发 / 窗口关闭由 main 端 handleWindowClosed 处理)
 *
 * @CP-4 chunk 3 新增:
 * - SearchAddon + 搜索栏 (Ctrl+F 唤出,上一个/下一个/关闭/大小写)
 * - 右键菜单 (复制 / 粘贴 / 清屏 / 搜索) — 当 settings.behavior.terminalRightClick='menu'
 * - 直接粘贴 — 当 settings.behavior.terminalRightClick='paste'
 * - 选中即复制 — settings.behavior.selectOnCopy=true 时
 *
 * @CP-4 勘误:
 * - #6/#9: Ctrl+F / Esc 通过 term.attachCustomKeyEventHandler 拦截,避免 xterm
 *   把它们透传成 ^F / 0x1B 字节给 PTY (原 React onKeyDown 在 wrapper div 上,
 *   xterm 内部的 keydown 优先消费,所以 Ctrl+F 在终端 focus 时只会渲染成 ^F)
 * - #7: SearchAddon.onDidChangeResults 暴露命中数 → 搜索栏显示 "x / N"
 * - #8: 搜索按钮 / Enter 改用 ref 中的最新 searchText,避免 useCallback 闭包
 *   抓到旧值导致"按 Enter 跳的是上一次的关键字"
 * - #10: 多行粘贴前弹原生 confirm 警告,允许用户取消(类 Windows Terminal)
 *
 * @对应文档章节:
 *   软件定义书.md 5.1.4 (终端体验)、5.1.9 (主题)、6.6.2 (行为)、8.4 (owner);
 *   ipc-protocol.md 5.2、6.2、第 8 (字节流)
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Check, Maximize2, Minimize2, X } from 'lucide-react';
import {
  COMMAND_CHANNELS,
  EVENT_CHANNELS,
  type GetScrollbackPayload,
  type GetScrollbackResponse,
  type ImeProbeDumpPayload,
  type ImeProbeDumpResponse,
  type SendInputResponse,
  type SessionOutputPayload,
} from '@shared/protocol';
import type { SessionInfo, ThemeId } from '@shared/types';
import { attachImeCompositionEndCleaner } from '@shared/ime-textarea-workaround';
import {
  createImeProbeRing,
  isLikelyHistoryFlush,
  type ImeProbeEntry,
} from '@shared/ime-probe-ring';
import { useAppDispatch, useAppState } from '../store';
import { readClipboardText, writeClipboardText } from '../clipboard';
import { Icon } from './icons';
import { useContextMenuApi, type ContextMenuItem } from './ContextMenu';
import { useToast } from './Toast';
import { useModal } from './Modal';
import { useTranslation } from './LanguageProvider';
import { matchKeybinding } from '@shared/terminal-keybindings';
import '@xterm/xterm/css/xterm.css';

/**
 * 浅色主题的 ANSI 256 色扩展表(索引 16-255,共 240 项)。
 * 不设置时 xterm 用内置 240 色——按深色背景调的灰阶,232-255 上半段在浅底
 * 上对比度 < 3:1,Claude Code 等 CLI 发 `\x1b[38;5;245m` dim 字会几乎不可见。
 *
 * 这里:
 *   - 16-231 保留标准 xterm 6×6×6 cube(饱和色在浅底上一般够看,边缘 case
 *     由 minimumContrastRatio 兜底)
 *   - 232-255 灰阶斜率 *10 → *4,即 [#080808, #eeeeee] 压成 [#080808, #707070],
 *     所有灰阶在 #fff8fb / #faf4ed 浅底上保持 ≥ 4.5:1
 */
function buildLightExtendedAnsi(): string[] {
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  const rgb = (r: number, g: number, b: number) => `#${hex(r)}${hex(g)}${hex(b)}`;
  const cube = [0, 0x5f, 0x87, 0xaf, 0xd7, 0xff];
  const out: string[] = [];
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        out.push(rgb(cube[r]!, cube[g]!, cube[b]!));
      }
    }
  }
  for (let n = 232; n <= 255; n++) {
    const v = 8 + (n - 232) * 4;
    out.push(rgb(v, v, v));
  }
  return out;
}
const LIGHT_EXTENDED_ANSI = buildLightExtendedAnsi();

/**
 * 7 套主题对应的 xterm theme 颜色 (软件定义书 5.1.9)。
 * 与 global.css 的 [data-theme="..."] CSS 变量同源,任何主题变更都需
 * 同时更新这两处。
 */
const XTERM_THEMES: Record<ThemeId, ITheme> = {
  'rose-pine': {
    background: '#191724',
    foreground: '#e0def4',
    cursor: '#e0def4',
    cursorAccent: '#191724',
    selectionBackground: '#403d52',
    black: '#26233a',
    red: '#eb6f92',
    green: '#31748f',
    yellow: '#f6c177',
    blue: '#9ccfd8',
    magenta: '#c4a7e7',
    cyan: '#ebbcba',
    white: '#e0def4',
    brightBlack: '#6e6a86',
    brightRed: '#eb6f92',
    brightGreen: '#31748f',
    brightYellow: '#f6c177',
    brightBlue: '#9ccfd8',
    brightMagenta: '#c4a7e7',
    brightCyan: '#ebbcba',
    brightWhite: '#e0def4',
  },
  'rose-pine-dawn': {
    // BETA-035:浅底色下 ANSI bright 集对比度调到 WCAG AA(≥4.5:1)。
    // 用户报告 Claude Code 在浅色主题下出现"浅底白字",根因是 brightBlack
    // (常用于 dimmed 文字)对 #faf4ed 仅 ~3.0:1,brightYellow ~2.5:1。
    // 这里把 brightBlack / brightYellow / brightCyan 调暗,其它 bright 项
    // 保持与 normal 同色(Rose Pine Dawn 官方设计就是 bright=normal)。
    background: '#faf4ed',
    foreground: '#575279',
    cursor: '#575279',
    cursorAccent: '#faf4ed',
    selectionBackground: '#dfdad9',
    black: '#f2e9e1',
    red: '#b4637a',
    green: '#286983',
    yellow: '#ea9d34',
    blue: '#56949f',
    magenta: '#907aa9',
    cyan: '#d7827e',
    white: '#575279',
    // 以下三项 BETA-035 调整后的对比度估算(对 #faf4ed):
    // brightBlack #5e5a73:~6:1   ✓(原 #9893a5 ~3.0:1)
    // brightYellow #a36e10:~5:1  ✓(原 #ea9d34 ~2.5:1)
    // brightCyan #a35a55:~5:1    ✓(原 #d7827e ~3.0:1)
    brightBlack: '#5e5a73',
    brightRed: '#b4637a',
    brightGreen: '#286983',
    brightYellow: '#a36e10',
    brightBlue: '#56949f',
    brightMagenta: '#907aa9',
    brightCyan: '#a35a55',
    brightWhite: '#575279',
    extendedAnsi: LIGHT_EXTENDED_ANSI,
  },
  'rose-pine-moon': {
    background: '#232136',
    foreground: '#e0def4',
    cursor: '#e0def4',
    cursorAccent: '#232136',
    selectionBackground: '#44415a',
    black: '#393552',
    red: '#eb6f92',
    green: '#3e8fb0',
    yellow: '#f6c177',
    blue: '#9ccfd8',
    magenta: '#c4a7e7',
    cyan: '#ea9a97',
    white: '#e0def4',
    brightBlack: '#6e6a86',
    brightRed: '#eb6f92',
    brightGreen: '#3e8fb0',
    brightYellow: '#f6c177',
    brightBlue: '#9ccfd8',
    brightMagenta: '#c4a7e7',
    brightCyan: '#ea9a97',
    brightWhite: '#e0def4',
  },
  cutie: {
    // 樱花奶昔(Sakura Milk):奶白底 + 莓系深色文字,与 global.css [data-theme='cutie'] 一致;
    // 所有 ANSI 色对 #fff8fb 背景对比度 ≥ 4.5:1(BETA-035 浅色标准)
    background: '#fff8fb',
    foreground: '#5c1d3e',
    cursor: '#e91e63',
    cursorAccent: '#fff8fb',
    selectionBackground: '#f5c3d3',
    black: '#5c1d3e',
    red: '#c81258',
    green: '#4d8a5e',
    yellow: '#b8682e',
    blue: '#7665b8',
    magenta: '#b8347e',
    cyan: '#4d7d9e',
    white: '#5c1d3e',
    brightBlack: '#8a4566',
    brightRed: '#a8124a',
    brightGreen: '#3a6b48',
    brightYellow: '#8f4f1c',
    brightBlue: '#5a4b96',
    brightMagenta: '#9c2868',
    brightCyan: '#3a6480',
    brightWhite: '#3d0f28',
    extendedAnsi: LIGHT_EXTENDED_ANSI,
  },
  business: {
    background: '#1d2733',
    foreground: '#d8dee9',
    cursor: '#88c0d0',
    cursorAccent: '#1d2733',
    selectionBackground: '#3b4252',
    black: '#2e3440',
    red: '#bf616a',
    green: '#a3be8c',
    yellow: '#ebcb8b',
    blue: '#81a1c1',
    magenta: '#b48ead',
    cyan: '#88c0d0',
    white: '#d8dee9',
    brightBlack: '#4c566a',
    brightRed: '#bf616a',
    brightGreen: '#a3be8c',
    brightYellow: '#ebcb8b',
    brightBlue: '#81a1c1',
    brightMagenta: '#b48ead',
    brightCyan: '#8fbcbb',
    brightWhite: '#eceff4',
  },
  ubuntu: {
    background: '#300a24',
    foreground: '#eeeeec',
    cursor: '#dd4814',
    cursorAccent: '#300a24',
    selectionBackground: '#5e2750',
    black: '#2e3436',
    red: '#cc0000',
    green: '#4e9a06',
    yellow: '#c4a000',
    blue: '#3465a4',
    magenta: '#75507b',
    cyan: '#06989a',
    white: '#d3d7cf',
    brightBlack: '#555753',
    brightRed: '#ef2929',
    brightGreen: '#8ae234',
    brightYellow: '#fce94f',
    brightBlue: '#729fcf',
    brightMagenta: '#ad7fa8',
    brightCyan: '#34e2e2',
    brightWhite: '#eeeeec',
  },
  'windows-terminal': {
    background: '#0c0c0c',
    foreground: '#cccccc',
    cursor: '#cccccc',
    cursorAccent: '#0c0c0c',
    selectionBackground: '#3a3d41',
    black: '#0c0c0c',
    red: '#c50f1f',
    green: '#13a10e',
    yellow: '#c19c00',
    blue: '#0037da',
    magenta: '#881798',
    cyan: '#3a96dd',
    white: '#cccccc',
    brightBlack: '#767676',
    brightRed: '#e74856',
    brightGreen: '#16c60c',
    brightYellow: '#f9f1a5',
    brightBlue: '#3b78ff',
    brightMagenta: '#b4009e',
    brightCyan: '#61d6d6',
    brightWhite: '#f2f2f2',
  },
  // BETA-033 — One Dark Pro (官方调色板)
  'one-dark-pro': {
    background: '#282c34',
    foreground: '#abb2bf',
    cursor: '#528bff',
    cursorAccent: '#282c34',
    selectionBackground: '#3e4451',
    black: '#282c34',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#abb2bf',
    brightBlack: '#5c6370',
    brightRed: '#e06c75',
    brightGreen: '#98c379',
    brightYellow: '#e5c07b',
    brightBlue: '#61afef',
    brightMagenta: '#c678dd',
    brightCyan: '#56b6c2',
    brightWhite: '#ffffff',
  },
  // BETA-033 — Dracula (官方调色板)
  dracula: {
    background: '#282a36',
    foreground: '#f8f8f2',
    cursor: '#f8f8f2',
    cursorAccent: '#282a36',
    selectionBackground: '#44475a',
    black: '#21222c',
    red: '#ff5555',
    green: '#50fa7b',
    yellow: '#f1fa8c',
    blue: '#bd93f9',
    magenta: '#ff79c6',
    cyan: '#8be9fd',
    white: '#f8f8f2',
    brightBlack: '#6272a4',
    brightRed: '#ff6e6e',
    brightGreen: '#69ff94',
    brightYellow: '#ffffa5',
    brightBlue: '#d6acff',
    brightMagenta: '#ff92df',
    brightCyan: '#a4ffff',
    brightWhite: '#ffffff',
  },
  // BETA-033 — Tokyo Night (官方调色板)
  'tokyo-night': {
    background: '#1a1b26',
    foreground: '#c0caf5',
    cursor: '#c0caf5',
    cursorAccent: '#1a1b26',
    selectionBackground: '#283457',
    black: '#15161e',
    red: '#f7768e',
    green: '#9ece6a',
    yellow: '#e0af68',
    blue: '#7aa2f7',
    magenta: '#bb9af7',
    cyan: '#7dcfff',
    white: '#a9b1d6',
    brightBlack: '#414868',
    brightRed: '#f7768e',
    brightGreen: '#9ece6a',
    brightYellow: '#e0af68',
    brightBlue: '#7aa2f7',
    brightMagenta: '#bb9af7',
    brightCyan: '#7dcfff',
    brightWhite: '#c0caf5',
  },
  // BETA-033 — Catppuccin Mocha (官方调色板)
  'catppuccin-mocha': {
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    cursor: '#f5e0dc',
    cursorAccent: '#1e1e2e',
    selectionBackground: '#585b70',
    black: '#45475a',
    red: '#f38ba8',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    magenta: '#f5c2e7',
    cyan: '#94e2d5',
    white: '#bac2de',
    brightBlack: '#585b70',
    brightRed: '#f38ba8',
    brightGreen: '#a6e3a1',
    brightYellow: '#f9e2af',
    brightBlue: '#89b4fa',
    brightMagenta: '#f5c2e7',
    brightCyan: '#94e2d5',
    brightWhite: '#a6adc8',
  },
  // UI-2 — Catppuccin Latte(浅色版本,与 Mocha 对应)
  // 官方 ANSI 调色板:https://github.com/catppuccin/iterm
  // bright 系按 BETA-035 标准在 #eff1f5 上 ≥4.5:1(brightBlack/Yellow/Cyan 调暗)
  'catppuccin-latte': {
    background: '#eff1f5',
    foreground: '#4c4f69',
    cursor: '#dc8a78',
    cursorAccent: '#eff1f5',
    selectionBackground: '#acb0be',
    black: '#5c5f77',
    red: '#d20f39',
    green: '#40a02b',
    yellow: '#df8e1d',
    blue: '#1e66f5',
    magenta: '#ea76cb',
    cyan: '#179299',
    white: '#acb0be',
    brightBlack: '#5e5d6e',
    brightRed: '#d20f39',
    brightGreen: '#40a02b',
    brightYellow: '#a36e10',
    brightBlue: '#1e66f5',
    brightMagenta: '#8839ef',
    brightCyan: '#0a7176',
    brightWhite: '#4c4f69',
    extendedAnsi: LIGHT_EXTENDED_ANSI,
  },
  // UI-2 — Tokyo Night Day(浅色版本)
  // 官方调色板:folke/tokyonight.nvim(day variant)
  // 设计要点:foreground 是钢蓝 #3760bf(非黑),是 TND 标志,保留
  'tokyo-night-day': {
    background: '#e1e2e7',
    foreground: '#3760bf',
    cursor: '#3760bf',
    cursorAccent: '#e1e2e7',
    selectionBackground: '#b6bdcf',
    black: '#a1a6c5',
    red: '#f52a65',
    green: '#587539',
    yellow: '#8c6c3e',
    blue: '#2e7de9',
    magenta: '#9854f1',
    cyan: '#007197',
    white: '#6172b0',
    brightBlack: '#4f5d9e',
    brightRed: '#f52a65',
    brightGreen: '#587539',
    brightYellow: '#8c6c3e',
    brightBlue: '#2e7de9',
    brightMagenta: '#9854f1',
    brightCyan: '#007197',
    brightWhite: '#3760bf',
    extendedAnsi: LIGHT_EXTENDED_ANSI,
  },
  // UI-2 — Light Pink(浅色可爱,mgwg/light-pink-theme 上游)
  // 上游 ANSI 颜色在 #f5f5f5 bg 上多处不达 AA(yellow/magenta/cyan),
  // 按 BETA-035 标准统一加深到 ≥4.5:1
  'light-pink': {
    background: '#f5f5f5',
    foreground: '#54494b',
    cursor: '#ff7ab3',
    cursorAccent: '#f5f5f5',
    selectionBackground: '#f1dde9',
    black: '#54494b',
    red: '#d2304b',
    green: '#4a7559',
    yellow: '#8a6c1f',    // 上游 #b08b35 在浅底 ~3.2:1,加深到 ≥4.5
    blue: '#1f6e89',
    magenta: '#9d3c5e',   // 上游 function 色,本身已 ≥4.5
    cyan: '#2d6b75',      // 上游 #458a96 仅 ~3.7,加深到 ≥4.5
    white: '#54494b',
    brightBlack: '#7d6770',
    brightRed: '#d2304b',
    brightGreen: '#4a7559',
    brightYellow: '#8a6c1f',
    brightBlue: '#1f6e89',
    brightMagenta: '#8855a0',   // 加深后的紫莓
    brightCyan: '#2d6b75',
    brightWhite: '#44132d',     // 深酒红(exception 色)
    extendedAnsi: LIGHT_EXTENDED_ANSI,
  },
  // UI-2 — Fairyfloss(深色可爱,sailorhg 原创)
  // https://sailorhg.github.io/fairyfloss/
  // 上游调色板直接采用 — kawaii 工程师文化 OG,palette 是其 brand identity
  fairyfloss: {
    background: '#5a5475',
    foreground: '#f8f8f2',
    cursor: '#c5a3ff',
    cursorAccent: '#5a5475',
    selectionBackground: '#6959aa',
    black: '#5a5475',
    red: '#ff857f',
    green: '#c2ffdf',
    yellow: '#ffea00',
    blue: '#c5a3ff',
    magenta: '#ffb8d1',
    cyan: '#c2ffdf',
    white: '#f8f8f2',
    brightBlack: '#a186cf',
    brightRed: '#ff857f',
    brightGreen: '#c2ffdf',
    brightYellow: '#fff352',
    brightBlue: '#9673d3',
    brightMagenta: '#ffb8d1',
    brightCyan: '#c2ffdf',
    brightWhite: '#ffffff',
  },
};

function getXtermTheme(themeId: ThemeId | undefined): ITheme {
  return XTERM_THEMES[themeId ?? 'rose-pine'] ?? XTERM_THEMES['rose-pine'];
}

/**
 * 是否浅色主题 — 通过 extendedAnsi 引用相等判定(填了 LIGHT_EXTENDED_ANSI
 * 的主题就是浅色)。配合 minimumContrastRatio,只在浅色主题打开对比度兜底,
 * 避免无差别加深破坏深色主题里故意调淡的颜色(如 prompt hint、git diff
 * context 行等)。
 */
function isLightTheme(themeId: ThemeId | undefined): boolean {
  return getXtermTheme(themeId).extendedAnsi === LIGHT_EXTENDED_ANSI;
}
const LIGHT_THEME_MIN_CONTRAST = 4.5;

interface TerminalViewProps {
  /**
   * 必须满足 session.ownerWindowId === state.myWindowId — 父组件 MainPane 通过
   * getDisplayableSession 强制保证。这里不再做 isOwner=false 的占位 UI。
   * (myWindowId prop 已删除:本窗口生命周期内不变,不参与 effect deps;
   *  契约由父组件强制,不需要在本组件运行时再判断。)
   */
  session: SessionInfo;
}

/**
 * 把焦点归还给 xterm 的 helper-textarea。
 *
 * 设计：xterm 的 `term.focus()` 在 search bar 可见时会和搜索 input 抢焦点
 * (它一定会 focus 内部 helper-textarea)；用 ref + 简单 guard 保证只在
 * "我们确实希望终端有焦点"的场景下生效。
 *
 * 调用时机：所有可能让焦点漂走的副作用末尾兜底调用一次：
 * - paste / copy / clear (右键菜单或快捷键完成后)
 * - drop (拖文件后)
 * - tab / blank tab / template button / window chrome 按钮 click
 * - ContextMenu / Toast / Modal 关闭后
 * - TerminalView mount (FOC-1: 切 session 自动聚焦)
 * - selectedSessionId 变化 (FOC-6: 托盘点击 / focus-requested)
 *
 * 不抢搜索栏的焦点 (searchVisibleRef.current=true 时跳过)。
 */
function focusTerminal(
  termRef: { current: Terminal | null },
  searchVisibleRef: { current: boolean },
): void {
  if (searchVisibleRef.current) return;
  termRef.current?.focus();
}

export function TerminalView({ session }: TerminalViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);

  const appState = useAppState();
  const dispatch = useAppDispatch();
  const { t, tx } = useTranslation();
  const simpleMode = appState.simpleMode;
  const themeId = appState.settings.appearance?.theme;
  const fontSize = appState.settings.appearance?.terminalFontSize ?? 13;
  const fontFamily =
    appState.settings.appearance?.terminalFontFamily ??
    '"Cascadia Mono", "JetBrains Mono", Consolas, "LXGW WenKai Mono", monospace';
  const lineHeight = appState.settings.appearance?.terminalLineHeight ?? 1.2;
  const selectOnCopy = appState.settings.behavior?.selectOnCopy ?? true;
  const rightClickMode = appState.settings.behavior?.terminalRightClick ?? 'menu';
  const bracketedPaste = appState.settings.behavior?.bracketedPaste ?? true;
  // 终端渲染器选择(mount 时决定,运行时切换需关 tab 重开)
  const terminalRenderer =
    appState.settings.advanced?.terminalRenderer ?? 'auto';

  // 把"创建期"读到的初始值用 useMemo 锁定 (terminal 创建后只用 mutator 调整),
  // 否则每次 settings 引用变化都会重建 xterm 实例。
  const initialTheme = useMemo(() => getXtermTheme(themeId), [
    // initial 仅依赖一次,但 themeId 仅作 dep 进入 effect 不等于 recreate
    // 这里读初值,运行时切换走另一个 effect。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    session.id,
  ]);

  // SCROLL-1 二次修复(2026-05-24,KBD-1 同 PR):scrollback replay 期间整体
  // 隐藏 terminal-host,直到 fence callback + scrollToBottom + 一帧 RAF 让
  // xterm 渲染器画到最终态,才置回 visible。canvas 在 hidden 期间继续接收
  // WebGL/DOM 绘制(visibility:hidden 只跳 compositing,不停 canvas pixel
  // 累积),用户第一可见帧就是最终态。
  //
  // 配合 inert:visibility:hidden 已经让 helper-textarea 不能 focus,但
  // 浏览器仍可能把焦点落到子树外的 fallback 元素(Sidebar input / Modal
  // 等)。`inert` 显式声明:replay 期间子树不响应任何 input/focus/click。
  // 这样用户在切换 session 的 100-500ms 间隙敲键,不会误进 Sidebar 改名 /
  // 触发任何 keybinding — replay 完 reveal 后焦点立即归还终端可继续敲。
  //
  // key={session.id} 强制重建,挂载默认 false → reveal 后 true,无残留。
  // 详见 docs/issues/scroll-1-session-switch-progressive-refresh.md 与
  // docs/键盘交互规范.md 中"replay 期间按键不响应"决定。
  const [hostRevealed, setHostRevealed] = useState(false);

  // 搜索栏状态
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [searchResults, setSearchResults] = useState<{
    matches: number;
    current: number;
  }>({ matches: 0, current: 0 });
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  // 把搜索状态镜像到 ref,attachCustomKeyEventHandler 等长期闭包能读最新值
  const searchVisibleRef = useRef(searchVisible);
  searchVisibleRef.current = searchVisible;
  const searchTextRef = useRef(searchText);
  searchTextRef.current = searchText;
  const searchCaseSensitiveRef = useRef(searchCaseSensitive);
  searchCaseSensitiveRef.current = searchCaseSensitive;

  // 右键菜单走全局 ContextMenuProvider (越界翻转 / Esc / 外部点击 / 滚轮关闭都
  // 在 Provider 里统一处理),这里只保留 handleContextMenu 一个调用点。
  const ctxApi = useContextMenuApi();
  const toast = useToast();
  const modal = useModal();
  // toast 引用镜像到 ref,让 mount effect 内长期闭包(dataHandler / paste 等)
  // 能读最新 toast api(useToast 的返回 reference 在 ToastProvider 内是稳定的,
  // 但走 ref 让"未来 push 实现替换"也免改下游)。
  const toastRef = useRef(toast);
  toastRef.current = toast;
  // 防 toast 刷屏:多次 sendInput 失败短时间内只弹一次。
  const lastInputRejectToastAtRef = useRef(0);

  // ── 操作:复制 / 粘贴 / 清屏 / 搜索 ──
  //
  // 勘误第二轮:剪贴板从 navigator.clipboard 换到 IPC 走 main 端 Electron
  // clipboard 模块。原因:navigator.clipboard.{write,read}Text 在 Electron
  // file:// 上下文需 Permission API 放行;我们的 setPermissionRequestHandler
  // 早期拒掉了 clipboard-write,导致写操作静默 reject。
  //
  // 优先用 preload 暴露的 window.api.clipboard.* (内部也走 IPC);旧 preload
  // 没这个字段时,直接 window.api.invoke 调同样的 IPC channel。这样 dev 模式
  // 即便 preload 还是老版本,只要 main 重启了 IPC channel 就生效。
  const handleCopy = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    const sel = term.getSelection();
    if (sel) {
      // CPB-C4:Windows 平台多行复制用 CRLF,符合 Notepad / Office 等
      // 原生程序对换行的预期(xterm getSelection 默认只给 LF)。
      // 平台分支:process.platform 在 renderer 走 preload 不可读,
      // 用 navigator.platform 判断 win(包含 'win32' / 'windows' 兼容)。
      // 跨平台时 macOS/Linux 拷贝走 LF 不动。
      const onWindows = navigator.platform.toLowerCase().includes('win');
      const finalText = onWindows ? sel.replace(/\n/g, '\r\n') : sel;
      void writeClipboardText(finalText);
    }
    // CPB-C1:复制完归还焦点 — 避免右键菜单选"复制"后菜单关闭 → 焦点
    // 漂到 body → 用户敲键无反应的反馈
    focusTerminal(termRef, searchVisibleRef);
  }, []);

  const handlePaste = useCallback(async () => {
    try {
      const text = await readClipboardText();
      if (!text) return;

      // CPB-P4:大粘贴预检 — >1MB 警告,避免用户误粘巨型剪贴板
      // (从浏览器复制了一整个 HTML 页 / 误把日志文件 copy 全文 / 文件路径
      // 被复制成 base64 等)冻结终端。1MB 阈值给"合理粘贴"足够余量,
      // 仍能粘多页代码 / 长 prompt 给 AI agent。
      const LARGE_PASTE_BYTES = 1 * 1024 * 1024;
      const byteLen = new Blob([text]).size;
      if (byteLen > LARGE_PASTE_BYTES) {
        const sizeMB = (byteLen / 1024 / 1024).toFixed(2);
        const preview = sanitizePastedPreview(text.slice(0, 200)) + '…';
        const ok = await modal.confirm({
          title: '大段内容粘贴',
          message:
            `即将粘贴 ${sizeMB} MB 内容到终端。\n` +
            '过大的粘贴可能让 shell 长时间无响应,或被 ConPTY 管道阻塞。',
          preview,
          confirmLabel: '继续粘贴',
          cancelLabel: '取消',
          danger: true,
        });
        if (!ok) return;
      }

      // CPB-P8:启用 bracketed paste 协议时,shell 端(PowerShell 7+ /
      // bash 5+ / zsh / fish / Claude Code REPL 等)把 \x1b[200~..\x1b[201~
      // 之间的内容当 literal,用户可编辑后再 Enter,不会被立即执行。
      // 此模式下多行不再需要 confirm 兜底。
      //
      // 用户禁用 bracketed paste(用 cmd 等不支持 readline 的 shell)时,
      // 多行粘贴回到原行为:走 confirm 警告。

      // 内嵌 ESC(0x1B)→ 可能是 ANSI 注入(OSC/CSI 改终端状态),弹强警告
      // confirm。普通粘贴含 ESC 极罕见。bracketed paste 包裹会让 ESC 也
      // 被 literal 处理,但 modal 显示给用户决定是否真要这么干。
      // preview 走 sanitizePastedPreview 把控制字符渲染成可见占位符,
      // 避免预览本身欺骗用户(CPB-P7)。
      const hasEsc = text.indexOf('\x1b') >= 0;
      if (hasEsc) {
        const previewRaw =
          text.length > 200 ? text.slice(0, 200) + '…' : text;
        const preview = sanitizePastedPreview(previewRaw);
        const ok = await modal.confirm({
          title: '粘贴内容含转义字符',
          message:
            '剪贴板内容包含 ESC 控制字符(可能改终端状态 / 清屏 / 改标题等)。\n' +
            '常见于从恶意网页或受感染的剪贴板内容。继续粘贴?',
          preview,
          confirmLabel: '强制粘贴',
          cancelLabel: '取消',
          danger: true,
        });
        if (!ok) return;
      }

      // bracketed paste 禁用 + 多行 → 走旧 confirm 兜底
      if (!bracketedPaste) {
        // BETA-041:CPB-P3 原版 trim 用 .replace(/\n$/, '') 只剥一个尾换行,
        // "ls\n\n" 仍被算成 2 行误触发 confirm。改为 split 后弹出所有尾部
        // 空行,逻辑显式可读、不漏 case。
        const lines = text.split(/\r\n|\r|\n/);
        while (lines.length > 0 && lines[lines.length - 1] === '') {
          lines.pop();
        }
        const lineCount = lines.length;
        if (lineCount > 1) {
          const normalized = lines.join('\n');
          const previewRaw =
            normalized.length > 200
              ? normalized.slice(0, 200) + '…'
              : normalized;
          const preview = sanitizePastedPreview(previewRaw);
          const ok = await modal.confirm({
            title: tx('多行粘贴确认', 'Multi-line paste confirmation'),
            message: tx(
              `即将粘贴 ${lineCount} 行内容到终端。\n多行内容可能被 shell 当成多条命令立即执行。\n建议在"设置 → 行为"启用 bracketed paste 让支持的 shell 把粘贴当 literal。`,
              `About to paste ${lineCount} lines into the terminal.\nMulti-line content may be interpreted by the shell as multiple commands.\nEnable bracketed paste in Settings → Behavior so supported shells treat it as literal text.`,
            ),
            preview,
            confirmLabel: tx('粘贴', 'Paste'),
            cancelLabel: tx('取消', 'Cancel'),
          });
          if (!ok) return;
        }
      }

      // bracketed paste 包裹(可通过 settings.behavior.bracketedPaste 关闭,
      // cmd.exe 等不支持 readline 的 shell 用户应当关闭以免看到字面 marker)
      const payload = bracketedPaste ? `\x1b[200~${text}\x1b[201~` : text;
      const base64 = encodeStringToBase64(payload);
      await window.api.invoke(COMMAND_CHANNELS.SESSION_SEND_INPUT, {
        sessionId: session.id,
        data: base64,
      });
    } catch (err) {
      console.warn('[TerminalView] paste failed', err);
    } finally {
      // CPB-P1:粘贴完成无论成功失败都归还焦点。
      focusTerminal(termRef, searchVisibleRef);
    }
  }, [session.id, modal, bracketedPaste]);

  const handleClear = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    term.clear();
  }, []);

  const handleOpenSearch = useCallback(() => {
    setSearchVisible(true);
    // setState 后立即 focus 太早,DOM 还没挂;用 raf 等下一帧
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, []);

  // BETA-028:终端工具栏通过 window CustomEvent 触达本组件 — 清屏 / 唤搜索栏。
  // detail.sessionId 必须匹配本实例的 session,否则忽略(多窗口时只有持有者响应)。
  useEffect(() => {
    const onClear = (e: Event): void => {
      const sid = (e as CustomEvent<{ sessionId: string }>).detail?.sessionId;
      if (sid && sid !== session.id) return;
      handleClear();
    };
    const onOpenSearch = (e: Event): void => {
      const sid = (e as CustomEvent<{ sessionId: string }>).detail?.sessionId;
      if (sid && sid !== session.id) return;
      handleOpenSearch();
    };
    window.addEventListener('marina:terminal-clear', onClear);
    window.addEventListener('marina:terminal-open-search', onOpenSearch);
    return () => {
      window.removeEventListener('marina:terminal-clear', onClear);
      window.removeEventListener('marina:terminal-open-search', onOpenSearch);
    };
  }, [session.id, handleClear, handleOpenSearch]);

  const handleCloseSearch = useCallback(() => {
    // 先清掉 SearchAddon 的高亮,否则关搜索栏后高亮还残留
    try {
      searchRef.current?.clearDecorations();
    } catch {
      /* ignore */
    }
    setSearchVisible(false);
    setSearchText('');
    setSearchResults({ matches: 0, current: 0 });
    // 关闭搜索后让焦点回到终端
    termRef.current?.focus();
  }, []);

  // CP-4 勘误 #8:performSearch 通过 ref 读最新 searchText/caseSensitive,
  // 避免 useCallback 闭包抓到旧 searchText 导致"按 Enter 跳的是上一次的关键字"。
  // 同时打开 decorations 让命中处在 viewport 上有高亮 + minimap marker。
  const performSearch = useCallback((direction: 'next' | 'previous'): void => {
    const search = searchRef.current;
    const text = searchTextRef.current;
    if (!search || !text) return;
    const opts = {
      caseSensitive: searchCaseSensitiveRef.current,
      decorations: {
        matchBackground: '#7d6c00',
        matchOverviewRuler: '#f6c177',
        activeMatchBackground: '#bd6500',
        activeMatchColorOverviewRuler: '#eb6f92',
      },
    };
    if (direction === 'next') search.findNext(text, opts);
    else search.findPrevious(text, opts);
  }, []);

  // handlers 镜像到 ref:attachCustomKeyEventHandler 在 mount effect 内一次性
  // 注册,deps 只 [session.id];直接闭包 handle* useCallback 会锁住"挂载那
  // 一刻"的版本,后续 bracketedPaste / modal / rightClickMode 等设置变化
  // 重建出的新 handle* 永远进不来 → Ctrl+Shift+V 不跟设置走(P1-1)。
  // 同 toastRef 模式:每次渲染镜像当前函数,事件回调读 ref.current 即最新。
  const handlersRef = useRef({
    handleCopy,
    handlePaste,
    handleClear,
    handleOpenSearch,
    handleCloseSearch,
  });
  handlersRef.current = {
    handleCopy,
    handlePaste,
    handleClear,
    handleOpenSearch,
    handleCloseSearch,
  };

  // ── xterm 实例生命周期 ──
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const term = new Terminal({
      fontFamily,
      fontSize,
      lineHeight,
      cursorBlink: true,
      cursorStyle: 'bar',
      theme: initialTheme,
      // 浅色主题打开 WCAG AA 对比度兜底:Claude Code 等 CLI 用 ANSI 256(走
      // extendedAnsi)与 24-bit truecolor 输出 dim 字时,即使主题填了浅色调色板,
      // 仍可能出现"浅底浅字"边缘 case;这里在浅色主题渲染层强制 ≥ 4.5:1。深色
      // 主题保持默认 1(不干预),避免破坏深色场景里精心调淡的视觉层级。
      minimumContrastRatio: isLightTheme(themeId) ? LIGHT_THEME_MIN_CONTRAST : 1,
      scrollback: 5000,
      // SearchAddon 的 registerDecoration 走 proposed API,关闭就触发
      // "You must set allowProposedApi option to true" → 错误边界。
      // xterm 这个 API 已在 5.x 稳定使用,proposed 标签只是它内部 RFC 流程慢。
      allowProposedApi: true,
      // 勘误第二轮 #5:启用 Windows 模式。
      // 解决:在 Windows 上(尤其 ConPTY 下),PowerShell / cmd 输出的 \r\n
      // 与 xterm 的换行/重绘语义不完全匹配,某些字符宽度计算偏差导致行末出
      // 现"残影"字符 / 行尾空格被吃掉。windowsMode=true 让 xterm 用 Windows
      // 风格处理 LF / CR / 行尾,实测对 ConPTY 输出的 stability 有明显改进。
      windowsMode: true,
    });
    termRef.current = term;

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    const searchAddon = new SearchAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.loadAddon(searchAddon);
    fitRef.current = fitAddon;
    searchRef.current = searchAddon;

    // PER-1 / XTM-1:装 WebGL 渲染器替代默认 DOM renderer。
    // 性能 10-50× 提升,长瀑布输出 (npm install / find / Claude Code 流式
    // token) 主线程不再 100%、不再 frame drops。
    //
    // 必须在 term.open() 之后 loadAddon — WebGL 需要 canvas DOM 节点存在
    // 才能初始化 GL context。
    //
    // onContextLoss 回退:GPU 被系统抢占 / 显卡驱动崩溃 → WebGL context
    // lost,dispose addon 后 xterm 自动回退 DOM renderer。

    // ↓ 这一段 effect 内部先占位,真正 load 放到 term.open 之后(见下面)
    let webglAddon: WebglAddon | null = null;

    // disposed 标志在 cleanup 内被置 true,其他异步路径(webfont ready /
    // scrollback chunked write / replay then)读它决定要不要继续 — 必须
    // 在所有这些路径之前声明(let 是块作用域,TDZ 不允许后向引用)。
    let disposed = false;

    // KBD-1 整改(2026-05-24):键盘 binding 集中到 terminal-keybindings.ts。
    // 此处仅"扫表 match → dispatch action",6 处早返 / 5 个嵌套特例都消失。
    //
    // 历史(已废弃):attachCustomKeyEventHandler 内有一段长 if/else,逐个
    // 拦 Ctrl+F / Ctrl+Shift+C / Ctrl+Insert / Ctrl+Shift+V / Shift+Insert /
    // Esc(搜索栏开时)。漏拦 Ctrl+V 导致 0x16(Unix literal-next)发到 PTY,
    // 三套粘贴还和 xterm native paste listener 双倍触发 — PR #3 与本次整改
    // 合并修复。
    //
    // 不变式:
    //   - IME composition 期间(isComposing || keyCode===229)所有键透传,
    //     binding table 不参与匹配
    //   - 任何 binding 命中都 return false 让 xterm 不发字节给 PTY;唯一例外
    //     是 'copy-or-sigint' 在无选区时 return true 让 ^C 透传发 SIGINT
    //   - paste 类 action 的真正动作在 capture-phase 'paste' listener
    //     (见 term.open 之后的 PASTE-1 注册块),本 handler 只负责 consume
    //     keyboard event
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      if (ev.isComposing || ev.keyCode === 229) return true;
      const binding = matchKeybinding(ev, {
        searchVisible: searchVisibleRef.current,
      });
      if (!binding) return true; // 透传给 xterm 默认处理

      // 走 ref 取最新 handler — bracketedPaste/modal 等设置变化时仍生效(P1-1)
      const h = handlersRef.current;
      const term = termRef.current;

      switch (binding.action) {
        case 'open-search':
          h.handleOpenSearch();
          return false;
        case 'close-search':
          h.handleCloseSearch();
          return false;
        case 'copy-or-sigint': {
          // 有选区:复制 + 清选区(CPB-C3 — 否则下次 Ctrl+C 残留选区
          // 让 hasSel=true,永远走复制分支不发 SIGINT);无选区:透传 ^C
          const hasSel = !!term?.getSelection();
          if (!hasSel) return true;
          h.handleCopy();
          term?.clearSelection();
          return false;
        }
        case 'copy-and-clear': {
          // Ctrl+Shift+C / Ctrl+Insert:有选区复制 + 清选区;
          // 无选区也要清(防御性,理论上 hasSel=false 时 clearSelection 是 no-op)
          // 关键修复:之前 Ctrl+Shift+C / Ctrl+Insert 复制后不清选区,
          // 让随后的 Ctrl+C 误走复制分支,SIGINT 失效。
          if (term?.getSelection()) {
            h.handleCopy();
            term.clearSelection();
          }
          return false;
        }
        case 'consume-for-paste':
          // Ctrl+V 阻 xterm 发 0x16,Ctrl+Shift+V / Shift+Insert 显式 consume。
          // 浏览器随后触发 paste 事件 → capture-phase listener 接管 → handlePaste()。
          // 不在此处直接调 handlePaste:capture listener 是唯一入口,确保
          // 语音输入 / 浏览器右键粘贴 / 这三个键位都走同一条路径,无双倍。
          return false;
        default: {
          // 编译期 exhaustiveness check
          const _exhaustive: never = binding.action;
          void _exhaustive;
          return true;
        }
      }
    });

    // SearchAddon 暴露 onDidChangeResults — 用它拿命中数 + 当前位置 (#7)
    const searchResultsDisposable = searchAddon.onDidChangeResults?.(
      (results) => {
        if (!results) {
          setSearchResults({ matches: 0, current: 0 });
          return;
        }
        // xterm 的 ISearchAddonResult: { resultIndex: number, resultCount: number }
        // resultIndex 为 -1 表示无命中
        const count = results.resultCount ?? 0;
        const idx = results.resultIndex ?? -1;
        setSearchResults({
          matches: count,
          current: count > 0 && idx >= 0 ? idx + 1 : 0,
        });
      },
    );

    // CURSOR-1 根治后(state-replay 架构),BETA-019 workaround 已删除:
    // 此处原有 `term.buffer.onBufferChange` listener 强行在 alt-buffer 期间
    // 关 cursorBlink,启发式错且实测 5% 出错。
    //
    // 真正修复在 main 端 `SessionManager.getScrollbackForReplay`:重挂时通过
    // SerializeAddon 从 headless 状态机吐完整 ANSI 重建流(含 ?1049h / ?25l
    // 等模式),renderer 写入即恢复正确 buffer / cursor 可见性。应用要藏光标
    // 就发 ?25l,Marina 转发,不再二次猜。

    term.open(container);

    // PASTE-1(2026-05-24,合并 PR #3):capture-phase paste 监听器 —
    // 所有粘贴的唯一入口。
    //
    // 背景:xterm.js 在 helper-textarea 上注册 bubble-phase paste listener,
    // 把剪贴板内容直接发到 PTY,不走我们的 handlePaste(bracketed paste /
    // 大粘贴警告 / 多行确认 / ESC 检测都拿不到)。我们在 capture phase 拦截
    // 并 stopImmediatePropagation 阻止 xterm 的 bubble listener,统一走
    // handlersRef.current.handlePaste。
    //
    // 覆盖来源:Ctrl+V / Ctrl+Shift+V / Shift+Insert / 语音输入(智模 /
    // 闪电说等"写剪贴板 → 模拟 Ctrl+V")/ 浏览器右键粘贴 / 剪贴板桥粘贴。
    //
    // IME 不变式:paste 事件不挂 composition 状态机,IME 期间 Ctrl+V 仍能
    // 正常触发 capture listener(不走 attachCustomKeyEventHandler 的 IME
    // 守卫路径)。
    //
    // 双层注册:helper-textarea 是 xterm 的 paste 目标元素;container 是
    // 兜底(若 xterm 未来重构,helper-textarea 改名 / 不存在,container 这层
    // 仍能接住事件)。两层都走 capture phase,stopImmediatePropagation 阻
    // 后续 listener。
    //
    // cleanup:container 在 useEffect cleanup 内 (xterm dispose 时整个 DOM
    // 被 React 卸载),listener 跟着 GC;但显式 remove 给未来读代码的人留
    // invariant。
    const pasteInterceptor = (evt: ClipboardEvent): void => {
      evt.stopImmediatePropagation();
      evt.preventDefault();
      void handlersRef.current.handlePaste();
    };
    const helperTaForPaste = container.querySelector<HTMLElement>(
      '.xterm-helper-textarea',
    );
    helperTaForPaste?.addEventListener('paste', pasteInterceptor, true);
    container.addEventListener('paste', pasteInterceptor, true);

    // IME-1 探针 ring buffer — 暂存最近 50 条 EV,onData 触发疑似 LEAK 时
    // 一并 IPC 发到 main 端 logger.ime 落盘。capacity=50 覆盖 LEAK 前 1-2s
    // 的 composition 事件,足够定位 race 路径而不会让单条日志体积失控。
    const imeProbeRing = createImeProbeRing(50);

    // IME-1 workaround:挂 compositionend 兜底清空 helper-textarea。
    // 根因在 @xterm/xterm CompositionHelper:整个 xterm 只在 Enter / Ctrl+C
    // 时清 textarea,中文 IME 用户长时间不按 Enter 会累到几百几千字符;再叠加
    // compositionend 用 substring(start) 取从开头到 textarea 末尾的几条 race
    // 路径,就会把历史一起送给 onData。这里在每次 compositionend 后延迟 16ms
    // (~1 帧)清空,从根上断"textarea 累积历史"这个前提。
    // 详见 docs/issues/ime-1-chinese-ime-stale-textarea-flush.md 与
    // src/shared/ime-textarea-workaround.ts 的 JSDoc。
    let detachImeWorkaround: (() => void) | null = null;
    try {
      const helperTaForWorkaround = container.querySelector(
        '.xterm-helper-textarea',
      ) as HTMLTextAreaElement | null;
      if (helperTaForWorkaround) {
        detachImeWorkaround = attachImeCompositionEndCleaner(
          helperTaForWorkaround,
        );
      }
    } catch (err) {
      console.warn('[TerminalView] IME-1 workaround attach failed', err);
    }

    // [IME-1 PROBE B] 临时探针:追踪 helper-textarea 的 composition 时序与
    // keydown 229 事件,用来定位"中文 IME 按标点冲刷历史"的触发路径。
    //
    // 升级(2026-05-18 第二轮):原先直接 console.warn 每条 EV,
    //   (1) 中文用户日常输入每个标点都打一条 console,噪音淹没真问题
    //   (2) 真 LEAK 触发时若 DevTools 没开,前置 EV 序列就丢了 — 而 LEAK 判定
    //       race 路径必须靠 LEAK 前面那几条 EV
    // 改成 ring buffer (50 条) 暂存,onData 触发疑似 LEAK 时一次性 IPC dump
    // 到 main 端 logger.ime 通道落盘。详见 @shared/ime-probe-ring。
    //
    // 不挂 cleanup:listener 随 term.dispose() 移除 textarea 一起被 GC;
    // ring 在 useEffect 结束闭包内,组件 unmount 时整个引用消失。
    try {
      const helperTa = container.querySelector(
        '.xterm-helper-textarea',
      ) as HTMLTextAreaElement | null;
      if (helperTa) {
        const trace =
          (tag: ImeProbeEntry['ev']) =>
          (e: Event): void => {
            imeProbeRing.push({
              t: performance.now().toFixed(1),
              ev: tag,
              data: (e as CompositionEvent).data ?? '',
              taLen: helperTa.value.length,
              taTail: helperTa.value.slice(-40),
            });
          };
        helperTa.addEventListener('compositionstart', trace('start'));
        helperTa.addEventListener('compositionupdate', trace('update'));
        helperTa.addEventListener('compositionend', trace('end'));
        helperTa.addEventListener('keydown', (e) => {
          // 微软拼音标点 auto-convert 走 keyCode 229 + !isComposing 路径,
          // 不经过 compositionstart — 只能从 keydown 抓
          if (e.keyCode === 229) {
            imeProbeRing.push({
              t: performance.now().toFixed(1),
              ev: 'kd229',
              key: e.key,
              taLen: helperTa.value.length,
              taTail: helperTa.value.slice(-40),
            });
          }
        });
      }
    } catch (err) {
      console.warn('[IME-1 PROBE B] attach failed', err);
    }

    // PER-1:term.open 之后才能 load WebGL addon(需 canvas DOM 节点)。
    // try/catch 兜底:某些虚拟机 / 无 GPU 加速环境下 WebGL context 创建
    // 失败,catch 后 xterm 自动用 DOM renderer。
    //
    // 决定用 WebGL renderer 还是 DOM renderer。
    //
    // settings.advanced.terminalRenderer:
    //   'auto'  = 平台默认:Windows/macOS WebGL,Linux DOM(PER-LINUX,
    //             BETA-003 性能修复 — Chromium 在 Linux 下 GPU 驱动栈
    //             Mesa/EGL 经常不完整,WebGL context 会成功创建但走 CPU
    //             模拟,xterm 滚动秒级响应不可用;catch 不触发,只能按
    //             platform 直接跳)
    //   'webgl' = 强制 WebGL(Linux 上几乎必然慢得不可用,只在显式调研时用)
    //   'dom'   = 强制 DOM renderer(某些 TUI 在 WebGL 下光标渲染异常时
    //             用作回退手段;性能 10-50× 差但稳)
    //
    // mount 时决定,运行时改设置需重建 xterm 实例(关 tab 重开),因为
    // addon 在 term.open 之后只 load 一次。
    const isLinux =
      typeof navigator !== 'undefined' &&
      /linux/i.test(navigator.userAgent) &&
      !/android/i.test(navigator.userAgent);
    const useWebGL =
      terminalRenderer === 'webgl'
        ? true
        : terminalRenderer === 'dom'
          ? false
          : !isLinux; // 'auto'
    if (!useWebGL) {
      console.info(
        `[TerminalView] using DOM renderer (settings.advanced.terminalRenderer=${terminalRenderer}${terminalRenderer === 'auto' && isLinux ? ', Linux auto' : ''})`,
      );
    } else {
      try {
        webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => {
          try {
            webglAddon?.dispose();
          } catch {
            /* ignore */
          }
          webglAddon = null;
        });
        term.loadAddon(webglAddon);
      } catch (err) {
        console.warn(
          '[TerminalView] WebGL renderer unavailable, falling back to DOM',
          err,
        );
        webglAddon = null;
      }
    }

    try {
      fitAddon.fit();
    } catch {
      /* 忽略极小窗口 fit 错误 */
    }

    // XTM-9:webfont 首次加载完成时 measure 字符宽度才准。用户切自定义
    // terminalFontFamily 后第一次 mount 会用 fallback metrics 算 fit,
    // 边缘可能空 1-2 列;字体加载完成后主动 re-fit。
    // document.fonts.ready 是 promise,resolve 时所有 @font-face 已就位。
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      void document.fonts.ready.then(() => {
        if (disposed) return;
        try {
          fitAddon.fit();
        } catch {
          /* ignore */
        }
      });
    }

    // FOC-1:mount 后立即抢焦点 — 修复"切 tab/创建 session/接管 orphan/
    // 退出 settings 后必须再点一次终端区才能打字"。xterm 的 helper-textarea
    // 在 open() 后才存在,所以 focus 必须在 open() 之后调。
    // 不走 focusTerminal helper:searchVisibleRef 在 mount 时尚未与上层
    // hook 绑定,直接 term.focus() 即可,且 mount 时不可能 search 是开的。
    term.focus();

    const cols = term.cols;
    const rows = term.rows;

    // fit 后把精确 cols/rows 写回 store。后续 SESSION_CREATE 调用读
    // store.lastTerminalDims,确保 spawn PTY 时尺寸已经接近 fit 值,
    // 避免 ConPTY 的 spawn-then-resize 重画 banner quirk (用户勘误 #2)。
    dispatch({ type: 'view/update-terminal-dims', dims: { cols, rows } });

    // 启动后无条件同步初始尺寸给 PTY。
    //
    // 这里**不**做 "cols/rows 等于 session.cols/session.rows 就跳过" 的短路 —
    // 该 IPC 同时承担"我刚被显示"的信号功能:主进程 resize() 即便接到 no-op
    // 尺寸也会打开 RESIZE_QUIET_MS 窗口,压住切 tab / 重挂时 ConPTY 重发屏内容
    // 引起的 idle session 闪绿(见 session-manager.ts:resize 的勘误注释)。
    // 跳过 IPC 会让该兜底窗口永远开不起来 — 抖动源 A 的根因。
    window.api
      .invoke(COMMAND_CHANNELS.SESSION_RESIZE, {
        sessionId: session.id,
        cols,
        rows,
      })
      .catch(() => {});

    // ── Scrollback replay 协议 ──
    let replayed = false;
    let pending: Array<{ seq: number; bytes: Uint8Array }> = [];
    let lastReplayedSeq = -1;

    const cleanupOutput = window.api.on<SessionOutputPayload>(
      EVENT_CHANNELS.SESSION_OUTPUT,
      (payload) => {
        if (payload.sessionId !== session.id) return;
        const bytes = decodeBase64ToBytes(payload.data);
        if (!replayed) {
          pending.push({ seq: payload.seq, bytes });
          return;
        }
        if (payload.seq > lastReplayedSeq) {
          term.write(bytes);
        }
      },
    );

    void window.api
      .invoke<GetScrollbackPayload, GetScrollbackResponse>(
        COMMAND_CHANNELS.SESSION_GET_SCROLLBACK,
        { sessionId: session.id },
      )
      .then(async (res) => {
        if (disposed) return;
        if (res.data) {
          // FLK-1:分片 write 避免 2MB scrollback 同步阻塞主线程 100-300ms
          // (用户看到的"切 session 后黑屏一下,然后内容瞬间涌出"卡顿)。
          // 16KB 切片 + setTimeout(0) 让出主线程,让 xterm RAF 和 IPC 都有
          // 机会运行,期间用户敲键的回显也能正常显示。
          const all = decodeBase64ToBytes(res.data);
          const CHUNK = 16 * 1024;
          for (let i = 0; i < all.length; i += CHUNK) {
            if (disposed) return;
            term.write(all.subarray(i, i + CHUNK));
            // 大于一片才让出 — 小 scrollback 一次过完
            if (all.length > CHUNK && i + CHUNK < all.length) {
              await new Promise((r) => setTimeout(r, 0));
            }
          }
        }
        if (disposed) return;
        lastReplayedSeq = res.lastSeq;
        for (const c of pending) {
          if (c.seq > lastReplayedSeq) term.write(c.bytes);
        }
        pending = [];
        replayed = true;
        // BETA-018 + SCROLL-1 第一轮:scrollback 重放完后锚底,消除"从上
        // 往下刷屏"观感。重放是同步内容回灌,不是历史浏览,应当锚定底部。
        //
        // SCROLL-1 第一轮 fence:scrollToBottom **必须**在 fence callback 内,
        // 而不是这里直接调。因为 `term.write()` 是异步排队 — 上面所有 write
        // 调用返回时,xterm parser 通常还在分批消化 writeBuffer,buffer 里
        // 只有已 parse 完的那部分行。直接 scrollToBottom 锚的"底"在后续
        // parser 解析新行时会被持续往下推 → 视觉上仍是从顶部往下铺。
        // 空 chunk + callback 走 xterm 内部 FIFO writeBuffer,callback
        // 由 parser drain 后触发(d.ts:1216:"callback that fires when
        // the data was processed by the parser") — 等价于一道 drain fence,
        // 锚的"底"才是真正的最终底。
        //
        // SCROLL-1 第二轮(2026-05-24,KBD-1 同 PR):第一轮 fence 只解决
        // "最终 scroll 位置"对不对,**没解决** "分片 write + setTimeout(0)
        // yield 之间,xterm RAF 把每个 chunk 处理后的中间 buffer 画到 canvas
        // 上"的中间帧暴露问题 — 用户报"刷屏速度快多了但还在抖"。修法是
        // 从 mount 起 host visibility:hidden + inert(见 JSX),fence cb +
        // scrollToBottom + 一帧 RAF(留给 xterm renderer 把最终 viewport
        // 画进 canvas)后才 setHostRevealed(true) reveal。第一可见帧 =
        // 终态 canvas 合成结果。
        //
        // disposed 兜底:fence / RAF 都是异步,期间用户可能已切走 / 关窗,
        // 组件已 dispose,跳过避免 throw / setState on unmounted。
        // 详见 docs/issues/scroll-1-session-switch-progressive-refresh.md。
        term.write('', () => {
          if (disposed) return;
          term.scrollToBottom();
          requestAnimationFrame(() => {
            if (disposed) return;
            setHostRevealed(true);
          });
        });
      })
      .catch((err) => {
        console.warn('[TerminalView] get-scrollback failed, falling back', err);
        if (disposed) return;
        for (const c of pending) term.write(c.bytes);
        pending = [];
        replayed = true;
        // BETA-018 + SCROLL-1:fallback 路径同样走 fence + scrollToBottom
        // + host reveal,保持 viewport 与 visibility 行为一致。即便走到
        // catch(get-scrollback rejected),也必须 reveal host,否则终端
        // 永远是隐藏的,用户看不到任何输出。
        term.write('', () => {
          if (disposed) return;
          term.scrollToBottom();
          requestAnimationFrame(() => {
            if (disposed) return;
            setHostRevealed(true);
          });
        });
      });

    // ResizeObserver — trailing debounce 150ms (用户勘误后续 #4)
    let lastCols = cols;
    let lastRows = rows;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const RESIZE_DEBOUNCE_MS = 150;

    const performResize = (): void => {
      if (disposed) return;
      try {
        fitAddon.fit();
      } catch (err) {
        // RSZ-4:fit 抛错原来 silent return,lastCols/Rows 不更新 → 下次
        // RO 仍会 retry。改 logger.warn 让排查 readline 行宽错位 / TUI
        // 重绘异常的开发者能看到上下文。
        console.warn('[TerminalView] fit() failed, will retry on next RO', err);
        return;
      }
      const newCols = term.cols;
      const newRows = term.rows;
      // XTM-8 / FLK-3:断言尺寸合理,不达不发 IPC。
      // fit 在容器 layout 未收敛时可能算出 cols=0 / rows=0,xterm 内部
      // InputHandler 在 0 维度下处理换行 / 光标位置错乱,导致首屏渲染
      // 像 "窄一条字" 闪过再撑开。20×5 是终端的最小实用阈值
      // (validateDimensions 在 main 端兜底用 1×1,这里在 renderer 提前 guard
      //  更严格,等下一轮 RO 拿到稳定 layout 再发)。
      if (newCols < 20 || newRows < 5) {
        return;
      }
      if (newCols === lastCols && newRows === lastRows) return;
      lastCols = newCols;
      lastRows = newRows;
      dispatch({
        type: 'view/update-terminal-dims',
        dims: { cols: newCols, rows: newRows },
      });
      window.api
        .invoke(COMMAND_CHANNELS.SESSION_RESIZE, {
          sessionId: session.id,
          cols: newCols,
          rows: newRows,
        })
        .catch(() => {});
    };

    const resizeObserver = new ResizeObserver(() => {
      if (disposed) return;
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        performResize();
      }, RESIZE_DEBOUNCE_MS);
    });
    resizeObserver.observe(container);

    // RSZ-2:最大化 / 还原是瞬时尺寸跳变,不属于连续拖拽,跳过 debounce 立即
    // 执行 — 体感"双击 → 屏幕变大 → 终端立即铺满",而不是 150ms 停顿。
    const cleanupMaxState = window.api.on<{ maximized: boolean }>(
      EVENT_CHANNELS.WINDOW_MAX_STATE_CHANGED,
      () => {
        if (disposed) return;
        if (resizeTimer !== null) {
          clearTimeout(resizeTimer);
          resizeTimer = null;
        }
        // 等一帧让 chrome layout 收敛后再 fit
        requestAnimationFrame(() => {
          if (disposed) return;
          performResize();
        });
      },
    );

    // 用户键盘输入 → 发回 PTY。
    //
    // TYP-1 / IPC-4:main 现在返回 { accepted, reason }。accepted=false 时
    // (session 已退出 / 已 destroy / 非 owner)给用户一个可见 toast,
    // 避免"敲键无反应 → 关窗口重开"的体感主诉。
    //
    // 节流:5 秒内只弹一次 reject toast,避免一长串按键每个都触发一条。
    //
    // XTM-7:打字时若有待定 resize,先 flush 再发输入 — 拖窗 + 立刻打字
    // 场景下避免 PTY 用旧 cols/rows 处理 prompt 折行错位。
    const dataHandler = term.onData((data) => {
      // [IME-1 PROBE A] 临时探针 — 检测 onData 收到的 data 是否疑似
      // "textarea 累积历史被冲刷出去"。判定下沉到 isLikelyHistoryFlush
      // (依赖 data.length + taLen 两个字段,不依赖子串比较,边界稳健):
      //   - data.length > 20  AND  taLen >= data.length + 8
      //
      // 原阈值 `data.length > 20` 会把"用户一口气输入 24 字按 Enter"的
      // 正常长 IME 提交误报为 leak (实例:2026-05-18 用户 head/tail/taTail
      // 三字段完全一致的现场)。新判定通过 taLen ≥ data.length + 8 的富余
      // 把"textarea 内容就是 data 本身"的长输入场景排除。
      //
      // 触发时:
      //   - push 一条 ev='leak' 到 ring(包含 leakLen/head/tail 字段)
      //   - drain ring 整体经 IPC 发到 main 端 logger.ime 落盘 — 不依赖
      //     DevTools 打开
      //   - 同时 console.warn 一条,DevTools 开着的话第一时间能看到
      const ta = container.querySelector(
        '.xterm-helper-textarea',
      ) as HTMLTextAreaElement | null;
      const taLen = ta?.value.length ?? -1;
      if (isLikelyHistoryFlush(data.length, taLen)) {
        const taTail = ta?.value.slice(-60) ?? '';
        const leakEntry: ImeProbeEntry = {
          t: performance.now().toFixed(1),
          ev: 'leak',
          taLen,
          taTail,
          leakLen: data.length,
          leakHead: data.slice(0, 60),
          leakTail: data.slice(-30),
        };
        imeProbeRing.push(leakEntry);
        const entries = imeProbeRing.drain();
        console.warn('[IME-LEAK]', leakEntry);
        // fire-and-forget — IPC 失败不阻塞用户输入,main handler 已有兜底
        void window.api
          .invoke<ImeProbeDumpPayload, ImeProbeDumpResponse>(
            COMMAND_CHANNELS.LOGGER_IME_DUMP,
            {
              meta: { t: leakEntry.t, sessionId: session.id },
              entries,
            },
          )
          .catch((err) => {
            console.warn('[IME-1] ime-dump IPC failed', err);
          });
      }
      if (resizeTimer !== null) {
        clearTimeout(resizeTimer);
        resizeTimer = null;
        performResize();
      }
      const base64 = encodeStringToBase64(data);
      void window.api
        .invoke<{ sessionId: string; data: string }, SendInputResponse>(
          COMMAND_CHANNELS.SESSION_SEND_INPUT,
          { sessionId: session.id, data: base64 },
        )
        .then((res) => {
          if (res.accepted) return;
          const now = Date.now();
          if (now - lastInputRejectToastAtRef.current < 5000) return;
          lastInputRejectToastAtRef.current = now;
          const msg =
            res.reason === 'pty-exited'
              ? '会话已退出,请按 × 关闭标签或新建终端'
              : res.reason === 'session-not-found'
                ? '会话已不存在(可能被其他窗口关闭)'
                : res.reason === 'not-owner'
                  ? '此会话由其他窗口持有,输入未送达'
                  : res.reason === 'pty-write-failed'
                    ? 'PTY 写入失败,终端可能需要重启'
                    : '输入未送达';
          toastRef.current.push({ kind: 'warn', message: msg });
        })
        .catch((err) => console.error('[TerminalView] send-input failed', err));
    });

    return () => {
      disposed = true;
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeObserver.disconnect();
      cleanupMaxState();
      cleanupOutput();
      detachImeWorkaround?.();
      // PASTE-1 cleanup:显式 remove。实际上 container 被 React 卸载时
      // listener 一起 GC,但留显式 remove 让未来读代码的人有 invariant 可循。
      helperTaForPaste?.removeEventListener('paste', pasteInterceptor, true);
      container.removeEventListener('paste', pasteInterceptor, true);
      dataHandler.dispose();
      searchResultsDisposable?.dispose();
      searchAddon.dispose();
      // PER-1:WebGL addon 必须在 term.dispose 之前释放,否则 GL context
      // 句柄泄漏(显存累积,大量切 session 后会触发显卡警告)
      try {
        webglAddon?.dispose();
      } catch {
        /* ignore */
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  // 主题运行时切换
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = getXtermTheme(themeId);
    term.options.minimumContrastRatio = isLightTheme(themeId)
      ? LIGHT_THEME_MIN_CONTRAST
      : 1;
  }, [themeId]);

  // SCROLL-1 二次修复 + KBD-1:reveal 后立即归还焦点给 helper-textarea。
  // 期间 host inert,焦点漂到 body / 上次 active 元素;reveal 让 inert 解除,
  // 才能让 focus 落上。不走 focusTerminalDom(它有 Modal/Settings/searchBar
  // guard,reveal 时这些 guard 通常不该挡 — 直接 termRef.focus 更明确)。
  useEffect(() => {
    if (!hostRevealed) return;
    if (searchVisibleRef.current) return; // 搜索栏在,焦点留搜索 input
    requestAnimationFrame(() => {
      termRef.current?.focus();
    });
  }, [hostRevealed]);

  // FLK-10:session.state='exited' 时 stop 光标闪烁,避免"会话已死但光标
  // 在闪"误导用户以为还能交互(配合 TYP-1 的 toast,死后输入有可见反馈)。
  // 状态回到 active/idle 时(实际不会发生,exited 是终态)恢复闪。
  //
  // CURSOR-1 后:not-exited 分支不再读 buffer.type — 应用要藏光标会发
  // ?25l,Marina 转发即可,无需启发式。
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (session.state === 'exited') {
      term.options.cursorBlink = false;
      term.options.cursorStyle = 'underline';
    } else {
      term.options.cursorStyle = 'bar';
      term.options.cursorBlink = true;
    }
  }, [session.state]);

  // 字体 / 字号 / 行高 运行时切换 + 重新 fit
  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term) return;
    term.options.fontFamily = fontFamily;
    term.options.fontSize = fontSize;
    term.options.lineHeight = lineHeight;
    if (fit) {
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
    }
  }, [fontFamily, fontSize, lineHeight]);

  // CP-4 勘误 #7:输入框内容 / 大小写切换 → 立即触发一次 findNext,
  // 这样用户每键入一个字母就能看到当前命中数;同时清空时清掉高亮。
  useEffect(() => {
    const search = searchRef.current;
    if (!search) return;
    if (!searchVisible) return;
    if (!searchText) {
      try {
        search.clearDecorations();
      } catch {
        /* ignore */
      }
      setSearchResults({ matches: 0, current: 0 });
      return;
    }
    // findNext 在没找到时不会丢命中位置;重新搜索时从头开始
    performSearch('next');
  }, [searchText, searchCaseSensitive, searchVisible, performSearch]);

  // 选中即复制 (settings.behavior.selectOnCopy)
  // 勘误第二轮:同 handleCopy/handlePaste,走 IPC clipboard 桥而非
  // navigator.clipboard,避开 web 权限拒绝。
  //
  // CPB-C2:trailing debounce 100ms — 避免拖选 50 字符触发 50 次 IPC
  // 写剪贴板(Windows 剪贴板 OLE 锁让输入法 / Quicker / Ditto 等剪贴板
  // 管理器频繁闪动)。trailing 让"拖完才写"语义,与原生选中即复制
  // 体验一致。
  useEffect(() => {
    const term = termRef.current;
    if (!term || !selectOnCopy) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onWindows = navigator.platform.toLowerCase().includes('win');
    const disp = term.onSelectionChange(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const sel = term.getSelection();
        if (!sel) return;
        // 同 handleCopy 的 CPB-C4:Windows 走 CRLF。
        const finalText = onWindows ? sel.replace(/\n/g, '\r\n') : sel;
        void writeClipboardText(finalText);
      }, 100);
    });
    return () => {
      if (timer) clearTimeout(timer);
      disp.dispose();
    };
  }, [selectOnCopy, session.id]);

  // CP-4 勘误 #6/#9:Ctrl+F / Esc 走 attachCustomKeyEventHandler (见 xterm
  // mount effect),不再用 wrapper 的 onKeyDown — 后者优先级低于 xterm 内部
  // keydown,在终端 focus 时根本拿不到。

  // 右键菜单 / 直接粘贴 — 取决于 settings.behavior.terminalRightClick
  const handleContextMenu = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (rightClickMode === 'paste') {
        void handlePaste();
        return;
      }
      const term = termRef.current;
      const hasSelection = !!term?.getSelection();
      const items: ContextMenuItem[] = [
        {
          icon: <Icon name="copy" size={13} />,
          label: '复制',
          hint: hasSelection ? '复制选中文字' : '没有选中文字',
          disabled: !hasSelection,
          onSelect: handleCopy,
        },
        {
          icon: <Icon name="paste" size={13} />,
          label: '粘贴',
          hint: '从剪贴板粘贴文字到终端',
          onSelect: handlePaste,
        },
        {
          icon: <Icon name="clear" size={13} />,
          label: '清屏',
          hint: '清空当前显示(scrollback 保留)',
          onSelect: handleClear,
        },
        {
          icon: <Icon name="search" size={13} />,
          label: '搜索',
          hint: 'Ctrl+F',
          onSelect: handleOpenSearch,
        },
      ];
      ctxApi.open({ x: e.clientX, y: e.clientY, title: '终端', items });
    },
    [rightClickMode, handlePaste, handleCopy, handleClear, handleOpenSearch, ctxApi],
  );

  // Windows Terminal 风格:拖文件进终端 → 把(必要时引号包裹的)路径作为
  // 输入发回 PTY。多文件用空格分隔。
  //
  // F12(DROP-1 重构):dragover preventDefault + dropEffect 现由 App.tsx
  // 的 window 监听器统一处理(看 data-drop-zone 属性识别本元素)。这里
  // 只剩 drop 消费逻辑。
  const handleTerminalDrop = useCallback(
    async (e: ReactDragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;
      // file.path 在 Electron 31 上仍由扩展 File API 提供(同 Sidebar 用法);
      // 32+ 才需要切 webUtils.getPathForFile,届时再迁移。
      const paths = files
        .map((f) => (f as File & { path?: string }).path)
        .filter((p): p is string => !!p && p.length > 0);
      if (paths.length === 0) return;
      // SEC-5:NTFS 允许文件名含 ; & ` 等 shell 元字符,拖进 bash / PowerShell
      // 会被解释成命令分隔符或子命令。罕见但能让"文件路径 foo;rm -rf ~/x"
      // 实际执行 rm。检测元字符弹 Modal.confirm 让用户确认。
      const SHELL_METAS = /[;&`$|<>(){}\\!*?\n\r]/;
      const dangerousPaths = paths.filter((p) => SHELL_METAS.test(p));
      if (dangerousPaths.length > 0) {
        const ok = await modal.confirm({
          title: '路径包含危险字符',
          message:
            '拖入的文件路径含 shell 元字符 (; & ` $ | < > 等)。\n' +
            '某些 shell 会把这些当成命令分隔符或子命令,导致意外执行。',
          preview: dangerousPaths.join('\n'),
          confirmLabel: '强制粘贴',
          cancelLabel: '取消',
          danger: true,
        });
        if (!ok) return;
      }
      const quoted = paths
        // Windows 路径不允许包含 ",所以只需对含空白的路径加双引号即可。
        .map((p) => (/\s/.test(p) ? `"${p}"` : p))
        .join(' ');
      const base64 = encodeStringToBase64(quoted);
      window.api
        .invoke(COMMAND_CHANNELS.SESSION_SEND_INPUT, {
          sessionId: session.id,
          data: base64,
        })
        .catch((err) => console.error('[TerminalView] drop send-input failed', err));
      // CPB-DROP-1:统一走 focusTerminal helper(原 termRef.current?.focus()
      // 是 paste/copy 之外开发者偶尔记得的不一致情况;现在所有副作用都走
      // 同一接口,搜索栏可见时自动跳过)。
      focusTerminal(termRef, searchVisibleRef);
    },
    [session.id, modal],
  );

  // M1-I:Ctrl + 滚轮调节字号 (spec 7.2.2)
  //
  // FLK-4:本地立即生效 + trailing 100ms 才广播 SETTINGS_UPDATE。
  //
  // 历史:每个 wheel tick 立即发 SETTINGS_UPDATE → main 广播给所有窗口
  // → 全部 TerminalView 跑 [fontFamily, fontSize, lineHeight] effect →
  // 全部 re-fit。三窗口五会话场景下单次滚轮触发 15 次 fit 抖动可见。
  //
  // 现在:term.options.fontSize 本地立刻改给用户视觉反馈,IPC 走 trailing
  // debounce — 滚动停 100ms 后才广播一次,跨窗口同步只发生一次。
  const wheelDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const pendingFontSizeRef = useRef<number | null>(null);
  const handleWheel = useCallback(
    (e: ReactWheelEvent<HTMLDivElement>) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const term = termRef.current;
      const fit = fitRef.current;
      const current = pendingFontSizeRef.current ?? fontSize;
      const delta = e.deltaY < 0 ? 1 : -1;
      const next = Math.max(8, Math.min(24, current + delta));
      if (next === current) return;
      pendingFontSizeRef.current = next;
      // 本地立即生效 — 用户视觉反馈
      if (term) term.options.fontSize = next;
      if (fit) {
        try {
          fit.fit();
        } catch {
          /* ignore */
        }
      }
      // trailing 100ms 才广播,避免跨窗口同步风暴
      if (wheelDebounceTimerRef.current) {
        clearTimeout(wheelDebounceTimerRef.current);
      }
      wheelDebounceTimerRef.current = setTimeout(() => {
        wheelDebounceTimerRef.current = null;
        const settled = pendingFontSizeRef.current;
        pendingFontSizeRef.current = null;
        if (settled === null) return;
        void window.api.invoke(COMMAND_CHANNELS.SETTINGS_UPDATE, {
          partial: { appearance: { terminalFontSize: settled } },
        });
      }, 100);
    },
    [fontSize],
  );

  const cwdDrifted =
    !!session.currentCwd &&
    !!session.originalCwd &&
    session.currentCwd.toLowerCase() !== session.originalCwd.toLowerCase();
  const statusDotClass =
    session.state === 'exited'
      ? 'status-dot exited'
      : session.state === 'idle'
        ? 'status-dot idle'
        : 'status-dot active';

  return (
    <div className="terminal-wrapper">
      <div className="terminal-statusbar">
        <span className={statusDotClass}>
          {session.state === 'exited' && session.exitCode === 0 && (
            <Check size={8} className="status-dot-icon ok" />
          )}
          {session.state === 'exited' &&
            typeof session.exitCode === 'number' &&
            session.exitCode !== 0 && (
              <X size={8} className="status-dot-icon fail" />
            )}
        </span>
        <span className="status-text">
          {session.displayName} · pid {session.pid > 0 ? session.pid : '—'}
          {session.state === 'exited' &&
            tx(` · 已退出 (exitCode=${session.exitCode ?? 0})`, ` · Exited (exitCode=${session.exitCode ?? 0})`)}
        </span>
        <button
          type="button"
          className="status-simple-toggle"
          onClick={() => dispatch({ type: 'view/toggle-simple-mode' })}
          title={
            simpleMode
              ? t('terminal.toolbar.fromSimple')
              : t('terminal.toolbar.toSimple')
          }
          aria-label={
            simpleMode
              ? t('terminal.toolbar.fromSimple')
              : t('terminal.toolbar.toSimple')
          }
        >
          {simpleMode ? <Maximize2 size={12} /> : <Minimize2 size={12} />}
        </button>
        <span
          className="status-cwd"
          title={
            cwdDrifted
              ? tx(`当前: ${session.currentCwd}\n原: ${session.originalCwd}`, `Current: ${session.currentCwd}\nOriginal: ${session.originalCwd}`)
              : session.currentCwd
          }
        >
          {cwdDrifted && <Icon name="alertTriangle" size={11} />}
          {cwdDrifted && ' '}
          {session.currentCwd}
        </span>
      </div>
      <div
        className="terminal-host"
        ref={containerRef}
        data-drop-zone="files"
        // SCROLL-1 二次修复 + KBD-1 整改(2026-05-24):replay 期间双重隔离 —
        //   visibility:hidden  → 消除中间帧暴露(canvas 继续累积像素,
        //                        只跳 compositing,fit 仍能算尺寸)
        //   inert              → 阻止 focus 落入子树,helper-textarea 不会
        //                        "假 focus",按键也不会误进 Sidebar / Modal
        //                        等其他 focusable 元素
        //
        // 产品决策:replay 100-500ms 内按键不响应是有意为之 — 符合"切换中"
        //   直觉,且避免 typeahead 误发到错位 focus(用户在 Sidebar 改名输入
        //   框残留焦点时切 session,敲 ls 三个字母可能进改名框)。
        //
        // 详见:docs/issues/scroll-1-session-switch-progressive-refresh.md
        //   docs/键盘交互规范.md(replay 期间 focus 行为不变式)
        inert={hostRevealed ? undefined : ''}
        style={hostRevealed ? undefined : { visibility: 'hidden' }}
        onContextMenu={handleContextMenu}
        onWheel={handleWheel}
        onDrop={handleTerminalDrop}
      />
      {searchVisible && (
        <div className="terminal-search-bar" role="search" aria-label={tx('终端搜索', 'Terminal search')}>
          <input
            ref={searchInputRef}
            type="text"
            className="terminal-search-input"
            placeholder={tx('搜索 (Enter 下一个 / Shift+Enter 上一个 / Esc 关闭)', 'Search (Enter = next, Shift+Enter = prev, Esc = close)')}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                handleCloseSearch();
              } else if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                performSearch(e.shiftKey ? 'previous' : 'next');
              }
            }}
          />
          {/* CP-4 勘误 #7:命中数显示 (来自 SearchAddon.onDidChangeResults) */}
          <span
            className="terminal-search-count"
            title={
              searchText
                ? tx(`${searchResults.matches} 个匹配,当前第 ${searchResults.current}`, `${searchResults.matches} matches, currently #${searchResults.current}`)
                : tx('输入关键字开始搜索', 'Type to start searching')
            }
          >
            {searchText
              ? searchResults.matches > 0
                ? `${searchResults.current}/${searchResults.matches}`
                : tx('无匹配', 'No match')
              : '—'}
          </span>
          <button
            type="button"
            className="terminal-search-btn"
            onClick={() => performSearch('previous')}
            title={tx('上一个 (Shift+Enter)', 'Previous (Shift+Enter)')}
            aria-label={tx('上一个匹配', 'Previous match')}
            disabled={!searchText || searchResults.matches === 0}
          >
            ↑
          </button>
          <button
            type="button"
            className="terminal-search-btn"
            onClick={() => performSearch('next')}
            title={tx('下一个 (Enter)', 'Next (Enter)')}
            aria-label={tx('下一个匹配', 'Next match')}
            disabled={!searchText || searchResults.matches === 0}
          >
            ↓
          </button>
          <button
            type="button"
            className={`terminal-search-btn${searchCaseSensitive ? ' active' : ''}`}
            onClick={() => setSearchCaseSensitive((v) => !v)}
            title={tx('区分大小写', 'Case sensitive')}
            aria-label={tx('区分大小写', 'Case sensitive')}
            aria-pressed={searchCaseSensitive}
          >
            Aa
          </button>
          <button
            type="button"
            className="terminal-search-btn close"
            onClick={handleCloseSearch}
            title={tx('关闭 (Esc)', 'Close (Esc)')}
            aria-label={tx('关闭搜索', 'Close search')}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 把粘贴 preview 里的控制字符渲染成可见占位符,避免预览本身被 ANSI 序列
 * 欺骗(用户看 confirm 预览觉得"就是普通文字啊",其实是 \x1b[2J 清屏 +
 * 实际命令)。
 *
 * 规则:
 * - C0(<0x20)除 \t \n \r 外替换成 `^X`(X 是 0x40+code 的字符,Caret notation)
 * - DEL (0x7F) → `^?`
 * - 不存在的 ESC 序列符号清晰可见
 * - \t \n \r 保留(预览块用 <pre> 渲染,这些会自然换行 / 缩进)
 * - 危险 Unicode 双向重写字符(U+200E/200F、U+202A-E、U+2066-9)
 *   → `\u{XXXX}` 字面占位
 */
function sanitizePastedPreview(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (
      code === 0x202a ||
      code === 0x202b ||
      code === 0x202c ||
      code === 0x202d ||
      code === 0x202e ||
      code === 0x200e ||
      code === 0x200f ||
      code === 0x200b ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      out += `\\u{${code.toString(16).toUpperCase().padStart(4, '0')}}`;
      continue;
    }
    if (ch === '\t' || ch === '\n' || ch === '\r') {
      out += ch;
      continue;
    }
    if (code < 0x20) {
      out += '^' + String.fromCharCode(code + 0x40);
      continue;
    }
    if (code === 0x7f) {
      out += '^?';
      continue;
    }
    out += ch;
  }
  return out;
}

function decodeBase64ToBytes(b64: string): Uint8Array {
  // OSC-7:JS 字符串 + charCodeAt 的循环换成 Uint8Array.from + 回调
  // V8 内部能识别这个常用模式并 SIMD 加速,实测 100KB chunk 解码从
  // 5-8ms 降到 1-2ms。视觉上"大段输出涌入"的卡顿明显减少。
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/**
 * 把 UTF-8 字符串编成 base64,chunked 优化用于大粘贴。
 *
 * CPB-P4:原版本 `for (const byte of utf8) binary += String.fromCharCode(byte)`
 * 在 1MB 输入下走 1M 次字符串 concat,V8 rope string 优化也压不住,主线程
 * 阻塞 100ms+。改成 64KB chunked + String.fromCharCode.apply 批量 + 末尾
 * btoa,实测 5MB 粘贴从 ~2s 降到 ~150ms。
 */
function encodeStringToBase64(str: string): string {
  const utf8 = new TextEncoder().encode(str);
  // 小字符串(< 8KB)走最简路径,避免 apply 调用开销在热路径占主导
  if (utf8.length < 8 * 1024) {
    return btoa(String.fromCharCode.apply(null, Array.from(utf8)));
  }
  // 大字符串分片 + 拼接。每片 32KB 避免 apply 超出 V8 args 上限(~65535)。
  const CHUNK = 32 * 1024;
  let binary = '';
  for (let i = 0; i < utf8.length; i += CHUNK) {
    const slice = utf8.subarray(i, i + CHUNK);
    binary += String.fromCharCode.apply(null, Array.from(slice));
  }
  return btoa(binary);
}
