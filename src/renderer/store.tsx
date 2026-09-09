/**
 * @file src/renderer/store.ts
 * @purpose Renderer 全局状态:从 main 拉取 snapshot 后维护本窗口可见的
 *   pathTree / sessions / windows / settings,加上窗口私有的 view state
 *   (selectedPathId / selectedSessionId / expandedPathIds)。
 *   订阅 evt:* 增量事件并 dispatch 对应 action。
 *
 * @关键设计:
 * - 不引入第三方状态库,用 React 内置 useReducer + Context (AGENTS.md
 *   1.2 边界 2 禁止未询问就加新包)
 * - 业务数据:全部来自 main snapshot + 事件增量;renderer 不持久化
 *   (软件定义书 9.2.2)
 * - View state:本窗口私有,不上 main (软件定义书 9.2.2)
 * - sessions 用 Map<sessionId, SessionInfo> 而非数组,便于 O(1) 查询;
 *   pathTree.sessionIds 数组保留索引顺序
 *
 * @对应文档章节: 软件定义书.md 9.2.2、9.3;ipc-protocol.md 第 4 (handshake)
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import {
  COMMAND_CHANNELS,
  EVENT_CHANNELS,
  type BookmarksUpdatedPayload,
  type FilePanelSnapshot,
  type FilePanelUpdatedPayload,
  type FilePanelHeadingNavigationPayload,
  type CommandPanelSnapshot,
  type CommandPanelUpdatedPayload,
  type MdThemeListUpdatedPayload,
  type GetSnapshotResponse,
  type PathTreeUpdatedPayload,
  type SessionCreatedPayload,
  type SessionDestroyedPayload,
  type SessionExitedPayload,
  type SessionOwnerChangedPayload,
  type SessionStateChangedPayload,
  type SettingsChangedPayload,
  // 外观归属客户端(local-control):远程窗口读写本机 appearance 的 payload
  type LocalAppearanceChangedPayload,
  type SshProfilesUpdatedPayload,
  type RemoteDaemonStatusPayload,
  type TemplateListUpdatedPayload,
  type WindowFocusRequestedPayload,
  type WindowListUpdatedPayload,
} from '@shared/protocol';
import type {
  Bookmark,
  FileKind,
  MdTheme,
  OpenedFile,
  PathNode,
  PathTree,
  SessionInfo,
  Settings,
  SshProfile,
  RemoteDaemonProfile,
  Template,
  WindowInfo,
} from '@shared/types';
import type { RegisteredPanelId } from './components/layout/panel-registry';
import { restoreWorkspaceSnapshot, scheduleWorkspaceSnapshotWrite } from './workspace-snapshot';

/** 滚动条目的内容类型:文件的 FileKind,或命令输出(ADR-037 整合后的内存源,
 * 无 FileKind;identity 路径约定 'command:<key>',与 MarkdownDocument 的
 * documentIdentity 同约定 —— 真实文件路径不会以 'command:' 开头,天然无冲突)。 */
export type FileViewerScrollKind = FileKind | 'command';

/** 右侧文件预览的像素滚动位置；按 sessionId + file.path + kind 隔离。 */
export interface FileViewerScrollPosition {
  kind: FileViewerScrollKind;
  scrollTop: number;
  scrollLeft: number;
}

export type FileViewerScrollState = Map<string, Map<string, FileViewerScrollPosition>>;

// ──────────────────────────────────────────────────────────────────
// State 定义
// ──────────────────────────────────────────────────────────────────

export interface AppState {
  // ── 全局数据 (来自 main) ─────────────────────────────
  pathTree: PathTree;
  sessions: Map<string, SessionInfo>;
  bookmarks: Bookmark[];
  sshProfiles: SshProfile[];
  /** v2.0 远程后端(§14.9):remote daemon profile 列表(public 副本) */
  remoteBackendProfiles: RemoteDaemonProfile[];
  /** v2.0 远程服务端运行状态(本窗口所连 daemon 的 server 状态) */
  remoteDaemonStatus: RemoteDaemonStatusPayload | null;
  windows: WindowInfo[];
  templates: Template[];
  defaultTemplateId: string;
  settings: Settings;

  // ── 本窗口元数据 ───────────────────────────────────
  myWindowId: string;
  myWindowNumber: number;

  // ── 本窗口私有 view state ────────────────────────────
  selectedPathId: string | null;
  selectedSessionId: string | null;
  expandedPathIds: Set<string>;
  /** 是否在设置视图 (CP-2 暂不实现设置 UI,字段保留供 CP-4) */
  inSettingsView: boolean;
  /**
   * 主区终端容器的最新尺寸估算 (cols/rows)。
   *
   * 用于 SESSION_CREATE 调用时传给 main 端 spawn PTY。
   * 关键作用 (CP-2 勘误):避免 spawn-then-resize 的 ConPTY 重画 quirk
   * 导致 PowerShell 启动横幅多次重复出现在 ring buffer 里。
   *
   * 来源:
   * 1. MainPane 的 ResizeObserver 用 main-pane 容器尺寸 + 字号粗估
   * 2. TerminalView 第一次 fit 后用 xterm.js 的真实 fit 结果覆盖 (更精确)
   *
   * 默认值 120×30 是一个常见终端尺寸,首次启动时若 ResizeObserver 还
   * 没跑够,用它当 fallback。
   */
  lastTerminalDims: { cols: number; rows: number };

  /**
   * BETA-027:简易页面模式 — 隐藏 Sidebar / Tab bar,只保留 WindowChrome
   * + 终端区。从 Explorer 右键"在 Marina 简易终端中打开"启动时默认 true;
   * 也可通过工具栏按钮(BETA-028)在普通页面里切换。本窗口私有,不跨窗口同步。
   */
  simpleMode: boolean;

  /**
   * 终端侧边文件面板:每个 session 独立的已打开文件快照。evt:file-panel
   * :updated 推来时覆盖该 session 的快照;session 销毁时清理。文件**内容**
   * 按需 cmd:file-panel:read,不存进 state(避免大文件占内存 + 切 tab 浪费)。
   */
  filePanels: Map<string, FilePanelSnapshot>;

  /**
   * Main 定向推来的未消费 Markdown 标题跳转 FIFO。它是一次性 view intent，不进入
   * FilePanelSnapshot/workspace 持久化；同 session 快速重复请求也必须逐个消费。
   */
  filePanelHeadingNavigations: Map<string, FilePanelHeadingNavigationPayload[]>;

  /**
   * 命令面板(v0.3.3 ADR-027):每个 session 独立的指令列表快照。evt:command-panel
   * :updated 推来时覆盖;session 销毁时清理。流式 output 不进 store(走
   * command-output-cache 按 runId 订阅,同 code-block-run-cache 模式)。
   */
  commandPanels: Map<string, CommandPanelSnapshot>;

  /**
   * 右侧 Markdown/Diff/Text/Image 预览滚动位置。本窗口私有 L1 view state,
   * 不写 main/localStorage；按 sessionId → OpenedFile.path → kind 保存。
   * 切文件/面板/session 可恢复，文件关闭或 session 销毁即清理。
   */
  fileViewerScroll: FileViewerScrollState;

