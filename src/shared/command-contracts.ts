/**
 * @file command-contracts.ts
 * @purpose IPC 命令契约的 single source of truth:把每个 COMMAND_CHANNELS 字面量
 *          映射到它的 { payload, response } 类型,让 invoke / registerHandle 自动推导,
 *          消除 renderer 与 main 端各自手写泛型、channel 退化为裸 string 的散落。
 *
 * @关键设计:
 * - CommandContractMap 的键是 COMMAND_CHANNELS 的字面量值(如 'app:get-protocol-version'),
 *   不是 string。因此 invoke(channel, ...) 的 channel 在编译期就被收窄为合法命令,
 *   传错 channel(拼写错误 / 已废弃命令)直接 typecheck 报错。
 * - payload / response 类型从映射推导:invoke<K>(channel, payload) 的 payload 类型是
 *   CommandContractMap[K]['payload'],返回 Promise<CommandContractMap[K]['response']>。
 *   renderer 不再需要手写 window.api.invoke<Payload, Response>(...),也消除了
 *   "renderer 写的类型和 main handler 实际类型不一致"这类 typecheck 抓不到的漂移。
 * - 纯类型模块:这里只有 interface,没有任何运行时值。运行时校验(zod / 手写 schema)
 *   刻意不加(见 AGENTS §9 不引入新依赖;payload 结构校验留给 handler 内部)。
 * - 事件广播(webContents.send 的单向推送)不进本映射:它们没有 invoke/response 语义,
 *   走各自的 EVENT_CHANNELS 类型。本映射只覆盖 request/response 的命令。
 *
 * @对应文档:架构整改 H3(CommandContractMap);软件定义书 IPC 协议章节
 *
 * @不要在这里做的事:
 * - 不要加运行时 schema 校验(那是 handler 的职责,且不引入 zod 依赖)
 * - 不要把事件通道塞进来(它们无 response 语义)
 * - 不要让键退化为 string(收窄为字面量是本文件的核心价值)
 */

import type { COMMAND_CHANNELS } from './protocol';

// Payload 类型(handler 输入)
import type {
  GetSnapshotPayload,
  QuitPayload,
  CreateWindowPayload,
  FocusWindowPayload,
  CreateSessionPayload,
  CloseSessionPayload,
  ReorderSessionsPayload,
  UpdateSessionUiLayoutPayload,
  ClaimSessionPayload,
  TakeoverSessionPayload,
  GetScrollbackPayload,
  AttachTerminalViewPayload,
  DetachTerminalViewPayload,
  ReleaseSessionPayload,
  OpenSessionInNewWindowPayload,
  FocusSessionOwnerPayload,
  SendInputPayload,
  ResizeSessionPayload,
  AddBookmarkPayload,
  RemoveBookmarkPayload,
  RenameBookmarkPayload,
  ReorderBookmarksPayload,
  AddBookmarkGroupPayload,
  RenameBookmarkGroupPayload,
  RemoveBookmarkGroupPayload,
  SetDefaultTemplateForBookmarkPayload,
  PickFolderPayload,
  ListDirectoryPickerPayload,
  RemoveFromRecentPayload,
  InstallMarinaSkillPayload,
  PiBridgeInstallPayload,
  AddSshProfilePayload,
  UpdateSshProfilePayload,
  PickSshKeyFilePayload,
  DeleteSshProfilePayload,
  AddRemoteProfilePayload,
  UpdateRemoteProfilePayload,
  DeleteRemoteProfilePayload,
  GetRemoteConnectionPayload,
  RemoteDaemonSetPortPayload,
  RemoteDaemonSetPasswordPayload,
  TestSshProfilePayload,
  AddRemoteBookmarkPayload,
  UpdateSettingsPayload,
  UpdateAppearanceSettingsPayload,
  ShowInExplorerPayload,
  OpenPathPayload,
  ImeProbeDumpPayload,
  OpenExternalPayload,
  ClipboardWriteTextPayload,
  AddTemplatePayload,
  UpdateTemplatePayload,
  DeleteTemplatePayload,
  SetDefaultTemplatePayload,
  GetOpenFilesPayload,
  FilePanelActionPayload,
  OpenFilePanelPayload,
  OpenPathFromMarkdownPayload,
  ReadFilePayload,
  ReadImagePayload,
  GalleryResolveImagePayload,
  GalleryOpenImagePayload,
  GetFileTreeRootsPayload,
  ListFileTreeDirectoryPayload,
  OpenFileTreeFilePayload,
  RevealFileTreePathPayload,
  OpenFileTreePathPayload,
  ListFileTreeRecursivePayload,
  SetFileTreePollingDemandPayload,
  SetFileTreeWatchedDirsPayload,
  SetGitPollingDemandPayload,
  GetGitStatusPayload,
  OpenGitDiffPayload,
  OpenGitFilePayload,
  RunCodeBlockPayload,
  StopCodeBlockPayload,
  GetCommandPanelStatePayload,
  RunCommandPayload,
  CloseCommandPayload,
  ShowCommandPayload,
  UpdateCommandRefreshPolicyPayload,
  SetCommandDemandPayload,
  SudoPasswordSetPayload,
  SudoPasswordClearPayload,
  SudoPasswordHasPayload,
  SudoPasswordStatePayload,
  GetMdThemeCssPayload,
  CaptureCpuProfilePayload,
} from './protocol';

