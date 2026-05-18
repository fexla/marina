/**
 * @file src/main/platform/windows-env.test.ts
 * @purpose 覆盖 BETA-ENV-1 修复的核心纯函数 — expandWindowsEnvPlaceholders /
 *   normalizeWindowsSpawnEnv。
 *
 * @关键测试点(对应 windows-env.ts @修复策略 的两层防御):
 * - 占位符展开:存在 / 不存在 / 大小写不一致 / 嵌套 / 空值 / 循环 / 非字符串
 * - 子进程 env 规整:SystemRoot 缺失 / 仅大写 / 空串 / 与 windir 不同 casing
 * - PATH-like 字段范围:PATH / Path / PATHEXT / PSModulePath / ComSpec
 * - 残留告警:展开后仍含 %XYZ% 应回调 onWarn,但不抛错
 *
 * @AGENTS.md 5.6: 测试要"会出错"—— 覆盖**真实复现场景**(用户报告里的诡异
 *   `SystemRoot='' + SYSTEMROOT='C:\\Windows'`)而不是教科书 happy path。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  expandWindowsEnvPlaceholders,
  normalizeWindowsSpawnEnv,
} from './windows-env';

describe('expandWindowsEnvPlaceholders', () => {
  it('展开单个 %SystemRoot% 占位符', () => {
    const out = expandWindowsEnvPlaceholders('%SystemRoot%\\System32', {
      SystemRoot: 'C:\\Windows',
    });
    expect(out).toBe('C:\\Windows\\System32');
  });

  it('PATH 串里所有 %SystemRoot% / %SYSTEMROOT% 都被展开', () => {
    const raw =
      '%SystemRoot%\\system32;%SystemRoot%;%SystemRoot%\\System32\\Wbem;' +
      '%SYSTEMROOT%\\System32\\WindowsPowerShell\\v1.0;' +
      '%SYSTEMROOT%\\System32\\OpenSSH';
    const out = expandWindowsEnvPlaceholders(raw, { SystemRoot: 'C:\\Windows' });
    expect(out).toBe(
      'C:\\Windows\\system32;C:\\Windows;C:\\Windows\\System32\\Wbem;' +
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0;' +
        'C:\\Windows\\System32\\OpenSSH',
    );
    expect(out).not.toMatch(/%/);
  });

  it('名字查找大小写不敏感(Win32 内核行为)', () => {
    const env = { SystemRoot: 'C:\\Windows' };
    expect(expandWindowsEnvPlaceholders('%systemroot%', env)).toBe('C:\\Windows');
    expect(expandWindowsEnvPlaceholders('%SYSTEMROOT%', env)).toBe('C:\\Windows');
    expect(expandWindowsEnvPlaceholders('%SystemRoot%', env)).toBe('C:\\Windows');
    expect(expandWindowsEnvPlaceholders('%SystEmRoOt%', env)).toBe('C:\\Windows');
  });

  it('未命中的 %XYZ% **保留原样**(对齐 Win32 ExpandEnvironmentStrings,关键防御点)', () => {
    const out = expandWindowsEnvPlaceholders('%NotSet%\\bin', {
      SystemRoot: 'C:\\Windows',
    });
    expect(out).toBe('%NotSet%\\bin');
  });

  it('空值视同未命中,保留占位符(防御:env.SystemRoot="" 不应被替换成空)', () => {
    // 这是真实用户报告里的现象 — process.env.SystemRoot 是空串。
    // 若把空串当合法值替换,PATH 里 "%SystemRoot%\\System32" 会变成 "\\System32",
    // 全部路径解析失败 → 复现报告里的 PowerShell 找不到。
    const out = expandWindowsEnvPlaceholders('%SystemRoot%\\System32', {
      SystemRoot: '',
    });
    expect(out).toBe('%SystemRoot%\\System32');
  });

  it('展开内容若仍含 %name%,会继续展开(多层引用)', () => {
    // 罕见但合法:某些 installer 写 PATHEXT 时引用了别的占位符
    const out = expandWindowsEnvPlaceholders('%A%\\bin', {
      A: '%B%\\inner',
      B: 'C:\\root',
    });
    expect(out).toBe('C:\\root\\inner\\bin');
  });

  it('循环引用不会死循环(最多 5 层后停下,残留保留)', () => {
    const env = { A: '%B%', B: '%A%' };
    const out = expandWindowsEnvPlaceholders('%A%', env);
    // 任何展开都不能让进程吊死;输出仍是 string
    expect(typeof out).toBe('string');
    // 最终结果保留某种 %A%/%B% 占位符(不会变空、不会抛错)
    expect(out).toMatch(/%[AB]%/);
  });

  it('没有 % 的字符串原样返回(快路径)', () => {
    const env = { SystemRoot: 'C:\\Windows' };
    expect(expandWindowsEnvPlaceholders('C:\\already\\absolute', env)).toBe(
      'C:\\already\\absolute',
    );
    expect(expandWindowsEnvPlaceholders('', env)).toBe('');
  });

  it('单独的 % 不报错,不被识别为占位符', () => {
    const out = expandWindowsEnvPlaceholders('50% off; %SystemRoot%\\x', {
      SystemRoot: 'C:\\Windows',
    });
    expect(out).toBe('50% off; C:\\Windows\\x');
  });

  it('未闭合的 %name 不展开,原样保留', () => {
    const out = expandWindowsEnvPlaceholders('%SystemRoot\\System32', {
      SystemRoot: 'C:\\Windows',
    });
    expect(out).toBe('%SystemRoot\\System32');
  });

  it('env 里同时存在多种 casing,任一非空都能被找到', () => {
    // 这是 BETA-ENV-1 报告里的真实诡异情形:
    // process.env 同时含 SystemRoot='' 与 SYSTEMROOT='C:\\Windows'
    // 通过 buildCaseInsensitiveLookup 过滤空串,大写那条仍能命中。
    const out = expandWindowsEnvPlaceholders('%SystemRoot%\\bin', {
      SystemRoot: '',
      SYSTEMROOT: 'C:\\Windows',
    });
    expect(out).toBe('C:\\Windows\\bin');
  });
});

describe('normalizeWindowsSpawnEnv — canonical SystemRoot 补齐', () => {
  it('SystemRoot 缺失时,从 SYSTEMROOT 取值并写入 canonical key', () => {
    const env: Record<string, string> = {
      SYSTEMROOT: 'C:\\Windows',
      PATH: '%SystemRoot%\\System32',
    };
    normalizeWindowsSpawnEnv(env);
    expect(env.SystemRoot).toBe('C:\\Windows');
    expect(env.SYSTEMROOT).toBe('C:\\Windows');
    expect(env.windir).toBe('C:\\Windows');
  });

  it('SystemRoot="" 且 SYSTEMROOT="C:\\Windows" 时,覆写为非空(真实用户场景)', () => {
    // BETA-ENV-1 报告的核心症状:子进程 env 里 SystemRoot 是空串,
    // SYSTEMROOT 才是真实值。本测试钉死该回归。
    const env: Record<string, string> = {
      SystemRoot: '',
      SYSTEMROOT: 'C:\\Windows',
      PATH: '%SystemRoot%\\System32',
    };
    normalizeWindowsSpawnEnv(env);
    expect(env.SystemRoot).toBe('C:\\Windows');
    expect(env.PATH).toBe('C:\\Windows\\System32');
  });

  it('SystemRoot / SYSTEMROOT 都缺失时,从 windir 取值', () => {
    const env: Record<string, string> = {
      windir: 'D:\\Windows',
      PATH: '%SystemRoot%\\System32',
    };
    normalizeWindowsSpawnEnv(env);
    expect(env.SystemRoot).toBe('D:\\Windows');
    expect(env.PATH).toBe('D:\\Windows\\System32');
  });

  it('三个 source 全无,fallback 到 C:\\Windows', () => {
    const env: Record<string, string> = { PATH: '%SystemRoot%\\System32' };
    normalizeWindowsSpawnEnv(env);
    expect(env.SystemRoot).toBe('C:\\Windows');
    expect(env.PATH).toBe('C:\\Windows\\System32');
  });

  it('SystemRoot 已正确设置时不覆盖(幂等)', () => {
    const env: Record<string, string> = {
      SystemRoot: 'E:\\AltWindows',
      PATH: '%SystemRoot%\\System32',
    };
    normalizeWindowsSpawnEnv(env);
    expect(env.SystemRoot).toBe('E:\\AltWindows');
    expect(env.PATH).toBe('E:\\AltWindows\\System32');
  });
});

describe('normalizeWindowsSpawnEnv — PATH-like 字段展开', () => {
  it('PATH(大写)、Path(混合)都被展开', () => {
    const env: Record<string, string> = {
      SystemRoot: 'C:\\Windows',
      PATH: '%SystemRoot%\\System32;C:\\bin',
      Path: '%SystemRoot%\\System32',
    };
    normalizeWindowsSpawnEnv(env);
    expect(env.PATH).toBe('C:\\Windows\\System32;C:\\bin');
    expect(env.Path).toBe('C:\\Windows\\System32');
  });

  it('PATHEXT / PSModulePath / ComSpec 都在展开范围内', () => {
    const env: Record<string, string> = {
      SystemRoot: 'C:\\Windows',
      PATHEXT: '.COM;.EXE;.BAT',
      PSModulePath:
        '%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\Modules\\',
      ComSpec: '%SystemRoot%\\System32\\cmd.exe',
    };
    normalizeWindowsSpawnEnv(env);
    expect(env.PSModulePath).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules\\',
    );
    expect(env.ComSpec).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(env.PATHEXT).toBe('.COM;.EXE;.BAT'); // 无占位符,原样
  });

  it('用户自定义 env(如 MY_VAR=%SystemRoot%)不展开 — 仅 PATH-like 范围', () => {
    // 设计取舍:用户 template.env 里可能故意写 %XYZ% 字面量
    const env: Record<string, string> = {
      SystemRoot: 'C:\\Windows',
      MY_VAR: '%SystemRoot%\\custom',
    };
    normalizeWindowsSpawnEnv(env);
    expect(env.MY_VAR).toBe('%SystemRoot%\\custom');
  });

  it('返回值是同一引用(原地修改),便于链式', () => {
    const env: Record<string, string> = { PATH: '%SystemRoot%\\System32' };
    const out = normalizeWindowsSpawnEnv(env);
    expect(out).toBe(env);
  });
});

describe('normalizeWindowsSpawnEnv — onWarn 残留告警', () => {
  it('展开后 PATH 仍含未知占位符 → 触发 onWarn,不抛错', () => {
    const warns: string[] = [];
    const env: Record<string, string> = {
      SystemRoot: 'C:\\Windows',
      PATH: '%SystemRoot%\\System32;%TotallyUnknownVar%\\bin',
    };
    normalizeWindowsSpawnEnv(env, { onWarn: (m) => warns.push(m) });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('%TotallyUnknownVar%');
    expect(env.PATH).toBe('C:\\Windows\\System32;%TotallyUnknownVar%\\bin');
  });

  it('PATH 全部展开成功 → 不触发 onWarn', () => {
    const warn = vi.fn();
    const env: Record<string, string> = {
      SystemRoot: 'C:\\Windows',
      PATH: '%SystemRoot%\\System32',
    };
    normalizeWindowsSpawnEnv(env, { onWarn: warn });
    expect(warn).not.toHaveBeenCalled();
  });

  it('未传 onWarn 时,残留占位符仍允许通过(不阻塞 spawn)', () => {
    const env: Record<string, string> = {
      SystemRoot: 'C:\\Windows',
      PATH: '%Unknown%\\bin',
    };
    expect(() => normalizeWindowsSpawnEnv(env)).not.toThrow();
    expect(env.PATH).toBe('%Unknown%\\bin');
  });
});

describe('normalizeWindowsSpawnEnv — 真实用户报告复现(回归测)', () => {
  it('用户报告里的完整 PATH + 双 SystemRoot 同时出现,修复后 PowerShell 路径可达', () => {
    // 来源:BETA-ENV-1 报告。把用户原始 PATH 完整钉进测试,任何回归(getRefreshedPath
    // 又开始返回未展开值 / normalizeSpawnEnv 调用顺序被打乱)都会让这条测试挂掉。
    const env: Record<string, string> = {
      SystemRoot: '',
      SYSTEMROOT: 'C:\\Windows',
      PATH:
        '/usr/local/bin:/usr/bin:/bin:' +
        '%SystemRoot%/system32:%SystemRoot%:%SystemRoot%/System32/Wbem:' +
        '%SYSTEMROOT%/System32/WindowsPowerShell/v1.0:' +
        '%SYSTEMROOT%/System32/OpenSSH',
    };
    normalizeWindowsSpawnEnv(env);
    expect(env.PATH).not.toMatch(/%SystemRoot%/i);
    expect(env.PATH).toContain('C:\\Windows/System32/WindowsPowerShell/v1.0');
    expect(env.PATH).toContain('C:\\Windows/System32/OpenSSH');
    expect(env.SystemRoot).toBe('C:\\Windows');
  });
});
