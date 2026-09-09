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
 *   (path/settings/window 列表广播全部窗口;session output 单目标发 owner 或 parked view)
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
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  nativeImage,
  dialog,
  safeStorage,
  shell,
} from 'electron';
import { getBuildType } from './build-type';
import type { FilePanelService } from './file-panel-service';
import type { FileTreeService } from './file-tree-service';
import { listDirectoryPickerEntries } from './directory-picker-service';
import type { GitService } from './git-service';
import type { FileTreePollingService } from './file-tree-polling-service';
import type { PerformanceDiagnostics } from './performance-diagnostics';
import type { SkillInstaller } from './skill-installer';
import type { PiBridgeInstaller } from './pi-bridge-installer';
import type { MarkdownThemeManager } from './markdown-theme-manager';
import type { CodeBlockRunner } from './code-block-runner';
import type { CommandPanelService, CommandPanelUpdateEvent } from './command-panel-service';
import { dispatchMarinaLink } from './marina-link-dispatch';
import type { SudoPasswordStore } from './sudo-password-store';
import {
  getExplorerIntegrationStatus,
  setClassicIntegration,
  setModernIntegration,
  getPsCommands,
} from './explorer-integration';
import type { ClientRegistry, ClientTransport } from './client-registry';
import type { TerminalViewRegistry } from './terminal-view-registry';
import { promises as fs } from 'node:fs';
import { join as joinPath, isAbsolute as isAbsolutePath } from 'node:path';
import {
  COMMAND_CHANNELS,
  EVENT_CHANNELS,
  PROTOCOL_VERSION,
  type AddBookmarkPayload,
  type AddBookmarkResponse,
  type AddBookmarkGroupPayload,
  type AddBookmarkGroupResponse,
  type AddRemoteBookmarkPayload,
  type AddSshProfilePayload,
  type AddSshProfileResponse,
  // 远程后端 profile(ADR-014 / §14.9)
  type AddRemoteProfilePayload,
  type RemoteDaemonSetPasswordPayload,
  type RemoteDaemonSetPortPayload,
  type RemoteDaemonStatusResponse,
  type AddRemoteProfileResponse,
  type DeleteRemoteProfilePayload,
  type GetRemoteConnectionPayload,
  type GetRemoteConnectionResponse,
  type ListRemoteProfilesResponse,
  type UpdateRemoteProfilePayload,
  type UpdateRemoteProfileResponse,
  type AppStateChangedPayload,
  type BookmarksUpdatedPayload,
  type ClaimSessionPayload,
  type TakeoverSessionPayload,
  type ClaimSessionResponse,
  type AttachTerminalViewPayload,
  type AttachTerminalViewResponse,
  type DetachTerminalViewPayload,
  type ClipboardReadTextResponse,
  type ClipboardWriteTextPayload,
  type ClipboardWriteTextResponse,
  type ClipboardWriteImagePayload,
  type ClipboardWriteImageResponse,
  type FilePanelActionPayload,
  type FilePanelSnapshot,
  type FilePanelUpdatedPayload,
  type FilePanelHeadingNavigationPayload,
  type OpenFilePanelPayload,
  type OpenPathFromMarkdownPayload,
  type RunMarinaLinkPayload,
  type RunMarinaLinkResponse,
  type GetFileTreeRootsPayload,
  type GetFileTreeRootsResponse,
  type ListFileTreeDirectoryPayload,
  type ListFileTreeDirectoryResponse,
  type OpenFileTreeFilePayload,
  type RevealFileTreePathPayload,
  type GetGitStatusPayload,
  type GetGitStatusResponse,
  type SetGitPollingDemandPayload,
  type SetFileTreePollingDemandPayload,
  type SetFileTreeWatchedDirsPayload,
  type FileTreeChangedPayload,
  type GitStatusUpdatedPayload,
  type OpenGitDiffPayload,
  type OpenGitFilePayload,
  type ResolveGitPathResponse,
  type GetOpenFilesPayload,
  type ReadFilePayload,
  type ReadImagePayload,
  type ReadImageResponse,
  type GalleryResolveImagePayload,
  type GalleryResolveImageResponse,
  type GalleryOpenImagePayload,
  type GalleryOpenImageResponse,
  type GalleryRevealImagePayload,
  type GalleryRevealImageResponse,
  type GetMdThemeCssPayload,
  type GetMdThemeCssResponse,
  type ListMdThemesResponse,
  type MdThemeListUpdatedPayload,
  type ReadFileResponse,
  type CloseSessionPayload,
  type CommandEnvelope,
  type CreateSessionPayload,
  type CreateSessionResponse,
  type CreateWindowPayload,
  type CreateWindowResponse,
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
  type KnownHostsRefreshResponse,
  type ListShellsResponse,
  type ListSshProfilesResponse,
  type SshAgentStatusResponse,
  type SshConfigListResponse,
  type OpenExternalPayload,
  type SetDefaultTemplatePayload,
  type SettingsArchiveV1,
  type UpdateTemplatePayload,
  type UpdateTemplateResponse,
  type GetSnapshotResponse,
  type PathTreeUpdatedPayload,
  type PickFolderPayload,
  type PickFolderResponse,
  type ListDirectoryPickerPayload,
  type ListDirectoryPickerResponse,
  type PickSshKeyFilePayload,
  type PickSshKeyFileResponse,
  type QuitPayload,
  type QuitResponse,
  type OpenSessionInNewWindowPayload,
  type OpenSessionInNewWindowResponse,
  type ReleaseSessionPayload,
  type RemoveBookmarkGroupPayload,
  type RemoveBookmarkPayload,
  type RemoveFromRecentPayload,
  type RenameBookmarkGroupPayload,
  type RenameBookmarkPayload,
  type ReorderBookmarksPayload,
  type ReorderSessionsPayload,
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
  type OpenPathPayload,
  type OpenFileTreePathPayload,
  type ListFileTreeRecursivePayload,
  type ListFileTreeRecursiveResponse,
  type SshProfilesUpdatedPayload,
  type ShowInExplorerPayload,
  type TemplateListUpdatedPayload,
  type TestSshProfilePayload,
  type TestSshProfileResponse,
  // 外观归属客户端(local-control):远程窗口读写本机 appearance 的 payload
  type GetAppearanceSettingsResponse,
  type UpdateAppearanceSettingsPayload,
  type LocalAppearanceChangedPayload,
  type UpdateSettingsPayload,
  type UpdateSshProfilePayload,
  type UpdateSshProfileResponse,
  type UpdateSessionUiLayoutPayload,
  type WindowFocusRequestedPayload,
  type WindowListUpdatedPayload,
  type ImeProbeDumpPayload,
  type ImeProbeDumpResponse,
  type ShiftCapturePayload,
  type InstallMarinaSkillPayload,
  type InstallMarinaSkillResponse,
  type PiBridgeInstallPayload,
  type PiBridgeInstallResponse,
  type PiBridgeStatusResponse,
  type RunCodeBlockPayload,
  type RunCodeBlockResponse,
  type StopCodeBlockPayload,
  type CodeBlockOutputPayload,
  type CodeBlockExitedPayload,
  type WorkspaceFilePanelSnapshot,
  type WorkspaceSummary,
  type WorkspaceBindResult,
  type CommandPanelSnapshot,
  type CommandPanelUpdatedPayload,
  type RunCommandPayload,
  type CloseCommandPayload,
  type ShowCommandPayload,
  type UpdateCommandRefreshPolicyPayload,
  type SetCommandDemandPayload,
  type GetCommandPanelStatePayload,
  type SudoPasswordSetPayload,
  type SudoPasswordClearPayload,
  type SudoPasswordHasPayload,
  type SudoPasswordStatePayload,
} from '@shared/protocol';
import type {
  CommandContractMap,
  CommandPayload,
  CommandResponse,
} from '@shared/command-contracts';
import type { AppSnapshot, MdTheme, RemoteDaemonProfile, Settings, Template } from '@shared/types';
import type { WindowManager } from './window-manager';
import type { PathManager } from './path-manager';
import { pathRefFromId } from './path-manager';
import type { SettingsManager } from './settings-manager';
import type { SessionManager } from './session-manager';
import type { SessionWorkspaceCoordinator } from './coordinators/session-workspace-coordinator';
import type { SshProfileManager } from './ssh-profile-manager';
import type { RemoteProfileManager } from './remote-profile-manager';
import { RemoteProfileManagerError } from './remote-profile-manager';
import type { RemoteDaemonController } from './remote-daemon-controller';
import type { TemplatesManager } from './templates-manager';
import type { AIClient } from './ai-client';
import type { KnownHostsManager } from './known-hosts-manager';
import { parseSshConfig } from './ssh-config-parser';
import { detectSshAgent } from './ssh-agent';
import { logger } from './logger';
import { performanceMetrics } from './performance-metrics';
import { getLifecycleState, isQuiescing, setQuitting } from './app-lifecycle';

export interface IpcLayerDeps {
  windowManager: WindowManager;
  pathManager: PathManager;
  settingsManager: SettingsManager;
  sessionManager: SessionManager;
  /**
   * M2:workspace 资源协调器(ADR-024 的 session↔workspaceId 绑定 + workspace 编排)。
   * 从 SessionManager 拆出后,workspace IPC 路由直接委托它(index.ts 注入)。
   */
  workspaceCoordinator: SessionWorkspaceCoordinator;
  sshProfileManager?: SshProfileManager;
  /** v2.0 远程后端(ADR-014 / §14.9):client 端 remote daemon profile 管理。可选。 */
  remoteProfileManager?: RemoteProfileManager;
  /** v2.0 远程服务端控制器(UI 启停 + 配置)。可选(未注入时 daemon IPC 返回错误)。 */
  remoteDaemonController?: RemoteDaemonController;
  /** SSH 方案 §阶段 3.1:已知主机指纹历史,可选(无 SSH 用户不创建) */
  knownHostsManager?: KnownHostsManager;
  templatesManager: TemplatesManager;
  /**
   * 终端侧边文件面板服务(MARINA_SERVICE)。HTTP REST + 状态源 + fs.watch。
   * 生产必填;ipc 层本身不单测(AGENTS.md 5.4 转发逻辑测在 file-panel-service)。
   */
  filePanelService: FilePanelService;
  /** ADR-016 受限文件树服务：仅 active owner session 的 cwd/workspace 双根只读导航。 */
  fileTreeService: FileTreeService;
  /**
   * v0.3.0 (ADR-017):Git 变更浏览服务。与 fileTreeService 同构的安全模式;
   * 只调 git status / git diff,永不写 .git。生产必填;转发逻辑测在
   * git-service.test.ts(本层仅转发)。
   */
  gitService: GitService;
  /**
   * 文件树目录列表的 demand-aware 后台轮询(ADR-021,与 Git 同构):前台文件
   * 面板的展开目录由它每 3s 重验,变化时经 evt:file-tree:changed 广播。
   */
  fileTreePollingService: FileTreePollingService;
  /** 0.3.2 常驻性能飞行记录器 + 用户显式 V8 CPU profile。 */
  performanceDiagnostics: PerformanceDiagnostics;
  /** 内置 show-in-marina skill 的项目级安装服务。 */
  skillInstaller: SkillInstaller;
  /** v0.3.3 ADR-028：pi-marina-bridge package 安装服务（全局/项目级）。 */
  piBridgeInstaller: PiBridgeInstaller;
  /**
   * Markdown 面板主题管理器(Typora 式可扩展)。生产必填;负责扫主题目录、
   * 读 CSS 文本、fs.watch 自动发现增删。
   */
  markdownThemeManager: MarkdownThemeManager;
  /**
   * v2.0 dispatcher 基座:所有 client(本地窗口 + 远程 WS)注册于此。
   * 由调用方(index.ts)创建并注入,与 daemon 协调器(remote-daemon.ts)共享同一实例。
   */
  clientRegistry: ClientRegistry;
  /** 只读终端视图租约；interactive owner 仍由 SessionManager 管理。 */
  terminalViewRegistry: TerminalViewRegistry;
  /**
   * Markdown 代码块一键执行服务(v0.3.3,ADR-023)。直接 spawn 系统命令,
   * 不经 PTY。事件经 wireEventBroadcasts 定向回发起 client。
   */
  codeBlockRunner: CodeBlockRunner;
  /**
   * 命令面板服务(v0.3.3,ADR-028 / Feature G)。AI 经 marina run / HTTP /run / IPC
   * 推送任意命令字符串,复用 codeBlockRunner 执行(bash),输出渲染 markdown 进第 4 面板。
   * 生产必填;转发逻辑测在 command-panel-service(本层仅转发)。
   */
  commandPanelService: CommandPanelService;
  /**
   * v0.3.3 远程 sudo:内存态 sudo 密码仓库。ipc 据此注册 set/clear/has handler +
   * 订阅 changed 广播 SUDO_PASSWORD_STATE(只含 boolean,不含密码)。密码本身永
   * 不过 IPC 返回 renderer(附录 H)。
   */
  sudoPasswordStore: SudoPasswordStore;
  /** BETA-031:可选,未注入时 AI_TEST_CONNECTION 返回 ok:false */
  aiClient?: AIClient;
}

let installed = false;
let aiClient: AIClient | undefined;
/**
 * v2.0 dispatcher 基座(阶段1.2):所有 client(本地窗口 + 远程 WS)注册于此,
 * 广播/定向发都走它。installIpcLayer 时创建并挂窗口生命周期钩子。
 * 远程 WS client 在阶段1.4 也注册进同一实例。
 */
let registry: ClientRegistry | null = null;

/**
 * 注册全部 IPC handler 与事件桥接。整个应用只能调用一次。
 */
export function installIpcLayer(deps: IpcLayerDeps): void {
  if (installed) throw new Error('[ipc] installIpcLayer() already called');
  installed = true;
  aiClient = deps.aiClient;

  // dispatcher 基座:registry 由调用方(index.ts)创建并注入,让 daemon 协调器
  // (remote-daemon.ts)和 ipc 共享同一实例 —— 远程 WS client(阶段1.4)也注册进它。
  // 本地零改动兼容:每个 BrowserWindow 注册成 local client(clientId=windowId,
  // ipc-protocol §2.6.1),renderer 仍走 Electron IPC。
  const reg = deps.clientRegistry;
  registry = reg;
  const wm = deps.windowManager;
  wm.onWindowCreated((info, win) => {
    reg.add({
      clientId: info.id,
      send(channel, envelope) {
        // webContents 可能在窗口关闭瞬间已 destroyed(与原 broadcastEvent 的
        // isDestroyed guard 等价;registry.safeSend 也会兜底吞错)。
        if (!win.isDestroyed()) win.webContents.send(channel, envelope);
      },
    } satisfies ClientTransport);
  });
  wm.onWindowClosed((windowId) => {
    deps.terminalViewRegistry.removeClient(windowId);
    // v0.3.3:Markdown 代码块执行 —— 发起窗口关闭时杀掉它启动的全部运行,
    // 避免向已销毁的 webContents 推事件 + 回收子进程。
    deps.codeBlockRunner.removeClient(windowId);
    // v0.3.3:命令面板同理(它复用 codeBlockRunner,但额外要清自己的 runId 路由 +
    // 后台 demand)。幂等。
    deps.commandPanelService.onWindowClosed(windowId);
    reg.remove(windowId);
  });

  registerCommandHandlers(deps);
  registerFilePanelHandlers(deps);
  registerFileTreeHandlers(deps);
  registerGitHandlers(deps);
  registerCodeBlockHandlers(deps);
  registerCommandPanelHandlers(deps);
  registerSudoPasswordHandlers(deps);
  registerWorkspaceHandlers(deps);
  registerMdThemeHandlers(deps);
  wireEventBroadcasts(deps);
}

