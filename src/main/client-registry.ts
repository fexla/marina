/**
 * @file src/main/client-registry.ts
 * @purpose 统一管理所有"连接到 Main 后端的 client",给 dispatcher 提供统一的
 *   "事件发送目标"抽象。本地 in-process 窗口和远程 WS client 都注册成
 *   ClientTransport,事件广播不再直接遍历 BrowserWindow,而是遍历 registry。
 *
 * @关键设计:
 * - ClientTransport:一个 send(channel, envelope) 方法 + clientId + 可选 onClose。
 *   本地实现包 webContents.send;远程实现包 WebSocket.send(JSON.stringify)。
 *   registry 不关心传输细节,只维护"clientId → transport"字典。
 * - 本地 in-process client 的 clientId = windowId(ipc-protocol §2.6.1:
 *   本地零改动兼容,windowId 即其 clientId)
 * - 远程 WS client 的 clientId = 握手分配的稳定 id,断线重连凭 token 复用
 *   (见 transport-ws.ts)
 * - broadcast<P>(channel, payload):遍历所有 client.send,内部 wrap 成
 *   EventEnvelope。替代原 ipc.ts broadcastEvent(遍历 BrowserWindow)。
 * - sendTo<P>(clientId, channel, payload):定向发。替代原 sendEventTo,
 *   但参数从 BrowserWindow 改为 clientId(远程 client 没有 BrowserWindow)。
 *
 * @对应文档章节:
 * - ipc-protocol.md §2.6 Transport 抽象 + §2.6.1 clientId/windowId 边界
 * - 方案-远程后端 §IV.4 双模式 dispatcher
 * - 软件定义书 §14.9.3
 *
 * @不要在这里做的事:
 * - 不要管 WS 握手 / 认证(那是 transport-ws.ts 的职责)
 * - 不要持有业务逻辑(registry 只是"clientId → 发送通道"字典 + 广播)
 * - 不要 import electron(保持纯抽象,本地 transport 工厂放 ipc.ts)
 */

import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from '../shared/protocol';

/**
 * 一个连接到 Main 后端的 client 的传输抽象。
 * dispatcher 通过它向 client 推事件;registry 通过 clientId 标识它。
 */
export interface ClientTransport {
  /** 稳定标识。本地 = windowId;远程 = 握手分配的 id。 */
  readonly clientId: string;
  /**
   * 推一个事件给该 client。
   * 本地实现:webContents.send(channel, envelope)。
   * 远程实现:WebSocket.send(JSON.stringify({ channel, envelope }))。
   * envelope 已是 EventEnvelope(由 registry 内部 wrapEvent 构造)。
   */
  send(channel: string, envelope: EventEnvelope): void;
  /**
   * 可选。registry.remove 时触发,实现可在此释放自己的资源
   * (如 WS close 监听器、webContents 引用)。失败不影响 registry 状态。
   */
  onClose?: () => void;
}

interface RegistryEntry {
  transport: ClientTransport;
  registeredAt: number;
}

/**
 * "clientId → ClientTransport" 的注册表 + 广播器。
 *
 * 线程模型:Node 单线程事件循环保证 add/remove/sendTo/broadcast 不会真并发,
 * 但顺序敏感(如 remove 后立即 sendTo 应安全返回 undefined)——本类的所有方法
 * 都是同步且无 await,顺序由调用方保证。
 */
export class ClientRegistry {
  private readonly clients = new Map<string, RegistryEntry>();

  /**
   * 注册一个 client。clientId 必须唯一。
   * @throws Error 如果 clientId 已注册(本地窗口编号异常 / WS 握手未查重)
   */
  add(transport: ClientTransport): void {
    if (this.clients.has(transport.clientId)) {
      throw new Error(
        `[client-registry] clientId="${transport.clientId}" 已注册。` +
          '本地窗口 clientId=windowId 若冲突说明 WindowManager 编号异常;' +
          '远程 WS client 若冲突说明握手未检查 clientId 唯一性。',
      );
    }
    this.clients.set(transport.clientId, {
      transport,
      registeredAt: Date.now(),
    });
  }

  /**
   * 注销一个 client。找不到则静默返回(幂等,便于在 close 事件可能多次触发的场景调用)。
   * 触发 transport.onClose(若有)。
   */
  remove(clientId: string): void {
    const entry = this.clients.get(clientId);
    if (!entry) return;
    this.clients.delete(clientId);
    // onClose 失败不应影响 registry 状态(调用方仍在依赖 registry 一致性)。
    try {
      entry.transport.onClose?.();
    } catch (err) {
      console.warn(
        `[client-registry] onClose 抛错 clientId="${clientId}"(已忽略):`,
        err,
      );
    }
  }

  /** 取一个 client 的 transport;未注册返回 undefined。 */
  get(clientId: string): ClientTransport | undefined {
    return this.clients.get(clientId)?.transport;
  }

  has(clientId: string): boolean {
    return this.clients.has(clientId);
  }

  /** 当前所有 client(快照数组,遍历期间 add/remove 不影响本数组)。 */
  list(): ClientTransport[] {
    return [...this.clients.values()].map((e) => e.transport);
  }

  count(): number {
    return this.clients.size;
  }

  /**
   * 全局广播:遍历所有 client.send。
   * 替代原 ipc.ts broadcastEvent(遍历 BrowserWindow.getAllWindows)。
   * 单个 client 发送失败不拖垮其他 client(本地 webContents 可能刚 destroyed;
   * 远程 WS 可能正在关闭)——"尽力发"语义,与原 webContents.isDestroyed guard 等价。
   */
  broadcast<P>(channel: string, payload: P): void {
    const envelope: EventEnvelope<P> = {
      eventId: randomUUID(),
      timestamp: Date.now(),
      payload,
    };
    for (const { transport } of this.clients.values()) {
      this.safeSend(transport, channel, envelope);
    }
  }

  /**
   * 定向发:发给指定 clientId。
   * 替代原 ipc.ts sendEventTo(win, channel, payload),但参数从 BrowserWindow
   * 改为 clientId——因为远程 client 没有 BrowserWindow,session.ownerWindowId
   * 在 v2.0 升级为 ownerClientId 后(阶段1.5),定向广播只认 clientId。
   *
   * 找不到该 client(已断开 / 未注册)静默返回;发送失败也静默(safeSend,
   * 与 broadcast 同策略:尽力发)。两者都与原 sendEventTo 遇到 destroyed
   * window 的 guard 语义一致——调用方(wireEventBroadcasts)无需为单个
   * client 瞬时不可达而加错误处理。
   */
  sendTo<P>(clientId: string, channel: string, payload: P): void {
    const transport = this.clients.get(clientId)?.transport;
    if (!transport) return;
    const envelope: EventEnvelope<P> = {
      eventId: randomUUID(),
      timestamp: Date.now(),
      payload,
    };
    this.safeSend(transport, channel, envelope);
  }

  /**
   * 单次发送 + 异常隔离。
   * webContents.send 在窗口刚 destroyed 时会抛;WebSocket.send 在连接 closing 时也会。
   * 这类瞬时失败不应中断对其他 client 的广播。
   */
  private safeSend(
    transport: ClientTransport,
    channel: string,
    envelope: EventEnvelope,
  ): void {
    try {
      transport.send(channel, envelope);
    } catch (err) {
      console.warn(
        `[client-registry] send 失败 clientId="${transport.clientId}" channel="${channel}"(已忽略):`,
        err,
      );
    }
  }
}
