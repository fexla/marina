/**
 * @file src/main/ipc.ts
 * @purpose 集中注册所有 IPC handler,把 Manager 的事件桥接到 webContents
 *   广播。Main 进程的"对外接口层"。
 *
 * @关键设计:
 * - 严格遵守 ipc-protocol.md:仅用 invoke/handle (禁用 send/on)
 * - 每个 handler 都接收 CommandEnvelope,带 windowId / requestId
 * - 错误统一通过 throw 让 ipcMain.handle 在 renderer 端 reject promise
 *   (renderer 用 try/catch 捕获带 code 的错误)
 * - Manager 事件 → broadcast/sendTo:广播策略按 ipc-protocol 2.5
 *   (path/settings/window 列表广播全部窗口;session output 仅 owner)
 *
 * @对应文档章节: docs/ipc-protocol.md 全部
 *
 * @CP-2 范围:
 * - cmd:app:get-protocol-version / get-snapshot / quit
 * - cmd:window:create / close-self / close-all / focus
 * - cmd:bookmark:* / path:remove-from-recent / system:show-in-explorer
 * - cmd:settings:get / update
 * - cmd:session:create / close / claim / release / focus-owner / send-input / resize
 * - 所有 evt:* 广播
 */
import { app, BrowserWindow, clipboard, ipcMain, dialog, safeStorage, shell } from 'electron';
import { getBuildType } from './build-type';
import {
  getExplorerIntegrationStatus,
  setClassicIntegration,
  setModernIntegration,
  getPsCommands,
} from './explorer-integration';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join as joinPath } from 'node:path';
import {
  COMMAND_CHANNELS,
  EVENT_CHANNELS,
  PROTOCOL_VERSION,
  type AddBookmarkPayload,
  type AddBookmarkResponse,
  type AddRemoteBookmarkPayload,
  type AddSshProfilePayload,
  type AddSshProfileResponse,
  type AppStateChangedPayload,
  type BookmarksUpdatedPayload,
  type ClaimSessionPayload,
  type ClaimSessionResponse,
  type ClipboardReadTextResponse,
  type ClipboardWriteTextPayload,
  type ClipboardWriteTextResponse,
  type CloseSessionPayload,
  type CommandEnvelope,
  type CreateSessionPayload,
  type CreateSessionResponse,
  type CreateWindowPayload,
  type CreateWindowResponse,
  type EventEnvelope,
  type FocusSessionOwnerPayload,
  type FocusWindowPayload,
  type AddTemplatePayload,
  type AddTemplateResponse,
  type DeleteTemplatePayload,
  type DeleteSshProfilePayload,
  type ExportSettingsResponse,
  type GetAutoStartResponse,
  type GetProtocolVersionResponse,
  type GetScrollbackPayload,
  type GetScrollbackResponse,
  type GetSettingsResponse,
  type GetSnapshotPayload,
  type ImportSettingsResponse,
  type ListShellsResponse,
  type ListSshProfilesResponse,
  type OpenExternalPayload,
  type SetDefaultTemplatePayload,
  type SettingsArchiveV1,
  type UpdateTemplatePayload,
  type UpdateTemplateResponse,
  type GetSnapshotResponse,
  type PathTreeUpdatedPayload,
  type PickFolderPayload,
  type PickFolderResponse,
  type PickSshKeyFilePayload,
  type PickSshKeyFileResponse,
  type QuitPayload,
  type QuitResponse,
  type OpenSessionInNewWindowPayload,
  type OpenSessionInNewWindowResponse,
  type ReleaseSessionPayload,
  type RemoveBookmarkPayload,
  type RemoveFromRecentPayload,
  type RenameBookmarkPayload,
  type ReorderBookmarksPayload,
  type ResizeSessionPayload,
  type ResizeSessionResponse,
  type SendInputPayload,
  type SendInputResponse,
  type SessionCreatedPayload,
  type SessionDestroyedPayload,
  type SessionExitedPayload,
  type SessionOutputPayload,
  type SessionOwnerChangedPayload,
  type SessionStateChangedPayload,
  type SetDefaultTemplateForBookmarkPayload,
  type SettingsChangedPayload,
  type SshProfilesUpdatedPayload,
  type ShowInExplorerPayload,
  type TemplateListUpdatedPayload,
  type TestSshProfilePayload,
  type TestSshProfileResponse,
  type UpdateSettingsPayload,
  type UpdateSshProfilePayload,
  type UpdateSshProfileResponse,
  type WindowFocusRequestedPayload,
  type WindowListUpdatedPayload,
  type ImeProbeDumpPayload,
  type ImeProbeDumpResponse,
} from '@shared/protocol';
import type { AppSnapshot, Settings, Template } from '@shared/types';
import type { WindowManager } from './window-manager';
import type { PathManager } from './path-manager';
import { pathRefFromId } from './path-manager';
import type { SettingsManager } from './settings-manager';
import type { SessionManager } from './session-manager';
import type { SshProfileManager } from './ssh-profile-manager';
import type { TemplatesManager } from './templates-manager';
import type { AIClient } from './ai-client';
import { logger } from './logger';
import { setQuitting } from './index';

export interface IpcLayerDeps {
  windowManager: WindowManager;
  pathManager: PathManager;
  settingsManager: SettingsManager;
  sessionManager: SessionManager;
  sshProfileManager?: SshProfileManager;
  templatesManager: TemplatesManager;
  /** BETA-031:可选,未注入时 AI_TEST_CONNECTION 返回 ok:false */
  aiClient?: AIClient;
}

let installed = false;
let aiClient: AIClient | undefined;

/**
 * 注册全部 IPC handler 与事件桥接。整个应用只能调用一次。
 */
export function installIpcLayer(deps: IpcLayerDeps): void {
  if (installed) throw new Error('[ipc] installIpcLayer() already called');
  installed = true;
  aiClient = deps.aiClient;
  registerCommandHandlers(deps);
  wireEventBroadcasts(deps);
}

// ──────────────────────────────────────────────────────────────────
// 工具:事件广播
// ──────────────────────────────────────────────────────────────────

function wrapEvent<P>(payload: P): EventEnvelope<P> {
  return { eventId: randomUUID(), timestamp: Date.now(), payload };
}

function broadcastEvent<P>(channel: string, payload: P): void {
  const envelope = wrapEvent(payload);
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, envelope);
  }
}

function sendEventTo<P>(win: BrowserWindow, channel: string, payload: P): void {
  if (win.isDestroyed()) return;
  win.webContents.send(channel, wrapEvent(payload));
}

// ──────────────────────────────────────────────────────────────────
// Command handlers
// ──────────────────────────────────────────────────────────────────

