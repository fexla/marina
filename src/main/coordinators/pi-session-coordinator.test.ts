/**
 * @file pi-session-coordinator.test.ts
 * @purpose PiSessionCoordinator 单测:主 piSessionId 锁定 + reason 分发 + hooks 调用 +
 * pi↔workspace 映射 + subagent 聚合状态(v0.3.4:前台抑制 settled / 后台拉回
 * working / 延迟 teardown / 泄露回收)。全部 mock(workspaceCoordinator / hooks /
 * settings / lookup),不碰 SessionManager 状态机(状态副作用由 hooks 的 mock
 * 断言「调用了谁」)。
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
  /** workspace 切换 notify 回调(pi resume/new 后触发文件面板重建)。 */
  onWorkspaceSwitched: ReturnType<typeof vi.fn>;
}
function makePi(
  overrides: {
    settings?: PiSettingsSource;
    lookup?: SessionLookup | null;
    workspaceEnabled?: boolean;
    createForSession?: () => Promise<{ workspaceId: string; dir: string }>;
    getRecord?: (wsId: string) => unknown;
    /** 注入时钟(泄露回收测试);缺省真实 Date.now。 */
    now?: () => number;
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
    overrides.now,
  );
  pi.attachHooks(hooks);
  pi.attachSessionLookup(overrides.lookup ?? makeLookup());
  const onWorkspaceSwitched = vi.fn();
  pi.attachWorkspaceSwitchNotify(onWorkspaceSwitched);
  return { pi, hooks, ws, onWorkspaceSwitched };
}