  /**
   * 每个 session 在右侧 dock stack 里最后激活的面板(file-tree / file-panel)，
   * 本窗口私有 view state(不上 main)。LayoutHost.PanelStack 的 activePanelId
   * 完全由它驱动:用户点 tab、openFile 自动切换都写进这里，PanelStack remount
   * (进出设置页 / 简易模式 / 开关 file panel)时从此恢复，避免重挂后被历史
   * effect 再次抢回「已打开」、吞掉用户手动选择。session 销毁时清理。
   */
  activePanels: Map<string, RegisteredPanelId>;

  /**
   * v0.3.3 ADR-037:「已打开」面板内部正在看哪一侧 —— 'file'(打开文件)或
   * 'command'(AI 推送指令的输出)。命令面板整合进 file-panel 后,dock 级
   * activePanels 只能表达「面板本身」,面板内文件/命令两侧的切换由这里记录。
   *
   * 写入点:openFile / runCommand 的 requestActivation 事件(reducer 侧随
   * activePanels 一起写),以及用户点 tab(view/set-open-panel-view)。读取方
   * (FilePanel / LayoutHost SearchBar gate)用 resolveOpenPanelView 兜底:
   * 记录的一侧已空时回退另一侧。session 销毁 / file-panel/clear 清理。
   */
  openPanelViews: Map<string, 'file' | 'command'>;

  /**
   * 每个 session 最后被选中(成为本窗口正在看的终端)的时间戳(ms)。本窗口私有
   * view state(不上 main)。用于「关闭当前终端后自动续看」时在同目录多个无主
   * orphan 候选里按「最近使用的优先」排序(见 useCloseSession),而不是按侧栏/
   * tab 的创建顺序,更贴合「关一个、看下一个」的直觉。每次 select-session /
   * sessions/created(新终端选中)写一次;session 销毁时清理。
   */
  lastSelectedAt: Map<string, number>;

  /**
   * 每个 session 的终端视口滚动位置(topLine + 是否贴底)。本窗口私有 view state。
   *
   * 为什么放 store 而不是组件内/模块级:位置是「显示什么」的一部分(正如
   * selectedSessionId 决定显示哪个 session),应当是一等 view state,走同一条
   * 数据流——与 activePanels / lastSelectedAt / filePanels 等 per-session view
   * state 一致。TerminalView 用 key={session.id},切 session 会卸载重建 xterm,
   * 位置必须跨 mount 存活,放 store 天然跨 mount(模块级隐藏 Map 是不进数据流的
   * 旁路,与既有模式不一致且难观测/测试)。
   *
   * 写:TerminalView onScroll(累积到本地 ref,trailing debounce 写 store +
   * unmount 立即 flush,避免每帧 dispatch 重渲染)。读:mount/replay fence 读一次
   * 用于恢复。sessions/destroyed 清理,无界累积。
   */
  terminalScroll: Map<string, { topLine: number; wasAtBottom: boolean }>;

  /**
   * 自定义 markdown 面板主题列表(扫 userData/markdown-themes/*.css)。evt:md-
   * theme:list-updated 推来时整体替换;启动时 cmd:md-theme:list 拉一次。设置页
   * 下拉据此渲染选项;CSS 内容不存 state(按需 cmd:md-theme:get-css 注入)。
   */
  mdThemes: MdTheme[];
}

const EMPTY_TREE: PathTree = {
  bookmarks: [],
  temporary: [],
  recent: [],
  groups: [],
};

// ──────────────────────────────────────────────────────────────────
// Action
// ──────────────────────────────────────────────────────────────────

export type AppAction =
  | { type: 'snapshot/load'; snapshot: GetSnapshotResponse }
  | { type: 'pathTree/update'; tree: PathTree }
  | { type: 'bookmarks/update'; bookmarks: Bookmark[] }
  | { type: 'sshProfiles/update'; profiles: SshProfile[] }
  | { type: 'remoteBackendProfiles/update'; profiles: RemoteDaemonProfile[] }
  | { type: 'remoteDaemonStatus/update'; status: RemoteDaemonStatusPayload | null }
  | { type: 'sessions/created'; session: SessionInfo }
  | { type: 'sessions/owner-changed'; sessionId: string; ownerWindowId: string | null }
  | { type: 'sessions/state-changed'; sessionId: string; changes: Partial<SessionInfo> }
  | { type: 'sessions/exited'; sessionId: string; exitCode: number }
  | { type: 'sessions/destroyed'; sessionId: string }
  | { type: 'windows/list-update'; windows: WindowInfo[] }
  | { type: 'settings/changed'; settings: Settings }
  // 远程窗口专用:daemon 的设置变更只应用非 appearance 字段(外观归本机)
  | { type: 'settings/backend-changed'; settings: Settings }
  // 远程窗口专用:本机 appearance 变更广播,只替换 appearance 块
  | { type: 'settings/local-appearance-changed'; appearance: Settings['appearance'] }
  | { type: 'templates/update'; templates: Template[]; defaultTemplateId: string }
  | { type: 'view/select-path'; pathId: string | null }
  | { type: 'view/select-session'; sessionId: string | null }
  | {
      type: 'view/terminal-scroll';
      sessionId: string;
      topLine: number;
      wasAtBottom: boolean;
    }
  | {
      type: 'view/file-viewer-scroll';
      sessionId: string;
      /** 文件绝对路径,或 'command:<key>'(命令输出滚动记忆)。 */
      path: string;
      kind: FileViewerScrollKind;
      scrollTop: number;
      scrollLeft: number;
    }
  | { type: 'view/toggle-path-expand'; pathId: string }
  | { type: 'view/toggle-simple-mode' }
  | { type: 'view/set-simple-mode'; value: boolean }
  | { type: 'view/expand-path'; pathId: string }
  | { type: 'view/enter-settings' }
  | { type: 'view/exit-settings' }
  | {
      type: 'view/focus-requested';
      selectSessionId?: string;
      enterSettings?: boolean;
    }
  | { type: 'view/update-terminal-dims'; dims: { cols: number; rows: number } }
  | {
      type: 'file-panel/updated';
      sessionId: string;
      files: OpenedFile[];
      activePath: string | null;
      /** openFile 成功时为 true，请求 LayoutHost 激活「已打开」面板。 */
      requestActivation: boolean;
    }
  | {
      type: 'file-panel/heading-navigation-requested';
      request: FilePanelHeadingNavigationPayload;
    }
  | {
      type: 'file-panel/heading-navigation-consumed';
      sessionId: string;
      requestId: string;
    }
  | {
      type: 'command-panel/updated';
      sessionId: string;
      commands: CommandPanelSnapshot['commands'];
      activeKey: string | null;
      /** 推送新指令时为 true,请求 LayoutHost 激活「命令」面板。 */
      requestActivation: boolean;
    }
  | { type: 'file-panel/clear'; sessionId: string }
  | {
      type: 'view/set-active-panel';
      sessionId: string;
      panelId: RegisteredPanelId;
    }
  | {
      /** ADR-037:用户在「已打开」面板内点文件/命令 tab 时记录正在看哪一侧。 */
      type: 'view/set-open-panel-view';
      sessionId: string;
      view: 'file' | 'command';
    }
  | {
      /**
       * v0.3.3 ADR-024:bind 后 renderer 只恢复 scroll；完整 openedFiles/active 由 main
       * FilePanelService 先通过 file-panel/updated 给出，runs 进独立缓存。
       */
      type: 'workspace/snapshot-restored';
      sessionId: string;
      scroll: Record<string, { scrollTop: number; scrollLeft: number; kind: FileKind }>;
    }
  | { type: 'md-themes/update'; themes: MdTheme[] };