// Response 类型(handler 输出)
import type {
  GetProtocolVersionResponse,
  GetSnapshotResponse,
  QuitResponse,
  CreateWindowResponse,
  CreateSessionResponse,
  ClaimSessionResponse,
  TakeoverSessionResponse,
  GetScrollbackResponse,
  AttachTerminalViewResponse,
  OpenSessionInNewWindowResponse,
  SendInputResponse,
  ResizeSessionResponse,
  AddBookmarkResponse,
  AddBookmarkGroupResponse,
  PickFolderResponse,
  ListDirectoryPickerResponse,
  InstallMarinaSkillResponse,
  PiBridgeInstallResponse,
  PiBridgeStatusResponse,
  ListSshProfilesResponse,
  AddSshProfileResponse,
  UpdateSshProfileResponse,
  PickSshKeyFileResponse,
  ListRemoteProfilesResponse,
  AddRemoteProfileResponse,
  UpdateRemoteProfileResponse,
  GetRemoteConnectionResponse,
  RemoteDaemonStatusResponse,
  TestSshProfileResponse,
  SshConfigListResponse,
  SshAgentStatusResponse,
  KnownHostsRefreshResponse,
  GetSettingsResponse,
  GetAppearanceSettingsResponse,
  ListShellsResponse,
  GetAutoStartResponse,
  ClipboardReadTextResponse,
  ClipboardWriteTextResponse,
  AddTemplateResponse,
  UpdateTemplateResponse,
  ExportSettingsResponse,
  ImportSettingsResponse,
  FilePanelSnapshot,
  ReadFileResponse,
  ReadImageResponse,
  GalleryResolveImageResponse,
  GalleryOpenImageResponse,
  GetFileTreeRootsResponse,
  ListFileTreeDirectoryResponse,
  ListFileTreeRecursiveResponse,
  GetGitStatusResponse,
  ResolveGitPathResponse,
  RunCodeBlockResponse,
  CommandPanelSnapshot,
  ListMdThemesResponse,
  GetMdThemeCssResponse,
  WorkspaceSummary,
  WorkspaceBindResult,
  WorkspaceFilePanelSnapshot,
  PerformanceStatus,
  CaptureCpuProfileResponse,
  ImeProbeDumpResponse,
  ExplorerIntegrationStatus,
  GetPsCommandsResponse,
} from './protocol';

/**
 * 命令契约映射。键是 COMMAND_CHANNELS 的字面量值,值是该命令的 { payload, response }。
 *
 * 维护纪律:新增 IPC 命令时,必须在此映射登记对应的 payload/response 类型,
 * 否则 invoke / registerHandle 的类型推导会退化为 unknown。映射与 ipc.ts 的
 * registerHandle 标注由 typecheck 双向校验(不一致即编译失败)。
 */
