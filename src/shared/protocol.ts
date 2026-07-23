/**
 * @file protocol.ts
 * @purpose IPC 协议的共享类型定义。Main 与 Renderer 都从这里 import,
 *   确保两端对消息 schema 的理解完全一致。
 *
 * @关键设计:
 * - Channel 命名严格遵守 docs/ipc-protocol.md 第 2.1 节的
 *   `<kind>:<domain>:<action>` 格式
 * - 每个命令的 payload 类型与返回值类型成对定义
 * - 所有 payload 必须 JSON 可序列化 (ipc-protocol.md 1.3 节)
 * - 这个文件不引入任何运行时代码,纯类型 + 常量
 *
 * @对应文档章节: docs/ipc-protocol.md 全部
 */
import type {
  AppSnapshot,
  Bookmark,
  FileKind,
  FileTreeEntry,
  FileTreeRootId,
  MdTheme,
  OpenedFile,
  PathTree,
  RemoteDaemonProfile,
  SessionInfo,
  SessionUiLayoutPatch,
  Settings,
  SshProfile,
  Template,
  WindowInfo,
} from './types';
import type { DeepPartial } from './types-helpers';
export type {
  CaptureCpuProfilePayload,
  CaptureCpuProfileResponse,
  PerformanceStatus,
} from './performance-types';

/**
 * 协议版本号。Main 与 Renderer 不匹配时拒绝 handshake。
 * Bump 规则:破坏性变更 +1;新增 channel 或扩展 payload 不需要 bump。
 */
// v2 引入每窗口远程后端、WS clientId owner 语义和控制面/数据面路由，
// 与只理解本地 WindowInfo owner 的 v1 不兼容，必须在握手阶段明确拒绝混用。
export const PROTOCOL_VERSION = 2 as const;

/** host-only 连接发现协议固定扫描的 daemon 端口范围(含首尾)。 */
export const REMOTE_DAEMON_PORT_MIN = 32780 as const;
export const REMOTE_DAEMON_PORT_MAX = 32789 as const;
export const REMOTE_DAEMON_DEFAULT_PORT = REMOTE_DAEMON_PORT_MIN;

/**
 * 所有命令通道的命名常量。集中管理避免硬编码字符串散落各处。
 */