// ──────────────────────────────────────────────────────────────────
// Reducer
// ──────────────────────────────────────────────────────────────────

function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'snapshot/load': {
      const s = action.snapshot;
      const sessionsMap = new Map(s.sessions.map((sess) => [sess.id, sess]));
      // 默认选中第一个收藏路径 (若有);否则不选
      const firstBookmark = s.pathTree.bookmarks[0];
      return {
        ...state,
        pathTree: s.pathTree,
        sessions: sessionsMap,
        windows: s.windows,
        sshProfiles: s.sshProfiles,
        remoteBackendProfiles: s.remoteBackendProfiles,
        templates: s.templates,
        defaultTemplateId: s.defaultTemplateId,
        settings: s.settings,
        // 远程后端窗口的真实 owner id 不是本地 BrowserWindow 的 windowId,而是
        // daemon 在 WS auth 后分配的 clientId。SessionManager.createSession 也会用
        // 这个 clientId 写 session.ownerWindowId。若这里继续保留 preload URL 里的
        // 本地 windowId,新建远程 session 会被 getDisplayableSession 误判为“别人持有”,
        // TerminalView 不挂载,用户看到的现象就是“连接成功但打不开终端”。
        myWindowId: s.myWindowId,
        // bookmarks 不从 pathTree 派生 — 完整列表由 evt:bookmarks:updated
        // 单独同步,snapshot 期先置空,等首个 bookmarks/update 来填。
        bookmarks: [],
        selectedPathId: state.selectedPathId ?? firstBookmark?.id ?? null,
      };
    }
    case 'pathTree/update': {
      const selectedPathStillExists =
        state.selectedPathId !== null &&
        findPathNode(action.tree, state.selectedPathId) !== undefined;
      const validPathIds = new Set([
        ...action.tree.bookmarks.map((p) => p.id),
        ...action.tree.temporary.map((p) => p.id),
        ...action.tree.recent.map((p) => p.id),
      ]);
      const expandedPathIds = new Set(
        [...state.expandedPathIds].filter((pathId) => validPathIds.has(pathId)),
      );
      return {
        ...state,
        pathTree: action.tree,
        expandedPathIds,
        selectedPathId: selectedPathStillExists ? state.selectedPathId : null,
        selectedSessionId: selectedPathStillExists ? state.selectedSessionId : null,
      };
    }

    case 'bookmarks/update':
      return { ...state, bookmarks: action.bookmarks };

    case 'sshProfiles/update':
      return { ...state, sshProfiles: action.profiles };
    case 'remoteBackendProfiles/update':
      return { ...state, remoteBackendProfiles: action.profiles };
    case 'remoteDaemonStatus/update':
      return { ...state, remoteDaemonStatus: action.status };

    case 'sessions/created': {
      const sessions = new Map(state.sessions);
      sessions.set(action.session.id, action.session);
      // 新创建且属于本窗口 (双击 path / + 按钮 / 模板按钮 等场景):
      // 立即把它设为 selected。这样后续的 evt:session:owner-changed
      // (释放本窗口旧 owner) 到达时,selectedSessionId 已是新 session,
      // displayable 不会闪到 EmptyPathState (用户勘误后续 #1 闪 + 现象)。
      if (action.session.ownerWindowId === state.myWindowId) {
        // BETA-042:新 session 自动展开所属 path。覆盖两个场景:
        // (a) Explorer 右键"在 Marina 终端打开"开新窗口时,sidebar 默认折叠,
        //     用户看不到刚创建的 session
        // (b) 模板按钮 / + 双击在已折叠 path 上创建 session 时,直观应展开
        const expandedPathIds = new Set(state.expandedPathIds);
        if (action.session.pathId) {
          expandedPathIds.add(action.session.pathId);
        }
        // 新建即选中 → 记录最后选中时间,与 view/select-session 一致
        // (关闭当前终端续看时按最近使用排序,新终端现在就是最近使用的)。
        const lastSelectedAt = new Map(state.lastSelectedAt);
        lastSelectedAt.set(action.session.id, Date.now());
        return {
          ...state,
          sessions,
          selectedSessionId: action.session.id,
          // 同时确保 selectedPathId 是新 session 的 path
          selectedPathId: action.session.pathId || state.selectedPathId,
          expandedPathIds,
          lastSelectedAt,
        };
      }
      return { ...state, sessions };
    }

    case 'sessions/owner-changed': {
      const existing = state.sessions.get(action.sessionId);
      if (!existing) return state;
      // 同值短路:避免乐观更新后 main broadcast 同样的值再次触发渲染
      if (existing.ownerWindowId === action.ownerWindowId) return state;
      const updated: SessionInfo = {
        ...existing,
        ownerWindowId: action.ownerWindowId,
      };
      const sessions = new Map(state.sessions);
      sessions.set(action.sessionId, updated);
      return { ...state, sessions };
    }

    case 'sessions/exited': {
      const existing = state.sessions.get(action.sessionId);
      if (!existing) return state;
      // ADR-008:'exited' 是新状态名 (取代 'tombstoned'),无 5 分钟自动消失。
      const updated: SessionInfo = {
        ...existing,
        state: 'exited',
        exitCode: action.exitCode,
        exitedAt: Date.now(),
      };
      const sessions = new Map(state.sessions);
      sessions.set(action.sessionId, updated);
      return { ...state, sessions };
    }

    case 'sessions/state-changed': {
      // 由 main 的 evt:session:state-changed 推送。覆盖任意子集字段:
      // state (active/idle/exited)、currentCwd、exitCode、exitedAt 等。
      const existing = state.sessions.get(action.sessionId);
      if (!existing) return state;
      const merged: SessionInfo = { ...existing, ...action.changes };
      const sessions = new Map(state.sessions);
      sessions.set(action.sessionId, merged);
      return { ...state, sessions };
    }

    case 'templates/update':
      return {
        ...state,
        templates: action.templates,
        defaultTemplateId: action.defaultTemplateId,
      };

    case 'sessions/destroyed': {
      const sessions = new Map(state.sessions);
      sessions.delete(action.sessionId);
      // 文件面板:session 没了,清掉快照、预览滚动位置与活动面板记录。
      const filePanels = new Map(state.filePanels);
      filePanels.delete(action.sessionId);
      const filePanelHeadingNavigations = new Map(state.filePanelHeadingNavigations);
      filePanelHeadingNavigations.delete(action.sessionId);
      // 命令面板:同理清掋指令列表快照。
      const commandPanels = new Map(state.commandPanels);
      commandPanels.delete(action.sessionId);
      const fileViewerScroll = new Map(state.fileViewerScroll);
      fileViewerScroll.delete(action.sessionId);
      const activePanels = new Map(state.activePanels);
      activePanels.delete(action.sessionId);
      const openPanelViews = new Map(state.openPanelViews);
      openPanelViews.delete(action.sessionId);
      const lastSelectedAt = new Map(state.lastSelectedAt);
      lastSelectedAt.delete(action.sessionId);
      const terminalScroll = new Map(state.terminalScroll);
      terminalScroll.delete(action.sessionId);
      const next: AppState = {
        ...state,
        sessions,
        filePanels,
        filePanelHeadingNavigations,
        commandPanels,
        fileViewerScroll,
        activePanels,
        openPanelViews,
        lastSelectedAt,
        terminalScroll,
      };
      // 当前选中的 session 被销毁 → 取消选中
      if (state.selectedSessionId === action.sessionId) {
        next.selectedSessionId = null;
      }
      return next;
    }

    case 'file-panel/updated': {
      const filePanels = new Map(state.filePanels);
      filePanels.set(action.sessionId, {
        files: action.files,
        activePath: action.activePath,
      });

      // 关闭文件时同步裁掉它的 view state；仅切 activePath 不清其他仍打开文件。
      // kind 变化也视为另一个 viewer 身份。late unmount flush 到达后,下面的
      // view/file-viewer-scroll 还会再次校验当前 snapshot,不会把已关条目复活。
      let fileViewerScroll = state.fileViewerScroll;
      const previousScroll = state.fileViewerScroll.get(action.sessionId);
      if (previousScroll) {
        const allowed = new Map(action.files.map((file) => [file.path, file.kind]));
        // command: 条目属于命令面板(ADR-037 后同 session 同 bucket 共存),
        // 文件列表变化不裁它们 —— 它们的裁剪在 command-panel/updated 里做。
        const kept = new Map(
          [...previousScroll].filter(([path, position]) =>
            path.startsWith('command:')
              ? position.kind === 'command'
              : allowed.get(path) === position.kind,
          ),
        );
        if (kept.size !== previousScroll.size) {
          fileViewerScroll = new Map(state.fileViewerScroll);
          if (kept.size > 0) fileViewerScroll.set(action.sessionId, kept);
          else fileViewerScroll.delete(action.sessionId);
        }
      }
      // 文件已关闭时同步丢弃该路径尚未执行的目标，避免以后同 session 同路径重开
      // 时错误重放。正常 watcher 更新 files 仍含目标路径，不影响 pending FIFO。
      let filePanelHeadingNavigations = state.filePanelHeadingNavigations;
      const pendingNavigations = state.filePanelHeadingNavigations.get(action.sessionId);
      if (pendingNavigations) {
        const openPaths = new Set(action.files.map((file) => file.path));
        const kept = pendingNavigations.filter((request) => openPaths.has(request.path));
        if (kept.length !== pendingNavigations.length) {
          filePanelHeadingNavigations = new Map(state.filePanelHeadingNavigations);
          if (kept.length > 0) filePanelHeadingNavigations.set(action.sessionId, kept);
          else filePanelHeadingNavigations.delete(action.sessionId);
        }
      }
      // requestActivation=true(openFile 成功)时把活动面板设为「已打开」。reducer
      // 在事件到达时即写 activePanels,无论 PanelStack 是否挂载:remount 后从 store
      // 读到正确值(不抢用户手动切回的焦点),PanelStack 卸载期间(设置页/简易模式)
      // 发生的新请求也不丢。LayoutHost 解析时再校验 file-panel 是否属于当前 stack,
      // 不属于则回退。幂等:已是 file-panel 则只更新 filePanels。
      // ADR-037:同时记录面板内正在看「文件」侧(openFile 语义上选中一个文件)。
      if (action.requestActivation) {
        const activePanels = new Map(state.activePanels);
        activePanels.set(action.sessionId, 'file-panel');
        const openPanelViews = new Map(state.openPanelViews);
        openPanelViews.set(action.sessionId, 'file');
        return {
          ...state,
          filePanels,
          fileViewerScroll,
          filePanelHeadingNavigations,
          activePanels,
          openPanelViews,
        };
      }
      return { ...state, filePanels, fileViewerScroll, filePanelHeadingNavigations };
    }
    case 'file-panel/heading-navigation-requested': {
      const current = state.filePanelHeadingNavigations.get(action.request.sessionId) ?? [];
      if (current.some((request) => request.requestId === action.request.requestId)) return state;
      const filePanelHeadingNavigations = new Map(state.filePanelHeadingNavigations);
      filePanelHeadingNavigations.set(action.request.sessionId, [...current, action.request]);
      return { ...state, filePanelHeadingNavigations };
    }
    case 'file-panel/heading-navigation-consumed': {
      const current = state.filePanelHeadingNavigations.get(action.sessionId);
      if (!current?.some((request) => request.requestId === action.requestId)) return state;
      const remaining = current.filter((request) => request.requestId !== action.requestId);
      const filePanelHeadingNavigations = new Map(state.filePanelHeadingNavigations);
      if (remaining.length > 0) filePanelHeadingNavigations.set(action.sessionId, remaining);
      else filePanelHeadingNavigations.delete(action.sessionId);
      return { ...state, filePanelHeadingNavigations };
    }
    case 'command-panel/updated': {
      const commandPanels = new Map(state.commandPanels);
      commandPanels.set(action.sessionId, {
        commands: action.commands,
        activeKey: action.activeKey,
      });
      // 关闭命令 tab 时同步裁掉它的滚动记忆(镜像 file-panel/updated 对文件的
      // 裁剪;文件条目不受这里影响)。
      let fileViewerScroll = state.fileViewerScroll;
      const previousScroll = state.fileViewerScroll.get(action.sessionId);
      if (previousScroll) {
        const commandKeys = new Set(action.commands.map((c) => `command:${c.key}`));
        const kept = new Map(
          [...previousScroll].filter(
            ([path, position]) => !path.startsWith('command:') || (position.kind === 'command' && commandKeys.has(path)),
          ),
        );
        if (kept.size !== previousScroll.size) {
          fileViewerScroll = new Map(state.fileViewerScroll);
          if (kept.size > 0) fileViewerScroll.set(action.sessionId, kept);
          else fileViewerScroll.delete(action.sessionId);
        }
      }
      // ADR-037:命令面板整合进「已打开」后,runCommand 的 requestActivation 不再
      // 切到独立 command dock(已不存在),而是 1) 激活 file-panel dock +
      // 2) 记录面板内正在看「命令」侧 —— main 端 activeKey 已指向该指令,FilePanel
      // 据此渲染命令 tab。幂等:同值只更新 commandPanels。
      if (action.requestActivation) {
        const activePanels = new Map(state.activePanels);
        activePanels.set(action.sessionId, 'file-panel');
        const openPanelViews = new Map(state.openPanelViews);
        openPanelViews.set(action.sessionId, 'command');
        return { ...state, commandPanels, activePanels, openPanelViews, fileViewerScroll };
      }
      return { ...state, commandPanels, fileViewerScroll };
    }
    case 'workspace/snapshot-restored': {
      // 文件列表/active 已由有完整 stat 元数据的 file-panel/updated 更新；这里仅补
      // renderer 私有 scroll。runs 由 code-block-run-cache 单独导入。
      const scrollMap = new Map<string, FileViewerScrollPosition>();
      for (const [path, pos] of Object.entries(action.scroll)) {
        scrollMap.set(path, {
          kind: pos.kind,
          scrollTop: pos.scrollTop,
          scrollLeft: pos.scrollLeft,
        });
      }
      const fileViewerScroll = new Map(state.fileViewerScroll);
      if (scrollMap.size > 0) fileViewerScroll.set(action.sessionId, scrollMap);
      else fileViewerScroll.delete(action.sessionId);
      return { ...state, fileViewerScroll };
    }
    case 'file-panel/clear': {
      // 快照、导航、viewer scroll、active panel、面板内视图任一有记录都统一清理。
      if (
        !state.filePanels.has(action.sessionId) &&
        !state.filePanelHeadingNavigations.has(action.sessionId) &&
        !state.fileViewerScroll.has(action.sessionId) &&
        !state.activePanels.has(action.sessionId) &&
        !state.openPanelViews.has(action.sessionId)
      ) {
        return state;
      }
      const filePanels = new Map(state.filePanels);
      filePanels.delete(action.sessionId);
      const filePanelHeadingNavigations = new Map(state.filePanelHeadingNavigations);
      filePanelHeadingNavigations.delete(action.sessionId);
      const fileViewerScroll = new Map(state.fileViewerScroll);
      fileViewerScroll.delete(action.sessionId);
      const activePanels = new Map(state.activePanels);
      activePanels.delete(action.sessionId);
      const openPanelViews = new Map(state.openPanelViews);
      openPanelViews.delete(action.sessionId);
      return {
        ...state,
        filePanels,
        filePanelHeadingNavigations,
        fileViewerScroll,
        activePanels,
        openPanelViews,
      };
    }

    case 'view/set-active-panel': {
      // 用户点 tab 切换面板的唯一写入点(openFile 自动切换不走这里,而走
      // file-panel/updated reducer 的 requestActivation 分支)。幂等:重复设同值
      // 返回原 state(避免无谓 re-render)。
      if (state.activePanels.get(action.sessionId) === action.panelId) return state;
      const activePanels = new Map(state.activePanels);
      activePanels.set(action.sessionId, action.panelId);
      return { ...state, activePanels };
    }

    case 'view/set-open-panel-view': {
      // 用户点「已打开」面板内的文件/命令 tab。与 view/set-active-panel 同款幂等。
      // 程序推送(openFile / runCommand)不走这里,走各自 updated reducer 的
      // requestActivation 分支(那里同时切 activePanels 和本字段)。
      if (state.openPanelViews.get(action.sessionId) === action.view) return state;
      const openPanelViews = new Map(state.openPanelViews);
      openPanelViews.set(action.sessionId, action.view);
      return { ...state, openPanelViews };
    }

    case 'md-themes/update':
      return { ...state, mdThemes: action.themes };

    case 'windows/list-update':
      return { ...state, windows: action.windows };

    case 'settings/changed':
      return { ...state, settings: action.settings };
    case 'settings/backend-changed': {
      // 远程窗口:daemon 的设置变更只保留非 appearance 字段 —— 外观归本机,
      // 不能被 daemon 的 appearance 覆盖(否则远程窗口会跳回 daemon 主题/字体)。
      return { ...state, settings: { ...action.settings, appearance: state.settings.appearance } };
    }
    case 'settings/local-appearance-changed': {
      // 远程窗口:本机 appearance 变更广播(local-control),实时同步本机外观。
      return { ...state, settings: { ...state.settings, appearance: action.appearance } };
    }

    case 'view/select-path': {
      // 选中 path 时自动展开它
      const expanded = new Set(state.expandedPathIds);
      if (action.pathId) expanded.add(action.pathId);

      // CP-2 勘误后:"持有 = 显示"语义。切 path 时只能自动选中本窗口
      // 已 owner 的 session;不能选 orphan / 他人持有的,因为那需要 invoke
      // claim / focus-owner (副作用,不能在 reducer 里做)。用户必须显式
      // 点击 tab 才会切换 owner。
      // 如果该 path 下没有本窗口持有的 session → selectedSessionId=null
      // → MainPane 显示 EmptyPathState (新建终端页面)。
      //
      // issue #4:hideTopTabBar=true 时强制走 EmptyPathState 路径,
      // 用户切到已有 session 必须从 Sidebar 显式点 SessionItem。
      // 注意:这里不能加 `action.pathId !== state.selectedPathId` 守卫 —
      // 否则当前 path 已选中时再点同一 path 不会清空 selectedSessionId,
      // 用户得"先切 B 再切回 A"才能看到新建页(用户反馈 issue #4 续)。
      let selectedSessionId: string | null = state.selectedSessionId;
      if (state.settings.appearance?.hideTopTabBar) {
        selectedSessionId = null;
      } else if (action.pathId !== state.selectedPathId) {
        const node = findPathNode(state.pathTree, action.pathId ?? '');
        const myOwnedSid =
          node?.sessionIds.find((sid) => {
            const s = state.sessions.get(sid);
            return s?.ownerWindowId === state.myWindowId;
          }) ?? null;
        selectedSessionId = myOwnedSid;
      }
      return {
        ...state,
        selectedPathId: action.pathId,
        selectedSessionId,
        expandedPathIds: expanded,
      };
    }

    case 'view/select-session': {
      // 记录「最后选中时间」,供关闭当前终端后按最近使用顺序续看(useCloseSession)。
      if (action.sessionId) {
        const lastSelectedAt = new Map(state.lastSelectedAt);
        lastSelectedAt.set(action.sessionId, Date.now());
        return {
          ...state,
          selectedSessionId: action.sessionId,
          lastSelectedAt,
        };
      }
      return { ...state, selectedSessionId: action.sessionId };
    }

    case 'view/terminal-scroll': {
      // 终端视口滚动位置记忆(一等 view state)。TerminalView onScroll 累积后
      // trailing debounce 写进来;切 session 重挂时 replay fence 读一次恢复。
      // 写频率已在外层限制,这里只做幂等覆盖。
      const terminalScroll = new Map(state.terminalScroll);
      terminalScroll.set(action.sessionId, {
        topLine: action.topLine,
        wasAtBottom: action.wasAtBottom,
      });
      return { ...state, terminalScroll };
    }

    case 'view/file-viewer-scroll': {
      // late cleanup 防线:只有当前 snapshot 里仍存在的条目能写。
      // 文件已关闭/session 已清时直接拒绝,避免 unmount flush 复活陈旧条目。
      // 命令条目('command:<key>')按 commandPanels 当前列表校验,同理。
      if (action.path.startsWith('command:')) {
        const commandExists = state.commandPanels
          .get(action.sessionId)
          ?.commands.some((candidate) => `command:${candidate.key}` === action.path);
        if (!commandExists || action.kind !== 'command') return state;
      } else {
        const file = state.filePanels
          .get(action.sessionId)
          ?.files.find((candidate) => candidate.path === action.path);
        if (!file || file.kind !== action.kind) return state;
      }
      if (!Number.isFinite(action.scrollTop) || !Number.isFinite(action.scrollLeft)) {
        return state;
      }
      const scrollTop = Math.max(0, action.scrollTop);
      const scrollLeft = Math.max(0, action.scrollLeft);
      const existing = state.fileViewerScroll.get(action.sessionId)?.get(action.path);
      if (
        existing?.kind === action.kind &&
        existing.scrollTop === scrollTop &&
        existing.scrollLeft === scrollLeft
      ) {
        return state;
      }
      const sessionScroll = new Map(state.fileViewerScroll.get(action.sessionId) ?? []);
      sessionScroll.set(action.path, { kind: action.kind, scrollTop, scrollLeft });
      const fileViewerScroll = new Map(state.fileViewerScroll);
      fileViewerScroll.set(action.sessionId, sessionScroll);
      return { ...state, fileViewerScroll };
    }

    case 'view/toggle-path-expand': {
      const expanded = new Set(state.expandedPathIds);
      if (expanded.has(action.pathId)) expanded.delete(action.pathId);
      else expanded.add(action.pathId);
      return { ...state, expandedPathIds: expanded };
    }

    case 'view/toggle-simple-mode':
      return { ...state, simpleMode: !state.simpleMode };

    case 'view/set-simple-mode':
      return { ...state, simpleMode: action.value };

    case 'view/expand-path': {
      if (state.expandedPathIds.has(action.pathId)) return state;
      const expanded = new Set(state.expandedPathIds);
      expanded.add(action.pathId);
      return { ...state, expandedPathIds: expanded };
    }

    case 'view/enter-settings':
      return { ...state, inSettingsView: true };

    case 'view/exit-settings':
      return { ...state, inSettingsView: false };

    case 'view/focus-requested': {
      // session-click / tray-click / tray-session-click / tray-open-settings 等 main 推送的聚焦请求
      let next = state;
      if (action.selectSessionId) {
        const session = state.sessions.get(action.selectSessionId);
        if (session) {
          next = {
            ...next,
            selectedPathId: session.pathId,
            selectedSessionId: action.selectSessionId,
            inSettingsView: false, // 选 session 隐含退出 settings
          };
        }
      }
      if (action.enterSettings) {
        next = { ...next, inSettingsView: true };
      }
      return next;
    }

    case 'view/update-terminal-dims': {
      const { cols, rows } = action.dims;
      // 简单去抖:相同尺寸不更新 (避免无意义重渲染)
      if (state.lastTerminalDims.cols === cols && state.lastTerminalDims.rows === rows) {
        return state;
      }
      return { ...state, lastTerminalDims: { cols, rows } };
    }

    default:
      return state;
  }
}