export interface CommandContractMap {
  // ── App ──────────────────────────────────────────────────────────────────
  [COMMAND_CHANNELS.APP_GET_PROTOCOL_VERSION]: {
    payload: undefined;
    response: GetProtocolVersionResponse;
  };
  [COMMAND_CHANNELS.APP_GET_SNAPSHOT]: {
    payload: GetSnapshotPayload;
    response: GetSnapshotResponse;
  };
  [COMMAND_CHANNELS.APP_QUIT]: { payload: QuitPayload; response: QuitResponse };

  // ── Window ────────────────────────────────────────────────────────────────
  [COMMAND_CHANNELS.WINDOW_CREATE]: {
    payload: CreateWindowPayload;
    response: CreateWindowResponse;
  };
  [COMMAND_CHANNELS.WINDOW_CLOSE_SELF]: { payload: undefined; response: void };
  [COMMAND_CHANNELS.WINDOW_CLOSE_ALL]: { payload: undefined; response: void };
  [COMMAND_CHANNELS.WINDOW_MINIMIZE]: { payload: undefined; response: void };
  [COMMAND_CHANNELS.WINDOW_TOGGLE_MAXIMIZE]: { payload: undefined; response: void };
  [COMMAND_CHANNELS.WINDOW_GET_MAX_STATE]: {
    payload: undefined;
    response: { maximized: boolean };
  };
  [COMMAND_CHANNELS.WINDOW_FOCUS]: { payload: FocusWindowPayload; response: void };

  // ── Session ───────────────────────────────────────────────────────────────
  [COMMAND_CHANNELS.SESSION_CREATE]: {
    payload: CreateSessionPayload;
    response: CreateSessionResponse;
  };
  [COMMAND_CHANNELS.SESSION_CLOSE]: { payload: CloseSessionPayload; response: void };
  [COMMAND_CHANNELS.SESSION_RENAME]: {
    payload: { sessionId: string; newDisplayName: string };
    response: void;
  };
  [COMMAND_CHANNELS.SESSION_CLEAR_MANUAL_RENAME]: {
    payload: { sessionId: string };
    response: void;
  };
  [COMMAND_CHANNELS.SESSION_REORDER]: { payload: ReorderSessionsPayload; response: void };
  [COMMAND_CHANNELS.SESSION_UPDATE_UI_LAYOUT]: {
    payload: UpdateSessionUiLayoutPayload;
    response: void;
  };
  [COMMAND_CHANNELS.SESSION_MARK_VIEWED]: { payload: { sessionId: string }; response: void };
  [COMMAND_CHANNELS.SESSION_CLAIM]: {
    payload: ClaimSessionPayload;
    response: ClaimSessionResponse;
  };
  /** v0.3.3 右键「占用此终端」:显式强占(他人持有时也成功,与 claim 的区别点)。 */
  [COMMAND_CHANNELS.SESSION_TAKEOVER]: {
    payload: TakeoverSessionPayload;
    response: TakeoverSessionResponse;
  };
  [COMMAND_CHANNELS.SESSION_GET_SCROLLBACK]: {
    payload: GetScrollbackPayload;
    response: GetScrollbackResponse;
  };
  [COMMAND_CHANNELS.SESSION_ATTACH_TERMINAL_VIEW]: {
    payload: AttachTerminalViewPayload;
    response: AttachTerminalViewResponse;
  };
  [COMMAND_CHANNELS.SESSION_DETACH_TERMINAL_VIEW]: {
    payload: DetachTerminalViewPayload;
    response: { ok: true };
  };
  [COMMAND_CHANNELS.SESSION_EXPORT_SCROLLBACK]: {
    payload: { sessionId: string };
    response: { text: string };
  };
  [COMMAND_CHANNELS.SESSION_CLEAR_SCROLLBACK]: {
    payload: { sessionId: string };
    response: void;
  };
  [COMMAND_CHANNELS.SESSION_RELEASE]: { payload: ReleaseSessionPayload; response: void };
  [COMMAND_CHANNELS.SESSION_OPEN_IN_NEW_WINDOW]: {
    payload: OpenSessionInNewWindowPayload;
    response: OpenSessionInNewWindowResponse;
  };
  [COMMAND_CHANNELS.SESSION_FOCUS_OWNER]: {
    payload: FocusSessionOwnerPayload;
    response: void;
  };
  [COMMAND_CHANNELS.SESSION_SEND_INPUT]: {
    payload: SendInputPayload;
    response: SendInputResponse;
  };
  [COMMAND_CHANNELS.SESSION_RESIZE]: {
    payload: ResizeSessionPayload;
    response: ResizeSessionResponse;
  };

