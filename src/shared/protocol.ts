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
  PersistedGroup,
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
  /** 注册一个只读终端视图租约；不授予 input/resize owner 权限。 */
  SESSION_ATTACH_TERMINAL_VIEW: 'cmd:session:attach-terminal-view',
  /** 释放匹配 viewId 的终端视图租约(cache eviction / renderer unmount)。 */
  SESSION_DETACH_TERMINAL_VIEW: 'cmd:session:detach-terminal-view',
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
   * v0.3.3 ADR-028:renderer 选中某 session 时上报“已查看”，清除其 hasUnviewedWork
   * 标记(侧栏指示灯警告色转正常)。per-session：任一窗口查看即清。幂等。
   */
  SESSION_MARK_VIEWED: 'cmd:session:mark-viewed',
  /**
   * 右键 Tab → “在新窗口中打开”。
   * - 本地 backend:main 原子 release → 创建窗口 → claim 给新 windowId。
   * - 远程 backend:preload 拆成 daemon release + 客户端本地 WINDOW_CREATE;
   *   新窗口连接后用新 WS clientId claim。
   */
  SESSION_OPEN_IN_NEW_WINDOW: 'cmd:session:open-in-new-window',
  /**
   * v0.3.3 Feature E.2 / 决策 #15:拖动同一 path 下的 session 重排顺序。
   * 真值存 main/daemon 内存(sessionOrder Map),不落盘(重启重置)。
   * 校验:orderedSessionIds 必须恰好等于该 path 当前 session 集合。
   */
  SESSION_REORDER: 'cmd:session:reorder',

  // Bookmark / Path 域
  BOOKMARK_ADD: 'cmd:bookmark:add',
  BOOKMARK_REMOVE: 'cmd:bookmark:remove',
  BOOKMARK_RENAME: 'cmd:bookmark:rename',
  BOOKMARK_REORDER: 'cmd:bookmark:reorder',
  BOOKMARK_SET_DEFAULT_TEMPLATE: 'cmd:bookmark:set-default-template',
  BOOKMARK_PICK_FOLDER: 'cmd:bookmark:pick-folder',
  /**
   * 远程后端窗口的自绘文件夹选择器：在当前 backend 分层列目录。
   * 默认 backend-data，远程窗口必须发到 daemon；绝不能列客户端本地目录。
   */
  DIRECTORY_PICKER_LIST: 'cmd:directory-picker:list',
  /** v0.3.3 ADR-025 / Feature E.1:收藏分组 CRUD(低频,各自独立 IPC)。 */
  BOOKMARK_GROUP_ADD: 'cmd:bookmark:group:add',
  BOOKMARK_GROUP_RENAME: 'cmd:bookmark:group:rename',
  BOOKMARK_GROUP_REMOVE: 'cmd:bookmark:group:remove',
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

  // ── 外观归属(local-control 域,见 docs/plans/远程窗口外观继承本机.md)──
  // 远程后端窗口的外观(theme/字体/语言/zoom 等全部 appearance 块)归当前客户端
  // 机器所有,而非远程 daemon。这两个命令被声明 local-control,远程窗口调用时
  // 走客户端本地 IPC,读写的是客户端本机 settingsManager —— 与 cmd:settings:get /
  // update(backend-data,远程窗口走 WS 读写 daemon)刻意解耦。
  /** 拉本机客户端的 appearance(local-control)。远程窗口用它覆盖 snapshot 里
   *  来自 daemon 的 appearance;本地窗口用 cmd:settings:get 即可。 */
  SETTINGS_GET_APPEARANCE: 'cmd:settings:get-appearance',
  /** 把外观改动写回本机客户端(local-control)。远程窗口设置页改外观走此通道写
   *  本机 settingsManager,并触发 SETTINGS_LOCAL_APPEARANCE_CHANGED 广播同步同机窗口。 */
  SETTINGS_UPDATE_APPEARANCE: 'cmd:settings:update-appearance',

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
  /**
   * Markdown 代码块一键执行(v0.3.3,ADR-023)。main/daemon 根据 sourceSessionId
   * 读 backend 与 currentCwd,直接 child_process.spawn 对应 shell,不经 PTY/xterm。
   * 输出/退出经 evt:system:code-block-* 事件回推给发起 client。路由 = backend-data
   * (远程窗口自动发到 daemon,本地/远程行为一致)。
   */
  SYSTEM_RUN_CODE_BLOCK: 'cmd:system:run-code-block',
  /** 停止某次运行(SIGKILL 子进程)。幂等,未运行/未知 runId 静默。 */
  SYSTEM_STOP_CODE_BLOCK: 'cmd:system:stop-code-block',

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
  /** v0.3.3 Feature B:markdown 文档里的本地文件链接 → 相对 md 目录解析进面板只读查看 */
  FILE_PANEL_OPEN_PATH: 'cmd:file-panel:open-path',
  /** 关闭面板里某个已打开文件 */
  FILE_PANEL_CLOSE: 'cmd:file-panel:close',
  /** 仅切换 active(点 tab),不改文件列表 */
  FILE_PANEL_SHOW: 'cmd:file-panel:show',
  /** 读已打开文件的内容:text/markdown 返回字符串,image 返回 base64 dataUrl */
  FILE_PANEL_READ: 'cmd:file-panel:read',
  /** 读 markdown 里的本地图片为 dataUrl(相对 md 文件目录解析,绕开 CSP 对 file:// 的禁) */
  FILE_PANEL_READ_IMAGE: 'cmd:file-panel:read-image',

  // Command panel 域 —— AI 经 HTTP /run(或此 IPC)推送任意命令字符串,Marina 跑它
  // 并把 markdown 输出渲染进第 4 个 dock 面板(ADR-028 / Feature G)。trigger=
  // program-push,与 file-panel 同构;区别在内层:这里推的是「指令」而非「文件」,
  // 且每条指令各自带刷新策略(默认仅前台,少数后台轮询走 BackgroundWorkScheduler)。
  /** 拉某 session 当前命令面板状态(指令列表 + active + 每条策略)。claim/接管/切 bind 恢复用 */
  COMMAND_PANEL_GET_STATE: 'cmd:command-panel:get-state',
  /** 推送/重跑一条指令(body {sessionId, command, title?});同 command 用于重跑时按 command 去重 upsert */
  COMMAND_PANEL_RUN: 'cmd:command-panel:run',
  /** 关闭某条指令 tab(按 commandKey) */
  COMMAND_PANEL_CLOSE: 'cmd:command-panel:close',
  /** 仅切 active(点 tab),不改指令列表 */
  COMMAND_PANEL_SHOW: 'cmd:command-panel:show',
  /** 改某条指令的刷新策略(per-指令,D4) */
  COMMAND_PANEL_SET_STRATEGY: 'cmd:command-panel:set-strategy',
  /** renderer 上报面板 demand(可见性/聚焦 → HOT/WARM/NONE,仿 git:set-polling-demand) */
  COMMAND_PANEL_SET_DEMAND: 'cmd:command-panel:set-demand',

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
  /** ADR-021:renderer 上报文件树面板轮询需求(HOT/NONE,仿 git:set-polling-demand)。
   *  只有前台窗口可见的文件面板报 HOT,其余一律 NONE。consumerId 取 envelope.windowId。 */
  FILE_TREE_SET_POLLING_DEMAND: 'cmd:file-tree:set-polling-demand',
  /** FileTreePanel 上报当前已展开目录集合(即 main 端轮询目标)。与 demand 分开由面板
   *  单独上报:展开集合是面板私有态,LayoutHost(可见性真值源)不感知。 */
  FILE_TREE_SET_WATCHED_DIRS: 'cmd:file-tree:set-watched-dirs',

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

  // Workspace 域(v0.3.3 ADR-024 / Feature D)—— 绑定/复用/状态持久化。
  // workspaceId 与 sessionId 解耦;操作当前客户端机器的本地 daemon 状态
  // (session→workspaceId 绑定 + 本地受管目录),故入 LOCAL_CONTROL_COMMANDS_SET。
  /** 查当前 session 绑定的 workspace 绝对路径(CLI `workspace` 用)。 */
  WORKSPACE_GET_CURRENT: 'cmd:workspace:get-current',
  /** 列当前 pathScope 下的命名 workspace。 */
  WORKSPACE_LIST: 'cmd:workspace:list',
  /** bind = upsert:新→命名+pin;存在→切+恢复快照。forceNew=true + 存在→报错。 */
  WORKSPACE_BIND: 'cmd:workspace:bind',
  /** 切回新空临时 workspace(原命名 pinned 不动)。 */
  WORKSPACE_NEW: 'cmd:workspace:new',
  /** 剥 name+pinned,workspace 退回可回收态(name 省略=当前绑定)。 */
  WORKSPACE_UNPIN: 'cmd:workspace:unpin',
  /** 读某 workspace 的文件面板快照(bind 切换后恢复用;renderer 触发)。 */
  WORKSPACE_READ_SNAPSHOT: 'cmd:workspace:read-snapshot',
  /** 写某 workspace 的文件面板快照(renderer 状态变化 debounce 后触发)。 */
  WORKSPACE_WRITE_SNAPSHOT: 'cmd:workspace:write-snapshot',

  // Gallery 域(v0.3.3 ADR-026 / Feature A)—— 图片表代码块的单图解析。
  // 本地图相对 md 目录解析读 dataUrl(复用 read-image 安全面);网络图
  // (http(s)) daemon 拉取落盘 workspace 缓存再转 dataUrl(绕开 prod CSP
  // img-src 限制)。读的是 session 绑定的文件,在 daemon 机器 → backend-data 域。
  /** 解析 gallery 单张图为本地图 dataUrl(本地图复用 read-image;网络图下载缓存)。 */
  GALLERY_RESOLVE_IMAGE: 'cmd:gallery:resolve-image',
  /** 用系统图片查看器打开 gallery 某张图(main resolve 路径后 shell.openPath)。 */
  GALLERY_OPEN_IMAGE: 'cmd:gallery:open-image',
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
  // v0.3.3 ADR-024:workspace 操作改的是当前客户端机器的本地 daemon 状态
  // (session→workspaceId 绑定 + 本地受管目录),远程窗口里必须发到当前桌面 daemon。
  COMMAND_CHANNELS.WORKSPACE_GET_CURRENT,
  COMMAND_CHANNELS.WORKSPACE_LIST,
  COMMAND_CHANNELS.WORKSPACE_BIND,
  COMMAND_CHANNELS.WORKSPACE_NEW,
  COMMAND_CHANNELS.WORKSPACE_UNPIN,
  COMMAND_CHANNELS.WORKSPACE_READ_SNAPSHOT,
  COMMAND_CHANNELS.WORKSPACE_WRITE_SNAPSHOT,
  // 外观归属客户端机器(同 workspace 理由):远程窗口的外观读写必须发到当前
  // 客户端本地 main,绝不能发给所连 daemon —— 否则外观会被 daemon 的设置覆盖。
  COMMAND_CHANNELS.SETTINGS_GET_APPEARANCE,
  COMMAND_CHANNELS.SETTINGS_UPDATE_APPEARANCE,
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
  /** 本机客户端 appearance 变更广播(local-control 域)。本机 settingsManager 的
   *  appearance 变化时广播;远程窗口订阅此事件实时同步本机外观(本地窗口已通过
   *  SETTINGS_CHANGED 更新,忽略本事件避免双重刷新)。设计动机见
   *  docs/plans/远程窗口外观继承本机.md §问题2(实时同步)。 */
  SETTINGS_LOCAL_APPEARANCE_CHANGED: 'evt:settings:local-appearance-changed',
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
   * v0.3.3 ADR-024 / Feature D:workspace 切换完成(bind/new/unpin 后)。
   * payload = { sessionId, workspaceId }。renderer 收到后调 restoreWorkspaceSnapshot
   * 恢复 file-panel 的 scroll/runs(openedFiles/activePath 由同次的 FILE_PANEL_UPDATED
   * 同步,因为 FilePanelService.onWorkspaceSwitched 会重建 PanelState 并 emit)。
   * 定向推给该 session 的 owner 窗口(同 FILE_PANEL_UPDATED 策略)。
   */
  WORKSPACE_CHANGED: 'evt:workspace:changed',

  /**
   * 命令面板状态变化(指令增删/active 切换/策略变更/状态机翻转/输出落定)。
   * 定向推给该 session 的 owner 窗口(与 FILE_PANEL_UPDATED 同策略)。payload 见
   * CommandPanelSnapshot。流式实时输出复用 evt:system:code-block-output/
   * exited(命令面板的 run 就是 CodeBlockRunner 跑的,runId 空间一致,renderer
   * 按各自 runId 订阅即可,不重复造事件)。
   */
  COMMAND_PANEL_UPDATED: 'evt:command-panel:updated',

  /**
   * Git 面板仓库变更状态更新。main 预取或 ADR-021 demand-aware task 已附带脱敏
   * snapshot 广播，renderer 直接更新组件外缓存，不需再拉一次 get-status。
   */
  GIT_STATUS_UPDATED: 'evt:git:status-updated',

  /**
   * 文件树目录列表变化。main 端 FileTreePollingService(demand-aware task)轮询
   * 已展开目录并 diff 后广播,renderer 收到直接更新对应目录快照,不二次拉取。
   */
  FILE_TREE_CHANGED: 'evt:file-tree:changed',

  /**
   * 自定义 markdown 主题列表变化(用户往 markdown-themes/ 增删 .css,fs.watch
   * 触发)。广播给所有窗口,renderer 更新设置页下拉。
   */
  MD_THEME_LIST_UPDATED: 'evt:md-theme:list-updated',

  /**
   * Markdown 代码块运行 stdout/stderr 流式输出(v0.3.3,ADR-023)。按 runId 定向
   * 发给发起 client(本地窗口 = windowId,远程 = WS clientId)。后端事件,远程
   * 自动从 daemon 回推。payload 见 CodeBlockOutputPayload。
   */
  CODE_BLOCK_OUTPUT: 'evt:system:code-block-output',
  /** Markdown 代码块运行子进程退出。带 exitCode/signal,renderer 据此切状态。 */
  CODE_BLOCK_EXITED: 'evt:system:code-block-exited',
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
  /**
   * 接管瞬间已 emit 的最后一条 PTY output seq(O(1) 读取)。
   *
   * REPLAY-1(2026-07-31):claim 不再序列化 / 返回全量 scrollback。历史实现
   * 在 claim 响应里带完整 scrollback「保协议自洽」,但 renderer 从不消费它 —
   * 冷挂载走 cmd:session:get-scrollback,暖切换由 TerminalDeck 缓存 + view
   * lease 维持。每次切换在 main 重复 serialize(5000 行 ≈ 40-60ms)并传输
   * 0.6-2MB base64 大 payload(远程模式还要 JSON/deflate/网络),是切换
   * 终端慢的纯浪费点。
   */
  lastSeq: number;
}

