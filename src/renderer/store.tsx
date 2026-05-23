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
  type GetSnapshotResponse,
  type PathTreeUpdatedPayload,
  type SessionCreatedPayload,
  type SessionDestroyedPayload,
  type SessionExitedPayload,
  type SessionOwnerChangedPayload,
  type SessionStateChangedPayload,
  type SettingsChangedPayload,
  type SshProfilesUpdatedPayload,
  type TemplateListUpdatedPayload,
  type WindowFocusRequestedPayload,
  type WindowListUpdatedPayload,
} from '@shared/protocol';
import type {
  Bookmark,
  PathNode,
  PathTree,
  SessionInfo,
  Settings,
  SshProfile,
  Template,
  WindowInfo,
} from '@shared/types';

// ──────────────────────────────────────────────────────────────────
// State 定义
// ──────────────────────────────────────────────────────────────────

export interface AppState {
  // ── 全局数据 (来自 main) ─────────────────────────────
  pathTree: PathTree;
  sessions: Map<string, SessionInfo>;
  bookmarks: Bookmark[];
  sshProfiles: SshProfile[];
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
}

const EMPTY_TREE: PathTree = {
  bookmarks: [],
  temporary: [],
  recent: [],
};

// ──────────────────────────────────────────────────────────────────
// Action
// ──────────────────────────────────────────────────────────────────

export type AppAction =
  | { type: 'snapshot/load'; snapshot: GetSnapshotResponse }
  | { type: 'pathTree/update'; tree: PathTree }
  | { type: 'bookmarks/update'; bookmarks: Bookmark[] }
  | { type: 'sshProfiles/update'; profiles: SshProfile[] }
  | { type: 'sessions/created'; session: SessionInfo }
  | { type: 'sessions/owner-changed'; sessionId: string; ownerWindowId: string | null }
  | { type: 'sessions/state-changed'; sessionId: string; changes: Partial<SessionInfo> }
  | { type: 'sessions/exited'; sessionId: string; exitCode: number }
  | { type: 'sessions/destroyed'; sessionId: string }
  | { type: 'windows/list-update'; windows: WindowInfo[] }
  | { type: 'settings/changed'; settings: Settings }
  | { type: 'templates/update'; templates: Template[]; defaultTemplateId: string }
  | { type: 'view/select-path'; pathId: string | null }
  | { type: 'view/select-session'; sessionId: string | null }
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
  | { type: 'view/update-terminal-dims'; dims: { cols: number; rows: number } };

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
        templates: s.templates,
        defaultTemplateId: s.defaultTemplateId,
        settings: s.settings,
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
        return {
          ...state,
          sessions,
          selectedSessionId: action.session.id,
          // 同时确保 selectedPathId 是新 session 的 path
          selectedPathId: action.session.pathId || state.selectedPathId,
          expandedPathIds,
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
      const next: AppState = { ...state, sessions };
      // 当前选中的 session 被销毁 → 取消选中
      if (state.selectedSessionId === action.sessionId) {
        next.selectedSessionId = null;
      }
      return next;
    }

    case 'windows/list-update':
      return { ...state, windows: action.windows };

    case 'settings/changed':
      return { ...state, settings: action.settings };

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
      let selectedSessionId: string | null = state.selectedSessionId;
      if (action.pathId !== state.selectedPathId) {
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

    case 'view/select-session':
      return { ...state, selectedSessionId: action.sessionId };

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
      if (
        state.lastTerminalDims.cols === cols &&
        state.lastTerminalDims.rows === rows
      ) {
        return state;
      }
      return { ...state, lastTerminalDims: { cols, rows } };
    }

    default:
      return state;
  }
}

/**
 * 在三栏(bookmarks / temporary / recent)里找指定 pathId 的 PathNode。
 *
 * 公共导出:多处需要按 pathId 拿完整 PathNode(选中路径 / Tab 右键拿 cwd /
 * 历史搜索 等),曾经有调用方在外面重写过这条 fallback 链(MainPane Tab 内
 * 找 path 字段,P2-13)。统一从这里导出。
 */