describe('PiSessionCoordinator — session_start(reason 分发)', () => {
  it('reason=new + 开关开 → 建 workspace + 返回 workspaceId(交回 bridge 存 entry)', async () => {
    const { pi, hooks, ws } = makePi();
    const r = await pi.handlePiSessionEvent('s1', {
      piSessionId: 'pi-1',
      event: 'session_start',
      reason: 'new',
    });
    expect(ws.createForSession).toHaveBeenCalledWith('s1');
    expect(hooks.onPiAgentChanged).toHaveBeenCalledWith('s1', true);
    expect(r).toEqual({ workspaceId: 'ws-pi' }); // 新建 id 交回 bridge 存 entry
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

  it('reason=resume + payload 带 workspaceId 且活 → 切回不新建(不返回 id)', async () => {
    const { pi, ws } = makePi({ getRecord: () => ({ name: null }) }); // workspace 活
    const r = await pi.handlePiSessionEvent('s1', {
      piSessionId: 'pi-1',
      event: 'session_start',
      reason: 'resume',
      workspaceId: 'ws-from-entry', // bridge 从对话 entry 读出带上
    });
    expect(ws.switchSessionToWorkspace).toHaveBeenCalledWith('s1', 'ws-from-entry');
    expect(ws.createForSession).not.toHaveBeenCalled(); // 没新建
    expect(r).toBeUndefined(); // 切回已有,不返回 id(entry 里已是同一个)
  });

  it('reason=resume + payload workspaceId 被回收 → 重建并返回新 id', async () => {
    const { pi, ws } = makePi({ getRecord: () => null }); // 全部判定被回收
    const r = await pi.handlePiSessionEvent('s1', {
      piSessionId: 'pi-1',
      event: 'session_start',
      reason: 'resume',
      workspaceId: 'ws-reclaimed',
    });
    expect(ws.createForSession).toHaveBeenCalledWith('s1'); // 重建
    expect(r).toEqual({ workspaceId: 'ws-pi' }); // 返回新 id 让 bridge 更新 entry
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

  // ── resume/new 后触发文件面板重建 notify(修 resume 文件不恢复)──

  it('reason=new 新建 workspace 后触发 onWorkspaceSwitched(文件面板重建)', async () => {
    const { pi, onWorkspaceSwitched } = makePi();
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'pi-1',
      event: 'session_start',
      reason: 'new',
    });
    expect(onWorkspaceSwitched).toHaveBeenCalledWith('s1');
  });

  it('reason=resume 切回活 workspace 后触发 onWorkspaceSwitched(文件面板恢复)', async () => {
    // bridge 从 entry 读出 workspaceId 带上 → Marina 切回活 workspace
    const { pi, onWorkspaceSwitched, ws } = makePi({ getRecord: () => ({ name: null }) });
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'pi-1',
      event: 'session_start',
      reason: 'resume',
      workspaceId: 'ws-from-entry',
    });
    expect(ws.switchSessionToWorkspace).toHaveBeenCalledWith('s1', 'ws-from-entry');
    // 核心:切回后必须触发 notify,否则文件面板不重建、原打开文件不恢复
    expect(onWorkspaceSwitched).toHaveBeenCalledWith('s1');
  });

  it('resume 时 workspace 被回收 → 重建并触发 onWorkspaceSwitched', async () => {
    const { pi, onWorkspaceSwitched } = makePi({ getRecord: () => null });
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'pi-1',
      event: 'session_start',
      reason: 'resume',
      workspaceId: 'ws-reclaimed',
    });
    expect(onWorkspaceSwitched).toHaveBeenCalledWith('s1');
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

describe('PiSessionCoordinator — subagent 聚合状态(v0.3.4,L3 重开)', () => {
  /** 标准起手:主 pi start → working → settled(终端此刻 idle)。 */
  async function settleMain(pi: PiSessionCoordinator) {
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'pi-main',
      event: 'session_start',
      reason: 'startup',
    });
    await pi.handlePiSessionEvent('s1', { piSessionId: 'pi-main', event: 'agent_working' });
    await pi.handlePiSessionEvent('s1', { piSessionId: 'pi-main', event: 'agent_settled' });
  }

  it('后台子 agent 开干(主已 settled)→ 上升沿拉回 working;排空 → settled', async () => {
    const { pi, hooks } = makePi();
    await settleMain(pi);
    hooks.notifyAgentWorking.mockClear();
    hooks.notifyAgentSettled.mockClear();
    // 子进程启动并开始工作(事件被主锁拦截 → 进聚合)
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'sub-1',
      event: 'session_start',
      reason: 'fork',
    });
    await pi.handlePiSessionEvent('s1', { piSessionId: 'sub-1', event: 'agent_working' });
    expect(hooks.notifyAgentWorking).toHaveBeenCalledTimes(1); // 上升沿:状态回 active
    // 子收工 → 聚合下降沿:idle + hasUnviewedWork(走主 agent 收工同一路径)
    await pi.handlePiSessionEvent('s1', { piSessionId: 'sub-1', event: 'agent_settled' });
    expect(hooks.notifyAgentSettled).toHaveBeenCalledTimes(1);
  });

  it('前台子 agent:主 working 期间子事件不重复 notify;主 settled 被抑制,等子收工才真 idle', async () => {
    const { pi, hooks } = makePi();
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'pi-main',
      event: 'session_start',
      reason: 'startup',
    });
    await pi.handlePiSessionEvent('s1', { piSessionId: 'pi-main', event: 'agent_working' });
    // 主在干,子(task 工具)启动 + 开干 → 无新增 notify(聚合本来就在 working)
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'sub-1',
      event: 'session_start',
      reason: 'fork',
    });
    await pi.handlePiSessionEvent('s1', { piSessionId: 'sub-1', event: 'agent_working' });
    expect(hooks.notifyAgentWorking).toHaveBeenCalledTimes(1);
    // 主这轮完成但子还在干 → settled 抑制(不 notify,状态保持 active)
    await pi.handlePiSessionEvent('s1', { piSessionId: 'pi-main', event: 'agent_settled' });
    expect(hooks.notifyAgentSettled).not.toHaveBeenCalled();
    // 子收工 → 这时才真 idle + 未看标记
    await pi.handlePiSessionEvent('s1', { piSessionId: 'sub-1', event: 'agent_settled' });
    expect(hooks.notifyAgentSettled).toHaveBeenCalledTimes(1);
  });

  it('主退出但子在干 → 延迟 teardown;子排空的下降沿补 unbind + isPiAgent=false', async () => {
    const { pi, hooks } = makePi();
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'pi-main',
      event: 'session_start',
      reason: 'startup',
    });
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'sub-1',
      event: 'session_start',
      reason: 'fork',
    });
    await pi.handlePiSessionEvent('s1', { piSessionId: 'sub-1', event: 'agent_working' });
    // 主退出(quit)→ 子还在干,teardown 延迟
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'pi-main',
      event: 'session_shutdown',
      reason: 'quit',
    });
    expect(hooks.unbindAgent).not.toHaveBeenCalled();
    // 子收工 → 下降沿:settled + 补 teardown
    await pi.handlePiSessionEvent('s1', { piSessionId: 'sub-1', event: 'agent_settled' });
    expect(hooks.notifyAgentSettled).toHaveBeenCalledTimes(1);
    expect(hooks.unbindAgent).toHaveBeenCalledWith('s1');
    expect(hooks.onPiAgentChanged).toHaveBeenLastCalledWith('s1', false);
  });

  it('主退出+子在干期间用户新起 pi(/new)→ 延迟 teardown 取消,子收工不误伤新主', async () => {
    const { pi, hooks } = makePi();
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'pi-a',
      event: 'session_start',
      reason: 'startup',
    });
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'sub-1',
      event: 'session_start',
      reason: 'fork',
    });
    await pi.handlePiSessionEvent('s1', { piSessionId: 'sub-1', event: 'agent_working' });
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'pi-a',
      event: 'session_shutdown',
      reason: 'new',
    });
    // 新主接管(旧主已 shutdown 清锁)→ 取消延迟 teardown,getter 复用不重复 bind
    const bindsBefore = hooks.bindAgent.mock.calls.length;
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'pi-b',
      event: 'session_start',
      reason: 'new',
    });
    expect(hooks.bindAgent.mock.calls.length).toBe(bindsBefore);
    // 子收工 → 下降沿 settled 通知,但不 teardown(新主还活着)
    await pi.handlePiSessionEvent('s1', { piSessionId: 'sub-1', event: 'agent_settled' });
    expect(hooks.notifyAgentSettled).toHaveBeenCalledTimes(1);
    expect(hooks.unbindAgent).not.toHaveBeenCalled();
  });

  it('已注册子永不升级为主:主退出后子的 session_start 不抢 workspace/绑定', async () => {
    const { pi, hooks, ws } = makePi();
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'pi-main',
      event: 'session_start',
      reason: 'startup',
    });
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'sub-1',
      event: 'session_start',
      reason: 'fork',
    });
    await pi.handlePiSessionEvent('s1', { piSessionId: 'sub-1', event: 'agent_working' });
    // 子还在干 → 主退出走延迟 teardown,注册表存活(这是注册子受保护的前提;
    // 全 idle 时主退出会立即 teardown 丢弃注册,游离子事件回落既有主路径)。
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'pi-main',
      event: 'session_shutdown',
      reason: 'quit',
    });
    // 主已退出(currentMain null)。已注册子此刻 session_start(如后台链路继续 spawn)
    // → 仍按子处理:不建 workspace、不绑主。
    ws.createForSession.mockClear();
    hooks.onPiAgentChanged.mockClear();
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'sub-1',
      event: 'session_start',
      reason: 'startup',
    });
    expect(ws.createForSession).not.toHaveBeenCalled();
    expect(hooks.onPiAgentChanged).not.toHaveBeenCalledWith('s1', true);
  });

  it('子 agent_working 未注册(竞态兜底)→ 就地注册并触发上升沿', async () => {
    const { pi, hooks } = makePi();
    await settleMain(pi);
    hooks.notifyAgentWorking.mockClear();
    // 没发 session_start,直接 agent_working(启动竞态)
    await pi.handlePiSessionEvent('s1', { piSessionId: 'sub-x', event: 'agent_working' });
    expect(hooks.notifyAgentWorking).toHaveBeenCalledTimes(1);
    // 后续 settled 也能被跟踪(未注册则忽略,这里应触发下降沿)
    hooks.notifyAgentSettled.mockClear();
    await pi.handlePiSessionEvent('s1', { piSessionId: 'sub-x', event: 'agent_settled' });
    expect(hooks.notifyAgentSettled).toHaveBeenCalledTimes(1);
  });

  it('未注册子的 settled/shutdown → 忽略,不触发虚假下降沿', async () => {
    const { pi, hooks } = makePi();
    await settleMain(pi);
    hooks.notifyAgentSettled.mockClear();
    // 主 settled 时已 notify 过一次;一个从未注册的子发 settled(乱序/回收后)
    // → 不得再次 notify(否则会把用户已查看清掉的 hasUnviewedWork 又标回去)。
    await pi.handlePiSessionEvent('s1', { piSessionId: 'ghost', event: 'agent_settled' });
    expect(hooks.notifyAgentSettled).not.toHaveBeenCalled();
  });
});

