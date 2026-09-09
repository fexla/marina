/**
 * @file src/main/pi-bridge-inject.test.ts
 * @purpose 测 packages/pi-marina-bridge/extensions/inject.ts 的 skill 目录解析、
 *   Marina 系统提示词注入纯函数,以及 index.ts 的 handler 注册逻辑
 *   (方案-pibridge-skill与提示词注入-20260909)。
 *
 * @为什么测试文件放 src/main 而包内:Marina 的 vitest/tsconfig 只覆盖 src/**,
 *   所以沿用 pi-bridge-binding.test.ts 的先例 —— 测试文件放 src/main、相对路径
 *   import 包内模块。
 *
 * @被测契约:
 *   - resolveSkillsDir:extension 模块 URL → <pkg>/skills 绝对路径。
 *   - appendMarinaPrompt:幂等追加(含 marker 不重复);追加块含 marker + 三节
 *     Marina 约定(大段输出走 show-in-marina / 瀑布式 / grilling)。
 *   - skillsDirExists:目录存在性(真包目录存在;虚构路径不存在)。
 *   - index.ts 工厂(动态 import 真模块 + mock pi):非 Marina env 零注册;
 *     Marina env 下 resources_discover 返回包内 skills 路径、before_agent_start
 *     幂等追加提示词。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  MARINA_PROMPT_MARKER,
  MARINA_SYSTEM_PROMPT,
  appendMarinaPrompt,
  resolveSkillsDir,
  skillsDirExists,
} from '../../packages/pi-marina-bridge/extensions/inject';

describe('resolveSkillsDir', () => {
  it('extension 模块 URL → 包根/skills 绝对路径', () => {
    // 模拟 jiti 加载 <pkg>/extensions/index.ts 时传入的 import.meta.url
    // (Windows 形态:file:/// 加盘符,percent-encoding 由 fileURLToPath 解)。
    const url = 'file:///D:/data/marina/packages/pi-marina-bridge/extensions/index.ts';
    const dir = resolveSkillsDir(url);
    expect(dir).toBe(resolve('D:/data/marina/packages/pi-marina-bridge/skills'));
  });

  it('percent-encoded 路径(带空格的安装目录)正确解码', () => {
    // 稳定位置 ~/.pi/agent/packages/... 可能落在带空格的用户目录;URL 形态是 %20。
    const url =
      'file:///C:/Users/My%20Name/.pi/agent/packages/pi-marina-bridge/extensions/index.ts';
    const dir = resolveSkillsDir(url);
    expect(dir).toBe(resolve('C:/Users/My Name/.pi/agent/packages/pi-marina-bridge/skills'));
  });
});

describe('skillsDirExists', () => {
  it('真实包内 skills 目录存在(打包/复制完整性的正向样例)', () => {
    const pkgSkills = resolve(__dirname, '..', '..', 'packages', 'pi-marina-bridge', 'skills');
    expect(skillsDirExists(pkgSkills)).toBe(true);
  });

  it('虚构路径不存在', () => {
    expect(skillsDirExists(resolve(__dirname, 'no-such-dir-xyz'))).toBe(false);
  });
});

describe('appendMarinaPrompt', () => {
  it('base 不含 marker → 追加完整 Marina 提示词块', () => {
    const out = appendMarinaPrompt('You are pi.');
    expect(out).not.toBe('You are pi.');
    expect(out.startsWith('You are pi.\n\n')).toBe(true);
    expect(out).toContain(MARINA_PROMPT_MARKER);
    expect(out).toContain(MARINA_SYSTEM_PROMPT);
  });

  it('base 已含 marker → 原样返回(pi 每轮从 base 重建,此为防御路径)', () => {
    const once = appendMarinaPrompt('base prompt');
    const twice = appendMarinaPrompt(once);
    expect(twice).toBe(once);
  });

  it('追加两次后长度不变(幂等)', () => {
    const once = appendMarinaPrompt('base prompt');
    expect(appendMarinaPrompt(once).length).toBe(once.length);
  });
});

describe('MARINA_SYSTEM_PROMPT 内容(来源:开发者 CLAUDE.md 的 Marina 三节)', () => {
  it('含 show-in-marina skill 引用与渐进披露指引', () => {
    expect(MARINA_SYSTEM_PROMPT).toContain('show-in-marina');
    expect(MARINA_SYSTEM_PROMPT).toContain('SKILL.md');
  });

  it('覆盖三节约定:大段输出走面板 / 瀑布式 / grilling', () => {
    expect(MARINA_SYSTEM_PROMPT).toContain('输出与展示');
    expect(MARINA_SYSTEM_PROMPT).toContain('瀑布式');
    expect(MARINA_SYSTEM_PROMPT).toContain('grilling');
    expect(MARINA_SYSTEM_PROMPT).toContain('推论');
  });

  it('marker 位于注入块首行(幂等检查的锚点)', () => {
    expect(MARINA_SYSTEM_PROMPT.startsWith(MARINA_PROMPT_MARKER)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// index.ts 注册逻辑(动态 import 真模块 + mock pi)。pi 的 ExtensionAPI 只有
// type-only import(index.ts 里 `import type`),vitest 转译时擦除,不需要
// marina 仓里装 pi 依赖 —— 这里测的是我们自己的注册/守卫逻辑,不是 pi 本身。
// ─────────────────────────────────────────────────────────────────────────────

/** 捕获 pi.on 注册的 handler,按事件名索引。 */
function createMockPi(): {
  pi: { on: (event: string, handler: (...args: unknown[]) => unknown) => void };
  handlers: Map<string, Array<(...args: unknown[]) => unknown>>;
} {
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const pi = {
    on(event: string, handler: (...args: unknown[]) => unknown): void {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };
  return { pi, handlers };
}

describe('index.ts extension 工厂(真实模块 + mock pi)', () => {
  const ENV_KEYS = ['MARINA_SERVICE', 'MARINA_TOKEN', 'TERMINAL_ID'] as const;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('非 Marina 环境:零注册(no-op 是全局安装安全性的关键)', async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const mod = await import('../../packages/pi-marina-bridge/extensions/index');
    const { pi, handlers } = createMockPi();
    (mod.default as (p: unknown) => void)(pi);
    expect(handlers.size).toBe(0);
  });

  it('Marina 环境:注册 resources_discover + before_agent_start,行为正确', async () => {
    process.env.MARINA_SERVICE = 'http://127.0.0.1:19999';
    process.env.MARINA_TOKEN = 'tok';
    process.env.TERMINAL_ID = 't1';
    const mod = await import('../../packages/pi-marina-bridge/extensions/index');
    const { pi, handlers } = createMockPi();
    (mod.default as (p: unknown) => void)(pi);

    // 5 个转发事件 + 2 个注入钩子(与 index.ts 文件头的注册清单一致)。
    expect([...handlers.keys()].sort()).toEqual(
      [
        'session_start',
        'session_shutdown',
        'agent_start',
        'agent_settled',
        'session_before_compact',
        'session_compact',
        'session_info_changed',
        'resources_discover',
        'before_agent_start',
      ].sort(),
    );

    // resources_discover → 贡献包内 skills/ 目录(真实 index.ts 所在包的路径)。
    const discover = handlers.get('resources_discover')![0]!;
    const discovered = (await discover({
      type: 'resources_discover',
      cwd: '/x',
      reason: 'startup',
    })) as { skillPaths: string[] };
    expect(discovered.skillPaths).toEqual([
      resolve(__dirname, '..', '..', 'packages', 'pi-marina-bridge', 'skills'),
    ]);

    // before_agent_start → 幂等追加 Marina 提示词。
    const beforeStart = handlers.get('before_agent_start')![0]!;
    const r1 = (await beforeStart({
      type: 'before_agent_start',
      prompt: 'hi',
      systemPrompt: 'base',
    })) as {
      systemPrompt: string;
    };
    expect(r1.systemPrompt).toBe(appendMarinaPrompt('base'));
    const r2 = (await beforeStart({
      type: 'before_agent_start',
      prompt: 'hi',
      systemPrompt: r1.systemPrompt,
    })) as { systemPrompt: string };
    expect(r2.systemPrompt).toBe(r1.systemPrompt); // 幂等:不重复追加
  });
});
