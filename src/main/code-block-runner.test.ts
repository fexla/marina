/**
 * @file code-block-runner.test.ts
 * @purpose 守护 CodeBlockRunner 的执行模型契约:
 *   - 不经 PTY,直接 spawn(用 fake spawn 守护 argv)。
 *   - cwd 来自服务端 session.currentCwd(renderer 不被信任)。
 *   - SSH session 拒绝;session 不存在拒绝;code 过大拒绝。
 *   - stdout/stderr 聚合切块 + exited 事件;stop / removeSession / removeClient 杀进程。
 *
 *   不起真系统进程(AGENTS.md 9.3),用 fake ChildProcess + EventEmitter。
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  CodeBlockRunner,
  CodeBlockError,
  buildSpawnArgs,
  DetectingOutputDecoder,
  PS_UTF8_PREFIX,
  type SpawnFn,
  type CodeBlockOutputEvent,
  type CodeBlockExitedEvent,
} from './code-block-runner';
import type { SessionInfo, ShellInfo } from '@shared/types';

/** 造一个 fake ChildProcess:满足 pipeOutput 用到的 on('data'/'close'/'error')。 */
function makeFakeChild(): {
  child: any;
  stdout: EventEmitter;
  stderr: EventEmitter;
  killed: { signal: string | null };
  emitClose: (exitCode: number | null, signal: string | null) => void;
  emitError: (err: Error) => void;
} {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  // ChildProcess 的 stdout/stderr 是 Readable,这里只需 EventEmitter 的 on('data')。
  const killed: { signal: string | null } = { signal: null };
  const child = {
    pid: 12345,
    stdout,
    stderr,
    kill(signal: string) {
      killed.signal = signal;
      return true;
    },
    on(event: string, cb: (...a: unknown[]) => void) {
      // close / error 走 child 自身;测试用 emitClose / emitError 触发。
      (child as any)._bus = (child as any)._bus ?? new EventEmitter();
      (child as any)._bus.on(event, cb);
    },
  };
  const emitClose = (exitCode: number | null, signal: string | null): void =>
    (child as any)._bus.emit('close', exitCode, signal);
  const emitError = (err: Error): void => (child as any)._bus.emit('error', err);
  return { child, stdout, stderr, killed, emitClose, emitError };
}

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 's1',
    pathId: 'C:\\proj',
    templateId: 'shell',
    originalCwd: 'C:\\proj',
    currentCwd: 'C:\\proj',
    cols: 80,
    rows: 24,
    pid: 1,
    displayName: 'Shell',
    ownerWindowId: 'w1',
    state: 'active',
    ...overrides,
  };
}

/** 模拟 detectShells 结果(绝对路径,与 WindowsAdapter 同构)。 */
const FAKE_SHELLS: ShellInfo[] = [
  {
    id: 'pwsh',
    displayName: 'PowerShell 7',
    executablePath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  },
  {
    id: 'powershell',
    displayName: 'Windows PowerShell',
    executablePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  },
  { id: 'cmd', displayName: 'Command Prompt', executablePath: 'C:\\Windows\\System32\\cmd.exe' },
  {
    id: 'git-bash',
    displayName: 'Git Bash',
    executablePath: 'C:\\Program Files\\Git\\bin\\bash.exe',
  },
];