// ──────────────────────────────────────────────────────────────────
// 工具:事件广播(委托 ClientRegistry)
// ──────────────────────────────────────────────────────────────────
//
// v2.0 dispatcher 基座(阶段1.2):广播不再直接遍历 BrowserWindow,而是走
// ClientRegistry。本地 in-process 窗口在 installIpcLayer 里注册成 local
// client(clientId=windowId,send 包 webContents.send);远程 WS client 在
// 阶段1.4 也注册进同一 registry。两种 client 同构,broadcast/sendTo 不区分。
//
// 本步是零回归重构:本地路径行为完全不变 —— 发送通道从"遍历窗口"改成
// "遍历 registry 里的 local client",而 local client 就是这些窗口。

function broadcastEvent<P>(channel: string, payload: P): void {
  // registry 在 installIpcLayer 里创建;可选链防御未初始化场景(测试/未调 install)。
  registry?.broadcast(channel, payload);
}

function sendEventTo<P>(clientId: string, channel: string, payload: P): void {
  // 参数从 BrowserWindow 改为 clientId:远程 client 没有 BrowserWindow。
  // session.ownerWindowId 在 v2.0 升级为 ownerClientId 后(阶段1.5),
  // 定向广播只认 clientId。本地路径下 clientId = windowId。
  // 找不到该 client(已关闭/未注册)静默,与原 destroyed window guard 等价。
  registry?.sendTo(clientId, channel, payload);
}

// ──────────────────────────────────────────────────────────────────
// v2.0 dispatcher 基础设施(阶段1.5)
// ──────────────────────────────────────────────────────────────────
// registerHandle:同时挂 Electron IPC + 存进 rawHandlers 表。WS dispatcher
// (dispatchCommand)从表查,用 fakeEvent 调同一组 handler —— 两种 transport
// 同构,业务逻辑零重复,75 个 handler 签名零改动。
//
// 远程 client 无 BrowserWindow,dialog 类命令在 WS 下必须返回明确的
// RemoteDialogUnavailable,不能把 sender=undefined 交给 Electron 后再泄漏 TypeError。
// Renderer 也必须在远程后端窗口改用路径输入,不能要求 headless daemon 弹对话框。
type RawHandler = (e: Electron.IpcMainInvokeEvent, envelope: CommandEnvelope) => unknown;
const rawHandlers = new Map<string, RawHandler>();

function registerHandle<K extends keyof CommandContractMap>(
  channel: K,
  handler: (
    e: Electron.IpcMainInvokeEvent,
    envelope: CommandEnvelope<CommandPayload<K>>,
  ) => CommandResponse<K> | Promise<CommandResponse<K>>,
): void {
  // 0.3.2 性能飞行记录器:统一在 transport 入口按固定 channel 名计时。
  // 不记录 envelope/payload,因此不会把路径、命令或终端内容写进自动报告。
  const measuredHandler = (
    e: Electron.IpcMainInvokeEvent,
    envelope: CommandEnvelope<CommandPayload<K>>,
  ): unknown => {
    const finish = performanceMetrics.begin(`ipc.${channel}`);
    try {
      const result = handler(e, envelope);
      if (isPromiseLike(result)) {
        return Promise.resolve(result).then(
          (value) => {
            finish();
            return value;
          },
          (error) => {
            finish(error);
            throw error;
          },
        );
      }
      finish();
      return result;
    } catch (error) {
      finish(error);
      throw error;
    }
  };
  rawHandlers.set(channel, measuredHandler as RawHandler);
  ipcMain.handle(channel, (e, envelope) => {
    // 退出 quiesce gate(H4):进入退出流程后,本地 IPC 也拒绝新工作,
    // 避免新命令落在 shutdown/flush 之后。与 dispatchCommand 的 WS gate 对称。
    if (isQuiescing()) {
      throw makeIpcError(
        'Quiescing',
        `channel="${channel}" rejected: app is shutting down (lifecycle=${getLifecycleState()})`,
      );
    }
    return measuredHandler(e, envelope as CommandEnvelope<CommandPayload<K>>);
  });
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * 返回 native dialog 的父窗口；远程 transport 没有 webContents 时明确拒绝。
 *
 * 为什么不能静默回退 `BrowserWindow.getFocusedWindow()`:daemon 可能同时运行着
 * 一套本机 GUI，把远程用户的文件选择器弹到无人看到或错误用户的桌面上；更常见
 * 的 headless 场景则直接没有窗口。远程 renderer 应改用后端路径输入。
 */
function requireLocalDialogOwner(
  event: Electron.IpcMainInvokeEvent,
  channel: string,
): BrowserWindow | undefined {
  if (!event.sender) {
    throw makeIpcError(
      'RemoteDialogUnavailable',
      `channel="${channel}" requires a local Electron window, but the command arrived through ` +
        'remote transport without webContents. Possible causes: (1) a remote UI invoked a native ' +
        'file dialog, (2) the command routing domain is wrong. Use a backend-path input in remote ' +
        'windows; native dialogs are only available in local windows.',
    );
  }
  return (
    BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined
  );
}

/**
 * WS command 统一入口。remote-daemon 收到 command 帧后调它。
 * 复用 rawHandlers(与本地 ipcMain.handle 同一组 handler)。
 * fakeEvent.sender = undefined:远程 client 无 webContents。
 * envelope 里的 windowId 字段:WS client 填其 clientId(字段语义扩展,
 * 完整 windowId→clientId 重命名留后续 reviewer 建议项)。
 */
export async function dispatchCommand(
  channel: string,
  envelope: CommandEnvelope,
): Promise<
  { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } }
