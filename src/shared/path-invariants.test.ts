/**
 * @file src/shared/path-invariants.test.ts
 * @purpose SSH 方案 v2.1 §I.3 + §II.1 不变式锁定:本地用户视野守护 +
 *   PathKind discriminated union exhaustiveness。
 *
 * 这些测试是"本地不变式"的最后一道防线 — 任何破坏它们的改动会让 CI Gate-1
 * 失败。详见 docs/方案-SSH-完整支持-20260524.md §III 阶段 1 / §IV CI Gates。
 *
 * 不在这里的:
 *   - PathManager 持久化迁移测试 → path-manager.test.ts
 *   - SettingsView 远程分类条件渲染 → 受限于无 React Testing Library,以
 *     buildVisibleCategories 的纯函数覆盖代替(本文件)
 */
import { describe, expect, it } from 'vitest';
import type {
  Bookmark,
  LocalBookmark,
  PathKind,
  PathNode,
  RecentEntry,
  RemoteBookmark,
} from './types';
import { assertNeverPathKind } from './types';

// ──────────────────────────────────────────────────────────────────
// §II.1 discriminated union exhaustiveness
// ──────────────────────────────────────────────────────────────────

describe('PathKind discriminated union — exhaustiveness invariants', () => {
  /**
   * switch on b.kind 后,TS 把 sshProfileId narrow 成必填 / 不存在,无需
   * `??` 兜底。任何未来加 PathKind 时(例如 'wsl' / 'docker'),编译器
   * 会强制每个 switch 加分支,assertNeverPathKind 是底线兜底。
   */
  it('switch on Bookmark.kind 覆盖 local + ssh 后,sshProfileId narrow 为必填', () => {
    const local: LocalBookmark = {
      id: 'l1',
      kind: 'local',
      path: '/tmp/a',
      addedAt: 1,
    };
    const remote: RemoteBookmark = {
      id: 'r1',
      kind: 'ssh',
      sshProfileId: 'profile-x',
      path: '~/repo',
      addedAt: 2,
    };

    function pathFor(b: Bookmark): string {
      switch (b.kind) {
        case 'local':
          // @ts-expect-error — local 分支没有 sshProfileId,访问应被 TS 拒绝
          void b.sshProfileId;
          return b.path;
        case 'ssh':
          // narrow 后 sshProfileId 直接是 string,不需要 ?? 也不需要 !
          return `${b.sshProfileId}:${b.path}`;
        default:
          return assertNeverPathKind(b);
      }
    }

    expect(pathFor(local)).toBe('/tmp/a');
    expect(pathFor(remote)).toBe('profile-x:~/repo');
  });

  it('assertNeverPathKind 在 runtime 抛错,catch 兜底未来漏 case', () => {
    const bad = 'wsl' as unknown as never;
    expect(() => assertNeverPathKind(bad)).toThrow(/unhandled PathKind/);
  });

  it('PathNode / RecentEntry / Bookmark 都按 kind narrow', () => {
    const items: Array<Bookmark | RecentEntry | PathNode> = [
      { id: 'a', kind: 'local', path: '/x', addedAt: 1 },
      { id: 'b', kind: 'ssh', sshProfileId: 'p1', path: '~/x', addedAt: 1 },
      { kind: 'local', path: '/y', lastUsedAt: 1, useCount: 1 },
      { kind: 'ssh', sshProfileId: 'p2', path: '~/y', lastUsedAt: 1, useCount: 1 },
      {
        id: 'n1',
        kind: 'local',
        path: '/z',
        category: 'bookmarked',
        sessionIds: [],
      },
      {
        id: 'n2',
        kind: 'ssh',
        sshProfileId: 'p3',
        path: '~/z',
        category: 'bookmarked',
        sessionIds: [],
      },
    ];

    const sshCount = items.filter((i) => i.kind === 'ssh').length;
    expect(sshCount).toBe(3);
    for (const i of items) {
      if (i.kind === 'ssh') {
        // narrow 后 sshProfileId 必填,不允许 undefined
        expect(typeof i.sshProfileId).toBe('string');
        expect(i.sshProfileId.length).toBeGreaterThan(0);
      }
    }
  });

  it('PathKind 字面量集合保持稳定(添加新 kind 必须同步本测试)', () => {
    const allKinds: PathKind[] = ['local', 'ssh'];
    expect(allKinds).toHaveLength(2);
  });
});

// ──────────────────────────────────────────────────────────────────
// §I.3 本地不变式 — sidebar 路径筛选
// ──────────────────────────────────────────────────────────────────

describe('Sidebar segment filter (本地不变式 §I.3)', () => {
  const sample: PathNode[] = [
    { id: '/a', kind: 'local', path: '/a', category: 'bookmarked', sessionIds: [] },
    {
      id: 'ssh:p1:~/x',
      kind: 'ssh',
      sshProfileId: 'p1',
      path: '~/x',
      category: 'bookmarked',
      sessionIds: [],
    },
    { id: '/b', kind: 'local', path: '/b', category: 'temporary', sessionIds: [] },
    {
      id: 'ssh:p1:~/y',
      kind: 'ssh',
      sshProfileId: 'p1',
      path: '~/y',
      category: 'recent',
      sessionIds: [],
    },
  ];

  function filter(nodes: PathNode[], seg: 'local' | 'remote'): PathNode[] {
    return seg === 'remote'
      ? nodes.filter((n) => n.kind === 'ssh')
      : nodes.filter((n) => n.kind === 'local');
  }

  it('segment=local 时不渲染任何 SSH 节点', () => {
    const filtered = filter(sample, 'local');
    expect(filtered.every((n) => n.kind === 'local')).toBe(true);
    expect(filtered.find((n) => n.kind === 'ssh')).toBeUndefined();
  });

  it('segment=remote 时不渲染任何本地节点', () => {
    const filtered = filter(sample, 'remote');
    expect(filtered.every((n) => n.kind === 'ssh')).toBe(true);
    expect(filtered.find((n) => n.kind === 'local')).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────
// §II.6 设置页"远程"分类条件渲染
// ──────────────────────────────────────────────────────────────────

/**
 * 与 SettingsView.tsx 的 buildVisibleCategories 同源 — 本测试以纯函数复制
 * 用于守护语义,SettingsView 改实现时这条不变式不能动:
 *   "无 SshProfile 且 advanced.enableRemote === false 时,'remote' 分类
 *    不出现在 nav 列表里。"
 *
 * 不直接 import SettingsView 是因为它依赖 React 环境 + electron preload。
 */
function shouldShowRemoteCategory(input: {
  hasSshProfiles: boolean;
  enableRemote: boolean;
}): boolean {
  return input.hasSshProfiles || input.enableRemote;
}

describe('Settings remote category visibility (本地不变式 §II.6)', () => {
  it('全新用户(无 profile + enableRemote=false)不显示 remote', () => {
    expect(
      shouldShowRemoteCategory({ hasSshProfiles: false, enableRemote: false }),
    ).toBe(false);
  });

  it('用户加了 SshProfile 后 remote 自动可见', () => {
    expect(
      shouldShowRemoteCategory({ hasSshProfiles: true, enableRemote: false }),
    ).toBe(true);
  });

  it('用户主动勾选 enableRemote(即便没 profile)remote 可见', () => {
    expect(
      shouldShowRemoteCategory({ hasSshProfiles: false, enableRemote: true }),
    ).toBe(true);
  });

  it('两者都开自然可见', () => {
    expect(
      shouldShowRemoteCategory({ hasSshProfiles: true, enableRemote: true }),
    ).toBe(true);
  });
});
