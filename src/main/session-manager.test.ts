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
  SessionManager,
  SessionManagerError,
  inferDisplayName,
  looksLikeShellStartupGarbage,
  type PtySpawnFn,
} from './session-manager';
import { Osc1337Parser } from './osc1337-parser';
import { BUILTIN_TEMPLATES, mergeBuiltins } from './templates-manager';
import { makePathId } from './path-manager';
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
  /** 测试可设置:true → write 时抛错,模拟 ConPTY pipe half-closed */
  public writeShouldThrow = false;
  write(data: string): void {
    if (this.writeShouldThrow) {
      throw new Error('FakePty: simulated write failure');
    }
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

function makeStubTemplatesManager(
  extraTemplates: Template[] = [],
): TemplatesManager {
  // 用真实的 BUILTIN_TEMPLATES,resolve('shell') 返回内置 shell 模板
  const templates = [...BUILTIN_TEMPLATES, ...extraTemplates];
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
      windowStyle: 'windows',
      language: 'system',
      terminalFontFamily: '',
      terminalFontSize: 13,
      terminalLineHeight: 1.2,
      uiFontFamily: '',
      uiZoom: 1,
      macOSTrafficLightHoverSymbols: false,
    },
    ai: {
      provider: null,
      apiKey: '',
      baseURL: '',
      model: '',
      statusRecheckEnabled: false,
      statusRecheckSource: 'headless',
    },
    shell: { defaultShellId: '', newTerminalShellPolicy: 'default' },
    behavior: {
      startupBehavior: 'open-window',
      autoStart: false,
      confirmOnQuit: true,
      selectOnCopy: true,
      terminalRightClick: 'menu',
      bracketedPaste: true,
    },
    systemIntegration: { explorerOpenIn: 'new-window' },
    advanced: {
      logLevel: 'INFO',
      activeIdleThresholdSeconds: 2,
      includeSshConfig: false,
      enableControlMaster: false,
      enableRemote: false,
      terminalRenderer: 'auto',
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
    lifecycleModel: 'tray-resident' as const,
    async detectShells() {
      return [shell];
    },
    resolveExecutable(commandName: string) {
      if (!commandName.trim()) return null;
      return commandName;
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
    getRefreshedPath() {
      // 测试默认走 process.env.PATH,不触发 reg query。
      return process.env.PATH ?? '';
    },
    normalizeSpawnEnv(env: Record<string, string>) {
      // 测试默认 no-op,绕开 BETA-ENV-1 Windows 规整逻辑。
      return env;
    },
    getDefaultBookmarkSeeds() {
      return [];
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
    /** M1-I:默认 0 — 同上,测试默认跳过启动期 grace,markActive 立即生效 */
    startupGraceMs?: number;
    /** 抖动源 C/E:默认 0 — 测试不走 input echo quiet 窗口 */
    inputQuietMs?: number;
    /** PER-2 / F1:默认 0 — 测试每个 chunk 立即 emit,保持现有时序断言 */
    emitBatchMs?: number;
    templates?: Template[];
  } = {},
): {
  mgr: SessionManager;
  win: WindowManager;
  path: StubPathManager;
} {
  FakePty.reset();
  const win = makeStubWindowManager();
  const path = makeStubPathManager();
  const tmpl = makeStubTemplatesManager(opts.templates ?? []);
  const settings = opts.settings ?? makeStubSettingsManager();
  const mgr = new SessionManager(win, path, tmpl, settings, {
    spawnFn: opts.spawnFn ?? fakeSpawn,
    platformAdapter: opts.adapter ?? makeFakeAdapter(),
    hookFileResolver: () => 'C:\\fake\\hook.ps1',
    resizeQuietMs: opts.resizeQuietMs ?? 0,
    startupGraceMs: opts.startupGraceMs ?? 0,
    inputQuietMs: opts.inputQuietMs ?? 0,
    emitBatchMs: opts.emitBatchMs ?? 0,
    skipCwdValidation: true,
  });
  return { mgr, win, path };
}

function decodeEmbeddedTmuxScript(command: string): string {
  const match = command.match(/printf %s (?:'\\'')?([A-Za-z0-9+/=]+)(?:'\\'')? \| base64 -d/);
  if (!match?.[1]) {
    throw new Error(`测试无法从 SSH 命令中提取 tmux base64 脚本: ${command}`);
  }
  return Buffer.from(match[1], 'base64').toString('utf8');
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
    expect(info.state).toBe('idle');
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

  it('SSH session 用平台解析出的 ssh.exe 启动,而不是默认 shell 路径', async () => {
    const adapter: PlatformAdapter = {
      ...makeFakeAdapter(),
      resolveExecutable(commandName: string) {
        return commandName === 'ssh' ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : null;
      },
    };
    const { mgr } = makeManager({ adapter });
    const pathId = makePathId({
      kind: 'ssh',
      sshProfileId: 'ssh-1',
      path: '~/repo',
    });

    const info = await mgr.createSession({
      pathId,
      templateId: 'shell',
      ownerWindowId: 'w-1',
      cols: 80,
      rows: 24,
      sshProfile: {
        id: 'ssh-1',
        name: 'prod',
        host: 'example.com',
        port: 22,
        username: 'alice',
        authType: 'agent',
      },
    });

    expect(info.displayName).toBe('prod:~/repo');
    expect(FakePty.instances[0]!.file).toBe(
      'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
    );
    expect(FakePty.instances[0]!.args).toEqual([
      '-tt',
      '-p',
      '22',
      '-o',
      'ServerAliveInterval=30',
      'alice@example.com',
      "cd \"$HOME\"/'repo' && exec \"${SHELL:-/bin/sh}\" -l",
    ]);
  });

  it('SSH remotePath 为 ~ 时使用无参数 cd,避免 quote 后禁用 home 展开', async () => {
    const adapter: PlatformAdapter = {
      ...makeFakeAdapter(),
      resolveExecutable(commandName: string) {
        return commandName === 'ssh' ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : null;
      },
    };
    const { mgr } = makeManager({ adapter });
    const pathId = makePathId({
      kind: 'ssh',
      sshProfileId: 'ssh-1',
      path: '~',
    });

    await mgr.createSession({
      pathId,
      templateId: 'shell',
      ownerWindowId: 'w-1',
      cols: 80,
      rows: 24,
      sshProfile: {
        id: 'ssh-1',
        name: 'prod',
        host: 'example.com',
        port: 22,
        username: 'alice',
        authType: 'agent',
      },
    });

    expect(FakePty.instances[0]!.args).toContain(
      'cd && exec "${SHELL:-/bin/sh}" -l',
    );
  });

  it('SSH 启动模板在远端 cwd 中执行命令/参数/env', async () => {
    const adapter: PlatformAdapter = {
      ...makeFakeAdapter(),
      resolveExecutable(commandName: string) {
        return commandName === 'ssh' ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : null;
      },
    };
    const template: Template = {
      id: 'remote-codex',
      name: 'Remote Codex',
      icon: 'R',
      isBuiltin: false,
      command: 'codex',
      args: ['--model', 'gpt-5', "it's-ok"],
      env: { MARINA_MODE: 'remote test' },
      shellFirst: true,
      postExitAction: 'keep_shell',
    };
    const { mgr } = makeManager({ adapter, templates: [template] });
    const pathId = makePathId({
      kind: 'ssh',
      sshProfileId: 'ssh-1',
      path: '~/repo',
    });

    await mgr.createSession({
      pathId,
      templateId: 'remote-codex',
      ownerWindowId: 'w-1',
      cols: 80,
      rows: 24,
      sshProfile: {
        id: 'ssh-1',
        name: 'prod',
        host: 'example.com',
        port: 22,
        username: 'alice',
        authType: 'agent',
      },
    });

    const command = (FakePty.instances[0]!.args as string[]).at(-1)!;
    expect(command).toContain('cd "$HOME"/');
    expect(command).toContain('exec "${SHELL:-/bin/sh}" -ic');
    expect(command).toContain("env '\\''MARINA_MODE=remote test'\\''");
    expect(command).toContain("'\\''codex'\\''");
    expect(command).toContain("'\\''--model'\\''");
    expect(command).toContain("'\\''gpt-5'\\''");
    expect(command).toContain("'\\''it'\\''\\'\\'''\\''s-ok'\\''");
    expect(command).toContain('marina_template_status=$?;');
    expect(command).toContain('if [ "$marina_template_status" -eq 127 ]; then');
    expect(command).toContain('Marina: remote template command not found or not in PATH: codex');
    expect(command).toContain('exec "${SHELL:-/bin/sh}" -l');
  });

  it('SSH 启用 tmux 时自动 attach-or-create,远端无 tmux 默认回退 shell', async () => {
    const adapter: PlatformAdapter = {
      ...makeFakeAdapter(),
      resolveExecutable(commandName: string) {
        return commandName === 'ssh' ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : null;
      },
    };
    const { mgr } = makeManager({ adapter });
    const pathId = makePathId({
      kind: 'ssh',
      sshProfileId: 'ssh-1',
      path: '~/repo',
    });

    await mgr.createSession({
      pathId,
      templateId: 'shell',
      ownerWindowId: 'w-1',
      cols: 80,
      rows: 24,
      sshProfile: {
        id: 'ssh-1',
        name: 'prod',
        host: 'example.com',
        port: 22,
        username: 'alice',
        authType: 'agent',
        tmuxMode: 'attach-or-create',
      },
    });

    const command = (FakePty.instances[0]!.args as string[]).at(-1)!;
    expect(command).toContain('exec "${SHELL:-/bin/sh}" -lc');
    expect(command).toContain('command -v tmux >/dev/null 2>&1');
    expect(command).toContain('MARINA_TMUX_BASE=');
    expect(command).toContain('base64 -d');
    expect(command).not.toContain("sh -c '");
    expect(command).not.toContain('<<');
    const decodedTmuxScript = decodeEmbeddedTmuxScript(command);
    expect(decodedTmuxScript).toContain("grep -Eq '^[0-9]+$'");
    expect(decodedTmuxScript).not.toContain('case ');
    expect(decodedTmuxScript).not.toContain(';;');
    expect(decodedTmuxScript).not.toContain('exec tmux');
    expect(decodedTmuxScript).toContain('exit $?');
    expect(command).toContain('then exec "${SHELL:-/bin/sh}" -l; else');
    expect(command).toContain('tmux attach/create failed; falling back to shell.');
    expect(command).toContain('else exec "${SHELL:-/bin/sh}" -l; fi');
  });

  it('SSH tmux 正常退出后回到远端登录 shell,不让 ssh.exe 结束 Marina session', async () => {
    const adapter: PlatformAdapter = {
      ...makeFakeAdapter(),
      resolveExecutable(commandName: string) {
        return commandName === 'ssh' ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : null;
      },
    };
    const { mgr } = makeManager({ adapter });
    const pathId = makePathId({
      kind: 'ssh',
      sshProfileId: 'ssh-1',
      path: '~/repo',
    });

    await mgr.createSession({
      pathId,
      templateId: 'shell',
      ownerWindowId: 'w-1',
      cols: 80,
      rows: 24,
      sshProfile: {
        id: 'ssh-1',
        name: 'prod',
        host: 'example.com',
        port: 22,
        username: 'alice',
        authType: 'agent',
        tmuxMode: 'attach-or-create',
      },
    });

    const command = (FakePty.instances[0]!.args as string[]).at(-1)!;

    expect(command).toContain('if MARINA_TMUX_BASE=');
    expect(command).toContain('base64 -d');
    expect(command).not.toContain('<<');
    expect(command).toContain('then exec "${SHELL:-/bin/sh}" -l; else');
    expect(command).not.toContain('then MARINA_TMUX_BASE=');
  });

  it('SSH tmux 忽略旧版自定义 session 名,始终按目录末级派生', async () => {
    const adapter: PlatformAdapter = {
      ...makeFakeAdapter(),
      resolveExecutable(commandName: string) {
        return commandName === 'ssh' ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : null;
      },
    };
    const { mgr } = makeManager({ adapter });
    const pathId = makePathId({
      kind: 'ssh',
      sshProfileId: 'ssh-1',
      path: '/srv/app',
    });

    await mgr.createSession({
      pathId,
      templateId: 'shell',
      ownerWindowId: 'w-1',
      cols: 80,
      rows: 24,
      sshProfile: {
        id: 'ssh-1',
        name: 'prod',
        host: 'example.com',
        port: 22,
        username: 'alice',
        authType: 'agent',
        tmuxMode: 'attach-or-create',
        tmuxSessionName: 'deploy.api',
      },
    });

    const command = (FakePty.instances[0]!.args as string[]).at(-1)!;
    expect(command).toContain('/srv/app');
    expect(command).toContain('command -v tmux');
    expect(command).toContain('MARINA_TMUX_BASE=');
    expect(command).toContain('marina-app');
    expect(command).not.toContain('deploy.api');
  });

  it('SSH tmux 可配置远端缺 tmux 时直接失败', async () => {
    const adapter: PlatformAdapter = {
      ...makeFakeAdapter(),
      resolveExecutable(commandName: string) {
        return commandName === 'ssh' ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : null;
      },
    };
    const { mgr } = makeManager({ adapter });
    const pathId = makePathId({
      kind: 'ssh',
      sshProfileId: 'ssh-1',
      path: '~',
    });

    await mgr.createSession({
      pathId,
      templateId: 'shell',
      ownerWindowId: 'w-1',
      cols: 80,
      rows: 24,
      sshProfile: {
        id: 'ssh-1',
        name: 'prod',
        host: 'example.com',
        port: 22,
        username: 'alice',
        authType: 'agent',
        tmuxMode: 'attach-or-create',
        tmuxOnMissing: 'fail',
      },
    });

    const command = (FakePty.instances[0]!.args as string[]).at(-1)!;
    expect(command).toContain('Marina: tmux attach/create failed on the remote host.');
    expect(command).toContain('exit 127');
  });

  it('SSH tmux 忽略旧版 new-per-launch 策略,统一走智能选择脚本', async () => {
    const adapter: PlatformAdapter = {
      ...makeFakeAdapter(),
      resolveExecutable(commandName: string) {
        return commandName === 'ssh' ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : null;
      },
    };
    const { mgr } = makeManager({ adapter });
    const pathId = makePathId({
      kind: 'ssh',
      sshProfileId: 'ssh-1',
      path: '~/repo',
    });
    const common = {
      pathId,
      templateId: 'shell',
      ownerWindowId: 'w-1',
      cols: 80,
      rows: 24,
      sshProfile: {
        id: 'ssh-1',
        name: 'prod',
        host: 'example.com',
        port: 22,
        username: 'alice',
        authType: 'agent' as const,
        tmuxMode: 'attach-or-create' as const,
        tmuxSessionName: 'work',
        tmuxSessionPolicy: 'new-per-launch' as const,
      },
    };

    await mgr.createSession(common);

    const command = (FakePty.instances[0]!.args as string[]).at(-1)!;
    expect(command).toContain('MARINA_TMUX_BASE=');
    expect(command).toContain('marina-repo');
    expect(command).toContain('base64 -d');
    expect(command).not.toContain('work-');
  });

  it('SSH tmux 默认 session 名按远程目录末级派生', async () => {
    const adapter: PlatformAdapter = {
      ...makeFakeAdapter(),
      resolveExecutable(commandName: string) {
        return commandName === 'ssh' ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : null;
      },
    };
    const { mgr } = makeManager({ adapter });
    const pathId = makePathId({
      kind: 'ssh',
      sshProfileId: 'ssh-1',
      path: '/home/u1/projects',
    });

    await mgr.createSession({
      pathId,
      templateId: 'shell',
      ownerWindowId: 'w-1',
      cols: 80,
      rows: 24,
      sshProfile: {
        id: 'ssh-1',
        name: 'prod',
        host: 'example.com',
        port: 22,
        username: 'alice',
        authType: 'agent',
        tmuxMode: 'attach-or-create',
      },
    });

    const command = (FakePty.instances[0]!.args as string[]).at(-1)!;
    expect(command).toContain('MARINA_TMUX_BASE=');
    expect(command).toContain('marina-projects');
  });

  it('SSH 本机 ssh.exe 找不到时,错误信息明确指向 ssh 而不是 PowerShell', async () => {
    const adapter: PlatformAdapter = {
      ...makeFakeAdapter(),
      resolveExecutable() {
        return null;
      },
    };
    const { mgr } = makeManager({ adapter });
    const pathId = makePathId({
      kind: 'ssh',
      sshProfileId: 'ssh-1',
      path: '~/repo',
    });

    await expect(
      mgr.createSession({
        pathId,
        templateId: 'shell',
        ownerWindowId: 'w-1',
        cols: 80,
        rows: 24,
        sshProfile: {
          id: 'ssh-1',
          name: 'prod',
          host: 'example.com',
          port: 22,
          username: 'alice',
          authType: 'agent',
        },
      }),
    ).rejects.toThrow(/无法定位本机 ssh\.exe/);
  });

  // ────────────────────────────────────────────────────────────────
  // SSH 方案 v2.1 §阶段 2.3 + §阶段 3.5:ProxyJump + ControlMaster
  // ────────────────────────────────────────────────────────────────

  it('ProxyJump 单跳板 → -J 单值', async () => {
    const adapter: PlatformAdapter = {
      ...makeFakeAdapter(),
      resolveExecutable(commandName: string) {
        return commandName === 'ssh' ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : null;
      },
    };
    const { mgr } = makeManager({ adapter });
    const pathId = makePathId({ kind: 'ssh', sshProfileId: 'p1', path: '~' });
    await mgr.createSession({
      pathId,
      templateId: 'shell',
      ownerWindowId: 'w-1',
      cols: 80,
      rows: 24,
      sshProfile: {
        id: 'p1',
        name: 'inner',
        host: 'inner.example.com',
        port: 22,
        username: 'alice',
        authType: 'agent',
        proxyJump: ['bastion.example.com'],
      },
    });
    const args = FakePty.instances[0]!.args as string[];
    const i = args.indexOf('-J');
    expect(i).toBeGreaterThan(0);
    expect(args[i + 1]).toBe('bastion.example.com');
  });

  it('ProxyJump 多跳板 → -J 逗号拼接,顺序保留,空段过滤', async () => {
    const adapter: PlatformAdapter = {
      ...makeFakeAdapter(),
      resolveExecutable(commandName: string) {
        return commandName === 'ssh' ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : null;
      },
    };
    const { mgr } = makeManager({ adapter });
    const pathId = makePathId({ kind: 'ssh', sshProfileId: 'p1', path: '~' });
    await mgr.createSession({
      pathId,
      templateId: 'shell',
      ownerWindowId: 'w-1',
      cols: 80,
      rows: 24,
      sshProfile: {
        id: 'p1',
        name: 'deep',
        host: 'final.example.com',
        port: 2222,
        username: 'alice',
        authType: 'agent',
        proxyJump: ['user@bastion:22', '  ', 'inner.example.com'],
      },
    });
    const args = FakePty.instances[0]!.args as string[];
    const i = args.indexOf('-J');
    expect(args[i + 1]).toBe('user@bastion:22,inner.example.com');
  });

  it('ControlMaster 启用时 args 含 -o ControlMaster=auto / ControlPath / ControlPersist', async () => {
    const adapter: PlatformAdapter = {
      ...makeFakeAdapter(),
      resolveExecutable(commandName: string) {
        return commandName === 'ssh' ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : null;
      },
      getSshControlPath: () => '~/.ssh/cm-%r@%h:%p',
    };
    const { mgr } = makeManager({
      adapter,
      settings: makeStubSettingsManager({ enableControlMaster: true }),
    });
    const pathId = makePathId({ kind: 'ssh', sshProfileId: 'p1', path: '~' });
    await mgr.createSession({
      pathId,
      templateId: 'shell',
      ownerWindowId: 'w-1',
      cols: 80,
      rows: 24,
      sshProfile: {
        id: 'p1',
        name: 'prod',
        host: 'example.com',
        port: 22,
        username: 'alice',
        authType: 'agent',
      },
    });
    const args = FakePty.instances[0]!.args as string[];
    expect(args).toContain('ControlMaster=auto');
    expect(args).toContain('ControlPath=~/.ssh/cm-%r@%h:%p');
    expect(args).toContain('ControlPersist=10m');
  });

  it('ControlMaster 关闭时 args 不出现 ControlMaster=', async () => {
    const adapter: PlatformAdapter = {
      ...makeFakeAdapter(),
      resolveExecutable(commandName: string) {
        return commandName === 'ssh' ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : null;
      },
    };
    const { mgr } = makeManager({
      adapter,
      settings: makeStubSettingsManager({ enableControlMaster: false }),
    });
    const pathId = makePathId({ kind: 'ssh', sshProfileId: 'p1', path: '~' });
    await mgr.createSession({
      pathId,
      templateId: 'shell',
      ownerWindowId: 'w-1',
      cols: 80,
      rows: 24,
      sshProfile: {
        id: 'p1',
        name: 'prod',
        host: 'example.com',
        port: 22,
        username: 'alice',
        authType: 'agent',
      },
    });
    const args = FakePty.instances[0]!.args as string[];
    expect(args.some((a) => a.startsWith('ControlMaster='))).toBe(false);
    expect(args.some((a) => a.startsWith('ControlPath='))).toBe(false);
  });

  it('ProxyJump 缺失或空数组 → 不出现 -J', async () => {
    const adapter: PlatformAdapter = {
      ...makeFakeAdapter(),
      resolveExecutable(commandName: string) {
        return commandName === 'ssh' ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : null;
      },
    };
    const { mgr } = makeManager({ adapter });
    const pathId = makePathId({ kind: 'ssh', sshProfileId: 'p1', path: '~' });
    await mgr.createSession({
      pathId,
      templateId: 'shell',
      ownerWindowId: 'w-1',
      cols: 80,
      rows: 24,
      sshProfile: {
        id: 'p1',
        name: 'plain',
        host: 'example.com',
        port: 22,
        username: 'alice',
        authType: 'agent',
        proxyJump: [],
      },
    });
    const args = FakePty.instances[0]!.args as string[];
    expect(args).not.toContain('-J');
  });
});

describe('SessionManager — 状态机 (active / idle / exited)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('初始 state=idle (BETA-008:语义反转,active=命令执行中)', async () => {
    const { mgr } = makeManager();
    const info = await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    expect(info.state).toBe('idle');
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

    // CURSOR-1 后:不再有裸字节 managed.scrollback,改听 sessionOutput 事件
    // 来验证"重绘字节仍 emit 出去给 renderer"(emitBatchMs=0 默认,同步 emit)。
    const outputs: string[] = [];
    mgr.on('sessionOutput', (p: { data: string }) => {
      outputs.push(Buffer.from(p.data, 'base64').toString('utf8'));
    });

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

    // 重绘内容仍 emit 给 renderer(state-replay 重挂时 renderer 看到的内容)
    expect(outputs.join('')).toContain('CONPTY-REDRAW-CONTENT');
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

  it('同尺寸 resize 也开 quiet 窗口 (勘误第二轮 #9:TerminalView mount 信号)', async () => {
    // 行为变更原因:Claude Code / 其他 TUI 在终端"重新被显示"时会自发整屏
    // 重绘(切 tab → xterm 重挂 → child 收到刺激 → 重绘 → markActive)。
    // TerminalView mount 后总会调一次 resize 即使 dims 没变,这是"我刚被显示"
    // 信号。原同尺寸 short-circuit 把该信号丢了,导致 idle session 闪绿。
    // 现在:任何 resize 调用(含 no-op)都打开 quiet 窗口。
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

    mgr.resize(info.id, 80, 24); // 与当前尺寸完全一致 (TerminalView mount 信号)
    fp.emitData('reshow burst'); // 同 mount 触发的 ConPTY/TUI 重绘字节
    // quiet 窗口内不 markActive,session 仍是 idle
    expect(mgr.get(info.id)?.state).toBe('idle');

    // quiet 窗口过后真实用户活动 → 正常变 active
    vi.advanceTimersByTime(600);
    fp.emitData('真实用户活动');
    expect(mgr.get(info.id)?.state).toBe('active');
  });

  it('sendInput 后 input quiet 窗口内 PTY 字节不触发 markActive (抖动源 C/E)', async () => {
    // 行为目的:用户敲键 → cooked mode shell echo / raw mode TUI 重绘的字节
    // 不应把 idle dot 点亮 — 用户视角"我在打字,不是程序在跑"。
    const settings = makeStubSettingsManager({ activeIdleThresholdSeconds: 1 });
    const { mgr } = makeManager({ settings, inputQuietMs: 200 });
    const info = await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    const fp = FakePty.instances[0]!;
    // 先让 session 进入 idle
    fp.emitData('hi');
    vi.advanceTimersByTime(1100);
    expect(mgr.get(info.id)?.state).toBe('idle');

    // 模拟用户敲一个键 → 主进程 sendInput → PTY echo 回字节
    const base64 = Buffer.from('a', 'utf8').toString('base64');
    mgr.sendInput(info.id, base64);
    fp.emitData('a'); // echo
    // input quiet 窗口内不 markActive,session 仍是 idle
    expect(mgr.get(info.id)?.state).toBe('idle');

    // 连续敲键(每次都顺延窗口) → 整段打字过程仍是 idle
    vi.advanceTimersByTime(100);
    mgr.sendInput(info.id, Buffer.from('b', 'utf8').toString('base64'));
    fp.emitData('b');
    vi.advanceTimersByTime(100);
    mgr.sendInput(info.id, Buffer.from('c', 'utf8').toString('base64'));
    fp.emitData('c');
    expect(mgr.get(info.id)?.state).toBe('idle');
  });

  it('sendInput 后超过 input quiet 窗口,真实命令输出正常触发 markActive', async () => {
    const settings = makeStubSettingsManager({ activeIdleThresholdSeconds: 1 });
    const { mgr } = makeManager({ settings, inputQuietMs: 200 });
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

    // 用户按 Enter
    mgr.sendInput(info.id, Buffer.from('\r', 'utf8').toString('base64'));
    // 推进超过 input quiet 窗口
    vi.advanceTimersByTime(250);
    // 命令真的开始输出 (≥ 200ms 后) → markActive 正常触发
    fp.emitData('command output...');
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

describe('SessionManager — OSC 0/1/2 标题 (displayName 自动跟随)', () => {
  it('收到 OSC 0 → displayName 更新 + state change 广播', async () => {
    const { mgr } = makeManager();
    const stateChanges: { displayName?: string }[] = [];
    mgr.on('sessionStateChanged', (e: { changes: { displayName?: string } }) =>
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
    fp.emitData('\x1b]0;✻ Claude · ~/p (working…)\x07');

    const after = mgr.get(info.id)!;
    expect(after.displayName).toBe('✻ Claude · ~/p (working…)');
    expect(stateChanges.find((c) => c.displayName !== undefined)).toEqual({
      displayName: '✻ Claude · ~/p (working…)',
    });
  });

  it('OSC 0 标题不进 passthrough(不会在终端里显示乱码)', async () => {
    const { mgr } = makeManager();
    let receivedOutput = '';
    mgr.on('sessionOutput', (e: { data: string }) => {
      receivedOutput += Buffer.from(e.data, 'base64').toString('utf8');
    });
    await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    const fp = FakePty.instances[0]!;
    fp.emitData('A\x1b]0;hello\x07B');
    expect(receivedOutput).toBe('AB');
  });

  it('manuallyRenamed 后 OSC 标题不再覆盖 displayName', async () => {
    const { mgr } = makeManager();
    const info = await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    mgr.renameSession(info.id, 'My Pinned Name');
    expect(mgr.get(info.id)!.displayName).toBe('My Pinned Name');

    const fp = FakePty.instances[0]!;
    fp.emitData('\x1b]0;Should Be Ignored\x07');
    expect(mgr.get(info.id)!.displayName).toBe('My Pinned Name');
  });

  it('OSC 标题里 \\n / \\t 被替成空格,过长截到 100', async () => {
    const { mgr } = makeManager();
    const info = await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    const fp = FakePty.instances[0]!;
    fp.emitData('\x1b]0;a\nb\tc\x07');
    expect(mgr.get(info.id)!.displayName).toBe('a b c');

    const long = 'X'.repeat(200);
    fp.emitData(`\x1b]0;${long}\x07`);
    expect(mgr.get(info.id)!.displayName).toBe('X'.repeat(100));
  });

  it('空标题(全空白)被忽略,保留旧 displayName', async () => {
    const { mgr } = makeManager();
    const info = await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    const original = info.displayName;
    const fp = FakePty.instances[0]!;
    fp.emitData('\x1b]0;   \x07');
    expect(mgr.get(info.id)!.displayName).toBe(original);
  });

  it('相同 title 不重复广播 stateChanged', async () => {
    const { mgr } = makeManager();
    const info = await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    const fp = FakePty.instances[0]!;
    fp.emitData('\x1b]0;Same\x07');
    const changesAfterFirst: { displayName?: string }[] = [];
    mgr.on('sessionStateChanged', (e: { changes: { displayName?: string } }) =>
      changesAfterFirst.push(e.changes),
    );
    fp.emitData('\x1b]0;Same\x07');
    expect(changesAfterFirst.filter((c) => c.displayName !== undefined)).toEqual([]);
    expect(mgr.get(info.id)!.displayName).toBe('Same');
  });

  // TIT-1:powershell.exe / cmd.exe / Git Bash 启动时把窗口标题设成自己的 exe
  // 路径(ConPTY 把 SetConsoleTitle() 翻译成 OSC 0),Git Bash 默认 PS1 又每次
  // prompt 重发 "MINGW64:<cwd>"。这些"裸路径"标题不应该覆盖 Marina 的友好名。
  it('TIT-1 启动垃圾:整段是 Windows exe 路径 → 拒,保留 "PowerShell"', async () => {
    const { mgr } = makeManager();
    const info = await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    const before = info.displayName;
    const fp = FakePty.instances[0]!;
    fp.emitData('\x1b]0;C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\x07');
    expect(mgr.get(info.id)!.displayName).toBe(before);

    fp.emitData('\x1b]0;C:\\Windows\\System32\\cmd.exe\x07');
    expect(mgr.get(info.id)!.displayName).toBe(before);
  });

  it('TIT-1 启动垃圾:Git Bash 默认 PS1 "MINGW64:<path>" → 拒', async () => {
    const { mgr } = makeManager();
    const info = await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    const before = info.displayName;
    const fp = FakePty.instances[0]!;
    fp.emitData('\x1b]0;MINGW64:/c/Users/HP/Desktop/work/SimHDL\x07');
    expect(mgr.get(info.id)!.displayName).toBe(before);

    fp.emitData('\x1b]0;MINGW32:/c/foo\x07');
    expect(mgr.get(info.id)!.displayName).toBe(before);

    fp.emitData('\x1b]0;MSYS:/usr/local\x07');
    expect(mgr.get(info.id)!.displayName).toBe(before);
  });

  it('TIT-1 启动垃圾:裸 "/usr/bin/bash" / "cmd.exe" → 拒', async () => {
    const { mgr } = makeManager();
    const info = await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    const before = info.displayName;
    const fp = FakePty.instances[0]!;
    fp.emitData('\x1b]0;/usr/bin/bash\x07');
    expect(mgr.get(info.id)!.displayName).toBe(before);

    fp.emitData('\x1b]0;cmd.exe\x07');
    expect(mgr.get(info.id)!.displayName).toBe(before);

    fp.emitData('\x1b]0;pwsh.exe\x07');
    expect(mgr.get(info.id)!.displayName).toBe(before);
  });

  it('TIT-1 合法标题:CLI 工具发的 "vim /etc/hosts" → 放行', async () => {
    const { mgr } = makeManager();
    const info = await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    const fp = FakePty.instances[0]!;
    fp.emitData('\x1b]0;vim /etc/hosts\x07');
    expect(mgr.get(info.id)!.displayName).toBe('vim /etc/hosts');

    // Claude Code 自定义标题(含路径但有描述前缀)— 必须放行
    fp.emitData('\x1b]0;✻ Claude · ~/p (working…)\x07');
    expect(mgr.get(info.id)!.displayName).toBe(
      '✻ Claude · ~/p (working…)',
    );

    // 其他常见合法标题
    fp.emitData('\x1b]0;node app.js\x07');
    expect(mgr.get(info.id)!.displayName).toBe('node app.js');

    fp.emitData('\x1b]0;make -j4\x07');
    expect(mgr.get(info.id)!.displayName).toBe('make -j4');
  });
});

describe('looksLikeShellStartupGarbage (TIT-1)', () => {
  // 拒绝面:这些是 powershell.exe / cmd.exe / Git Bash 启动期自动发的标题,
  // 全部覆盖 displayName 会把 Marina 的 "PowerShell" / "Bash" 友好名搞没。
  it.each([
    'C:\\Windows\\System32\\cmd.exe',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'C:/Program Files/PowerShell/7/pwsh.exe',
    'D:\\tools\\bash.exe',
    '\\\\server\\share\\bin\\sh.exe',
    '/usr/bin/bash',
    '/bin/zsh',
    'MINGW64:/c/Users/HP/Desktop/work',
    'MINGW32:/c/foo',
    'MINGWARM:/c/foo',
    'MSYS:/usr/local',
    'MSYS2:/c/code',
    'mingw64:/c/lower-case-also',
    'cmd.exe',
    'powershell.exe',
    'pwsh.exe',
    'Bash.EXE',
  ])('%s → 启动垃圾', (title) => {
    expect(looksLikeShellStartupGarbage(title)).toBe(true);
  });

  // 放行面:CLI 工具改标题是核心功能,不能误杀。规律:**路径只是标题的
  // 一部分,前后有别的内容**(命令名 / 描述 / Unicode 装饰)。
  it.each([
    'vim /etc/hosts',
    'nano C:\\Users\\me\\notes.txt',
    'node app.js',
    'make -j4',
    'npm install',
    '✻ Claude · ~/p (working…)', // ✻ Claude · ~/p (working…)
    'cargo build',
    'python script.py',
    'PowerShell',
    'Bash',
    'editing notes.md',
    'connecting to db...',
    'tail -f /var/log/app.log',
    '$ git status',
  ])('%s → 合法标题', (title) => {
    expect(looksLikeShellStartupGarbage(title)).toBe(false);
  });

  // 边界:空串、纯空格(由 sanitizeTitle 处理掉,但 helper 自身也得稳)
  it('空串不算启动垃圾(由 sanitizeTitle 上层短路)', () => {
    expect(looksLikeShellStartupGarbage('')).toBe(false);
  });
});

// CURSOR-1 后:scrollback 存储从 2MB 裸字节 ring 改为 @xterm/headless 状态机。
// 旧的"SCROLLBACK_LIMIT 裁切"+"OSC-2 \n 边界对齐"两个 case 已不适用(裁切机制
// 不存在,headless 自己按行管 scrollback)— 删除。保留可见性的 case:输出是否
// 进入状态源、OSC 1337 是否被剥离不污染状态源、state-replay 输出能否被 renderer
// 重建。
describe('SessionManager — state-replay (headless + serialize)', () => {
  it('PTY 输出进入 headless,exportScrollback 能取回', async () => {
    const { mgr } = makeManager();
    const info = await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    const fp = FakePty.instances[0]!;
    fp.emitData('line1\r\nline2\r\n');
    const text = (await mgr.exportScrollback(info.id)).text;
    expect(text).toContain('line1');
    expect(text).toContain('line2');
  });

  it('OSC 1337 sequence 被剥离,不污染 headless 状态源', async () => {
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
    const text = (await mgr.exportScrollback(info.id)).text;
    // headless 看到的是 'AB',OSC 1337 既不在文本里也不在 ANSI 转义里
    expect(text).toContain('AB');
    expect(text).not.toContain('1337');
    expect(text).not.toContain('CurrentDir');
  });

  it('getScrollbackForReplay 返回的 ANSI 流能被 renderer 重写还原状态', async () => {
    const { mgr } = makeManager();
    const info = await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    const fp = FakePty.instances[0]!;
    // 进 alt-buffer + 隐光标 + 写一行 — 模拟 Claude Code / Codex 行为。
    // 旧架构这种短数据也工作,新架构同样要工作 — 这是 baseline。
    fp.emitData('\x1b[?1049h\x1b[?25l\x1b[Halt-content\r\n');
    const res = await mgr.getScrollbackForReplay(info.id);
    expect(res.lastSeq).toBeGreaterThanOrEqual(0);
    const ansi = Buffer.from(res.data, 'base64').toString('utf8');
    // 关键不变量:状态前缀里必须有 ?1049h(进 alt) + ?25l(隐光标);
    // 内容里有 'alt-content'。
    expect(ansi).toContain('\x1b[?1049h');
    expect(ansi).toContain('\x1b[?25l');
    expect(ansi).toContain('alt-content');
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

  // TYP-1 / IPC-4:sendInput 现在返回 { accepted, reason }
  it('sendInput 在 exited session 上返回 accepted=false reason=pty-exited (TYP-1)', async () => {
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
    const res = mgr.sendInput(
      info.id,
      Buffer.from('x', 'utf8').toString('base64'),
    );
    expect(res.accepted).toBe(false);
    expect(res.reason).toBe('pty-exited');
  });

  it('sendInput 在不存在 session 上返回 accepted=false reason=session-not-found', () => {
    const { mgr } = makeManager();
    const res = mgr.sendInput(
      'no-such-id',
      Buffer.from('x', 'utf8').toString('base64'),
    );
    expect(res.accepted).toBe(false);
    expect(res.reason).toBe('session-not-found');
  });

  it('sendInput 正常路径返回 accepted=true', async () => {
    const { mgr } = makeManager();
    const info = await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    const res = mgr.sendInput(
      info.id,
      Buffer.from('x', 'utf8').toString('base64'),
    );
    expect(res.accepted).toBe(true);
    expect(res.reason).toBeUndefined();
  });

  // PER-2 / F1:IPC chunk 聚合
  it('emitBatchMs > 0 时多次 chunk 在窗口内合并成一条 sessionOutput', async () => {
    vi.useFakeTimers();
    try {
      const { mgr } = makeManager({ emitBatchMs: 8 });
      await mgr.createSession({
        pathId: '/p',
        templateId: 'shell',
        ownerWindowId: 'w',
        cols: 80,
        rows: 24,
      });
      const fp = FakePty.instances[0]!;
      const outputs: Array<{ data: string; seq: number }> = [];
      mgr.on('sessionOutput', (p: { data: string; seq: number }) => {
        outputs.push({ data: p.data, seq: p.seq });
      });
      fp.emitData('aaa');
      fp.emitData('bbb');
      fp.emitData('ccc');
      // 同步内未 flush
      expect(outputs.length).toBe(0);
      // 8ms 后 flush 一次
      vi.advanceTimersByTime(10);
      expect(outputs.length).toBe(1);
      // base64 解码后是 'aaabbbccc'
      expect(Buffer.from(outputs[0]!.data, 'base64').toString('utf8')).toBe(
        'aaabbbccc',
      );
      // seq 是最后一条 chunk 对应的(3 个 chunk → outputSeq 0,1,2)
      expect(outputs[0]!.seq).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('emitBatchMs=0(默认测试)时每个 chunk 立即 emit', async () => {
    const { mgr } = makeManager(); // emitBatchMs=0
    await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    const fp = FakePty.instances[0]!;
    const outputs: Array<{ data: string; seq: number }> = [];
    mgr.on('sessionOutput', (p: { data: string; seq: number }) => {
      outputs.push({ data: p.data, seq: p.seq });
    });
    fp.emitData('a');
    fp.emitData('b');
    expect(outputs.length).toBe(2);
    expect(outputs[0]!.seq).toBe(0);
    expect(outputs[1]!.seq).toBe(1);
  });

  // TYP-2:pty.write 同步抛错返回 pty-write-failed
  it('sendInput 在 pty.write 抛错时返回 accepted=false reason=pty-write-failed', async () => {
    const { mgr } = makeManager();
    const info = await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    const fp = FakePty.instances[0]!;
    fp.writeShouldThrow = true;
    const res = mgr.sendInput(
      info.id,
      Buffer.from('x', 'utf8').toString('base64'),
    );
    expect(res.accepted).toBe(false);
    expect(res.reason).toBe('pty-write-failed');
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

describe('SessionManager — PER-2 emit 聚合 / state-replay 不变量', () => {
  // 这一组测试锁住 emit 聚合与 state-replay 之间的不变量,防止 renderer 双写。
  //
  // 旧架构(CURSOR-1 之前):getScrollback 返回 managed.scrollback 裸字节 ring。
  //   PER-2 v1 race:handlePtyData 立刻 appendScrollback 但延迟 emit → snap.data
  //   含未 emit 的字节 + lastSeq 旧 → 后续合并 emit 整段写入 renderer → 双写。
  //   PER-2 v2 修复:scrollback append 与 emit 同步在 flushPendingEmit 内原子前进。
  //
  // 新架构(CURSOR-1):裸字节 ring 删除,getScrollbackForReplay 通过
  //   flushPendingEmit + await drain headless + serialize 实现"原子快照"。
  //   不变量变成:getScrollbackForReplay **强制 flush** pendingEmit,返回时:
  //     - 所有原 pendingEmit 字节已通过 sessionOutput 事件发出
  //     - lastSeq 反映该 flush 后的最后 seq
  //     - serialize 输出反映已 drain 的 headless 状态(含所有 emit 出去的字节)
  //   renderer 用 seq > lastSeq 过滤 live channel pending,排除 serialize 已含
  //   的字节,不双写。

  it('getScrollbackForReplay 强制 flush pendingEmit,lastSeq 与 emit 序列一致', async () => {
    // 不用 fake timers — getScrollbackForReplay 内部要 await xterm parser drain,
    // 而 xterm 内部调度走 setImmediate/微任务,fake timers 会卡死 drain 永不
    // 返回。本测试本来就要走 emitBatchMs=8 的真实路径,8ms 是可接受成本。
    const { mgr } = makeManager({ emitBatchMs: 8 });
    const info = await mgr.createSession({
      pathId: '/p',
      templateId: 'shell',
      ownerWindowId: 'w',
      cols: 80,
      rows: 24,
    });
    const fp = FakePty.instances[0]!;
    const outputs: Array<{ data: string; seq: number }> = [];
    mgr.on('sessionOutput', (p: { data: string; seq: number }) => {
      outputs.push(p);
    });

    // chunk1 入 pendingEmit,8ms timer 未到 → 还未 emit
    fp.emitData('AAAA');
    expect(outputs).toHaveLength(0);

    // CURSOR-1 新语义:getScrollbackForReplay 内部 flushPendingEmit + drain + serialize。
    // 返回时 chunk1 已通过 sessionOutput 发出,lastSeq 反映该 chunk 的 seq。
    const res = await mgr.getScrollbackForReplay(info.id);
    expect(outputs).toHaveLength(1);
    expect(Buffer.from(outputs[0]!.data, 'base64').toString('utf8')).toBe(
      'AAAA',
    );
    expect(outputs[0]!.seq).toBe(res.lastSeq);

    // serialize 输出反映 headless 已经接受了 AAAA(headless 已 drain)
    const ansi = Buffer.from(res.data, 'base64').toString('utf8');
    expect(ansi).toContain('AAAA');
  });

  it('destroySession 内 flush 路径:窗口内最后一段字节不丢', async () => {
    vi.useFakeTimers();
    try {
      const { mgr } = makeManager({ emitBatchMs: 8 });
      const info = await mgr.createSession({
        pathId: '/p',
        templateId: 'shell',
        ownerWindowId: 'w',
        cols: 80,
        rows: 24,
      });
      const fp = FakePty.instances[0]!;
      const outputs: Array<{ data: string; seq: number }> = [];
      mgr.on('sessionOutput', (p: { data: string; seq: number }) => {
        outputs.push(p);
      });

      // chunk 进 pendingEmit;timer 还没到
      fp.emitData('LAST');
      expect(outputs).toHaveLength(0);

      // 立刻 close → destroySession 内必须 flush 最后一段
      mgr.closeSession(info.id);
      expect(outputs).toHaveLength(1);
      expect(Buffer.from(outputs[0]!.data, 'base64').toString('utf8')).toBe('LAST');
    } finally {
      vi.useRealTimers();
    }
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

  it('OSC 0 → title 事件 + 从 passthrough 剥离', () => {
    const p = new Osc1337Parser();
    const r = p.parse(Buffer.from('\x1b]0;hello\x07'));
    expect(r.passthrough.length).toBe(0);
    expect(r.events).toEqual([{ kind: 'title', value: 'hello' }]);
  });

  it('OSC 2 (window title only) 等价 OSC 0', () => {
    const p = new Osc1337Parser();
    const r = p.parse(Buffer.from('\x1b]2;just window title\x07'));
    expect(r.passthrough.length).toBe(0);
    expect(r.events).toEqual([{ kind: 'title', value: 'just window title' }]);
  });

  it('OSC 1 (icon name only) 也按 title 处理', () => {
    const p = new Osc1337Parser();
    const r = p.parse(Buffer.from('\x1b]1;icon\x07'));
    expect(r.passthrough.length).toBe(0);
    expect(r.events).toEqual([{ kind: 'title', value: 'icon' }]);
  });

  it('OSC 10 (前景色) 不被误判为 title — 仍然透传', () => {
    // OSC 10 / 11 / 12 是颜色查询/设置,以 1/2 开头但第二字节是数字而非 ';'。
    // 我们严格要求第二字节 ';',防止误吞色彩协议。
    const p = new Osc1337Parser();
    const seq = Buffer.from('\x1b]10;?\x07');
    const r = p.parse(seq);
    expect(r.passthrough).toEqual(seq);
    expect(r.events).toEqual([]);
  });

  it('OSC 8 (超链接) 不被识别为 title — 仍然透传', () => {
    const p = new Osc1337Parser();
    const seq = Buffer.from('\x1b]8;;https://example.com\x07link\x1b]8;;\x07');
    const r = p.parse(seq);
    expect(r.passthrough).toEqual(seq);
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

  it('超长 stash (> 16KB 没终止符) → 整段透传不丢内容', () => {
    const p = new Osc1337Parser();
    const giant = '\x1b]1337;' + 'x'.repeat(20_000); // 没有终止符
    const r = p.parse(Buffer.from(giant));
    // overflow 后 stash 清零(整段被 flush 到 passthrough)
    expect(p.stashedBytes).toBe(0);
    // OSC-3 回归修复(2026-05-14):overflow 整段透传,不静默丢。
    // 原 OSC-3"静默 drop 避免乱码"的方向是错的 — 配合 OSC-4 误识别
    // 0x9D 会让正常 UTF-8 内容被吃。宁可渲染字面 ANSI 乱码也别让用户
    // 内容凭空消失(乱码用户能复现 + 报告;丢字节不留痕迹更难排查)。
    expect(r.passthrough.length).toBeGreaterThanOrEqual(20_000);
    const r2 = p.parse(Buffer.from('more'));
    expect(r2.passthrough.toString('utf8')).toContain('more');
  });

  // OSC-4 回归修复(2026-05-14):0x9D 不再被识别为 C1 OSC 起始,作为
  // 普通字节透传给 xterm。详见 osc1337-parser.ts 的 OSC-4 回归注释。
  it('0x9D 作为普通字节透传,不识别为 C1 OSC 起始', () => {
    const p = new Osc1337Parser();
    // 0x9D + "1337;CurrentDir=/test" + BEL — 若被当 OSC 处理会产生 cwd 事件
    const buf = Buffer.concat([
      Buffer.from([0x9d]),
      Buffer.from('1337;CurrentDir=/test'),
      Buffer.from([0x07]),
    ]);
    const r = p.parse(buf);
    // 不应产生任何 OSC 事件
    expect(r.events).toHaveLength(0);
    // 0x9D 与后续字节(BEL 除外)整段透传 — BEL 0x07 是普通终端 bell,
    // 也走 passthrough。所以 passthrough 应当含 0x9D + 后面所有字节。
    expect(r.passthrough.length).toBe(buf.length);
    expect(r.passthrough[0]).toBe(0x9d);
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
