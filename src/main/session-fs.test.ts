/**
 * @file src/main/session-fs.test.ts
 * @purpose 验证 per-session 文件系统视角层(方案-远程文件面板一致性-20260917 P1):
 *   - LocalSessionFs 与旧内联 node:fs 行为等价(~ 展开 / resolve / stat / 截断读)。
 *   - SshSessionFs 经注入的 fake spawn 工作:远端 $HOME 缓存、POSIX resolve、
 *     stat 双格式(GNU/BSD)+ DIR/MISSING 分流、base64 读取与截断、argv 构造
 *     (port/key/跳板/ControlMaster/BatchMode/sshpass)、失败映射 EIO。
 *   全程不 spawn 真实进程(AGENTS.md 9.3)。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  localSessionFs,
  createSshSessionFs,
  type SshSessionFsDeps,
  type SshSessionFsTarget,
} from './session-fs';
import { normalizePath } from './path-manager';

// ──────────────────────────────────────────────────────────────────
// fake spawn:按 (command, args) 回放结果,记录调用供断言
// ──────────────────────────────────────────────────────────────────

interface FakeSpawnResult {
  stdout?: string;
  stderr?: string;
  code?: number;
  /** 模拟挂起(不 close),配合超时断言用。 */
  hang?: boolean;
}