  // ── Bookmark ──────────────────────────────────────────────────────────────
  [COMMAND_CHANNELS.BOOKMARK_ADD]: {
    payload: AddBookmarkPayload;
    response: AddBookmarkResponse;
  };
  [COMMAND_CHANNELS.BOOKMARK_REMOVE]: { payload: RemoveBookmarkPayload; response: void };
  [COMMAND_CHANNELS.BOOKMARK_RENAME]: { payload: RenameBookmarkPayload; response: void };
  [COMMAND_CHANNELS.BOOKMARK_REORDER]: { payload: ReorderBookmarksPayload; response: void };
  [COMMAND_CHANNELS.BOOKMARK_GROUP_ADD]: {
    payload: AddBookmarkGroupPayload;
    response: AddBookmarkGroupResponse;
  };
  [COMMAND_CHANNELS.BOOKMARK_GROUP_RENAME]: {
    payload: RenameBookmarkGroupPayload;
    response: void;
  };
  [COMMAND_CHANNELS.BOOKMARK_GROUP_REMOVE]: {
    payload: RemoveBookmarkGroupPayload;
    response: void;
  };
  [COMMAND_CHANNELS.BOOKMARK_SET_DEFAULT_TEMPLATE]: {
    payload: SetDefaultTemplateForBookmarkPayload;
    response: void;
  };
  [COMMAND_CHANNELS.BOOKMARK_PICK_FOLDER]: {
    payload: PickFolderPayload;
    response: PickFolderResponse;
  };
  [COMMAND_CHANNELS.DIRECTORY_PICKER_LIST]: {
    payload: ListDirectoryPickerPayload;
    response: ListDirectoryPickerResponse;
  };
  [COMMAND_CHANNELS.PATH_REMOVE_FROM_RECENT]: {
    payload: RemoveFromRecentPayload;
    response: void;
  };

  // ── Skill / Pi Bridge ─────────────────────────────────────────────────────
  [COMMAND_CHANNELS.SKILL_INSTALL_MARINA]: {
    payload: InstallMarinaSkillPayload;
    response: InstallMarinaSkillResponse;
  };
  [COMMAND_CHANNELS.PI_BRIDGE_INSTALL]: {
    payload: PiBridgeInstallPayload;
    response: PiBridgeInstallResponse;
  };
  [COMMAND_CHANNELS.PI_BRIDGE_STATUS]: {
    payload: undefined;
    response: PiBridgeStatusResponse;
  };