describe('buildSpawnArgs', () => {
  it('bash 走 -c(非登录非交互,避免登录 profile 副作用)', () => {
    expect(buildSpawnArgs('bash', 'npm test', true)).toEqual({
      command: 'bash',
      args: ['-c', 'npm test'],
    });
    expect(buildSpawnArgs('sh', 'ls', false)).toEqual({
      command: 'sh',
      args: ['-c', 'ls'],
    });
  });

  it('有 detectShells 结果时用绝对路径(解决 PATH 里没有 pwsh/bash 的 ENOENT)', () => {
    expect(buildSpawnArgs('bash', 'echo hi', true, FAKE_SHELLS)).toEqual({
      command: 'C:\\Program Files\\Git\\bin\\bash.exe',
      args: ['-c', 'echo hi'],
    });
    expect(buildSpawnArgs('pwsh', 'gci', true, FAKE_SHELLS)).toEqual({
      command: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      args: ['-NoProfile', '-Command', `${PS_UTF8_PREFIX}gci`],
    });
    expect(buildSpawnArgs('powershell', 'gci', true, FAKE_SHELLS)).toEqual({
      command: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      args: ['-NoProfile', '-Command', `${PS_UTF8_PREFIX}gci`],
    });
    expect(buildSpawnArgs('cmd', 'dir', true, FAKE_SHELLS)).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'dir'],
    });
  });

  it('pwsh 未装时回退到 powershell 5.1(Windows 上 powershell.exe 必装)', () => {
    const shellsNoPwsh = FAKE_SHELLS.filter((s) => s.id !== 'pwsh');
    expect(buildSpawnArgs('pwsh', 'gci', true, shellsNoPwsh)).toEqual({
      command: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      args: ['-NoProfile', '-Command', `${PS_UTF8_PREFIX}gci`],
    });
  });

  it('powershell / pwsh 强制 UTF-8 输出前缀(无 shells 时走 PATH 名)', () => {
    expect(buildSpawnArgs('powershell', 'gci', true)).toEqual({
      command: 'powershell.exe',
      args: ['-NoProfile', '-Command', `${PS_UTF8_PREFIX}gci`],
    });
    expect(buildSpawnArgs('pwsh', 'gci', false)).toEqual({
      command: 'pwsh',
      args: ['-NoProfile', '-Command', `${PS_UTF8_PREFIX}gci`],
    });
  });

  it('cmd 无 chcp(chcp 对管道输出无效,编码交给 DetectingOutputDecoder)', () => {
    expect(buildSpawnArgs('cmd', 'dir', true)).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'dir'],
    });
  });
});