export const COMMAND_CHANNELS = {
  // App 域
  APP_GET_PROTOCOL_VERSION: 'cmd:app:get-protocol-version',
  APP_GET_SNAPSHOT: 'cmd:app:get-snapshot',
  APP_QUIT: 'cmd:app:quit',

  // Window 域
  WINDOW_CREATE: 'cmd:window:create',
  WINDOW_CLOSE_SELF: 'cmd:window:close-self',
  WINDOW_CLOSE_ALL: 'cmd:window:close-all',
  WINDOW_FOCUS: 'cmd:window:focus',
  /** M1-A:最小化自身窗口 */
  WINDOW_MINIMIZE: 'cmd:window:minimize',
  /** M1-A:切换最大化/还原 */
  WINDOW_TOGGLE_MAXIMIZE: 'cmd:window:toggle-maximize',
  /** M1-A:查询当前是否最大化 */
  WINDOW_GET_MAX_STATE: 'cmd:window:get-max-state',

  // Session 域
  SESSION_CREATE: 'cmd:session:create',
  SESSION_CLOSE: 'cmd:session:close',
  SESSION_CLAIM: 'cmd:session:claim',
  SESSION_RELEASE: 'cmd:session:release',
  SESSION_FOCUS_OWNER: 'cmd:session:focus-owner',
  SESSION_SEND_INPUT: 'cmd:session:send-input',
  SESSION_RESIZE: 'cmd:session:resize',
  SESSION_GET_SCROLLBACK: 'cmd:session:get-scrollback',
  /** BETA-028:导出 scrollback 为 UTF-8 字符串,供终端工具栏"复制全部"按钮 */
  SESSION_EXPORT_SCROLLBACK: 'cmd:session:export-scrollback',
  /** BETA-028:清空 main 端的 scrollback ring buffer(配合 term.clear() 使用) */
  SESSION_CLEAR_SCROLLBACK: 'cmd:session:clear-scrollback',
  /** M1-C:重命名 session(只改 displayName,内部仍由 sessionId 标识) */
  SESSION_RENAME: 'cmd:session:rename',
  /**
   * STM-3:清除手动重命名标记,让 OSC 0/1/2 标题事件重新覆盖 displayName。
   * 用户右键"恢复自动标题"调,典型场景是用户希望 Claude Code 持续刷新
   * 的任务进度标题重新生效。
   */
  SESSION_CLEAR_MANUAL_RENAME: 'cmd:session:clear-manual-rename',
  /**
   * 更新当前终端的临时 UI 布局。布局随 session 接管同步，但 session 销毁后丢弃。
   */
  SESSION_UPDATE_UI_LAYOUT: 'cmd:session:update-ui-layout',
  /**
   * 右键 Tab → “在新窗口中打开”。
   * - 本地 backend:main 原子 release → 创建窗口 → claim 给新 windowId。
   * - 远程 backend:preload 拆成 daemon release + 客户端本地 WINDOW_CREATE;
   *   新窗口连接后用新 WS clientId claim。
   */
  SESSION_OPEN_IN_NEW_WINDOW: 'cmd:session:open-in-new-window',

  // Bookmark / Path 域
  BOOKMARK_ADD: 'cmd:bookmark:add',
  BOOKMARK_REMOVE: 'cmd:bookmark:remove',
  BOOKMARK_RENAME: 'cmd:bookmark:rename',
  BOOKMARK_REORDER: 'cmd:bookmark:reorder',
  BOOKMARK_SET_DEFAULT_TEMPLATE: 'cmd:bookmark:set-default-template',
  BOOKMARK_PICK_FOLDER: 'cmd:bookmark:pick-folder',
  PATH_REMOVE_FROM_RECENT: 'cmd:path:remove-from-recent',
  /** 将内置 show-in-marina skill 安装到所选收藏项目的 agent 目录。 */
  SKILL_INSTALL_MARINA: 'cmd:skill:install-marina',

  // SSH profile / remote path 域
  SSH_PROFILE_LIST: 'cmd:ssh-profile:list',
  SSH_PROFILE_ADD: 'cmd:ssh-profile:add',
  SSH_PROFILE_UPDATE: 'cmd:ssh-profile:update',
  SSH_PROFILE_DELETE: 'cmd:ssh-profile:delete',
  SSH_PROFILE_TEST: 'cmd:ssh-profile:test',
  SSH_PROFILE_PICK_KEY_FILE: 'cmd:ssh-profile:pick-key-file',
  REMOTE_BOOKMARK_ADD: 'cmd:remote-bookmark:add',

  // SSH 方案 v2.1 阶段 2+3:ssh_config / ssh-agent / known_hosts
  /** §阶段 2.1:列出 ~/.ssh/config 的 Host 条目(只读,合并到 sidebar 视用户开关) */
  SSH_CONFIG_LIST: 'cmd:ssh-config:list',
  /** §阶段 2.2:探测 ssh-agent 状态 + 列出已加载的 key */
  SSH_AGENT_STATUS: 'cmd:ssh-agent:status',
  /** §阶段 3.1:列出 ~/.ssh/known_hosts + 与 Marina history 比对的指纹变化 */
  KNOWN_HOSTS_REFRESH: 'cmd:known-hosts:refresh',

  // Settings 域
  SETTINGS_GET: 'cmd:settings:get',
  SETTINGS_UPDATE: 'cmd:settings:update',
  SETTINGS_RESET: 'cmd:settings:reset',
  SETTINGS_LIST_SHELLS: 'cmd:settings:list-shells',
  SETTINGS_GET_AUTO_START: 'cmd:settings:get-auto-start',
  SETTINGS_EXPORT: 'cmd:settings:export',
  SETTINGS_IMPORT: 'cmd:settings:import',

  // Templates 域 (CP-4 chunk 4 起 CRUD 暴露给 renderer)
  TEMPLATE_ADD: 'cmd:template:add',
  TEMPLATE_UPDATE: 'cmd:template:update',
  TEMPLATE_DELETE: 'cmd:template:delete',
  TEMPLATE_SET_DEFAULT: 'cmd:template:set-default',

  // System 域
  SYSTEM_SHOW_IN_EXPLORER: 'cmd:system:show-in-explorer',
  /** v0.3.2:用系统默认应用打开文件/目录(shell.openPath)。与 SYSTEM_OPEN_EXTERNAL
   *  (只允许 http/https/mailto)不同 —— 本通道专开本地路径,renderer 需先 resolve
   *  到绝对路径。file-tree 因 rootId 抽象走专用 FILE_TREE_OPEN_PATH。 */
  SYSTEM_OPEN_PATH: 'cmd:system:open-path',
  SYSTEM_OPEN_DATA_DIR: 'cmd:system:open-data-dir',
  SYSTEM_OPEN_LOGS_DIR: 'cmd:system:open-logs-dir',
  SYSTEM_OPEN_EXTERNAL: 'cmd:system:open-external',
  /** 当前构建形态 dev / portable / installed,供渲染端决定是否禁用系统集成 UI */
  SYSTEM_GET_BUILD_TYPE: 'cmd:system:get-build-type',
  /** BETA-039:返回 app.getPath('userData'),让设置页显示真实数据目录而非硬编码 */
  SYSTEM_GET_DATA_DIR: 'cmd:system:get-data-dir',

  // Explorer 集成域 —— 不进 settings.json,现场查 + 操作系统状态
  /** 综合查询:buildType + Win 版本 + 经典菜单 + Win11 新菜单 + 证书 + MSIX 包 */
  EXPLORER_INTEGRATION_GET_STATUS: 'cmd:explorer-integration:get-status',
  /** 经典右键菜单(HKCU 注册表)开/关 */
  EXPLORER_INTEGRATION_SET_CLASSIC: 'cmd:explorer-integration:set-classic',
  /** Win11 新菜单(MSIX + 证书)安装/卸载 */
  EXPLORER_INTEGRATION_SET_MODERN: 'cmd:explorer-integration:set-modern',
  /** 取出当前会执行的 PowerShell 命令字符串(供「复制 PS 命令」按钮) */
  EXPLORER_INTEGRATION_GET_PS_COMMANDS: 'cmd:explorer-integration:get-ps-commands',
  /**
   * 勘误第二轮:剪贴板 IPC。
   * navigator.clipboard.* 在 Electron file:// 上下文需 web 权限,我们的
   * permission handler 拒掉了 clipboard-write 导致写永远静默失败。走 IPC
   * 调主进程的 Electron clipboard 模块,绕开所有 web 权限层 + dev/prod 行为
   * 一致。preload 的 invoke 桥已经存在,这里只是新增 channel。
   */
  SYSTEM_CLIPBOARD_READ_TEXT: 'cmd:system:clipboard-read-text',
  SYSTEM_CLIPBOARD_WRITE_TEXT: 'cmd:system:clipboard-write-text',

  /** BETA-031:AI 助手测试连接 — 主进程用 SDK 跑一次 ping,返回成功 / 错误描述 */
  AI_TEST_CONNECTION: 'cmd:ai:test-connection',

  /**
   * IME-1 探针 dump — renderer 在 onData 检测到疑似 LEAK 时,把 ring buffer
   * 里的前置 EV 序列 + LEAK 详情一次性发到 main 端 logger.ime 通道落盘,
   * 不依赖 DevTools 打开。详见 src/shared/ime-probe-ring.ts。
   */
  LOGGER_IME_DUMP: 'cmd:logger:ime-dump',

  // 0.3.2 性能诊断域 —— 当前客户端本机 main 的飞行记录器,永远 local-control。
  PERFORMANCE_GET_STATUS: 'cmd:performance:get-status',
  PERFORMANCE_WRITE_REPORT: 'cmd:performance:write-report',
  PERFORMANCE_OPEN_REPORTS_DIR: 'cmd:performance:open-reports-dir',
  PERFORMANCE_CAPTURE_CPU_PROFILE: 'cmd:performance:capture-cpu-profile',

  // File panel 域 —— 终端侧边文件预览面板(renderer 主动查询 / UI 操作;
  // REST 侧 open/show/close 由终端内程序经 HTTP 调,不走这些 IPC)
  /** 拉某 session 当前已打开的文件列表 + active(接管/claim 后初始化面板用) */
  FILE_PANEL_GET_OPEN_FILES: 'cmd:file-panel:get-open-files',
  /** UI 侧"打开文件"按钮(选文件对话框)→ 打开并切 active */
  FILE_PANEL_OPEN: 'cmd:file-panel:open',
  /** 关闭面板里某个已打开文件 */
  FILE_PANEL_CLOSE: 'cmd:file-panel:close',
  /** 仅切换 active(点 tab),不改文件列表 */
  FILE_PANEL_SHOW: 'cmd:file-panel:show',
  /** 读已打开文件的内容:text/markdown 返回字符串,image 返回 base64 dataUrl */
  FILE_PANEL_READ: 'cmd:file-panel:read',
  /** 读 markdown 里的本地图片为 dataUrl(相对 md 文件目录解析,绕开 CSP 对 file:// 的禁) */
  FILE_PANEL_READ_IMAGE: 'cmd:file-panel:read-image',

  // File tree 域 —— active owner session 的受限双根只读导航(ADR-016)
  /** 获取 currentCwd / MARINA_WORKSPACE 两个逻辑根的可用性；不返回绝对路径。 */
  FILE_TREE_GET_ROOTS: 'cmd:file-tree:get-roots',
  /** 懒加载一个受限根下的直接子项；不递归、不接受绝对路径。 */
  FILE_TREE_LIST_DIRECTORY: 'cmd:file-tree:list-directory',
  /** v0.3.2:递归列出整个 root 的全量 entries(扁平),供 renderer 搜索时本地过滤。
   * 解决懒加载搜索限制:未展开目录的内容搜不到。一次拉取 + 本地过滤,query 变化不重拉。 */
  FILE_TREE_LIST_RECURSIVE: 'cmd:file-tree:list-recursive',
  /** 受限校验后打开树中选择的文件，返回既有 FilePanel 快照。 */
  FILE_TREE_OPEN_FILE: 'cmd:file-tree:open-file',
  /** 受限校验后在系统文件管理器中定位并选中树中选择的文件(v0.3.0)。
   *  不返回绝对路径给 renderer，直接由 main 端在 realpath 根包含校验后调用
   *  shell.showItemInFolder，避免 renderer 拿到任意文件路径。 */
  FILE_TREE_REVEAL_PATH: 'cmd:file-tree:reveal-path',
  /** v0.3.2:用系统默认应用打开 file-tree 节点(对称 reveal-path,保持 rootId 抽象)。 */
  FILE_TREE_OPEN_PATH: 'cmd:file-tree:open-path',

  // Git 域 —— active owner session 的只读变更浏览与 diff 预览(v0.3.0,ADR-017)。
  // 与 file-tree 同构的安全模式:owner 校验 + SSH 拒绝 + repoRoot 包含校验。
  // 只调 git status / git diff;永不调写 .git 的命令(见 §13.2/§14.6)。
  /** 拉当前仓库工作区变更分组(SSH/非 repo/disable 返回 unavailable)。 */
  GIT_GET_STATUS: 'cmd:git:get-status',
  /** v0.3.2 ADR-021:renderer 上报当前 Git 后台轮询需求(HOT/WARM/NONE)。 */
  GIT_SET_POLLING_DEMAND: 'cmd:git:set-polling-demand',
  /** 产出某文件的 unified diff,写入受管临时文件后交给 FilePanelService 打开。 */
  GIT_OPEN_DIFF: 'cmd:git:open-diff',
  /** v0.3.1 勘误:直接打开文件本身(不走 diff),跳「已打开」面板。 */
  GIT_OPEN_FILE: 'cmd:git:open-file',
  /** v0.3.1 勘误:解析相对路径 → 绝对路径(供 renderer 复制 / reveal)。 */
  GIT_RESOLVE_PATH: 'cmd:git:resolve-path',

  // Markdown 主题域 —— Typora 式可扩展:用户往 userData/markdown-themes/ 放 .css
  // 即多一个 markdown 面板风格(见 src/main/markdown-theme-manager.ts)。
  /** 列出所有自定义 markdown 主题(扫 markdown-themes/*.css) */
  MD_THEME_LIST: 'cmd:md-theme:list',
  /** 取某主题的 CSS 文本(renderer 注入 <style>,CSP 合规) */
  MD_THEME_GET_CSS: 'cmd:md-theme:get-css',
  /** 在系统文件管理器打开主题目录(便于用户放/编辑 .css) */
  MD_THEME_OPEN_DIR: 'cmd:md-theme:open-dir',

  // 远程后端 profile(ADR-014 / §14.9)—— client 端"如何连远程 daemon"
  REMOTE_PROFILE_LIST: 'cmd:remote-profile:list',
  REMOTE_PROFILE_ADD: 'cmd:remote-profile:add',
  REMOTE_PROFILE_UPDATE: 'cmd:remote-profile:update',
  REMOTE_PROFILE_DELETE: 'cmd:remote-profile:delete',
  /** preload 启动时拉某 profile 的连接信息(host + 解密后密码);null=无此 profile/未配对 */
  REMOTE_PROFILE_GET_CONNECTION: 'cmd:remote-profile:get-connection',
  // v2.0 远程服务端运行时启停 + 配置(UI 按钮触发)
  REMOTE_DAEMON_START: 'cmd:remote-daemon:start',
  REMOTE_DAEMON_STOP: 'cmd:remote-daemon:stop',
  REMOTE_DAEMON_GET_STATUS: 'cmd:remote-daemon:get-status',
  REMOTE_DAEMON_SET_PORT: 'cmd:remote-daemon:set-port',
  REMOTE_DAEMON_SET_PASSWORD: 'cmd:remote-daemon:set-password',
} as const;

