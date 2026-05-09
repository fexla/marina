/**
 * @file src/renderer/components/TerminalView.tsx
 * @purpose CP-1 终端视图。在窗口内挂载一个 xterm.js 实例,通过 IPC
 *   连接到 main 进程的 PowerShell PTY,完成双向字节流 + 自动 fit。
 *
 * @关键设计:
 * - xterm.js + FitAddon + WebLinksAddon (Search 等其他 addon 在 CP-4 接入)
 * - 主题颜色与 CSS variables 同步 (软件定义书 5.1.9 Rose Pine)
 * - 字节流: PTY → base64 → IPC → atob → xterm.write
 *           xterm.onData → utf8 → base64 → IPC → PTY
 * - resize: ResizeObserver 监听容器大小,fit 后把 cols/rows 同步给 PTY
 * - 组件卸载时关闭 session (避免僵尸 PTY,虽然 main 端窗口关闭也会清理)
 *
 * @对应文档章节:
 *   软件定义书.md 5.1.4 (终端体验)、5.1.9 (主题);
 *   ipc-protocol.md 第 5.2、第 8 (字节流);
 *   AGENTS.md CP-1 完成标志 ("xterm 里能正确显示 PowerShell 提示符,能输入命令")
 *
 * @CP-1 限制:
 * - 一窗一终端 (sessionId = windowId)
 * - 不接入 OSC 1337 cwd 跟踪 (CP-3)
 * - 不接入复制粘贴菜单 / 搜索 (CP-4)
 * - 简单的 Rose Pine 默认主题,主题切换在 CP-4
 */
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { COMMAND_CHANNELS, EVENT_CHANNELS, type SessionOutputPayload } from '@shared/protocol';
import '@xterm/xterm/css/xterm.css';

/**
 * Rose Pine xterm 主题 (软件定义书 5.1.9)。
 * 16 色 ANSI 映射尽量贴近官方 Rose Pine 调色板,确保 ls --color 等
 * 输出在视觉上与 UI 主题一致。
 */
const ROSE_PINE_XTERM_THEME = {
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
} as const;

interface TerminalViewProps {
  /** 当前窗口的 ID,作为 session 创建依据 (CP-1 sessionId = windowId) */
  windowId: string;
}

interface TerminalSessionInfo {
  sessionId: string;
  pid: number;
  shellPath: string;
  cwd: string;
}

export function TerminalView({ windowId }: TerminalViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [info, setInfo] = useState<TerminalSessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (windowId === 'bootstrap') {
      // bootstrap 占位窗口 (没经过 WindowManager 分配真实 UUID),不启 PTY
      setError(
        'windowId 是 bootstrap 占位值,说明窗口不是由 WindowManager 创建的。' +
          '检查 main/index.ts 是否走了正常 bootstrap 流程。',
      );
      return undefined;
    }

    const container = containerRef.current;
    if (!container) return undefined;

    // —— 创建 xterm 实例 ——
    const term = new Terminal({
      fontFamily:
        '"Cascadia Mono", "JetBrains Mono", Consolas, "LXGW WenKai Mono", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      theme: ROSE_PINE_XTERM_THEME,
      scrollback: 5000,
      allowProposedApi: false,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);

    term.open(container);

    // 初次 fit 后才知道实际 cols/rows
    let cols = 80;
    let rows = 24;
    try {
      fitAddon.fit();
      cols = term.cols;
      rows = term.rows;
    } catch {
      // 极小窗口下 fit 可能抛错,fallback 到 80x24
    }

    // —— 创建 PTY session ——
    let cleanupOutput: (() => void) | null = null;
    let cleanupExited: (() => void) | null = null;
    let disposed = false;
    let sessionId: string | null = null;

    void (async () => {
      try {
        const response = await window.api.invoke<
          { cols: number; rows: number },
          TerminalSessionInfo
        >(COMMAND_CHANNELS.SESSION_CREATE, { cols, rows });
        if (disposed) {
          // 组件已卸载,关掉刚开的 PTY 避免泄漏
          await window.api
            .invoke(COMMAND_CHANNELS.SESSION_CLOSE, { sessionId: response.sessionId })
            .catch(() => {});
          return;
        }
        sessionId = response.sessionId;
        setInfo(response);

        // 接收 PTY 输出
        cleanupOutput = window.api.on<SessionOutputPayload>(
          EVENT_CHANNELS.SESSION_OUTPUT,
          (payload) => {
            if (payload.sessionId !== response.sessionId) return;
            const bytes = decodeBase64ToBytes(payload.data);
            term.write(bytes);
          },
        );

        // PTY 退出 → 显示提示
        cleanupExited = window.api.on<{ sessionId: string; exitCode: number }>(
          EVENT_CHANNELS.SESSION_EXITED,
          (payload) => {
            if (payload.sessionId !== response.sessionId) return;
            term.write(
              `\r\n\x1b[33m[EasyTerm] PTY 退出,exitCode=${payload.exitCode}\x1b[0m\r\n`,
            );
          },
        );

        // 把用户输入回传给 PTY
        term.onData((data) => {
          const base64 = encodeStringToBase64(data);
          window.api
            .invoke(COMMAND_CHANNELS.SESSION_SEND_INPUT, {
              sessionId: response.sessionId,
              data: base64,
            })
            .catch((err) => {
              console.error('[TerminalView] send-input failed', err);
            });
        });
      } catch (err) {
        if (!disposed) {
          setError(
            `创建 session 失败: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    })();

    // —— 监听容器大小变化,自动 resize ——
    const resizeObserver = new ResizeObserver(() => {
      if (disposed) return;
      try {
        fitAddon.fit();
      } catch {
        return;
      }
      const newCols = term.cols;
      const newRows = term.rows;
      if (sessionId) {
        window.api
          .invoke(COMMAND_CHANNELS.SESSION_RESIZE, {
            sessionId,
            cols: newCols,
            rows: newRows,
          })
          .catch((err) => {
            console.warn('[TerminalView] resize PTY failed', err);
          });
      }
    });
    resizeObserver.observe(container);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      cleanupOutput?.();
      cleanupExited?.();
      if (sessionId) {
        // 主动关闭 session;main 端窗口关闭时也会清理,这里是双保险
        window.api
          .invoke(COMMAND_CHANNELS.SESSION_CLOSE, { sessionId })
          .catch(() => {});
      }
      term.dispose();
    };
  }, [windowId]);

  if (error) {
    return (
      <div className="terminal-error">
        <h2>终端启动失败</h2>
        <pre>{error}</pre>
        <p className="hint">
          常见排查: 1) 检查 PowerShell 是否在 PATH; 2) 检查 node-pty 是否
          为当前 Electron 重编译过 (跑 npm run postinstall);
          3) 看主进程日志。
        </p>
      </div>
    );
  }

  return (
    <div className="terminal-wrapper">
      <div className="terminal-statusbar">
        {info ? (
          <>
            <span className="status-dot active" />
            <span className="status-text">PowerShell · pid {info.pid}</span>
            <span className="status-cwd" title={info.cwd}>
              {info.cwd}
            </span>
          </>
        ) : (
          <>
            <span className="status-dot pending" />
            <span className="status-text">正在启动 PowerShell…</span>
          </>
        )}
      </div>
      <div className="terminal-host" ref={containerRef} />
    </div>
  );
}

// ─── 帮助函数:base64 ⇄ bytes ─────────────────────────────────────────

function decodeBase64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function encodeStringToBase64(str: string): string {
  // 用 TextEncoder 拿到 UTF-8 字节,再走 btoa
  const utf8 = new TextEncoder().encode(str);
  let binary = '';
  for (const byte of utf8) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