describe('CodeBlockRunner', () => {
  it('直接 spawn 对应 shell,cwd 取自 session.currentCwd', async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn<SpawnFn>(() => fake.child);
    let captured: any;
    const runner = new CodeBlockRunner(
      (id) => (id === 's1' ? makeSession({ currentCwd: 'D:\\repo' }) : null),
      spawnFn,
    );
    runner.on('output', (e: CodeBlockOutputEvent) => (captured = e));

    const { runId } = await runner.run({
      sourceSessionId: 's1',
      language: 'bash',
      code: 'echo hi',
      requestingClientId: 'w1',
    });

    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(spawnFn.mock.calls[0]![0]).toBe('bash');
    expect(spawnFn.mock.calls[0]![1]).toEqual(['-c', 'echo hi']);
    expect(spawnFn.mock.calls[0]![2].cwd).toBe('D:\\repo');

    // stdout 推一条 → 收到 output 事件(runId/clientId/stream 正确)
    fake.stdout.emit('data', Buffer.from('hi\n', 'utf8'));
    fake.emitClose(0, null);
    await Promise.resolve();
    expect(captured).toMatchObject({ runId, clientId: 'w1', stream: 'stdout', data: 'hi\n' });
  });

  it('getShells 注入时用绝对路径 spawn(修复 PATH 缺失 pwsh/bash 的 ENOENT)', async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn<SpawnFn>(() => fake.child);
    const runner = new CodeBlockRunner(
      (_id) => makeSession(),
      spawnFn,
      async () => FAKE_SHELLS,
    );

    await runner.run({
      sourceSessionId: 's1',
      language: 'pwsh',
      code: 'gci',
      requestingClientId: 'w1',
    });
    expect(spawnFn.mock.calls[0]![0]).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe');

    await runner.run({
      sourceSessionId: 's1',
      language: 'bash',
      code: 'echo hi',
      requestingClientId: 'w1',
    });
    expect(spawnFn.mock.calls[1]![0]).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
  });

  it('getShells 抛错时回退 PATH 名,不阻塞执行', async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn<SpawnFn>(() => fake.child);
    const runner = new CodeBlockRunner(
      (_id) => makeSession(),
      spawnFn,
      async () => {
        throw new Error('detectShells boom');
      },
    );
    await runner.run({
      sourceSessionId: 's1',
      language: 'cmd',
      code: 'dir',
      requestingClientId: 'w1',
    });
    expect(spawnFn.mock.calls[0]![0]).toBe('cmd.exe');
  });

  it('session 不存在 → SessionMissing', async () => {
    const runner = new CodeBlockRunner(
      () => null,
      () => makeFakeChild().child,
    );
    await expect(
      runner.run({ sourceSessionId: 'x', language: 'bash', code: 'ls', requestingClientId: 'w1' }),
    ).rejects.toThrow(CodeBlockError);
    await expect(
      runner.run({ sourceSessionId: 'x', language: 'bash', code: 'ls', requestingClientId: 'w1' }),
    ).rejects.toThrow(/不存在或已销毁/);
  });

  it('SSH session 拒绝(命令需在远程主机跑,本进程无法 spawn)', async () => {
    const runner = new CodeBlockRunner(
      (_id) => makeSession({ pathId: 'ssh:profile1:%2Fhome%2Fuser' }) as any,
      () => makeFakeChild().child,
    );
    await expect(
      runner.run({ sourceSessionId: 's1', language: 'bash', code: 'ls', requestingClientId: 'w1' }),
    ).rejects.toThrow(/SSH/);
  });

  it('code 超过上限 → CodeTooLarge', async () => {
    const runner = new CodeBlockRunner(
      (_id) => makeSession(),
      () => makeFakeChild().child,
    );
    const huge = 'x'.repeat(256 * 1024 + 1);
    await expect(
      runner.run({
        sourceSessionId: 's1',
        language: 'bash',
        code: huge,
        requestingClientId: 'w1',
      }),
    ).rejects.toThrow(/超过.*上限/);
  });

  it('spawn 同步抛 ENOENT → ShellMissing', async () => {
    const runner = new CodeBlockRunner(
      (_id) => makeSession(),
      () => {
        throw Object.assign(new Error('spawn bash ENOENT'), { code: 'ENOENT' });
      },
    );
    await expect(
      runner.run({ sourceSessionId: 's1', language: 'bash', code: 'ls', requestingClientId: 'w1' }),
    ).rejects.toThrow(/启动 bash 失败/);
  });

  it('spawn 后异步 ENOENT(error 事件)→ 输出友好提示', async () => {
    const fake = makeFakeChild();
    const runner = new CodeBlockRunner(
      (_id) => makeSession(),
      () => fake.child,
    );
    let outputs: CodeBlockOutputEvent[] = [];
    runner.on('output', (e) => outputs.push(e));

    await runner.run({
      sourceSessionId: 's1',
      language: 'bash',
      code: 'ls',
      requestingClientId: 'w1',
    });
    outputs = [];
    fake.emitError(Object.assign(new Error('spawn bash ENOENT'), { code: 'ENOENT' }));
    expect(outputs[0]!.stream).toBe('stderr');
    expect(outputs[0]!.data).toMatch(/找不到可执行命令/);
  });

  it('exited 事件带 exitCode/signal,退出后从 run map 清除', async () => {
    const fake = makeFakeChild();
    const runner = new CodeBlockRunner(
      (_id) => makeSession(),
      () => fake.child,
    );
    let exited: CodeBlockExitedEvent | undefined;
    runner.on('exited', (e) => (exited = e));

    const { runId } = await runner.run({
      sourceSessionId: 's1',
      language: 'powershell',
      code: 'throw',
      requestingClientId: 'w1',
    });
    expect(runner.size()).toBe(1);
    fake.emitClose(1, null);
    await Promise.resolve();
    expect(exited).toMatchObject({ runId, exitCode: 1, signal: null });
    expect(runner.size()).toBe(0);
  });

  it('stop 调 child.kill(SIGKILL),幂等', async () => {
    const fake = makeFakeChild();
    const runner = new CodeBlockRunner(
      (_id) => makeSession(),
      () => fake.child,
    );
    const { runId } = await runner.run({
      sourceSessionId: 's1',
      language: 'cmd',
      code: 'dir',
      requestingClientId: 'w1',
    });
    runner.stop(runId);
    expect(fake.killed.signal).toBe('SIGKILL');
    // 未知 runId 不抛
    expect(() => runner.stop('nope')).not.toThrow();
  });

  it('removeClient 杀掉该 client 启动的全部运行,且不发 exited', async () => {
    const fakeA = makeFakeChild();
    const fakeB = makeFakeChild();
    const seq = [fakeA, fakeB];
    const runner = new CodeBlockRunner(
      (_id) => makeSession(),
      () => seq.shift()!.child,
    );
    let exitedCount = 0;
    runner.on('exited', () => exitedCount++);

    await runner.run({
      sourceSessionId: 's1',
      language: 'bash',
      code: 'a',
      requestingClientId: 'w1',
    });
    await runner.run({
      sourceSessionId: 's1',
      language: 'bash',
      code: 'b',
      requestingClientId: 'w2',
    });
    expect(runner.size()).toBe(2);

    runner.removeClient('w1');
    expect(fakeA.killed.signal).toBe('SIGKILL');
    expect(fakeB.killed.signal).toBeNull(); // w2 的运行不受影响
    expect(runner.size()).toBe(1);
    expect(exitedCount).toBe(0); // 客户端没了,不发 exited
  });

  it('removeSession 只停止源 session 的运行,close 后仍向存活 client 发 exited', async () => {
    const fakeA = makeFakeChild();
    const fakeB = makeFakeChild();
    const seq = [fakeA, fakeB];
    const runner = new CodeBlockRunner(
      (id) => makeSession({ id }),
      () => seq.shift()!.child,
    );
    let exitedCount = 0;
    runner.on('exited', () => exitedCount++);

    await runner.run({
      sourceSessionId: 's1',
      language: 'bash',
      code: 'a',
      requestingClientId: 'w1',
    });
    await runner.run({
      sourceSessionId: 's2',
      language: 'bash',
      code: 'b',
      requestingClientId: 'w1',
    });

    runner.removeSession('s1');
    expect(fakeA.killed.signal).toBe('SIGKILL');
    expect(fakeB.killed.signal).toBeNull();
    // stop 只发 kill；保留记录直到 child close,让 renderer 收到 exited。
    expect(runner.size()).toBe(2);
    fakeA.emitClose(null, 'SIGKILL');
    await Promise.resolve();
    expect(runner.size()).toBe(1);
    expect(exitedCount).toBe(1);
  });
});

