/**
 * @file src/main/ipc.ts
 * @purpose 集中注册"非领域"的 IPC handler:协议握手等。
 *   领域级 handler (session/path/settings) 由各自的 manager 自行注册。
 *
 * @关键设计:
 * - 严格遵守 ipc-protocol.md:仅用 invoke/handle (禁用 send/on)
 * - 非领域 handler 集中此处,便于一眼看到 handshake / app 元数据等基础设施
 * - 错误统一通过 throw 让 ipcMain.handle 在 renderer 端 reject promise
 *
 * @对应文档章节: docs/ipc-protocol.md 第 4 章 (handshake)、5.1 节
 *
 * @CP-1 阶段:
 * 仅注册 cmd:app:get-protocol-version。其他 app 域命令 (snapshot / quit) 在
 * CP-2/CP-3 加入。session 域命令在 PtyController.install() 中注册。
 */
import { ipcMain, app } from 'electron';
import {
  COMMAND_CHANNELS,
  PROTOCOL_VERSION,
  type CommandEnvelope,
  type GetProtocolVersionResponse,
} from '@shared/protocol';

let installed = false;

/**
 * 注册非领域 IPC handler。只能调用一次。
 */
export function registerCoreIpcHandlers(): void {
  if (installed) {
    throw new Error('[ipc] registerCoreIpcHandlers() already called');
  }
  installed = true;

  ipcMain.handle(
    COMMAND_CHANNELS.APP_GET_PROTOCOL_VERSION,
    (_event, _envelope: CommandEnvelope<undefined>): GetProtocolVersionResponse => {
      return {
        protocolVersion: PROTOCOL_VERSION,
        buildVersion: app.getVersion(),
      };
    },
  );
}
