/**
 * @file src/main/pty-utils.test.ts
 * @purpose 验证 PTY 相关纯函数 (validateDimensions / buildSpawnEnv)。
 *
 * @对应文档章节: AGENTS.md 5.6 (测试要"会出错"),覆盖错误输入与边界。
 */
import { describe, expect, it } from 'vitest';
import { buildSpawnEnv, injectTerminalHintEnv, validateDimensions } from './pty-utils';

describe('validateDimensions', () => {
  it('合法值原样返回', () => {
    expect(validateDimensions(80, 24)).toEqual({ cols: 80, rows: 24 });
    expect(validateDimensions(120, 40)).toEqual({ cols: 120, rows: 40 });
  });

  it('小于 min 被夹到 min', () => {
    expect(validateDimensions(0, 0)).toEqual({ cols: 1, rows: 1 });
    expect(validateDimensions(-5, -10)).toEqual({ cols: 1, rows: 1 });
  });

  it('大于 max 被夹到 max', () => {
    expect(validateDimensions(5000, 5000)).toEqual({ cols: 1000, rows: 1000 });
  });

  it('NaN / Infinity / 非整数 → fallback (80x24)', () => {
    expect(validateDimensions(Number.NaN, 24)).toEqual({ cols: 80, rows: 24 });
    expect(validateDimensions(80, Number.POSITIVE_INFINITY)).toEqual({
      cols: 80,
      rows: 24,
    });
    expect(validateDimensions(80.5, 24.7)).toEqual({ cols: 80, rows: 24 });
  });

  it('cols 与 rows 是独立校验,一个非法不影响另一个', () => {
    expect(validateDimensions(Number.NaN, 100)).toEqual({ cols: 80, rows: 100 });
    expect(validateDimensions(120, Number.NaN)).toEqual({ cols: 120, rows: 24 });
  });

  it('自定义 min/max 可覆盖默认', () => {
    expect(
      validateDimensions(50, 10, { minCols: 100, maxCols: 200, minRows: 20, maxRows: 50 }),
    ).toEqual({ cols: 100, rows: 20 });
  });
});

describe('buildSpawnEnv', () => {
  it('过滤掉 undefined 值,只保留 string', () => {
    const env = buildSpawnEnv({
      PATH: '/usr/bin',
      HOME: '/home/me',
      EMPTY: undefined,
    });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/me' });
    expect(Object.hasOwn(env, 'EMPTY')).toBe(false);
  });

  it('skipKeys 中的 key 被剔除', () => {
    const env = buildSpawnEnv(
      {
        PATH: '/usr/bin',
        ELECTRON_RUN_AS_NODE: '1',
        ELECTRON_RENDERER_URL: 'http://x',
      },
      ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL'],
    );
    expect(env).toEqual({ PATH: '/usr/bin' });
  });

  it('skipKeys 缺省时不剔除任何东西', () => {
    const env = buildSpawnEnv({ A: '1', B: '2' });
    expect(env).toEqual({ A: '1', B: '2' });
  });

  it('返回值是新对象,不会污染传入的源', () => {
    const source = { A: '1' };
    const env = buildSpawnEnv(source);
    env.B = '2';
    expect(source).toEqual({ A: '1' });
  });

  it('skipKeys 不存在时不报错 (传入空 Set 等价)', () => {
    expect(() => buildSpawnEnv({ A: '1' }, [])).not.toThrow();
    expect(() => buildSpawnEnv({ A: '1' }, new Set())).not.toThrow();
  });
});

describe('injectTerminalHintEnv', () => {
  it('默认写出五件套:TERM / COLORTERM / TERM_PROGRAM / TERM_PROGRAM_VERSION / PI_HYPERLINKS', () => {
    const env: Record<string, string> = {};
    injectTerminalHintEnv(env, { programName: 'Marina', appVersion: '0.1.0' });
    expect(env).toEqual({
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'Marina',
      TERM_PROGRAM_VERSION: '0.1.0',
      PI_HYPERLINKS: '1',
    });
  });

  it('PI_HYPERLINKS 强制覆盖继承值 —— Marina 的 xterm 支持 OSC 8,不让上游终端的旧值干扰 pi 的能力判断', () => {
    const env: Record<string, string> = { PI_HYPERLINKS: '0' };
    injectTerminalHintEnv(env, { programName: 'Marina' });
    expect(env.PI_HYPERLINKS).toBe('1');
  });

  it('覆盖父进程继承的 TERM_PROGRAM —— 从 VS Code 终端启动 Marina 不应让子 shell 看到 vscode', () => {
    const env: Record<string, string> = {
      TERM_PROGRAM: 'vscode',
      TERM_PROGRAM_VERSION: '1.95.0',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    };
    injectTerminalHintEnv(env, { programName: 'Marina', appVersion: '0.1.0' });
    expect(env.TERM_PROGRAM).toBe('Marina');
    expect(env.TERM_PROGRAM_VERSION).toBe('0.1.0');
  });

  it('appVersion 缺失 / 空串 → 主动 delete 继承的旧值 (避免泄漏父终端版本号)', () => {
    const env: Record<string, string> = { TERM_PROGRAM_VERSION: '1.95.0' };
    injectTerminalHintEnv(env, { programName: 'Marina' });
    expect(Object.hasOwn(env, 'TERM_PROGRAM_VERSION')).toBe(false);

    const env2: Record<string, string> = { TERM_PROGRAM_VERSION: '1.95.0' };
    injectTerminalHintEnv(env2, { programName: 'Marina', appVersion: '' });
    expect(Object.hasOwn(env2, 'TERM_PROGRAM_VERSION')).toBe(false);
  });

  it('term / colorTerm option 可覆盖默认值 (给调试 / 特殊场景留口)', () => {
    const env: Record<string, string> = {};
    injectTerminalHintEnv(env, {
      programName: 'Marina',
      term: 'dumb',
      colorTerm: '',
    });
    expect(env.TERM).toBe('dumb');
    expect(env.COLORTERM).toBe('');
  });

  it('返回值就是入参 env(原地修改,方便链式),不会拷贝出新对象', () => {
    const env: Record<string, string> = { FOO: 'bar' };
    const ret = injectTerminalHintEnv(env, { programName: 'Marina', appVersion: '1.0' });
    expect(ret).toBe(env);
    expect(env.FOO).toBe('bar');
  });
});