export type CommandChannel = (typeof COMMAND_CHANNELS)[keyof typeof COMMAND_CHANNELS];

/**
 * 命令路由域(每窗口后端模型的核心架构边界)。
 *
 * preload 根据 channel 所属的域决定路由:
 * - 'local-control':客户端本地控制面,永远走客户端 Electron IPC。
 *   BrowserWindow 生命周期、窗口控件、本机资源(剪贴板/远程 profile 凭据)
 *   属于当前客户端机器,绝不能发给 daemon。
 * - 'backend-data':后端业务数据,本地窗口走本地 IPC,远程窗口走 WS→daemon。
 *   session/path/template/settings 等业务状态属于后端(本地 main 或远程 daemon)。
 *
 * 默认 'backend-data'(向后兼容:大部分命令是后端数据)。
 *
 * 新增命令时:在 LOCAL_CONTROL_COMMANDS_SET 显式声明 'local-control' 即可,
 * preload 自动路由,不需要在 preload/index.ts 再维护一份 Set。
 * 这避免了“新增本地控制命令忘记加到 preload Set”的隐式契约 bug
 * (review 发现的 clipboard 遗漏就是这个模式)。
 */
export type CommandRoutingDomain = 'local-control' | 'backend-data';

/**
 * 显式声明为本地控制面的命令集合。未列出的命令默认走 backend-data。
 *
 * 维护规则:新增的命令如果操作“当前客户端机器的本地资源”
 * (BrowserWindow、本机剪贴板/外部链接、本客户端的远程 profile 凭据、
 * 本客户端是否对外提供 daemon 服务),必须加到这里。
 * 加这里之后不需要在 preload/index.ts 再做任何事 —— preload 读这个声明自动路由。
 */
const LOCAL_CONTROL_COMMANDS_SET: ReadonlySet<string> = new Set<CommandChannel>([
  COMMAND_CHANNELS.APP_QUIT,
  COMMAND_CHANNELS.WINDOW_CREATE,
  COMMAND_CHANNELS.WINDOW_CLOSE_SELF,
  COMMAND_CHANNELS.WINDOW_CLOSE_ALL,
  COMMAND_CHANNELS.WINDOW_FOCUS,
  COMMAND_CHANNELS.WINDOW_MINIMIZE,
  COMMAND_CHANNELS.WINDOW_TOGGLE_MAXIMIZE,
  COMMAND_CHANNELS.WINDOW_GET_MAX_STATE,
  COMMAND_CHANNELS.REMOTE_PROFILE_LIST,
  COMMAND_CHANNELS.REMOTE_PROFILE_ADD,
  COMMAND_CHANNELS.REMOTE_PROFILE_UPDATE,
  COMMAND_CHANNELS.REMOTE_PROFILE_DELETE,
  COMMAND_CHANNELS.REMOTE_PROFILE_GET_CONNECTION,
  // “允许其他电脑连接本机”是当前客户端机器的服务端配置。远程窗口里也不能
  // 把启停/改密码发给当前连接的 daemon，否则客户端可远程关闭服务或轮换密码。
  COMMAND_CHANNELS.REMOTE_DAEMON_START,
  COMMAND_CHANNELS.REMOTE_DAEMON_STOP,
  COMMAND_CHANNELS.REMOTE_DAEMON_GET_STATUS,
  COMMAND_CHANNELS.REMOTE_DAEMON_SET_PORT,
  COMMAND_CHANNELS.REMOTE_DAEMON_SET_PASSWORD,
  COMMAND_CHANNELS.SYSTEM_CLIPBOARD_READ_TEXT,
  COMMAND_CHANNELS.SYSTEM_CLIPBOARD_WRITE_TEXT,
  COMMAND_CHANNELS.PERFORMANCE_GET_STATUS,
  COMMAND_CHANNELS.PERFORMANCE_WRITE_REPORT,
  COMMAND_CHANNELS.PERFORMANCE_OPEN_REPORTS_DIR,
  COMMAND_CHANNELS.PERFORMANCE_CAPTURE_CPU_PROFILE,
  // 用户点击链接时应在当前桌面打开浏览器，不能在 headless daemon 主机打开。
  COMMAND_CHANNELS.SYSTEM_OPEN_EXTERNAL,
]);

/** 查询某 channel 的路由域。preload 用这个决定走本地 IPC 还是 WS。 */
export function getCommandRouting(channel: string): CommandRoutingDomain {
  return LOCAL_CONTROL_COMMANDS_SET.has(channel as CommandChannel)
    ? 'local-control'
    : 'backend-data';
}

/**
 * 所有事件通道的命名常量。
 */
export const EVENT_CHANNELS = {
  // App / Window
  APP_STATE_CHANGED: 'evt:app:state-changed',
  WINDOW_ASSIGNED_ID: 'evt:window:assigned-id',
  WINDOW_LIST_UPDATED: 'evt:window:list-updated',
  WINDOW_FOCUS_REQUESTED: 'evt:window:focus-requested',
  /** M1-A:本窗口的 maximize / unmaximize 状态变化(供 renderer 切按钮图标 + 圆角) */
  WINDOW_MAX_STATE_CHANGED: 'evt:window:max-state-changed',
  /** v2.0 远程服务端状态变化(启动/停止/client 连接/断开)→ renderer 更新 UI */
  REMOTE_DAEMON_STATUS_CHANGED: 'evt:remote-daemon:status-changed',

  // Session
  SESSION_CREATED: 'evt:session:created',
  SESSION_STATE_CHANGED: 'evt:session:state-changed',
  SESSION_OUTPUT: 'evt:session:output',
  SESSION_EXITED: 'evt:session:exited',
  SESSION_OWNER_CHANGED: 'evt:session:owner-changed',
  SESSION_DESTROYED: 'evt:session:destroyed',

  // Path / Bookmark / Settings
  PATH_TREE_UPDATED: 'evt:path:tree-updated',
  BOOKMARKS_UPDATED: 'evt:bookmarks:updated',
  SSH_PROFILES_UPDATED: 'evt:ssh-profiles:updated',
  REMOTE_PROFILES_UPDATED: 'evt:remote-profiles:updated',
  SETTINGS_CHANGED: 'evt:settings:changed',
  TEMPLATES_UPDATED: 'evt:templates:updated',

  /**
   * BETA-003b · ADR-013:Linux 上最后窗口关闭 + 仍有 alive session 时,
   * 主进程拦截 close 事件后给本窗口 renderer 发此事件,弹 LastSessionConfirm
   * modal。Payload:{ sessionCount: number }。
   *
   * Windows / macOS 也复用同一 modal,触发位置分别是托盘菜单"完全退出"和
   * Cmd+Q / App Menu Quit。
   */
  UI_SHOW_LAST_SESSION_CONFIRM: 'evt:ui:show-last-session-confirm',

  /**
   * 终端侧边文件面板状态变化(REST open/show/close 触发,或 fs.watch 检测到
   * 文件被外部修改)。ipc.ts 只推给该 session 的 owner 窗口(与 SESSION_OUTPUT
   * 同策略),renderer 收到后更新 filePanels Map。
   */
  FILE_PANEL_UPDATED: 'evt:file-panel:updated',

  /**
   * Git 面板仓库变更状态更新。main 预取或 ADR-021 demand-aware task 已附带脱敏
   * snapshot 广播，renderer 直接更新组件外缓存，不需再拉一次 get-status。
   */
  GIT_STATUS_UPDATED: 'evt:git:status-updated',

  /**
   * 自定义 markdown 主题列表变化(用户往 markdown-themes/ 增删 .css,fs.watch
   * 触发)。广播给所有窗口,renderer 更新设置页下拉。
   */
  MD_THEME_LIST_UPDATED: 'evt:md-theme:list-updated',
} as const;

