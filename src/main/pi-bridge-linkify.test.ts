/**
 * @file src/main/pi-bridge-linkify.test.ts
 * @purpose 测 packages/pi-marina-bridge/extensions/linkify.ts 的 markdown
 *   链接化 transformer(方案-终端可交互链接-20260912),以及 vendored 路径
 *   检测器与 Marina 仓 src/shared 原版的行为一致性。
 *
 * @为什么测试文件放 src/main 而包内:同 pi-bridge-inject.test.ts 先例 ——
 *   Marina 的 vitest/tsconfig 只覆盖 src/**,相对路径 import 包内模块。
 *
 * @被测契约:
 * - linkifyMarkdown:裸路径 → marina:show 动作链接(绝对化 + --line);
 *   裸 URL → 链接(超长 label 缩短);fenced code / inline code / 已有链接 /
 *   图片不透明透传;流式重跑幂等。
 * - encodeMarinaUriPayload:()'!* 等会劈断 markdown href 的字符必须补编码。
 * - vendored detectFileLinks ≡ src/shared detectFileLinks(同 corpus 全等,
 *   防两份实现漂移)。
 * - index.ts 在 Marina env 下注册 transformer,非 Marina env 零注册。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  buildMarinaShowUri,
  encodeMarinaUriPayload,
  linkifyMarkdown,
  type LinkifyContext,
} from '../../packages/pi-marina-bridge/extensions/linkify';
import { detectFileLinks as vendorDetect } from '../../packages/pi-marina-bridge/extensions/vendor/terminal-path-detector';
import { detectFileLinks as sharedDetect } from '@shared/terminal-path-detector';

/** 测试用固定上下文:cwd/home 注入避免依赖测试机真实路径。 */
const CTX: LinkifyContext = {
  availableWidth: 100,
  cwd: 'C:\\proj\\demo',
  homeDir: 'C:\\Users\\tester',
};

// ─────────────────────────────────────────────────────────────────────────────
// vendored 检测器一致性(漂移守护)
// ─────────────────────────────────────────────────────────────────────────────