/**
 * 仅供单元测试验证 reducer 的远程 owner 语义。生产代码仍通过 AppStateProvider
 * 使用 useReducer(reducer, ...),不要在组件里直接调用。
 */
export const __appReducerForTest = reducer;

/**
 * 在三栏(bookmarks / temporary / recent)里找指定 pathId 的 PathNode。
 *
 * 公共导出:多处需要按 pathId 拿完整 PathNode(选中路径 / Tab 右键拿 cwd /
 * 历史搜索 等),曾经有调用方在外面重写过这条 fallback 链(MainPane Tab 内
 * 找 path 字段,P2-13)。统一从这里导出。
 */
export function findPathNode(tree: PathTree, pathId: string): PathNode | undefined {
  return (
    tree.bookmarks.find((p) => p.id === pathId) ??
    tree.temporary.find((p) => p.id === pathId) ??
    tree.recent.find((p) => p.id === pathId)
  );
}

// ──────────────────────────────────────────────────────────────────
// 默认 state (handshake / snapshot 之前用)
// ──────────────────────────────────────────────────────────────────

export function makeDefaultState(myWindowId: string, myWindowNumber: number): AppState {
  return {
    pathTree: EMPTY_TREE,
    sessions: new Map(),
    bookmarks: [],
    sshProfiles: [],
    remoteBackendProfiles: [],
    remoteDaemonStatus: null,
    windows: [],
    templates: [],
    defaultTemplateId: 'shell',
    settings: {} as Settings, // 临时空对象,snapshot 加载后填充
    myWindowId,
    myWindowNumber,
    selectedPathId: null,
    selectedSessionId: null,
    expandedPathIds: new Set(),
    inSettingsView: false,
    lastTerminalDims: { cols: 120, rows: 30 },
    // BETA-027:默认普通页面;Explorer 简易模式打开时在 startup 显式 dispatch set
    simpleMode: false,
    filePanels: new Map(),
    filePanelHeadingNavigations: new Map(),
    commandPanels: new Map(),
    fileViewerScroll: new Map(),
    activePanels: new Map(),
    openPanelViews: new Map(),
    lastSelectedAt: new Map(),
    terminalScroll: new Map(),
    mdThemes: [],
  };
}