export type EventChannel = (typeof EVENT_CHANNELS)[keyof typeof EVENT_CHANNELS];

// ──────────────────────────────────────────────────────────────────
// Envelope
// ──────────────────────────────────────────────────────────────────

export interface CommandEnvelope<P = unknown> {
  windowId: string;
  requestId: string;
  payload: P;
}

export interface EventEnvelope<P = unknown> {
  eventId: string;
  timestamp: number;
  payload: P;
}

// ──────────────────────────────────────────────────────────────────
// App 域
// ──────────────────────────────────────────────────────────────────

export interface GetProtocolVersionResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  buildVersion: string;
  /**
   * DEV-COEXIST(2026-05-16):构建形态。renderer 据此在标题栏后缀显示
   * "(dev)" / "(portable)",避免 dev 实例与打包版同时跑时误认。
   * 与 SYSTEM_GET_BUILD_TYPE 同源,只是放进握手响应里,首次握手就拿到。
   */
  buildType: 'dev' | 'portable' | 'installed';
}

export interface GetSnapshotPayload {
  /** 发起方窗口 ID,用于校验 */
  myWindowId: string;
}

export type GetSnapshotResponse = AppSnapshot;

export interface QuitPayload {
  /** CP-2 暂未使用,CP-3 加入 session 在跑时的二次确认时启用 */
  skipConfirmation?: boolean;
}

export interface QuitResponse {
  cancelled: boolean;
}

// ──────────────────────────────────────────────────────────────────
// Window 域
// ──────────────────────────────────────────────────────────────────

export interface CreateWindowPayload {
  /** 可选:新窗口启动时聚焦 / 接管的 sessionId。 */
  selectSessionId?: string;
  /** true → 新窗口以简易模式启动(隐藏 Sidebar/Tab bar)。 */
  simpleMode?: boolean;
  /**
   * v2.0 远程后端(每窗口后端):新窗口连的后端 profile id。
   * undefined/null = 本地 main 后端;非空 = 连该远程 daemon。
   */
  backendProfileId?: string;
}

export interface CreateWindowResponse {
  windowId: string;
  windowNumber: number;
}

/**
 * M1-A:WINDOW_MINIMIZE / WINDOW_TOGGLE_MAXIMIZE 没有 payload(目标窗口
 * 直接由 envelope.windowId 决定);WINDOW_GET_MAX_STATE 返回值。
 */
export interface GetWindowMaxStateResponse {
  maximized: boolean;
}

/**
 * M1-A:evt:window:max-state-changed payload。
 */
export interface WindowMaxStateChangedPayload {
  maximized: boolean;
}

export interface FocusWindowPayload {
  windowId: string;
}

// ──────────────────────────────────────────────────────────────────
// Session 域
// ──────────────────────────────────────────────────────────────────

export interface CreateSessionPayload {
  /** 启动 session 的 path id (= 该 path 的 normalize 后绝对路径)。
   *  缺省时 SessionManager 会用 homedir,主要用于 CP-1 兼容期。 */
  pathId?: string;
  /** 启动模板 id。CP-2 仅 'shell',CP-3 起接 TemplateManager */
  templateId?: string;
  /**
   * 勘误第二轮 #3:可选 shell 覆盖。缺省走 settings.shell.defaultShellId,
   * 给定时强制用该 shell 启动 (但仍走模板的 command/args)。EmptyPathState
   * 的"检测到的 Shell"按钮通过它实现"用 Git Bash 起一个 shell"。
   */
  shellId?: string;
  /** 是否本窗口接管 ownership。默认 true */
  takeOwnership?: boolean;
  /** 终端尺寸初始值 */
  cols: number;
  rows: number;
  /**
   * SSH 路径专用:本次连接是否启用远端 tmux。
   *
   * 这是一次性启动选项,不持久化到 SSH profile。首页的"连接"按钮传
   * disabled,旁边的"tmux"按钮传 attach-or-create,避免旧 profile 里的
   * tmux 字段影响普通 SSH 连接。
   */
  sshTmuxMode?: 'disabled' | 'attach-or-create';
}

export interface CreateSessionResponse {
  session: SessionInfo;
  /** 是否触发了 path 树变化 (临时分类等) */
  pathTreeChanged: boolean;
  /**
   * 非阻塞的提示信息。例如保存了 SSH 密码但本机没装 sshpass,无法自动注入。
   * renderer 收到非空字符串时弹一条 warn toast。
   */
  warning?: string;
}

export interface RenameSessionPayload {
  sessionId: string;
  newDisplayName: string;
}

/** cmd:skill:install-marina payload。projectPath 必须是本地收藏目录。 */
export interface InstallMarinaSkillPayload {
  projectPath: string;
  targets: Array<'pi' | 'claude' | 'codex'>;
  /** true 仅由 renderer 经用户覆盖确认后传入。 */
  overwrite?: boolean;
}

export interface InstallMarinaSkillResponse {
  installed: Array<{ target: 'pi' | 'claude' | 'codex'; destination: string }>;
  conflicts: Array<{ target: 'pi' | 'claude' | 'codex'; destination: string }>;
}

/** cmd:session:update-ui-layout payload。main 端合并并校验区块值。 */
export interface UpdateSessionUiLayoutPayload {
  sessionId: string;
  patch: SessionUiLayoutPatch;
}

export interface CloseSessionPayload {
  sessionId: string;
  /** 强制 kill (默认 false 即 SIGTERM) */
  force?: boolean;
}

export interface ClaimSessionPayload {
  sessionId: string;
}

export interface ClaimSessionResponse {
  /** Base64 编码的 scrollback 历史 (CP-2 修订:已实现 ring buffer)。
   *  Renderer 通常通过 cmd:session:get-scrollback 单独拉取以避免与 claim
   *  动作时序耦合,此返回值仍带数据保留协议自洽。 */
  scrollback: string;
  /** 与 scrollback 同时刻的 lastSeq,用于 renderer 去重。 */
  lastSeq: number;
}

export interface GetScrollbackPayload {
  sessionId: string;
}

export interface GetScrollbackResponse {
  /**
   * Base64 编码的 ANSI 重建流(UTF-8 字节)。
   *
   * CURSOR-1 后(state-replay 架构):main 端从 session 各自的 @xterm/headless
   * 状态机通过 SerializeAddon 序列化"当前完整终端状态"(buffer + 当前在哪个
   * buffer + 模式 + cursor + SGR)。Renderer 把 data 直接 term.write(),xterm
   * 按 ANSI parse 即恢复到字节级等价状态 — 包括 alt-buffer (?1049h)、
   * cursor 隐藏 (?25l)、滚动区 (DECSTBM) 等。
   *
   * 旧字段名 `data` 保留(不破坏 IPC 协议),但语义已从"原始 PTY 字节流"
   * 升级为"状态机重建 ANSI 流"。详见 SessionManager.getScrollbackForReplay
   * 与 docs/issues/cursor-1-alt-buffer-blink-policy-broke-codex.md。
   */
  data: string;
  /** 取此 scrollback 时刻 PTY 已 emit 的最后一条 output 的 seq;
   *  渲染端用 seq > lastSeq 去重 evt:session:output。 */
  lastSeq: number;
}

