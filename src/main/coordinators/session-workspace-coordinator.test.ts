/**
 * @file session-workspace-coordinator.test.ts
 * @purpose SessionWorkspaceCoordinator 单测:workspace 生命周期 + 编排方法 + SessionLookup 依赖。
 * 全部用 mock workspaceManager / mock SessionLookup,不碰真实文件系统与 SessionManager。
 */
import { describe, expect, it, vi, type Mock } from 'vitest';
import { SessionWorkspaceCoordinator } from './session-workspace-coordinator';
import type { SessionWorkspaceSource } from '../session-manager';
import type { SessionLookup } from './session-lookup';

/** 构造一个可记调用/可控返回的 workspaceManager mock。 */
type WmMocks = {
  create: Mock;
  cloneWorkspace: Mock;
  discard: Mock;
  release: Mock;
  getPathForWorkspace: Mock;
  bind: Mock;
  list: Mock;
  switchToNew: Mock;
  unpin: Mock;
  resolveByName: Mock;
  getRecord: Mock;
  readSnapshot: Mock;
  writeSnapshot: Mock;
};
function makeWorkspaceManager(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const wm: WmMocks = {
    create: vi.fn(async () => {
      calls.push('create');
      return { workspaceId: 'ws-1', dir: 'C:\\fake\\ws-1' };
    }),
    cloneWorkspace: vi.fn(async (sourceId: string) => {
      calls.push(`clone:${sourceId}`);
      return { workspaceId: 'ws-clone', dir: 'C:\\fake\\ws-clone' };
    }),
    discard: vi.fn(async (id: string) => {
      calls.push(`discard:${id}`);
    }),
    release: vi.fn((id: string) => {
      calls.push(`release:${id}`);
    }),
    getPathForWorkspace: vi.fn((id: string) => (id.startsWith('ws-') ? `C:\\fake\\${id}` : null)),
    bind: vi.fn(async () => ({
      kind: 'created',
      workspaceId: 'ws-2',
      dir: 'C:\\fake\\ws-2',
    })),
    list: vi.fn(async () => []),
    switchToNew: vi.fn(async () => ({ workspaceId: 'ws-3', dir: 'C:\\fake\\ws-3' })),
    unpin: vi.fn(async () => {}),
    resolveByName: vi.fn((name: string) => (name === 'named' ? 'ws-9' : null)),
    getRecord: vi.fn((id: string) =>
      id === 'ws-9'
        ? { name: 'named', createdAt: 1, closedAt: null, pinned: false, pathScope: 'C:\\proj' }
        : null,
    ),
    readSnapshot: vi.fn(async () => ({ files: [] })),
    writeSnapshot: vi.fn(async () => {}),
    ...overrides,
  };
  return { wm, calls };
}

function makeLookup(overrides: Partial<SessionLookup> = {}): SessionLookup {
  return {
    hasSession: (sid) => sid === 's1',
    getSessionPathId: (sid) => (sid === 's1' ? 'C:\\proj' : null),
    ...overrides,
  };
}

function makeCoord(
  overrides: {
    workspaceManager?: Record<string, unknown>;
    lookup?: SessionLookup | null;
    workspaceManagerNull?: boolean;
  } = {},
) {
  const { wm, calls } = makeWorkspaceManager(overrides.workspaceManager);
  const coord = new SessionWorkspaceCoordinator(
    overrides.workspaceManagerNull ? null : (wm as unknown as SessionWorkspaceSource),
  );
  if (overrides.lookup !== null) coord.attachSessionLookup(overrides.lookup ?? makeLookup());
  return { coord, wm, calls };
}

