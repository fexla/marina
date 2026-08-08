/**
 * @file pi-session-coordinator.test.ts
 * @purpose PiSessionCoordinator 单测:主 piSessionId 锁定 + reason 分发 + hooks 调用 +
 * pi↔workspace 映射。全部 mock(workspaceCoordinator / hooks / settings / lookup),
 * 不碰 SessionManager 状态机(状态副作用由 hooks 的 mock 断言「调用了谁」)。
 */
import { describe, expect, it, vi } from 'vitest';
import { PiSessionCoordinator } from './pi-session-coordinator';
import type { SessionWorkspaceCoordinator } from './session-workspace-coordinator';
import type { PiSessionHooks, PiSettingsSource } from './pi-session-coordinator';
import type { SessionLookup } from './session-lookup';

function makeHooks(): { [K in keyof PiSessionHooks]: ReturnType<typeof vi.fn> } {
  return {
    onPiAgentChanged: vi.fn(),
    onPiName: vi.fn(),
    bindAgent: vi.fn(),
    unbindAgent: vi.fn(),
    notifyAgentWorking: vi.fn(),
    notifyAgentSettled: vi.fn(),
  };
}

function makeSettings(
  overrides: Partial<{ enabled: boolean; newCreates: boolean; resumeSwitch: boolean }> = {},
): PiSettingsSource {
  return {
    get: () => ({
      piIntegration: {
        enabled: overrides.enabled ?? true,
        newConversationCreatesWorkspace: overrides.newCreates ?? true,
        resumeSwitchesWorkspace: overrides.resumeSwitch ?? true,
      },
    }),
  };
}

function makeLookup(overrides: Partial<SessionLookup> = {}): SessionLookup {
  return {
    hasSession: (sid) => sid === 's1',
    getSessionPathId: (sid) => (sid === 's1' ? 'C:\\proj' : null),
    ...overrides,
  };
}

interface PiHarness {
  pi: PiSessionCoordinator;
  hooks: { [K in keyof PiSessionHooks]: ReturnType<typeof vi.fn> };
  ws: {
    isWorkspaceEnabled: ReturnType<typeof vi.fn>;
    createForSession: ReturnType<typeof vi.fn>;
    getRecord: ReturnType<typeof vi.fn>;
    switchSessionToWorkspace: ReturnType<typeof vi.fn>;
  };
}
function makePi(
  overrides: {
    settings?: PiSettingsSource;
    lookup?: SessionLookup | null;
    workspaceEnabled?: boolean;
    createForSession?: () => Promise<{ workspaceId: string; dir: string }>;
    getRecord?: (wsId: string) => unknown;
  } = {},
): PiHarness {
  const hooks = makeHooks();
  const ws = {
    isWorkspaceEnabled: vi.fn(),
    createForSession: vi.fn(),
    getRecord: vi.fn(),
    switchSessionToWorkspace: vi.fn(),
  };
  ws.isWorkspaceEnabled.mockImplementation(() => overrides.workspaceEnabled ?? true);
  ws.createForSession.mockImplementation(
    overrides.createForSession ?? (async () => ({ workspaceId: 'ws-pi', dir: 'C:\\fake\\ws-pi' })),
  );
  ws.getRecord.mockImplementation(
    overrides.getRecord ?? ((wsId: string) => (wsId === 'ws-live' ? { name: null } : null)),
  );
  const pi = new PiSessionCoordinator(
    ws as unknown as SessionWorkspaceCoordinator,
    overrides.settings ?? makeSettings(),
  );
  pi.attachHooks(hooks);
  pi.attachSessionLookup(overrides.lookup ?? makeLookup());
  return { pi, hooks, ws };
}

describe('PiSessionCoordinator — session_start(reason 分发)', () => {
  it('reason=new + 开关开 → 建 workspace + 记映射 + onPiAgentChanged(true)', async () => {
    const { pi, hooks, ws } = makePi();
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'pi-1',
      event: 'session_start',
      reason: 'new',
    });
    expect(ws.createForSession).toHaveBeenCalledWith('s1');
    expect(hooks.onPiAgentChanged).toHaveBeenCalledWith('s1', true);
    // resume 同一 pi 对话 → 映射活 → 切回不新建
    ws.getRecord.mockReturnValueOnce({ name: null });
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'pi-1',
      event: 'session_start',
      reason: 'resume',
    });
    expect(ws.switchSessionToWorkspace).toHaveBeenCalledWith('s1', 'ws-pi');
    expect(ws.createForSession).toHaveBeenCalledTimes(1); // 没新建
  });

  it('reason=new + settings.enabled=false → 不建 workspace,但 onPiAgentChanged 仍调', async () => {
    const { pi, hooks, ws } = makePi({ settings: makeSettings({ enabled: false }) });
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'pi-1',
      event: 'session_start',
      reason: 'new',
    });
    expect(ws.createForSession).not.toHaveBeenCalled();
    expect(hooks.onPiAgentChanged).toHaveBeenCalledWith('s1', true);
  });

  it('reason=resume + 目标 workspace 被回收 → 重建并更新映射', async () => {
    const { pi, ws } = makePi({ getRecord: () => null }); // 全部判定被回收
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'pi-1',
      event: 'session_start',
      reason: 'new',
    });
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'pi-1',
      event: 'session_start',
      reason: 'resume',
    });
    expect(ws.createForSession).toHaveBeenCalledTimes(2); // resume 时重建
  });

  it('workspace 未启用 → 不建不切(hooks 仍调)', async () => {
    const { pi, hooks, ws } = makePi({ workspaceEnabled: false });
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'pi-1',
      event: 'session_start',
      reason: 'new',
    });
    expect(ws.createForSession).not.toHaveBeenCalled();
    expect(hooks.onPiAgentChanged).toHaveBeenCalledWith('s1', true);
  });
});