describe('DetectingOutputDecoder', () => {
  it('GBK 字节解码成中文(cmd 在中文 Windows 按 ANSI 代码页输出)', () => {
    const dec = new DetectingOutputDecoder();
    // “你好,来自 cmd” 的 GBK 字节(实测 cmd.exe 输出) + ASCII 前缀
    const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x2c, 0x41, 0x42]);
    expect(dec.write(gbk)).toBe('你好,AB');
    expect(dec.end()).toBe('');
  });

  it('纯 ASCII 不触发判定,直接输出', () => {
    const dec = new DetectingOutputDecoder();
    expect(dec.write(Buffer.from('hello world', 'ascii'))).toBe('hello world');
    expect(dec.end()).toBe('');
  });

  it('UTF-8 字节保持原样(系统 ACP=UTF-8 的机器)', () => {
    const dec = new DetectingOutputDecoder();
    const utf8 = Buffer.from('你好,来自 cmd', 'utf8');
    expect(dec.write(utf8)).toBe('你好,来自 cmd');
    expect(dec.end()).toBe('');
  });

  it('多字节字符跨 chunk 切分不产生乱码(stream 模式缓存尾字节)', () => {
    const dec = new DetectingOutputDecoder();
    // “中文测试” 的 GBK 字节 = D6 D0 CE C4 B2 E2 CA D4(Buffer 不支持 gbk 编码,
    // 直接用硬编码字节数组)。
    const bytes = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]);
    // chunk1:ASCII “A” + 前 3 字节(D6 D0 CE = “中” + 半个“文”的尾字节 CE)
    expect(dec.write(Buffer.concat([Buffer.from('A'), bytes.subarray(0, 3)]))).toBe('A中');
    // chunk2:剩余 5 字节 —— CE C4 = 文,B2 E2 = 测,CA D4 = 试
    expect(dec.write(bytes.subarray(3))).toBe('文测试');
    expect(dec.end()).toBe('');
  });
});