// ──────────────────────────────────────────────────────────────────
// Context
// ──────────────────────────────────────────────────────────────────

interface AppContextValue {
  state: AppState;
  dispatch: Dispatch<AppAction>;
}

const AppContext = createContext<AppContextValue | null>(null);
/**
 * 独立暴露一个永远指向最新 state 的 ref(value 引用永久稳定,消费者不会
 * 因为 state 变更触发重渲)。配合 React.memo 用,可以让列表项组件在事件
 * 回调里读全局 state、但渲染时不订阅 state — 抖动源 D 的破法。
 */
const AppStateRefContext = createContext<MutableRefObject<AppState> | null>(null);

export function AppStateProvider({
  myWindowId,
  myWindowNumber,
  children,
}: {
  myWindowId: string;
  myWindowNumber: number;
  children: ReactNode;
}): JSX.Element {
  const [state, dispatch] = useReducer(reducer, makeDefaultState(myWindowId, myWindowNumber));
  const value = useMemo(() => ({ state, dispatch }), [state]);
  // Render-phase ref 赋值:跨 commit 让 useAppStateRef 的消费者总能读到
  // 最新 state。React 文档允许 useRef 在 render 阶段被赋值 — 是 idiomatic
  // 的 "外部可变" 容器用法,不触发 re-render,也不破坏 concurrent rendering
  // (我们用 React 18 严格模式 mount 时会赋两次,值仍正确)。
  const stateRef = useRef(state);
  stateRef.current = state;
  // v0.3.3 ADR-028:选中某 session 时上报“已查看” → 清其 hasUnviewedWork
  // (侧栏指示灯警告色转正常)。per-session，任一窗口查看即清。选中=null 不发。
  // 放这里而非 reducer:发 IPC 是副作用，reducer 须纯。
  useEffect(() => {
    if (state.selectedSessionId) {
      void window.api.invoke(COMMAND_CHANNELS.SESSION_MARK_VIEWED, {
        sessionId: state.selectedSessionId,
      });
    }
  }, [state.selectedSessionId]);
  return (
    <AppStateRefContext.Provider value={stateRef}>
      <AppContext.Provider value={value}>{children}</AppContext.Provider>
    </AppStateRefContext.Provider>
  );
}