describe('PiSessionCoordinator — 主锁(子 agent 忽略)', () => {
  it('主绑定后,子 piSid 的 session_start 被忽略(不建 workspace、不抢绑定)', async () => {
    const { pi, hooks, ws } = makePi();
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'pi-main',
      event: 'session_start',
      reason: 'startup',
    });
    ws.createForSession.mockClear();
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'subagent-1',
      event: 'session_start',
      reason: 'fork',
    });
    expect(ws.createForSession).not.toHaveBeenCalled();
    expect(hooks.onPiAgentChanged).toHaveBeenCalledTimes(1); // 只主的那次
  });

  it('子 piSid 的 name_changed 被忽略(不污染主名)', async () => {
    const { pi, hooks } = makePi();
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'pi-main',
      event: 'session_start',
      reason: 'startup',
    });
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'sub-1',
      event: 'name_changed',
      name: 'subagent-xxx',
    });
    // onPiName 只被主那次调过(且被忽略分支不调)
    expect(hooks.onPiName).not.toHaveBeenCalled();
  });

  it('主 shutdown 后再 start 新主 → 新主正常绑定', async () => {
    const { pi, hooks, ws } = makePi();
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'pi-old',
      event: 'session_start',
      reason: 'startup',
    });
    await pi.handlePiSessionEvent('s1', { piSessionId: 'pi-old', event: 'session_shutdown' });
    hooks.onPiAgentChanged.mockClear();
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'pi-new',
      event: 'session_start',
      reason: 'new',
    });
    expect(ws.createForSession).toHaveBeenCalled();
    expect(hooks.onPiAgentChanged).toHaveBeenCalledWith('s1', true);
  });
});

describe('PiSessionCoordinator — 其余事件 → hooks', () => {
  it('agent_working → notifyAgentWorking;agent_settled → notifyAgentSettled', async () => {
    const { pi, hooks } = makePi();
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'pi-1',
      event: 'session_start',
      reason: 'startup',
    });
    await pi.handlePiSessionEvent('s1', { piSessionId: 'pi-1', event: 'agent_working' });
    expect(hooks.notifyAgentWorking).toHaveBeenCalledWith('s1');
    await pi.handlePiSessionEvent('s1', { piSessionId: 'pi-1', event: 'agent_settled' });
    expect(hooks.notifyAgentSettled).toHaveBeenCalledWith('s1');
  });

  it('name_changed → onPiName(name);name 缺省传 null', async () => {
    const { pi, hooks } = makePi();
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'pi-1',
      event: 'session_start',
      reason: 'startup',
    });
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'pi-1',
      event: 'name_changed',
      name: '重构',
    });
    expect(hooks.onPiName).toHaveBeenCalledWith('s1', '重构');
    await pi.handlePiSessionEvent('s1', { piSessionId: 'pi-1', event: 'name_changed' });
    expect(hooks.onPiName).toHaveBeenLastCalledWith('s1', null);
  });

  it('session_shutdown → onPiAgentChanged(false) + unbindAgent', async () => {
    const { pi, hooks } = makePi();
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'pi-1',
      event: 'session_start',
      reason: 'new',
    });
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'pi-1',
      event: 'session_shutdown',
      reason: 'quit',
    });
    expect(hooks.onPiAgentChanged).toHaveBeenLastCalledWith('s1', false);
    expect(hooks.unbindAgent).toHaveBeenCalledWith('s1');
  });
});

describe('PiSessionCoordinator — session 不存在 / onSessionDestroyed', () => {
  it('session 不存在 → 静默 no-op(不抛、不调 hooks)', async () => {
    const { pi, hooks, ws } = makePi({ lookup: makeLookup({ hasSession: () => false }) });
    await expect(
      pi.handlePiSessionEvent('no-such', { piSessionId: 'pi-1', event: 'agent_settled' }),
    ).resolves.toBeUndefined();
    expect(hooks.notifyAgentSettled).not.toHaveBeenCalled();
    expect(ws.createForSession).not.toHaveBeenCalled();
  });

  it('onSessionDestroyed 清双向映射(主 lock + pi↔workspace)', async () => {
    const { pi, ws } = makePi();
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'pi-1',
      event: 'session_start',
      reason: 'new',
    });
    pi.onSessionDestroyed('s1');
    // 映射清空 → 同 piSid 再次 start 走首访重建
    const before = ws.createForSession.mock.calls.length;
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'pi-1',
      event: 'session_start',
      reason: 'resume',
    });
    expect(ws.createForSession.mock.calls.length).toBe(before + 1);
  });
});