  // ── SSH / Remote profiles ─────────────────────────────────────────────────
  [COMMAND_CHANNELS.SSH_PROFILE_LIST]: {
    payload: undefined;
    response: ListSshProfilesResponse;
  };
  [COMMAND_CHANNELS.SSH_PROFILE_ADD]: {
    payload: AddSshProfilePayload;
    response: AddSshProfileResponse;
  };
  [COMMAND_CHANNELS.SSH_PROFILE_UPDATE]: {
    payload: UpdateSshProfilePayload;
    response: UpdateSshProfileResponse;
  };
  [COMMAND_CHANNELS.SSH_PROFILE_PICK_KEY_FILE]: {
    payload: PickSshKeyFilePayload;
    response: PickSshKeyFileResponse;
  };
  [COMMAND_CHANNELS.SSH_PROFILE_DELETE]: { payload: DeleteSshProfilePayload; response: void };
  [COMMAND_CHANNELS.SSH_PROFILE_TEST]: {
    payload: TestSshProfilePayload;
    response: TestSshProfileResponse;
  };
  [COMMAND_CHANNELS.REMOTE_PROFILE_LIST]: {
    payload: undefined;
    response: ListRemoteProfilesResponse;
  };
  [COMMAND_CHANNELS.REMOTE_PROFILE_ADD]: {
    payload: AddRemoteProfilePayload;
    response: AddRemoteProfileResponse;
  };
  [COMMAND_CHANNELS.REMOTE_PROFILE_UPDATE]: {
    payload: UpdateRemoteProfilePayload;
    response: UpdateRemoteProfileResponse;
  };
  [COMMAND_CHANNELS.REMOTE_PROFILE_DELETE]: {
    payload: DeleteRemoteProfilePayload;
    response: void;
  };
  [COMMAND_CHANNELS.REMOTE_PROFILE_GET_CONNECTION]: {
    payload: GetRemoteConnectionPayload;
    response: GetRemoteConnectionResponse;
  };
  [COMMAND_CHANNELS.REMOTE_DAEMON_START]: {
    payload: undefined;
    response: RemoteDaemonStatusResponse;
  };
  [COMMAND_CHANNELS.REMOTE_DAEMON_STOP]: {
    payload: undefined;
    response: RemoteDaemonStatusResponse;
  };
  [COMMAND_CHANNELS.REMOTE_DAEMON_GET_STATUS]: {
    payload: undefined;
    response: RemoteDaemonStatusResponse;
  };
  [COMMAND_CHANNELS.REMOTE_DAEMON_SET_PORT]: {
    payload: RemoteDaemonSetPortPayload;
    response: RemoteDaemonStatusResponse;
  };
  [COMMAND_CHANNELS.REMOTE_DAEMON_SET_PASSWORD]: {
    payload: RemoteDaemonSetPasswordPayload;
    response: RemoteDaemonStatusResponse;
  };
  [COMMAND_CHANNELS.REMOTE_BOOKMARK_ADD]: {
    payload: AddRemoteBookmarkPayload;
    response: AddBookmarkResponse;
  };
  [COMMAND_CHANNELS.SSH_CONFIG_LIST]: {
    payload: undefined;
    response: SshConfigListResponse;
  };
  [COMMAND_CHANNELS.SSH_AGENT_STATUS]: {
    payload: undefined;
    response: SshAgentStatusResponse;
  };
  [COMMAND_CHANNELS.KNOWN_HOSTS_REFRESH]: {
    payload: undefined;
    response: KnownHostsRefreshResponse;
  };

  // ── Settings ──────────────────────────────────────────────────────────────
  [COMMAND_CHANNELS.SETTINGS_GET]: { payload: undefined; response: GetSettingsResponse };
  [COMMAND_CHANNELS.SETTINGS_UPDATE]: { payload: UpdateSettingsPayload; response: void };
  [COMMAND_CHANNELS.SETTINGS_RESET]: { payload: undefined; response: void };
  [COMMAND_CHANNELS.SETTINGS_GET_APPEARANCE]: {
    payload: undefined;
    response: GetAppearanceSettingsResponse;
  };
  [COMMAND_CHANNELS.SETTINGS_UPDATE_APPEARANCE]: {
    payload: UpdateAppearanceSettingsPayload;
    response: void;
  };
  [COMMAND_CHANNELS.SETTINGS_LIST_SHELLS]: { payload: undefined; response: ListShellsResponse };
  [COMMAND_CHANNELS.SETTINGS_GET_AUTO_START]: {
    payload: undefined;
    response: GetAutoStartResponse;
  };
  [COMMAND_CHANNELS.SETTINGS_EXPORT]: { payload: undefined; response: ExportSettingsResponse };
  [COMMAND_CHANNELS.SETTINGS_IMPORT]: { payload: undefined; response: ImportSettingsResponse };