export function findPathNode(
  tree: PathTree,
  pathId: string,
): PathNode | undefined {
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
export function useIpcSync(): { ready: boolean; error: string | null } {
  const dispatch = useAppDispatch();
  const myWindowId = useAppState().myWindowId;
  const [status, setStatus] = useReducer(
    (
      _: { ready: boolean; error: string | null },
      action:
        | { type: 'ready' }
        | { type: 'error'; message: string },
    ) => {
      switch (action.type) {
        case 'ready':
          return { ready: true, error: null };
        case 'error':
          return { ready: false, error: action.message };
        default:
          return { ready: false, error: null };
      }
    },
    { ready: false, error: null },
  );

  useEffect(() => {
    let cancelled = false;
    const cleanups: Array<() => void> = [];

    void (async () => {
      try {
        const snapshot = await window.api.invoke<
          { myWindowId: string },
          GetSnapshotResponse
        >(COMMAND_CHANNELS.APP_GET_SNAPSHOT, { myWindowId });
        if (cancelled) return;
        dispatch({ type: 'snapshot/load', snapshot });

        // 订阅事件
        cleanups.push(
          window.api.on<PathTreeUpdatedPayload>(
            EVENT_CHANNELS.PATH_TREE_UPDATED,
            (p) => dispatch({ type: 'pathTree/update', tree: p.tree }),
          ),
          window.api.on<BookmarksUpdatedPayload>(
            EVENT_CHANNELS.BOOKMARKS_UPDATED,
            (p) => dispatch({ type: 'bookmarks/update', bookmarks: p.bookmarks }),
          ),
          window.api.on<SshProfilesUpdatedPayload>(
            EVENT_CHANNELS.SSH_PROFILES_UPDATED,
            (p) => dispatch({ type: 'sshProfiles/update', profiles: p.profiles }),
          ),
          window.api.on<SessionCreatedPayload>(
            EVENT_CHANNELS.SESSION_CREATED,
            (p) => dispatch({ type: 'sessions/created', session: p.session }),
          ),
          window.api.on<SessionOwnerChangedPayload>(
            EVENT_CHANNELS.SESSION_OWNER_CHANGED,
            (p) =>
              dispatch({
                type: 'sessions/owner-changed',
                sessionId: p.sessionId,
                ownerWindowId: p.newOwnerWindowId,
              }),
          ),
          window.api.on<SessionExitedPayload>(
            EVENT_CHANNELS.SESSION_EXITED,
            (p) =>
              dispatch({
                type: 'sessions/exited',
                sessionId: p.sessionId,
                exitCode: p.exitCode,
              }),
          ),
          window.api.on<SessionStateChangedPayload>(
            EVENT_CHANNELS.SESSION_STATE_CHANGED,
            (p) =>
              dispatch({
                type: 'sessions/state-changed',
                sessionId: p.sessionId,
                changes: p.changes,
              }),
          ),
          window.api.on<SessionDestroyedPayload>(
            EVENT_CHANNELS.SESSION_DESTROYED,
            (p) => dispatch({ type: 'sessions/destroyed', sessionId: p.sessionId }),
          ),
          window.api.on<TemplateListUpdatedPayload>(
            EVENT_CHANNELS.TEMPLATES_UPDATED,
            (p) =>
              dispatch({
                type: 'templates/update',
                templates: p.templates,
                defaultTemplateId: p.defaultTemplateId,
              }),
          ),
          window.api.on<WindowListUpdatedPayload>(
            EVENT_CHANNELS.WINDOW_LIST_UPDATED,
            (p) => dispatch({ type: 'windows/list-update', windows: p.windows }),
          ),
          window.api.on<SettingsChangedPayload>(
            EVENT_CHANNELS.SETTINGS_CHANGED,
            (p) => dispatch({ type: 'settings/changed', settings: p.settings }),
          ),
          window.api.on<WindowFocusRequestedPayload>(
            EVENT_CHANNELS.WINDOW_FOCUS_REQUESTED,
            (p) =>
              dispatch({
                type: 'view/focus-requested',
                ...(p.selectSessionId ? { selectSessionId: p.selectSessionId } : {}),
                ...(p.reason === 'tray-open-settings' ? { enterSettings: true } : {}),
              }),
          ),
        );

        setStatus({ type: 'ready' });
      } catch (err) {
        if (!cancelled) {
          setStatus({
            type: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
      for (const c of cleanups) c();
    };
  }, [dispatch, myWindowId]);

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