export interface ReleaseSessionPayload {
  sessionId: string;
}

export interface OpenSessionInNewWindowPayload {
  sessionId: string;
  /** true → 新窗口以简易模式启动(隐藏 Sidebar/Tab bar)。默认 false。 */
  simpleMode?: boolean;
}

export interface OpenSessionInNewWindowResponse {
  windowId: string;
  windowNumber: number;
}

export interface FocusSessionOwnerPayload {
  sessionId: string;
}

export interface SendInputPayload {
  sessionId: string;
  /** 字节流,base64 编码 */
  data: string;
}

/**
 * sendInput/resize 的反馈。
 *
 * 历史:CP-1/2/3 期间这两条 IPC 都是 void(成功 / 失败都静默,renderer
 * 永远不知道键被丢了)。fix/robustness-pass(2026-05-13)起改为返回
 * accepted + reason,renderer 据此 toast / 视觉降级。
 *
 * reason 取值:
 *   - 'session-not-found' · sessionId 不在 SessionManager.sessions Map(已 destroy / 不存在)
 *   - 'pty-exited'        · session 在 'exited' 状态,managed.pty===null
 *   - 'not-owner'         · 调用方不是 session 的 ownerWindowId(只用于 sendInput)
 *   - 'pty-write-failed'  · pty.write() 抛错(ConPTY pipe half-closed 等)
 *   - 'invalid-dimensions'· cols/rows 不合规(只用于 resize)
 *
 * accepted=true 时 reason 一定不存在。
 */
export interface SendInputResponse {
  accepted: boolean;
  reason?: 'session-not-found' | 'pty-exited' | 'not-owner' | 'pty-write-failed';
}

export interface ResizeSessionResponse {
  accepted: boolean;
  reason?: 'session-not-found' | 'pty-exited' | 'invalid-dimensions';
}

export interface ResizeSessionPayload {
  sessionId: string;
  cols: number;
  rows: number;
}

// ──────────────────────────────────────────────────────────────────
// Bookmark / Path 域
// ──────────────────────────────────────────────────────────────────

export interface AddBookmarkPayload {
  path: string;
  displayName?: string;
  defaultTemplateId?: string;
}

export interface AddBookmarkResponse {
  bookmark: Bookmark;
}

export interface RemoveBookmarkPayload {
  pathId: string;
}

export interface RenameBookmarkPayload {
  pathId: string;
  newDisplayName: string;
}

export interface ReorderBookmarksPayload {
  orderedPathIds: string[];
}

export interface SetDefaultTemplateForBookmarkPayload {
  pathId: string;
  templateId: string | null;
}

export interface PickFolderPayload {
  defaultPath?: string;
}

export interface PickFolderResponse {
  /** 用户取消 → null */
  path: string | null;
}

export interface RemoveFromRecentPayload {
  path: string;
}

// ──────────────────────────────────────────────────────────────────
// SSH / Remote Path 域
// ──────────────────────────────────────────────────────────────────

export interface AddSshProfilePayload {
  name: string;
  host: string;
  port: number;
  username: string;
  authType: 'agent' | 'keyFile' | 'password';
  keyFilePath?: string;
  /**
   * 可选明文密码。main 收到后用 safeStorage 加密落盘,renderer 永远拿不到。
   * undefined = 不更新已有保存密码;'' (空字符串) = 清除已保存密码。
   */
  password?: string;
  defaultRemoteCwd?: string;
  /** SSH 方案 §阶段 2.3:ProxyJump 多跳板(逗号分隔的多 host;每段最多 5 段) */
  proxyJump?: string[];
  tmuxMode?: 'disabled' | 'attach-or-create';
  tmuxSessionName?: string;
  tmuxSessionPolicy?: 'reuse' | 'new-per-launch';
  tmuxOnMissing?: 'fallback-shell' | 'fail';
}

export interface AddSshProfileResponse {
  profile: SshProfile;
}

export interface UpdateSshProfilePayload {
  id: string;
  partial: Partial<AddSshProfilePayload>;
}

export interface UpdateSshProfileResponse {
  profile: SshProfile;
}

export interface DeleteSshProfilePayload {
  id: string;
}

export interface ListSshProfilesResponse {
  profiles: SshProfile[];
}

// ── 远程后端 profile(ADR-014 / §14.9)──

export interface AddRemoteProfilePayload {
  displayName: string;
  host: string;
  /** 明文配对密码;main 用 safeStorage 加密落盘(同 SSH password 模式)。 */
  password?: string;
  /** 阶段2b TLS:证书指纹(首次确认后存)。 */
  certFingerprint?: string;
}

export interface UpdateRemoteProfilePayload {
  id: string;
  partial: Partial<AddRemoteProfilePayload>;
}

export interface DeleteRemoteProfilePayload {
  id: string;
}

/** 请求某 profile 的连接信息(preload 建 RemoteTransport 用)。 */
export interface GetRemoteConnectionPayload {
  profileId: string;
}

export interface ListRemoteProfilesResponse {
  profiles: RemoteDaemonProfile[];
}

export interface AddRemoteProfileResponse {
  profile: RemoteDaemonProfile;
}

export interface UpdateRemoteProfileResponse {
  profile: RemoteDaemonProfile;
}

/**
 * preload 启动时按 profileId 拉连接信息。null = 无此 profile / 未配对(无密码)。
 * 有值 = preload 据此扫描 host 的端口(12580 起)连 Marina daemon。
 * token 是 main 解密后的明文配对密码(仅在本机内存中传给 preload,不出本机)。
 */
export interface GetRemoteConnectionResponse {
  connection: {
    host: string;
    token: string;
    profileId: string;
    displayName: string;
  } | null;
}

// ── v2.0 远程服务端(UI 启停 + 配置)──

export interface RemoteDaemonStatusPayload {
  running: boolean;
  port: number | null;
  clientCount: number;
  hasPassword: boolean;
  /**
   * 端口监听自检结果(controller.start 后主动 connect 127.0.0.1:port 验证)。
   * undefined = 尚未启动 / 未自检;{ ok: false, reason } = listen 失败(端口被占 / 绑定异常)。
   * 用户看到“已开启但自检失败” → 能快速定位“服务开了但连不上”是监听问题。
   */
  listenCheck?: { ok: boolean; reason?: string };
}

/**
 * v2.0 远程连接错误自动分析:把连接失败的**阶段**和**原因**细分,
 * renderer 据此给针对性诊断(而不是笼统的“连不上”)。
 *
 * 错误点全链路:
 *   client ──TCP connect──→ daemon [监听?] ──WS upgrade──→ ──auth(token)──→ [token 对?]
 *
 * 对应错误码:
 *   LISTEN_FAILED    — daemon 端自检:端口起不来(占用/绑定)。仅 daemon 状态里用。
 *   PROFILE_INCOMPLETE — client profile 缺 host/token(本地数据问题)。
 *   TCP_REFUSED      — TCP 连接被拒(server 没起 / 端口没开 / 绑定到别的接口)。
 *   TCP_TIMEOUT      — TCP 连接超时(防火墙 drop / WG 路由 / 网络不通)。与 REFUSED 的区别:REFUSED 是对方明确拒(RST),TIMEOUT 是包丢了。
 *   TCP_UNREACHABLE  — 浏览器 WebSocket 无法区分 REFUSED/TIMEOUT(底层都报 close 1006)。
 *                      统一归此类,错误页排查清单同时列两类可能。
 *   WS_HANDSHAKE     — TCP 通但 WS 升级失败(目标不是 Marina daemon / 协议不对)。
 *   AUTH_REJECTED    — daemon 明确拒认证(token 不匹配,close code 4001)。
 *   AUTH_TIMEOUT     — WS 连上但 daemon 不回 auth-ok(daemon 异常 / 卡住 / 版本不兼容)。
 *   NO_PORT_FOUND    — 扫描范围内所有端口都失败(用最有价值的子错误原因描述)。
 */