describe('vendored terminal-path-detector ≡ src/shared 原版', () => {
  const CORPUS = [
    'at src/main/ipc.ts:1867:22 in Marina',
    'see @src/x.ts:42',
    'see assets/logo@2x.png',
    'edit ~/projects/x.ts',
    'see README.md',
    'https://example.com/a.ts:12 no match',
    'win D:\\data\\proj\\a.md:3 colons',
    'mixed C:/forward/slash.ts and back\\slash.ts',
    '中文路径 src/组件/面板.tsx:99',
    'no paths here at all',
    'node_modules/.bin/vitest.ts',
    '(paren/wrapped) src/a.ts:1:2 end',
    'x.tar.gz archive src/backup.tar.gz:8',
  ];

  it('同 corpus 输出全等(raw/path/line/col/start/end)', () => {
    for (const sample of CORPUS) {
      expect(vendorDetect(sample)).toEqual(sharedDetect(sample));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// encodeMarinaUriPayload
// ─────────────────────────────────────────────────────────────────────────────

describe('encodeMarinaUriPayload', () => {
  it('空格/引号/括号/百分号全部编码(markdown href 与 OSC 8 双安全)', () => {
    expect(encodeMarinaUriPayload('"a b(c).txt" --line 3')).not.toMatch(/[ !'()*"]/);
  });

  it('percent-decode 一次后还原原文(与 marina-link.ts 的单次 decode 对齐)', () => {
    const original = '"C:\\my dir\\a (1).txt" --line 42';
    const decoded = decodeURIComponent(encodeMarinaUriPayload(original));
    expect(decoded).toBe(original);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// linkifyMarkdown:裸路径
// ─────────────────────────────────────────────────────────────────────────────

describe('linkifyMarkdown 裸路径 → marina:show', () => {
  it('相对路径按 ctx.cwd 绝对化,raw 文本作 label(转义反斜杠)', () => {
    const out = linkifyMarkdown('edit src/x.ts now', CTX);
    const abs = resolve(CTX.cwd!, 'src/x.ts');
    expect(out).toBe(`edit [src/x.ts](${buildMarinaShowUri(abs)}) now`);
    // href 里只有安全字符(decode 后是 marina:show "C:\proj\demo\src\x.ts")
    expect(decodeURIComponent(buildMarinaShowUri(abs))).toBe(`marina:show "${abs}"`);
  });

  it('path:line → --line N(终端文件链接的行号语义平移)', () => {
    const out = linkifyMarkdown('see src/x.ts:42', CTX);
    expect(out).toContain('--line%2042');
    expect(decodeURIComponent(out)).toContain(`show "${resolve(CTX.cwd!, 'src/x.ts')}" --line 42`);
  });

  it('@ 前缀双候选取剥 @ 的首候选(AI 引用语义优先),label 保留原文', () => {
    const out = linkifyMarkdown('see @src/x.ts', CTX);
    expect(out).toContain('[@src/x.ts](marina:');
    expect(decodeURIComponent(out)).toContain(`show "${resolve(CTX.cwd!, 'src/x.ts')}"`);
  });

  it('~/ 路径展开到 ctx.homeDir', () => {
    const out = linkifyMarkdown('edit ~/notes/a.md', CTX);
    expect(decodeURIComponent(out)).toContain(`show "${resolve(CTX.homeDir!, 'notes/a.md')}"`);
  });

  it('绝对路径原样(不再拼 cwd)—— 正斜杠盘符形态', () => {
    const out = linkifyMarkdown('open D:/data/log.txt:10', CTX);
    expect(decodeURIComponent(out)).toContain('show "D:/data/log.txt" --line 10');
  });

  it('纯反斜杠 Windows 路径不检测 —— 与 Marina STRICT 规则一致(防盘符/注册表键误报)', () => {
    expect(linkifyMarkdown('open D:\\data\\log.txt:10', CTX)).toBe('open D:\\data\\log.txt:10');
  });

  it('裸文件名(无斜杠)不动 —— 与 Marina STRICT 规则一致', () => {
    expect(linkifyMarkdown('see README.md', CTX)).toBe('see README.md');
  });

  it('URL 内的伪路径不重复包裹(URL 优先)', () => {
    const out = linkifyMarkdown('https://example.com/a.ts:12 ok', CTX);
    expect(out).toBe('[https://example.com/a.ts:12](https://example.com/a.ts:12) ok');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// linkifyMarkdown:裸 URL
// ─────────────────────────────────────────────────────────────────────────────

describe('linkifyMarkdown 裸 URL', () => {
  it('短 URL:label 原样,包成链接保证可点', () => {
    expect(linkifyMarkdown('go https://a.dev now', CTX)).toBe(
      'go [https://a.dev](https://a.dev) now',
    );
  });

  it('超长 URL:label 缩短为域名+尾段,href 完整保留', () => {
    const url = 'https://example.com/very/long/path/to/some/deep/article/page.html?x=1#anchor';
    const out = linkifyMarkdown(`see ${url} end`, CTX);
    expect(out).toBe(`see [example.com….html?x=1#anchor](${url}) end`);
  });

  it('尾部句读剥掉(不属于 URL),括号平衡时不剥)', () => {
    expect(linkifyMarkdown('see https://a.dev/x. end', CTX)).toBe(
      'see [https://a.dev/x](https://a.dev/x). end',
    );
    // 平衡括号的 Wikipedia 式 URL 完整保留
    expect(linkifyMarkdown('(https://en.wikipedia.org/wiki/Foo_(bar))', CTX)).toBe(
      '([https://en.wikipedia.org/wiki/Foo_(bar)](https://en.wikipedia.org/wiki/Foo_(bar)))',
    );
  });

  it('<autolink> 形态不包裹(避免破坏 <> 语法)', () => {
    expect(linkifyMarkdown('<https://a.dev>', CTX)).toBe('<https://a.dev>');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 不透明段:fence / inline code / 已有链接 / 图片
// ─────────────────────────────────────────────────────────────────────────────

describe('linkifyMarkdown 不透明段透传', () => {
  it('fenced code block 内不链接化(含围栏开/闭行原样)', () => {
    const md = [
      'intro',
      '```ts',
      'const u = "https://a.dev"; // src/x.ts:1',
      '```',
      'tail src/y.ts',
    ].join('\n');
    const out = linkifyMarkdown(md, CTX);
    const lines = out.split('\n');
    expect(lines[2]).toBe('const u = "https://a.dev"; // src/x.ts:1'); // code 内原样
    expect(lines[4]).toContain('marina:'); // fence 外照常链接化
  });

  it('inline code span 内不链接化', () => {
    expect(linkifyMarkdown('run `npm i https://a.dev src/x.ts` ok', CTX)).toBe(
      'run `npm i https://a.dev src/x.ts` ok',
    );
  });

  it('未闭合 inline code(流式半截)原样到行尾,不误包', () => {
    expect(linkifyMarkdown('code `npm i src/x.ts', CTX)).toBe('code `npm i src/x.ts');
  });

  it('已有 [label](href) 整段原文回放(label 自带转义不被二次转义)', () => {
    const md = 'see [\\[x\\] docs](https://a.dev) and [plain](src/a.ts)';
    expect(linkifyMarkdown(md, CTX)).toBe(md);
  });

  it('已有链接的 label 是超长 URL → 仅缩短 label,href 不动', () => {
    const url = 'https://example.com/very/long/path/to/article/page.html#section';
    const out = linkifyMarkdown(`see [${url}](${url})`, CTX);
    expect(out).toBe(`see [example.com…age.html#section](${url})`);
  });

  it('marina: 动作链接原样(模型写的 [打开](marina:show ...) 不被加工)', () => {
    const md = 'click [打开](marina:show%20%22a.md%22%20--heading%20T)';
    expect(linkifyMarkdown(md, CTX)).toBe(md);
  });

  it('图片 ![alt](src) 原样', () => {
    const md = 'img ![shot](docs/pic.png) end';
    expect(linkifyMarkdown(md, CTX)).toBe(md);
  });

  it('引用式 [a][b] 不是链接语法,label 内路径会被包(已知取舍,罕见于对话)', () => {
    const out = linkifyMarkdown('[src/x.ts][ref]', CTX);
    expect(out).toContain('marina:');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 幂等 / 流式
// ─────────────────────────────────────────────────────────────────────────────

describe('幂等与流式安全', () => {
  it('transform(transform(x)) === transform(x)(流式重跑、防御性重入)', () => {
    const md = [
      'see src/x.ts:42 and https://example.com/very/long/path/to/page.html',
      '[docs](a.md) + `code src/x.ts`',
      '```',
      'in code src/x.ts',
      '```',
      'tail',
    ].join('\n');
    const once = linkifyMarkdown(md, CTX);
    expect(linkifyMarkdown(once, CTX)).toBe(once);
  });

  it('流式半截链接 [label](h 不被误包,补全后正常处理', () => {
    const partial = linkifyMarkdown('see [docs](src/od', CTX);
    expect(partial).toBe('see [docs](src/od');
    const full = linkifyMarkdown('see [docs](src/odd.ts)', CTX);
    expect(full).toBe('see [docs](src/odd.ts)');
  });

  it('空串/纯空白原样返回', () => {
    expect(linkifyMarkdown('', CTX)).toBe('');
    expect(linkifyMarkdown('\n\n', CTX)).toBe('\n\n');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// index.ts 注册(真实模块 + mock pi;模式同 pi-bridge-inject.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

describe('index.ts transformer 注册', () => {
  const ENV_KEYS = ['MARINA_SERVICE', 'MARINA_TOKEN', 'TERMINAL_ID'] as const;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.MARINA_SERVICE = 'http://127.0.0.1:19999';
    process.env.MARINA_TOKEN = 'tok';
    process.env.TERMINAL_ID = 't1';
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('Marina env 下注册 transformer 且透传 ctx.availableWidth', async () => {
    const mod = await import('../../packages/pi-marina-bridge/extensions/index');
    let registered: ((md: string, ctx: { availableWidth: number }) => string) | undefined;
    const pi = {
      on(): void {},
      registerMarkdownTransformer(
        fn: (md: string, ctx: { availableWidth: number }) => string,
      ): void {
        registered = fn;
      },
    };
    (mod.default as (p: unknown) => void)(pi);
    expect(registered).toBeTypeOf('function');
    const out = registered!('edit src/x.ts', {
      availableWidth: 80,
      isStreaming: true,
      messageType: 'assistant',
    } as Parameters<NonNullable<typeof registered>>[1]);
    expect(out).toContain('marina:show');
  });

  it('非 Marina env:不注册 transformer(no-op)', async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const mod = await import('../../packages/pi-marina-bridge/extensions/index');
    let called = false;
    const pi = {
      on(): void {},
      registerMarkdownTransformer(): void {
        called = true;
      },
    };
    (mod.default as (p: unknown) => void)(pi);
    expect(called).toBe(false);
  });

  it('老 pi 无 registerMarkdownTransformer 方法:不抛异常(静默降级)', async () => {
    const mod = await import('../../packages/pi-marina-bridge/extensions/index');
    const pi = { on(): void {} };
    expect(() => (mod.default as (p: unknown) => void)(pi)).not.toThrow();
  });
});
