/**
 * @file src/shared/terminal-path-detector.test.ts
 * @purpose 验证 detectFileLinks 的 STRICT 路径检测(ADR-027 决策 1)。
 * 覆盖:带斜杠/行号列号/中文/双扩展名/绝对路径/括号包围/URL 排除/裸文件名不识别/
 * 属性访问不识别/目录名不识别。
 */
import { describe, expect, it } from 'vitest';
import { detectFileLinks, parsePathWithLineCol } from './terminal-path-detector';

describe('detectFileLinks — STRICT 路径检测', () => {
  it('带斜杠 + 行:列 → path/line/col 全解析', () => {
    const r = detectFileLinks('at src/main/session-manager.ts:1061:15');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      path: 'src/main/session-manager.ts',
      line: 1061,
      col: 15,
    });
    expect(r[0]!.raw).toBe('src/main/session-manager.ts:1061:15');
  });

  it('只有行号(无列)→ col 为 undefined', () => {
    const r = detectFileLinks('error at src/shared/protocol.ts:227');
    expect(r[0]).toMatchObject({ path: 'src/shared/protocol.ts', line: 227 });
    expect(r[0]!.col).toBeUndefined();
  });

  it('无行号 → line/col 均 undefined', () => {
    const r = detectFileLinks('FAIL src/main/file-panel-service.test.ts');
    expect(r[0]).toMatchObject({ path: 'src/main/file-panel-service.test.ts' });
    expect(r[0]!.line).toBeUndefined();
  });

  it('双扩展名(.test.ts)→ 完整保留', () => {
    const r = detectFileLinks('see src/x.spec.test.ts:42');
    expect(r[0]!.path).toBe('src/x.spec.test.ts');
  });

  it('括号包围 (src/x.ts) → 不吞括号,path 完整', () => {
    const r = detectFileLinks('  at Object.<anonymous> (src/main/ipc.ts:1867:22)');
    expect(r).toHaveLength(1);
    expect(r[0]!.path).toBe('src/main/ipc.ts');
    expect(r[0]!.line).toBe(1867);
    // raw 不含括号
    expect(r[0]!.raw.startsWith('(')).toBe(false);
  });

  it('绝对路径(/usr/local/bin/x.sh)→ 识别', () => {
    const r = detectFileLinks('run /usr/local/bin/x.sh now');
    expect(r[0]!.path).toBe('/usr/local/bin/x.sh');
  });

  it('中文路径(docs/方案-终端.md)→ 识别', () => {
    const r = detectFileLinks('修改 docs/方案-终端.md 第 42 行');
    expect(r[0]!.path).toBe('docs/方案-终端.md');
  });

  it('一行多个路径 → 全部检出', () => {
    const r = detectFileLinks('see src/a.ts:10 and lib/b.go:20');
    expect(r).toHaveLength(2);
    expect(r[0]!.path).toBe('src/a.ts');
    expect(r[1]!.path).toBe('lib/b.go');
  });

  it('start/end 是字符 index(0-based,含/不含)', () => {
    const r = detectFileLinks('ab src/x.ts');
    expect(r[0]!.start).toBe(3);
    expect(r[0]!.end).toBe(11);
    expect('ab src/x.ts'.slice(r[0]!.start, r[0]!.end)).toBe('src/x.ts');
  });
});

describe('detectFileLinks — 不该识别的(从严,降误识别)', () => {
  it('裸文件名(无斜杠)→ 不识别(README.md 等)', () => {
    expect(detectFileLinks('see README.md for details')).toEqual([]);
    expect(detectFileLinks('edit config.json')).toEqual([]);
    expect(detectFileLinks('tsc app.ts')).toEqual([]);
  });

  it('属性访问(.property,无斜杠)→ 不识别', () => {
    expect(detectFileLinks('const len = arr.length;')).toEqual([]);
    expect(detectFileLinks('return obj.toString();')).toEqual([]);
    expect(detectFileLinks('data.map(x => x.id)')).toEqual([]);
    expect(detectFileLinks('res.json({ ok: true })')).toEqual([]);
  });

  it('目录名(无扩展名)→ 不识别', () => {
    expect(detectFileLinks('cd src/main && ls')).toEqual([]);
    expect(detectFileLinks('cd lib')).toEqual([]);
  });

  it('版本号(无斜杠)→ 不识别', () => {
    expect(detectFileLinks('using node v20.10.0')).toEqual([]);
    expect(detectFileLinks('package version 2.0.1')).toEqual([]);
  });
});