  // ── System ────────────────────────────────────────────────────────────────
  [COMMAND_CHANNELS.SYSTEM_SHOW_IN_EXPLORER]: {
    payload: ShowInExplorerPayload;
    response: void;
  };
  [COMMAND_CHANNELS.SYSTEM_OPEN_PATH]: { payload: OpenPathPayload; response: void };
  [COMMAND_CHANNELS.SYSTEM_OPEN_DATA_DIR]: { payload: undefined; response: void };
  [COMMAND_CHANNELS.SYSTEM_OPEN_LOGS_DIR]: { payload: undefined; response: void };
  [COMMAND_CHANNELS.SYSTEM_GET_BUILD_TYPE]: {
    payload: undefined;
    response: { buildType: string };
  };
  [COMMAND_CHANNELS.SYSTEM_GET_DATA_DIR]: {
    payload: undefined;
    response: { dataDir: string };
  };
  [COMMAND_CHANNELS.SYSTEM_OPEN_EXTERNAL]: { payload: OpenExternalPayload; response: void };
  [COMMAND_CHANNELS.SYSTEM_CLIPBOARD_READ_TEXT]: {
    payload: undefined;
    response: ClipboardReadTextResponse;
  };
  [COMMAND_CHANNELS.SYSTEM_CLIPBOARD_WRITE_TEXT]: {
    payload: ClipboardWriteTextPayload;
    response: ClipboardWriteTextResponse;
  };

  // ── Performance / diagnostics ─────────────────────────────────────────────
  [COMMAND_CHANNELS.PERFORMANCE_GET_STATUS]: {
    payload: undefined;
    response: PerformanceStatus;
  };
  [COMMAND_CHANNELS.PERFORMANCE_WRITE_REPORT]: {
    payload: undefined;
    response: PerformanceStatus;
  };
  [COMMAND_CHANNELS.PERFORMANCE_OPEN_REPORTS_DIR]: { payload: undefined; response: void };
  [COMMAND_CHANNELS.PERFORMANCE_CAPTURE_CPU_PROFILE]: {
    payload: CaptureCpuProfilePayload;
    response: CaptureCpuProfileResponse;
  };

  // ── AI / logger ───────────────────────────────────────────────────────────
  [COMMAND_CHANNELS.AI_TEST_CONNECTION]: {
    payload: undefined;
    response: { ok: boolean; message: string };
  };
  [COMMAND_CHANNELS.LOGGER_IME_DUMP]: {
    payload: ImeProbeDumpPayload;
    response: ImeProbeDumpResponse;
  };

  // ── Explorer integration ──────────────────────────────────────────────────
  [COMMAND_CHANNELS.EXPLORER_INTEGRATION_GET_STATUS]: {
    payload: undefined;
    response: ExplorerIntegrationStatus;
  };
  [COMMAND_CHANNELS.EXPLORER_INTEGRATION_SET_CLASSIC]: {
    payload: { enabled: boolean };
    response: { ok: boolean; message: string; status: ExplorerIntegrationStatus };
  };
  [COMMAND_CHANNELS.EXPLORER_INTEGRATION_SET_MODERN]: {
    payload: { enabled: boolean };
    response: { ok: boolean; message: string; status: ExplorerIntegrationStatus };
  };
  [COMMAND_CHANNELS.EXPLORER_INTEGRATION_GET_PS_COMMANDS]: {
    payload: undefined;
    response: GetPsCommandsResponse;
  };

  // ── Template ──────────────────────────────────────────────────────────────
  [COMMAND_CHANNELS.TEMPLATE_ADD]: { payload: AddTemplatePayload; response: AddTemplateResponse };
  [COMMAND_CHANNELS.TEMPLATE_UPDATE]: {
    payload: UpdateTemplatePayload;
    response: UpdateTemplateResponse;
  };
  [COMMAND_CHANNELS.TEMPLATE_DELETE]: { payload: DeleteTemplatePayload; response: void };
  [COMMAND_CHANNELS.TEMPLATE_SET_DEFAULT]: {
    payload: SetDefaultTemplatePayload;
    response: void;
  };

