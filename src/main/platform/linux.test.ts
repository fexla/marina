/**
 * @file src/main/platform/linux.test.ts
 * @purpose 覆盖 LinuxAdapter 的核心方法。完全 mock 文件系统 / child_process,
 *   不真访问 /proc / /etc/shells / gsettings。
 *
 * @对应工单: BETA-003a
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NodeFs from 'node:fs';

// 模块级 mock:fs.promises 与 child_process.execFile
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs');
  return {
    ...actual,
    promises: {
      readFile: vi.fn(),
      access: vi.fn(),
      readlink: vi.fn(),
      writeFile: vi.fn(),
      mkdir: vi.fn(),
      unlink: vi.fn(),
    },
  };
});

vi.mock('node:child_process', () => ({
  execFile: vi.fn(
    (
      _cmd: string,
      _args: string[],
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      cb(null, '', '');
    },
  ),
}));

vi.mock('../logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// 必须在 mock 之后再 import 被测模块
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { LinuxAdapter } from './linux';

const fsRead = fs.readFile as ReturnType<typeof vi.fn>;
const fsAccess = fs.access as ReturnType<typeof vi.fn>;
const fsReadlink = fs.readlink as ReturnType<typeof vi.fn>;
const fsWrite = fs.writeFile as ReturnType<typeof vi.fn>;
const fsMkdir = fs.mkdir as ReturnType<typeof vi.fn>;
const fsUnlink = fs.unlink as ReturnType<typeof vi.fn>;
const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  // 默认让所有 mock 走"成功"路径,各 test 按需覆盖
  fsAccess.mockResolvedValue(undefined);
  fsMkdir.mockResolvedValue(undefined);
  fsWrite.mockResolvedValue(undefined);
  fsUnlink.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LinuxAdapter — lifecycleModel', () => {
  it("固定为 'no-persistence' (ADR-013 方案 A)", () => {
    const adapter = new LinuxAdapter();
    expect(adapter.lifecycleModel).toBe('no-persistence');
  });
});

describe('LinuxAdapter — detectShells', () => {
  it('解析 /etc/shells,过滤伪 shell,按优先级排序', async () => {
    fsRead.mockResolvedValue(
      [
        '# /etc/shells: valid login shells',
        '/bin/sh',
        '/bin/bash',
        '/usr/bin/bash',
        '/bin/zsh',
        '/usr/bin/fish',
        '/usr/sbin/nologin',
        '/bin/false',
      ].join('\n'),
    );
    fsAccess.mockResolvedValue(undefined);

    const adapter = new LinuxAdapter();
    const shells = await adapter.detectShells();

    // bash > zsh > fish 排序(BETA-003a 决策:bash 排第一,hook 已测试完备;
    // zsh / fish 暂未完整接通临时副本铺设,优先级靠后)
    const ids = shells.map((s) => s.id);
    expect(ids[0]).toBe('bash');
    expect(ids[1]).toBe('zsh');
    expect(ids[2]).toBe('fish');
    // nologin / false 被过滤
    expect(ids).not.toContain('nologin');
    expect(ids).not.toContain('false');
    // 同名 bash 只保留第一个(/bin/bash)
    const bashEntries = shells.filter((s) => s.id === 'bash');
    expect(bashEntries).toHaveLength(1);
    expect(bashEntries[0]!.executablePath).toBe('/bin/bash');
  });

  it('/etc/shells 读不到 → 兜底返回 bash', async () => {
    fsRead.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const adapter = new LinuxAdapter();
    const shells = await adapter.detectShells();
    expect(shells).toEqual([
      { id: 'bash', displayName: 'Bash', executablePath: '/bin/bash' },
    ]);
  });

  it('shell 路径不可执行 → 跳过该条', async () => {
    fsRead.mockResolvedValue('/bin/bash\n/bin/zsh\n');
    // bash 可执行,zsh 不可执行
    fsAccess.mockImplementation(async (path: string) => {
      if (path === '/bin/zsh') throw new Error('EACCES');
    });
    const adapter = new LinuxAdapter();
    const shells = await adapter.detectShells();
    expect(shells.map((s) => s.id)).toEqual(['bash']);
  });
});

describe('LinuxAdapter — buildShellLaunchParams', () => {
  const adapter = new LinuxAdapter();

  it('bash 走 --rcfile + -i', () => {
    const result = adapter.buildShellLaunchParams(
      { id: 'bash', displayName: 'Bash', executablePath: '/bin/bash' },
      '/tmp/marina-hook.bashrc',
    );
    expect(result.args).toEqual(['--rcfile', '/tmp/marina-hook.bashrc', '-i']);
    expect(result.env).toEqual({});
  });

  it('zsh 走 ZDOTDIR 环境变量', () => {
    const result = adapter.buildShellLaunchParams(
      { id: 'zsh', displayName: 'Zsh', executablePath: '/bin/zsh' },
      '/tmp/marina-zsh-dir/.zshrc',
    );
    expect(result.args).toEqual(['-i']);
    expect(result.env['ZDOTDIR']).toBe('/tmp/marina-zsh-dir');
  });

  it('fish 走 XDG_CONFIG_HOME 指向 fish/config.fish 上两级', () => {
    const result = adapter.buildShellLaunchParams(
      { id: 'fish', displayName: 'Fish', executablePath: '/usr/bin/fish' },
      '/tmp/marina-fish/fish/config.fish',
    );
    expect(result.args).toEqual(['-i']);
    expect(result.env['XDG_CONFIG_HOME']).toBe('/tmp/marina-fish');
  });

  it('带 commandToRun 时:bash -c "cmd; exec bash -i"', () => {
    const result = adapter.buildShellLaunchParams(
      { id: 'bash', displayName: 'Bash', executablePath: '/bin/bash' },
      '/tmp/hook',
      { command: 'echo', args: ['hello world'] },
    );
    expect(result.args[0]).toBe('--rcfile');
    expect(result.args[1]).toBe('/tmp/hook');
    expect(result.args[2]).toBe('-i');
    expect(result.args[3]).toBe('-c');
    expect(result.args[4]).toMatch(/echo.*hello world.*exec bash -i/);
  });
});

describe('LinuxAdapter — getProcessCwd', () => {
  it('正常 readlink /proc/<pid>/cwd', async () => {
    fsReadlink.mockResolvedValue('/home/user/project');
    const adapter = new LinuxAdapter();
    const cwd = await adapter.getProcessCwd(1234);
    expect(cwd).toBe('/home/user/project');
    expect(fsReadlink).toHaveBeenCalledWith('/proc/1234/cwd');
  });

  it('进程已退出 ENOENT → 返回 null', async () => {
    fsReadlink.mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );
    const adapter = new LinuxAdapter();
    expect(await adapter.getProcessCwd(1234)).toBe(null);
  });

  it('非法 pid → null 不调 readlink', async () => {
    const adapter = new LinuxAdapter();
    expect(await adapter.getProcessCwd(-1)).toBe(null);
    expect(await adapter.getProcessCwd(0)).toBe(null);
    expect(fsReadlink).not.toHaveBeenCalled();
  });
});

describe('LinuxAdapter — setAutoStart / isAutoStartEnabled', () => {
  it('setAutoStart(true) 写 .desktop 文件', async () => {
    const adapter = new LinuxAdapter();
    await adapter.setAutoStart(true);

    expect(fsMkdir).toHaveBeenCalledTimes(1);
    expect(fsWrite).toHaveBeenCalledTimes(1);
    const [, content] = fsWrite.mock.calls[0]!;
    expect(content).toContain('[Desktop Entry]');
    expect(content).toContain('Type=Application');
    expect(content).toContain('Name=Marina');
    expect(content).toContain('Exec=');
  });

  it('setAutoStart(false) 删除文件,ENOENT 容忍', async () => {
    const adapter = new LinuxAdapter();
    fsUnlink.mockRejectedValueOnce(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );
    await expect(adapter.setAutoStart(false)).resolves.not.toThrow();
  });

  it('isAutoStartEnabled 文件存在 → true', async () => {
    const adapter = new LinuxAdapter();
    fsAccess.mockResolvedValueOnce(undefined);
    expect(await adapter.isAutoStartEnabled()).toBe(true);
  });

  it('isAutoStartEnabled 文件不存在 → false', async () => {
    const adapter = new LinuxAdapter();
    fsAccess.mockRejectedValueOnce(new Error('ENOENT'));
    expect(await adapter.isAutoStartEnabled()).toBe(false);
  });
});

describe('LinuxAdapter — registerFileManagerIntegration', () => {
  it('依次调 gsettings + update-alternatives', async () => {
    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        cb(null, '', '');
      },
    );
    const adapter = new LinuxAdapter();
    await adapter.registerFileManagerIntegration('/usr/bin/marina');

    const cmds = execFileMock.mock.calls.map((c) => c[0]);
    expect(cmds).toContain('gsettings');
    expect(cmds).toContain('update-alternatives');
  });

  it('update-alternatives 失败 → 回退 alternatives', async () => {
    let firstUpdateAlt = true;
    execFileMock.mockImplementation(
      (
        cmd: string,
        _args: string[],
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        if (cmd === 'update-alternatives' && firstUpdateAlt) {
          firstUpdateAlt = false;
          cb(new Error('ENOENT'), '', '');
        } else {
          cb(null, '', '');
        }
      },
    );
    const adapter = new LinuxAdapter();
    await adapter.registerFileManagerIntegration('/usr/bin/marina');

    const cmds = execFileMock.mock.calls.map((c) => c[0]);
    expect(cmds).toContain('alternatives');
  });
});

describe('LinuxAdapter — getDefaultBookmarkSeeds', () => {
  it('返回桌面 + 主目录两条', () => {
    const adapter = new LinuxAdapter();
    const seeds = adapter.getDefaultBookmarkSeeds();
    expect(seeds).toHaveLength(2);
    expect(seeds[0]!.label).toBe('桌面');
    expect(seeds[1]!.label).toBe('主目录');
  });
});