export interface GetScrollbackPayload {
  sessionId: string;
}

export interface AttachTerminalViewPayload {
  sessionId: string;
  /** renderer mount 实例 UUID；防旧 cleanup 删除替代租约。 */
  viewId: string;
}

export interface AttachTerminalViewResponse {
  /** true 表示该 xterm 自上次 attach 起从未漏输出,可原样复用 viewport。 */
  continuous: boolean;
}

export interface DetachTerminalViewPayload {
  sessionId: string;
  viewId: string;
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
  reason?: 'session-not-found' | 'pty-exited' | 'invalid-dimensions' | 'not-owner';
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
  /** 选择器从某个分组菜单打开时，收藏原子地直接进入该组。 */
  groupId?: string;
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
  /**
   * v0.3.3 ADR-025(用户裁决 2026-08-04 后为组树):统一分层 reorder payload。
   * - `ungrouped` = 未分组 pathId 有序列表(顶置渲染)。
   * - `groups` = **扁平组表**:含全部组(含子组);`subgroupOrder` 是直接子组
   *   id 有序列表,roots = 未被任何组引用的 id;`childOrder` 是该组直接
   *   path 的有序列表。
   * main 校验:ungrouped ∪ 各 childOrder 的并集必须恰好等于当前 bookmarks
   * 的 pathId 集合(无重复/无未知/无遗漏),然后整体替换顺序 + groupId;
   * 组引用必须存在且无环。旧「全部未分组」= `{ ungrouped: [全量], groups: [] }`。
   */
  ungrouped: string[];
  groups: { id: string; childOrder: string[]; subgroupOrder: string[] }[];
}