  // ── File panel ────────────────────────────────────────────────────────────
  [COMMAND_CHANNELS.FILE_PANEL_GET_OPEN_FILES]: {
    payload: GetOpenFilesPayload;
    response: FilePanelSnapshot;
  };
  [COMMAND_CHANNELS.FILE_PANEL_OPEN]: {
    payload: OpenFilePanelPayload;
    response: FilePanelSnapshot;
  };
  [COMMAND_CHANNELS.FILE_PANEL_OPEN_PATH]: {
    payload: OpenPathFromMarkdownPayload;
    response: FilePanelSnapshot;
  };
  [COMMAND_CHANNELS.FILE_PANEL_SHOW]: {
    payload: FilePanelActionPayload;
    response: FilePanelSnapshot;
  };
  [COMMAND_CHANNELS.FILE_PANEL_CLOSE]: {
    payload: FilePanelActionPayload;
    response: FilePanelSnapshot;
  };
  [COMMAND_CHANNELS.FILE_PANEL_READ]: { payload: ReadFilePayload; response: ReadFileResponse };
  [COMMAND_CHANNELS.FILE_PANEL_READ_IMAGE]: {
    payload: ReadImagePayload;
    response: ReadImageResponse;
  };
  [COMMAND_CHANNELS.GALLERY_RESOLVE_IMAGE]: {
    payload: GalleryResolveImagePayload;
    response: GalleryResolveImageResponse;
  };
  [COMMAND_CHANNELS.GALLERY_OPEN_IMAGE]: {
    payload: GalleryOpenImagePayload;
    response: GalleryOpenImageResponse;
  };

  // ── File tree ─────────────────────────────────────────────────────────────
  [COMMAND_CHANNELS.FILE_TREE_GET_ROOTS]: {
    payload: GetFileTreeRootsPayload;
    response: GetFileTreeRootsResponse;
  };
  [COMMAND_CHANNELS.FILE_TREE_LIST_DIRECTORY]: {
    payload: ListFileTreeDirectoryPayload;
    response: ListFileTreeDirectoryResponse;
  };
  [COMMAND_CHANNELS.FILE_TREE_OPEN_FILE]: {
    payload: OpenFileTreeFilePayload;
    response: FilePanelSnapshot;
  };
  [COMMAND_CHANNELS.FILE_TREE_REVEAL_PATH]: {
    payload: RevealFileTreePathPayload;
    response: void;
  };
  [COMMAND_CHANNELS.FILE_TREE_OPEN_PATH]: { payload: OpenFileTreePathPayload; response: void };
  [COMMAND_CHANNELS.FILE_TREE_LIST_RECURSIVE]: {
    payload: ListFileTreeRecursivePayload;
    response: ListFileTreeRecursiveResponse;
  };
  [COMMAND_CHANNELS.FILE_TREE_SET_POLLING_DEMAND]: {
    payload: SetFileTreePollingDemandPayload;
    response: void;
  };
  [COMMAND_CHANNELS.FILE_TREE_SET_WATCHED_DIRS]: {
    payload: SetFileTreeWatchedDirsPayload;
    response: void;
  };

  // ── Git ───────────────────────────────────────────────────────────────────
  [COMMAND_CHANNELS.GIT_SET_POLLING_DEMAND]: {
    payload: SetGitPollingDemandPayload;
    response: void;
  };
  [COMMAND_CHANNELS.GIT_GET_STATUS]: {
    payload: GetGitStatusPayload;
    response: GetGitStatusResponse;
  };
  [COMMAND_CHANNELS.GIT_OPEN_DIFF]: { payload: OpenGitDiffPayload; response: FilePanelSnapshot };
  [COMMAND_CHANNELS.GIT_OPEN_FILE]: { payload: OpenGitFilePayload; response: FilePanelSnapshot };
  [COMMAND_CHANNELS.GIT_RESOLVE_PATH]: {
    payload: OpenGitFilePayload;
    response: ResolveGitPathResponse;
  };

  // ── Code block runner ─────────────────────────────────────────────────────
  [COMMAND_CHANNELS.SYSTEM_RUN_CODE_BLOCK]: {
    payload: RunCodeBlockPayload;
    response: RunCodeBlockResponse;
  };
  [COMMAND_CHANNELS.SYSTEM_STOP_CODE_BLOCK]: { payload: StopCodeBlockPayload; response: void };

