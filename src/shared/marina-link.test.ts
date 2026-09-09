/**
 * @file src/shared/marina-link.test.ts
 * @purpose 守护 marina: 动作链接的解析契约(v0.3.3 ADR-035):
 *   percent-decode → shell 风格分词 → show/run 子命令结构。
 *
 * @为什么值得测:解析结果是 main 端直接执行的动作(打开文件 / 跑命令),
 *   分词规则(引号 / 反斜杠字面 / %20 还原)任何漂移都会让 AI 按旧文档写的
 *   链接静默变义 —— 用例直接钉住「AI 文档怎么写 → 解析成什么」。
 */
import { describe, expect, it } from 'vitest';
import {
  marinaLinkDisplayCommand,
  parseMarinaLinkHref,
  peekMarinaLinkKind,
} from './marina-link';

describe('parseMarinaLinkHref: show', () => {
  it('基础形式:相对路径', () => {
    expect(parseMarinaLinkHref('marina:show issue-42.md')).toEqual({
      ok: true,
      command: { kind: 'show', path: 'issue-42.md' },
    });
  });

  it('CommonMark 形态:空格写 %20 先解码再分词(解码后是一个含空格的参数)', () => {
    expect(parseMarinaLinkHref('marina:show%20my%20report.md')).toEqual({
      ok: true,
      command: { kind: 'show', path: 'my report.md' },
    });
  });

  it('引号形式:含空格路径整体一个参数', () => {
    expect(parseMarinaLinkHref('marina:show "my report.md"')).toEqual({
      ok: true,
      command: { kind: 'show', path: 'my report.md' },
    });
  });

  it('Windows 绝对路径:反斜杠保持字面(不被当转义吃掉)', () => {
    // micromark 会把反斜杠编码成 %5C,解码后是字面反斜杠
    expect(parseMarinaLinkHref('marina:show D:%5Cws%5Cissue%2042.md')).toEqual({
      ok: true,
      command: { kind: 'show', path: 'D:\\ws\\issue 42.md' },
    });
    expect(parseMarinaLinkHref('marina:show D:/ws/issue.md')).toEqual({
      ok: true,
      command: { kind: 'show', path: 'D:/ws/issue.md' },
    });
  });

  it('--heading 提取(引号值 / %20 值都行)', () => {
    expect(parseMarinaLinkHref('marina:show a.md --heading "Verification Steps"')).toEqual({
      ok: true,
      command: { kind: 'show', path: 'a.md', heading: 'Verification Steps' },
    });
    expect(parseMarinaLinkHref('marina:show a.md --heading%20验证')).toEqual({
      ok: true,
      command: { kind: 'show', path: 'a.md', heading: '验证' },
    });
    // 误写的未知 flag 不报错,拼进路径(以「文件不存在」自然浮错)
    expect(parseMarinaLinkHref('marina:show a.md --quiet')).toEqual({
      ok: true,
      command: { kind: 'show', path: 'a.md --quiet' },
    });
  });

  it('两个引号并排 = 保留各自内容;唯一转义是反斜杠+同款引号', () => {
    expect(parseMarinaLinkHref('marina:show "say \'hi\' now.md"')).toEqual({
      ok: true,
      command: { kind: 'show', path: "say 'hi' now.md" },
    });
    expect(parseMarinaLinkHref('marina:show "a \\"quoted\\" file.md"')).toEqual({
      ok: true,
      command: { kind: 'show', path: 'a "quoted" file.md' },
    });
  });

  it('scheme 大小写不敏感', () => {
    expect(parseMarinaLinkHref('MARINA:SHOW a.md')).toEqual({
      ok: true,
      command: { kind: 'show', path: 'a.md' },
    });
  });

  it('位置参数按单空格拼接:两个裸 token 等价一个含空格路径', () => {
    expect(parseMarinaLinkHref('marina:show my report.md')).toEqual({
      ok: true,
      command: { kind: 'show', path: 'my report.md' },
    });
  });

  it('缺路径 / --heading 缺值 都报可读错误', () => {
    expect(parseMarinaLinkHref('marina:show')).toEqual({
      ok: false,
      error: expect.stringContaining('需要一个文件路径'),
    });
    expect(parseMarinaLinkHref('marina:show a.md --heading')).toEqual({
      ok: false,
      error: expect.stringContaining('--heading'),
    });
  });
});

