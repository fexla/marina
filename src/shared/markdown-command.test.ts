/**
 * @file markdown-command.test.ts
 * @purpose 守护 Markdown 代码块语言归一化与可运行判定的契约。
 *   纯函数,无 mock;新增别名时同步加 case,防回归。
 */
import { describe, it, expect } from 'vitest';
import { resolveLanguage, isRunnable, SUPPORTED_LANGUAGES } from './markdown-command';

describe('resolveLanguage', () => {
  it('从 react-markdown 的 language-* class 归一化', () => {
    expect(resolveLanguage('language-bash')).toBe('bash');
    expect(resolveLanguage('language-powershell')).toBe('powershell');
    expect(resolveLanguage('language-pwsh')).toBe('pwsh');
    expect(resolveLanguage('language-cmd')).toBe('cmd');
    expect(resolveLanguage('language-bat')).toBe('cmd');
  });

  it('shell 系别名统一到 sh/bash', () => {
    expect(resolveLanguage('language-shell')).toBe('sh');
    expect(resolveLanguage('language-zsh')).toBe('sh');
    expect(resolveLanguage('language-fish')).toBe('sh');
    expect(resolveLanguage(undefined, 'ksh')).toBe('sh');
  });

  it('大小写与 .exe 后缀容错', () => {
    expect(resolveLanguage(undefined, 'PowerShell')).toBe('powershell');
    expect(resolveLanguage(undefined, 'POSH')).toBe('powershell');
    expect(resolveLanguage('language-PWSH.EXE')).toBe('pwsh');
    expect(resolveLanguage('language-CMD.EXE')).toBe('cmd');
  });

  it('不支持的语言返回 null', () => {
    expect(resolveLanguage('language-python')).toBeNull();
    expect(resolveLanguage('language-json')).toBeNull();
    expect(resolveLanguage('language-')).toBeNull();
    expect(resolveLanguage(undefined)).toBeNull();
    expect(resolveLanguage(undefined, '')).toBeNull();
    // 注意:API 契约是 string | undefined,null 不在契约内(renderer 类型已保证),
    // 这里不测 null 以免把非契约行为固化进测试。
  });

  it('裸语言标签可经 fallbackRaw 传入', () => {
    expect(resolveLanguage(undefined, 'batch')).toBe('cmd');
    expect(resolveLanguage(undefined, 'dos')).toBe('cmd');
  });
});

describe('isRunnable', () => {
  it('受支持语言 + 非空 code → 可运行', () => {
    expect(isRunnable('bash', 'npm test')).toBe(true);
    expect(isRunnable('sh', 'echo hi')).toBe(true);
    expect(isRunnable('powershell', 'Get-Date')).toBe(true);
    expect(isRunnable('pwsh', 'pwsh -v')).toBe(true);
    expect(isRunnable('cmd', 'dir')).toBe(true);
  });

  it('空白 code 不可运行(没东西可跑)', () => {
    expect(isRunnable('bash', '   \n\t ')).toBe(false);
    expect(isRunnable('bash', '')).toBe(false);
  });

  it('语言为 null 不可运行', () => {
    expect(isRunnable(null, 'npm test')).toBe(false);
  });

  it('SUPPORTED_LANGUAGES 与 CodeBlockLanguage union 对齐', () => {
    // 五种归一化语言都必须在支持集合里 —— main spawn 分支据此选命令。
    expect(SUPPORTED_LANGUAGES.has('bash')).toBe(true);
    expect(SUPPORTED_LANGUAGES.has('sh')).toBe(true);
    expect(SUPPORTED_LANGUAGES.has('powershell')).toBe(true);
    expect(SUPPORTED_LANGUAGES.has('pwsh')).toBe(true);
    expect(SUPPORTED_LANGUAGES.has('cmd')).toBe(true);
    expect(SUPPORTED_LANGUAGES.size).toBe(5);
  });
});
