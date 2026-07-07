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
import type { AppSnapshot, PathNode, SessionInfo } from '@shared/types';

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