describe('SessionWorkspaceCoordinator — 生命周期', () => {
  it('createForSession 创建 workspace + 记绑定,返回 {workspaceId, dir}', async () => {
    const { coord, calls } = makeCoord();
    const created = await coord.createForSession('s1');
    expect(created).toEqual({ workspaceId: 'ws-1', dir: 'C:\\fake\\ws-1' });
    expect(calls).toContain('create');
    expect(coord.getWorkspaceIdForSession('s1')).toBe('ws-1');
    expect(coord.getWorkspacePathForSession('s1')).toBe('C:\\fake\\ws-1');
  });

  it('createForSession 失败抛 code=WorkspaceCreateFailed(带原因)', async () => {
    const { coord } = makeCoord({
      workspaceManager: {
        create: vi.fn(async () => {
          throw new Error('ENOSPC');
        }),
      },
    });
    await expect(coord.createForSession('s1')).rejects.toMatchObject({
      code: 'WorkspaceCreateFailed',
    });
  });

  it('workspace 未启用(manager=null)时 createForSession 抛 WorkspaceNotConfigured', async () => {
    const { coord } = makeCoord({ workspaceManagerNull: true });
    await expect(coord.createForSession('s1')).rejects.toMatchObject({
      code: 'WorkspaceNotConfigured',
    });
  });

  it('discardForSession 撤销绑定 workspace 并删绑定', async () => {
    const { coord, calls } = makeCoord();
    await coord.createForSession('s1');
    await coord.discardForSession('s1');
    expect(calls).toContain('discard:ws-1');
    expect(coord.getWorkspaceIdForSession('s1')).toBeNull();
  });

  it('onSessionDestroyed release 绑定 workspace + 删绑定;无绑定 no-op', async () => {
    const { coord, calls } = makeCoord();
    coord.onSessionDestroyed('s1');
    expect(calls).not.toContain('release:ws-1'); // 无绑定
    await coord.createForSession('s1');
    coord.onSessionDestroyed('s1');
    expect(calls).toContain('release:ws-1');
    expect(coord.getWorkspaceIdForSession('s1')).toBeNull();
  });

  it('release 抛错只 warn,不阻塞销毁流程', async () => {
    const { coord } = makeCoord({
      workspaceManager: {
        release: vi.fn(() => {
          throw new Error('fs error');
        }),
      },
    });
    await coord.createForSession('s1');
    expect(() => coord.onSessionDestroyed('s1')).not.toThrow();
    expect(coord.getWorkspaceIdForSession('s1')).toBeNull();
  });

  // ── fork 继承(方案 20260817 裁决 1)──────────────────────────────

  it('cloneForSession 委托 manager.cloneWorkspace 并把新 id 绑到 session', async () => {
    const { coord, calls } = makeCoord();
    const created = await coord.cloneForSession('s1', 'ws-parent');
    expect(created).toEqual({ workspaceId: 'ws-clone', dir: 'C:\\fake\\ws-clone' });
    expect(calls).toContain('clone:ws-parent');
    expect(coord.getWorkspaceIdForSession('s1')).toBe('ws-clone');
  });

  it('cloneForSession 在 manager 未注入时抛 WorkspaceNotConfigured', async () => {
    const { coord } = makeCoord({ workspaceManagerNull: true });
    await expect(coord.cloneForSession('s1', 'ws-parent')).rejects.toMatchObject({
      code: 'WorkspaceNotConfigured',
    });
  });

  // ── 同文件共享的 release 防护(方案 20260817 裁决 3)────────────

  it('多 session 共享同一 workspace(跨终端同文件):最后一个占用者销毁才 release', async () => {
    // 生产中全应用只有一个 SessionWorkspaceCoordinator,所有 session 的绑定都在
    // 同一张表里;跨终端 /resume 同一对话文件 → 两条 session 绑同一 ws。
    const { coord, calls } = makeCoord({
      lookup: {
        hasSession: (sid: string) => ['s1', 's2'].includes(sid),
        getSessionPathId: () => 'C:\\proj',
      },
    });
    await coord.createForSession('s1');
    const wsId = coord.getWorkspaceIdForSession('s1');
    expect(wsId).toBe('ws-1');
    coord.switchSessionToWorkspace('s2', wsId!);

    // 第一个销毁:仍被 s2 占用 → 不得 release(否则保留期一到 s2 面板内容蒸发)。
    coord.onSessionDestroyed('s1');
    expect(calls).not.toContain('release:ws-1');
    // 最后一个销毁:正常 release。
    coord.onSessionDestroyed('s2');
    expect(calls).toContain('release:ws-1');
  });
});

