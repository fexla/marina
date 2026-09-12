/**
 * @file workspace-snapshot.ts
 * @purpose v0.3.3 ADR-024 / Feature D:「已打开」面板状态快照的恢复 + 写入编排。
 *   ADR-039 起快照含命令页切片(commandPanel/panelView/command: 滚动条目),
 *   命令与文档同一条 debounce 写入 / 切换恢复管线。
 *
 * @关键设计:
 * - bind 切到某 workspace 后,调 restoreWorkspaceSnapshot(dispatch, sessionId):
 *   读 main 的 WORKSPACE_READ_SNAPSHOT → dispatch 'workspace/snapshot-restored'
 *   灌入 scroll(文件+命令)+ 面板内视图 + restoreCodeBlockRuns 灌入 runs。
 * - 面板状态变化(openedFiles/active/scroll/runs/commandPanel)触发
 *   scheduleWorkspaceSnapshotWrite:500ms debounce 后发 WORKSPACE_WRITE_SNAPSHOT
 *   (滚动停滚落盘,ADR §2.6)。切走面板/关 session 应 flush(本模块提供
 *   flushWorkspaceSnapshotWrite)。commandPanel 切片不在 renderer 组装 —— main
 *   在写边界合并 CommandPanelService 内存真值(单一真相源,见 ipc.ts)。
 * - 不进逐字节热路径(附录 H):只在聚合点 debounce 写。
 *
 * @对应文档章节: ADR-024 §2.6、ADR-039、附录 H。
 *
 * @不要在这里做的事:
 * - 不读/写 localStorage(runs/命令可能含敏感信息,只落 main 受管目录)。
 * - 不在 PTY 逐字节热路径上报。
 * - 不在 renderer 组装 commandPanel 切片(命令真值在 main,边界合并)。
 */
import type { AppAction, AppState, FileViewerScrollKind } from './store';
import { COMMAND_CHANNELS, type WorkspaceFilePanelSnapshot } from '@shared/protocol';
import type { FileKind } from '@shared/types';
import {
  restoreCodeBlockRuns,
  exportCodeBlockRuns,
} from './components/file-panel/code-block-run-cache';

type Dispatch = (action: AppAction) => void;
type GetState = () => AppState;

const WRITE_DEBOUNCE_MS = 500;

/** 进行中的 debounce timer:按 sessionId 隔离(每个 session 独立 debounce)。 */
const writeTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * 从快照推导恢复到 renderer 的滚动条目与面板内视图(纯函数,可测)。
 *
 * - 文件条目:kind 从快照 openedFiles 推(找不到则跳过,防 kind 不匹配导致 viewer
 *   复活错误状态 —— 快照 scroll 只存 scrollTop/scrollLeft,不含 kind)。
 * - 命令条目(command: 前缀,ADR-039 起持久化):kind 恒 'command',按快照
 *   commandPanel.commands 的 key 校验(命令已不在快照里的孤儿滚动条目跳过,
 *   防复活)。以快照为权威而非 store —— 恢复与 commandPanelUpdated 事件的
 *   到达顺序解耦。
 * - 视图:优先快照显式 panelView;缺失(旧快照)时推导 —— 有 active 命令且无
 *   active 文件 = 当时在看命令侧,否则文件侧。
 */