describe('PiSessionCoordinator — subagent 泄露回收(sweepStaleChildren)', () => {
  it('超过宽限期无事件的 working 子被回收 → 下降沿 settled(+延迟 teardown 补)', async () => {
    let clock = 1_000_000;
    const { pi, hooks } = makePi({ now: () => clock });
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'pi-main',
      event: 'session_start',
      reason: 'startup',
    });
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'sub-1',
      event: 'session_start',
      reason: 'fork',
    });
    await pi.handlePiSessionEvent('s1', { piSessionId: 'sub-1', event: 'agent_working' });
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'pi-main',
      event: 'session_shutdown',
      reason: 'quit',
    });
    hooks.notifyAgentSettled.mockClear();
    hooks.unbindAgent.mockClear();
    // 子被 hard-kill:此后无任何事件。推进 15 分钟 → 回收 = 下降沿 + 补 teardown。
    clock += 15 * 60_000 + 1;
    pi.sweepStaleChildren();
    expect(hooks.notifyAgentSettled).toHaveBeenCalledTimes(1);
    expect(hooks.unbindAgent).toHaveBeenCalledWith('s1');
    // 回收后再收到该子的事件 → 未注册,忽略(不二次翻转)。
    await pi.handlePiSessionEvent('s1', { piSessionId: 'sub-1', event: 'agent_settled' });
    expect(hooks.notifyAgentSettled).toHaveBeenCalledTimes(1);
  });

  it('宽限期内有事件(name_changed keep-alive)→ 不回收;onPiName 仍不被调', async () => {
    let clock = 1_000_000;
    const { pi, hooks } = makePi({ now: () => clock });
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'pi-main',
      event: 'session_start',
      reason: 'startup',
    });
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'sub-1',
      event: 'session_start',
      reason: 'fork',
    });
    await pi.handlePiSessionEvent('s1', { piSessionId: 'sub-1', event: 'agent_working' });
    // 10 分钟时子发了 name_changed(免费的活着证明)→ 15 分钟线上扫时未超宽限
    clock += 10 * 60_000;
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'sub-1',
      event: 'name_changed',
      name: 'subagent-worker-1',
    });
    expect(hooks.onPiName).not.toHaveBeenCalled(); // 污染拦截不动摇
    clock += 5 * 60_000; // 距 name_changed 仅 5 分钟 < 15 分钟
    pi.sweepStaleChildren();
    expect(hooks.notifyAgentSettled).not.toHaveBeenCalled(); // 未回收,聚合仍 working
  });

  it('session 销毁清聚合:后续子事件静默丢弃', async () => {
    const { pi, hooks } = makePi();
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'pi-main',
      event: 'session_start',
      reason: 'startup',
    });
    await pi.handlePiSessionEvent('s1', {
      piSessionId: 'sub-1',
      event: 'session_start',
      reason: 'fork',
    });
    pi.onSessionDestroyed('s1');
    hooks.notifyAgentWorking.mockClear();
    await pi.handlePiSessionEvent('s1', { piSessionId: 'sub-1', event: 'agent_working' });
    expect(hooks.notifyAgentWorking).not.toHaveBeenCalled();
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