export type RemoteConnectErrorCode =
  | 'LISTEN_FAILED'
  | 'PROFILE_INCOMPLETE'
  | 'TCP_UNREACHABLE'
  | 'TCP_REFUSED'
  | 'TCP_TIMEOUT'
  | 'WS_HANDSHAKE'
  | 'AUTH_REJECTED'
  | 'AUTH_TIMEOUT'
  | 'NO_PORT_FOUND';

/** client 端连接失败时报告给 renderer 的结构化错误。 */
export interface RemoteConnectError {
  code: RemoteConnectErrorCode;
  /** 人类可读的具体描述(含 host/port 等上下文)。renderer 错误页可直接展示。 */
  message: string;
  host: string;
  /** 尝试的端口(扫描场景为最后一个试的端口)。 */
  port?: number;
  /** NO_PORT_FOUND 时,聚合各端口尝试的错误码(供 renderer 选最有价值诊断)。 */
  triedErrors?: RemoteConnectErrorCode[];
}

export interface RemoteDaemonStatusResponse {
  status: RemoteDaemonStatusPayload;
}

export interface RemoteDaemonSetPortPayload {
  port: number;
}

export interface RemoteDaemonSetPasswordPayload {
  password: string;
}

export interface PickSshKeyFilePayload {
  defaultPath?: string;
}

export interface PickSshKeyFileResponse {
  /** 用户取消 → null */
  path: string | null;
}

export interface TestSshProfilePayload {
  id: string;
}

export interface TestSshProfileResponse {
  ok: boolean;
  message: string;
}

export interface AddRemoteBookmarkPayload {
  sshProfileId: string;
  remotePath: string;
  displayName?: string;
  defaultTemplateId?: string;
}

// ──────────────────────────────────────────────────────────────────
// Settings 域
// ──────────────────────────────────────────────────────────────────

export interface GetSettingsResponse {
  settings: Settings;
}

export interface UpdateSettingsPayload {
  partial: DeepPartial<Settings>;
}

// ──────────────────────────────────────────────────────────────────
// Templates 域
// ──────────────────────────────────────────────────────────────────

export interface AddTemplatePayload {
  name: string;
  icon: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  shellFirst: boolean;
  postExitAction: 'close_session' | 'keep_shell' | 'hold';
}

export interface AddTemplateResponse {
  template: Template;
}

export interface UpdateTemplatePayload {
  id: string;
  partial: Partial<{
    name: string;
    icon: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    shellFirst: boolean;
    postExitAction: 'close_session' | 'keep_shell' | 'hold';
  }>;
}

export interface UpdateTemplateResponse {
  template: Template;
}

export interface DeleteTemplatePayload {
  id: string;
}

export interface SetDefaultTemplatePayload {
  id: string;
}

// ──────────────────────────────────────────────────────────────────
// SSH 方案 v2.1 阶段 2+3:ssh_config / ssh-agent / known_hosts payload
// ──────────────────────────────────────────────────────────────────

/**
 * ~/.ssh/config 的一条 Host 条目(只读;用户改请直接编辑 ssh_config)。
 *
 * Marina 在 sidebar / RemotePanel 把这些条目展示为"来源:ssh_config"标签,
 * 不可删/编辑;连接时按本条同等 SshProfile 拼 ssh args。
 */
export interface SshConfigEntryDto {
  alias: string;
  hostName: string;
  user?: string;
  port: number;
  identityFiles: string[];
  proxyJump: string[];
  /** ssh_config 文件绝对路径(tooltip / 诊断) */
  sourceFile: string;
}

export interface SshConfigListResponse {
  enabled: boolean;
  entries: SshConfigEntryDto[];
}

export type SshAgentStatusResponse =
  | {
      status: 'agent-running';
      keys: Array<{
        bits: number;
        fingerprint: string;
        comment: string;
        keyType: string;
      }>;
    }
  | {
      status: 'agent-missing';
      reason: 'no-socket' | 'cli-missing' | 'cli-failed';
      message: string;
    };

export interface KnownHostsRefreshResponse {
  entries: Array<{
    hosts: string;
    keyType: string;
    fingerprint: string;
    sourceFile: string;
    isHashed: boolean;
  }>;
  /** 与 history 比对后,本次发现指纹变化的 host 列表(potential MITM) */
  changes: Array<{
    host: string;
    previousFingerprint: string;
    newFingerprint: string;
    keyType: string;
  }>;
}

// ──────────────────────────────────────────────────────────────────
// Settings export / import
// ──────────────────────────────────────────────────────────────────

/**
 * 导出/导入用的归档 JSON schema (CP-4 chunk 4)。
 *
 * V1 用单 JSON 文件而非 zip:
 * - 4 类配置(settings/bookmarks/recent/templates)合体到一个 JSON
 * - 不含 logs / scrollback / 进程状态
 * - format 字段 + version 字段方便未来迁移
 *
 * 文档 6.6.2 描述为 zip,V1 折衷为 JSON 以避免引入 zip 库依赖
 * (AGENTS.md 1.2 边界 2)。未来加 archiver 包可平滑升级。
 */
export interface SettingsArchiveV1 {
  /**
   * 归档格式标签。v1.5 改名后新导出统一 'marina-archive';读侧也接受
   * 'easyterm-archive'(改名前的旧归档)。
   */
  format: 'marina-archive' | 'easyterm-archive';
  version: 1;
  exportedAt: number;
  exportedFrom: string;
  settings: Settings;
  bookmarks: { paths: Bookmark[] };
  /**
   * v2.1:archive 内 recent 容纳 SSH 项,kind / sshProfileId 可选,导入时由
   * PathManager.validateRecentArray 严格校验(ssh kind 必须带 sshProfileId)。
   * 字段缺失视为 local,与启动期 migrateRecentOnLoad 对齐。
   */
  recent: {
    paths: Array<{
      path: string;
      lastUsedAt: number;
      useCount: number;
      kind?: 'local' | 'ssh';
      sshProfileId?: string;
    }>;
  };
  sshProfiles?: { profiles: SshProfile[] };
  templates: { defaultTemplateId: string; templates: Template[] };
}

export interface ExportSettingsResponse {
  /** 用户取消 → null */
  filePath: string | null;
}

export interface ImportSettingsResponse {
  /** 用户取消 → 'cancelled' / 错误 → 'error' / 成功 → 'imported' */
  status: 'imported' | 'cancelled' | 'error';
  errorMessage?: string;
}

export interface ShellListItem {
  /** shell id (pwsh / powershell / cmd / git-bash 等) */
  id: string;
  /** 用户友好显示名 (PowerShell 7 / Windows PowerShell / Command Prompt 等) */
  displayName: string;
  /** 实测命中的可执行文件绝对路径 */
  executablePath: string;
}

export interface ListShellsResponse {
  shells: ShellListItem[];
}

export interface GetAutoStartResponse {
  enabled: boolean;
}

// ──────────────────────────────────────────────────────────────────
// System 域
// ──────────────────────────────────────────────────────────────────

export interface ShowInExplorerPayload {
  path: string;
}

/** v0.3.2:用系统默认应用打开本地路径(shell.openPath)。 */
export interface OpenPathPayload {
  path: string;
}

export interface OpenExternalPayload {
  /** http(s) URL — 文件 / file:// 协议拒绝 (安全) */
  url: string;
}

export interface ClipboardWriteTextPayload {
  text: string;
}

export interface ClipboardReadTextResponse {
  text: string;
}

export interface ClipboardWriteTextResponse {
  ok: boolean;
}

// ──────────────────────────────────────────────────────────────────
// Explorer 集成域
// ──────────────────────────────────────────────────────────────────

export type BuildType = 'dev' | 'portable' | 'installed';

export interface GetBuildTypeResponse {
  buildType: BuildType;
}