export function useAppState(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('[store] useAppState 必须在 AppStateProvider 内使用');
  return ctx.state;
}

export function useAppDispatch(): Dispatch<AppAction> {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('[store] useAppDispatch 必须在 AppStateProvider 内使用');
  return ctx.dispatch;
}

/**
 * 返回一个 ref,ref.current 永远指向最新 AppState。
 *
 * **只能在事件回调 / effect 里读 ref.current**;在渲染阶段读 ref.current
 * 拿到的值跟 useAppState() 一致,但 ref 的更新不会触发本组件重渲。
 *
 * 使用场景:列表项组件用 React.memo + 精确 props 跳过无关重渲,但其
 * onClick / onContextMenu 仍需要全局 state(如 templates、其他 session
 * 列表)。把这部分通过 stateRef 拿,渲染不订阅,事件读最新。
 */
export function useAppStateRef(): MutableRefObject<AppState> {
  const ref = useContext(AppStateRefContext);
  if (!ref) throw new Error('[store] useAppStateRef 必须在 AppStateProvider 内使用');
  return ref;
}

// ──────────────────────────────────────────────────────────────────
// IPC 同步 hook:订阅所有 evt:* 转 dispatch
// ──────────────────────────────────────────────────────────────────

/**
 * 在挂载时拉 snapshot + 订阅所有事件;卸载时取消订阅。
 * 必须在 AppStateProvider 内使用一次 (通常在 App 组件)。
 */