/**
 * v0.3.3 ADR-025:新建分组,返回新 groupId。组名收藏内唯一。
 * parentId = 父组 id(嵌套子组)；缺省 = 顶层。
 */
export interface AddBookmarkGroupPayload {
  name: string;
  parentId?: string;
}
export interface AddBookmarkGroupResponse {
  id: string;
}
/** v0.3.3 ADR-025:重命名分组(收藏内唯一)。 */
export interface RenameBookmarkGroupPayload {
  id: string;
  name: string;
}
/** v0.3.3 ADR-025:解散分组,其下 path 与子组提升到父级(绝不删数据)。 */
export interface RemoveBookmarkGroupPayload {
  id: string;
}
/**
 * v0.3.3 Feature E.2 / 决策 #15:重排某 path 下的 session 顺序。
 * orderedSessionIds 必须恰好等于该 path 当前 session 集合。
 */
export interface ReorderSessionsPayload {
  pathId: string;
  orderedSessionIds: string[];
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

/** 自绘 backend 文件夹选择器的一次分层列举请求；省略 path 从 backend home 开始。 */
export interface ListDirectoryPickerPayload {
  path?: string;
}

export interface DirectoryPickerEntry {
  name: string;
  /** backend 上的规范化绝对路径；renderer 只展示和回传，不允许文本编辑。 */
  path: string;
}

export interface ListDirectoryPickerResponse {
  currentPath: string;
  parentPath: string | null;
  homePath: string;
  rootPath: string;
  directories: DirectoryPickerEntry[];
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
  /** 与本地收藏一致：指定后直接进入该分组，不经过未分组中间态。 */
  groupId?: string;
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

// ── 外观归属客户端(local-control 域,见 docs/plans/远程窗口外观继承本机.md)──
// 远程窗口的外观读写走单独通道,与 backend-data 的 settings 命令解耦。
/** get-appearance 响应:仅返回本机 appearance 块。 */
export interface GetAppearanceSettingsResponse {
  appearance: Settings['appearance'];
}
/** update-appearance 入参:appearance 块的部分字段(字段都是叶子值,用 Partial 即可)。 */
export interface UpdateAppearanceSettingsPayload {
  partial: Partial<Settings['appearance']>;
}
/** evt:settings:local-appearance-changed payload:本机 appearance 块整体。 */
export interface LocalAppearanceChangedPayload {
  appearance: Settings['appearance'];
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
  bookmarks: { paths: Bookmark[]; groups?: PersistedGroup[] };
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
// Markdown 代码块执行域 (v0.3.3,ADR-023)
// ──────────────────────────────────────────────────────────────────
//
// 设计要点(详见 docs/方案-markdown代码块执行-20260731.md):
// - renderer 只传 sourceSessionId + 归一化后的 shell language + 代码原文;
//   cwd / backend / 可执行路径一律由 main/daemon 根据 session 真值解析,
//   renderer 不传也不信任 cwd。
// - 执行不经 PTY/xterm,不创建 Marina session,不调用 SessionManager.sendInput;
//   直接 child_process.spawn 对应 shell 一次性跑完整 code。当前终端是
//   Claude Code / vim 等任何程序都不会受影响。
// - 事件按 runId 定向回发起 client;runId 仅本进程内唯一即可。

/** 归一化后支持的 shell 语言(与 src/shared/markdown-command.ts 同源)。 */
export type CodeBlockLanguage = 'bash' | 'sh' | 'powershell' | 'pwsh' | 'cmd';

/** cmd:system:run-code-block payload。 */
export interface RunCodeBlockPayload {
  /** Markdown 面板绑定的 session;main/daemon 据此读 backend 与 currentCwd。 */
  sourceSessionId: string;
  /** 归一化后的 shell 语言(由 shared/markdown-command.ts resolveLanguage 得到)。 */
  language: CodeBlockLanguage;
  /** 代码块原文(已 trim 尾部空白)。main 端做长度上限校验。 */
  code: string;
}

/** cmd:system:run-code-block 返回。runId 用于后续 output/exited 事件匹配与 stop。 */
export interface RunCodeBlockResponse {
  runId: string;
}

/** cmd:system:stop-code-block payload。 */
export interface StopCodeBlockPayload {
  runId: string;
}

/**
 * evt:system:code-block-output payload。data 为 stdout/stderr 的 UTF-8 文本片段
 * (main 端已按 64KB 聚合切块,避免逐字符广播砸 IPC)。
 */
export interface CodeBlockOutputPayload {
  runId: string;
  stream: 'stdout' | 'stderr';
  data: string;
}

/** evt:system:code-block-exited payload。exitCode=null 表示被信号杀掉。 */
export interface CodeBlockExitedPayload {
  runId: string;
  exitCode: number | null;
  signal: string | null;
}

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

// ──────────────────────────────────────────────────────────────────
// Command panel(命令面板,ADR-028 / Feature G)
// ──────────────────────────────────────────────────────────────────

/**
 * 单条命令的刷新策略(per-指令,D4)。
 * - foreground:仅当用户切到该 tab 且面板可见时才跑(默认,大多数指令,省资源)。
 * - background-30s / background-5s:即便没在看也按固定频率后台跑(少数监控类)。
 * - manual:从不自动跑,只有用户点「立即刷新」才跑。
 * - off:暂停(不跑也不计入轮询);保留 tab 与历史输出。
 */
export type CommandRefreshStrategy =
  | 'foreground'
  | 'background-30s'
  | 'background-5s'
  | 'manual'
  | 'off';

/** 单条命令的运行状态机(D4)。 */
export type CommandRunStatus = 'idle' | 'running' | 'exited' | 'error';

/**
 * 命令面板里的一条指令(program-push,AI 经 marina run / HTTP /run 推送)。
 *
 * @关键设计:
 * - key 是稳定身份:同一 command 字符串去重 upsert(重跑复用同 key),避免重复 tab。
 * - command 是任意 shell 字符串(bash 执行);「引用内置脚本」不是独立形态,它就是
 *   command 的一种(如 `bash panel-scripts/map.sh`)。
 * - output 是最近一次运行的拼接输出(stdout+stderr),renderer 当 markdown 渲染。
 *   单条上限 OUTPUT_MAX_BYTES(防失控累积),超出尾部裁切保留最新。
 */
export interface CommandEntry {
  /** 稳定身份(由 command 派生),同 command 去重。 */
  key: string;
  /** 任意 shell 命令字符串(bash 执行)。 */
  command: string;
  /** 可选标题(展示用);缺省取 command 截断。 */
  title: string | null;
  /** per-指令 刷新策略。 */
  strategy: CommandRefreshStrategy;
  /** 最近一次 runId(用于匹配流式 output/exited 事件)。 */
  lastRunId: string | null;
  /** 最近一次退出码(null=仍在跑或被信号杀)。 */
  lastExitCode: number | null;
  /** 当前状态机位置。 */
  status: CommandRunStatus;
  /** 最近一次输出(stdout+stderr 拼接),renderer 当 markdown 渲染。 */
  output: string;
  /** 最近一次运行结束时间(epoch ms),用于展示。 */
  lastRunAt: number | null;
}

/** 命令面板快照(与 FilePanelSnapshot 对称)。 */
export interface CommandPanelSnapshot {
  /** 指令列表(按推送顺序)。 */
  commands: CommandEntry[];
  /** 当前展示的指令 key;无指令或无选中时为 null。 */
  activeKey: string | null;
}

/** 命令面板更新广播 payload(requestActivation 让 renderer 自动切到 command tab)。 */
export interface CommandPanelUpdatedPayload {
  sessionId: string;
  commands: CommandEntry[];
  activeKey: string | null;
  /** 仅推送新指令时 true,请求 renderer 激活命令面板。 */
  requestActivation?: boolean;
}

/** cmd:command-panel:get-state payload/返回。 */
export interface GetCommandPanelStatePayload {
  sessionId: string;
}

/** cmd:command-panel:run payload(推送/重跑一条指令)。 */
export interface RunCommandPayload {
  sessionId: string;
  /** 任意 shell 命令字符串(bash 执行,在 session.currentCwd 下)。 */
  command: string;
  /** 可选展示标题。 */
  title?: string | null;
}

/** cmd:command-panel:close payload。 */
export interface CloseCommandPayload {
  sessionId: string;
  commandKey: string;
}

/** cmd:command-panel:show payload。 */
export interface ShowCommandPayload {
  sessionId: string;
  commandKey: string;
}

/** cmd:command-panel:set-strategy payload。 */
export interface SetCommandStrategyPayload {
  sessionId: string;
  commandKey: string;
  strategy: CommandRefreshStrategy;
}

/** cmd:command-panel:set-demand payload(面板可见性/聚焦变化上报)。 */
export interface SetCommandDemandPayload {
  sessionId: string;
  /** none=切走/隐藏;warm=面板可见但未聚焦;hot=面板可见且聚焦。 */
  level: 'none' | 'warm' | 'hot';
}

/** evt:command-panel:exited payload。 */
export interface CommandExitedPayload {
  runId: string;
  exitCode: number | null;
  signal: string | null;
}

// 注:命令面板的流式 output/exited 复用 CodeBlockOutputPayload / CodeBlockExitedPayload
// + evt:system:code-block-output / exited(执行内核同为 CodeBlockRunner,runId 一致)。

/** cmd:file-panel:open / close / show payload。path 可相对 session.currentCwd。 */
export interface FilePanelActionPayload {
  sessionId: string;
  path: string;
}

/** v0.3.3 Feature B cmd:file-panel:open-path payload。markdown 文档里的本地文件
 * 链接点击 → main 相对 mdPath 所在目录解析 src 为本地绝对路径后进面板只读查看。
 * mdPath 必须是该 session 已打开列表里的 md 文件(同 ReadImagePayload 成员校验防线),
 * 防 renderer 被诱导用任意 mdPath + src 打开磁盘任意文件。 */
export interface OpenPathFromMarkdownPayload {
  sessionId: string;
  mdPath: string;
  src: string;
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

/** v0.3.3 Feature A cmd:gallery:resolve-image payload。src 是 gallery 代码块的
 * 某一行原值(本地图相对 md 目录 / 网络 http(s) URL)。sessionId + mdPath 复用
 * read-image 的成员校验防线(mdPath 必须是该 session 已打开的 md 文件),防
 * renderer 被诱导读任意本地图。网络图在 daemon 下载落盘后转 dataUrl 返回。 */
export interface GalleryResolveImagePayload {
  sessionId: string;
  mdPath: string;
  src: string;
}

/** cmd:gallery:resolve-image 返回。成功返 dataUrl(本地图直接读;网络图下载
 * 缓存后读);失败返 error(本地缺失/非图片/超限/网络超时/SSH 远程本地图不可达)。 */
export type GalleryResolveImageResponse = { dataUrl: string } | { error: string };

/** v0.3.3 Feature A cmd:gallery:open-image payload。与 resolve-image 同 payload;
 * main 端 resolve 到落盘后的绝对路径(本地图原路径;网络图下载缓存路径)后
 * 调 shell.openPath 调系统图片查看器。不把绝对路径返给 renderer(防泄露)。 */
export interface GalleryOpenImagePayload {
  sessionId: string;
  mdPath: string;
  src: string;
}

/** cmd:gallery:open-image 返回。ok=true 表示已触发系统查看器(具体是否打开成功
 * 由 OS 决定,shell.openPath 返回空串=无错误);error 时 renderer 可提示。 */
export type GalleryOpenImageResponse = { ok: true } | { error: string };

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

// ── v0.3.3 ADR-024 / Feature D:workspace 域 payload ──────────────────

/** 文件面板状态快照的一个运行结果条目(与 code-block-run-cache 的 snapshot 对齐)。 */
export interface WorkspaceRunEntry {
  key: string;
  state: string;
  output: string;
  exitCode: number | null;
}

/** bind 切换后推给 renderer 恢复的快照(<workspace>/__marina_state__/file-panel.json)。 */
export interface WorkspaceFilePanelSnapshot {
  version: 1;
  openedFiles: Array<{ path: string; kind: string; external: boolean }>;
  activeFilePath: string | null;
  scroll: Record<string, { scrollTop: number; scrollLeft: number }>;
  runs: WorkspaceRunEntry[];
}

/** list() 返回项。 */
export interface WorkspaceSummary {
  workspaceId: string;
  name: string | null;
  createdAt: number;
  closedAt: number | null;
  pinned: boolean;
  pathScope: string | null;
  fileCount: number;
}

/** bind 结果(CLI `bind` 打印 / renderer 决定是否推快照恢复)。 */
export interface WorkspaceBindResult {
  kind: 'created' | 'switched';
  workspaceId: string;
  dir: string;
  /** switched 才有:让 CLI 打印提示「已切到现有 X」。 */
  createdAt?: number;
  fileCount?: number;
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

/** cmd:file-tree:set-polling-demand payload。consumerId 只能取 envelope.windowId。 */
export interface SetFileTreePollingDemandPayload {
  sessionId: string;
  level: BackgroundDemandLevel;
}

/** FileTreePanel 上报的一个轮询目标目录(逻辑根 + 相对路径,不含绝对路径)。 */
export interface FileTreePollingDir {
  rootId: FileTreeRootId;
  /** 相对 root 的目录路径;根目录用空字符串。 */
  relativePath: string;
}

/** cmd:file-tree:set-watched-dirs payload(展开集合变化时上报;面板卸载时发空数组)。 */
export interface SetFileTreeWatchedDirsPayload {
  sessionId: string;
  dirs: FileTreePollingDir[];
}

/** evt:file-tree:changed payload:一次轮询中内容发生变化的目录(携带完整新快照)。 */
export interface FileTreeChangedPayload {
  sessionId: string;
  changes: Array<{
    rootId: FileTreeRootId;
    relativePath: string;
    snapshot: ListFileTreeDirectoryResponse;
  }>;
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
