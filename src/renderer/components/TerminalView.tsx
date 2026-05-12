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
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import {
  COMMAND_CHANNELS,
  EVENT_CHANNELS,
  type GetScrollbackPayload,
  type GetScrollbackResponse,
  type SessionOutputPayload,
} from '@shared/protocol';
import type { SessionInfo, ThemeId } from '@shared/types';
import { useAppDispatch, useAppState } from '../store';
import { Icon, type IconName } from './icons';
import '@xterm/xterm/css/xterm.css';

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
    brightBlack: '#9893a5',
    brightRed: '#b4637a',
    brightGreen: '#286983',
    brightYellow: '#ea9d34',
    brightBlue: '#56949f',
    brightMagenta: '#907aa9',
    brightCyan: '#d7827e',
    brightWhite: '#575279',
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
    background: '#231a30',
    foreground: '#f7e6f5',
    cursor: '#f7a8d8',
    cursorAccent: '#231a30',
    selectionBackground: '#4d3a5b',
    black: '#3a2c4a',
    red: '#ff6ea1',
    green: '#a3e8c2',
    yellow: '#ffd479',
    blue: '#9bbbff',
    magenta: '#d4a3ff',
    cyan: '#a8e6f0',
    white: '#f7e6f5',
    brightBlack: '#7a6488',
    brightRed: '#ff6ea1',
    brightGreen: '#a3e8c2',
    brightYellow: '#ffd479',
    brightBlue: '#9bbbff',
    brightMagenta: '#d4a3ff',
    brightCyan: '#a8e6f0',
    brightWhite: '#f7e6f5',
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
};

function getXtermTheme(themeId: ThemeId | undefined): ITheme {
  return XTERM_THEMES[themeId ?? 'rose-pine'] ?? XTERM_THEMES['rose-pine'];
}

interface TerminalViewProps {
  /**
   * 必须满足 session.ownerWindowId === myWindowId — 父组件 MainPane 通过
   * getDisplayableSession 强制保证。这里不再做 isOwner=false 的占位 UI。
   */
  session: SessionInfo;
  myWindowId: string;
}

interface ContextMenuState {
  x: number;
  y: number;
  hasSelection: boolean;
}

