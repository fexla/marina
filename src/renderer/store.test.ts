/**
 * @file src/renderer/store.test.ts
 * @purpose 覆盖 renderer 全局状态的远程 owner 语义。
 *
 * @关键设计:
 * - 远程后端窗口的真实 owner id 是 daemon 在 WS auth 后分配的 clientId,
 *   不是本地 BrowserWindow query string 里的 windowId。
 * - snapshot.myWindowId 是 main/daemon 对当前连接的权威身份。snapshot/load 必须
 *   写入 state.myWindowId,否则 session.ownerWindowId === clientId 的远程 session
 *   会被 getDisplayableSession 误判为“其他窗口持有”,TerminalView 不挂载。
 *
 * @对应问题:0.2.6 修复“远程连接成功后点击新建终端,终端打不开”。
 */
import { describe, expect, it } from 'vitest';
import {
  __appReducerForTest,
  getDisplayableSession,
  makeDefaultState,
  type AppState,
} from './store';
import type { AppSnapshot, FileKind, OpenedFile, PathNode, SessionInfo } from '@shared/types';

function pathNode(): PathNode {
  return {
    id: 'C:\\remote-project',
    kind: 'local',
    path: 'C:\\remote-project',
    displayName: 'remote-project',
    category: 'bookmarked',
    sessionIds: [],
  } as PathNode;
}

function makeSession(ownerWindowId: string): SessionInfo {
  return {
    id: 'sess-remote-1',
    pathId: 'C:\\remote-project',
    templateId: 'shell',
    ownerWindowId,
    originalCwd: 'C:\\remote-project',
    currentCwd: 'C:\\remote-project',
    cols: 120,
    rows: 30,
    pid: 1234,
    displayName: 'PowerShell',
    state: 'active',
    createdAt: Date.now(),
  } as SessionInfo;
}

function snapshot(remoteClientId: string): AppSnapshot {
  const p = pathNode();
  return {
    windows: [],
    sessions: [],
    pathTree: { bookmarks: [p], temporary: [], recent: [] },
    sshProfiles: [],
    remoteBackendProfiles: [],
    templates: [],
    defaultTemplateId: 'shell',
    settings: {},
    myWindowId: remoteClientId,
  } as unknown as AppSnapshot;
}

describe('renderer store remote owner identity', () => {
  it('snapshot/load 使用 daemon 返回的 myWindowId,让远程新 session 可显示', () => {
    const localWindowId = 'local-browser-window-id';
    const remoteClientId = 'remote-ws-client-id';
    let state: AppState = makeDefaultState(localWindowId, 7);

    state = __appReducerForTest(state, {
      type: 'snapshot/load',
      snapshot: snapshot(remoteClientId),
    } as never);

    expect(state.myWindowId).toBe(remoteClientId);

    const session = makeSession(remoteClientId);
    state = __appReducerForTest(state, { type: 'sessions/created', session } as never);

    expect(state.selectedSessionId).toBe(session.id);
    expect(getDisplayableSession(state)?.id).toBe(session.id);
  });
});

function opened(path: string, kind: FileKind): OpenedFile {
  return {
    path,
    name: path.split('\\').pop() ?? path,
    kind,
    mtimeMs: 1,
  } as OpenedFile;
}

function updateFiles(
  state: AppState,
  sessionId: string,
  files: OpenedFile[],
  activePath: string | null,
): AppState {
  return __appReducerForTest(state, {
    type: 'file-panel/updated',
    sessionId,
    files,
    activePath,
    requestActivation: false,
  });
}

describe('renderer file viewer scroll state', () => {
  it('按 session + path + kind 隔离并同时保存 X/Y', () => {
    const a = opened('C:\\a.md', 'markdown');
    const b = opened('C:\\b.diff', 'diff');
    let state = makeDefaultState('w1', 1);
    state = updateFiles(state, 's1', [a, b], a.path);
    state = updateFiles(state, 's2', [a], a.path);

    state = __appReducerForTest(state, {
      type: 'view/file-viewer-scroll',
      sessionId: 's1',
      path: a.path,
      kind: a.kind,
      scrollTop: 120,
      scrollLeft: 8,
    });
    state = __appReducerForTest(state, {
      type: 'view/file-viewer-scroll',
      sessionId: 's1',
      path: b.path,
      kind: b.kind,
      scrollTop: 240,
      scrollLeft: 90,
    });
    state = __appReducerForTest(state, {
      type: 'view/file-viewer-scroll',
      sessionId: 's2',
      path: a.path,
      kind: a.kind,
      scrollTop: 360,
      scrollLeft: 0,
    });

    expect(state.fileViewerScroll.get('s1')?.get(a.path)).toEqual({
      kind: 'markdown',
      scrollTop: 120,
      scrollLeft: 8,
    });
    expect(state.fileViewerScroll.get('s1')?.get(b.path)?.scrollLeft).toBe(90);
    expect(state.fileViewerScroll.get('s2')?.get(a.path)?.scrollTop).toBe(360);
  });

  it('切 activePath 保留仍打开文件；关闭后裁掉且拒绝 late flush', () => {
    const a = opened('C:\\a.ts', 'text');
    const b = opened('C:\\b.md', 'markdown');
    let state = updateFiles(makeDefaultState('w1', 1), 's1', [a, b], a.path);
    state = __appReducerForTest(state, {
      type: 'view/file-viewer-scroll',
      sessionId: 's1',
      path: a.path,
      kind: a.kind,
      scrollTop: 88,
      scrollLeft: 12,
    });

    state = updateFiles(state, 's1', [a, b], b.path);
    expect(state.fileViewerScroll.get('s1')?.get(a.path)?.scrollTop).toBe(88);

    state = updateFiles(state, 's1', [b], b.path);
    expect(state.fileViewerScroll.get('s1')?.has(a.path) ?? false).toBe(false);
    const afterClose = state;
    state = __appReducerForTest(state, {
      type: 'view/file-viewer-scroll',
      sessionId: 's1',
      path: a.path,
      kind: a.kind,
      scrollTop: 999,
      scrollLeft: 0,
    });
    expect(state).toBe(afterClose);
  });

  it('file-panel/clear 与 session destroy 清整个 session bucket', () => {
    const file = opened('C:\\a.md', 'markdown');
    let state = updateFiles(makeDefaultState('w1', 1), 's1', [file], file.path);
    state = __appReducerForTest(state, {
      type: 'view/file-viewer-scroll',
      sessionId: 's1',
      path: file.path,
      kind: file.kind,
      scrollTop: 42,
      scrollLeft: 0,
    });
    state = __appReducerForTest(state, { type: 'file-panel/clear', sessionId: 's1' });
    expect(state.fileViewerScroll.has('s1')).toBe(false);

    state = updateFiles(state, 's2', [file], file.path);
    state = __appReducerForTest(state, {
      type: 'view/file-viewer-scroll',
      sessionId: 's2',
      path: file.path,
      kind: file.kind,
      scrollTop: 77,
      scrollLeft: 0,
    });
    state = __appReducerForTest(state, { type: 'sessions/destroyed', sessionId: 's2' });
    expect(state.fileViewerScroll.has('s2')).toBe(false);
  });
});