/**
 * 三个状态值的语义:
 * - `enabled`     当前系统状态已开启(经典 = HKCU key 存在;Win11 新菜单 = MSIX 已注册)
 * - `disabled`    支持但未开启
 * - `unsupported` 当前构建/系统不支持(dev / portable 一律 unsupported;经典菜单则在
 *                 非 Windows 上 unsupported;Win11 新菜单还要求 build >= 22000)
 */
export type ExplorerIntegrationState = 'enabled' | 'disabled' | 'unsupported';

export interface ExplorerIntegrationCertInfo {
  thumbprint: string;
  /** 证书 NotAfter,ISO 字符串 */
  notAfter: string;
  subject: string;
  /** Cert:\CurrentUser\TrustedPeople 是否存在该 thumbprint */
  trusted: boolean;
}

export interface ExplorerIntegrationPackageInfo {
  /** Marina.ContextMenu 等包名 */
  name: string;
  version: string;
  installLocation: string;
}

export interface ExplorerIntegrationStatus {
  buildType: BuildType;
  /** 例如 "10.0.22621";非 Windows 时为空字符串 */
  windowsBuild: string;
  /** Win11 22000+ 才支持 Modern 菜单(IExplorerCommand) */
  win11ModernSupported: boolean;
  classic: ExplorerIntegrationState;
  modern: ExplorerIntegrationState;
  /** 证书信息(Modern 菜单依赖,Modern 不支持时为 null) */
  cert: ExplorerIntegrationCertInfo | null;
  /** MSIX 包信息(modern=enabled 时存在) */
  package: ExplorerIntegrationPackageInfo | null;
  /** Modern 不支持的原因(展示给用户)。null = 支持 */
  modernUnsupportedReason: string | null;
  /** Classic 不支持的原因。null = 支持 */
  classicUnsupportedReason: string | null;
}

export interface SetExplorerIntegrationPayload {
  enabled: boolean;
}

export interface SetExplorerIntegrationResponse {
  ok: boolean;
  /** 失败时的可读消息;ok=true 时为空 */
  message: string;
  /** 操作后的最新状态(渲染端无需再单独调 GET_STATUS) */
  status: ExplorerIntegrationStatus;
}

export interface GetPsCommandsResponse {
  /** 安装 Win11 新菜单等价的 PowerShell 命令(供"复制" 按钮) */
  installModern: string;
  /** 卸载 Win11 新菜单 */
  uninstallModern: string;
  /** 注册经典菜单 */
  installClassic: string;
  /** 卸载经典菜单 */
  uninstallClassic: string;
}

// ──────────────────────────────────────────────────────────────────
// 事件 payload
// ──────────────────────────────────────────────────────────────────

export interface AppStateChangedPayload {
  hasWindows: boolean;
  totalSessions: number;
  activeSessions: number;
}

export interface WindowAssignedIdPayload {
  windowId: string;
  windowNumber: number;
}

export interface WindowListUpdatedPayload {
  windows: WindowInfo[];
}

export interface WindowFocusRequestedPayload {
  reason:
    | 'session-click'
    | 'tray-click'
    | 'manual'
    | 'tray-session-click' // M1-H:托盘"正在运行的会话"子菜单点击
    | 'tray-open-settings'; // M1-H:托盘"设置…"菜单
  selectSessionId?: string;
}

export interface SessionCreatedPayload {
  session: SessionInfo;
}

export interface SessionStateChangedPayload {
  sessionId: string;
  changes: Partial<SessionInfo>;
  full: SessionInfo;
}

export interface SessionOutputPayload {
  sessionId: string;
  /** base64 编码的字节流 */
  data: string;
  /** 自该 session 创建以来的事件序号,单调递增,从 0 开始 */
  seq: number;
}

export interface SessionExitedPayload {
  sessionId: string;
  exitCode: number;
  /** node-pty 给的是 signal number,Windows 上通常没有 */
  signal?: number;
}

export interface SessionOwnerChangedPayload {
  sessionId: string;
  oldOwnerWindowId: string | null;
  newOwnerWindowId: string | null;
}

export interface SessionDestroyedPayload {
  sessionId: string;
  /**
   * 销毁触发源。v1.2 起没有 'tombstone-expired' (砍墓地,见 ADR-008);
   * 'pty-exited' 仅在应用启动 / 异常 race 中出现 — 正常 PTY 退出不再立即
   * destroy,而是进入 'exited' 状态 (sessionExited 事件已涵盖),由用户
   * 主动关闭触发 'user-closed' destroy。
   */
  reason: 'user-closed' | 'app-quit' | 'pty-exited';
}

export interface PathTreeUpdatedPayload {
  tree: PathTree;
}

export interface BookmarksUpdatedPayload {
  bookmarks: Bookmark[];
}

export interface SshProfilesUpdatedPayload {
  profiles: SshProfile[];
}

export interface SettingsChangedPayload {
  settings: Settings;
  /** 变化的字段路径,如 ["appearance.theme"];renderer 可基于此局部更新 */
  changedKeys: string[];
}

/**
 * 模板列表更新 (CP-2 阶段不发,因为模板未持久化;CP-3 起启用)。
 */
export interface TemplateListUpdatedPayload {
  templates: Template[];
  defaultTemplateId: string;
}

/**
 * IME-1 探针 dump payload。entries 是 ring 的快照(按时序),最后一条
 * 通常是 ev='leak'(若不是,说明 ring 里有更新的 EV 把 leak 挤出去了)。
 * meta 给 main 端写日志时定位用,不重复 entries 里的信息。
 */
export interface ImeProbeDumpPayload {
  meta: {
    /** renderer 端的 performance.now() 时间戳字符串(便于和 entries 对齐) */
    t: string;
    /** session id,用来在多个终端里区分哪一个触发的 */
    sessionId: string;
  };
  entries: Array<{
    t: string;
    ev: 'start' | 'update' | 'end' | 'kd229' | 'leak';
    data?: string;
    key?: string;
    taLen: number;
    taTail: string;
    leakLen?: number;
    leakHead?: string;
    leakTail?: string;
  }>;
}

export interface ImeProbeDumpResponse {
  ok: true;
}

// ──────────────────────────────────────────────────────────────────
// File panel 域 (终端侧边文件预览面板 / MARINA_SERVICE 远程调用)
// ──────────────────────────────────────────────────────────────────

/**
 * 某个 session 的文件面板当前快照。不含 sessionId(由 payload 外层 /
 * Map 的 key 携带),也不含文件内容(内容按需 cmd:file-panel:read)。
 */
export interface FilePanelSnapshot {
  files: OpenedFile[];
  /** 当前展示的文件 path;无文件或无选中时为 null */
  activePath: string | null;
}

/** cmd:file-panel:get-open-files payload。 */
export interface GetOpenFilesPayload {
  sessionId: string;
}

/** cmd:file-panel:open / close / show payload。path 可相对 session.currentCwd。 */
export interface FilePanelActionPayload {
  sessionId: string;
  path: string;
}

/** cmd:file-panel:read payload。path 必须是已打开列表里的规范化绝对路径。 */
export interface ReadFilePayload {
  sessionId: string;
  path: string;
}

/** cmd:file-panel:read-image payload。src 是 markdown 里 ![alt](src) 的原始值,
 * main 相对 mdPath 所在目录解析为本地绝对路径后读。网络/data:/blob: 不该走到这
 * (renderer 直接交给 <img>);传到这里会被拒。sessionId 用于成员校验:mdPath 必须
 * 是该 session 已打开列表里的 md 文件(与 readFile 同防线),防 renderer 被诱导
 * 用任意 mdPath 读磁盘任意目录的图片。 */
export interface ReadImagePayload {
  sessionId: string;
  mdPath: string;
  src: string;
}

/** cmd:file-panel:read-image 返回。dataUrl 成功;base64 dataUrl 可直接喂 <img src>。
 * error 时 renderer 降级显示占位(图片缺失/非图片/超限/路径不可达)。 */
export type ReadImageResponse = { dataUrl: string } | { error: string };