export function deriveRestoredScroll(snapshot: WorkspaceFilePanelSnapshot): {
  scroll: Record<string, { scrollTop: number; scrollLeft: number; kind: FileViewerScrollKind }>;
  view: 'file' | 'command';
} {
  const kindByPath = new Map<string, FileKind>();
  for (const f of snapshot.openedFiles) {
    kindByPath.set(f.path, f.kind as FileKind);
  }
  const commandKeys = new Set(
    (snapshot.commandPanel?.commands ?? []).map((c) => `command:${c.key}`),
  );
  const scroll: Record<
    string,
    { scrollTop: number; scrollLeft: number; kind: FileViewerScrollKind }
  > = {};
  for (const [path, pos] of Object.entries(snapshot.scroll)) {
    if (path.startsWith('command:')) {
      if (!commandKeys.has(path)) continue; // 命令已不在快照,孤儿滚动不复活
      scroll[path] = { scrollTop: pos.scrollTop, scrollLeft: pos.scrollLeft, kind: 'command' };
      continue;
    }
    const kind = kindByPath.get(path);
    if (!kind) continue; // scroll 对应的文件已不在 openedFiles,跳过(防复活)
    scroll[path] = { scrollTop: pos.scrollTop, scrollLeft: pos.scrollLeft, kind };
  }
  const view =
    snapshot.panelView === 'file' || snapshot.panelView === 'command'
      ? snapshot.panelView
      : snapshot.commandPanel?.activeKey && !snapshot.activeFilePath
        ? 'command'
        : 'file';
  return { scroll, view };
}

/**
 * bind 切到某 workspace 后,从 main 读其文件面板快照并恢复到 store + run 缓存。
 * 文件/结果缺失由 main 端 readSnapshot 过滤(返 null);null 则跳过(保持当前空状态)。
 */
export async function restoreWorkspaceSnapshot(
  dispatch: Dispatch,
  sessionId: string,
): Promise<void> {
  try {
    const { snapshot } = await window.api.invoke(
      // 通道名用常量(COMMAND_CHANNELS 是值,不是类型;旧代码 type-import 导致
      // 只能字面量 + 错误 cast,这里恢复值 import 用真实常量)。
      COMMAND_CHANNELS.WORKSPACE_READ_SNAPSHOT,
      { sessionId },
    );
    if (!snapshot) return;

    // 文件列表/active 不在这里恢复：main 的 FilePanelService.onWorkspaceSwitched
    // 已先 stat 并 emit 完整 OpenedFile(name/size/mtime/path);命令列表同样由
    // CommandPanelService.onWorkspaceSwitched 先恢复并 emit。renderer 只补 main
    // 不持有的 scroll(文件+命令)/面板内视图/runs。
    const { scroll, view } = deriveRestoredScroll(snapshot);
    dispatch({
      type: 'workspace/snapshot-restored',
      sessionId,
      scroll,
      view,
    });

    // runs 灌进 code-block-run-cache(模块级单例)。
    restoreCodeBlockRuns(snapshot.runs);
  } catch (err) {
    // 快照恢复失败不应阻塞 bind 切换;main 端 readSnapshot 缺失/损坏返 null 已兜底,
    // 这里只 catch IPC 层异常。
    console.warn('[workspace-snapshot] restore failed:', err);
  }
}

/**
 * 调度一次快照写(500ms debounce)。由 file-panel 状态变化(openedFiles/active/
 * scroll/runs 变化)触发。组装当前 file-panel 状态(openedFiles/active/scroll +
 * 从 code-block-run-cache 导出的 runs)发 WORKSPACE_WRITE_SNAPSHOT。
 *
 * 路径形式:workspace 内文件存相对 workspace 根,workspace 外文件存绝对 + external。
 * 这里简化:openedFile.path 若是绝对路径且在 workspace 外 → external=true。相对路径
 * 的判定依赖当前 workspace 根(由 main 端 writeSnapshot 内部拼,renderer 只传 path
 * 原值 + external 标记)。
 *
 * @param getWorkspaceDir 当前 workspace 绝对路径(从 main 查;null 时所有路径算 external)。
 */
export function scheduleWorkspaceSnapshotWrite(
  sessionId: string,
  getState: GetState,
  getWorkspaceDir: () => string | null,
): void {
  const existing = writeTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    writeTimers.delete(sessionId);
    void doWriteSnapshot(sessionId, getState, getWorkspaceDir);
  }, WRITE_DEBOUNCE_MS);
  writeTimers.set(sessionId, timer);
}

/** 强制立即 flush 某 session 的待写快照(切走面板/关 session 用)。 */
export function flushWorkspaceSnapshotWrite(
  sessionId: string,
  getState: GetState,
  getWorkspaceDir: () => string | null,
): void {
  const existing = writeTimers.get(sessionId);
  if (existing) {
    clearTimeout(existing);
    writeTimers.delete(sessionId);
  }
  void doWriteSnapshot(sessionId, getState, getWorkspaceDir);
}