describe('parseMarinaLinkHref: run', () => {
  it('多 token 命令拼成一条(%20 解码出的空格不拼进去)', () => {
    expect(parseMarinaLinkHref('marina:run gh issue list --limit 5')).toEqual({
      ok: true,
      command: { kind: 'run', command: 'gh issue list --limit 5' },
    });
    // gh%20issue%20list 解码后是「一个含空格 token」= 整条命令,同样合法
    expect(parseMarinaLinkHref('marina:run gh%20issue%20list')).toEqual({
      ok: true,
      command: { kind: 'run', command: 'gh issue list' },
    });
  });

  it('引号命令保留内部空格', () => {
    expect(parseMarinaLinkHref('marina:run "git log --oneline -5"')).toEqual({
      ok: true,
      command: { kind: 'run', command: 'git log --oneline -5' },
    });
  });

  it('--title 只在命令开始前识别(CLI 文档同位:run --title X <cmd>)', () => {
    expect(parseMarinaLinkHref('marina:run --title "Git 状态" "git status"')).toEqual({
      ok: true,
      command: { kind: 'run', command: 'git status', title: 'Git 状态' },
    });
    // 命令开始后的 --title 属于命令本身
    expect(parseMarinaLinkHref('marina:run "git status" --title X')).toEqual({
      ok: true,
      command: { kind: 'run', command: 'git status --title X' },
    });
  });

  it('命令自身的 flag(-q / --limit 等)原样保留', () => {
    expect(parseMarinaLinkHref('marina:run make test -q')).toEqual({
      ok: true,
      command: { kind: 'run', command: 'make test -q' },
    });
  });

  it('--title 缺值报错;空命令报错', () => {
    expect(parseMarinaLinkHref('marina:run --title')).toEqual({
      ok: false,
      error: expect.stringContaining('--title'),
    });
    expect(parseMarinaLinkHref('marina:run')).toEqual({
      ok: false,
      error: expect.stringContaining('需要命令'),
    });
  });
});

describe('parseMarinaLinkHref: 边界', () => {
  it('非 marina: 前缀报错(含 marinax: 这类伪前缀)', () => {
    expect(parseMarinaLinkHref('https://example.com')).toEqual({
      ok: false,
      error: expect.stringContaining('不是 marina:'),
    });
    expect(parseMarinaLinkHref('marinax:show a.md')).toEqual({
      ok: false,
      error: expect.stringContaining('不是 marina:'),
    });
    expect(parseMarinaLinkHref('')).toEqual({ ok: false, error: expect.any(String) });
  });

  it('未支持子命令报错并列出可用集', () => {
    expect(parseMarinaLinkHref('marina:close --all')).toEqual({
      ok: false,
      error: expect.stringContaining('show'),
    });
    expect(parseMarinaLinkHref('marina:')).toEqual({
      ok: false,
      error: expect.stringContaining('(空)'),
    });
  });

  it('超限参数报错', () => {
    expect(parseMarinaLinkHref(`marina:run ${'a'.repeat(5000)}`)).toEqual({
      ok: false,
      error: expect.stringContaining('上限'),
    });
  });

  it('畸形 % 序列容错(保留原值继续解析)', () => {
    expect(parseMarinaLinkHref('marina:show 100%.md')).toEqual({
      ok: true,
      command: { kind: 'show', path: '100%.md' },
    });
  });

  it('未闭合引号容忍到底(剩余字符进 token)', () => {
    expect(parseMarinaLinkHref('marina:show "unterminated file.md')).toEqual({
      ok: true,
      command: { kind: 'show', path: 'unterminated file.md' },
    });
  });
});

describe('peekMarinaLinkKind / marinaLinkDisplayCommand(渲染层轻量窥探)', () => {
  it('kind 只认 show/run,大小写不敏感,其它 null', () => {
    expect(peekMarinaLinkKind('marina:show a.md')).toBe('show');
    expect(peekMarinaLinkKind('marina:RUN x')).toBe('run');
    expect(peekMarinaLinkKind('marina:close x')).toBeNull();
    expect(peekMarinaLinkKind('./local.md')).toBeNull();
  });

  it('displayCommand 返回解码后的参数原文(chip tooltip 用)', () => {
    expect(marinaLinkDisplayCommand('marina:show%20a%20b.md')).toBe('show a b.md');
    expect(marinaLinkDisplayCommand('marina:run gh pr list')).toBe('run gh pr list');
    expect(marinaLinkDisplayCommand('https://x.dev')).toBeNull();
    // trim 掉解码后首尾空白,tooltip 干净
    expect(marinaLinkDisplayCommand('marina:%20show%20a.md%20')).toBe('show a.md');
  });
});
