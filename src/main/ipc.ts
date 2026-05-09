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
import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import {
  COMMAND_CHANNELS,
  EVENT_CHANNELS,
  PROTOCOL_VERSION,
  type AddBookmarkPayload,
  type AddBookmarkResponse,
  type AppStateChangedPayload,
  type BookmarksUpdatedPayload,
  type ClaimSessionPayload,
  type ClaimSessionResponse,
  type CloseSessionPayload,
  type CommandEnvelope,
  type CreateSessionPayload,
  type CreateSessionResponse,
  type CreateWindowPayload,
  type CreateWindowResponse,
  type EventEnvelope,
  type FocusSessionOwnerPayload,
  type FocusWindowPayload,
  type GetProtocolVersionResponse,
  type GetSettingsResponse,
  type GetSnapshotPayload,
  type GetSnapshotResponse,
  type PathTreeUpdatedPayload,
  type PickFolderPayload,
  type PickFolderResponse,
  type QuitPayload,
  type QuitResponse,
  type ReleaseSessionPayload,
  type RemoveBookmarkPayload,
  type RemoveFromRecentPayload,
  type RenameBookmarkPayload,
  type ReorderBookmarksPayload,
  type ResizeSessionPayload,
  type SendInputPayload,
  type SessionCreatedPayload,
  type SessionDestroyedPayload,
  type SessionExitedPayload,
  type SessionOutputPayload,
  type SessionOwnerChangedPayload,
  type SetDefaultTemplateForBookmarkPayload,
  type SettingsChangedPayload,
  type ShowInExplorerPayload,
  type UpdateSettingsPayload,
  type WindowFocusRequestedPayload,
  type WindowListUpdatedPayload,
} from '@shared/protocol';
import type { AppSnapshot, Settings, Template } from '@shared/types';
import type { WindowManager } from './window-manager';
import type { PathManager } from './path-manager';
import type { SettingsManager } from './settings-manager';
import type { SessionManager } from './session-manager';
import { setQuitting } from './index';

/**
 * CP-2 内置模板表。CP-3 起由 TemplateManager 持久化。
 */
const CP2_BUILTIN_TEMPLATES: Template[] = [
  {
    id: 'shell',
    name: 'Shell',
    icon: '🐚',
    isBuiltin: true,
    command: '',
    args: [],
    env: {},
    shellFirst: true,
    postExitAction: 'close_session',
  },
];
const CP2_DEFAULT_TEMPLATE_ID = 'shell';

export interface IpcLayerDeps {
  windowManager: WindowManager;
  pathManager: PathManager;
  settingsManager: SettingsManager;
  sessionManager: SessionManager;
}

let installed = false;

/**
 * 注册全部 IPC handler 与事件桥接。整个应用只能调用一次。
 */
export function installIpcLayer(deps: IpcLayerDeps): void {
  if (installed) throw new Error('[ipc] installIpcLayer() already called');
  installed = true;
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
  const { windowManager, pathManager, settingsManager, sessionManager } = deps;

  // App
  ipcMain.handle(
    COMMAND_CHANNELS.APP_GET_PROTOCOL_VERSION,
    (): GetProtocolVersionResponse => ({
      protocolVersion: PROTOCOL_VERSION,
      buildVersion: app.getVersion(),
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
      const info = windowManager.createWindow();
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
    (
      _e,
      envelope: CommandEnvelope<CreateSessionPayload>,
    ): CreateSessionResponse => {
      const { pathId, templateId, takeOwnership = true, cols, rows } = envelope.payload;
      const oldTreeJson = JSON.stringify(pathManager.getTree());
      const session = sessionManager.createSession({
        pathId: pathId ?? '',
        templateId: templateId ?? CP2_DEFAULT_TEMPLATE_ID,
        ownerWindowId: takeOwnership ? envelope.windowId : '',
        cols,
        rows,
      });
      // 若不接管 ownership (罕见,默认接管),把 owner 改为 null
      if (!takeOwnership) {
        sessionManager.releaseOwner(session.id, envelope.windowId);
      }
      const pathTreeChanged =
        JSON.stringify(pathManager.getTree()) !== oldTreeJson;
      return { session, pathTreeChanged };
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.SESSION_CLOSE,
    (_e, envelope: CommandEnvelope<CloseSessionPayload>): void => {
      sessionManager.closeSession(envelope.payload.sessionId);
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.SESSION_CLAIM,
    (
      _e,
      envelope: CommandEnvelope<ClaimSessionPayload>,
    ): ClaimSessionResponse => {
      sessionManager.claimOwner(envelope.payload.sessionId, envelope.windowId);
      // CP-2 无 scrollback;CP-3 接入后从 ring buffer 拉
      return { scrollback: '' };
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.SESSION_RELEASE,
    (_e, envelope: CommandEnvelope<ReleaseSessionPayload>): void => {
      sessionManager.releaseOwner(envelope.payload.sessionId, envelope.windowId);
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
    (_e, envelope: CommandEnvelope<SendInputPayload>): void => {
      sessionManager.sendInput(envelope.payload.sessionId, envelope.payload.data);
    },
  );

  ipcMain.handle(
    COMMAND_CHANNELS.SESSION_RESIZE,
    (_e, envelope: CommandEnvelope<ResizeSessionPayload>): void => {
      sessionManager.resize(
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
}

// ──────────────────────────────────────────────────────────────────
// 事件桥接
// ──────────────────────────────────────────────────────────────────

function wireEventBroadcasts(deps: IpcLayerDeps): void {
  const { windowManager, pathManager, settingsManager, sessionManager } = deps;

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

  sessionManager.on('sessionExited', (e: SessionExitedPayload) => {
    broadcastEvent<SessionExitedPayload>(EVENT_CHANNELS.SESSION_EXITED, e);
  });

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
    templates: CP2_BUILTIN_TEMPLATES,
    defaultTemplateId: CP2_DEFAULT_TEMPLATE_ID,
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
