/**
 * @file src/shared/path-display.test.ts
 * @purpose 验证 BETA-014 路径同名去重的纯函数逻辑。
 */
import { describe, expect, it } from 'vitest';
import type { PathNode } from '@shared/types';
import { disambiguatePathNames, formatDisplayPath, toWslUncPath } from './path-display';

function node(id: string, path: string, displayName?: string): PathNode {
  return {
    id,
    path,
    kind: 'local',
    category: 'bookmarked',
    sessionIds: [],
    ...(displayName !== undefined ? { displayName } : {}),
  };
}

describe('disambiguatePathNames (BETA-014)', () => {
  it('全部唯一时只取末段', () => {
    const r = disambiguatePathNames([
      node('a', 'C:\\projA\\src'),
      node('b', 'C:\\projB\\app'),
      node('c', 'C:\\projC\\lib'),
    ]);
    expect(r.get('a')).toBe('src');
    expect(r.get('b')).toBe('app');
    expect(r.get('c')).toBe('lib');
  });

  it('两条末级同名时各加一段父目录', () => {
    const r = disambiguatePathNames([
      node('a', 'C:\\projA\\src'),
      node('b', 'C:\\projB\\src'),
    ]);
    expect(r.get('a')).toBe('projA/src');
    expect(r.get('b')).toBe('projB/src');
  });

  it('三条末级同名,前段不同 → 各加一段', () => {
    const r = disambiguatePathNames([
      node('a', 'C:\\projA\\src'),
      node('b', 'C:\\projB\\src'),
      node('c', 'C:\\projC\\src'),
    ]);
    expect(r.get('a')).toBe('projA/src');
    expect(r.get('b')).toBe('projB/src');
    expect(r.get('c')).toBe('projC/src');
  });

  it('同名两层 → 加到三段', () => {
    const r = disambiguatePathNames([
      node('a', 'C:\\group1\\sub\\src'),
      node('b', 'C:\\group2\\sub\\src'),
    ]);
    // sub/src 仍同名 → group/sub/src
    expect(r.get('a')).toBe('group1/sub/src');
    expect(r.get('b')).toBe('group2/sub/src');
  });

  it('已手动命名的不参与去重', () => {
    const r = disambiguatePathNames([
      node('a', 'C:\\projA\\src', '我的项目 A'),
      node('b', 'C:\\projB\\src'),
    ]);
    expect(r.get('a')).toBe('我的项目 A');
    // 'b' 单独留在去重池里 — 没人和它同名 → 单段 'src'
    expect(r.get('b')).toBe('src');
  });

  it('同时有手动命名 + 自动同名时,自动同名仍要互相去重', () => {
    const r = disambiguatePathNames([
      node('a', 'C:\\projA\\src', '手动 A'),
      node('b', 'C:\\projB\\src'),
      node('c', 'C:\\projC\\src'),
    ]);
    expect(r.get('a')).toBe('手动 A');
    expect(r.get('b')).toBe('projB/src');
    expect(r.get('c')).toBe('projC/src');
  });

  it('Linux 风格 / 路径', () => {
    const r = disambiguatePathNames([
      node('a', '/home/user/projA/src'),
      node('b', '/home/user/projB/src'),
    ]);
    expect(r.get('a')).toBe('projA/src');
    expect(r.get('b')).toBe('projB/src');
  });

  it('空 displayName 视为未手动命名', () => {
    const r = disambiguatePathNames([
      node('a', 'C:\\projA\\src', ''),
      node('b', 'C:\\projB\\src'),
    ]);
    expect(r.get('a')).toBe('projA/src');
    expect(r.get('b')).toBe('projB/src');
  });

  it('完全相同的路径(理论上不应出现)走到根仍接受同名', () => {
    const r = disambiguatePathNames([
      node('a', 'C:\\projA\\src'),
      node('b', 'C:\\projA\\src'),
    ]);
    // 两条都吃到根,定稿相同名:实际数据里不会出现,但函数不应死循环
    expect(r.get('a')).toBeDefined();
    expect(r.get('b')).toBeDefined();
  });

  it('单条节点直接返回末段', () => {
    const r = disambiguatePathNames([node('a', 'C:\\onlyOne\\src')]);
    expect(r.get('a')).toBe('src');
  });
});

describe('formatDisplayPath', () => {
  it('WSL home 下路径显示为 ~ 开头', () => {
    expect(formatDisplayPath('\\\\wsl$\\Rocky8\\home\\me\\repo')).toBe('~/repo');
    expect(formatDisplayPath('\\\\wsl.localhost\\Ubuntu\\home\\me')).toBe('~');
  });

  it('WSL 非 home 路径显示为 Linux 绝对路径', () => {
    expect(formatDisplayPath('\\\\wsl$\\Rocky8\\etc\\nginx')).toBe('/etc/nginx');
  });

  it('非 WSL 路径保持原样', () => {
    expect(formatDisplayPath('D:\\projects\\marina')).toBe('D:\\projects\\marina');
  });
});

describe('toWslUncPath', () => {
  it('把 Linux 绝对路径转为 WSL UNC 路径', () => {
    expect(toWslUncPath('Rocky8', '/home/me/repo')).toBe('\\\\wsl$\\Rocky8\\home\\me\\repo');
  });

  it('根目录和 home 简写默认打开发行版根目录', () => {
    expect(toWslUncPath('Ubuntu', '/')).toBe('\\\\wsl$\\Ubuntu\\');
    expect(toWslUncPath('Ubuntu', '~/repo')).toBe('\\\\wsl$\\Ubuntu\\');
  });
});