function makeFakeDeps(handler: (command: string, args: string[]) => FakeSpawnResult | null) {
  const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const deps: SshSessionFsDeps = {
    resolveExecutable: (name) => (name === 'ssh' ? '/usr/bin/ssh' : '/usr/bin/sshpass'),
    spawn: (command, args, options) => {
      calls.push({ command, args, env: options.env });
      const result = handler(command, args) ?? { code: 0, stdout: '' };
      const child = new EventEmitter() as unknown as ChildProcess;
      (child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
      (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
      (child as unknown as { kill: () => void }).kill = () => undefined;
      setImmediate(() => {
        if (result.hang) return;
        if (result.stdout) {
          ((child as unknown as { stdout: EventEmitter }).stdout as EventEmitter).emit(
            'data',
            Buffer.from(result.stdout, 'utf8'),
          );
        }
        if (result.stderr) {
          ((child as unknown as { stderr: EventEmitter }).stderr as EventEmitter).emit(
            'data',
            Buffer.from(result.stderr, 'utf8'),
          );
        }
        child.emit('close', result.code ?? 0);
      });
      return child;
    },
  };
  return { deps, calls };
}

const SSH_TARGET: SshSessionFsTarget = {
  host: 'srv',
  port: 22,
  username: 'u',
  authType: 'agent',
};

describe('LocalSessionFs(与旧内联 node:fs 行为等价)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'marina-sfs-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('~ 与相对路径解析', () => {
    expect(localSessionFs.resolve('/base', '~')).toBe(homedir());
    expect(localSessionFs.resolve('/base', '~/x/y.txt')).toBe(
      normalizePath(join(homedir(), 'x', 'y.txt')),
    );
    expect(localSessionFs.resolve('/base', 'a/b.txt')).toBe(
      normalizePath(join('/base', 'a', 'b.txt')),
    );
    expect(localSessionFs.resolve('/base', '/abs/x.txt')).toBe(normalizePath('/abs/x.txt'));
  });

  it('stat:存在/缺失/目录三分', async () => {
    await writeFile(join(dir, 'f.txt'), 'hello');
    await mkdir(join(dir, 'd'));
    const file = await localSessionFs.stat(join(dir, 'f.txt'));
    expect(file.exists).toBe(true);
    expect(file.isFile).toBe(true);
    expect(file.size).toBe(5);
    const miss = await localSessionFs.stat(join(dir, 'nope'));
    expect(miss.exists).toBe(false);
    const d = await localSessionFs.stat(join(dir, 'd'));
    expect(d.exists).toBe(true);
    expect(d.isFile).toBe(false);
  });

  it('readLimited 截断 + truncated 标记', async () => {
    await writeFile(join(dir, 'big.txt'), '0123456789');
    const r = await localSessionFs.readLimited(join(dir, 'big.txt'), 4);
    expect(r.buf.toString('utf8')).toBe('0123');
    expect(r.truncated).toBe(true);
    const r2 = await localSessionFs.readLimited(join(dir, 'big.txt'), 100);
    expect(r2.buf.toString('utf8')).toBe('0123456789');
    expect(r2.truncated).toBe(false);
  });
});

describe('SshSessionFs(远端 exec 视角)', () => {
  it('ensureHome 缓存远端 $HOME,resolve 按 POSIX 语义展开 ~', async () => {
    const { deps } = makeFakeDeps((_c, args) => {
      const remote = args[args.length - 1] ?? '';
      if (remote.includes('printf %s "$HOME"')) return { stdout: '/home/remote' };
      return null;
    });
    const fs = createSshSessionFs(SSH_TARGET, deps);
    await fs.ensureHome();
    expect(fs.resolve('/base', '~')).toBe('/home/remote');
    expect(fs.resolve('/base', '~/proj/a.md')).toBe('/home/remote/proj/a.md');
    expect(fs.resolve('/home/u', 'rel/a.md')).toBe('/home/u/rel/a.md');
    expect(fs.resolve('/home/u', '/abs/a.md')).toBe('/abs/a.md');
    // POSIX 视角:Windows 盘符路径不是绝对路径(会被当相对拼接,由 stat 报错)
    expect(fs.isAbsolute('C:\\x')).toBe(false);
    expect(fs.isAbsolute('/x')).toBe(true);
    expect(fs.basename('/a/b/c.md')).toBe('c.md');
    expect(fs.dirname('/a/b/c.md')).toBe('/a/b');
  });

  it('stat:GNU "size mtime" 解析 / __DIR__ / __MISSING__ / 非法输出抛 EIO', async () => {
    const { deps } = makeFakeDeps((_c, args) => {
      const remote = args[args.length - 1] ?? '';
      if (remote.includes("f='/p/file.md'")) return { stdout: '128 1700000000\n' };
      if (remote.includes("f='/p/dir'")) return { stdout: '__DIR__' };
      if (remote.includes("f='/p/none'")) return { stdout: '__MISSING__' };
      if (remote.includes("f='/p/garbage'")) return { stdout: 'not-a-number\n' };
      return null;
    });
    const fs = createSshSessionFs(SSH_TARGET, deps);
    const ok = await fs.stat('/p/file.md');
    expect(ok).toEqual({ exists: true, isFile: true, size: 128, mtimeMs: 1_700_000_000_000 });
    expect(await fs.stat('/p/dir')).toEqual({ exists: true, isFile: false, size: 0, mtimeMs: 0 });
    expect(await fs.stat('/p/none')).toEqual({ exists: false, isFile: false, size: 0, mtimeMs: 0 });
    await expect(fs.stat('/p/garbage')).rejects.toMatchObject({ code: 'EIO' });
  });

  it('readLimited / readFull 走 base64 并支持截断', async () => {
    const content = '0123456789';
    const { deps } = makeFakeDeps((_c, args) => {
      const remote = args[args.length - 1] ?? '';
      if (remote.includes('head -c 5')) return { stdout: Buffer.from('01234').toString('base64') };
      if (remote.includes('base64 <')) return { stdout: Buffer.from(content).toString('base64') };
      return null;
    });
    const fs = createSshSessionFs(SSH_TARGET, deps);
    const limited = await fs.readLimited('/p/f.txt', 4);
    expect(limited.buf.toString('utf8')).toBe('0123');
    expect(limited.truncated).toBe(true);
    const full = await fs.readFull('/p/f.txt');
    expect(full.toString('utf8')).toBe(content);
  });

  it('argv:port / BatchMode(key 认证)/ ControlMaster 三件套', () => {
    const { deps, calls } = makeFakeDeps(() => ({ stdout: '__MISSING__' }));
    const fs = createSshSessionFs(
      {
        ...SSH_TARGET,
        authType: 'keyFile',
        keyFilePath: '/key',
        proxyJump: ['hop1', 'hop2'],
        controlPath: '/cm-%r@%h:%p',
      },
      deps,
    );
    void fs.stat('/p/x').catch(() => undefined);
    expect(calls).toHaveLength(1);
    const args = calls[0]!.args;
    expect(args).toContain('-p');
    expect(args).toContain('22');
    expect(args).toContain('-i');
    expect(args).toContain('/key');
    expect(args).toContain('-J');
    expect(args).toContain('hop1,hop2');
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('ControlMaster=auto');
    expect(args).toContain('ControlPath=/cm-%r@%h:%p');
    expect(args).toContain('ControlPersist=10m');
    // 远端目标 + 命令在最后
    expect(args[args.length - 2]).toBe('u@srv');
  });

  it('argv:password 认证经 sshpass -e + SSHPASS env,且无 BatchMode', async () => {
    const { deps, calls } = makeFakeDeps(() => ({ stdout: '/home/u' }));
    const fs = createSshSessionFs(
      { ...SSH_TARGET, authType: 'password', password: 'secret' },
      deps,
    );
    await fs.ensureHome();
    expect(calls[0]!.command).toBe('/usr/bin/sshpass');
    expect(calls[0]!.args[0]).toBe('-e');
    expect(calls[0]!.args[1]).toBe('/usr/bin/ssh');
    expect(calls[0]!.env?.SSHPASS).toBe('secret');
    const flat = calls[0]!.args.join(' ');
    expect(flat).not.toContain('BatchMode');
  });

  it('远端命令失败(exit!=0)→ EIO,错误信息含 host 与 stderr 摘要', async () => {
    const { deps } = makeFakeDeps(() => ({ code: 255, stderr: 'Connection refused' }));
    const fs = createSshSessionFs(SSH_TARGET, deps);
    await expect(fs.stat('/p/x')).rejects.toMatchObject({ code: 'EIO' });
    await expect(fs.stat('/p/x')).rejects.toThrow(/srv/);
  });

  it('ssh 可执行缺失 → EIO 且不 spawn', async () => {
    const { deps, calls } = makeFakeDeps(() => ({ stdout: '' }));
    const broken: SshSessionFsDeps = {
      ...deps,
      resolveExecutable: () => null,
    };
    const fs = createSshSessionFs(SSH_TARGET, broken);
    await expect(fs.stat('/p/x')).rejects.toMatchObject({ code: 'EIO' });
    expect(calls).toHaveLength(0);
  });

  it('watch 返回 null(SSH 无变更监视,方案 §6 降级)', () => {
    const { deps } = makeFakeDeps(() => ({ stdout: '' }));
    const fs = createSshSessionFs(SSH_TARGET, deps);
    expect(fs.watch('/p/x', () => undefined)).toBeNull();
  });
});
