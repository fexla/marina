/**
 * @file remote-visibility.test.ts
 * @purpose 远程 UI 可见性不变式(软件定义书 §14.2 本地用户视野守护 +
 *   docs/方案-远程UI统一-20260803.md §III.4)。
 *
 * 这些测试是"本地不变式"的最后一道防线:任何一处远程 UI 显示条件
 * 与 hasAnyRemote 偏离(比如有人给 footer 按钮加了独立条件、或把
 * daemonRunning 从条件里去掉),改这个文件即可被发现。
 */
import { describe, expect, it } from 'vitest';
import { hasAnyRemote, type RemoteVisibilityInput } from './remote-visibility';

const none: RemoteVisibilityInput = {
  hasSshProfiles: false,
  hasDaemonProfiles: false,
  enableRemote: false,
  daemonRunning: false,
};

describe('hasAnyRemote — 本地用户视野不变式(§14.2)', () => {
  it('无任何远程配置时 = false(UI 与 beta.9 一致)', () => {
    expect(hasAnyRemote(none)).toBe(false);
  });

  it('只有 SSH profile → true', () => {
    expect(hasAnyRemote({ ...none, hasSshProfiles: true })).toBe(true);
  });

  it('只有远程电脑(daemon profile)→ true', () => {
    expect(hasAnyRemote({ ...none, hasDaemonProfiles: true })).toBe(true);
  });

  it('只有 enableRemote 显式开关 → true', () => {
    expect(hasAnyRemote({ ...none, enableRemote: true })).toBe(true);
  });

  it('只有服务端运行中(daemonRunning)→ true — 用户必须还能关掉它', () => {
    expect(hasAnyRemote({ ...none, daemonRunning: true })).toBe(true);
  });
});

describe('hasAnyRemote — 组合', () => {
  it('SSH + daemon 双配置 → true', () => {
    expect(hasAnyRemote({ ...none, hasSshProfiles: true, hasDaemonProfiles: true })).toBe(true);
  });

  it('enableRemote 关闭但其它项为真 → 仍 true(视野只随真实配置收敛)', () => {
    expect(hasAnyRemote({ ...none, enableRemote: false, daemonRunning: true })).toBe(true);
  });
});