export function useIpcSync(): {
  ready: boolean;
  error: string | null;
  /** 远程连接失败的错误码(preload ConnectError.code,如 AUTH_REJECTED/TCP_UNREACHABLE)。null=非远程连接错误/未出错。 */
  errorCode: string | null;
} {
  const dispatch = useAppDispatch();
  const stateRef = useAppStateRef();
  const [status, setStatus] = useReducer(
    (
      _: { ready: boolean; error: string | null; errorCode: string | null },
      action: { type: 'ready' } | { type: 'error'; message: string; errorCode?: string | null },
    ) => {
      switch (action.type) {
        case 'ready':
          return { ready: true, error: null, errorCode: null };
        case 'error':
          return { ready: false, error: action.message, errorCode: action.errorCode ?? null };
        default:
          return { ready: false, error: null, errorCode: null };
      }
    },
    { ready: false, error: null, errorCode: null },
  );

  useEffect(() => {
    let cancelled = false;
    const cleanups: Array<() => void> = [];

    void (async () => {
      try {
        // 必须先订阅、后拉 snapshot。两者共用同一 IPC/WS 有序传输:
        // - snapshot 处理前发生的事件会包含在 snapshot 里;
        // - snapshot 响应后发生的事件会被已安装的 listener 接住。
        // 旧顺序“snapshot → 逐个订阅”在中间有空档,远程 create session 时可能
        // 丢 PATH_TREE_UPDATED / SESSION_CREATED,表现为服务端或其他窗口左侧缺项。
        cleanups.push(
          window.api.on<PathTreeUpdatedPayload>(EVENT_CHANNELS.PATH_TREE_UPDATED, (p) =>
            dispatch({ type: 'pathTree/update', tree: p.tree }),
          ),
          window.api.on<BookmarksUpdatedPayload>(EVENT_CHANNELS.BOOKMARKS_UPDATED, (p) =>
            dispatch({ type: 'bookmarks/update', bookmarks: p.bookmarks }),
          ),
          window.api.on<SshProfilesUpdatedPayload>(EVENT_CHANNELS.SSH_PROFILES_UPDATED, (p) =>
            dispatch({ type: 'sshProfiles/update', profiles: p.profiles }),
          ),
          window.api.on<{ profiles: RemoteDaemonProfile[] }>(
            EVENT_CHANNELS.REMOTE_PROFILES_UPDATED,
            (p) => dispatch({ type: 'remoteBackendProfiles/update', profiles: p.profiles }),
          ),
          window.api.on<RemoteDaemonStatusPayload>(
            EVENT_CHANNELS.REMOTE_DAEMON_STATUS_CHANGED,
            (s) => dispatch({ type: 'remoteDaemonStatus/update', status: s }),
          ),
          // 启动时主动拉一次 daemon 服务端状态(订阅只覆盖后续变化)。
          // 包成 IIFE 返回 cleanup,cleanups.push 要求每个参数是 () => void。
          (() => {
            void window.api
              .invoke(
                COMMAND_CHANNELS.REMOTE_DAEMON_GET_STATUS,
                undefined,
              )
              .then((r) => dispatch({ type: 'remoteDaemonStatus/update', status: r.status }))
              .catch(() => {
                /* 远程不可达 / 未初始化时静默 */
              });
            return () => {};
          })(),
          window.api.on<SessionCreatedPayload>(EVENT_CHANNELS.SESSION_CREATED, (p) =>
            dispatch({ type: 'sessions/created', session: p.session }),
          ),
          window.api.on<SessionOwnerChangedPayload>(EVENT_CHANNELS.SESSION_OWNER_CHANGED, (p) =>
            dispatch({
              type: 'sessions/owner-changed',
              sessionId: p.sessionId,
              ownerWindowId: p.newOwnerWindowId,
            }),
          ),
          window.api.on<SessionExitedPayload>(EVENT_CHANNELS.SESSION_EXITED, (p) =>
            dispatch({
              type: 'sessions/exited',
              sessionId: p.sessionId,
              exitCode: p.exitCode,
            }),
          ),
          window.api.on<SessionStateChangedPayload>(EVENT_CHANNELS.SESSION_STATE_CHANGED, (p) =>
            dispatch({
              type: 'sessions/state-changed',
              sessionId: p.sessionId,
              changes: p.changes,
            }),
          ),
          window.api.on<SessionDestroyedPayload>(EVENT_CHANNELS.SESSION_DESTROYED, (p) =>
            dispatch({ type: 'sessions/destroyed', sessionId: p.sessionId }),
          ),
          window.api.on<FilePanelUpdatedPayload>(EVENT_CHANNELS.FILE_PANEL_UPDATED, (p) => {
            dispatch({
              type: 'file-panel/updated',
              sessionId: p.sessionId,
              files: p.files,
              activePath: p.activePath,
              requestActivation: p.requestActivation === true,
            });
            // Feature D 写入端:文件面板(openedFiles/active)变化 → debounce 写快照。
            // getWorkspaceDir=null(workspace 路径需 IPC 查,这里降级:所有路径当
            // external 存绝对路径,restore 时绝对路径直接用,同机器恢复正确)。
            // scroll/runs 变化的写不在热路径触发(低频,缺失时 restore 跳过)。
            scheduleWorkspaceSnapshotWrite(
              p.sessionId,
              () => stateRef.current,
              () => null,
            );
          }),
          window.api.on<FilePanelHeadingNavigationPayload>(
            EVENT_CHANNELS.FILE_PANEL_HEADING_NAVIGATION_REQUESTED,
            (request) =>
              dispatch({
                type: 'file-panel/heading-navigation-requested',
                request,
              }),
          ),
          // v0.3.3 Feature D:workspace 切换完成。main 已重建 PanelState 并发了
          // filePanelUpdated(上面已同步 openedFiles/activePath);这里读新 workspace
          // 快照恢复 scroll/runs(workspace-snapshot.ts 已实现)。dispatch 闭包可拿。
          window.api.on<{ sessionId: string }>(EVENT_CHANNELS.WORKSPACE_CHANGED, (p) => {
            void restoreWorkspaceSnapshot(dispatch, p.sessionId);
          }),
          window.api.on<CommandPanelUpdatedPayload>(EVENT_CHANNELS.COMMAND_PANEL_UPDATED, (p) =>
            dispatch({
              type: 'command-panel/updated',
              sessionId: p.sessionId,
              commands: p.commands,
              activeKey: p.activeKey,
              requestActivation: p.requestActivation === true,
            }),
          ),
          window.api.on<MdThemeListUpdatedPayload>(EVENT_CHANNELS.MD_THEME_LIST_UPDATED, (p) =>
            dispatch({ type: 'md-themes/update', themes: p.themes }),
          ),
          window.api.on<TemplateListUpdatedPayload>(EVENT_CHANNELS.TEMPLATES_UPDATED, (p) =>
            dispatch({
              type: 'templates/update',
              templates: p.templates,
              defaultTemplateId: p.defaultTemplateId,
            }),
          ),
          window.api.on<WindowListUpdatedPayload>(EVENT_CHANNELS.WINDOW_LIST_UPDATED, (p) =>
            dispatch({ type: 'windows/list-update', windows: p.windows }),
          ),
          window.api.on<SettingsChangedPayload>(EVENT_CHANNELS.SETTINGS_CHANGED, (p) => {
            // 远程窗口:外观归本机。daemon 的设置变更走 backend-changed(保留本机 appearance);
            // 本地窗口整体替换(零回归)。
            if (window.api.backendProfileId) {
              dispatch({ type: 'settings/backend-changed', settings: p.settings });
            } else {
              dispatch({ type: 'settings/changed', settings: p.settings });
            }
          }),
          window.api.on<LocalAppearanceChangedPayload>(
            EVENT_CHANNELS.SETTINGS_LOCAL_APPEARANCE_CHANGED,
            (p) => {
              // 本机 appearance 变更广播(local-control)。仅远程窗口响应(实时同步本机外观);
              // 本地窗口已通过上面的 SETTINGS_CHANGED 更新,忽略避免双重刷新。
              if (window.api.backendProfileId) {
                dispatch({
                  type: 'settings/local-appearance-changed',
                  appearance: p.appearance,
                });
              }
            },
          ),
          window.api.on<WindowFocusRequestedPayload>(EVENT_CHANNELS.WINDOW_FOCUS_REQUESTED, (p) =>
            dispatch({
              type: 'view/focus-requested',
              ...(p.selectSessionId ? { selectSessionId: p.selectSessionId } : {}),
              ...(p.reason === 'tray-open-settings' ? { enterSettings: true } : {}),
            }),
          ),
        );

        const snapshot = await window.api.invoke(
          COMMAND_CHANNELS.APP_GET_SNAPSHOT,
          { myWindowId: window.api.windowId },
        );

        // remoteBackendProfiles 是“本客户端如何连接其他电脑”的本地控制面数据，
        // 不能信任远程 snapshot 里的同名字段:远程窗口的 snapshot 来自 daemon，
        // 那里保存的是 daemon 自己的 profile 列表。REMOTE_PROFILE_LIST 被声明为
        // local-control，远程窗口调用时也会走客户端本地 IPC。订阅已在上面先装好，
        // 因此后续新增/改名/删除由本地 REMOTE_PROFILES_UPDATED 持续同步。
        let localRemoteProfiles = snapshot.remoteBackendProfiles;
        try {
          const result = await window.api.invoke(
            COMMAND_CHANNELS.REMOTE_PROFILE_LIST,
            undefined,
          );
          localRemoteProfiles = result.profiles;
        } catch {
          // 本地 main 尚未注册该命令(协议不匹配)时保留 snapshot 值；握手版本检查
          // 通常会更早拦截，此处只做向后兼容兜底，不能让整个 UI 因 profile 列表失败。
        }

        // 外观归属客户端:远程窗口的 appearance 也必须用本机,而非 daemon —— 复刻
        // 上面 remoteBackendProfiles 的“本地控制面字段覆盖”模式。SETTINGS_GET_APPEARANCE
        // 是 local-control,远程窗口调用走客户端本地 IPC。本地窗口跳过(直接用 snapshot)。
        let localAppearance = snapshot.settings.appearance;
        if (window.api.backendProfileId) {
          try {
            const result = await window.api.invoke(
              COMMAND_CHANNELS.SETTINGS_GET_APPEARANCE,
              undefined,
            );
            localAppearance = result.appearance;
          } catch {
            // 本地 main 未注册该命令(协议不匹配)时保留 snapshot 的 daemon 外观;
            // 握手版本检查通常会更早拦截,此处仅向后兼容兜底,不让 UI 起不来。
          }
        }

        if (cancelled) return;
        dispatch({
          type: 'snapshot/load',
          snapshot: {
            ...snapshot,
            remoteBackendProfiles: localRemoteProfiles,
            settings: { ...snapshot.settings, appearance: localAppearance },
          },
        });

        // 自定义 markdown 主题列表:启动拉一次(订阅已覆盖后续增删广播)。
        // 失败不阻塞主流程 —— 设置页下拉只是少自定义项,内置主题仍可用。
        try {
          const { themes } = await window.api.invoke(
            COMMAND_CHANNELS.MD_THEME_LIST,
            undefined,
          );
          if (!cancelled) dispatch({ type: 'md-themes/update', themes });
        } catch (err) {
          console.warn('[md-theme] initial list failed', err);
        }

        setStatus({ type: 'ready' });
      } catch (err) {
        if (!cancelled) {
          // err 可能是 preload 抛的 ConnectError(带 code,如 AUTH_REJECTED/TCP_UNREACHABLE)
          // 或普通 Error。提取 code 供错误页给针对性诊断。
          const errorCode =
            err !== null &&
            typeof err === 'object' &&
            'code' in err &&
            typeof (err as { code?: unknown }).code === 'string'
              ? (err as { code: string }).code
              : null;
          setStatus({
            type: 'error',
            message: err instanceof Error ? err.message : String(err),
            errorCode,
          });
        }
      }
    })();

    return () => {
      cancelled = true;
      for (const c of cleanups) c();
    };
  }, [dispatch, stateRef]);

  return status;
}