function registerCommandHandlers(deps: IpcLayerDeps): void {
  const {
    windowManager,
    pathManager,
    settingsManager,
    sessionManager,
    sshProfileManager,
    templatesManager,
  } = deps;

  // App
  ipcMain.handle(
    COMMAND_CHANNELS.APP_GET_PROTOCOL_VERSION,
    (): GetProtocolVersionResponse => ({
      protocolVersion: PROTOCOL_VERSION,
      buildVersion: app.getVersion(),
      buildType: getBuildType(),
    }),
  );

  ipcMain.handle(
    COMMAND_CHANNELS.APP_GET_SNAPSHOT,
    (_e, envelope: CommandEnvelope<GetSnapshotPayload>): GetSnapshotResponse => {
      return buildSnapshot(deps, envelope.windowId);
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.APP_QUIT,
    async (_e, _envelope: CommandEnvelope<QuitPayload>): Promise<QuitResponse> => {
      // CP-2 简化:无 session 在跑时的二次确认 (CP-3 加入)
      setQuitting();
      app.quit();
      return { cancelled: false };
    },
  );

  // Window
  ipcMain.handle(
    COMMAND_CHANNELS.WINDOW_CREATE,
    (_e, _envelope: CommandEnvelope<CreateWindowPayload>): CreateWindowResponse => {
      const info = windowManager.createWindowFromFactory();
      return { windowId: info.id, windowNumber: info.number };
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.WINDOW_CLOSE_SELF,
    (_e, envelope: CommandEnvelope<undefined>): void => {
      windowManager.closeWindow(envelope.windowId);
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.WINDOW_CLOSE_ALL,
    (_e, _envelope: CommandEnvelope<undefined>): void => {
      windowManager.closeAll();
    },
  );

  // M1-A:自绘标题栏配套的窗口控制
  ipcMain.handle(
    COMMAND_CHANNELS.WINDOW_MINIMIZE,
    (_e, envelope: CommandEnvelope<undefined>): void => {
      windowManager.minimizeWindow(envelope.windowId);
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.WINDOW_TOGGLE_MAXIMIZE,
    (_e, envelope: CommandEnvelope<undefined>): void => {
      windowManager.toggleMaximizeWindow(envelope.windowId);
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.WINDOW_GET_MAX_STATE,
    (_e, envelope: CommandEnvelope<undefined>) => {
      return { maximized: windowManager.isMaximized(envelope.windowId) };
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.WINDOW_FOCUS,
    (_e, envelope: CommandEnvelope<FocusWindowPayload>): void => {
      const ok = windowManager.focus(envelope.payload.windowId);
      if (!ok) {
        throw makeIpcError('WindowNotFound', `windowId="${envelope.payload.windowId}"`);
      }
      const win = windowManager.getById(envelope.payload.windowId);
      if (win) {
        sendEventTo<WindowFocusRequestedPayload>(
          win,
          EVENT_CHANNELS.WINDOW_FOCUS_REQUESTED,
          { reason: 'manual' },
        );
      }
    },
  );

  // Session
  ipcMain.handle(
    COMMAND_CHANNELS.SESSION_CREATE,
    async (
      _e,
      envelope: CommandEnvelope<CreateSessionPayload>,
    ): Promise<CreateSessionResponse> => {
      const {
        pathId,
        templateId,
        shellId,
        takeOwnership = true,
        cols,
        rows,
        sshTmuxMode,
      } = envelope.payload;
      const oldTreeJson = JSON.stringify(pathManager.getTree());
      const effectiveTemplateId =
        templateId ?? templatesManager.getDefaultTemplateId();
      const pathRef = pathId ? pathRefFromId(pathId) : null;
      const sshProfile =
        pathRef?.kind === 'ssh' && pathRef.sshProfileId
          ? sshProfileManager?.getInternal(pathRef.sshProfileId)
          : null;
      if (pathRef?.kind === 'ssh' && !sshProfile) {
        throw makeIpcError('SshProfileNotFound', `sshProfileId="${pathRef.sshProfileId}"`);
      }
      // takeOwnership=false 时直接传空 owner — createSession 内部
      // `input.ownerWindowId || null` 会落到 info.ownerWindowId = null。
      // 不要先创建带 owner 再 releaseOwner:那条路径在 owner=='' 时已被
      // 折叠为 null,后续 releaseOwner 会因 null !== envelope.windowId 抛 NotOwner。
      const sshProfileForLaunch = sshProfile
        ? {
            ...sshProfile,
            // tmux 是首页按钮表达的"本次启动意图",不是 SSH profile 状态。
            // 这样即使旧 profile 里残留 tmuxMode,首页"连接"仍稳定是纯 SSH。
            tmuxMode:
              sshTmuxMode === 'attach-or-create'
                ? 'attach-or-create' as const
                : 'disabled' as const,
            tmuxOnMissing: 'fallback-shell' as const,
            // 在 main 进程里立刻解密;session-manager 只看到明文,不持有
            // safeStorage 句柄。解密失败(profile 文件来自另一台机器 / 用户)
            // 时悄悄丢弃,会自动回退到交互式密码提示。
            ...(sshProfile.passwordEncrypted
              ? decryptStoredPassword(sshProfile.passwordEncrypted)
              : {}),
          }
        : null;
      if (sshProfileForLaunch) {
        delete (sshProfileForLaunch as { passwordEncrypted?: string }).passwordEncrypted;
      }
      const session = await sessionManager.createSession({
        pathId: pathId ?? '',
        templateId: effectiveTemplateId,
        ownerWindowId: takeOwnership ? envelope.windowId : '',
        cols,
        rows,
        ...(shellId ? { shellIdOverride: shellId } : {}),
        ...(sshProfileForLaunch ? { sshProfile: sshProfileForLaunch } : {}),
      });
      const pathTreeChanged =
        JSON.stringify(pathManager.getTree()) !== oldTreeJson;
      const warning = sessionManager.lastLaunchWarning ?? undefined;
      return warning ? { session, pathTreeChanged, warning } : { session, pathTreeChanged };
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.SESSION_CLOSE,
    (_e, envelope: CommandEnvelope<CloseSessionPayload>): void => {
      sessionManager.closeSession(envelope.payload.sessionId);
    },
  );

  // M1-C
  ipcMain.handle(
    COMMAND_CHANNELS.SESSION_RENAME,
    (_e, envelope: CommandEnvelope<{ sessionId: string; newDisplayName: string }>): void => {
      sessionManager.renameSession(envelope.payload.sessionId, envelope.payload.newDisplayName);
    },
  );

  // STM-3:清除手动重命名标记
  ipcMain.handle(
    COMMAND_CHANNELS.SESSION_CLEAR_MANUAL_RENAME,
    (_e, envelope: CommandEnvelope<{ sessionId: string }>): void => {
      sessionManager.clearManualRename(envelope.payload.sessionId);
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.SESSION_CLAIM,
    async (
      _e,
      envelope: CommandEnvelope<ClaimSessionPayload>,
    ): Promise<ClaimSessionResponse> => {
      sessionManager.claimOwner(envelope.payload.sessionId, envelope.windowId);
      // CP-2 勘误后:scrollback ring buffer 已实现。带回历史以保协议自洽,
      // 但 renderer 通常用 cmd:session:get-scrollback 单独拉,以避免 claim
      // 动作和 history-replay 时序耦合 (TerminalView 重新挂载场景非 claim 触发)
      // CURSOR-1 后:替换路径 = getScrollbackForReplay(state-replay 架构,
      // 返回完整终端状态 ANSI 流),需 async + await。
      const sb = await sessionManager.getScrollbackForReplay(
        envelope.payload.sessionId,
      );
      return { scrollback: sb.data, lastSeq: sb.lastSeq };
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.SESSION_GET_SCROLLBACK,
    async (
      _e,
      envelope: CommandEnvelope<GetScrollbackPayload>,
    ): Promise<GetScrollbackResponse> => {
      // CURSOR-1:走 state-replay 路径(SerializeAddon),不再返回裸字节。
      // 详见 SessionManager.getScrollbackForReplay 与 docs/issues/cursor-1-...
      return sessionManager.getScrollbackForReplay(envelope.payload.sessionId);
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.SESSION_EXPORT_SCROLLBACK,
    async (
      _e,
      envelope: CommandEnvelope<{ sessionId: string }>,
    ): Promise<{ text: string }> => {
      // BETA-028:工具栏"复制全部"按钮 → 返回 UTF-8 字符串。
      // CURSOR-1 后 exportScrollback 改 async(读 headless 前需 drain parser)。
      return sessionManager.exportScrollback(envelope.payload.sessionId);
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.SESSION_CLEAR_SCROLLBACK,
    (
      _e,
      envelope: CommandEnvelope<{ sessionId: string }>,
    ): void => {
      // BETA-028:工具栏"清屏"按钮配合 term.clear() 使用
      sessionManager.clearScrollback(envelope.payload.sessionId);
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.SESSION_RELEASE,
    (_e, envelope: CommandEnvelope<ReleaseSessionPayload>): void => {
      sessionManager.releaseOwner(envelope.payload.sessionId, envelope.windowId);
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.SESSION_OPEN_IN_NEW_WINDOW,
    (
      _e,
      envelope: CommandEnvelope<OpenSessionInNewWindowPayload>,
    ): OpenSessionInNewWindowResponse => {
      const { sessionId } = envelope.payload;
      const session = sessionManager.get(sessionId);
      if (!session) {
        throw makeIpcError('SessionNotFound', `sessionId="${sessionId}"`);
      }
      // 允许两种情况:
      //   1) 当前 owner 就是调用方 → 先释放再 claim 给新窗口(经典"移到新窗口")
      //   2) session 是 orphan(无主) → 不需要释放,直接 claim 给新窗口
      // 拒绝:其他窗口正持有 — 跨窗口偷会话不在本协议允许范围。
      if (
        session.ownerWindowId !== null &&
        session.ownerWindowId !== envelope.windowId
      ) {
        throw makeIpcError(
          'NotOwner',
          `sessionId="${sessionId}" 由其他窗口持有(${session.ownerWindowId}),不能从此窗口移动`,
        );
      }
      // 同步:若是调用方持有则先 release,然后造新窗口 + claim — 新窗口拉
      // snapshot 时已经是它持有的状态,renderer 从 URL ?selectSessionId 读到
      // 目标后直接 dispatch 选中,没有跨进程时序竞争。
      if (session.ownerWindowId === envelope.windowId) {
        sessionManager.releaseOwner(sessionId, envelope.windowId);
      }
      // 从调用方窗口的当前 bounds 计算级联偏移,避免新窗口完全盖在旧窗口上。
      // getNormalBounds 排除最大化/全屏的扩展尺寸,所以即使调用方是 maximized,
      // 新窗口也会落到"该窗口被还原后的位置 + 偏移",不会撑满屏幕。
      const callerWin = windowManager.getById(envelope.windowId);
      const cascadeBounds = (() => {
        if (!callerWin || callerWin.isDestroyed()) return undefined;
        const b = callerWin.getNormalBounds();
        const CASCADE = 32;
        return {
          width: b.width,
          height: b.height,
          x: b.x + CASCADE,
          y: b.y + CASCADE,
          maximized: false,
        };
      })();
      const info = windowManager.createWindowFromFactory({
        selectSessionId: sessionId,
        ...(envelope.payload.simpleMode ? { simpleMode: true } : {}),
        ...(cascadeBounds ? { initialBounds: cascadeBounds } : {}),
      });
      try {
        sessionManager.claimOwner(sessionId, info.id);
      } catch (err) {
        // 极小概率:在 release 与 claim 之间另一个窗口抢先 claim。session 留
        // 在那里(orphan 或被抢),新窗口仍开出来,只是不会自动 select。
      }
      return { windowId: info.id, windowNumber: info.number };
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.SESSION_FOCUS_OWNER,
    (_e, envelope: CommandEnvelope<FocusSessionOwnerPayload>): void => {
      const session = sessionManager.get(envelope.payload.sessionId);
      if (!session) {
        throw makeIpcError(
          'SessionNotFound',
          `sessionId="${envelope.payload.sessionId}"`,
        );
      }
      if (!session.ownerWindowId) return; // 无主无可聚焦
      const ok = windowManager.focus(session.ownerWindowId);
      if (!ok) return; // owner 窗口已不存在,静默
      const ownerWin = windowManager.getById(session.ownerWindowId);
      if (ownerWin) {
        sendEventTo<WindowFocusRequestedPayload>(
          ownerWin,
          EVENT_CHANNELS.WINDOW_FOCUS_REQUESTED,
          { reason: 'session-click', selectSessionId: session.id },
        );
      }
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.SESSION_SEND_INPUT,
    (
      _e,
      envelope: CommandEnvelope<SendInputPayload>,
    ): SendInputResponse => {
      // IPC-3:ownership 校验 — 防止 renderer 状态短暂落后于 main 时,
      // 一个已不归本窗口的 session 仍接受写入(用户视觉上"打字了但没回显",
      // 因为 sessionOutput 推给了真 owner)。
      //
      // 允许放行的情况:
      //   - 调用方就是 owner — 正常情况
      //   - session.ownerWindowId === null(orphan)— renderer 即将 claim,
      //     允许写入避免乱码丢字符;一旦 claim 成功 sessionOutput 自然推回
      //
      // 拒绝的情况:
      //   - session.ownerWindowId 是其他窗口 — 真的不该写,返回 not-owner
      const sess = sessionManager.get(envelope.payload.sessionId);
      if (
        sess &&
        sess.ownerWindowId !== null &&
        sess.ownerWindowId !== envelope.windowId
      ) {
        return { accepted: false, reason: 'not-owner' };
      }
      return sessionManager.sendInput(
        envelope.payload.sessionId,
        envelope.payload.data,
      );
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.SESSION_RESIZE,
    (
      _e,
      envelope: CommandEnvelope<ResizeSessionPayload>,
    ): ResizeSessionResponse => {
      return sessionManager.resize(
        envelope.payload.sessionId,
        envelope.payload.cols,
        envelope.payload.rows,
      );
    },
  );

  // Bookmark / Path
  ipcMain.handle(
    COMMAND_CHANNELS.BOOKMARK_ADD,
    async (
      _e,
      envelope: CommandEnvelope<AddBookmarkPayload>,
    ): Promise<AddBookmarkResponse> => {
      // 校验路径是目录 (软件定义书 5.1.1 要求文件夹选择器/拖拽路径,
      // ipc-protocol PathNotDirectory / PathNotExist 错误码)
      await assertDirectory(envelope.payload.path);
      const bookmark = pathManager.addBookmark({
        path: envelope.payload.path,
        ...(envelope.payload.displayName ? { displayName: envelope.payload.displayName } : {}),
        ...(envelope.payload.defaultTemplateId
          ? { defaultTemplateId: envelope.payload.defaultTemplateId }
          : {}),
      });
      return { bookmark };
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.BOOKMARK_REMOVE,
    (_e, envelope: CommandEnvelope<RemoveBookmarkPayload>): void => {
      pathManager.removeBookmark(envelope.payload.pathId);
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.BOOKMARK_RENAME,
    (_e, envelope: CommandEnvelope<RenameBookmarkPayload>): void => {
      pathManager.renameBookmark(envelope.payload.pathId, envelope.payload.newDisplayName);
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.BOOKMARK_REORDER,
    (_e, envelope: CommandEnvelope<ReorderBookmarksPayload>): void => {
      pathManager.reorderBookmarks(envelope.payload.orderedPathIds);
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.BOOKMARK_SET_DEFAULT_TEMPLATE,
    (
      _e,
      envelope: CommandEnvelope<SetDefaultTemplateForBookmarkPayload>,
    ): void => {
      pathManager.setDefaultTemplate(
        envelope.payload.pathId,
        envelope.payload.templateId,
      );
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.BOOKMARK_PICK_FOLDER,
    async (
      _e,
      envelope: CommandEnvelope<PickFolderPayload>,
    ): Promise<PickFolderResponse> => {
      const fromWindow = BrowserWindow.fromWebContents(_e.sender);
      const result = await dialog.showOpenDialog(fromWindow ?? BrowserWindow.getFocusedWindow()!, {
        title: '选择文件夹',
        properties: ['openDirectory'],
        ...(envelope.payload.defaultPath ? { defaultPath: envelope.payload.defaultPath } : {}),
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { path: null };
      }
      return { path: result.filePaths[0]! };
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.PATH_REMOVE_FROM_RECENT,
    (_e, envelope: CommandEnvelope<RemoveFromRecentPayload>): void => {
      pathManager.removeFromRecent(envelope.payload.path);
    },
  );

  // SSH profiles / remote bookmarks
  ipcMain.handle(
    COMMAND_CHANNELS.SSH_PROFILE_LIST,
    (_e, _envelope: CommandEnvelope<undefined>): ListSshProfilesResponse => {
      return { profiles: sshProfileManager?.list() ?? [] };
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.SSH_PROFILE_ADD,
    (_e, envelope: CommandEnvelope<AddSshProfilePayload>): AddSshProfileResponse => {
      if (!sshProfileManager) {
        throw makeIpcError('SshProfileUnavailable', 'SSH profile manager 未初始化');
      }
      const { password, ...rest } = envelope.payload;
      const addInput: Omit<typeof rest, never> & { passwordEncrypted?: string } = { ...rest };
      if (typeof password === 'string' && password.length > 0) {
        addInput.passwordEncrypted = encryptPasswordOrThrow(password);
      }
      const profile = sshProfileManager.add(addInput);
      return { profile };
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.SSH_PROFILE_UPDATE,
    (_e, envelope: CommandEnvelope<UpdateSshProfilePayload>): UpdateSshProfileResponse => {
      if (!sshProfileManager) {
        throw makeIpcError('SshProfileUnavailable', 'SSH profile manager 未初始化');
      }
      const { password, ...partialRest } = envelope.payload.partial;
      const partial: typeof partialRest & { passwordEncrypted?: string } = { ...partialRest };
      if (typeof password === 'string') {
        // '' 表示清除已保存密码;非空字符串则加密落盘。
        partial.passwordEncrypted = password.length > 0 ? encryptPasswordOrThrow(password) : '';
      }
      const profile = sshProfileManager.update(envelope.payload.id, partial);
      return { profile };
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.SSH_PROFILE_PICK_KEY_FILE,
    async (
      _e,
      envelope: CommandEnvelope<PickSshKeyFilePayload>,
    ): Promise<PickSshKeyFileResponse> => {
      const fromWindow = BrowserWindow.fromWebContents(_e.sender);
      const result = await dialog.showOpenDialog(
        fromWindow ?? BrowserWindow.getFocusedWindow()!,
        {
          title: '选择 SSH 私钥文件',
          properties: ['openFile', 'showHiddenFiles'],
          ...(envelope.payload.defaultPath
            ? { defaultPath: envelope.payload.defaultPath }
            : {}),
        },
      );
      if (result.canceled || result.filePaths.length === 0) {
        return { path: null };
      }
      return { path: result.filePaths[0]! };
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.SSH_PROFILE_DELETE,
    (_e, envelope: CommandEnvelope<DeleteSshProfilePayload>): void => {
      if (!sshProfileManager) {
        throw makeIpcError('SshProfileUnavailable', 'SSH profile manager 未初始化');
      }
      if (pathManager.hasSshProfileReferences(envelope.payload.id)) {
        throw makeIpcError(
          'SshProfileInUse',
          '该 SSH 服务器仍被收藏 / 最近 / 运行中的会话引用,请先移除这些远程路径。',
        );
      }
      sshProfileManager.delete(envelope.payload.id);
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.SSH_PROFILE_TEST,
    async (
      _e,
      envelope: CommandEnvelope<TestSshProfilePayload>,
    ): Promise<TestSshProfileResponse> => {
      const profile = sshProfileManager?.get(envelope.payload.id);
      if (!profile) return { ok: false, message: 'SSH 配置不存在' };
      // MVP:不主动建立后台连接,避免无交互密码/host key prompt 卡死。
      // 真正连接由 session 启动时的 ssh CLI 处理;这里做可执行输入校验。
      return {
        ok: true,
        message: `${profile.username}@${profile.host}:${profile.port}`,
      };
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.REMOTE_BOOKMARK_ADD,
    (_e, envelope: CommandEnvelope<AddRemoteBookmarkPayload>): AddBookmarkResponse => {
      const profile = sshProfileManager?.get(envelope.payload.sshProfileId);
      if (!profile) {
        throw makeIpcError(
          'SshProfileNotFound',
          `sshProfileId="${envelope.payload.sshProfileId}"`,
        );
      }
      const bookmark = pathManager.addBookmark({
        kind: 'ssh',
        sshProfileId: profile.id,
        path: envelope.payload.remotePath,
        ...(envelope.payload.displayName ? { displayName: envelope.payload.displayName } : {}),
        ...(envelope.payload.defaultTemplateId
          ? { defaultTemplateId: envelope.payload.defaultTemplateId }
          : {}),
      });
      return { bookmark };
    },
  );

  // Settings
  ipcMain.handle(
    COMMAND_CHANNELS.SETTINGS_GET,
    (_e, _envelope: CommandEnvelope<undefined>): GetSettingsResponse => {
      return { settings: settingsManager.get() };
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.SETTINGS_UPDATE,
    (_e, envelope: CommandEnvelope<UpdateSettingsPayload>): void => {
      settingsManager.update(envelope.payload.partial);
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.SETTINGS_RESET,
    (_e, _envelope: CommandEnvelope<undefined>): void => {
      settingsManager.reset();
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.SETTINGS_LIST_SHELLS,
    async (_e, _envelope: CommandEnvelope<undefined>): Promise<ListShellsResponse> => {
      const shells = await sessionManager.listAvailableShells();
      return {
        shells: shells.map((s) => ({
          id: s.id,
          displayName: s.displayName,
          executablePath: s.executablePath,
        })),
      };
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.SETTINGS_GET_AUTO_START,
    (_e, _envelope: CommandEnvelope<undefined>): GetAutoStartResponse => {
      // Electron 跨平台 API,Windows 上读 Run 注册表
      return { enabled: app.getLoginItemSettings().openAtLogin };
    },
  );

  // System
  ipcMain.handle(
    COMMAND_CHANNELS.SYSTEM_SHOW_IN_EXPLORER,
    async (
      _e,
      envelope: CommandEnvelope<ShowInExplorerPayload>,
    ): Promise<void> => {
      shell.showItemInFolder(envelope.payload.path);
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.SYSTEM_OPEN_DATA_DIR,
    async (_e, _envelope: CommandEnvelope<undefined>): Promise<void> => {
      // app.getPath('userData') = %APPDATA%\Marina
      await shell.openPath(app.getPath('userData'));
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.SYSTEM_OPEN_LOGS_DIR,
    async (_e, _envelope: CommandEnvelope<undefined>): Promise<void> => {
      // logs 目录:%APPDATA%\Marina\logs (M1-D 起 logger.ts 实际会写;空目录也可打开)
      // 还没接通日志框架,但目录能打开,空就空)。
      const logsDir = joinPath(app.getPath('userData'), 'logs');
      try {
        await fs.mkdir(logsDir, { recursive: true });
      } catch {
        /* 已存在或创建失败都直接尝试打开,反正用户能看到 */
      }
      await shell.openPath(logsDir);
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.SYSTEM_GET_BUILD_TYPE,
    (_e, _envelope: CommandEnvelope<undefined>) => {
      return { buildType: getBuildType() };
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.SYSTEM_GET_DATA_DIR,
    (_e, _envelope: CommandEnvelope<undefined>): { dataDir: string } => {
      // BETA-039:UI 设置页用真实绝对路径替代硬编码 %APPDATA%\Marina,
      // 在 portable / dev / 自定义 userData 场景下也保持准确。
      return { dataDir: app.getPath('userData') };
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.AI_TEST_CONNECTION,
    async (_e, _envelope: CommandEnvelope<undefined>) => {
      // BETA-031:AI 助手设置页"测试连接"按钮调用。失败信息透传 UI。
      if (!aiClient) return { ok: false, message: 'AI client 未初始化' };
      return aiClient.testConnection();
    },
  );

  // IME-1 探针 dump — renderer 端 ring buffer 触发 LEAK 时一次性送过来。
  // 不依赖 DevTools 打开,事后可通过 `cmd:system:open-logs-dir` 按钮直达
  // `%APPDATA%/Marina/logs/ime-YYYY-MM-DD.log` 查看。
  // 设计:无 throw、无大规模 stringify(已在 logger.format 内做 JSON.stringify
  // 兜底),让 renderer 的 fire-and-forget 调用永不影响主链路。
  ipcMain.handle(
    COMMAND_CHANNELS.LOGGER_IME_DUMP,
    (
      _e,
      envelope: CommandEnvelope<ImeProbeDumpPayload>,
    ): ImeProbeDumpResponse => {
      const { meta, entries } = envelope.payload;
      logger.ime(
        'ime-probe',
        `leak dump session=${meta.sessionId} t=${meta.t} entries=${entries.length}`,
        { meta, entries },
      );
      return { ok: true };
    },
  );

  // Explorer 集成 —— 不读 settings,现场查 + 操作系统状态
  ipcMain.handle(
    COMMAND_CHANNELS.EXPLORER_INTEGRATION_GET_STATUS,
    async (_e, _envelope: CommandEnvelope<undefined>) => {
      return await getExplorerIntegrationStatus();
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.EXPLORER_INTEGRATION_SET_CLASSIC,
    async (
      _e,
      envelope: CommandEnvelope<{ enabled: boolean }>,
    ) => {
      const result = await setClassicIntegration(
        envelope.payload.enabled,
        app.getPath('exe'),
      );
      const status = await getExplorerIntegrationStatus();
      return { ok: result.ok, message: result.message, status };
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.EXPLORER_INTEGRATION_SET_MODERN,
    async (
      _e,
      envelope: CommandEnvelope<{ enabled: boolean }>,
    ) => {
      const result = await setModernIntegration(envelope.payload.enabled);
      const status = await getExplorerIntegrationStatus();
      return { ok: result.ok, message: result.message, status };
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.EXPLORER_INTEGRATION_GET_PS_COMMANDS,
    (_e, _envelope: CommandEnvelope<undefined>) => {
      return getPsCommands(app.getPath('exe'));
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.SYSTEM_OPEN_EXTERNAL,
    async (
      _e,
      envelope: CommandEnvelope<OpenExternalPayload>,
    ): Promise<void> => {
      const url = envelope.payload.url;
      // 安全:仅允许 http / https / mailto,拒绝 file:// 等本地协议
      if (!/^(https?|mailto):/i.test(url)) {
        throw makeIpcError('InvalidUrl', `不允许的 URL 协议: "${url}"`);
      }
      await shell.openExternal(url);
    },
  );

  // 勘误第二轮:剪贴板 — main 端直接调 Electron clipboard。
  // 不走 navigator.clipboard.* (web Permission API 拒掉 clipboard-write,
  // 表现为选中即复制 / Ctrl+Shift+C / 右键粘贴全部静默失败,见 prelease 前
  // 勘误第二轮工作记录)。Electron clipboard 模块没有权限层。
  ipcMain.handle(
    COMMAND_CHANNELS.SYSTEM_CLIPBOARD_READ_TEXT,
    (
      _e,
      _envelope: CommandEnvelope<undefined>,
    ): ClipboardReadTextResponse => {
      try {
        return { text: clipboard.readText() };
      } catch {
        return { text: '' };
      }
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.SYSTEM_CLIPBOARD_WRITE_TEXT,
    (
      _e,
      envelope: CommandEnvelope<ClipboardWriteTextPayload>,
    ): ClipboardWriteTextResponse => {
      try {
        clipboard.writeText(envelope.payload.text);
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
  );

  // Templates CRUD (CP-4 chunk 4)
  ipcMain.handle(
    COMMAND_CHANNELS.TEMPLATE_ADD,
    (_e, envelope: CommandEnvelope<AddTemplatePayload>): AddTemplateResponse => {
      const t = templatesManager.add(envelope.payload);
      return { template: t };
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.TEMPLATE_UPDATE,
    (
      _e,
      envelope: CommandEnvelope<UpdateTemplatePayload>,
    ): UpdateTemplateResponse => {
      const t = templatesManager.update(envelope.payload.id, envelope.payload.partial);
      return { template: t };
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.TEMPLATE_DELETE,
    (_e, envelope: CommandEnvelope<DeleteTemplatePayload>): void => {
      templatesManager.delete(envelope.payload.id);
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.TEMPLATE_SET_DEFAULT,
    (_e, envelope: CommandEnvelope<SetDefaultTemplatePayload>): void => {
      templatesManager.setDefault(envelope.payload.id);
    },
  );

  // Settings export / import (CP-4 chunk 4)
  //
  // V1 折衷:导出/导入用单 JSON 文件而非 zip,避免引入 zip 库依赖。
  // 文档 6.6.2 描述为 zip,未来加 archiver 包可平滑升级。
  ipcMain.handle(
    COMMAND_CHANNELS.SETTINGS_EXPORT,
    async (
      _e,
      _envelope: CommandEnvelope<undefined>,
    ): Promise<ExportSettingsResponse> => {
      const fromWindow = BrowserWindow.fromWebContents(_e.sender);
      const owner = fromWindow ?? BrowserWindow.getFocusedWindow()!;

      // M1-F:先弹隐私警告 — 模板可能含 API key (env);用户三选一:
      // 取消 / 仅导出公开字段(env 清空) / 完整导出(含敏感凭据)
      const tmpls = deps.templatesManager.list();
      const hasEnvKeys = tmpls.some(
        (t) => t.env && Object.keys(t.env).length > 0,
      );
      let includeSecrets = false;
      if (hasEnvKeys) {
        const askRes = await dialog.showMessageBox(owner, {
          type: 'warning',
          title: '导出敏感凭据?',
          message: '归档将包含启动模板里的环境变量,可能含 API key、token 等敏感凭据。',
          detail:
            '"仅公开字段":导出时清空所有模板的环境变量,适合分享。\n' +
            '"包含敏感凭据":完整导出,只在你信任的设备间转移时再用。',
          buttons: ['取消', '仅公开字段', '包含敏感凭据'],
          defaultId: 1,
          cancelId: 0,
        });
        if (askRes.response === 0) return { filePath: null };
        includeSecrets = askRes.response === 2;
      } else {
        // 无敏感字段时不打扰
        includeSecrets = true;
      }

      const suffix = hasEnvKeys
        ? includeSecrets
          ? '-with-secrets'
          : '-public'
        : '';
      const result = await dialog.showSaveDialog(owner, {
        title: '导出 Marina 配置',
        defaultPath: `marina-config-${formatDateForFilename(new Date())}${suffix}.json`,
        filters: [{ name: 'Marina Archive (JSON)', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePath) {
        return { filePath: null };
      }
      const archive = await buildArchive(deps);
      if (!includeSecrets) {
        // 清空所有模板的 env(M1-F 公开模式)
        for (const t of archive.templates.templates) {
          t.env = {};
        }
      }
      await fs.writeFile(result.filePath, JSON.stringify(archive, null, 2), 'utf-8');
      return { filePath: result.filePath };
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.SETTINGS_IMPORT,
    async (
      _e,
      _envelope: CommandEnvelope<undefined>,
    ): Promise<ImportSettingsResponse> => {
      const fromWindow = BrowserWindow.fromWebContents(_e.sender);
      const result = await dialog.showOpenDialog(
        fromWindow ?? BrowserWindow.getFocusedWindow()!,
        {
          title: '导入 Marina 配置',
          properties: ['openFile'],
          filters: [{ name: 'Marina Archive (JSON)', extensions: ['json'] }],
        },
      );
      if (result.canceled || result.filePaths.length === 0) {
        return { status: 'cancelled' };
      }
      const filePath = result.filePaths[0]!;
      let archive: SettingsArchiveV1;
      try {
        const raw = await fs.readFile(filePath, 'utf-8');
        archive = JSON.parse(raw) as SettingsArchiveV1;
        validateArchive(archive);
      } catch (err) {
        return {
          status: 'error',
          errorMessage: err instanceof Error ? err.message : String(err),
        };
      }
      // 二次确认 — 不再重启应用 (CP-4 勘误 #12)。
      const confirmRes = await dialog.showMessageBox(
        fromWindow ?? BrowserWindow.getFocusedWindow()!,
        {
          type: 'warning',
          title: '确认导入',
          message: '导入将完全覆盖现有配置(收藏 / 最近 / 模板 / 设置)。',
          detail: '运行中的终端不会被关,继续后所有窗口立即看到新配置。是否继续?',
          buttons: ['取消', '继续导入'],
          defaultId: 0,
          cancelId: 0,
        },
      );
      if (confirmRes.response !== 1) {
        return { status: 'cancelled' };
      }
      try {
        await applyArchiveInMemory(deps, archive);
      } catch (err) {
        return {
          status: 'error',
          errorMessage: err instanceof Error ? err.message : String(err),
        };
      }
      return { status: 'imported' };
    },
  );
}

function formatDateForFilename(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}` +
    `${pad(d.getMonth() + 1)}` +
    `${pad(d.getDate())}-` +
    `${pad(d.getHours())}` +
    `${pad(d.getMinutes())}`
  );
}

async function buildArchive(deps: IpcLayerDeps): Promise<SettingsArchiveV1> {
  const dataDir = app.getPath('userData');
  const readJson = async <T>(filename: string, fallback: T): Promise<T> => {
    try {
      const raw = await fs.readFile(joinPath(dataDir, filename), 'utf-8');
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  };
  // 强制先 flush,以保证读盘时拿到最新写入
  await flushAllStores(deps);
  const settings = deps.settingsManager.get();
  const bookmarks = await readJson<{ paths: unknown[] }>('bookmarks.json', { paths: [] });
  const recent = await readJson<{ paths: unknown[] }>('recent.json', { paths: [] });
  const templates = {
    defaultTemplateId: deps.templatesManager.getDefaultTemplateId(),
    templates: deps.templatesManager.list(),
  };
  return {
    // v1.5 起统一用 'marina-archive';读侧同时接受 'easyterm-archive' 旧值(向后兼容)。
    format: 'marina-archive',
    version: 1,
    exportedAt: Date.now(),
    exportedFrom: app.getVersion(),
    settings,
    // 类型断言:JSON 上读出来已经是合法 schema (持久化文件不通过 IPC 不需要严格 schema 校验)
    bookmarks: bookmarks as SettingsArchiveV1['bookmarks'],
    recent: recent as SettingsArchiveV1['recent'],
    sshProfiles: { profiles: deps.sshProfileManager?.list() ?? [] },
    templates,
  };
}

function validateArchive(input: unknown): asserts input is SettingsArchiveV1 {
  // 接受新名 'marina-archive' 和旧名 'easyterm-archive'(v1.5 改名前的归档)。
  // 都是同一 schema,只是 format 标签不同。
  const fmt = (input as SettingsArchiveV1 | null)?.format;
  if (
    !input ||
    typeof input !== 'object' ||
    (fmt !== 'marina-archive' && fmt !== 'easyterm-archive') ||
    (input as SettingsArchiveV1).version !== 1
  ) {
    throw new Error(
      '不是合法的归档:format/version 不匹配 (期望 marina-archive v1,旧 easyterm-archive v1 也接受)',
    );
  }
  const i = input as SettingsArchiveV1;
  if (!i.settings || !i.bookmarks?.paths || !i.recent?.paths || !i.templates?.templates) {
    throw new Error('归档缺少必需字段 (settings / bookmarks / recent / templates)');
  }
}

/**
 * CP-4 勘误 #12:不再 fs.writeFile + app.relaunch (dev 模式下 relaunch 与
 * Vite HMR daemon 协作不稳,导致用户看到"导入后无法正常渲染")。改成走每个
 * Manager 暴露的 replaceAll() 方法 — 内存替换 + JsonStore 持久化 + emit 事件
 * → 所有窗口通过 evt:settings:changed / evt:templates:updated /
 *   evt:path:tree-updated / evt:bookmarks:updated 实时刷新 UI。
 *
 * 优点:
 * - 不重启应用,运行中的 PTY session 不被关 (符合软件定义书"窗口零成本开关",
 *   而 session 持久化是设计上不允许的,所以 import 不应当杀已活的 session)
 * - 不依赖 app.relaunch 在 dev 模式工作
 * - settings.appearance.theme 等"即改即生效"路径自然走通
 */
async function applyArchiveInMemory(
  deps: IpcLayerDeps,
  archive: SettingsArchiveV1,
): Promise<void> {
  // M1-L:事务化 — 先 dry-run validate(都走各 Manager 的 validate),全部通过
  // 才正式 commit。否则中途 settings 已替换但 templates 失败,会出现一边新
  // 一边旧的"半应用"状态。
  //
  // Manager 暴露的 replaceAll 已经内置 validate;无法在不 commit 的前提下
  // 单独 validate(它们直接 emit)。折衷:用 validateSettings / validateTemplate
  // 等独立函数预检 — 但 PathManager 没有公开 validate,bookmarks/recent 的
  // 校验在 IPC 层做(原 archive validateArchive 已确认 schema)。
  //
  // 风险层面:即使分步 commit,失败也只是中间状态可见(reducer 已 emit),
  // 用户看到的是部分应用而不是数据损坏 — 重新导入或重置即可恢复。所以
  // 这一层事务化主要是"日志清楚 + 错误信息能定位失败点",而不是真原子。

  // 1) settings replaceAll(包含 deepMerge + validate)
  try {
    deps.settingsManager.replaceAll(archive.settings);
  } catch (err) {
    throw new Error(`settings: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2) templates replaceAll(mergeBuiltins + 自带校验)
  try {
    deps.templatesManager.replaceAll({
      defaultTemplateId: archive.templates.defaultTemplateId,
      templates: archive.templates.templates,
    });
  } catch (err) {
    throw new Error(`templates: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3) bookmarks + recent
  try {
    deps.pathManager.replaceAll({
      bookmarks: archive.bookmarks.paths,
      recent: archive.recent.paths,
    });
  } catch (err) {
    throw new Error(`paths: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (archive.sshProfiles?.profiles && deps.sshProfileManager) {
    try {
      deps.sshProfileManager.replaceAll(archive.sshProfiles.profiles);
    } catch (err) {
      throw new Error(`sshProfiles: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 等待所有 store debounce 落盘
  await flushAllStores(deps);
}

async function flushAllStores(deps: IpcLayerDeps): Promise<void> {
  await Promise.all([
    deps.settingsManager.flush(),
    deps.pathManager.flush(),
    deps.sshProfileManager?.flush() ?? Promise.resolve(),
    deps.templatesManager.flush(),
  ]);
}

// ──────────────────────────────────────────────────────────────────
// 事件桥接
// ──────────────────────────────────────────────────────────────────

function wireEventBroadcasts(deps: IpcLayerDeps): void {
  const {
    windowManager,
    pathManager,
    settingsManager,
    sessionManager,
    sshProfileManager,
    templatesManager,
  } = deps;

  // Path 树变化 → 广播 evt:path:tree-updated
  pathManager.on('pathTreeUpdated', () => {
    const tree = pathManager.getTree();
    broadcastEvent<PathTreeUpdatedPayload>(EVENT_CHANNELS.PATH_TREE_UPDATED, { tree });
    broadcastAppState(deps);
  });

  pathManager.on('bookmarksUpdated', () => {
    broadcastEvent<BookmarksUpdatedPayload>(EVENT_CHANNELS.BOOKMARKS_UPDATED, {
      bookmarks: pathManager.listBookmarks(),
    });
  });

  sshProfileManager?.on('sshProfilesUpdated', (e: SshProfilesUpdatedPayload) => {
    broadcastEvent<SshProfilesUpdatedPayload>(
      EVENT_CHANNELS.SSH_PROFILES_UPDATED,
      e,
    );
  });

  // 设置变化 → 广播 evt:settings:changed
  settingsManager.on(
    'settingsChanged',
    (e: { settings: Settings; changedKeys: string[] }) => {
      broadcastEvent<SettingsChangedPayload>(EVENT_CHANNELS.SETTINGS_CHANGED, {
        settings: e.settings,
        changedKeys: e.changedKeys,
      });
    },
  );

  // Session 事件
  sessionManager.on('sessionCreated', (session) => {
    broadcastEvent<SessionCreatedPayload>(EVENT_CHANNELS.SESSION_CREATED, { session });
    broadcastAppState(deps);
  });

  sessionManager.on('sessionOwnerChanged', (e) => {
    broadcastEvent<SessionOwnerChangedPayload>(EVENT_CHANNELS.SESSION_OWNER_CHANGED, e);
  });

  // CP-3: state-changed 涵盖 active/idle 转移、currentCwd 更新、exited 状态。
  // SessionExitedPayload 仍单独发,因为它带 exitCode 等额外信息。
  sessionManager.on('sessionStateChanged', (e: SessionStateChangedPayload) => {
    broadcastEvent<SessionStateChangedPayload>(
      EVENT_CHANNELS.SESSION_STATE_CHANGED,
      e,
    );
    // active/idle 转移可能影响 trayManager 的图标 (V1.1),广播 app state
    broadcastAppState(deps);
  });

  sessionManager.on('sessionExited', (e: SessionExitedPayload) => {
    broadcastEvent<SessionExitedPayload>(EVENT_CHANNELS.SESSION_EXITED, e);
  });

  // 模板变化 (CP-3: 用户改默认模板 / CP-4: CRUD 自定义模板)
  templatesManager.on(
    'templatesUpdated',
    (e: { templates: Template[]; defaultTemplateId: string }) => {
      broadcastEvent<TemplateListUpdatedPayload>(
        EVENT_CHANNELS.TEMPLATES_UPDATED,
        e,
      );
    },
  );

  sessionManager.on('sessionDestroyed', (e: SessionDestroyedPayload) => {
    broadcastEvent<SessionDestroyedPayload>(EVENT_CHANNELS.SESSION_DESTROYED, e);
    broadcastAppState(deps);
  });

  // Session output → 仅推 owner
  sessionManager.on('sessionOutput', (payload: SessionOutputPayload) => {
    const session = sessionManager.get(payload.sessionId);
    if (!session?.ownerWindowId) return; // 无 owner 不推 (CP-3 写 scrollback)
    const ownerWin = windowManager.getById(session.ownerWindowId);
    if (ownerWin) {
      sendEventTo<SessionOutputPayload>(ownerWin, EVENT_CHANNELS.SESSION_OUTPUT, payload);
    }
  });

  // 窗口列表变化 → 广播 evt:window:list-updated
  // 窗口关闭时:让 SessionManager 把该窗口持有的 sessions 转为无主
  windowManager.onWindowCreated(() => {
    broadcastEvent<WindowListUpdatedPayload>(EVENT_CHANNELS.WINDOW_LIST_UPDATED, {
      windows: windowManager.list(),
    });
    broadcastAppState(deps);
  });

  windowManager.onWindowClosed((windowId) => {
    sessionManager.handleWindowClosed(windowId);
    broadcastEvent<WindowListUpdatedPayload>(EVENT_CHANNELS.WINDOW_LIST_UPDATED, {
      windows: windowManager.list(),
    });
    broadcastAppState(deps);
  });
}

function broadcastAppState(deps: IpcLayerDeps): void {
  const sessions = deps.sessionManager.list();
  broadcastEvent<AppStateChangedPayload>(EVENT_CHANNELS.APP_STATE_CHANGED, {
    hasWindows: deps.windowManager.count() > 0,
    totalSessions: sessions.length,
    activeSessions: sessions.filter((s) => s.state === 'active').length,
  });
}

// ──────────────────────────────────────────────────────────────────
// Snapshot 构建
// ──────────────────────────────────────────────────────────────────

function buildSnapshot(deps: IpcLayerDeps, myWindowId: string): AppSnapshot {
  return {
    windows: deps.windowManager.list(),
    sessions: deps.sessionManager.list(),
    pathTree: deps.pathManager.getTree(),
    sshProfiles: deps.sshProfileManager?.list() ?? [],
    templates: deps.templatesManager.list(),
    defaultTemplateId: deps.templatesManager.getDefaultTemplateId(),
    settings: deps.settingsManager.get(),
    myWindowId,
  };
}

// ──────────────────────────────────────────────────────────────────
// 错误工具
// ──────────────────────────────────────────────────────────────────

interface IpcError extends Error {
  code: string;
  details?: Record<string, unknown>;
}

function makeIpcError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): IpcError {
  const err = new Error(`[ipc] ${code}: ${message}`) as IpcError;
  err.code = code;
  if (details) err.details = details;
  return err;
}

function encryptPasswordOrThrow(plaintext: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw makeIpcError(
      'SafeStorageUnavailable',
      '当前系统未启用 OS 凭据加密(Linux 上可能缺少 libsecret/GNOME Keyring)。无法安全保存密码。',
    );
  }
  return safeStorage.encryptString(plaintext).toString('base64');
}

function decryptStoredPassword(blob: string): { password?: string } {
  if (!safeStorage.isEncryptionAvailable()) return {};
  try {
    const buf = Buffer.from(blob, 'base64');
    return { password: safeStorage.decryptString(buf) };
  } catch {
    return {};
  }
}

async function assertDirectory(path: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(path);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw makeIpcError('PathNotExist', `path="${path}" 不存在`);
    }
    throw makeIpcError(
      'Internal',
      `stat 失败 path="${path}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!stat.isDirectory()) {
    throw makeIpcError('PathNotDirectory', `path="${path}" 不是目录`);
  }
}