  // ── Command panel ─────────────────────────────────────────────────────────
  [COMMAND_CHANNELS.COMMAND_PANEL_GET_STATE]: {
    payload: GetCommandPanelStatePayload;
    response: CommandPanelSnapshot;
  };
  [COMMAND_CHANNELS.COMMAND_PANEL_RUN]: {
    payload: RunCommandPayload;
    response: CommandPanelSnapshot;
  };
  [COMMAND_CHANNELS.COMMAND_PANEL_CLOSE]: {
    payload: CloseCommandPayload;
    response: CommandPanelSnapshot;
  };
  [COMMAND_CHANNELS.COMMAND_PANEL_SHOW]: {
    payload: ShowCommandPayload;
    response: CommandPanelSnapshot;
  };
  [COMMAND_CHANNELS.COMMAND_PANEL_UPDATE_REFRESH_POLICY]: {
    payload: UpdateCommandRefreshPolicyPayload;
    response: CommandPanelSnapshot;
  };
  [COMMAND_CHANNELS.COMMAND_PANEL_SET_DEMAND]: {
    payload: SetCommandDemandPayload;
    response: void;
  };

  // ── Sudo 密码(v0.3.3 远程 sudo)——内存态,密码本身只进 SET 入参,其余只回 boolean ──
  [COMMAND_CHANNELS.SUDO_PASSWORD_SET]: {
    payload: SudoPasswordSetPayload;
    response: { ok: true };
  };
  [COMMAND_CHANNELS.SUDO_PASSWORD_CLEAR]: {
    payload: SudoPasswordClearPayload;
    response: { ok: true };
  };
  [COMMAND_CHANNELS.SUDO_PASSWORD_HAS]: {
    payload: SudoPasswordHasPayload;
    response: SudoPasswordStatePayload;
  };

  // ── Markdown theme ────────────────────────────────────────────────────────
  [COMMAND_CHANNELS.MD_THEME_LIST]: { payload: undefined; response: ListMdThemesResponse };
  [COMMAND_CHANNELS.MD_THEME_GET_CSS]: {
    payload: GetMdThemeCssPayload;
    response: GetMdThemeCssResponse;
  };
  [COMMAND_CHANNELS.MD_THEME_OPEN_DIR]: { payload: undefined; response: void };

  // ── Workspace ─────────────────────────────────────────────────────────────
  [COMMAND_CHANNELS.WORKSPACE_GET_CURRENT]: {
    payload: { sessionId: string };
    response: { path: string | null };
  };
  [COMMAND_CHANNELS.WORKSPACE_LIST]: {
    payload: { sessionId: string };
    response: { items: WorkspaceSummary[] };
  };
  [COMMAND_CHANNELS.WORKSPACE_BIND]: {
    payload: { sessionId: string; name: string; new?: boolean };
    response: WorkspaceBindResult;
  };
  [COMMAND_CHANNELS.WORKSPACE_NEW]: {
    payload: { sessionId: string };
    response: { workspaceId: string; dir: string };
  };
  [COMMAND_CHANNELS.WORKSPACE_UNPIN]: {
    payload: { sessionId: string; name?: string | null };
    response: { workspaceId: string } | null;
  };
  [COMMAND_CHANNELS.WORKSPACE_READ_SNAPSHOT]: {
    payload: { sessionId: string };
    response: { snapshot: WorkspaceFilePanelSnapshot | null };
  };
  [COMMAND_CHANNELS.WORKSPACE_WRITE_SNAPSHOT]: {
    payload: { sessionId: string; snapshot: WorkspaceFilePanelSnapshot };
    response: void;
  };
}

/**
 * 所有合法命令 channel 的字面量联合。invoke / registerHandle 用它收窄 channel 参数,
 * 防止拼写错误或已废弃命令漏网。等价于 COMMAND_CHANNELS 的值联合,但通过契约映射
 * 间接表达,确保"有契约的命令"和"合法 channel"是同一个集合。
 */
export type CommandChannelKey = keyof CommandContractMap;

/**
 * 命令 K 的 payload 类型。给 invoke / registerHandle 的 envelope 参数用。
 */
export type CommandPayload<K extends CommandChannelKey> = CommandContractMap[K]['payload'];

/**
 * 命令 K 的 response 类型。给 invoke 的返回 Promise / registerHandle 的 handler 返回用。
 */
export type CommandResponse<K extends CommandChannelKey> = CommandContractMap[K]['response'];
