/**
 * @file src/preload/index.ts
 * @purpose Preload 脚本,运行在每个 BrowserWindow 的隔离上下文中。
 *   通过 contextBridge 把白名单的 IPC 能力暴露给 renderer (window.api)。
 *
 * @关键设计:
 * - contextIsolation 启用,sandbox 关闭 (因 main 用 node-pty 等原生模块)
 * - 不直接暴露 ipcRenderer 给 renderer,只暴露包装好的 invoke / on
 * - 暴露 windowId 与 windowNumber (从 URL query 解析,见 ipc-protocol.md 2.2)
 * - 这里不写业务逻辑,只是一座最薄的桥
 *
 * @对应文档章节: docs/ipc-protocol.md 全部;软件定义书.md 9.2.2
 *
 * @AGENTS.md 5.1: preload 不需要单测 (简单转发)。
 *
 * @CP-1 阶段:
 * 暴露 windowId / windowNumber / invoke / on / getProtocolVersion。
 * 完整业务方法 (session/bookmark/template) 在 CP-2/3/4 加入。
 */
import { contextBridge, ipcRenderer, webFrame } from 'electron';
import { platform, release } from 'os';
import {
  COMMAND_CHANNELS,
  type ClipboardReadTextResponse,
  type ClipboardWriteTextPayload,
  type ClipboardWriteTextResponse,
  type CommandEnvelope,
} from '@shared/protocol';

/**
 * 解析当前 OS 的 Windows build 号(如 22621),非 Windows 或解析失败返回 null。
 * @xterm/xterm 6.x 的 windowsPty 选项需要 buildNumber 来决定 ConPTY workaround
 * 走哪条:>= 21376 走现代分支(reflow 启用),否则走兼容分支(scrollback 兜底
 * + 行尾启发式)。preload 是同步可访问 os 模块的最早入口,handshake 之前就能拿,
 * Terminal 实例构造时直接读 window.api.windowsBuild,无需绕一次 IPC。
 */
const windowsBuild = ((): number | null => {
  if (platform() !== 'win32') return null;
  const parts = release().split('.');
  if (parts.length < 3) return null;
  const n = Number.parseInt(parts[2] ?? '0', 10);
  return Number.isFinite(n) && n > 0 ? n : null;
})();

/**
 * 从 URL query string 提取窗口元数据。
 * Main 创建 BrowserWindow 时附加 ?windowId=...&windowNumber=...
 */
function readWindowParams(): { windowId: string; windowNumber: number } {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('windowId') ?? 'bootstrap';
  const numStr = params.get('windowNumber');
  const num = numStr ? Number.parseInt(numStr, 10) : 0;
  return {
    windowId: id,
    windowNumber: Number.isFinite(num) && num > 0 ? num : 0,
  };
}

const { windowId, windowNumber } = readWindowParams();

/**
 * 包装 ipcRenderer.invoke,自动附加 windowId / requestId / payload 信封。
 */
async function invoke<P, R>(channel: string, payload: P): Promise<R> {
  const envelope: CommandEnvelope<P> = {
    windowId,
    requestId: crypto.randomUUID(),
    payload,
  };
  return ipcRenderer.invoke(channel, envelope);
}

/**
 * 订阅 main 推送的事件,返回取消订阅函数。
 * handler 收到的是事件信封的 payload 部分,信封外壳在此处剥离。
 */
function on<P>(channel: string, handler: (payload: P) => void): () => void {
  const wrapped = (_event: unknown, envelope: { payload: P } | undefined): void => {
    if (envelope && typeof envelope === 'object' && 'payload' in envelope) {
      handler(envelope.payload);
    }
  };
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.off(channel, wrapped);
}

/**
 * 暴露给 renderer 的 API。renderer 通过 window.api 访问。
 * 类型在 src/renderer/global.d.ts 中声明。
 */
const api = {
  /** 当前窗口 UUID (CP-1 占位 'bootstrap',WindowManager 创建时为真实 UUID) */
  windowId,
  /** 当前窗口编号 (Window N),0 表示未由 WindowManager 分配 */
  windowNumber,
  /**
   * Windows build 号(如 22621),非 Windows 或解析失败为 null。
   * TerminalView 构造 xterm 实例时传给 windowsPty.buildNumber。
   */
  windowsBuild,

  /** 协议版本握手 — handshake 第一步 (ipc-protocol.md 第 4 章) */
  getProtocolVersion: (): Promise<{
    protocolVersion: number;
    buildVersion: string;
    /** DEV-COEXIST 2026-05-16:dev / portable / installed,titlebar 后缀用 */
    buildType: 'dev' | 'portable' | 'installed';
  }> => invoke(COMMAND_CHANNELS.APP_GET_PROTOCOL_VERSION, undefined),

  /** 通用命令调用,channel 名从 @shared/protocol 取常量 */
  invoke,

  /** 订阅事件 */
  on,

  /**
   * 设置当前 renderer 的 zoom factor (CP-4 uiZoom)。webFrame 只在
   * preload 上下文可用,所以这里包装一下。范围由 main 端 SettingsManager
   * 校验为 [0.75, 1.5];这里只做最低限度兜底,异常值不应用。
   */
  setUiZoom(factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0) return;
    webFrame.setZoomFactor(factor);
  },

  /**
   * 勘误第二轮:剪贴板桥(走 main IPC)。
   *
   * 原因:navigator.clipboard.* 在 Electron file:// 上下文需 web Permission
   * 放行,我们的 setPermissionRequestHandler 早期把 clipboard-write 拒了 →
   * 选中即复制 / 右键粘贴 / Ctrl+Shift+C/V 全部静默失败。
   *
   * 实现选择:走 ipcRenderer.invoke 调 main 端 Electron clipboard 模块,
   * 而非直接在 preload import 'electron' 的 clipboard。原因:
   *   1. dev 模式下 preload 不一定会被 electron-vite 立即重打包,本字段
   *      可能是旧版而不存在;
   *   2. main IPC 路径只要 main 重启就生效,electron-vite dev 在主进程文件
   *      变化时会自动重启 Electron 进程,行为一致。
   *
   * 异步,但 onSelectionChange / handleCopy 都允许 fire-and-forget。
   */
  clipboard: {
    async readText(): Promise<string> {
      try {
        const res = await invoke<undefined, ClipboardReadTextResponse>(
          COMMAND_CHANNELS.SYSTEM_CLIPBOARD_READ_TEXT,
          undefined,
        );
        return res.text;
      } catch {
        return '';
      }
    },
    async writeText(text: string): Promise<boolean> {
      try {
        const res = await invoke<
          ClipboardWriteTextPayload,
          ClipboardWriteTextResponse
        >(COMMAND_CHANNELS.SYSTEM_CLIPBOARD_WRITE_TEXT, { text });
        return res.ok;
      } catch {
        return false;
      }
    },
  },
} as const;

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
