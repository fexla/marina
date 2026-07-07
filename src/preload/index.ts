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
  type GetRemoteConnectionPayload,
  type GetRemoteConnectionResponse,
} from '@shared/protocol';
import { RemoteTransport, ConnectError, ConnectErrorCode, type WSLike } from './remote-transport';

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
function readWindowParams(): { windowId: string; windowNumber: number; backend: string | null } {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('windowId') ?? 'bootstrap';
  const numStr = params.get('windowNumber');
  const num = numStr ? Number.parseInt(numStr, 10) : 0;
  // v2.0 每窗口后端:?backend=<profileId> = 远程窗口;缺失/'local' = 本地窗口
  const backendRaw = params.get('backend');
  const backend = backendRaw && backendRaw !== 'local' ? backendRaw : null;
  return {
    windowId: id,
    windowNumber: Number.isFinite(num) && num > 0 ? num : 0,
    backend,
  };
}

const { windowId, windowNumber, backend } = readWindowParams();

// 浏览器原生 WebSocket 适配成 WSLike(RemoteTransport 期望的接口)。
// preload 上下文有原生 WebSocket;这里桥接 on*/send/close + readyState。
function browserWs(url: string): WSLike {
  const ws = new WebSocket(url);
  const adapter: WSLike = {
    get readyState() {
      return ws.readyState;
    },
    OPEN: WebSocket.OPEN,
    send: (d: string) => ws.send(d),
    close: () => ws.close(),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  ws.onopen = () => adapter.onopen?.();
  ws.onmessage = (ev: MessageEvent) => adapter.onmessage?.({ data: ev.data });
  // 透传 close code/reason(daemon 认证失败用 4003/4001,client 端错误分析依赖它)。
  ws.onclose = (ev: CloseEvent) =>
    adapter.onclose?.({ code: ev.code, reason: ev.reason });
  ws.onerror = (e) => adapter.onerror?.(e);
  return adapter;
}

// ── v2.0 远程后端 transport gate(ADR-014 / §14.9,每窗口后端)──
// backend=null(本地窗口):invoke/on 走 ipcRenderer,**零回归**。
// backend=profileId(远程窗口):首次 invoke 时拉该 profile 的 connection,
// 建 RemoteTransport 连 ws://daemon,后续 invoke/on 走 WS。
// on 本地路径立即注册(零回归);远程路径 transport ready 后注册。
let remoteTransport: RemoteTransport | null = null;
let transportInit: Promise<void> | null = null;
function ensureTransport(): Promise<void> {
  if (transportInit) return transportInit;
  transportInit = (async () => {
    // 每窗口后端:窗口创建时定死 backend(URL ?backend=),生命周期内不变。
    if (!backend) return; // 本地窗口
    try {
      const res = (await ipcRenderer.invoke(
        COMMAND_CHANNELS.REMOTE_PROFILE_GET_CONNECTION,
        {
          windowId,
          requestId: crypto.randomUUID(),
          payload: { profileId: backend },
        } as CommandEnvelope<GetRemoteConnectionPayload>,
      )) as GetRemoteConnectionResponse;
      if (res?.connection) {
        const { host, token } = res.connection;
        // profile 数据不全 → 明确报 PROFILE_INCOMPLETE(本地数据问题,非网络)。
        if (!host || !token) {
          throw new ConnectError(
            ConnectErrorCode.PROFILE_INCOMPLETE,
            `[preload] 该远程电脑配置不完整(缺 ${!host ? 'IP' : '密码'}),请在设置里补全。`,
          );
        }
        // 端口扫描:从 32780 起,串行尝试 32780-32789。端口关闭 TCP RST 快速失败,
        // 遇开放的错误端口才等握手超时(1.5s)。找到第一个握手通过的端口。
        // 设计动机(用户需求):client 只需 IP,不用输端口。daemon 默认 32780,
        // 扫描一小段兑底 daemon 端口被占改用别的。
        const PORT_FROM = 32780;
        const PORT_COUNT = 10;
        let portFound: number | null = null;
        // 收集各端口尝试的错误码,全失败时选最有价值的报告给用户。
        const tried: Array<{ port: number; code: string; message: string }> = [];
        for (let i = 0; i < PORT_COUNT; i++) {
          const port = PORT_FROM + i;
          const probe = new RemoteTransport({
            url: `ws://${host}:${port}`,
            token,
            wsFactory: browserWs,
            authTimeoutMs: 3000,
            autoReconnect: false,
          });
          try {
            await probe.ready;
            probe.close();
            portFound = port;
            break;
          } catch (err) {
            probe.close();
            const code = err instanceof ConnectError ? err.code : 'UNKNOWN';
            const message = err instanceof Error ? err.message : String(err);
            tried.push({ port, code, message });
          }
        }
        if (portFound === null) {
          // 选最有价值的错误码(优先级:AUTH_REJECTED > WS_HANDSHAKE > AUTH_TIMEOUT > TCP_UNREACHABLE)。
          // AUTH_REJECTED 最有价值 —— 说明某个端口是 Marina daemon 但密码错(用户改密码即可)。
          // 全部 TCP_UNREACHABLE → server 根本没起 / 网络不通(最常见)。
          const priority: Record<string, number> = {
            AUTH_REJECTED: 0,
            WS_HANDSHAKE: 1,
            AUTH_TIMEOUT: 2,
            TCP_UNREACHABLE: 3,
            UNKNOWN: 4,
          };
          const best = [...tried].sort(
            (a, b) => (priority[a.code] ?? 9) - (priority[b.code] ?? 9),
          )[0];
          const bestCode = best?.code ?? 'TCP_UNREACHABLE';
          const triedCodes = tried.map((t) => t.code);
          // 构造给 renderer 的诊断信息(含 host/端口范围/最有价值原因)。
          throw new ConnectError(
            bestCode as ConnectErrorCode,
            `[preload] 连接 ${host}:${PORT_FROM}-${PORT_FROM + PORT_COUNT - 1} 全部失败。` +
              `最有价值原因:${best?.message ?? '无响应'}。` +
              `尝试详情:${tried.map((t) => `${t.port}=${t.code}`).join(', ')}。` +
              `triedCodes=${triedCodes.join(',')}`,
          );
        }
        // 重建带重连回调的 transport 连找到的端口(扫描用的 probe 已 close)
        const t = new RemoteTransport({
          url: `ws://${host}:${portFound}`,
          token,
          wsFactory: browserWs,
          // 阶段3 断线重连:成功后 reload 重新拉 snapshot(session owner 在断线时
          // 被 daemon 自动 release,重连后要重建视图)。reload 丢 renderer 状态可接受
          // (断线是异常,用户重新介入合理)。
          onReconnectSuccess: () => {
            console.warn('[preload] remote reconnected — reload to refresh snapshot');
            window.location.reload();
          },
          onReconnectStart: () => {
            console.warn('[preload] remote connection lost — reconnecting...');
          },
          onReconnectFail: (reason) => {
            console.error('[preload] remote reconnect failed (terminal):', reason);
          },
        });
        await t.ready;
        remoteTransport = t;
      }
    } catch (err) {
      // 远程连接失败:绝不静默回退本地!每窗口后端模型下,用户明确要开远程窗口,
      // 失败必须报错 —— 否则窗口偷偷变本地,用户看到本地数据会以为“打开错了/还是本地窗口”。
      // 保留 ConnectError 的 code(preload 端口扫描/profile 检查会抛),renderer 错误页
      // 据 code 给针对性诊断。非 ConnectError(如 IPC 拉取 connection 失败)包成通用错误。
      if (err instanceof ConnectError) {
        throw err;
      }
      const reason = err instanceof Error ? err.message : String(err);
      throw new ConnectError(
        ConnectErrorCode.NO_PORT_FOUND,
        `[preload] 拉取远程连接信息失败:${reason}`,
      );
    }
  })();
  return transportInit;
}

/**
 * 包装 invoke:远程模式走 WS transport,本地走 ipcRenderer(自动加 windowId/requestId/payload 信封)。
 */
async function invoke<P, R>(channel: string, payload: P): Promise<R> {
  await ensureTransport();
  if (remoteTransport) {
    return remoteTransport.invoke<R>(channel, payload);
  }
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
  // 本地路径立即注册(零回归);远程路径 transport ready 后额外注册。
  ipcRenderer.on(channel, wrapped);
  let unsubRemote = (): void => {};
  ensureTransport().then(() => {
    if (remoteTransport) {
      unsubRemote = remoteTransport.on(channel, handler as (payload: unknown) => void);
    }
  });
  return () => {
    ipcRenderer.off(channel, wrapped);
    unsubRemote();
  };
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