> {
  // 退出 quiesce gate(H4):进入退出流程后,WS 路径也拒绝新命令。
  // 远程 client 在 daemon 退出窗口内发来的命令不会落在 shutdown/flush 之后。
  if (isQuiescing()) {
    return {
      ok: false,
      error: {
        code: 'Quiescing',
        message: `channel="${channel}" rejected: app is shutting down (lifecycle=${getLifecycleState()})`,
      },
    };
  }
  const handler = rawHandlers.get(channel);
  if (!handler) {
    return {
      ok: false,
      error: { code: 'UnknownChannel', message: `channel="${channel}" 未注册` },
    };
  }
  const fakeEvent = { sender: undefined } as unknown as Electron.IpcMainInvokeEvent;
  try {
    const result = await handler(fakeEvent, envelope);
    return { ok: true, result };
  } catch (err) {
    const code = (err as { code?: string })?.code ?? 'Internal';
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { code, message } };
  }
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
    remoteProfileManager,
    knownHostsManager,
    templatesManager,
    remoteDaemonController,
    performanceDiagnostics,
  } = deps;

  // REMOTE_DAEMON_* 是客户端本地控制面。controller 停止时内部 currentPort=null，
  // 但设置页仍需显示本机“下次启动会用”的配置端口；统一用 settings 补齐。
  const getLocalDaemonStatus = (): RemoteDaemonStatusResponse['status'] => {
    const status = remoteDaemonController?.getStatus() ?? {
      running: false,
      port: null,
      clientCount: 0,
      hasPassword: false,
    };
    return {
      ...status,
      port: status.port ?? settingsManager.get().remoteDaemon.port,
    };
  };

  // App
  registerHandle(
    COMMAND_CHANNELS.APP_GET_PROTOCOL_VERSION,
    (): GetProtocolVersionResponse => ({
      protocolVersion: PROTOCOL_VERSION,
      buildVersion: app.getVersion(),
      buildType: getBuildType(),
    }),
  );

  registerHandle(
    COMMAND_CHANNELS.APP_GET_SNAPSHOT,
    (_e, envelope: CommandEnvelope<GetSnapshotPayload>): GetSnapshotResponse => {
      return buildSnapshot(deps, envelope.windowId);
    },
  );

  registerHandle(
    COMMAND_CHANNELS.APP_QUIT,
    async (_e, _envelope: CommandEnvelope<QuitPayload>): Promise<QuitResponse> => {
      // CP-2 简化:无 session 在跑时的二次确认 (CP-3 加入)
      setQuitting();
      app.quit();
      return { cancelled: false };
    },
  );

  // Window
  registerHandle(
    COMMAND_CHANNELS.WINDOW_CREATE,
    (_e, envelope: CommandEnvelope<CreateWindowPayload>): CreateWindowResponse => {
      // 客户端本地控制面创建窗口。远程窗口通过 preload 调此本地 handler 时,
      // 会带 backendProfileId + 可选 selectSessionId/simpleMode,新窗口因此继续
      // 连接同一 daemon,而不是错误回到本地 backend。
      const info = windowManager.createWindowFromFactory({
        ...(envelope.payload.backendProfileId
          ? { backendProfileId: envelope.payload.backendProfileId }
          : {}),
        ...(envelope.payload.selectSessionId
          ? { selectSessionId: envelope.payload.selectSessionId }
          : {}),
        ...(envelope.payload.simpleMode ? { simpleMode: true } : {}),
      });
      // OS 层窗口标题(任务栏 / Alt+Tab / dock 显示用)。自绘标题栏(frame:false)
      // 已在 renderer 端 WindowChrome 显示远程标识;这里同步更新 OS title,让用户
      // 在任务栏 / Alt+Tab 也能区分远程窗口。profile 名查不到(刚删)时回退到 id。
      if (envelope.payload.backendProfileId) {
        const profile = remoteProfileManager
          ?.list()
          .find((p) => p.id === envelope.payload.backendProfileId);
        const name = profile
          ? `${profile.displayName} (${profile.host})`
          : envelope.payload.backendProfileId;
        const win = windowManager.getById(info.id);
        win?.setTitle(`Marina — Window ${info.number} → ${name}`);
      }
      return { windowId: info.id, windowNumber: info.number };
    },
  );

  registerHandle(
    COMMAND_CHANNELS.WINDOW_CLOSE_SELF,
    (_e, envelope: CommandEnvelope<undefined>): void => {
      windowManager.closeWindow(envelope.windowId);
    },
  );

  registerHandle(
    COMMAND_CHANNELS.WINDOW_CLOSE_ALL,
    (_e, _envelope: CommandEnvelope<undefined>): void => {
      windowManager.closeAll();
    },
  );

  // M1-A:自绘标题栏配套的窗口控制
  registerHandle(
    COMMAND_CHANNELS.WINDOW_MINIMIZE,
    (_e, envelope: CommandEnvelope<undefined>): void => {
      windowManager.minimizeWindow(envelope.windowId);
    },
  );

  registerHandle(
    COMMAND_CHANNELS.WINDOW_TOGGLE_MAXIMIZE,
    (_e, envelope: CommandEnvelope<undefined>): void => {
      windowManager.toggleMaximizeWindow(envelope.windowId);
    },
  );

  registerHandle(
    COMMAND_CHANNELS.WINDOW_GET_MAX_STATE,
    (_e, envelope: CommandEnvelope<undefined>) => {
      return { maximized: windowManager.isMaximized(envelope.windowId) };
    },
  );

  registerHandle(
    COMMAND_CHANNELS.WINDOW_FOCUS,
    (_e, envelope: CommandEnvelope<FocusWindowPayload>): void => {
      const ok = windowManager.focus(envelope.payload.windowId);
      if (!ok) {
        throw makeIpcError('WindowNotFound', `windowId="${envelope.payload.windowId}"`);
      }
      sendEventTo<WindowFocusRequestedPayload>(
        envelope.payload.windowId,
        EVENT_CHANNELS.WINDOW_FOCUS_REQUESTED,
        { reason: 'manual' },
      );
    },
  );

  // Session
  registerHandle(
    COMMAND_CHANNELS.SESSION_CREATE,
    async (_e, envelope: CommandEnvelope<CreateSessionPayload>): Promise<CreateSessionResponse> => {
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
      const effectiveTemplateId = templateId ?? templatesManager.getDefaultTemplateId();
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
                ? ('attach-or-create' as const)
                : ('disabled' as const),
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
      const pathTreeChanged = JSON.stringify(pathManager.getTree()) !== oldTreeJson;
      const warning = sessionManager.lastLaunchWarning ?? undefined;
      return warning ? { session, pathTreeChanged, warning } : { session, pathTreeChanged };
    },
  );

  registerHandle(
    COMMAND_CHANNELS.SESSION_CLOSE,
    (_e, envelope: CommandEnvelope<CloseSessionPayload>): void => {
      sessionManager.closeSession(envelope.payload.sessionId);
    },
  );

  // M1-C
  registerHandle(
    COMMAND_CHANNELS.SESSION_RENAME,
    (_e, envelope: CommandEnvelope<{ sessionId: string; newDisplayName: string }>): void => {
      sessionManager.renameSession(envelope.payload.sessionId, envelope.payload.newDisplayName);
    },
  );

  // STM-3:清除手动重命名标记
  registerHandle(
    COMMAND_CHANNELS.SESSION_CLEAR_MANUAL_RENAME,
    (_e, envelope: CommandEnvelope<{ sessionId: string }>): void => {
      sessionManager.clearManualRename(envelope.payload.sessionId);
    },
  );

  // v0.3.3 Feature E.2 / 决策 #15:拖动同一 path 下 session 重排(服务端内存,不落盘)。
  // 校验在 PathManager.reorderSessions:orderedSessionIds 必须恰好等于该 path 当前 session 集合。
  registerHandle(
    COMMAND_CHANNELS.SESSION_REORDER,
    (_e, envelope: CommandEnvelope<ReorderSessionsPayload>): void => {
      pathManager.reorderSessions(envelope.payload.pathId, envelope.payload.orderedSessionIds);
    },
  );

  // 会话专属 UI 布局由 SessionManager 作为临时 session 状态保存。它会随既有
  // evt:session:state-changed 广播，owner 接管或远程客户端重连无需专门通道。
  registerHandle(
    COMMAND_CHANNELS.SESSION_UPDATE_UI_LAYOUT,
    (_e, envelope: CommandEnvelope<UpdateSessionUiLayoutPayload>): void => {
      sessionManager.updateUiLayout(envelope.payload.sessionId, envelope.payload.patch);
    },
  );

  // v0.3.3 ADR-028:renderer 选中 session 时上报“已查看” → 清 hasUnviewedWork
  // (侧栏指示灯警告色转正常)。同时带 windowId 记入主进程的
  // activeSessionByWindow 映射(isSessionCurrentlyViewed 判定“正在看”用)。
  registerHandle(
    COMMAND_CHANNELS.SESSION_MARK_VIEWED,
    (_e, envelope: CommandEnvelope<{ sessionId: string }>): void => {
      sessionManager.markViewed(envelope.payload.sessionId, envelope.windowId);
    },
  );

  registerHandle(
    COMMAND_CHANNELS.SESSION_CLAIM,
    async (_e, envelope: CommandEnvelope<ClaimSessionPayload>): Promise<ClaimSessionResponse> => {
      sessionManager.claimOwner(envelope.payload.sessionId, envelope.windowId);
      // REPLAY-1(2026-07-31):claim 只更新 owner + 返回 O(1) lastSeq,不再
      // 序列化 / 返回全量 scrollback。历史沿革:
      //   - CP-2 勘误后:带回 scrollback ring buffer 以保协议自洽,注释明说
      //     renderer 通常用 cmd:session:get-scrollback 单独拉,避免 claim 动作
      //     和 history-replay 时序耦合
      //   - CURSOR-1 后:替换路径 = getScrollbackForReplay(完整终端状态 ANSI)
      //   - 实测(2026-07-31):claim 的 scrollback 响应无人消费(冷挂载走
      //     get-scrollback,暖切换走 TerminalDeck 缓存 + view lease),反而每次
      //     切换都重复 serialize + 传输 0.6-2MB payload — 切终端慢的纯浪费点
      // lastSeq 保留在响应里:claim-gate 只 await settle 不用它,但保留它让
      // 协议形状稳定(以后 delta 同步可复用),且是零成本的字段。
      return { lastSeq: sessionManager.getLastEmittedSeq(envelope.payload.sessionId) ?? -1 };
    },
  );

  // v0.3.3 用户裁决:右键菜单「占用此终端」→ 显式强占 owner。claim 对他人
  // 持有抛 SessionAlreadyOwned(8.4 默认不抢);takeover 直接覆盖 —— 服务
  // "远程断网后旧 client 僵尸持有 session"与"用户明确要抢回控制权"两个场景。
  // 旧 owner 侧 UI 由 sessionOwnerChanged 广播自动转「其他窗口持有」,无需
  // 额外通知命令。lastSeq 语义与 claim 相同。
  registerHandle(
    COMMAND_CHANNELS.SESSION_TAKEOVER,
    async (
      _e,
      envelope: CommandEnvelope<TakeoverSessionPayload>,
    ): Promise<ClaimSessionResponse> => {
      sessionManager.takeoverOwner(envelope.payload.sessionId, envelope.windowId);
      return { lastSeq: sessionManager.getLastEmittedSeq(envelope.payload.sessionId) ?? -1 };
    },
  );

  registerHandle(
    COMMAND_CHANNELS.SESSION_GET_SCROLLBACK,
    async (_e, envelope: CommandEnvelope<GetScrollbackPayload>): Promise<GetScrollbackResponse> => {
      // CURSOR-1:走 state-replay 路径(SerializeAddon),不再返回裸字节。
      // 详见 SessionManager.getScrollbackForReplay 与 docs/issues/cursor-1-...
      return sessionManager.getScrollbackForReplay(envelope.payload.sessionId);
    },
  );

  registerHandle(
    COMMAND_CHANNELS.SESSION_ATTACH_TERMINAL_VIEW,
    async (
      _e,
      envelope: CommandEnvelope<AttachTerminalViewPayload>,
    ): Promise<AttachTerminalViewResponse> => {
      const { sessionId, viewId } = envelope.payload;
      const session = sessionManager.get(sessionId);
      if (!session) {
        throw new Error(
          `[ipc] attach terminal view failed: sessionId="${sessionId}" not found. ` +
            'Possible causes: session was closed, renderer snapshot is stale. Refresh app state.',
        );
      }
      // view 是只读输出租约,但首次/重新 attach 仍只允许当前 interactive owner,
      // 防止任意窗口订阅另一个窗口正在操作的终端字节流。
      if (session.ownerWindowId !== envelope.windowId) {
        throw new Error(
          `[ipc] attach terminal view rejected: sessionId="${sessionId}" ` +
            `requester="${envelope.windowId}" owner="${session.ownerWindowId}". ` +
            'Possible causes: owner changed during tab switch, another window claimed the session. ' +
            'Wait for the owner snapshot and retry only when this window owns the session.',
        );
      }
      if (typeof viewId !== 'string' || viewId.length < 8 || viewId.length > 128) {
        throw new Error(
          `[ipc] attach terminal view rejected: invalid viewId length for sessionId="${sessionId}". ` +
            'Possible causes: renderer protocol mismatch, corrupted payload. Reload the window.',
        );
      }
      return deps.terminalViewRegistry.attach(sessionId, envelope.windowId, viewId);
    },
  );

  registerHandle(
    COMMAND_CHANNELS.SESSION_DETACH_TERMINAL_VIEW,
    async (_e, envelope: CommandEnvelope<DetachTerminalViewPayload>): Promise<{ ok: true }> => {
      deps.terminalViewRegistry.detach(
        envelope.payload.sessionId,
        envelope.windowId,
        envelope.payload.viewId,
      );
      return { ok: true };
    },
  );

  registerHandle(
    COMMAND_CHANNELS.SESSION_EXPORT_SCROLLBACK,
    async (_e, envelope: CommandEnvelope<{ sessionId: string }>): Promise<{ text: string }> => {
      // BETA-028:工具栏"复制全部"按钮 → 返回 UTF-8 字符串。
      // CURSOR-1 后 exportScrollback 改 async(读 headless 前需 drain parser)。
      return sessionManager.exportScrollback(envelope.payload.sessionId);
    },
  );

  registerHandle(
    COMMAND_CHANNELS.SESSION_CLEAR_SCROLLBACK,
    (_e, envelope: CommandEnvelope<{ sessionId: string }>): void => {
      // BETA-028:工具栏"清屏"按钮配合 term.clear() 使用
      sessionManager.clearScrollback(envelope.payload.sessionId);
    },
  );

  registerHandle(
    COMMAND_CHANNELS.SESSION_RELEASE,
    (_e, envelope: CommandEnvelope<ReleaseSessionPayload>): void => {
      sessionManager.releaseOwner(envelope.payload.sessionId, envelope.windowId);
    },
  );

  registerHandle(
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
      if (session.ownerWindowId !== null && session.ownerWindowId !== envelope.windowId) {
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

  registerHandle(
    COMMAND_CHANNELS.SESSION_FOCUS_OWNER,
    (_e, envelope: CommandEnvelope<FocusSessionOwnerPayload>): void => {
      const session = sessionManager.get(envelope.payload.sessionId);
      if (!session) {
        throw makeIpcError('SessionNotFound', `sessionId="${envelope.payload.sessionId}"`);
      }
      if (!session.ownerWindowId) return; // 无主无可聚焦

      // owner 可能是两种 client:
      // 1) daemon 本进程 BrowserWindow id → WindowManager 可直接聚焦;
      // 2) 远程 WS clientId → daemon 没有那个客户端的 BrowserWindow,不能拿
      //    clientId 调本地 WindowManager。此时只定向发 focus-requested,由远程
      //    preload 在客户端本机聚焦其 BrowserWindow,renderer 再选中 session。
      windowManager.focus(session.ownerWindowId);
      sendEventTo<WindowFocusRequestedPayload>(
        session.ownerWindowId,
        EVENT_CHANNELS.WINDOW_FOCUS_REQUESTED,
        { reason: 'session-click', selectSessionId: session.id },
      );
    },
  );

  registerHandle(
    COMMAND_CHANNELS.SESSION_SEND_INPUT,
    (_e, envelope: CommandEnvelope<SendInputPayload>): SendInputResponse => {
      // IPC-3:ownership 校验 — 防止 renderer 状态短暂落后于 main 时,
      // 一个已不归本窗口的 session 仍接受写入(用户视觉上"打字了但没回显",
      // 因为 sessionOutput 推给了真 owner)。
      //
      // 只有 interactive owner 能写。旧实现放行 owner=null 的“即将 claim”窗口，
      // 但 TerminalDeck 引入 parked view 后这会让切换边界的延迟 paste/drop 写进
      // 已隐藏 session；宁可在 claim 完成前拒绝一次，也不能写错终端。
      const sess = sessionManager.get(envelope.payload.sessionId);
      if (sess && sess.ownerWindowId !== envelope.windowId) {
        return { accepted: false, reason: 'not-owner' };
      }
      return sessionManager.sendInput(envelope.payload.sessionId, envelope.payload.data);
    },
  );

  registerHandle(
    COMMAND_CHANNELS.SESSION_RESIZE,
    (_e, envelope: CommandEnvelope<ResizeSessionPayload>): ResizeSessionResponse => {
      const session = sessionManager.get(envelope.payload.sessionId);
      if (session && session.ownerWindowId !== envelope.windowId) {
        return { accepted: false, reason: 'not-owner' };
      }
      return sessionManager.resize(
        envelope.payload.sessionId,
        envelope.payload.cols,
        envelope.payload.rows,
      );
    },
  );

  // Bookmark / Path
  registerHandle(
    COMMAND_CHANNELS.BOOKMARK_ADD,
    async (_e, envelope: CommandEnvelope<AddBookmarkPayload>): Promise<AddBookmarkResponse> => {
      // 校验路径是目录 (软件定义书 5.1.1 要求文件夹选择器/拖拽路径,
      // ipc-protocol PathNotDirectory / PathNotExist 错误码)
      await assertDirectory(envelope.payload.path);
      const bookmark = pathManager.addBookmark({
        path: envelope.payload.path,
        ...(envelope.payload.displayName ? { displayName: envelope.payload.displayName } : {}),
        ...(envelope.payload.defaultTemplateId
          ? { defaultTemplateId: envelope.payload.defaultTemplateId }
          : {}),
        ...(envelope.payload.groupId !== undefined ? { groupId: envelope.payload.groupId } : {}),
      });
      return { bookmark };
    },
  );

  registerHandle(
    COMMAND_CHANNELS.BOOKMARK_REMOVE,
    (_e, envelope: CommandEnvelope<RemoveBookmarkPayload>): void => {
      pathManager.removeBookmark(envelope.payload.pathId);
    },
  );

  registerHandle(
    COMMAND_CHANNELS.BOOKMARK_RENAME,
    (_e, envelope: CommandEnvelope<RenameBookmarkPayload>): void => {
      pathManager.renameBookmark(envelope.payload.pathId, envelope.payload.newDisplayName);
    },
  );

  registerHandle(
    COMMAND_CHANNELS.BOOKMARK_REORDER,
    (_e, envelope: CommandEnvelope<ReorderBookmarksPayload>): void => {
      // v0.3.3 ADR-025:统一分层 reorder(ungrouped + groups[].childOrder)。
      pathManager.reorderBookmarks({
        ungrouped: envelope.payload.ungrouped,
        groups: envelope.payload.groups,
      });
    },
  );

  // v0.3.3 ADR-025 / Feature E.1:收藏分组 CRUD(各自独立 IPC)。
  registerHandle(
    COMMAND_CHANNELS.BOOKMARK_GROUP_ADD,
    (_e, envelope: CommandEnvelope<AddBookmarkGroupPayload>): AddBookmarkGroupResponse => {
      const group = pathManager.addGroup(
        envelope.payload.name,
        envelope.payload.kind,
        envelope.payload.parentId ?? undefined,
      );
      return { id: group.id };
    },
  );

  registerHandle(
    COMMAND_CHANNELS.BOOKMARK_GROUP_RENAME,
    (_e, envelope: CommandEnvelope<RenameBookmarkGroupPayload>): void => {
      pathManager.renameGroup(envelope.payload.id, envelope.payload.name);
    },
  );

  registerHandle(
    COMMAND_CHANNELS.BOOKMARK_GROUP_REMOVE,
    (_e, envelope: CommandEnvelope<RemoveBookmarkGroupPayload>): void => {
      pathManager.removeGroup(envelope.payload.id);
    },
  );

  registerHandle(
    COMMAND_CHANNELS.BOOKMARK_SET_DEFAULT_TEMPLATE,
    (_e, envelope: CommandEnvelope<SetDefaultTemplateForBookmarkPayload>): void => {
      pathManager.setDefaultTemplate(envelope.payload.pathId, envelope.payload.templateId);
    },
  );

  registerHandle(
    COMMAND_CHANNELS.BOOKMARK_PICK_FOLDER,
    async (_e, envelope: CommandEnvelope<PickFolderPayload>): Promise<PickFolderResponse> => {
      const owner = requireLocalDialogOwner(_e, COMMAND_CHANNELS.BOOKMARK_PICK_FOLDER);
      const options: Electron.OpenDialogOptions = {
        title: '选择文件夹',
        properties: ['openDirectory'],
        ...(envelope.payload.defaultPath ? { defaultPath: envelope.payload.defaultPath } : {}),
      };
      const result = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) {
        return { path: null };
      }
      return { path: result.filePaths[0]! };
    },
  );

  registerHandle(
    COMMAND_CHANNELS.DIRECTORY_PICKER_LIST,
    (
      _e,
      envelope: CommandEnvelope<ListDirectoryPickerPayload>,
    ): Promise<ListDirectoryPickerResponse> => {
      // backend-data 命令:本地窗口在本机 main 列目录；远程窗口经 WS 在 daemon
      // 列目录。renderer 因而能用同一个“点击式”选择器浏览正确电脑。
      return listDirectoryPickerEntries(envelope.payload.path);
    },
  );

  registerHandle(
    COMMAND_CHANNELS.PATH_REMOVE_FROM_RECENT,
    (_e, envelope: CommandEnvelope<RemoveFromRecentPayload>): void => {
      pathManager.removeFromRecent(envelope.payload.path);
    },
  );

  // 收藏路径右键的“安装 Marina Skill”(claude/codex 目标;pi 由 pi-marina-bridge
  // 自动注入,不走这里,见 skill-installer.ts 头注释)。它写的是当前 backend 上
  // 所选项目的 agent 目录，因此在远程 backend 窗口中会由 daemon 执行，不能标为
  // local-control。
  registerHandle(
    COMMAND_CHANNELS.SKILL_INSTALL_MARINA,
    async (
      _e,
      envelope: CommandEnvelope<InstallMarinaSkillPayload>,
    ): Promise<InstallMarinaSkillResponse> => deps.skillInstaller.install(envelope.payload),
  );

  // v0.3.3 ADR-028：pi-marina-bridge 安装（全局/项目级）+ 状态查询。同 skill-install
  // 一样写当前 backend（项目级写 daemon 上所选项目；全局写 daemon 主机 ~/.pi/agent），
  // 因此远程窗口也由 daemon 执行，不标 local-control。
  registerHandle(
    COMMAND_CHANNELS.PI_BRIDGE_INSTALL,
    async (
      _e,
      envelope: CommandEnvelope<PiBridgeInstallPayload>,
    ): Promise<PiBridgeInstallResponse> => {
      const r = await deps.piBridgeInstaller.install(envelope.payload);
      return {
        alreadyInstalled: r.alreadyInstalled,
        packageDir: r.packageDir,
        settingsFile: r.settingsFile,
      };
    },
  );
  registerHandle(
    COMMAND_CHANNELS.PI_BRIDGE_STATUS,
    async (_e, _envelope): Promise<PiBridgeStatusResponse> => {
      const piInstalled = deps.piBridgeInstaller.isPiInstalled();
      // 已装检测：读全局 settings.json 的 packages 是否含稳定位置路径。
      const globallyInstalled = await deps.piBridgeInstaller
        .isGloballyInstalled()
        .catch(() => false);
      return { piInstalled, globallyInstalled };
    },
  );

  // SSH profiles / remote bookmarks
  registerHandle(
    COMMAND_CHANNELS.SSH_PROFILE_LIST,
    (_e, _envelope: CommandEnvelope<undefined>): ListSshProfilesResponse => {
      return { profiles: sshProfileManager?.list() ?? [] };
    },
  );

  registerHandle(
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

  registerHandle(
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

  registerHandle(
    COMMAND_CHANNELS.SSH_PROFILE_PICK_KEY_FILE,
    async (
      _e,
      envelope: CommandEnvelope<PickSshKeyFilePayload>,
    ): Promise<PickSshKeyFileResponse> => {
      const owner = requireLocalDialogOwner(_e, COMMAND_CHANNELS.SSH_PROFILE_PICK_KEY_FILE);
      const options: Electron.OpenDialogOptions = {
        title: '选择 SSH 私钥文件',
        properties: ['openFile', 'showHiddenFiles'],
        ...(envelope.payload.defaultPath ? { defaultPath: envelope.payload.defaultPath } : {}),
      };
      const result = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) {
        return { path: null };
      }
      return { path: result.filePaths[0]! };
    },
  );

  registerHandle(
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

  // ── 远程后端 profile(ADR-014 / §14.9)──
  // 模式对齐 SSH profile:list 返回 public 副本;add/update 接明文 token,
  // 这里用 encryptPasswordOrThrow 加密后传 manager(同 SSH password)。
  registerHandle(
    COMMAND_CHANNELS.REMOTE_PROFILE_LIST,
    (_e, _envelope: CommandEnvelope<undefined>): ListRemoteProfilesResponse => ({
      profiles: remoteProfileManager?.list() ?? [],
    }),
  );

  registerHandle(
    COMMAND_CHANNELS.REMOTE_PROFILE_ADD,
    (_e, envelope: CommandEnvelope<AddRemoteProfilePayload>): AddRemoteProfileResponse => {
      if (!remoteProfileManager) {
        throw makeIpcError('RemoteProfileUnavailable', 'remote profile manager 未初始化');
      }
      const { password, ...rest } = envelope.payload;
      const input: Omit<RemoteDaemonProfile, 'id' | 'addedAt'> = { ...rest };
      if (typeof password === 'string' && password.length > 0) {
        input.tokenEncrypted = encryptPasswordOrThrow(password);
      }
      return { profile: remoteProfileManager.add(input) };
    },
  );

  registerHandle(
    COMMAND_CHANNELS.REMOTE_PROFILE_UPDATE,
    (_e, envelope: CommandEnvelope<UpdateRemoteProfilePayload>): UpdateRemoteProfileResponse => {
      if (!remoteProfileManager) {
        throw makeIpcError('RemoteProfileUnavailable', 'remote profile manager 未初始化');
      }
      const { password, ...partialRest } = envelope.payload.partial;
      const partial: typeof partialRest & { tokenEncrypted?: string } = { ...partialRest };
      if (typeof password === 'string') {
        // '' 清除已配对密码;非空加密落盘(同 SSH password 语义)
        partial.tokenEncrypted = password.length > 0 ? encryptPasswordOrThrow(password) : '';
      }
      const profile = remoteProfileManager.update(envelope.payload.id, partial);
      // profile 改名/改 host 后同步 OS 层 title(任务栏 / Alt+Tab)。renderer 的
      // WindowChrome 通过本地 REMOTE_PROFILES_UPDATED 同步自绘标题栏。
      for (const info of windowManager.list()) {
        if (info.backendProfileId !== profile.id) continue;
        windowManager
          .getById(info.id)
          ?.setTitle(`Marina — Window ${info.number} → ${profile.displayName} (${profile.host})`);
      }
      return { profile };
    },
  );

  registerHandle(
    COMMAND_CHANNELS.REMOTE_PROFILE_DELETE,
    (_e, envelope: CommandEnvelope<DeleteRemoteProfilePayload>): void => {
      if (!remoteProfileManager) {
        throw makeIpcError('RemoteProfileUnavailable', 'remote profile manager 未初始化');
      }
      // 检查是否有窗口正在连该远程后端。已打开的远程窗口 URL ?backend=<id> 已定死,
      // 删除 profile 后它的 preload 会拿不到连接信息,下次重连会失败。
      const inUse = windowManager.list().find((w) => w.backendProfileId === envelope.payload.id);
      if (inUse) {
        throw makeIpcError(
          'RemoteProfileInUse',
          `该远程电脑正被窗口 ${inUse.number} 使用,请先关闭该窗口。`,
        );
      }
      try {
        remoteProfileManager.delete(envelope.payload.id);
      } catch (err) {
        if (err instanceof RemoteProfileManagerError) {
          throw makeIpcError('RemoteProfileNotFound', err.message);
        }
        throw err;
      }
    },
  );

  // preload 启动时按 profileId 拉连接信息(url + 解密 token)。null=无此 profile/未配对。
  // 每窗口后端:窗口创建时定 backend,preload 据此 profileId 决定连哪个 daemon。
  registerHandle(
    COMMAND_CHANNELS.REMOTE_PROFILE_GET_CONNECTION,
    (_e, envelope: CommandEnvelope<GetRemoteConnectionPayload>): GetRemoteConnectionResponse => {
      if (!remoteProfileManager) return { connection: null };
      const internal = remoteProfileManager.getInternal(envelope.payload.profileId);
      if (!internal || !internal.tokenEncrypted) return { connection: null };
      const { password: token } = decryptStoredPassword(internal.tokenEncrypted);
      if (!token) return { connection: null };
      return {
        connection: {
          host: internal.host,
          token,
          profileId: internal.id,
          displayName: internal.displayName,
        },
      };
    },
  );

  // v2.0 远程服务端运行时启停 + 配置(UI 按钮触发)
  registerHandle(
    COMMAND_CHANNELS.REMOTE_DAEMON_START,
    async (): Promise<RemoteDaemonStatusResponse> => {
      if (!remoteDaemonController) {
        throw makeIpcError('RemoteProfileUnavailable', 'remote daemon controller 未初始化');
      }
      const port = settingsManager.get().remoteDaemon.port;
      await remoteDaemonController.start(port);
      return { status: getLocalDaemonStatus() };
    },
  );
  registerHandle(
    COMMAND_CHANNELS.REMOTE_DAEMON_STOP,
    async (): Promise<RemoteDaemonStatusResponse> => {
      if (!remoteDaemonController) {
        throw makeIpcError('RemoteProfileUnavailable', 'remote daemon controller 未初始化');
      }
      await remoteDaemonController.stop();
      return { status: getLocalDaemonStatus() };
    },
  );
  registerHandle(
    COMMAND_CHANNELS.REMOTE_DAEMON_GET_STATUS,
    (): RemoteDaemonStatusResponse => ({
      status: getLocalDaemonStatus(),
    }),
  );
  registerHandle(
    COMMAND_CHANNELS.REMOTE_DAEMON_SET_PORT,
    async (
      _e,
      envelope: CommandEnvelope<RemoteDaemonSetPortPayload>,
    ): Promise<RemoteDaemonStatusResponse> => {
      const port = envelope.payload.port;
      settingsManager.update({
        remoteDaemon: { ...settingsManager.get().remoteDaemon, port },
      });
      // 运行中则用新端口重启(踢所有 client 重连);未运行只改配置
      if (remoteDaemonController) {
        await remoteDaemonController.restartIfRunning(port);
      }
      return { status: getLocalDaemonStatus() };
    },
  );
  registerHandle(
    COMMAND_CHANNELS.REMOTE_DAEMON_SET_PASSWORD,
    async (
      _e,
      envelope: CommandEnvelope<RemoteDaemonSetPasswordPayload>,
    ): Promise<RemoteDaemonStatusResponse> => {
      if (!remoteDaemonController) {
        throw makeIpcError('RemoteProfileUnavailable', 'remote daemon controller 未初始化');
      }
      await remoteDaemonController.setPassword(envelope.payload.password);
      return { status: getLocalDaemonStatus() };
    },
  );

  registerHandle(
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

  registerHandle(
    COMMAND_CHANNELS.REMOTE_BOOKMARK_ADD,
    (_e, envelope: CommandEnvelope<AddRemoteBookmarkPayload>): AddBookmarkResponse => {
      const profile = sshProfileManager?.get(envelope.payload.sshProfileId);
      if (!profile) {
        throw makeIpcError('SshProfileNotFound', `sshProfileId="${envelope.payload.sshProfileId}"`);
      }
      const bookmark = pathManager.addBookmark({
        kind: 'ssh',
        sshProfileId: profile.id,
        path: envelope.payload.remotePath,
        ...(envelope.payload.displayName ? { displayName: envelope.payload.displayName } : {}),
        ...(envelope.payload.defaultTemplateId
          ? { defaultTemplateId: envelope.payload.defaultTemplateId }
          : {}),
        ...(envelope.payload.groupId !== undefined ? { groupId: envelope.payload.groupId } : {}),
      });
      return { bookmark };
    },
  );

  // SSH 方案 §阶段 2.1:ssh_config 集成 — 只在 advanced.includeSshConfig 开
  // 时读 ~/.ssh/config。关时返回 enabled=false + entries=[],renderer 自动
  // 不渲染 ssh_config 区。
  registerHandle(
    COMMAND_CHANNELS.SSH_CONFIG_LIST,
    (_e, _envelope: CommandEnvelope<undefined>): SshConfigListResponse => {
      const enabled = settingsManager.get().advanced.includeSshConfig === true;
      if (!enabled) return { enabled: false, entries: [] };
      const entries = parseSshConfig().map((e) => ({
        alias: e.alias,
        hostName: e.hostName,
        ...(e.user ? { user: e.user } : {}),
        port: e.port,
        identityFiles: e.identityFiles,
        proxyJump: e.proxyJump,
        sourceFile: e.sourceFile,
      }));
      return { enabled: true, entries };
    },
  );

  // SSH 方案 §阶段 2.2:同步探测 ssh-agent。耗时 ~100ms 以内,不进 worker。
  registerHandle(
    COMMAND_CHANNELS.SSH_AGENT_STATUS,
    (_e, _envelope: CommandEnvelope<undefined>): SshAgentStatusResponse => {
      const r = detectSshAgent();
      if (r.status === 'agent-running') {
        return { status: 'agent-running', keys: r.keys };
      }
      return { status: 'agent-missing', reason: r.reason, message: r.message };
    },
  );

  // SSH 方案 §阶段 3.1:列 ~/.ssh/known_hosts 并 diff history。
  // knownHostsManager 不在 deps 时返回空,避免 renderer 出错。
  registerHandle(
    COMMAND_CHANNELS.KNOWN_HOSTS_REFRESH,
    (_e, _envelope: CommandEnvelope<undefined>): KnownHostsRefreshResponse => {
      if (!knownHostsManager) return { entries: [], changes: [] };
      const r = knownHostsManager.refresh();
      return {
        entries: r.entries.map((e) => ({
          hosts: e.hosts,
          keyType: e.keyType,
          fingerprint: e.fingerprint,
          sourceFile: e.sourceFile,
          isHashed: e.isHashed,
        })),
        changes: r.changes,
      };
    },
  );

  // Settings
  registerHandle(
    COMMAND_CHANNELS.SETTINGS_GET,
    (_e, _envelope: CommandEnvelope<undefined>): GetSettingsResponse => {
      return { settings: settingsManager.get() };
    },
  );

  registerHandle(
    COMMAND_CHANNELS.SETTINGS_UPDATE,
    (_e, envelope: CommandEnvelope<UpdateSettingsPayload>): void => {
      settingsManager.update(envelope.payload.partial);
    },
  );

  registerHandle(
    COMMAND_CHANNELS.SETTINGS_RESET,
    (_e, _envelope: CommandEnvelope<undefined>): void => {
      settingsManager.reset();
    },
  );

  // ── 外观归属客户端(local-control 域,见 docs/plans/远程窗口外观继承本机.md)──
  // 这两个通道被声明在 LOCAL_CONTROL_COMMANDS_SET,远程窗口调用时走客户端本地
  // IPC,读写的是【当前客户端机器】的 settingsManager,而非所连 daemon。本地窗口
  // 一般用上面的 SETTINGS_GET/UPDATE 即可;这两个通道主要服务远程窗口的
  // “外观跟随本机”需求。handler 本身与本地/远程无关 —— 它始终操作本进程 settingsManager。
  registerHandle(
    COMMAND_CHANNELS.SETTINGS_GET_APPEARANCE,
    (_e, _envelope: CommandEnvelope<undefined>): GetAppearanceSettingsResponse => {
      return { appearance: settingsManager.get().appearance };
    },
  );

  registerHandle(
    COMMAND_CHANNELS.SETTINGS_UPDATE_APPEARANCE,
    (_e, envelope: CommandEnvelope<UpdateAppearanceSettingsPayload>): void => {
      // 合并到现有 appearance 块后整体写入。update 内部会触发 settingsChanged 事件,
      // 进而广播 SETTINGS_CHANGED(本地窗口)+ SETTINGS_LOCAL_APPEARANCE_CHANGED
      // (远程窗口,见下方 wireEventBroadcasts)。只合并顶层叶子字段。
      const current = settingsManager.get().appearance;
      settingsManager.update({
        appearance: { ...current, ...envelope.payload.partial },
      });
    },
  );

  registerHandle(
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

  registerHandle(
    COMMAND_CHANNELS.SETTINGS_GET_AUTO_START,
    (_e, _envelope: CommandEnvelope<undefined>): GetAutoStartResponse => {
      // Electron 跨平台 API,Windows 上读 Run 注册表
      return { enabled: app.getLoginItemSettings().openAtLogin };
    },
  );

  // System
  registerHandle(
    COMMAND_CHANNELS.SYSTEM_SHOW_IN_EXPLORER,
    async (_e, envelope: CommandEnvelope<ShowInExplorerPayload>): Promise<void> => {
      shell.showItemInFolder(envelope.payload.path);
    },
  );

  // v0.3.2:用系统默认应用打开本地文件/目录(右键「用默认应用打开」)。
  // 与 SYSTEM_OPEN_EXTERNAL(只 http/https/mailto)不同 —— 本通道开本地路径,
  // renderer 必须先 resolve 到绝对路径(git:resolve-path / file-panel 已持 / 等)。
  // file-tree 因 rootId 抽象走专用 FILE_TREE_OPEN_PATH,不经此通道。
  registerHandle(
    COMMAND_CHANNELS.SYSTEM_OPEN_PATH,
    async (_e, envelope: CommandEnvelope<OpenPathPayload>): Promise<void> => {
      const p = envelope.payload.path;
      // 防御:必须是绝对路径(阻止相对路径 / UNC 越界尝试)。openPath 对不存在路径
      // 返回错误串而不报异常,这里不额外校验存在性 —— 文件刚删等竞态由系统提示。
      if (!p || !isAbsolutePath(p)) {
        throw makeIpcError('InvalidPath', `SYSTEM_OPEN_PATH 要求绝对路径,收到: "${p}"`);
      }
      await shell.openPath(p);
    },
  );

  // 0.3.2 性能诊断命令全是当前客户端本机 control-plane；protocol.ts 已把
  // channel 列入 LOCAL_CONTROL_COMMANDS_SET，远程窗口不会误发给 daemon。
  registerHandle(
    COMMAND_CHANNELS.PERFORMANCE_GET_STATUS,
    (): ReturnType<PerformanceDiagnostics['getStatus']> => performanceDiagnostics.getStatus(),
  );

  registerHandle(
    COMMAND_CHANNELS.PERFORMANCE_WRITE_REPORT,
    async (): Promise<ReturnType<PerformanceDiagnostics['getStatus']>> =>
      performanceDiagnostics.writeReportNow(),
  );

  registerHandle(COMMAND_CHANNELS.PERFORMANCE_OPEN_REPORTS_DIR, async (): Promise<void> => {
    await fs.mkdir(performanceDiagnostics.getReportDir(), { recursive: true });
    const openError = await shell.openPath(performanceDiagnostics.getReportDir());
    if (openError) {
      throw new Error(
        `[IPC] Failed to open performance report directory. ` +
          `Possible causes: Explorer unavailable, directory permission denied, or shell integration failure. ${openError}`,
      );
    }
  });

  registerHandle(COMMAND_CHANNELS.PERFORMANCE_CAPTURE_CPU_PROFILE, async (_e, envelope) =>
    performanceDiagnostics.captureCpuProfile(envelope.payload.durationSeconds ?? 15),
  );

  registerHandle(
    COMMAND_CHANNELS.SYSTEM_OPEN_DATA_DIR,
    async (_e, _envelope: CommandEnvelope<undefined>): Promise<void> => {
      // app.getPath('userData') = %APPDATA%\Marina
      await shell.openPath(app.getPath('userData'));
    },
  );

  registerHandle(
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

  registerHandle(
    COMMAND_CHANNELS.SYSTEM_GET_BUILD_TYPE,
    (_e, _envelope: CommandEnvelope<undefined>) => {
      return { buildType: getBuildType() };
    },
  );

  registerHandle(
    COMMAND_CHANNELS.SYSTEM_GET_DATA_DIR,
    (_e, _envelope: CommandEnvelope<undefined>): { dataDir: string } => {
      // BETA-039:UI 设置页用真实绝对路径替代硬编码 %APPDATA%\Marina,
      // 在 portable / dev / 自定义 userData 场景下也保持准确。
      return { dataDir: app.getPath('userData') };
    },
  );

  registerHandle(
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
  registerHandle(
    COMMAND_CHANNELS.LOGGER_IME_DUMP,
    (_e, envelope: CommandEnvelope<ImeProbeDumpPayload>): ImeProbeDumpResponse => {
      const { meta, entries } = envelope.payload;
      logger.ime(
        'ime-probe',
        `leak dump session=${meta.sessionId} t=${meta.t} entries=${entries.length}`,
        { meta, entries },
      );
      return { ok: true };
    },
  );

  // [DEBUG-shift2] 终端左移 bug 捕获:renderer 检测器发现几何异常时上报,
  // main 端两件事(均 fire-and-forget 友好,永不 throw):
  //   1. JSONL 追加 logs/shift-capture-YYYY-MM-DD.log(一行一事件)
  //   2. 发送方窗口 capturePage 截图 → logs/shift-capture-<ts>.png(全局限频 3s)
  // 结案后连同通道/检测器一起删(grep: DEBUG-shift2)。
  let lastShiftShot = 0;
  registerHandle(
    COMMAND_CHANNELS.DEBUG_SHIFT_CAPTURE,
    async (
      _e: Electron.IpcMainInvokeEvent,
      envelope: CommandEnvelope<ShiftCapturePayload>,
    ): Promise<{ ok: true }> => {
      const { sessionId, kind, problems, snapshot } = envelope.payload;
      const line = JSON.stringify({
        t: new Date().toISOString(),
        sessionId,
        kind,
        problems,
        snapshot,
      });
      try {
        const logsDir = joinPath(app.getPath('userData'), 'logs');
        await fs.mkdir(logsDir, { recursive: true });
        const day = new Date().toISOString().slice(0, 10);
        await fs.appendFile(joinPath(logsDir, `shift-capture-${day}.log`), line + '\n', 'utf8');
        const now = Date.now();
        if (now - lastShiftShot > 3000) {
          lastShiftShot = now;
          const win = BrowserWindow.fromWebContents(_e.sender);
          if (win && !win.isDestroyed()) {
            const img = await win.webContents.capturePage();
            await fs.writeFile(joinPath(logsDir, `shift-capture-${now}.png`), img.toPNG());
          }
        }
      } catch (err) {
        console.warn('[shift-capture] dump failed:', err);
      }
      return { ok: true };
    },
  );

  // Explorer 集成 —— 不读 settings,现场查 + 操作系统状态
  registerHandle(
    COMMAND_CHANNELS.EXPLORER_INTEGRATION_GET_STATUS,
    async (_e, _envelope: CommandEnvelope<undefined>) => {
      return await getExplorerIntegrationStatus();
    },
  );

  registerHandle(
    COMMAND_CHANNELS.EXPLORER_INTEGRATION_SET_CLASSIC,
    async (_e, envelope: CommandEnvelope<{ enabled: boolean }>) => {
      const result = await setClassicIntegration(envelope.payload.enabled, app.getPath('exe'));
      const status = await getExplorerIntegrationStatus();
      return { ok: result.ok, message: result.message, status };
    },
  );

  registerHandle(
    COMMAND_CHANNELS.EXPLORER_INTEGRATION_SET_MODERN,
    async (_e, envelope: CommandEnvelope<{ enabled: boolean }>) => {
      const result = await setModernIntegration(envelope.payload.enabled);
      const status = await getExplorerIntegrationStatus();
      return { ok: result.ok, message: result.message, status };
    },
  );

  registerHandle(
    COMMAND_CHANNELS.EXPLORER_INTEGRATION_GET_PS_COMMANDS,
    (_e, _envelope: CommandEnvelope<undefined>) => {
      return getPsCommands(app.getPath('exe'));
    },
  );

  registerHandle(
    COMMAND_CHANNELS.SYSTEM_OPEN_EXTERNAL,
    async (_e, envelope: CommandEnvelope<OpenExternalPayload>): Promise<void> => {
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
  registerHandle(
    COMMAND_CHANNELS.SYSTEM_CLIPBOARD_READ_TEXT,
    (_e, _envelope: CommandEnvelope<undefined>): ClipboardReadTextResponse => {
      try {
        return { text: clipboard.readText() };
      } catch {
        return { text: '' };
      }
    },
  );

  registerHandle(
    COMMAND_CHANNELS.SYSTEM_CLIPBOARD_WRITE_TEXT,
    (_e, envelope: CommandEnvelope<ClipboardWriteTextPayload>): ClipboardWriteTextResponse => {
      try {
        clipboard.writeText(envelope.payload.text);
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
  );

  // v0.3.3 文档图片交互:复制图片本体到系统剪贴板。payload 是 renderer 已加载
  // 在 <img> 里的 base64 dataUrl —— main 端不重读磁盘,保证"复制的就是看到的
  // 那一帧"(文件 mtime 变更后 read-image 已 cache-bust 重拉)。
  // 防御:只接受 data:image/ 前缀,防止把任意 dataUrl(如内嵌 HTML/SVG 外的
  // 内容)当图片解码;nativeImage 解码失败/空图返回 ok=false 带 error。
  // 已知限制:GIF 经 nativeImage 只保留首帧 —— Windows 剪贴板位图无动画语义。
  registerHandle(
    COMMAND_CHANNELS.SYSTEM_CLIPBOARD_WRITE_IMAGE,
    (_e, envelope: CommandEnvelope<ClipboardWriteImagePayload>): ClipboardWriteImageResponse => {
      const dataUrl = envelope.payload?.dataUrl;
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
        return { ok: false, error: 'not an image dataUrl' };
      }
      try {
        const image = nativeImage.createFromDataURL(dataUrl);
        if (image.isEmpty()) {
          return { ok: false, error: 'image decoded empty (unsupported or corrupt data)' };
        }
        clipboard.writeImage(image);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: `nativeImage decode failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  );

  // Templates CRUD (CP-4 chunk 4)
  registerHandle(
    COMMAND_CHANNELS.TEMPLATE_ADD,
    (_e, envelope: CommandEnvelope<AddTemplatePayload>): AddTemplateResponse => {
      const t = templatesManager.add(envelope.payload);
      return { template: t };
    },
  );

  registerHandle(
    COMMAND_CHANNELS.TEMPLATE_UPDATE,
    (_e, envelope: CommandEnvelope<UpdateTemplatePayload>): UpdateTemplateResponse => {
      const t = templatesManager.update(envelope.payload.id, envelope.payload.partial);
      return { template: t };
    },
  );

  registerHandle(
    COMMAND_CHANNELS.TEMPLATE_DELETE,
    (_e, envelope: CommandEnvelope<DeleteTemplatePayload>): void => {
      templatesManager.delete(envelope.payload.id);
    },
  );

  registerHandle(
    COMMAND_CHANNELS.TEMPLATE_SET_DEFAULT,
    (_e, envelope: CommandEnvelope<SetDefaultTemplatePayload>): void => {
      templatesManager.setDefault(envelope.payload.id);
    },
  );

  // Settings export / import (CP-4 chunk 4)
  //
  // V1 折衷:导出/导入用单 JSON 文件而非 zip,避免引入 zip 库依赖。
  // 文档 6.6.2 描述为 zip,未来加 archiver 包可平滑升级。
  registerHandle(
    COMMAND_CHANNELS.SETTINGS_EXPORT,
    async (_e, _envelope: CommandEnvelope<undefined>): Promise<ExportSettingsResponse> => {
      const owner = requireLocalDialogOwner(_e, COMMAND_CHANNELS.SETTINGS_EXPORT);

      // M1-F:先弹隐私警告 — 模板可能含 API key (env);用户三选一:
      // 取消 / 仅导出公开字段(env 清空) / 完整导出(含敏感凭据)
      const tmpls = deps.templatesManager.list();
      const hasEnvKeys = tmpls.some((t) => t.env && Object.keys(t.env).length > 0);
      let includeSecrets = false;
      if (hasEnvKeys) {
        const askOptions: Electron.MessageBoxOptions = {
          type: 'warning',
          title: '导出敏感凭据?',
          message: '归档将包含启动模板里的环境变量,可能含 API key、token 等敏感凭据。',
          detail:
            '"仅公开字段":导出时清空所有模板的环境变量,适合分享。\n' +
            '"包含敏感凭据":完整导出,只在你信任的设备间转移时再用。',
          buttons: ['取消', '仅公开字段', '包含敏感凭据'],
          defaultId: 1,
          cancelId: 0,
        };
        const askRes = owner
          ? await dialog.showMessageBox(owner, askOptions)
          : await dialog.showMessageBox(askOptions);
        if (askRes.response === 0) return { filePath: null };
        includeSecrets = askRes.response === 2;
      } else {
        // 无敏感字段时不打扰
        includeSecrets = true;
      }

      const suffix = hasEnvKeys ? (includeSecrets ? '-with-secrets' : '-public') : '';
      const saveOptions: Electron.SaveDialogOptions = {
        title: '导出 Marina 配置',
        defaultPath: `marina-config-${formatDateForFilename(new Date())}${suffix}.json`,
        filters: [{ name: 'Marina Archive (JSON)', extensions: ['json'] }],
      };
      const result = owner
        ? await dialog.showSaveDialog(owner, saveOptions)
        : await dialog.showSaveDialog(saveOptions);
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

  registerHandle(
    COMMAND_CHANNELS.SETTINGS_IMPORT,
    async (_e, _envelope: CommandEnvelope<undefined>): Promise<ImportSettingsResponse> => {
      const owner = requireLocalDialogOwner(_e, COMMAND_CHANNELS.SETTINGS_IMPORT);
      const options: Electron.OpenDialogOptions = {
        title: '导入 Marina 配置',
        properties: ['openFile'],
        filters: [{ name: 'Marina Archive (JSON)', extensions: ['json'] }],
      };
      const result = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options);
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
      const confirmOptions: Electron.MessageBoxOptions = {
        type: 'warning',
        title: '确认导入',
        message: '导入将完全覆盖现有配置(收藏 / 最近 / 模板 / 设置)。',
        detail: '运行中的终端不会被关,继续后所有窗口立即看到新配置。是否继续?',
        buttons: ['取消', '继续导入'],
        defaultId: 0,
        cancelId: 0,
      };
      const confirmRes = owner
        ? await dialog.showMessageBox(owner, confirmOptions)
        : await dialog.showMessageBox(confirmOptions);
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
  const bookmarks = await readJson<{ paths: unknown[]; groups?: unknown[] }>('bookmarks.json', {
    paths: [],
  });
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
    // v0.3.3 ADR-025:导出带 groups(可能为 undefined,导入侧 validateGroupsArray 允许缺省→[])。
    // exactOptionalPropertyTypes 下不能直接写 groups: undefined,这里整体断言存档形状。
    bookmarks: (bookmarks.groups
      ? {
          paths: bookmarks.paths as SettingsArchiveV1['bookmarks']['paths'],
          groups: bookmarks.groups as SettingsArchiveV1['bookmarks']['groups'],
        }
      : {
          paths: bookmarks.paths as SettingsArchiveV1['bookmarks']['paths'],
        }) as SettingsArchiveV1['bookmarks'],
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
async function applyArchiveInMemory(deps: IpcLayerDeps, archive: SettingsArchiveV1): Promise<void> {
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
      // v0.3.3 ADR-025:旧归档无 groups → undefined → validateGroupsArray 不被调(留 [])。
      groups: archive.bookmarks.groups,
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

// ──────────────────────────────────────────────────────────────────
// File panel handlers (终端侧边文件预览面板)
// 这些 IPC 供 renderer UI 主动操作:拉列表(接管/claim 后初始化)、点 tab 切换、
// 关闭、读内容。终端程序经 HTTP 触发的 open/show/close 走 FilePanelService
// 内部,不经这些 IPC;两类入口共享 service 状态机,事件统一从
// 'filePanelUpdated' 出(见 wireEventBroadcasts)。
//
// H2(架构复核):这些命令携带文件绝对路径/内容,是「同账户数据外发」面。
// 非 owner 窗口即使知道 sessionId,也不应能读/改别的窗口正在操作的文件面板。
// 校验放在 IPC adapter 层(本函数),不进 FilePanelService 核心 —— 终端内 HTTP
// agent 在 session orphan 时仍应能 program-push 更新 main 真值,那类入口直接调
// FilePanelService、不经这些 IPC,故不受本校验影响。
// ──────────────────────────────────────────────────────────────────

/**
 * 校验 requester 是否为 session 的当前 owner(client 语义)。
 *
 * 与 FileTreeService.requireOwner 同语义:每个请求重查 owner,避免 session 被
 * 接管后旧窗口继续读取文件。错误用 makeIpcError 带 code,dispatchCommand 的
 * WS 路径与 ipcMain 本地路径都能拿到结构化错误(code/message)。
 *
 * @throws makeIpcError('SessionNotFound' | 'NotOwner')
 */
function requireFilePanelOwner(
  sessionManager: SessionManager,
  sessionId: string,
  requesterId: string,
): void {
  const session = sessionManager.get(sessionId);
  if (!session) {
    throw makeIpcError(
      'SessionNotFound',
      `file-panel 操作被拒绝: sessionId="${sessionId}" 不存在或已关闭。` +
        '可能原因: renderer 快照过期、session 已被销毁。刷新应用状态后再试。',
    );
  }
  if (session.ownerWindowId !== requesterId) {
    throw makeIpcError(
      'NotOwner',
      `file-panel 操作被拒绝: 当前窗口(client="${requesterId}")不是 ` +
        `sessionId="${sessionId}" 的 owner(实际 owner="${session.ownerWindowId}")。` +
        '请先接管该会话,或切换到 owner 窗口操作。',
    );
  }
}

function registerFilePanelHandlers(deps: IpcLayerDeps): void {
  const { filePanelService, sessionManager } = deps;

  /**
   * v0.3.3 ADR-036:命令面板输出来源的相对路径解析基准 = 指令**运行时** cwd
   * (CommandPanelService.getRunCwd 真值,终端 cd 后旧输出不漂移)。旧持久化
   * 快照没有 runCwd → 回退 session 当前 cwd;都取不到返回 undefined,由服务层
   * 报"missing path base"(renderer 显示错误占位/toast)。renderer 只传
   * commandKey,基准值全程 main 端真值,伪造不了。
   */
  const commandBaseDir = (sessionId: string, commandKey: string | undefined): string | undefined => {
    if (commandKey === undefined) return undefined;
    return (
      deps.commandPanelService.getRunCwd(sessionId, commandKey) ??
      sessionManager.get(sessionId)?.currentCwd ??
      undefined
    );
  };

  registerHandle(
    COMMAND_CHANNELS.FILE_PANEL_GET_OPEN_FILES,
    (_e, envelope: CommandEnvelope<GetOpenFilesPayload>): FilePanelSnapshot => {
      requireFilePanelOwner(sessionManager, envelope.payload.sessionId, envelope.windowId);
      return filePanelService.getOpenFiles(envelope.payload.sessionId);
    },
  );

  registerHandle(
    COMMAND_CHANNELS.FILE_PANEL_OPEN,
    async (_e, envelope: CommandEnvelope<OpenFilePanelPayload>): Promise<FilePanelSnapshot> => {
      requireFilePanelOwner(sessionManager, envelope.payload.sessionId, envelope.windowId);
      return filePanelService.openFile(envelope.payload.sessionId, envelope.payload.path, {
        expectedOwnerWindowId: envelope.windowId,
        ...(envelope.payload.heading === undefined ? {} : { heading: envelope.payload.heading }),
      });
    },
  );

  // v0.3.3 Feature B:markdown 文档里的本地文件链接 → 相对 md 目录解析进面板只读查看。
  // 与 FILE_PANEL_OPEN 的区别:解析基准是 mdPath 所在目录(文档作者视角),不是 currentCwd。
  // ADR-036:命令面板输出(mdPath 缺省 + commandKey)以运行时 cwd 为基准(openFileFromBase)。
  registerHandle(
    COMMAND_CHANNELS.FILE_PANEL_OPEN_PATH,
    async (
      _e,
      envelope: CommandEnvelope<OpenPathFromMarkdownPayload>,
    ): Promise<FilePanelSnapshot> => {
      requireFilePanelOwner(sessionManager, envelope.payload.sessionId, envelope.windowId);
      const { sessionId, mdPath, src, commandKey } = envelope.payload;
      if (mdPath !== undefined) {
        return filePanelService.openFileFromMarkdown(sessionId, mdPath, src);
      }
      const baseDir = commandBaseDir(sessionId, commandKey);
      if (baseDir === undefined) {
        throw makeIpcError(
          'ResolveFailed',
          '本地链接缺少解析基准:payload 需要 mdPath 或 commandKey 其一' +
            '(commandKey 需对应存在的指令且能取到运行时/当前 cwd)。',
        );
      }
      return filePanelService.openFileFromBase(sessionId, baseDir, src);
    },
  );

  // v0.3.3 ADR-035:markdown 文档里的 marina: 动作链接([x](marina:show a.md))
  // → 解析子命令后分发到 file-panel(show)/command-panel(run),与 CLI 同源
  // (marina-link-dispatch.ts)。owner 校验与其它面板操作一致;错误(含语法错)
  // 上抛,renderer MdLink 捕获后 toast。
  registerHandle(
    COMMAND_CHANNELS.MARINA_LINK_RUN,
    async (
      _e,
      envelope: CommandEnvelope<RunMarinaLinkPayload>,
    ): Promise<RunMarinaLinkResponse> => {
      requireFilePanelOwner(sessionManager, envelope.payload.sessionId, envelope.windowId);
      return dispatchMarinaLink(
        { filePanelService, commandPanelService: deps.commandPanelService },
        envelope.payload.sessionId,
        envelope.payload.mdPath,
        envelope.payload.href,
        envelope.windowId,
        envelope.payload.commandKey,
      );
    },
  );

  registerHandle(
    COMMAND_CHANNELS.FILE_PANEL_SHOW,
    (_e, envelope: CommandEnvelope<FilePanelActionPayload>): FilePanelSnapshot => {
      requireFilePanelOwner(sessionManager, envelope.payload.sessionId, envelope.windowId);
      return filePanelService.showFile(envelope.payload.sessionId, envelope.payload.path);
    },
  );

  registerHandle(
    COMMAND_CHANNELS.FILE_PANEL_CLOSE,
    (_e, envelope: CommandEnvelope<FilePanelActionPayload>): FilePanelSnapshot => {
      requireFilePanelOwner(sessionManager, envelope.payload.sessionId, envelope.windowId);
      return filePanelService.closeFile(envelope.payload.sessionId, envelope.payload.path);
    },
  );

  registerHandle(
    COMMAND_CHANNELS.FILE_PANEL_READ,
    async (_e, envelope: CommandEnvelope<ReadFilePayload>): Promise<ReadFileResponse> => {
      requireFilePanelOwner(sessionManager, envelope.payload.sessionId, envelope.windowId);
      return filePanelService.readFile(envelope.payload.sessionId, envelope.payload.path);
    },
  );

  registerHandle(
    COMMAND_CHANNELS.FILE_PANEL_READ_IMAGE,
    async (_e, envelope: CommandEnvelope<ReadImagePayload>): Promise<ReadImageResponse> => {
      requireFilePanelOwner(sessionManager, envelope.payload.sessionId, envelope.windowId);
      // ADR-036:命令面板输出来源无 mdPath,基准 = 运行时 cwd(commandBaseDir)。
      const { sessionId, mdPath, src, commandKey } = envelope.payload;
      return filePanelService.readImageAsset(
        sessionId,
        mdPath,
        src,
        mdPath !== undefined ? undefined : commandBaseDir(sessionId, commandKey),
      );
    },
  );

  // v0.3.3 Feature A(ADR-026):gallery 图片表。resolve-image 解析单图为 dataUrl
  // (本地图复用 read-image;网络图 daemon 下载缓存转 dataUrl 绕 CSP)。open-image
  // 在 main 端 resolve 绝对路径后 shell.openPath 调系统图片查看器(不把路径返 renderer)。
  registerHandle(
    COMMAND_CHANNELS.GALLERY_RESOLVE_IMAGE,
    async (
      _e,
      envelope: CommandEnvelope<GalleryResolveImagePayload>,
    ): Promise<GalleryResolveImageResponse> => {
      requireFilePanelOwner(sessionManager, envelope.payload.sessionId, envelope.windowId);
      const { sessionId, mdPath, src, commandKey } = envelope.payload;
      return filePanelService.resolveGalleryImage(
        sessionId,
        mdPath,
        src,
        mdPath !== undefined ? undefined : commandBaseDir(sessionId, commandKey),
      );
    },
  );
  registerHandle(
    COMMAND_CHANNELS.GALLERY_OPEN_IMAGE,
    async (
      _e,
      envelope: CommandEnvelope<GalleryOpenImagePayload>,
    ): Promise<GalleryOpenImageResponse> => {
      requireFilePanelOwner(sessionManager, envelope.payload.sessionId, envelope.windowId);
      const { sessionId, mdPath, src, commandKey } = envelope.payload;
      const r = await filePanelService.openGalleryImage(
        sessionId,
        mdPath,
        src,
        mdPath !== undefined ? undefined : commandBaseDir(sessionId, commandKey),
      );
      if ('error' in r) return r;
      // shell.openPath 返空串=成功打开,非空串=错误信息(OS 语义)。
      const openError = await shell.openPath(r.path);
      return openError ? { error: openError } : { ok: true };
    },
  );

  // v0.3.3 文档图片交互:在资源管理器中显示 markdown 引用的图片(markdown 正文
  // 内联图与 gallery 共用)。resolver 与 open-image 完全共用 —— openGalleryImage
  // 的真实语义是"resolve 这个 md 相对 src 到磁盘绝对路径给 shell 用",这里只是
  // 把 shell 动作从 openPath 换成 showItemInFolder,同样不把路径返给 renderer。
  registerHandle(
    COMMAND_CHANNELS.GALLERY_REVEAL_IMAGE,
    async (
      _e,
      envelope: CommandEnvelope<GalleryRevealImagePayload>,
    ): Promise<GalleryRevealImageResponse> => {
      requireFilePanelOwner(sessionManager, envelope.payload.sessionId, envelope.windowId);
      const { sessionId, mdPath, src, commandKey } = envelope.payload;
      const r = await filePanelService.openGalleryImage(
        sessionId,
        mdPath,
        src,
        mdPath !== undefined ? undefined : commandBaseDir(sessionId, commandKey),
      );
      if ('error' in r) return r;
      shell.showItemInFolder(r.path);
      return { ok: true };
    },
  );
}

// ──────────────────────────────────────────────────────────────────
// File tree handlers（ADR-016 双根只读导航）
//
// FileTreeService 在每个请求中同时校验 session owner 与 realpath 根包含关系；
// handler 只负责从 CommandEnvelope 传 client/window id，不能在这里“图省事”
// 改成无 owner 的普通 fs API。
// ──────────────────────────────────────────────────────────────────
function registerFileTreeHandlers(deps: IpcLayerDeps): void {
  const { fileTreeService, fileTreePollingService } = deps;

  registerHandle(
    COMMAND_CHANNELS.FILE_TREE_GET_ROOTS,
    async (
      _e,
      envelope: CommandEnvelope<GetFileTreeRootsPayload>,
    ): Promise<GetFileTreeRootsResponse> => ({
      roots: await fileTreeService.getRoots(envelope.payload.sessionId, envelope.windowId),
    }),
  );

  registerHandle(
    COMMAND_CHANNELS.FILE_TREE_LIST_DIRECTORY,
    async (
      _e,
      envelope: CommandEnvelope<ListFileTreeDirectoryPayload>,
    ): Promise<ListFileTreeDirectoryResponse> =>
      fileTreeService.listDirectory(
        envelope.payload.sessionId,
        envelope.windowId,
        envelope.payload.rootId,
        envelope.payload.relativePath ?? '',
      ),
  );

  registerHandle(
    COMMAND_CHANNELS.FILE_TREE_OPEN_FILE,
    async (_e, envelope: CommandEnvelope<OpenFileTreeFilePayload>): Promise<FilePanelSnapshot> =>
      fileTreeService.openFile(
        envelope.payload.sessionId,
        envelope.windowId,
        envelope.payload.rootId,
        envelope.payload.relativePath,
      ),
  );

  // v0.3.0:在系统文件管理器中定位树中选择的文件。与 open-file 同根校验,
  // 但不返回路径给 renderer —— 校验通过后由 main 端直接调 shell.showItemInFolder。
  registerHandle(
    COMMAND_CHANNELS.FILE_TREE_REVEAL_PATH,
    async (_e, envelope: CommandEnvelope<RevealFileTreePathPayload>): Promise<void> => {
      await fileTreeService.revealPath(
        envelope.payload.sessionId,
        envelope.windowId,
        envelope.payload.rootId,
        envelope.payload.relativePath,
      );
    },
  );

  // v0.3.2:用系统默认应用打开 file-tree 节点(对称 reveal-path,保持 rootId 抽象)。
  registerHandle(
    COMMAND_CHANNELS.FILE_TREE_OPEN_PATH,
    async (_e, envelope: CommandEnvelope<OpenFileTreePathPayload>): Promise<void> => {
      await fileTreeService.openPath(
        envelope.payload.sessionId,
        envelope.windowId,
        envelope.payload.rootId,
        envelope.payload.relativePath,
      );
    },
  );

  // v0.3.2:递归列全量 entries(扁平),供 renderer 搜索懒加载未展开的目录。
  registerHandle(
    COMMAND_CHANNELS.FILE_TREE_LIST_RECURSIVE,
    async (
      _e,
      envelope: CommandEnvelope<ListFileTreeRecursivePayload>,
    ): Promise<ListFileTreeRecursiveResponse> => {
      return fileTreeService.listRecursive(
        envelope.payload.sessionId,
        envelope.windowId,
        envelope.payload.rootId,
      );
    },
  );

  // ADR-021:文件树轮询 demand(HOT/NONE,与 git:set-polling-demand 同构)。
  // consumerId 只能取可信 envelope.windowId;绝不接受 renderer 自报 clientId。
  registerHandle(
    COMMAND_CHANNELS.FILE_TREE_SET_POLLING_DEMAND,
    (_e, envelope: CommandEnvelope<SetFileTreePollingDemandPayload>): void => {
      fileTreePollingService.setPollingDemand(
        envelope.payload.sessionId,
        envelope.windowId,
        envelope.payload.level,
      );
    },
  );

  // 面板上报当前展开目录集合(main 端轮询目标)。同样以 envelope.windowId
  // 为 consumerId;空数组 = 卸载清理,幂等。
  registerHandle(
    COMMAND_CHANNELS.FILE_TREE_SET_WATCHED_DIRS,
    (_e, envelope: CommandEnvelope<SetFileTreeWatchedDirsPayload>): void => {
      fileTreePollingService.setWatchedDirs(
        envelope.payload.sessionId,
        envelope.windowId,
        envelope.payload.dirs,
      );
    },
  );
}

// ──────────────────────────────────────────────────────────────────
// Git 域 (v0.3.0,ADR-017)。与 file-tree 域同构的安全模式;
// 仅 owner + 非 SSH + repoRoot 包含校验。只读:不调任何写 .git 的命令。
// ──────────────────────────────────────────────────────────────────
function registerGitHandlers(deps: IpcLayerDeps): void {
  const { gitService } = deps;

  registerHandle(
    COMMAND_CHANNELS.GIT_SET_POLLING_DEMAND,
    (_e, envelope: CommandEnvelope<SetGitPollingDemandPayload>): void => {
      // consumerId 只能取可信 envelope.windowId；绝不接受 renderer 自报 clientId。
      gitService.setPollingDemand(
        envelope.payload.sessionId,
        envelope.windowId,
        envelope.payload.level,
      );
    },
  );

  registerHandle(
    COMMAND_CHANNELS.GIT_GET_STATUS,
    async (_e, envelope: CommandEnvelope<GetGitStatusPayload>): Promise<GetGitStatusResponse> => {
      const result = await gitService.getStatus(envelope.payload.sessionId, envelope.windowId);
      // GitService 返回 {repoRoot, groups, truncated} 或 {unavailable}。
      // protocol 层不回传 repoRoot(避免泄露绝对路径给 renderer)。
      if ('unavailable' in result) return { unavailable: result.unavailable };
      return { groups: result.groups, truncated: result.truncated };
    },
  );

  registerHandle(
    COMMAND_CHANNELS.GIT_OPEN_DIFF,
    async (_e, envelope: CommandEnvelope<OpenGitDiffPayload>): Promise<FilePanelSnapshot> =>
      gitService.openDiff(
        envelope.payload.sessionId,
        envelope.windowId,
        envelope.payload.relativePath,
      ),
  );

  // v0.3.1 勘误:Git 面板右键「打开文件本身」+「复制绝对路径 / 在 Explorer 显示」。
  registerHandle(
    COMMAND_CHANNELS.GIT_OPEN_FILE,
    async (_e, envelope: CommandEnvelope<OpenGitFilePayload>): Promise<FilePanelSnapshot> =>
      gitService.openFile(
        envelope.payload.sessionId,
        envelope.windowId,
        envelope.payload.relativePath,
        envelope.payload.repoIdentity,
      ),
  );

  registerHandle(
    COMMAND_CHANNELS.GIT_RESOLVE_PATH,
    async (_e, envelope: CommandEnvelope<OpenGitFilePayload>): Promise<ResolveGitPathResponse> => {
      const absolutePath = await gitService.resolvePath(
        envelope.payload.sessionId,
        envelope.windowId,
        envelope.payload.relativePath,
      );
      return { absolutePath };
    },
  );
}

// ──────────────────────────────────────────────────────────────────
// Markdown 代码块执行域 (v0.3.3,ADR-023)。
// 直接 child_process.spawn 系统命令,不经 PTY。详见 code-block-runner.ts。
// ──────────────────────────────────────────────────────────────────
function registerCodeBlockHandlers(deps: IpcLayerDeps): void {
  const { codeBlockRunner } = deps;

  // envelope.windowId 即发起 client(本地窗口 = windowId,远程 = WS clientId),
  // 透传给 runner 作为 output/exited 事件的定向目标。
  registerHandle(
    COMMAND_CHANNELS.SYSTEM_RUN_CODE_BLOCK,
    async (_e, envelope: CommandEnvelope<RunCodeBlockPayload>): Promise<RunCodeBlockResponse> => {
      // run 是 async(需等待 detectShells 解析绝对路径);registerHandle 支持
      // Promise,成功 / 抛错都会正确回传 renderer。
      return codeBlockRunner.run({
        sourceSessionId: envelope.payload.sourceSessionId,
        language: envelope.payload.language,
        code: envelope.payload.code,
        requestingClientId: envelope.windowId,
        sudo: !!envelope.payload.sudo,
      });
    },
  );

  registerHandle(
    COMMAND_CHANNELS.SYSTEM_STOP_CODE_BLOCK,
    (_e, envelope: CommandEnvelope<StopCodeBlockPayload>): void => {
      codeBlockRunner.stop(envelope.payload.runId);
    },
  );
}

// ──────────────────────────────────────────────────────────────────
// 命令面板域 (v0.3.3,ADR-028 / Feature G)
// - AI 经 marina run / HTTP /run / IPC 推送任意命令字符串
// - 复用 codeBlockRunner 执行(bash),输出渲染 markdown 进第 4 面板
// - 多 tab + per-指令独立刷新策略(scope=前台/后台，interval=手动/5s/30s)
// 本层仅转发;执行/状态机测在 command-panel-service。
// ──────────────────────────────────────────────────────────────────
function registerCommandPanelHandlers(deps: IpcLayerDeps): void {
  const { commandPanelService } = deps;

  registerHandle(
    COMMAND_CHANNELS.COMMAND_PANEL_GET_STATE,
    (_e, envelope: CommandEnvelope<GetCommandPanelStatePayload>): CommandPanelSnapshot =>
      commandPanelService.getSnapshot(envelope.payload.sessionId),
  );

  // 推送/重跑一条指令。envelope.windowId 即发起 client,output/exited 事件定向回它
  // (复用 code-block-output,runId 一致)。SSH/cwd/shell 失败透传 CodeBlockError。
  // sudo:仅 SSH session 生效,renderer / HTTP /run 透传;sudo 密码缺失时 service 把
  // entry 置 awaiting-sudo-password,不抛。
  registerHandle(
    COMMAND_CHANNELS.COMMAND_PANEL_RUN,
    async (_e, envelope: CommandEnvelope<RunCommandPayload>): Promise<CommandPanelSnapshot> =>
      commandPanelService.runCommand(
        envelope.payload.sessionId,
        envelope.payload.command,
        envelope.payload.title ?? null,
        envelope.windowId,
        !!envelope.payload.sudo,
      ),
  );

  registerHandle(
    COMMAND_CHANNELS.COMMAND_PANEL_CLOSE,
    (_e, envelope: CommandEnvelope<CloseCommandPayload>): CommandPanelSnapshot =>
      commandPanelService.closeCommand(envelope.payload.sessionId, envelope.payload.commandKey),
  );

  registerHandle(
    COMMAND_CHANNELS.COMMAND_PANEL_SHOW,
    (_e, envelope: CommandEnvelope<ShowCommandPayload>): CommandPanelSnapshot =>
      commandPanelService.showCommand(envelope.payload.sessionId, envelope.payload.commandKey),
  );

  registerHandle(
    COMMAND_CHANNELS.COMMAND_PANEL_UPDATE_REFRESH_POLICY,
    (_e, envelope: CommandEnvelope<UpdateCommandRefreshPolicyPayload>): CommandPanelSnapshot =>
      commandPanelService.updateRefreshPolicy(
        envelope.payload.sessionId,
        envelope.payload.commandKey,
        envelope.payload.patch,
      ),
  );

  // renderer 上报面板 demand(可见性/聚焦 → HOT/WARM/NONE)。与 git:set-polling-demand
  // 同策略:驱动 BackgroundWorkScheduler 的 per-指令 后台 task。
  registerHandle(
    COMMAND_CHANNELS.COMMAND_PANEL_SET_DEMAND,
    (_e, envelope: CommandEnvelope<SetCommandDemandPayload>): void => {
      commandPanelService.setDemand(
        envelope.payload.sessionId,
        envelope.windowId,
        envelope.payload.level,
      );
    },
  );
}

// ──────────────────────────────────────────────────────────────────
// Markdown 主题域 (Typora 式可扩展)
// - 拉主题列表(设置页下拉 + 启动初始化)
// - 取某主题 CSS 文本(注入 <style>)
// - 打开主题目录(放/编辑 .css)
// 增删 .css 由 manager 的 fs.watch 自动发现,经 wireEventBroadcasts 广播。
// ──────────────────────────────────────────────────────────────────
function registerMdThemeHandlers(deps: IpcLayerDeps): void {
  const { markdownThemeManager } = deps;

  registerHandle(
    COMMAND_CHANNELS.MD_THEME_LIST,
    async (): Promise<ListMdThemesResponse> => ({ themes: await markdownThemeManager.list() }),
  );

  registerHandle(
    COMMAND_CHANNELS.MD_THEME_GET_CSS,
    async (_e, envelope: CommandEnvelope<GetMdThemeCssPayload>): Promise<GetMdThemeCssResponse> => {
      // 按 id 反查 fileName(用户传的是 custom:sepia 这种稳定 id,不是磁盘名)。
      const hit = (await markdownThemeManager.list()).find((t) => t.id === envelope.payload.id);
      // 找不到(用户刚删了该主题文件)→ 返回空 css,renderer 清空 <style> 并
      // fallback 到 auto。这是正常竞态,不报错。
      if (!hit) return { css: '' };
      try {
        return { css: await markdownThemeManager.readCss(hit.fileName) };
      } catch (err) {
        logger.warn(
          'MdTheme',
          `readCss failed for ${hit.fileName}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { css: '' };
      }
    },
  );

  registerHandle(
    COMMAND_CHANNELS.MD_THEME_OPEN_DIR,
    async (_e, _envelope: CommandEnvelope<undefined>): Promise<void> => {
      // 复用 SYSTEM_OPEN_LOGS_DIR 范式:先确保目录存在(并补种预置)再打开。
      try {
        await markdownThemeManager.ensureFirstRun();
      } catch {
        /* ensureFirstRun 内部已 try/catch + log,这里再吞一次保证打开 */
      }
      await shell.openPath(markdownThemeManager.getDir());
    },
  );
}

// ──────────────────────────────────────────────────────────────────
// Sudo 密码域 (v0.3.3 远程 sudo)。
// 内存态密钥托管(按 SSH profile 隔离)。set/clear/has IPC + changed 广播。
// 密码本身永不过 IPC 返回;has/state 只回 boolean(附录 H 隐私红线)。
// ──────────────────────────────────────────────────────────────────
function registerSudoPasswordHandlers(deps: IpcLayerDeps): void {
  const { sudoPasswordStore } = deps;

  // 录入密码(masked 输入 → main 内存,绝不落盘)。空串=清除(与 store.set 语义一致)。
  registerHandle(
    COMMAND_CHANNELS.SUDO_PASSWORD_SET,
    (_e, envelope: CommandEnvelope<SudoPasswordSetPayload>): { ok: true } => {
      sudoPasswordStore.set(envelope.payload.sshProfileId, envelope.payload.password);
      return { ok: true };
    },
  );

  // 清除密码(「忘记密码」按钮 / 切换 profile 时主动失效)。
  registerHandle(
    COMMAND_CHANNELS.SUDO_PASSWORD_CLEAR,
    (_e, envelope: CommandEnvelope<SudoPasswordClearPayload>): { ok: true } => {
      sudoPasswordStore.clear(envelope.payload.sshProfileId);
      return { ok: true };
    },
  );

  // 查询是否已存密码(只回 boolean,renderer 据此显 🔑 按钮态)。
  registerHandle(
    COMMAND_CHANNELS.SUDO_PASSWORD_HAS,
    (_e, envelope: CommandEnvelope<SudoPasswordHasPayload>): SudoPasswordStatePayload => ({
      sshProfileId: envelope.payload.sshProfileId,
      has: sudoPasswordStore.has(envelope.payload.sshProfileId),
    }),
  );

  // 密码状态变化(录入/清除)→ 广播给所有 client(密码状态是 per-profile,任何窗口
  // 可能显示该 profile 的 session,都需更新 🔑 按钮态)。payload 只含 boolean。
  sudoPasswordStore.on('changed', (sshProfileId, has) => {
    broadcastEvent(EVENT_CHANNELS.SUDO_PASSWORD_STATE, { sshProfileId, has });
  });
}

function wireEventBroadcasts(deps: IpcLayerDeps): void {
  // v2.0 远程服务端状态变化 → 广播给所有 client(本地窗口 + 远程 WS)
  if (deps.remoteDaemonController) {
    deps.remoteDaemonController.onStatusChange = (status) =>
      broadcastEvent(EVENT_CHANNELS.REMOTE_DAEMON_STATUS_CHANGED, {
        ...status,
        // controller 停止时 currentPort=null；本地设置页仍需显示配置端口。
        port: status.port ?? deps.settingsManager.get().remoteDaemon.port,
      });
  }
  const {
    windowManager,
    pathManager,
    settingsManager,
    sessionManager,
    sshProfileManager,
    remoteProfileManager,
    templatesManager,
    filePanelService,
    gitService,
    fileTreePollingService,
    markdownThemeManager,
    codeBlockRunner,
    commandPanelService,
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
    broadcastEvent<SshProfilesUpdatedPayload>(EVENT_CHANNELS.SSH_PROFILES_UPDATED, e);
  });

  // 远程后端:profile 列表变化 → 广播给所有窗口(刷 UI)。
  // 不再有"全局 active 变化"(每窗口后端模型,active 已废,切换后端=开新窗口)。
  remoteProfileManager?.on('changed', () => {
    broadcastEvent(EVENT_CHANNELS.REMOTE_PROFILES_UPDATED, {
      profiles: remoteProfileManager.list(),
    });
  });

  // 设置变化 → 广播 evt:settings:changed
  settingsManager.on('settingsChanged', (e: { settings: Settings; changedKeys: string[] }) => {
    broadcastEvent<SettingsChangedPayload>(EVENT_CHANNELS.SETTINGS_CHANGED, {
      settings: e.settings,
      changedKeys: e.changedKeys,
    });
    // 外观归属客户端:appearance 变化时额外广播 local-control 事件,让远程窗口
    // 实时同步本机外观。本地窗口已通过上面的 SETTINGS_CHANGED 更新,会忽略本
    // 事件(见 store 的 on 分支),避免双重刷新。只在 appearance.* 变更时发。
    if (e.changedKeys.some((k) => k.startsWith('appearance.'))) {
      broadcastEvent<LocalAppearanceChangedPayload>(
        EVENT_CHANNELS.SETTINGS_LOCAL_APPEARANCE_CHANGED,
        { appearance: e.settings.appearance },
      );
    }
  });

  // Session 事件
  sessionManager.on('sessionCreated', (session) => {
    broadcastEvent<SessionCreatedPayload>(EVENT_CHANNELS.SESSION_CREATED, { session });
    broadcastAppState(deps);
  });

  sessionManager.on('sessionOwnerChanged', (e: SessionOwnerChangedPayload) => {
    // service 清理(git/fileTree/commandPanel 的 demand 重报)由
    // RuntimeLifecycleCoordinator 统一分发(M1),这里只广播给窗口。
    broadcastEvent<SessionOwnerChangedPayload>(EVENT_CHANNELS.SESSION_OWNER_CHANGED, e);
  });

  // CP-3: state-changed 涵盖 active/idle 转移、currentCwd 更新、exited 状态。
  // SessionExitedPayload 仍单独发,因为它带 exitCode 等额外信息。
  sessionManager.on('sessionStateChanged', (e: SessionStateChangedPayload) => {
    broadcastEvent<SessionStateChangedPayload>(EVENT_CHANNELS.SESSION_STATE_CHANGED, e);
    // active/idle 转移可能影响 trayManager 的图标 (V1.1),广播 app state
    broadcastAppState(deps);
  });

  sessionManager.on('sessionExited', (e: SessionExitedPayload) => {
    // service 清理(停 git watcher / 文件树轮询,ADR-008 防 exited session 永久扫描)
    // 由 RuntimeLifecycleCoordinator 统一分发(M1),这里只广播给窗口。
    broadcastEvent<SessionExitedPayload>(EVENT_CHANNELS.SESSION_EXITED, e);
  });

  // 模板变化 (CP-3: 用户改默认模板 / CP-4: CRUD 自定义模板)
  templatesManager.on(
    'templatesUpdated',
    (e: { templates: Template[]; defaultTemplateId: string }) => {
      broadcastEvent<TemplateListUpdatedPayload>(EVENT_CHANNELS.TEMPLATES_UPDATED, e);
    },
  );

  sessionManager.on('sessionDestroyed', (e: SessionDestroyedPayload) => {
    // service 清理(terminalView/codeBlock/filePanel/git/fileTree/commandPanel/
    // workspace/pi 的资源回收)由 RuntimeLifecycleCoordinator 统一分发(M1),
    // 这里只广播给窗口 + 刷 app state。
    broadcastEvent<SessionDestroyedPayload>(EVENT_CHANNELS.SESSION_DESTROYED, e);
    broadcastAppState(deps);
  });

  // 终端侧边文件面板状态变化(REST open/show/close 或 fs.watch 自动刷新触发)
  // → 广播给所有窗口。
  //
  // 为什么广播而不是「仅推 owner」(与 session output 不同):面板状态是
  // per-session 元数据,用户切到别的终端时该 session 会变 orphan
  // (ownerWindowId=null,见 SessionManager.claimOwner → releaseAllOwnedBy),
  // 但它的面板状态变更必须持续更新 —— 否则 orphan 期间的更新被「无 owner
  // 即丢弃」吞掉,用户下次切回该终端看到的还是旧面板(开发者反馈)。PTY
  // 字节流(session output)才需要定向给 owner:数据量大且只有 owner 的 xterm
  // 渲染它。面板/git 这类小元数据广播给所有窗口无副作用(各自存进 per-session
  // map,不显示就不读)。
  filePanelService.on('filePanelUpdated', (p: FilePanelUpdatedPayload) => {
    broadcastEvent<FilePanelUpdatedPayload>(EVENT_CHANNELS.FILE_PANEL_UPDATED, p);
  });

  // heading 是一次性 view intent，不可跟可重放的 filePanelUpdated 一起广播。
  // 只在请求发生时定向给 owner；watcher/workspace restore 永远不会重放它。
  filePanelService.on('filePanelNavigationRequested', (p: FilePanelHeadingNavigationPayload) => {
    const ownerClientId = sessionManager.get(p.sessionId)?.ownerWindowId;
    if (!ownerClientId) return;
    sendEventTo<FilePanelHeadingNavigationPayload>(
      ownerClientId,
      EVENT_CHANNELS.FILE_PANEL_HEADING_NAVIGATION_REQUESTED,
      p,
    );
  });

  // v0.3.3 Feature D:workspace 切换完成(bind switched / new)。FilePanelService
  // .onWorkspaceSwitched 已重建 PanelState 并 emit filePanelUpdated(同步 openedFiles/
  // activePath);本事件让 renderer 调 restoreWorkspaceSnapshot 恢复 scroll/runs
  // (main PanelState 不存这俩)。payload={sessionId}。
  filePanelService.on('workspaceChanged', (p: { sessionId: string }) => {
    broadcastEvent<{ sessionId: string }>(EVENT_CHANNELS.WORKSPACE_CHANGED, p);
  });

  // v0.3.3 命令面板包含任意 shell 命令与输出，只能发给当前 session owner。
  // orphan 期间不推事件也不丢真值：CommandPanelService 持有完整状态，下一 owner
  // 挂载时 cmd:command-panel:get-state 会补拉。requestActivation 也绝不能广播，
  // 否则无关窗口会被一条别人的 program-push 抢走当前面板。
  deps.commandPanelService.on('commandPanelUpdated', (p: CommandPanelUpdateEvent) => {
    const ownerClientId = sessionManager.get(p.sessionId)?.ownerWindowId;
    if (!ownerClientId) return;
    sendEventTo<CommandPanelUpdatedPayload>(ownerClientId, EVENT_CHANNELS.COMMAND_PANEL_UPDATED, {
      sessionId: p.sessionId,
      ...p.snapshot,
      requestActivation: p.requestActivation,
    });
  });

  // v0.3.3:Markdown 代码块执行的 stdout/stderr 与退出按发起 client 定向发送。
  // CommandPanel 也复用同一 runner，但它的命令/输出属于 session owner：服务层累积后
  // 只发 owner-only snapshot，绝不能再沿原 clientId 把流式内容泄漏给已转移的旧 owner。
  codeBlockRunner.on('output', (e: CodeBlockOutputPayload & { clientId: string }) => {
    if (commandPanelService.isCommandPanelRun(e.runId)) return;
    sendEventTo(e.clientId, EVENT_CHANNELS.CODE_BLOCK_OUTPUT, {
      runId: e.runId,
      stream: e.stream,
      data: e.data,
    } satisfies CodeBlockOutputPayload);
  });
  codeBlockRunner.on('exited', (e: CodeBlockExitedPayload & { clientId: string }) => {
    if (commandPanelService.isCommandPanelRun(e.runId)) return;
    sendEventTo(e.clientId, EVENT_CHANNELS.CODE_BLOCK_EXITED, {
      runId: e.runId,
      exitCode: e.exitCode,
      signal: e.signal,
    } satisfies CodeBlockExitedPayload);
  });

  // v0.3.0:Git 面板状态变化。两路触发:
  //  (1) 预取:SessionManager 检测到 cwd 进仓库(flip available)→ GitService.prefetchStatus
  //      → 拉 status → emit(填 renderer 缓存,消除面板切换延迟)
  //  (2) ADR-021 demand-aware task:HOT 3s / WARM 60s → 重拉 status → emit
  // payload 带 snapshot(已 strip repoRoot),renderer 收到零额外 IPC 直填缓存。
  // 策略与 file-panel 同:广播给所有窗口(非 owner 定向)。理由见上 file-panel 注释
  // —— orphan 期间的 git 状态变更也必须送达,否则切回终端看到旧 diff 计数/列表。
  gitService.on('gitStatusUpdated', (p: GitStatusUpdatedPayload) => {
    broadcastEvent<GitStatusUpdatedPayload>(EVENT_CHANNELS.GIT_STATUS_UPDATED, p);
  });

  // 文件树目录列表变化:FileTreePollingService(demand-aware task)轮询并 diff 后
  // 广播。renderer 收到带完整快照,零额外 IPC 直填目录缓存(与 gitStatusUpdated
  // 同策略:小元数据广播给所有窗口无副作用,各窗口按 sessionId 过滤)。
  fileTreePollingService.on('fileTreeChanged', (p: FileTreeChangedPayload) => {
    broadcastEvent<FileTreeChangedPayload>(EVENT_CHANNELS.FILE_TREE_CHANGED, p);
  });

  // 自定义 markdown 主题列表变化(用户往 markdown-themes/ 增删 .css)→ 广播给
  // 所有窗口,renderer 更新设置页下拉。每次 emit 已做去抖 + 内容比对。
  markdownThemeManager.on('listUpdated', (themes: MdTheme[]) => {
    broadcastEvent<MdThemeListUpdatedPayload>(EVENT_CHANNELS.MD_THEME_LIST_UPDATED, { themes });
  });

  // Session output → interactive owner 或唯一的 parked TerminalView。
  // parked view 只维持 xterm 渲染状态,没有 input/resize 权限；每 session 最多
  // 一个目标,绝不广播。owner 属于其他 client 时 registry 会把旧 view 标记断流。
  sessionManager.on('sessionOutput', (payload: SessionOutputPayload) => {
    const session = sessionManager.get(payload.sessionId);
    if (!session) return;
    const targetClientId = deps.terminalViewRegistry.resolveOutputTarget(
      payload.sessionId,
      session.ownerWindowId,
    );
    if (!targetClientId) return; // 无 owner/view:只保留 main headless 真值
    // 0.3.2 性能诊断:把 renderer 终端字节流的 IPC 发送记为一个 operation。这是
    // 远程/重负载场景的**背压信号**——sendEventTo 同步序列化 base64 payload +
    // 拷贝给 renderer,若 renderer(xterm 解析/GC)跟不上,该调用变慢会卡住 main
    // 事件循环,体现为 operation duration 上升,且 stall 的 activeOperations 里
    // 会出现本操作(此前 stall 全显示“活跃操作:无”就是这个盲点)。
    // 低开销:只在聚合点(8ms/窗口)记录,非逐字节;begin/finish 是 Map 查找 + now()。
    const finish = performanceMetrics.begin('pty.sessionOutputDispatch');
    try {
      sendEventTo<SessionOutputPayload>(targetClientId, EVENT_CHANNELS.SESSION_OUTPUT, payload);
    } finally {
      finish();
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
    // 先撤销该 consumer 的全部 demand，再 release owner；两条路径都幂等。
    gitService.removePollingConsumer(windowId);
    fileTreePollingService.removePollingConsumer(windowId);
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
    remoteBackendProfiles: deps.remoteProfileManager?.list() ?? [],
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

function makeIpcError(code: string, message: string, details?: Record<string, unknown>): IpcError {
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

// v0.3.3 ADR-024 / Feature D:workspace 域 IPC handler(renderer 快照同步 +
// workspace 操作)。CLI 走 HTTP(/workspace*),renderer 走这些 IPC。
// M2:编排全部委托给 SessionWorkspaceCoordinator(它维护 session↔workspaceId
// 绑定 + pathScope)。
function registerWorkspaceHandlers(deps: IpcLayerDeps): void {
  const { workspaceCoordinator } = deps;

  // 查当前 session 绑定的 workspace 绝对路径。
  registerHandle(
    COMMAND_CHANNELS.WORKSPACE_GET_CURRENT,
    (_e, envelope: CommandEnvelope<{ sessionId: string }>): { path: string | null } => {
      return { path: workspaceCoordinator.getWorkspacePathForSession(envelope.payload.sessionId) };
    },
  );

  // 列当前 session pathScope 下的命名 workspace。
  registerHandle(
    COMMAND_CHANNELS.WORKSPACE_LIST,
    async (
      _e,
      envelope: CommandEnvelope<{ sessionId: string }>,
    ): Promise<{ items: WorkspaceSummary[] }> => {
      const items = await workspaceCoordinator.listWorkspaces(envelope.payload.sessionId);
      return { items };
    },
  );

  // bind = upsert。
  registerHandle(
    COMMAND_CHANNELS.WORKSPACE_BIND,
    async (
      _e,
      envelope: CommandEnvelope<{ sessionId: string; name: string; new?: boolean }>,
    ): Promise<WorkspaceBindResult> => {
      return workspaceCoordinator.bindWorkspace(
        envelope.payload.sessionId,
        envelope.payload.name,
        envelope.payload.new === true,
      );
    },
  );

  // 切回新空临时 workspace。
  registerHandle(
    COMMAND_CHANNELS.WORKSPACE_NEW,
    async (
      _e,
      envelope: CommandEnvelope<{ sessionId: string }>,
    ): Promise<{ workspaceId: string; dir: string }> => {
      return workspaceCoordinator.switchToNewWorkspace(envelope.payload.sessionId);
    },
  );

  // unpin(name 省略=当前绑定 workspace)。
  registerHandle(
    COMMAND_CHANNELS.WORKSPACE_UNPIN,
    async (
      _e,
      envelope: CommandEnvelope<{ sessionId: string; name?: string | null }>,
    ): Promise<{ workspaceId: string } | null> => {
      return workspaceCoordinator.unpinWorkspace(
        envelope.payload.sessionId,
        envelope.payload.name ?? null,
      );
    },
  );

  // 读当前 session 绑定 workspace 的文件面板快照(bind 恢复用)。
  registerHandle(
    COMMAND_CHANNELS.WORKSPACE_READ_SNAPSHOT,
    async (
      _e,
      envelope: CommandEnvelope<{ sessionId: string }>,
    ): Promise<{ snapshot: WorkspaceFilePanelSnapshot | null }> => {
      const snap = await workspaceCoordinator.readWorkspaceSnapshot(envelope.payload.sessionId);
      return { snapshot: (snap as WorkspaceFilePanelSnapshot | null) ?? null };
    },
  );

  // 写当前 session 绑定 workspace 的文件面板快照(renderer debounce 触发)。
  registerHandle(
    COMMAND_CHANNELS.WORKSPACE_WRITE_SNAPSHOT,
    async (
      _e,
      envelope: CommandEnvelope<{ sessionId: string; snapshot: WorkspaceFilePanelSnapshot }>,
    ): Promise<void> => {
      await workspaceCoordinator.writeWorkspaceSnapshot(
        envelope.payload.sessionId,
        envelope.payload.snapshot,
      );
    },
  );
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