describe('detectFileLinks — URL 排除(双保险,运行时 xterm 也会去重)', () => {
  it('https URL → 不识别', () => {
    expect(detectFileLinks('fetch https://example.com/api/v2')).toEqual([]);
    expect(detectFileLinks('GET http://localhost:3000/users.json')).toEqual([]);
  });

  it('URL 后面跟合法路径(同行)→ 路径仍识别(URL 段排除,路径段保留)', () => {
    // https://... 被 URL 排除,但同行独立的 src/x.ts 仍命中
    const r = detectFileLinks('see https://a.com and src/x.ts:5');
    expect(r).toHaveLength(1);
    expect(r[0]!.path).toBe('src/x.ts');
  });
});

describe('detectFileLinks — @ 歧义双候选 & ~ home (v0.3.x)', () => {
  it('@ 开头 → 双候选 [剥@, 带@](AI 引用高频排首),path 保留 @', () => {
    const r = detectFileLinks('see @src/x.ts:42');
    expect(r).toHaveLength(1);
    expect(r[0]!.raw).toBe('@src/x.ts:42');
    expect(r[0]!.path).toBe('@src/x.ts'); // path = raw 主体,保留 @
    expect(r[0]!.pathCandidates).toEqual(['src/x.ts', '@src/x.ts']); // 剥@优先
    expect(r[0]!.line).toBe(42);
  });

  it('@ 在中间(Retina 图 logo@2x.png)→ 单候选,完整保留', () => {
    const r = detectFileLinks('see assets/logo@2x.png');
    expect(r).toHaveLength(1);
    expect(r[0]!.path).toBe('assets/logo@2x.png');
    expect(r[0]!.pathCandidates).toEqual(['assets/logo@2x.png']);
  });

  it('一行多个 @ 引用 → 各自双候选', () => {
    const r = detectFileLinks('see @src/a.ts and @lib/b.go');
    expect(r).toHaveLength(2);
    expect(r[0]!.pathCandidates).toEqual(['src/a.ts', '@src/a.ts']);
    expect(r[1]!.pathCandidates).toEqual(['lib/b.go', '@lib/b.go']);
  });

  it('~ home 路径 → 识别,单候选', () => {
    const r = detectFileLinks('edit ~/projects/x.ts');
    expect(r).toHaveLength(1);
    expect(r[0]!.path).toBe('~/projects/x.ts');
    expect(r[0]!.pathCandidates).toEqual(['~/projects/x.ts']);
  });
});

describe('parsePathWithLineCol — 右键选区解析(B 部分,不要求斜杠)', () => {
  it('带行:列 → 全解析', () => {
    expect(parsePathWithLineCol('  src/x.ts:42:8  ')).toMatchObject({
      path: 'src/x.ts',
      line: 42,
      col: 8,
    });
  });
  it('裸文件名(无斜杠)→ 也认(B 选中即试)', () => {
    expect(parsePathWithLineCol('README.md')).toMatchObject({ path: 'README.md' });
  });
  it('多行选区 → 取首行', () => {
    expect(parsePathWithLineCol('src/a.ts\nsrc/b.ts').path).toBe('src/a.ts');
  });
  it('无行号 → line/col undefined', () => {
    expect(parsePathWithLineCol('lib/util.go')).toMatchObject({ path: 'lib/util.go' });
  });
});