describe('SessionWorkspaceCoordinator — workspace 编排', () => {
  it('bindWorkspace 委托 workspaceManager.bind(pathScope=session.pathId);switched 才更新绑定', async () => {
    const { coord, wm } = makeCoord();
    await coord.createForSession('s1');
    // kind=created:新建命名 workspace,绑定不切(仍留当前 workspace)。
    const created = await coord.bindWorkspace('s1', 'named', false);
    expect(created.kind).toBe('created');
    expect(wm.bind).toHaveBeenCalledWith('ws-1', 'named', 'C:\\proj', false);
    expect(coord.getWorkspaceIdForSession('s1')).toBe('ws-1');
    // kind=switched:绑定切到目标 workspace。
    wm.bind.mockImplementation(async () => ({
      kind: 'switched',
      workspaceId: 'ws-2',
      dir: 'C:\\fake\\ws-2',
      createdAt: 1,
      fileCount: 0,
    }));
    const switched = await coord.bindWorkspace('s1', 'named', true);
    expect(switched.kind).toBe('switched');
    expect(coord.getWorkspaceIdForSession('s1')).toBe('ws-2');
  });

  it('bindWorkspace 对不存在 session 抛 SessionNotFound', async () => {
    const { coord } = makeCoord();
    await expect(coord.bindWorkspace('no-such', 'x', false)).rejects.toMatchObject({
      code: 'SessionNotFound',
    });
  });

  it('listWorkspaces 委托 manager.list(pathScope);不存在 session 抛 SessionNotFound', async () => {
    const { coord, wm } = makeCoord();
    await coord.listWorkspaces('s1');
    expect(wm.list).toHaveBeenCalledWith('C:\\proj');
    await expect(coord.listWorkspaces('no-such')).rejects.toMatchObject({
      code: 'SessionNotFound',
    });
  });

  it('switchToNewWorkspace 切新临时 + 更新绑定', async () => {
    const { coord } = makeCoord();
    await coord.createForSession('s1');
    const created = await coord.switchToNewWorkspace('s1');
    expect(created.workspaceId).toBe('ws-3');
    expect(coord.getWorkspaceIdForSession('s1')).toBe('ws-3');
  });

  it('unpinWorkspace(name 省略=当前绑定)委托 unpin(occupied=仍绑定)', async () => {
    const { coord, wm } = makeCoord();
    await coord.createForSession('s1');
    const r = await coord.unpinWorkspace('s1', null);
    expect(r).toEqual({ workspaceId: 'ws-1' });
    expect(wm.unpin).toHaveBeenCalledWith('ws-1', true);
  });

  it('unpinWorkspace(name=指定)走 resolveByName', async () => {
    const { coord, wm } = makeCoord();
    const r = await coord.unpinWorkspace('s1', 'named');
    expect(r).toEqual({ workspaceId: 'ws-9' });
    expect(wm.resolveByName).toHaveBeenCalledWith('named', 'C:\\proj');
  });

  it('readWorkspaceSnapshot / writeWorkspaceSnapshot 委托 manager(无绑定返 null/no-op)', async () => {
    const { coord, wm } = makeCoord();
    await coord.createForSession('s1');
    const snap = await coord.readWorkspaceSnapshot('s1');
    expect(snap).toEqual({ files: [] });
    expect(wm.readSnapshot).toHaveBeenCalledWith('ws-1');
    await coord.writeWorkspaceSnapshot('s1', { a: 1 });
    expect(wm.writeSnapshot).toHaveBeenCalledWith('ws-1', { a: 1 });
    // 无绑定 session
    expect(await coord.readWorkspaceSnapshot('s2')).toBeNull();
    await coord.writeWorkspaceSnapshot('s2', { a: 1 }); // no-op 不抛
  });

  it('getRecord / switchSessionToWorkspace(pi resume 用)', async () => {
    const { coord, wm } = makeCoord();
    await coord.createForSession('s1');
    expect(coord.getRecord('ws-9')).toMatchObject({ name: 'named' });
    expect(coord.getRecord('ws-none')).toBeNull();
    coord.switchSessionToWorkspace('s1', 'ws-9');
    expect(coord.getWorkspaceIdForSession('s1')).toBe('ws-9');
    void wm;
  });
});
