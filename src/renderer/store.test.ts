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
import type { AppAction } from './store';

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

describe('renderer open panel view(ADR-037 命令面板整合进「已打开」)', () => {
  function commandSnapshot(activation: boolean): AppAction {
    return {
      type: 'command-panel/updated',
      sessionId: 's1',
      commands: [
        {
          key: 'k1',
          command: 'git status',
          title: null,
          refreshPolicy: { scope: 'foreground', interval: '30s' },
          lastRunId: null,
          lastExitCode: 0,
          status: 'exited',
          output: '',
          lastRunAt: null,
          sudo: false,
        },
      ],
      activeKey: 'k1',
      requestActivation: activation,
    };
  }

  it('runCommand 的 requestActivation 激活 file-panel dock + 记录面板内看命令侧', () => {
    let state = makeDefaultState('w1', 1);
    state = __appReducerForTest(
      state,
      {
        type: 'view/set-active-panel',
        sessionId: 's1',
        panelId: 'git',
      } as never,
    );

    state = __appReducerForTest(state, commandSnapshot(true));

    expect(state.activePanels.get('s1')).toBe('file-panel');
    expect(state.openPanelViews.get('s1')).toBe('command');
  });

  it('openFile 的 requestActivation 记录面板内看文件侧(把视图从命令侧拉回)', () => {
    let state = makeDefaultState('w1', 1);
    state = __appReducerForTest(state, commandSnapshot(true));

    state = __appReducerForTest(state, {
      type: 'file-panel/updated',
      sessionId: 's1',
      files: [opened('C:\\a.md', 'markdown')],
      activePath: 'C:\\a.md',
      requestActivation: true,
    });

    expect(state.activePanels.get('s1')).toBe('file-panel');
    expect(state.openPanelViews.get('s1')).toBe('file');
  });

  it('无 requestActivation 的常规更新不动 activePanels / openPanelViews', () => {
    let state = makeDefaultState('w1', 1);
    state = __appReducerForTest(
      state,
      { type: 'view/set-active-panel', sessionId: 's1', panelId: 'git' } as never,
    );
    state = __appReducerForTest(state, commandSnapshot(false));
    state = __appReducerForTest(state, {
      type: 'file-panel/updated',
      sessionId: 's1',
      files: [opened('C:\\a.md', 'markdown')],
      activePath: 'C:\\a.md',
      requestActivation: false,
    });

    expect(state.activePanels.get('s1')).toBe('git');
    expect(state.openPanelViews.has('s1')).toBe(false);
  });

  it('view/set-open-panel-view 记录用户选择且幂等;destroy/clear 清理', () => {
    let state = makeDefaultState('w1', 1);
    const first = __appReducerForTest(state, {
      type: 'view/set-open-panel-view',
      sessionId: 's1',
      view: 'command',
    });
    expect(first.openPanelViews.get('s1')).toBe('command');
    // 幂等:同值返回原 state 引用(避免无谓 re-render)。
    expect(
      __appReducerForTest(first, {
        type: 'view/set-open-panel-view',
        sessionId: 's1',
        view: 'command',
      }),
    ).toBe(first);

    state = __appReducerForTest(state, { type: 'sessions/destroyed', sessionId: 's1' });
    expect(state.openPanelViews.has('s1')).toBe(false);

    state = __appReducerForTest(state, {
      type: 'view/set-open-panel-view',
      sessionId: 's2',
      view: 'file',
    });
    state = __appReducerForTest(state, { type: 'file-panel/clear', sessionId: 's2' });
    expect(state.openPanelViews.has('s2')).toBe(false);
  });

  it('命令输出滚动记忆:存在的命令可写,关掉的命令被裁,文件更新不误删', () => {
    let state = makeDefaultState('w1', 1);
    state = __appReducerForTest(state, commandSnapshot(false));

    // 命令存在 → 可写 'command:<key>' 条目。
    state = __appReducerForTest(state, {
      type: 'view/file-viewer-scroll',
      sessionId: 's1',
      path: 'command:k1',
      kind: 'command',
      scrollTop: 300,
      scrollLeft: 0,
    });
    expect(state.fileViewerScroll.get('s1')?.get('command:k1')?.scrollTop).toBe(300);

    // 不存在的命令 / kind 不符 → 拒绝(late flush 防线)。
    const before = state;
    state = __appReducerForTest(state, {
      type: 'view/file-viewer-scroll',
      sessionId: 's1',
      path: 'command:gone',
      kind: 'command',
      scrollTop: 1,
      scrollLeft: 0,
    });
    expect(state).toBe(before);
    state = __appReducerForTest(state, {
      type: 'view/file-viewer-scroll',
      sessionId: 's1',
      path: 'command:k1',
      kind: 'markdown',
      scrollTop: 1,
      scrollLeft: 0,
    });
    expect(state).toBe(before);

    // 文件列表更新(开/关/换 active)不裁命令条目。
    state = __appReducerForTest(state, {
      type: 'file-panel/updated',
      sessionId: 's1',
      files: [opened('C:\\a.md', 'markdown')],
      activePath: 'C:\\a.md',
      requestActivation: false,
    });
    expect(state.fileViewerScroll.get('s1')?.has('command:k1')).toBe(true);

    // 命令关闭(commandPanelUpdated 不再含它)→ 滚动条目被裁(bucket 空则整删)。
    state = __appReducerForTest(state, {
      type: 'command-panel/updated',
      sessionId: 's1',
      commands: [],
      activeKey: null,
      requestActivation: false,
    });
    expect(state.fileViewerScroll.get('s1')?.has('command:k1') ?? false).toBe(false);
  });

  it('workspace/snapshot-restored 恢复文件+命令滚动条目并记录面板内视图(ADR-039)', () => {
    let state = makeDefaultState('w1', 1);
    // 恢复前 main 侧已 emit 过恢复后的命令表(命令先于文件恢复,见 index.ts 接线)。
    state = __appReducerForTest(state, commandSnapshot(false));
    // 预置旧对话的滚动记忆,resume 恢复要整体替换而不是叠加。
    state = __appReducerForTest(state, {
      type: 'view/file-viewer-scroll',
      sessionId: 's1',
      path: 'command:old-conversation',
      kind: 'command',
      scrollTop: 999,
      scrollLeft: 0,
    });

    state = __appReducerForTest(state, {
      type: 'workspace/snapshot-restored',
      sessionId: 's1',
      scroll: {
        'C:\\a.md': { scrollTop: 120, scrollLeft: 0, kind: 'markdown' },
        'command:k1': { scrollTop: 300, scrollLeft: 0, kind: 'command' },
      },
      view: 'command',
    });

    const bucket = state.fileViewerScroll.get('s1')!;
    expect(bucket.get('C:\\a.md')?.kind).toBe('markdown');
    expect(bucket.get('command:k1')?.scrollTop).toBe(300);
    expect(bucket.has('command:old-conversation')).toBe(false); // 整体替换
    expect(state.openPanelViews.get('s1')).toBe('command');

    // 空 scroll(空 workspace)→ bucket 删除,但显式 view 仍记录(resolveOpenPanelView
    // 会因该侧为空回退,不产生死状态)。
    state = __appReducerForTest(state, {
      type: 'workspace/snapshot-restored',
      sessionId: 's1',
      scroll: {},
      view: 'file',
    });
    expect(state.fileViewerScroll.has('s1')).toBe(false);
    expect(state.openPanelViews.get('s1')).toBe('file');
  });
});
