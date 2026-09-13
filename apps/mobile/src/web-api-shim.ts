/**
 * @file apps/mobile/src/web-api-shim.ts
 * @purpose Android WebView 壳的 window.api 实现 —— renderer 期望的
 *   preload 门面(contextBridge 注入)在 web 环境不存在,由本模块在连接成功后
 *   挂上等价物。renderer 源码零改动(它只认 window.api 这一个门面)。
 *
 * @关键设计:
 * - 路由模型与 src/preload/index.ts 完全同构:
 *     local-control → 本地实现(local-commands.ts,localStorage/浏览器 API)
 *     backend-data  → RemoteTransport(WS,帧协议与 daemon 对称)
 *   路由声明共用 @shared/protocol 的 getCommandRouting —— 声明处改一处,
 *   两个客户端实现同时感知。
 * - backendProfileId 恒非空:Android 客户端「生而为远程窗口」,renderer 的
 *   远程分支(远程标识/设置页远程分类/占用菜单)天然生效。
 * - windowId 是设备稳定 UUID(localStorage 持久):daemon 侧 session owner、
 *   view lease、事件定向都以它为准;app 重启后 id 不变,断线宽限期内重连
 *   可 resume 同一 clientId(remote-transport 的 resumeClientId 机制)。
 * - LOCAL_CONTROL_EVENTS 四通道进程内分发(见 local-commands.ts),其余事件
 *   从 WS 订阅 —— 与 preload 的 on() 同构,防「本地事件混入 daemon 事件」。
 *
 * @不要在这里做的事:
 * - 不要在这里实现具体命令语义(进 local-commands.ts;本文件只做路由)
 * - 不要让未连接状态下安装(installWebApi 只在 transport ready 后调用,
 *   MobileBoot 负责连接前的 UI)
 */

import { COMMAND_CHANNELS, EVENT_CHANNELS, getCommandRouting } from '@shared/protocol';
import type { RemoteTransport } from '../../../src/preload/remote-transport';
import { handleLocalCommand, subscribeLocal } from './local-commands';

/** 与 src/preload/index.ts 的 LOCAL_CONTROL_EVENTS 保持同步(客户端控制面事件,
 * 进程内分发,不订阅 daemon 的同名事件)。preload 若增删需同步这里。 */
const LOCAL_CONTROL_EVENTS = new Set<string>([
  EVENT_CHANNELS.WINDOW_MAX_STATE_CHANGED,
  EVENT_CHANNELS.REMOTE_PROFILES_UPDATED,
  EVENT_CHANNELS.REMOTE_DAEMON_STATUS_CHANGED,
  EVENT_CHANNELS.SETTINGS_LOCAL_APPEARANCE_CHANGED,
]);

export interface InstallWebApiOptions {
  /** 已 ready 的远程 transport(connectRemoteDaemon 的产物)。 */
  transport: RemoteTransport;
  /** 当前连接的 daemon profile id(renderer 的 backendProfileId)。 */
  profileId: string;
  /** 设备稳定 clientId(main.tsx 生成并持久化)。 */
  windowId: string;
}

/**
 * 挂 window.api。类型上以 preload 导出的 Api 为目标形状,但 MobileBoot 的
 * 启动序(连接成功后才安装)决定了 renderer 拿到的 api 一定已连接 —— 不存在
 * 「未连接的 api」状态,与 Electron preload 的懒连接 gate 略有不同。
 */
export function installWebApi(opts: InstallWebApiOptions): void {
  const { transport, profileId, windowId } = opts;

  async function invoke(channel: string, payload: unknown): Promise<unknown> {
    // 移动端无多窗口。该命令在 Electron 端横跨两个控制域(见 preload 特判),
    // 这里直接报不支持;UI 层相应入口(tab 拖出/在新窗口打开)由 mobile.css
    // 与裁剪分支隐藏,此为实现守卫。
    if (channel === COMMAND_CHANNELS.SESSION_OPEN_IN_NEW_WINDOW) {
      throw new Error('[mobile] 移动端不支持在独立窗口打开 session(无多窗口)');
    }
    if (getCommandRouting(channel) === 'local-control') {
      return handleLocalCommand(channel, payload);
    }
    return transport.invoke(channel, payload);
  }

  function on(channel: string, handler: (payload: unknown) => void): () => void {
    if (LOCAL_CONTROL_EVENTS.has(channel)) {
      return subscribeLocal(channel, handler);
    }
    return transport.on(channel, handler);
  }

  const api = {
    windowId,
    windowNumber: 0,
    backendProfileId: profileId,
    windowsBuild: null,
    gpuCompositingDisabled: false,
    shiftCaptureEnabled: false,
    getProtocolVersion: () => invoke(COMMAND_CHANNELS.APP_GET_PROTOCOL_VERSION, undefined),
    invoke,
    on,
    /** webFrame 不存在于 web 环境;UI 缩放由移动端系统字号/应用内设置承担。 */
    setUiZoom: (_factor: number): void => {},
    clipboard: {
      async readText(): Promise<string> {
        const res = (await invoke(COMMAND_CHANNELS.SYSTEM_CLIPBOARD_READ_TEXT, undefined)) as {
          text: string;
        };
        return res.text;
      },
      async writeText(text: string): Promise<boolean> {
        const res = (await invoke(COMMAND_CHANNELS.SYSTEM_CLIPBOARD_WRITE_TEXT, { text })) as {
          ok: boolean;
        };
        return res.ok;
      },
    },
  };

  // renderer 的 window.api 类型来自 preload 的 Api(typeof api as const)。
  // shim 结构对齐但泛型签名更宽(invoke 接收 string channel),这里断言安装。
  (window as unknown as { api: typeof api }).api = api;
}
