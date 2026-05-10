/**
 * @file src/main/session-manager.test.ts
 * @purpose SessionManager 单元测试 (CP-3 重写,对应 ADR-008 后的状态机)。
 *   覆盖 createSession 异步流、active/idle/exited 状态转移、OSC 1337 cwd
 *   跟踪、currentCwd 漂移、scrollback ring buffer、owner 切换、PTY exit 不
 *   destroy、closeSession 销毁、cwd 兜底轮询。
 *
 * @关键设计:
 * - FakePty (EventEmitter 模拟 onData/onExit/write/resize/kill) 完全绕开
 *   node-pty 原生模块
 * - WindowManager / PathManager / TemplatesManager / SettingsManager 用 stub
 * - PlatformAdapter 用 fake (返回固定 shell + 可注入的 getProcessCwd)
 * - 用 vi.useFakeTimers + vi.advanceTimersByTime 验证定时器逻辑 (idle / cwd 轮询)
 *
 * @对应文档章节: AGENTS.md 5.3 必测;CP-3 完成标志状态机模块覆盖率 > 80%
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SCROLLBACK_LIMIT,
  SessionManager,
  SessionManagerError,
  inferDisplayName,
  type PtySpawnFn,
} from './session-manager';
import { Osc1337Parser } from './osc1337-parser';
import { BUILTIN_TEMPLATES, mergeBuiltins } from './templates-manager';
import type { TemplatesManager } from './templates-manager';
import type { SettingsManager } from './settings-manager';
import type { WindowManager } from './window-manager';
import type { PathManager } from './path-manager';
import type { PlatformAdapter, ShellInfo } from './platform';
import type { Settings, Template } from '@shared/types';

// ──────────────────────────────────────────────────────────────────
// FakePty
// ──────────────────────────────────────────────────────────────────

class FakePty {
  static instances: FakePty[] = [];
  public dataListeners: ((s: string) => void)[] = [];
  public exitListeners: ((e: { exitCode: number; signal?: number }) => void)[] = [];
  public written: string[] = [];
  public resized: { cols: number; rows: number }[] = [];
  public killed = false;
  public pid = Math.floor(Math.random() * 100000);

  constructor(
    public file: string,
    public args: string[] | string,
    public options: {
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string>;
      name: string;
    },
  ) {
    FakePty.instances.push(this);
  }

  onData(listener: (s: string) => void): { dispose(): void } {
    this.dataListeners.push(listener);
    return { dispose: () => {} };
  }
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): {
    dispose(): void;
  } {
    this.exitListeners.push(listener);
    return { dispose: () => {} };
  }
  write(data: string): void {
    this.written.push(data);
  }
  resize(cols: number, rows: number): void {
    this.resized.push({ cols, rows });
  }
  kill(): void {
    this.killed = true;
  }

  // 测试触发器
  emitData(s: string): void {
    for (const l of this.dataListeners) l(s);
  }
  emitExit(exitCode: number, signal?: number): void {
    for (const l of this.exitListeners) {
      l(signal !== undefined ? { exitCode, signal } : { exitCode });
    }
  }

  static reset(): void {
    FakePty.instances = [];
  }
}

const fakeSpawn: PtySpawnFn = (file, args, options) => {
  return new FakePty(file, args, options) as unknown as ReturnType<PtySpawnFn>;
};

// ──────────────────────────────────────────────────────────────────
// Stub 依赖
// ──────────────────────────────────────────────────────────────────

function makeStubWindowManager(): WindowManager {
  return {
    getById: () => null,
    list: () => [],
    count: () => 0,
  } as unknown as WindowManager;
}

interface StubPathManager extends PathManager {
  attached: { sessionId: string; path: string }[];
  detached: string[];
}

function makeStubPathManager(): StubPathManager {
  const attached: { sessionId: string; path: string }[] = [];
  const detached: string[] = [];
  const stub = {
    attachSession(sessionId: string, path: string): void {
      attached.push({ sessionId, path });
    },
    detachSession(sessionId: string): void {
      detached.push(sessionId);
    },
    attached,
    detached,
  };
  return stub as unknown as StubPathManager;
}

function makeStubTemplatesManager(): TemplatesManager {
  // 用真实的 BUILTIN_TEMPLATES,resolve('shell') 返回内置 shell 模板
  const templates = BUILTIN_TEMPLATES;
  return {
    resolve(id: string | undefined | null): Template {
      if (id) {
        const found = templates.find((t) => t.id === id);
        if (found) return found;
      }
      return templates[0]!; // shell
    },
    getDefaultTemplateId(): string {
      return 'shell';
    },
    list(): Template[] {
      return templates;
    },
    get(id: string): Template | null {
      return templates.find((t) => t.id === id) ?? null;
    },
    on() { return this; },
    emit() { return true; },
  } as unknown as TemplatesManager;
}

function makeStubSettingsManager(
  overrides: Partial<Settings['advanced']> = {},
): SettingsManager {
  const settings: Settings = {
    version: 1,
    appearance: {
      theme: 'rose-pine',
      followSystemTheme: false,
      terminalFontFamily: '',
      terminalFontSize: 13,
      terminalLineHeight: 1.2,
      uiFontFamily: '',
      uiZoom: 1,
    },
    shell: { defaultShellId: '', newTerminalShellPolicy: 'default' },
    behavior: {
      startupBehavior: 'open-window',
      autoStart: false,
      confirmOnQuit: true,
      selectOnCopy: true,
      terminalRightClick: 'menu',
    },
    systemIntegration: { explorerContextMenu: false },
    advanced: {
      logLevel: 'INFO',
      activeIdleThresholdSeconds: 2,
      ...overrides,
    },
  };
  return {
    get: (): Settings => settings,
  } as unknown as SettingsManager;
}

interface FakeAdapterOpts {
  getProcessCwdImpl?: (pid: number) => Promise<string | null>;
}

function makeFakeAdapter(opts: FakeAdapterOpts = {}): PlatformAdapter {
  const shell: ShellInfo = {
    id: 'pwsh',
    displayName: 'PowerShell 7',
    executablePath: 'C:\\fake\\pwsh.exe',
  };
  return {
    async detectShells() {
      return [shell];
    },
    buildShellLaunchParams() {
      return { args: ['-NoLogo'], env: {} };
    },
    async registerFileManagerIntegration() {
      throw new Error('not impl');
    },
    async unregisterFileManagerIntegration() {
      throw new Error('not impl');
    },
    async getProcessCwd(pid: number) {
      return opts.getProcessCwdImpl ? opts.getProcessCwdImpl(pid) : null;
    },
    async setAutoStart() {
      throw new Error('not impl');
    },
    async isAutoStartEnabled() {
      return false;
    },
  };
}

function makeManager(
  opts: {
    spawnFn?: PtySpawnFn;
    adapter?: PlatformAdapter;
    settings?: SettingsManager;
    /** 默认 0 — 测试不走 resize quiet 窗口,避免每个测试都要算时序 */
    resizeQuietMs?: number;
  } = {},
): {
  mgr: SessionManager;
  win: WindowManager;
  path: StubPathManager;
} {
  FakePty.reset();
  const win = makeStubWindowManager();
  const path = makeStubPathManager();
  const tmpl = makeStubTemplatesManager();
  const settings = opts.settings ?? makeStubSettingsManager();
  const mgr = new SessionManager(win, path, tmpl, settings, {
    spawnFn: opts.spawnFn ?? fakeSpawn,
    platformAdapter: opts.adapter ?? makeFakeAdapter(),
    hookFileResolver: () => 'C:\\fake\\hook.ps1',
    resizeQuietMs: opts.resizeQuietMs ?? 0,
  });
  return { mgr, win, path };
}