/**
 * 帮助函数:从当前 state 推导出"当前选中 path 下的所有 session"。
 */
export function getSessionsInSelectedPath(state: AppState): SessionInfo[] {
  if (!state.selectedPathId) return [];
  const node = findPathNode(state.pathTree, state.selectedPathId);
  if (!node) return [];
  const result: SessionInfo[] = [];
  for (const sid of node.sessionIds) {
    const s = state.sessions.get(sid);
    if (s) result.push(s);
  }
  return result;
}

/**
 * 帮助函数:从当前 state 推导出当前选中 session 的完整 info。
 */
export function getSelectedSession(state: AppState): SessionInfo | null {
  if (!state.selectedSessionId) return null;
  return state.sessions.get(state.selectedSessionId) ?? null;
}

/**
 * 帮助函数:返回"本窗口当前正在显示"的 session — 即 selected 且 owner
 * 是 myWindow 的那一个。否则 null。
 *
 * CP-2 勘误后的"持有=显示"语义:TerminalView 仅在此函数返回非 null 时
 * 被挂载;返回 null 时 MainPane 应渲染 EmptyPathState。
 */
export function getDisplayableSession(state: AppState): SessionInfo | null {
  const s = getSelectedSession(state);
  if (!s) return null;
  return s.ownerWindowId === state.myWindowId ? s : null;
}

/**
 * 帮助函数:返回当前窗口正在持有的 session id。新模型下至多 1 个,
 * 没有则返回 null。乐观接管时用于"先释放旧的"和"失败回滚"。
 */
export function findMyOwnedSessionId(state: AppState): string | null {
  for (const s of state.sessions.values()) {
    if (s.ownerWindowId === state.myWindowId) return s.id;
  }
  return null;
}