async function doWriteSnapshot(
  sessionId: string,
  getState: GetState,
  getWorkspaceDir: () => string | null,
): Promise<void> {
  const state = getState();
  const panel = state.filePanels.get(sessionId);
  const wsDir = getWorkspaceDir();
  const openedFiles = (panel?.files ?? []).map((f) => {
    const external = !wsDir || isAbsoluteOutside(f.path, wsDir);
    // workspace 内文件存相对路径(让 main 拼根;换机器/换根仍有效);外存绝对。
    const path = !external && wsDir ? (toRelative(f.path, wsDir) ?? f.path) : f.path;
    return {
      path,
      kind: String(f.kind),
      external,
      // Git diff 的 relativePath + repoIdentity 是「打开源文件」的导航真值；若快照
      // 丢掉它，bind 切走再切回后会退化成解析展示文本并绕过跨仓库身份校验。
      ...(f.origin ? { origin: f.origin } : {}),
    };
  });
  const scrollRaw = state.fileViewerScroll.get(sessionId);
  const scroll: Record<string, { scrollTop: number; scrollLeft: number }> = {};
  if (scrollRaw) {
    for (const [path, pos] of scrollRaw) {
      // 命令条目(command: 前缀)不是文件系统路径:不属于任何 workspace 内外
      // 判定,原样存取(isAbsoluteOutside 判非绝对 → 直通)。ADR-039 起命令页
      // 随 commandPanel 切片一起持久化,它的滚动记忆同文件一样跨 resume 恢复。
      const external = !path.startsWith('command:') &&
        (!wsDir || isAbsoluteOutside(path, wsDir));
      const storedPath = !external && wsDir ? (toRelative(path, wsDir) ?? path) : path;
      scroll[storedPath] = { scrollTop: pos.scrollTop, scrollLeft: pos.scrollLeft };
    }
  }
  // runs:从 code-block-run-cache 导出所有 exited 结果(ADR §2.6 C2:运行结果要持久)。
  const runs = exportCodeBlockRuns();
  const snapshot: WorkspaceFilePanelSnapshot = {
    version: 1,
    openedFiles,
    activeFilePath: panel?.activePath ?? null,
    scroll,
    runs,
    // 面板内正在看哪一侧(ADR-037/038);commandPanel 切片不在这里组装 —— main
    // 在 WORKSPACE_WRITE_SNAPSHOT 边界合并 CommandPanelService 内存真值。
    panelView: state.openPanelViews.get(sessionId) ?? null,
  };
  try {
    await window.api.invoke(COMMAND_CHANNELS.WORKSPACE_WRITE_SNAPSHOT, { sessionId, snapshot });
  } catch (err) {
    console.warn('[workspace-snapshot] write failed:', err);
  }
}

/** path 是否绝对路径且在 dir 之外(workspace 外文件)。 */
function isAbsoluteOutside(path: string, dir: string): boolean {
  if (!path || path === '.') return false;
  // 粗判:绝对路径(Windows 盘符 / POSIX /)且不以 dir 开头。
  const isAbs = /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\');
  if (!isAbs) return false; // 相对路径 → 视为 workspace 内
  return !startsWithDir(path, dir);
}

/** 把绝对 path 转成相对 dir 的路径;不在 dir 内返 null。 */
function toRelative(path: string, dir: string): string | null {
  if (!startsWithDir(path, dir)) return null;
  const rel = path.slice(dir.length).replace(/^[\\/]+/, '');
  return rel || null;
}

/** path 是否以 dir 开头(大小写不敏感,容 Windows;尾斜杠归一)。 */
function startsWithDir(path: string, dir: string): boolean {
  const p = path.toLowerCase().replace(/\\/g, '/');
  const d = dir.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
  return p === d || p.startsWith(d + '/');
}