// ──────────────────────────────────────────────────────────────────
// 测试
// ──────────────────────────────────────────────────────────────────

describe('inferDisplayName', () => {
  it('powershell.exe → PowerShell', () => {
    expect(inferDisplayName('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBe(
      'PowerShell',
    );
  });
  it('pwsh.exe → PowerShell', () => {
    expect(inferDisplayName('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('PowerShell');
  });
  it('cmd.exe → cmd', () => {
    expect(inferDisplayName('cmd.exe')).toBe('cmd');
  });
  it('bash → Bash', () => {
    expect(inferDisplayName('/usr/bin/bash')).toBe('Bash');
  });
  it('未知 shell 返回 stem', () => {
    expect(inferDisplayName('myshell')).toBe('myshell');
  });
});

describe('SessionManager — createSession', () => {
  it('创建后返回 SessionInfo,调用 attachSession,emit sessionCreated', async () => {
    const { mgr, path } = makeManager();
    const listener = vi.fn();
    mgr.on('sessionCreated', listener);
    const info = await mgr.createSession({
      pathId: 'C:\\proj\\a',
      templateId: 'shell',
      ownerWindowId: 'w-1',
      cols: 80,
      rows: 24,
    });
    expect(info.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(info.pathId).toBe('C:\\proj\\a');
    expect(info.originalCwd).toBe('C:\\proj\\a');
    expect(info.currentCwd).toBe('C:\\proj\\a');
    expect(info.ownerWindowId).toBe('w-1');
    expect(info.state).toBe('active');
    expect(info.cols).toBe(80);
    expect(info.exitCode).toBeUndefined();
    expect(path.attached).toEqual([{ sessionId: info.id, path: 'C:\\proj\\a' }]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(FakePty.instances).toHaveLength(1);
  });

  it('cols/rows 越界被夹到合法范围', async () => {
    const { mgr } = makeManager();
    const info = await mgr.createSession({
      pathId: '/proj/a',
      templateId: 'shell',
      ownerWindowId: 'w-1',
      cols: -5,
      rows: 99999,
    });
    expect(info.cols).toBe(1);
    expect(info.rows).toBe(1000);
  });

  it('未知 templateId 回退到默认模板 (resolve 兜底)', async () => {
    const { mgr } = makeManager();
    const info = await mgr.createSession({
      pathId: '/proj/a',
      templateId: 'unknown-template-id',
      ownerWindowId: 'w-1',
      cols: 80,
      rows: 24,
    });
    expect(info.templateId).toBe('shell');
  });

  it('spawn 失败时 throw PtySpawnFailed 带诊断', async () => {
    const failingSpawn: PtySpawnFn = () => {
      throw new Error('ENOENT: no such file or directory');
    };
    const { mgr } = makeManager({ spawnFn: failingSpawn });
    await expect(
      mgr.createSession({
        pathId: '/proj/a',
        templateId: 'shell',
        ownerWindowId: 'w-1',
        cols: 80,
        rows: 24,
      }),
    ).rejects.toThrow(/PtySpawnFailed/);
  });

  it('detectShells 返回空时 throw NoShellAvailable', async () => {
    const adapter: PlatformAdapter = {
      ...makeFakeAdapter(),
      async detectShells() {
        return [];
      },
    };
    const { mgr } = makeManager({ adapter });
    await expect(
      mgr.createSession({
        pathId: '/proj/a',
        templateId: 'shell',
        ownerWindowId: 'w-1',
        cols: 80,
        rows: 24,
      }),
    ).rejects.toThrow(/NoShellAvailable/);
  });
});

describe('SessionManager — 状态机 (active / idle / exited)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('初始 state=active', async () => {
    const { mgr } = makeManager();
    const info = await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    expect(info.state).toBe('active');
  });

  it('无输出超过 idle 阈值 → state=idle', async () => {
    const settings = makeStubSettingsManager({ activeIdleThresholdSeconds: 1 });
    const { mgr } = makeManager({ settings });
    const stateChanges: { state?: string }[] = [];
    mgr.on('sessionStateChanged', (e: { changes: { state?: string } }) =>
      stateChanges.push(e.changes),
    );
    const info = await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    const fp = FakePty.instances[0]!;
    // 触发一次输出 → active + 启动 idle 计时器
    fp.emitData('hello');
    // 推进超过阈值
    vi.advanceTimersByTime(1100);
    expect(mgr.get(info.id)?.state).toBe('idle');
    // 至少有一条 state-changed 把 state 改成 idle
    const idleChange = stateChanges.find((c) => c.state === 'idle');
    expect(idleChange).toBeDefined();
  });

  it('resize 后 quiet 窗口内 ConPTY 重绘字节不触发 markActive (CP-3 勘误 #3 v2)', async () => {
    const settings = makeStubSettingsManager({ activeIdleThresholdSeconds: 1 });
    const { mgr } = makeManager({ settings, resizeQuietMs: 500 });
    const info = await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    const fp = FakePty.instances[0]!;
    // 让 session 进入 idle
    fp.emitData('hi');
    vi.advanceTimersByTime(1100);
    expect(mgr.get(info.id)?.state).toBe('idle');

    // 模拟切窗口/接管时的流程:resize 一下,然后 PTY 立刻重发屏幕内容
    // (Windows ConPTY 在 resize 时的标准行为)。
    mgr.resize(info.id, 100, 30);
    fp.emitData('CONPTY-REDRAW-CONTENT');
    // quiet 窗口内仍是 idle,不闪绿
    expect(mgr.get(info.id)?.state).toBe('idle');

    // scrollback 仍正常追加 (重绘内容用户视觉上要看到)
    const sb = mgr.getScrollback(info.id);
    expect(Buffer.from(sb.data, 'base64').toString('utf8')).toContain(
      'CONPTY-REDRAW-CONTENT',
    );
  });

  it('resize 后超过 quiet 窗口,后续输出仍正常触发 markActive', async () => {
    const settings = makeStubSettingsManager({ activeIdleThresholdSeconds: 1 });
    const { mgr } = makeManager({ settings, resizeQuietMs: 500 });
    const info = await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    const fp = FakePty.instances[0]!;
    fp.emitData('hi');
    vi.advanceTimersByTime(1100);
    expect(mgr.get(info.id)?.state).toBe('idle');

    mgr.resize(info.id, 100, 30);
    // 推进超过 quiet 窗口
    vi.advanceTimersByTime(600);
    fp.emitData('真实用户活动');
    expect(mgr.get(info.id)?.state).toBe('active');
  });

  it('同尺寸 resize 不开 quiet 窗口 (避免无谓压制活跃)', async () => {
    const settings = makeStubSettingsManager({ activeIdleThresholdSeconds: 1 });
    const { mgr } = makeManager({ settings, resizeQuietMs: 500 });
    const info = await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    const fp = FakePty.instances[0]!;
    fp.emitData('hi');
    vi.advanceTimersByTime(1100);
    expect(mgr.get(info.id)?.state).toBe('idle');

    mgr.resize(info.id, 80, 24); // 与当前尺寸完全一致
    fp.emitData('user types');
    // 同尺寸不开窗口,所以这次输出应该触发 markActive
    expect(mgr.get(info.id)?.state).toBe('active');
  });

  it('idle 后再有输出 → state=active', async () => {
    const settings = makeStubSettingsManager({ activeIdleThresholdSeconds: 1 });
    const { mgr } = makeManager({ settings });
    const info = await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    const fp = FakePty.instances[0]!;
    fp.emitData('hi');
    vi.advanceTimersByTime(1100);
    expect(mgr.get(info.id)?.state).toBe('idle');
    fp.emitData('again');
    expect(mgr.get(info.id)?.state).toBe('active');
  });

  it('PTY 退出 → state=exited,session 仍在 sessions Map (不立即销毁)', async () => {
    const { mgr } = makeManager();
    const exitedListener = vi.fn();
    const destroyedListener = vi.fn();
    mgr.on('sessionExited', exitedListener);
    mgr.on('sessionDestroyed', destroyedListener);
    const info = await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    const fp = FakePty.instances[0]!;
    fp.emitExit(42);
    expect(exitedListener).toHaveBeenCalledTimes(1);
    expect(destroyedListener).not.toHaveBeenCalled(); // ADR-008:不立即销毁
    const after = mgr.get(info.id)!;
    expect(after.state).toBe('exited');
    expect(after.exitCode).toBe(42);
    expect(after.exitedAt).toBeGreaterThan(0);
    expect(mgr.count()).toBe(1); // 仍在 sessions Map
  });

  it('exited session 不可再回到 active (markActive guard)', async () => {
    const { mgr } = makeManager();
    const info = await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    const fp = FakePty.instances[0]!;
    fp.emitExit(0);
    // 模拟 race:emitData 在 emitExit 之后 (理论上不应发生,但 PTY 边界情况要防御)
    fp.emitData('post-exit');
    expect(mgr.get(info.id)?.state).toBe('exited');
  });

  it('closeSession 在 exited session 上 → 销毁,emit sessionDestroyed', async () => {
    const { mgr, path } = makeManager();
    const destroyedListener = vi.fn();
    mgr.on('sessionDestroyed', destroyedListener);
    const info = await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    const fp = FakePty.instances[0]!;
    fp.emitExit(0);
    expect(mgr.get(info.id)?.state).toBe('exited');

    mgr.closeSession(info.id);
    expect(destroyedListener).toHaveBeenCalledWith({
      sessionId: info.id,
      reason: 'user-closed',
    });
    expect(mgr.get(info.id)).toBeNull();
    expect(path.detached).toContain(info.id);
  });

  it('closeSession 在 active session 上 → kill PTY + 销毁', async () => {
    const { mgr } = makeManager();
    const info = await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    const fp = FakePty.instances[0]!;
    mgr.closeSession(info.id);
    expect(fp.killed).toBe(true);
    expect(mgr.get(info.id)).toBeNull();
  });
});

describe('SessionManager — OSC 1337 cwd 跟踪 (ADR-008)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('收到 OSC 1337 CurrentDir → 更新 currentCwd,不动 pathId', async () => {
    const { mgr } = makeManager();
    const stateChanges: { currentCwd?: string }[] = [];
    mgr.on('sessionStateChanged', (e: { changes: { currentCwd?: string } }) =>
      stateChanges.push(e.changes),
    );
    const info = await mgr.createSession({
      pathId: 'C:\\original',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    expect(info.currentCwd).toBe('C:\\original');

    const fp = FakePty.instances[0]!;
    // \x1b]1337;CurrentDir=C:\new\x07
    fp.emitData('prefix\x1b]1337;CurrentDir=C:\\\\new\x07suffix');

    const after = mgr.get(info.id)!;
    expect(after.pathId).toBe('C:\\original'); // 不变
    expect(after.currentCwd.toLowerCase()).toBe('c:\\new');
    const cwdChange = stateChanges.find((c) => c.currentCwd !== undefined);
    expect(cwdChange).toBeDefined();
  });

  it('OSC 1337 序列被字节流剥离,passthrough 透传非 OSC 字节', async () => {
    const { mgr } = makeManager();
    let receivedOutput: string | null = null;
    mgr.on('sessionOutput', (e: { data: string }) => {
      receivedOutput = Buffer.from(e.data, 'base64').toString('utf8');
    });
    await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    const fp = FakePty.instances[0]!;
    fp.emitData('hello\x1b]1337;CurrentDir=/x\x07world');
    expect(receivedOutput).toBe('helloworld');
  });

  it('收到首条 OSC 后,cwd 兜底轮询永久关闭', async () => {
    const cwdImpl = vi.fn().mockResolvedValue('/from-poll');
    const adapter = makeFakeAdapter({ getProcessCwdImpl: cwdImpl });
    const { mgr } = makeManager({ adapter });
    await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    const fp = FakePty.instances[0]!;
    // 在 grace 期内收到 OSC
    fp.emitData('\x1b]1337;CurrentDir=/from-osc\x07');
    // 推进超过 grace + poll 周期
    vi.advanceTimersByTime(15_000);
    // 即使有时间推进,getProcessCwd 不应被调用 (轮询从未启动)
    expect(cwdImpl).not.toHaveBeenCalled();
  });

  it('grace 后无 OSC → 启动 cwd 轮询,用 adapter 返回值更新 currentCwd', async () => {
    const cwdImpl = vi.fn().mockResolvedValue('C:\\polled');
    const adapter = makeFakeAdapter({ getProcessCwdImpl: cwdImpl });
    const { mgr } = makeManager({ adapter });
    const info = await mgr.createSession({
      pathId: 'C:\\original',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    // advanceTimersByTimeAsync 不仅推进 timer,还会 flush 内部 await 的
    // microtask 队列 — tickCwdPoll 内部的 await getProcessCwd() 才真的会
    // 解析。同步版本的 advanceTimersByTime 只触发 setInterval 回调,不等
    // 内部 promise resolve。
    await vi.advanceTimersByTimeAsync(5_000); // grace 到点 → setInterval 起步
    await vi.advanceTimersByTimeAsync(5_000); // 第一次 tick
    expect(cwdImpl).toHaveBeenCalled();
    const after = mgr.get(info.id)!;
    expect(after.currentCwd.toLowerCase()).toBe('c:\\polled');
  });
});

describe('SessionManager — scrollback ring buffer', () => {
  it('追加输出到 scrollback;getScrollback 返回 base64', async () => {
    const { mgr } = makeManager();
    const info = await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    const fp = FakePty.instances[0]!;
    fp.emitData('line1\n');
    fp.emitData('line2\n');
    const sb = mgr.getScrollback(info.id);
    const text = Buffer.from(sb.data, 'base64').toString('utf8');
    expect(text).toBe('line1\nline2\n');
    expect(sb.lastSeq).toBe(1);
  });

  it('超过 SCROLLBACK_LIMIT 时尾部裁切', async () => {
    const { mgr } = makeManager();
    const info = await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    const fp = FakePty.instances[0]!;
    // 写超出上限的数据;每次 1MB,共 4MB
    const oneMb = 'x'.repeat(1024 * 1024);
    for (let i = 0; i < 4; i++) fp.emitData(oneMb);
    const sb = mgr.getScrollback(info.id);
    const len = Buffer.from(sb.data, 'base64').length;
    expect(len).toBe(SCROLLBACK_LIMIT);
  });

  it('OSC 1337 不进 scrollback', async () => {
    const { mgr } = makeManager();
    const info = await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    const fp = FakePty.instances[0]!;
    fp.emitData('A\x1b]1337;CurrentDir=/x\x07B');
    const sb = mgr.getScrollback(info.id);
    const text = Buffer.from(sb.data, 'base64').toString('utf8');
    expect(text).toBe('AB');
  });
});

describe('SessionManager — owner 切换', () => {
  it('claimOwner 将无主 session 切给 windowId', async () => {
    const { mgr } = makeManager();
    const info = await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: '',
      cols: 80,
      rows: 24,
    });
    expect(info.ownerWindowId).toBeNull();
    mgr.claimOwner(info.id, 'w-2');
    expect(mgr.get(info.id)?.ownerWindowId).toBe('w-2');
  });

  it('claimOwner 当前 owner 是别的窗口 → throw SessionAlreadyOwned', async () => {
    const { mgr } = makeManager();
    const info = await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: 'w-1',
      cols: 80,
      rows: 24,
    });
    expect(() => mgr.claimOwner(info.id, 'w-2')).toThrowError(/SessionAlreadyOwned/);
  });

  it('claimOwner 释放本窗口已持有的其他 session', async () => {
    const { mgr } = makeManager();
    const a = await mgr.createSession({
      pathId: '/a',
      templateId: 'shell',
      ownerWindowId: 'w-1',
      cols: 80,
      rows: 24,
    });
    const b = await mgr.createSession({
      pathId: '/b',
      templateId: 'shell',
      ownerWindowId: '',
      cols: 80,
      rows: 24,
    });
    expect(mgr.get(a.id)?.ownerWindowId).toBe('w-1');
    mgr.claimOwner(b.id, 'w-1');
    // a 被释放,b 被 w-1 持有
    expect(mgr.get(a.id)?.ownerWindowId).toBeNull();
    expect(mgr.get(b.id)?.ownerWindowId).toBe('w-1');
  });

  it('handleWindowClosed 把该窗口持有的所有 session owner 设 null,不杀 PTY', async () => {
    const { mgr } = makeManager();
    const info = await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: 'w-1',
      cols: 80,
      rows: 24,
    });
    const fp = FakePty.instances[0]!;
    mgr.handleWindowClosed('w-1');
    expect(mgr.get(info.id)?.ownerWindowId).toBeNull();
    expect(fp.killed).toBe(false); // 不杀 PTY
    expect(mgr.count()).toBe(1); // session 仍在
  });

  it('releaseOwner 必须由 owner 自己调,否则 throw NotOwner', async () => {
    const { mgr } = makeManager();
    const info = await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: 'w-1',
      cols: 80,
      rows: 24,
    });
    expect(() => mgr.releaseOwner(info.id, 'w-2')).toThrowError(/NotOwner/);
    mgr.releaseOwner(info.id, 'w-1');
    expect(mgr.get(info.id)?.ownerWindowId).toBeNull();
  });
});

