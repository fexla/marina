/**
 * @file src/main/ssh-profile-manager.test.ts
 * @purpose 覆盖 SSH profile 持久化管理器的字段归一化与校验。
 *
 * @关键设计:
 * - 不访问真实 %APPDATA%\Marina,用内存 JsonStore mock
 * - tmux 配置是 SSH 启动链路的轻量增强,旧 profile 缺字段时默认关闭
 *
 * @对应文档章节: 软件定义书.md 第 11 章数据模型;AGENTS.md 第 9 章数据安全
 */
import { describe, expect, it, vi } from 'vitest';
import { SshProfileManager } from './ssh-profile-manager';
import type { JsonStore } from './persistence';
import type { SshProfilesFile } from '@shared/types';

function makeStore(initial: SshProfilesFile = { version: 1, profiles: [] }): JsonStore<SshProfilesFile> {
  let value = initial;
  return {
    load: vi.fn(async () => ({ value, source: 'main' as const })),
    set: vi.fn((next: SshProfilesFile) => {
      value = next;
    }),
    flush: vi.fn(async () => {}),
  } as unknown as JsonStore<SshProfilesFile>;
}

describe('SshProfileManager tmux settings', () => {
  it('旧 profile 缺 tmux 字段时默认关闭,无 tmux 时回退 shell', async () => {
    const mgr = new SshProfileManager(makeStore({
      version: 1,
      profiles: [{
        id: 'ssh-1',
        name: 'prod',
        host: 'example.com',
        port: 22,
        username: 'alice',
        authType: 'agent',
        addedAt: 1,
      }],
    }));
    await mgr.initialize();

    expect(mgr.get('ssh-1')).toMatchObject({
      tmuxMode: 'disabled',
      tmuxSessionPolicy: 'reuse',
      tmuxOnMissing: 'fallback-shell',
    });
  });

  it('新增 profile 时保留合法 tmux 设置', () => {
    const mgr = new SshProfileManager(makeStore());
    const profile = mgr.add({
      name: 'prod',
      host: 'example.com',
      port: 22,
      username: 'alice',
      authType: 'agent',
      defaultRemoteCwd: '~/repo',
      tmuxMode: 'attach-or-create',
      tmuxSessionName: 'deploy.api',
      tmuxSessionPolicy: 'new-per-launch',
      tmuxOnMissing: 'fail',
    });

    expect(profile).toMatchObject({
      tmuxMode: 'attach-or-create',
      tmuxSessionName: 'deploy.api',
      tmuxSessionPolicy: 'new-per-launch',
      tmuxOnMissing: 'fail',
    });
  });

  it('拒绝含 shell metacharacter 的 tmux session 名', () => {
    const mgr = new SshProfileManager(makeStore());

    expect(() =>
      mgr.add({
        name: 'prod',
        host: 'example.com',
        port: 22,
        username: 'alice',
        authType: 'agent',
        tmuxMode: 'attach-or-create',
        tmuxSessionName: 'bad;name',
      }),
    ).toThrow(/tmux session 名称/);
  });
});
