/**
 * @file src/main/title-resolver.test.ts
 * @purpose ADR-032 纯函数层测试:resolveTitle 优先级矩阵、classifyOscTitle
 * 分类、sanitize/垃圾过滤迁移后行为不变。全部无 IO —— 这个 bug 的回归
 * 断言在这里只要一行,不需要 FakePty / Electron。
 *
 * @对应文档章节: 软件定义书.md ADR-032
 */
import { describe, expect, it } from 'vitest';
import {
  classifyOscTitle,
  createTitleState,
  isShellSelfTitle,
  resolveTitle,
  sanitizeTitle,
} from './title-resolver';

describe('resolveTitle (ADR-032 优先级裁决)', () => {
  it('回归(本 ADR 的 bug):shell 子进程的 "Windows PowerShell" 压不过 pi 的 program 标题', () => {
    const state = createTitleState('PowerShell');
    state.shell = 'Windows PowerShell';
    state.program = 'pi - 架构设计 - marina';
    expect(resolveTitle(state)).toBe('pi - 架构设计 - marina');
  });

  it('全空时回落 default(地板值永远可见)', () => {
    expect(resolveTitle(createTitleState('PowerShell'))).toBe('PowerShell');
  });

  it('shell 槽压过 default(纯 shell session 显示 shell 自报名,与旧版一致)', () => {
    const state = createTitleState('PowerShell');
    state.shell = 'Windows PowerShell';
    expect(resolveTitle(state)).toBe('Windows PowerShell');
  });

  it('program 释放后回落 shell 槽(OSC 133 D 场景)', () => {
    const state = createTitleState('PowerShell');
    state.shell = 'Windows PowerShell';
    state.program = 'pi - chat - proj';
    expect(resolveTitle(state)).toBe('pi - chat - proj');
    state.program = null; // D 释放
    expect(resolveTitle(state)).toBe('Windows PowerShell');
  });

  it('agent(bridge 声明)> program(裸 OSC)', () => {
    const state = createTitleState('PowerShell');
    state.program = 'pi - OSC 名';
    state.agent = 'bridge 报的对话名';
    expect(resolveTitle(state)).toBe('bridge 报的对话名');
  });

  it('user(手动命名)永久最高;agent 释放后回落 user', () => {
    const state = createTitleState('PowerShell');
    state.program = 'pi - chat';
    state.agent = '对话名';
    state.user = '我的固定名';
    expect(resolveTitle(state)).toBe('我的固定名');
    state.agent = null; // pi 退出
    expect(resolveTitle(state)).toBe('我的固定名');
  });

  it('同槽后写覆盖前写(槽内 last-writer-wins,槽间永不越权)', () => {
    const state = createTitleState('PowerShell');
    state.program = 'vim a.txt';
    state.program = 'vim b.txt';
    state.shell = 'Windows PowerShell'; // 后到也不越权
    expect(resolveTitle(state)).toBe('vim b.txt');
  });
});

describe('classifyOscTitle (ADR-032 分类器)', () => {
  it('TIT-1 启动垃圾 → 丢弃(null)', () => {
    expect(classifyOscTitle('C:\\Windows\\System32\\cmd.exe')).toBeNull();
    expect(classifyOscTitle('/usr/bin/bash')).toBeNull();
    expect(classifyOscTitle('MINGW64:/c/Users/HP')).toBeNull();
    expect(classifyOscTitle('pwsh.exe')).toBeNull();
  });

  it('shell 自报标题(含提权前缀 / 中文系统变体)→ shell 槽', () => {
    expect(classifyOscTitle('Windows PowerShell')).toBe('shell');
    expect(classifyOscTitle('Administrator: Windows PowerShell')).toBe('shell');
    expect(classifyOscTitle('管理员: Windows PowerShell')).toBe('shell');
    expect(classifyOscTitle('PowerShell 7')).toBe('shell');
    expect(classifyOscTitle('PowerShell 7.4.6')).toBe('shell');
    expect(classifyOscTitle('命令提示符')).toBe('shell');
    expect(classifyOscTitle('Command Prompt')).toBe('shell');
    expect(classifyOscTitle('cmd')).toBe('shell');
  });

  it('CLI 工具 / agent 的 verb-leading 标题 → program 槽', () => {
    expect(classifyOscTitle('pi - 架构设计 - marina')).toBe('program');
    expect(classifyOscTitle('vim /etc/hosts')).toBe('program');
    expect(classifyOscTitle('✻ Claude · ~/p (working…)')).toBe('program');
    expect(classifyOscTitle('make -j4')).toBe('program');
  });
});

describe('isShellSelfTitle 边界', () => {
  it('含 shell 名但非整段自报的不误判', () => {
    expect(isShellSelfTitle('PowerShell 全入门教程')).toBe(false);
    expect(isShellSelfTitle('running Windows PowerShell script')).toBe(false);
  });
});

describe('sanitizeTitle (从 session-manager 迁移,行为不变)', () => {
  it('控制字符替空格 + 折叠 + trim', () => {
    expect(sanitizeTitle('a\nb\tc')).toBe('a b c');
    expect(sanitizeTitle('   x   y ')).toBe('x y');
  });
  it('RTL override 替空格', () => {
    expect(sanitizeTitle('a\u202Eevil')).toBe('a evil');
  });
  it('截到 100 字符', () => {
    expect(sanitizeTitle('X'.repeat(200))).toHaveLength(100);
  });
  it('空 / 全空白 → 空串', () => {
    expect(sanitizeTitle('   ')).toBe('');
    expect(sanitizeTitle('')).toBe('');
  });
});