describe('SessionManager — sendInput / resize', () => {
  it('sendInput 把 base64 解码后 write 到 PTY', async () => {
    const { mgr } = makeManager();
    const info = await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    const fp = FakePty.instances[0]!;
    mgr.sendInput(info.id, Buffer.from('echo hi\n', 'utf8').toString('base64'));
    expect(fp.written).toEqual(['echo hi\n']);
  });

  it('sendInput 在 exited session 上静默 (不报错)', async () => {
    const { mgr } = makeManager();
    const info = await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    const fp = FakePty.instances[0]!;
    fp.emitExit(0);
    expect(() =>
      mgr.sendInput(info.id, Buffer.from('x', 'utf8').toString('base64')),
    ).not.toThrow();
  });

  it('resize 透传到 PTY', async () => {
    const { mgr } = makeManager();
    const info = await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    const fp = FakePty.instances[0]!;
    mgr.resize(info.id, 100, 30);
    expect(fp.resized).toEqual([{ cols: 100, rows: 30 }]);
    expect(mgr.get(info.id)!.cols).toBe(100);
    expect(mgr.get(info.id)!.rows).toBe(30);
  });
});

describe('SessionManager — shutdown', () => {
  it('销毁所有 session', async () => {
    const { mgr } = makeManager();
    await mgr.createSession({
      pathId: '/a',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    await mgr.createSession({
      pathId: '/b',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    expect(mgr.count()).toBe(2);
    mgr.shutdown();
    expect(mgr.count()).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────
// 子模块单测:OSC 1337 解析器
// ──────────────────────────────────────────────────────────────────

describe('Osc1337Parser', () => {
  it('简单 OSC 1337 CurrentDir,BEL 终止', () => {
    const p = new Osc1337Parser();
    const r = p.parse(Buffer.from('A\x1b]1337;CurrentDir=/x\x07B'));
    expect(r.passthrough.toString('utf8')).toBe('AB');
    expect(r.events).toEqual([{ kind: 'cwd', value: '/x' }]);
  });

  it('ST (ESC \\) 也作为合法终止符', () => {
    const p = new Osc1337Parser();
    const r = p.parse(Buffer.from('\x1b]1337;CurrentDir=/y\x1b\\rest'));
    expect(r.passthrough.toString('utf8')).toBe('rest');
    expect(r.events).toEqual([{ kind: 'cwd', value: '/y' }]);
  });

  it('其他 OSC (例如 OSC 0 设置 title) 透传不解析', () => {
    const p = new Osc1337Parser();
    const r = p.parse(Buffer.from('\x1b]0;hello\x07'));
    expect(r.passthrough).toEqual(Buffer.from('\x1b]0;hello\x07'));
    expect(r.events).toEqual([]);
  });

  it('序列被两次 chunk 切分 → 第二次完成解析', () => {
    const p = new Osc1337Parser();
    const r1 = p.parse(Buffer.from('\x1b]1337;CurrentDir=/'));
    expect(r1.events).toEqual([]);
    expect(r1.passthrough.length).toBe(0);
    expect(p.stashedBytes).toBeGreaterThan(0);
    const r2 = p.parse(Buffer.from('foo\x07TAIL'));
    expect(r2.events).toEqual([{ kind: 'cwd', value: '/foo' }]);
    expect(r2.passthrough.toString('utf8')).toBe('TAIL');
    expect(p.stashedBytes).toBe(0);
  });

  it('夹在 ANSI 中的多个 OSC', () => {
    const p = new Osc1337Parser();
    const data = Buffer.from(
      '\x1b[31mred\x1b[0m\x1b]1337;CurrentDir=/a\x07normal\x1b]1337;CurrentDir=/b\x07end',
    );
    const r = p.parse(data);
    expect(r.passthrough.toString('utf8')).toBe('\x1b[31mred\x1b[0mnormalend');
    expect(r.events).toEqual([
      { kind: 'cwd', value: '/a' },
      { kind: 'cwd', value: '/b' },
    ]);
  });

  it('未知 key 进 unknown 事件,raw 保留', () => {
    const p = new Osc1337Parser();
    const r = p.parse(Buffer.from('\x1b]1337;RemoteHost=x.y.z\x07'));
    expect(r.events).toEqual([{ kind: 'unknown', raw: 'RemoteHost=x.y.z' }]);
  });

  it('孤立的 ESC 在末尾 → 存 stash,不丢字节', () => {
    const p = new Osc1337Parser();
    const r1 = p.parse(Buffer.from('hello\x1b'));
    expect(r1.passthrough.toString('utf8')).toBe('hello');
    expect(p.stashedBytes).toBe(1);
    // 下次 chunk 不是 ] → ESC 当普通字节透传
    const r2 = p.parse(Buffer.from('[31m'));
    expect(r2.passthrough.toString('utf8')).toBe('\x1b[31m');
  });

  it('超长 stash (> 16KB 没终止符) → flush 为透传,不死循环', () => {
    const p = new Osc1337Parser();
    const giant = '\x1b]1337;' + 'x'.repeat(20_000); // 没有终止符
    const r = p.parse(Buffer.from(giant));
    // 两次 parse 都不该卡住
    expect(p.stashedBytes).toBeLessThanOrEqual(16 * 1024);
    void r;
    const r2 = p.parse(Buffer.from('more'));
    // stash 加上 more 后超限 → 整段透传
    expect(r2.passthrough.length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────
// 子模块单测:TemplatesManager.mergeBuiltins
// ──────────────────────────────────────────────────────────────────

describe('TemplatesManager.mergeBuiltins', () => {
  it('空文件 → 4 个内置模板齐全,defaultId=shell', () => {
    const r = mergeBuiltins([], '');
    expect(r.templates).toHaveLength(4);
    expect(r.templates.map((t) => t.id)).toEqual(['shell', 'claude-code', 'codex', 'opencode']);
    expect(r.defaultId).toBe('shell');
    expect(r.mutated).toBe(true);
  });

  it('用户改了内置模板的 name/icon → 保留用户版本,但 isBuiltin 强制 true', () => {
    const userVersion: Template = {
      id: 'shell',
      name: 'My Shell',
      icon: '🦊',
      isBuiltin: false, // 用户/损坏文件错误地设为 false
      command: '',
      args: [],
      env: {},
      shellFirst: true,
      postExitAction: 'close_session',
    };
    const r = mergeBuiltins([userVersion], 'shell');
    const shell = r.templates.find((t) => t.id === 'shell')!;
    expect(shell.name).toBe('My Shell');
    expect(shell.icon).toBe('🦊');
    expect(shell.isBuiltin).toBe(true); // 被强制纠正
  });

  it('自定义模板 (id 不在 BUILTIN) 保留', () => {
    const custom: Template = {
      id: 'my-custom',
      name: 'My Custom',
      icon: '🔧',
      isBuiltin: false,
      command: 'custom-cmd',
      args: [],
      env: {},
      shellFirst: false,
      postExitAction: 'close_session',
    };
    const r = mergeBuiltins([custom], 'my-custom');
    expect(r.templates.find((t) => t.id === 'my-custom')).toBeDefined();
    expect(r.defaultId).toBe('my-custom');
  });

  it('defaultId 不存在 → 回退到 shell', () => {
    const r = mergeBuiltins([], 'nonexistent');
    expect(r.defaultId).toBe('shell');
    expect(r.mutated).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────
// 错误类型
// ──────────────────────────────────────────────────────────────────

describe('SessionManagerError', () => {
  it('包含 code 与详细 message', () => {
    const err = new SessionManagerError('SessionNotFound', 'sid="abc"', { sid: 'abc' });
    expect(err.code).toBe('SessionNotFound');
    expect(err.message).toContain('SessionNotFound');
    expect(err.details).toEqual({ sid: 'abc' });
  });
});
