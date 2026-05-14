/**
 * @file src/main/argv-utils.test.ts
 * @purpose argv 解析器单测。
 */
import { describe, expect, it } from 'vitest';
import { parseOpenHere } from './argv-utils';

describe('parseOpenHere', () => {
  it('找到 --open-here 后取下一个 token', () => {
    expect(
      parseOpenHere(['C:\\Marina.exe', '--open-here', 'D:\\projects\\foo']),
    ).toBe('D:\\projects\\foo');
  });

  it('没有 --open-here 返回 null', () => {
    expect(parseOpenHere(['C:\\Marina.exe', '--auto-start'])).toBeNull();
  });

  it('--open-here 在末尾(没有下一个 token)返回 null', () => {
    expect(parseOpenHere(['C:\\Marina.exe', '--open-here'])).toBeNull();
  });

  it('--open-here 后无任何非 flag token 返回 null', () => {
    // 历史测试 "防误吃" — 现在含义是 "扫完都没非 flag token"
    expect(
      parseOpenHere(['C:\\Marina.exe', '--open-here', '--auto-start']),
    ).toBeNull();
  });

  it('TIT-2: Electron 在 --open-here 后注入 Chromium flag,跳过它取真路径', () => {
    // Electron 31 second-instance argv 实测形态
    expect(
      parseOpenHere([
        'C:\\Marina.exe',
        '--open-here',
        '--allow-file-access-from-files',
        'C:\\Users\\liyue\\Desktop',
      ]),
    ).toBe('C:\\Users\\liyue\\Desktop');
  });

  it('TIT-2: 多个注入 flag 连续出现也能跳过', () => {
    expect(
      parseOpenHere([
        'exe',
        '--open-here',
        '--allow-file-access-from-files',
        '--disable-features=Foo',
        '/home/user/projects',
      ]),
    ).toBe('/home/user/projects');
  });

  it('TIT-2: POSIX 绝对路径(macOS/Linux 入口预留)正常返回', () => {
    expect(parseOpenHere(['app', '--open-here', '/Users/me/code'])).toBe(
      '/Users/me/code',
    );
  });

  it('--open-here 后是空字符串 返回 null', () => {
    expect(parseOpenHere(['C:\\Marina.exe', '--open-here', ''])).toBeNull();
  });

  it('多次出现取第一次', () => {
    expect(
      parseOpenHere([
        'exe',
        '--open-here',
        'C:\\first',
        '--open-here',
        'C:\\second',
      ]),
    ).toBe('C:\\first');
  });

  it('路径含空格/反斜杠正常返回原文', () => {
    expect(
      parseOpenHere(['exe', '--open-here', 'C:\\Users\\My Name\\Docs']),
    ).toBe('C:\\Users\\My Name\\Docs');
  });
});