/**
 * cmd:file-panel:read 返回。按 kind 区分内容载体:
 * - text/markdown/diff:UTF-8 字符串(超 MAX_READ_TEXT_BYTES 截断,truncated=true)
 *   diff 由 renderer DiffViewer 用 highlight.js 做行级着色(方案-diff高亮.md B)
 * - image:base64 dataUrl(可直接喂 <img src>),mime 供调试/未来按类型优化
 * - unknown:文件类型不支持预览(二进制 / 陌生扩展名)
 */
export type ReadFileResponse =
  | { kind: 'text' | 'markdown' | 'diff'; text: string; truncated: boolean }
  | { kind: 'image'; dataUrl: string; mime: string }
  | { kind: 'unknown'; message: string };

/**
 * evt:file-panel:updated payload。
 *
 * `requestActivation=true` 表示本次更新源于一次成功的「打开文件」(HTTP
 * /open-file、IPC cmd:file-panel:open、文件树点击三者最终都进
 * FilePanelService.openFile)，renderer 应把已打开面板切到前台。show / close /
 * fs.watch 刷新发送 false；字段缺失也按 false 处理，不会抢用户已手动切回的焦点。
 * 向后兼容:旧 renderer 忽略该可选字段即可，不影响渲染。
 */
export interface FilePanelUpdatedPayload {
  sessionId: string;
  files: OpenedFile[];
  activePath: string | null;
  /** 仅 openFile 成功时为 true，请求 renderer 激活「已打开」面板。 */
  requestActivation?: boolean;
}

/** ReadFileResponse 的 kind 与 FileKind 的交集(排除 web,本轮不支持)。 */
export type ReadableFileKind = Exclude<FileKind, 'unknown'>;

// ──────────────────────────────────────────────────────────────────
// File tree 域（ADR-016：当前 owner session 的双根只读导航）
// ──────────────────────────────────────────────────────────────────

export interface GetFileTreeRootsPayload {
  sessionId: string;
}

export interface FileTreeRootInfo {
  id: FileTreeRootId;
  label: string;
  available: boolean;
  reason?: string;
}

export interface GetFileTreeRootsResponse {
  roots: FileTreeRootInfo[];
}

export interface ListFileTreeDirectoryPayload {
  sessionId: string;
  rootId: FileTreeRootId;
  /** 相对 root 的路径；根目录用空字符串，绝对路径和 `..` 由 main 拒绝。 */
  relativePath?: string;
}

export interface ListFileTreeDirectoryResponse {
  rootId: FileTreeRootId;
  relativePath: string;
  entries: FileTreeEntry[];
  /** true 表示为避免大目录撑爆 IPC，本次仅返回前 500 个可访问直接子项。 */
  truncated: boolean;
}

/** v0.3.2:递归列出 root 全量 entries(扁平)。payload 只需 rootId,返回所有后代。 */
export interface ListFileTreeRecursivePayload {
  sessionId: string;
  rootId: FileTreeRootId;
}

/** list-recursive 响应:扁平 entries(含全路径 relativePath)+ 截断标志。
 * 上限保护(总数 5000 / 深度 15)防止巨型仓库(如 node_modules) 撑爆 IPC。 */
export interface ListFileTreeRecursiveResponse {
  rootId: FileTreeRootId;
  entries: FileTreeEntry[];
  truncated: boolean;
  /** 扫描的目录数(诊断用,让 renderer 显示“扫了 N 个目录”)。 */
  dirCount: number;
}

export interface OpenFileTreeFilePayload {
  sessionId: string;
  rootId: FileTreeRootId;
  relativePath: string;
}

/** cmd:file-tree:reveal-path payload(v0.3.0)。与 OpenFileTreeFilePayload 同形。 */
export interface RevealFileTreePathPayload {
  sessionId: string;
  rootId: FileTreeRootId;
  relativePath: string;
}

/** v0.3.2:用系统默认应用打开 file-tree 节点(对称 reveal)。 */
export interface OpenFileTreePathPayload {
  sessionId: string;
  rootId: FileTreeRootId;
  relativePath: string;
}

// ──────────────────────────────────────────────────────────────────
// Git 域 (v0.3.0,ADR-017 —— 受限只读变更浏览与 diff 预览)
// 与 file-tree 同构的安全模式;仅调 git status / git diff,永不写 .git。
// ──────────────────────────────────────────────────────────────────

/** Git 变更分组语义色。与 FileListRow 的 statusBadge tone 对齐。 */
export type GitStatusTone = 'conflict' | 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';

export interface GitStatusEntry {
  /** 相对 repoRoot 的 POSIX 风格路径(renamed 时是新路径)。 */
  relativePath: string;
  /** renamed 专用:旧路径;其他状态不携带。 */
  oldPath?: string;
}

export interface GitStatusGroup {
  tone: GitStatusTone;
  entries: GitStatusEntry[];
}

/** git:status 不可用原因。renderer 据此在「Git tab 不出现」之外提供诊断。 */
export type GitUnavailableReason =
  | 'disabled'
  | 'ssh-unsupported'
  | 'not-a-repo'
  | 'git-binary-missing';

/** cmd:git:get-status 返回。repoRoot 不返回给 renderer(避免泄露绝对路径)。 */
export interface GitStatusSnapshot {
  groups: GitStatusGroup[];
  truncated: boolean;
}

/** cmd:git:get-status payload。 */
export interface GetGitStatusPayload {
  sessionId: string;
}

/** 昂贵后台任务需求等级；当前仅 Git status 使用。 */
export type BackgroundDemandLevel = 'none' | 'warm' | 'hot';

/** cmd:git:set-polling-demand payload。consumerId 只能取 envelope.windowId。 */
export interface SetGitPollingDemandPayload {
  sessionId: string;
  level: BackgroundDemandLevel;
}

/** cmd:git:get-status 返回。available=false 时 renderer 不渲染 Git tab。 */
export type GetGitStatusResponse =
  | (GitStatusSnapshot & { unavailable?: undefined })
  | { unavailable: GitUnavailableReason };

/** cmd:git:open-diff payload。relativePath 由 getStatus 返回,renderer 原样回传。 */
export interface OpenGitDiffPayload {
  sessionId: string;
  relativePath: string;
}

/** v0.3.1 cmd:git:open-file payload(与 open-diff 同形,语义不同)。 */
export interface OpenGitFilePayload {
  sessionId: string;
  relativePath: string;
}

/** v0.3.1 cmd:git:resolve-path 返回。 */
export interface ResolveGitPathResponse {
  /** 绝对路径(repoRoot + relativePath,越界校验后)。 */
  absolutePath: string;
}

/** evt:git:status-updated payload。
 * 由 main 端预取(SessionManager 检测到 cwd 进仓库时)/ watcher(仓库变更)
 * 主动推。snapshot 为「已 strip repoRoot」的 GetGitStatusResponse 形状,renderer
 * 收到后直接写缓存(git-status-cache),零额外 IPC。
 * 注:不推送 loading/error 态(那些是 UI 瞬态)。 */
export interface GitStatusUpdatedPayload {
  sessionId: string;
  /** 正常状态。与 unavailable 互斥。 */
  groups?: GitStatusGroup[];
  truncated?: boolean;
  /** 不可用状态原因(预取/watcher 发现 cd 出仓库 / disable 等)。 */
  unavailable?: GitUnavailableReason | undefined;
}

// ──────────────────────────────────────────────────────────────────
// Markdown 主题域 (Typora 式可扩展面板风格)
// ──────────────────────────────────────────────────────────────────

/** cmd:md-theme:list 返回:当前 userData/markdown-themes/ 下的所有自定义主题。 */
export interface ListMdThemesResponse {
  themes: MdTheme[];
}

/** cmd:md-theme:get-css payload。id 形如 `custom:sepia`。 */
export interface GetMdThemeCssPayload {
  id: string;
}

/**
 * cmd:md-theme:get-css 返回。
 * - 找得到 → css = 文件 UTF-8 文本(可能很长,但单主题 CSS 一般 < 几十 KB)
 * - id 不在列表里(用户刚删) → css = '' ,renderer 据此清空注入的 <style>
 *   并由 MarkdownViewer fallback 到 auto
 */
export interface GetMdThemeCssResponse {
  css: string;
}

/** evt:md-theme:list-updated payload。 */
export interface MdThemeListUpdatedPayload {
  themes: MdTheme[];
}
