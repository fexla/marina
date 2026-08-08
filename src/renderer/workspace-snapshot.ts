/**
 * @file workspace-snapshot.ts
 * @purpose v0.3.3 ADR-024 / Feature D:文件面板状态快照的恢复 + 写入编排。
 *
 * @关键设计:
 * - bind 切到某 workspace 后,调 restoreWorkspaceSnapshot(dispatch, sessionId):
 *   读 main 的 WORKSPACE_READ_SNAPSHOT → dispatch 'workspace/snapshot-restored'
 *   灌入 openedFiles/active/scroll + restoreCodeBlockRuns 灌入 runs。
 * - file-panel 状态变化(openedFiles/active/scroll/runs)触发 scheduleWorkspaceSnapshotWrite:
 *   500ms debounce 后发 WORKSPACE_WRITE_SNAPSHOT(滚动停滚落盘,ADR §2.6)。
 *   切走面板/关 session 应 flush(本模块提供 flushWorkspaceSnapshotWrite)。
 * - 不进逐字节热路径(附录 H):只在聚合点 debounce 写。
 *
 * @对应文档章节: ADR-024 §2.6、附录 H。
 *
 * @不要在这里做的事:
 * - 不读/写 localStorage(runs 可能含敏感信息,只落 main 受管目录)。
 * - 不在 PTY 逐字节热路径上报。
 */
import type { AppAction, AppState } from './store';
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
 * bind 切到某 workspace 后,从 main 读其文件面板快照并恢复到 store + run 缓存。
 * 文件/结果缺失由 main 端 readSnapshot 过滤(返 null);null 则跳过(保持当前空状态)。
 *
 * 快照里的 scroll 只存 scrollTop/scrollLeft(不含 kind);恢复时 kind 从快照的
 * openedFiles 推(找不到则跳过该条,防 kind 不匹配导致 viewer 复活错误状态)。
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

    // 推 kind:从 openedFiles 建 path→kind 映射,给 scroll 条目补 kind。
    const kindByPath = new Map<string, FileKind>();
    for (const f of snapshot.openedFiles) {
      kindByPath.set(f.path, f.kind as FileKind);
    }
    const scrollWithKind: Record<
      string,
      { scrollTop: number; scrollLeft: number; kind: FileKind }
    > = {};
    for (const [path, pos] of Object.entries(snapshot.scroll)) {
      const kind = kindByPath.get(path);
      if (!kind) continue; // scroll 对应的文件已不在 openedFiles,跳过(防复活)
      scrollWithKind[path] = { scrollTop: pos.scrollTop, scrollLeft: pos.scrollLeft, kind };
    }

    // 文件列表/active 不在这里恢复：main 的 FilePanelService.onWorkspaceSwitched
    // 已先 stat 并 emit 完整 OpenedFile(name/size/mtime/path)。旧实现把磁盘快照的
    // {path,kind} 强转为 OpenedFile[] 覆盖完整事件，file.name=undefined 最终让
    // fileIconFor 崩溃白屏。renderer 只补 main PanelState 不持有的 scroll/runs。
    dispatch({
      type: 'workspace/snapshot-restored',
      sessionId,
      scroll: scrollWithKind,
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
    return { path, kind: String(f.kind), external };
  });
  const scrollRaw = state.fileViewerScroll.get(sessionId);
  const scroll: Record<string, { scrollTop: number; scrollLeft: number }> = {};
  if (scrollRaw) {
    for (const [path, pos] of scrollRaw) {
      const external = !wsDir || isAbsoluteOutside(path, wsDir);
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
  };
  try {
    await window.api.invoke(
      COMMAND_CHANNELS.WORKSPACE_WRITE_SNAPSHOT,
      { sessionId, snapshot },
    );
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