export function TerminalView({ session, myWindowId }: TerminalViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);

  const appState = useAppState();
  const dispatch = useAppDispatch();
  const themeId = appState.settings.appearance?.theme;
  const fontSize = appState.settings.appearance?.terminalFontSize ?? 13;
  const fontFamily =
    appState.settings.appearance?.terminalFontFamily ??
    '"Cascadia Mono", "JetBrains Mono", Consolas, "LXGW WenKai Mono", monospace';
  const lineHeight = appState.settings.appearance?.terminalLineHeight ?? 1.2;
  const selectOnCopy = appState.settings.behavior?.selectOnCopy ?? true;
  const rightClickMode = appState.settings.behavior?.terminalRightClick ?? 'menu';

  // 把"创建期"读到的初始值用 useMemo 锁定 (terminal 创建后只用 mutator 调整),
  // 否则每次 settings 引用变化都会重建 xterm 实例。
  const initialTheme = useMemo(() => getXtermTheme(themeId), [
    // initial 仅依赖一次,但 themeId 仅作 dep 进入 effect 不等于 recreate
    // 这里读初值,运行时切换走另一个 effect。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    session.id,
  ]);

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

  // 右键菜单状态
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);

  // ── 操作:复制 / 粘贴 / 清屏 / 搜索 ──
  const handleCopy = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    const sel = term.getSelection();
    if (sel) {
      void navigator.clipboard.writeText(sel).catch((err) => {
        console.warn('[TerminalView] clipboard.writeText failed', err);
      });
    }
  }, []);

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      // CP-4 勘误 #10:多行粘贴警告。剪贴板含换行 (\r 或 \n) → 弹确认,
      // 防止意外把整段脚本喂给 shell 触发执行。普通单行粘贴不打扰。
      // 行数估算:把 \r\n 归一化后按 \n 切。
      const normalized = text.replace(/\r\n?/g, '\n');
      const lineCount = normalized.split('\n').length;
      if (lineCount > 1) {
        const preview =
          normalized.length > 200
            ? normalized.slice(0, 200) + '…'
            : normalized;
        const ok = window.confirm(
          `即将粘贴 ${lineCount} 行内容到终端。\n\n` +
            `多行内容可能被 shell 当成多条命令立即执行。\n\n` +
            `预览:\n${preview}\n\n` +
            `继续粘贴?`,
        );
        if (!ok) return;
      }
      const base64 = encodeStringToBase64(text);
      await window.api.invoke(COMMAND_CHANNELS.SESSION_SEND_INPUT, {
        sessionId: session.id,
        data: base64,
      });
    } catch (err) {
      console.warn('[TerminalView] paste failed', err);
    }
  }, [session.id]);

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

  // ── xterm 实例生命周期 ──
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    void myWindowId;

    const term = new Terminal({
      fontFamily,
      fontSize,
      lineHeight,
      cursorBlink: true,
      cursorStyle: 'bar',
      theme: initialTheme,
      scrollback: 5000,
      allowProposedApi: false,
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

    // CP-4 勘误 #6/#9:Ctrl+F、Esc 必须在 xterm 把它们转成 ^F / 0x1B 字节
    // 之前拦下来。React 在 wrapper div 上的 onKeyDown 优先级低 (xterm 内部
    // 直接读 keydown,转成字节写 PTY)。attachCustomKeyEventHandler 是 xterm
    // 给的官方拦截点:返回 false 即"我已处理,xterm 不要继续"。
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      // Ctrl+F (Cmd+F on macOS) → 唤出搜索栏
      if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey) {
        const key = ev.key.toLowerCase();
        if (key === 'f') {
          handleOpenSearch();
          return false;
        }
      }
      // Esc:仅在搜索栏可见时拦截 — 否则 Esc 应正常透传给终端 (vim 等需要)
      if (ev.key === 'Escape' && searchVisibleRef.current) {
        handleCloseSearch();
        return false;
      }
      return true; // 其他键交给 xterm 默认处理
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

    term.open(container);

    try {
      fitAddon.fit();
    } catch {
      /* 忽略极小窗口 fit 错误 */
    }

    const cols = term.cols;
    const rows = term.rows;

    // fit 后把精确 cols/rows 写回 store。后续 SESSION_CREATE 调用读
    // store.lastTerminalDims,确保 spawn PTY 时尺寸已经接近 fit 值,
    // 避免 ConPTY 的 spawn-then-resize 重画 banner quirk (用户勘误 #2)。
    dispatch({ type: 'view/update-terminal-dims', dims: { cols, rows } });

    // 启动后立即同步初始尺寸给 PTY
    if (cols !== session.cols || rows !== session.rows) {
      window.api
        .invoke(COMMAND_CHANNELS.SESSION_RESIZE, {
          sessionId: session.id,
          cols,
          rows,
        })
        .catch(() => {});
    }

    // ── Scrollback replay 协议 ──
    let replayed = false;
    let pending: Array<{ seq: number; bytes: Uint8Array }> = [];
    let lastReplayedSeq = -1;
    let disposed = false;

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
      .then((res) => {
        if (disposed) return;
        if (res.data) {
          term.write(decodeBase64ToBytes(res.data));
        }
        lastReplayedSeq = res.lastSeq;
        for (const c of pending) {
          if (c.seq > lastReplayedSeq) term.write(c.bytes);
        }
        pending = [];
        replayed = true;
      })
      .catch((err) => {
        console.warn('[TerminalView] get-scrollback failed, falling back', err);
        if (disposed) return;
        for (const c of pending) term.write(c.bytes);
        pending = [];
        replayed = true;
      });

    // 用户键盘输入 → 发回 PTY
    const dataHandler = term.onData((data) => {
      const base64 = encodeStringToBase64(data);
      window.api
        .invoke(COMMAND_CHANNELS.SESSION_SEND_INPUT, {
          sessionId: session.id,
          data: base64,
        })
        .catch((err) => console.error('[TerminalView] send-input failed', err));
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
      } catch {
        return;
      }
      const newCols = term.cols;
      const newRows = term.rows;
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

    return () => {
      disposed = true;
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeObserver.disconnect();
      cleanupOutput();
      dataHandler.dispose();
      searchResultsDisposable?.dispose();
      searchAddon.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, myWindowId]);

  // 主题运行时切换
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = getXtermTheme(themeId);
  }, [themeId]);

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
  useEffect(() => {
    const term = termRef.current;
    if (!term || !selectOnCopy) return undefined;
    // xterm 的 onSelectionChange 在选区变化时触发;空选区也会触发(选区清空)
    const disp = term.onSelectionChange(() => {
      const sel = term.getSelection();
      if (!sel) return;
      navigator.clipboard.writeText(sel).catch(() => {
        // 失败静默 (剪贴板权限拒绝等)
      });
    });
    return () => disp.dispose();
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
      setCtxMenu({ x: e.clientX, y: e.clientY, hasSelection });
    },
    [rightClickMode, handlePaste],
  );

  // M1-I:Ctrl + 滚轮调节字号 (spec 7.2.2)
  const handleWheel = useCallback(
    (e: ReactWheelEvent<HTMLDivElement>) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? 1 : -1;
      const next = Math.max(8, Math.min(24, fontSize + delta));
      if (next === fontSize) return;
      void window.api.invoke(COMMAND_CHANNELS.SETTINGS_UPDATE, {
        partial: { appearance: { terminalFontSize: next } },
      });
    },
    [fontSize],
  );

  // 关闭右键菜单 — 全局点击 / Esc / 滚动
  useEffect(() => {
    if (!ctxMenu) return undefined;
    const close = (): void => setCtxMenu(null);
    const onKey = (ev: globalThis.KeyboardEvent): void => {
      if (ev.key === 'Escape') close();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('wheel', close, { passive: true });
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('wheel', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [ctxMenu]);

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
        <span className={statusDotClass} />
        <span className="status-text">
          {session.displayName} · pid {session.pid > 0 ? session.pid : '—'}
          {session.state === 'exited' &&
            ` · 已退出 (exitCode=${session.exitCode ?? 0})`}
        </span>
        <span
          className="status-cwd"
          title={
            cwdDrifted
              ? `当前: ${session.currentCwd}\n原: ${session.originalCwd}`
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
        onContextMenu={handleContextMenu}
        onWheel={handleWheel}
      />
      {searchVisible && (
        <div className="terminal-search-bar" role="search" aria-label="终端搜索">
          <input
            ref={searchInputRef}
            type="text"
            className="terminal-search-input"
            placeholder="搜索 (Enter 下一个 / Shift+Enter 上一个 / Esc 关闭)"
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
                ? `${searchResults.matches} 个匹配,当前第 ${searchResults.current}`
                : '输入关键字开始搜索'
            }
          >
            {searchText
              ? searchResults.matches > 0
                ? `${searchResults.current}/${searchResults.matches}`
                : '无匹配'
              : '—'}
          </span>
          <button
            type="button"
            className="terminal-search-btn"
            onClick={() => performSearch('previous')}
            title="上一个 (Shift+Enter)"
            aria-label="上一个匹配"
            disabled={!searchText || searchResults.matches === 0}
          >
            ↑
          </button>
          <button
            type="button"
            className="terminal-search-btn"
            onClick={() => performSearch('next')}
            title="下一个 (Enter)"
            aria-label="下一个匹配"
            disabled={!searchText || searchResults.matches === 0}
          >
            ↓
          </button>
          <button
            type="button"
            className={`terminal-search-btn${searchCaseSensitive ? ' active' : ''}`}
            onClick={() => setSearchCaseSensitive((v) => !v)}
            title="区分大小写"
            aria-label="区分大小写"
            aria-pressed={searchCaseSensitive}
          >
            Aa
          </button>
          <button
            type="button"
            className="terminal-search-btn close"
            onClick={handleCloseSearch}
            title="关闭 (Esc)"
            aria-label="关闭搜索"
          >
            ×
          </button>
        </div>
      )}
      {ctxMenu && (
        <TerminalContextMenu
          state={ctxMenu}
          onCopy={handleCopy}
          onPaste={handlePaste}
          onClear={handleClear}
          onSearch={handleOpenSearch}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}

interface TerminalContextMenuProps {
  state: ContextMenuState;
  onCopy: () => void;
  onPaste: () => void | Promise<void>;
  onClear: () => void;
  onSearch: () => void;
  onClose: () => void;
}

function TerminalContextMenu({
  state,
  onCopy,
  onPaste,
  onClear,
  onSearch,
  onClose,
}: TerminalContextMenuProps): JSX.Element {
  // CP-4 勘误 #11:右键菜单图标改用 lucide,不再 emoji
  const items: Array<{
    iconName: IconName;
    label: string;
    hint?: string;
    disabled?: boolean;
    onSelect: () => void | Promise<void>;
  }> = [
    {
      iconName: 'copy',
      label: '复制',
      hint: state.hasSelection ? '复制选中文字' : '没有选中文字',
      disabled: !state.hasSelection,
      onSelect: onCopy,
    },
    {
      iconName: 'paste',
      label: '粘贴',
      hint: '从剪贴板粘贴文字到终端',
      onSelect: onPaste,
    },
    {
      iconName: 'clear',
      label: '清屏',
      hint: '清空当前显示(scrollback 保留)',
      onSelect: onClear,
    },
    {
      iconName: 'search',
      label: '搜索',
      hint: 'Ctrl+F',
      onSelect: onSearch,
    },
  ];
  return (
    <div
      className="ctx-menu"
      style={{ left: state.x, top: state.y }}
      onMouseDown={(e) => e.stopPropagation()}
      role="menu"
    >
      <div className="ctx-menu-title">终端</div>
      {items.map((it, idx) => (
        <button
          key={idx}
          type="button"
          className="ctx-menu-item"
          disabled={it.disabled}
          title={it.hint}
          onClick={() => {
            void it.onSelect();
            onClose();
          }}
        >
          <span className="ctx-menu-check">
            <Icon name={it.iconName} size={13} />
          </span>
          <span className="ctx-menu-label">{it.label}</span>
        </button>
      ))}
    </div>
  );
}

function decodeBase64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeStringToBase64(str: string): string {
  const utf8 = new TextEncoder().encode(str);
  let binary = '';
  for (const byte of utf8) binary += String.fromCharCode(byte);
  return btoa(binary);
}
