/**
 * @file pi-bridge-binding.test.ts
 * @purpose 测 packages/pi-marina-bridge/extensions/binding.ts 的绑定读取纯函数。
 *   这是 bridge 包里**唯一可单测的逻辑**(其余是 pi 运行时胶水);vitest 只覆盖
 *   src/**,所以测试文件放 src/main、相对路径 import 包内模块。
 *
 * @被测行为(方案-pibridge-fork与子会话适配-20260817):
 * - readBranchWorkspaceId:取**当前分支(root→leaf 顺序数组)离 leaf 最近**的
 *   绑定 entry(从尾向前扫),不是全文件第一个——旧的 first-match 会永久命中最老
 *   的死绑定(workspace 回收后每次 resume 都新建,G1 实证 bug)。
 * - 旧版 pi 无 getBranch → 回退 getEntries() 取**最后一个**(追加序里最新)。
 * - readLastWorkspaceBinding:从父会话文件尾部反向扫,取最后追加的绑定
 *   (= 父对话当前 workspace);文件不存在 → null 静默降级。
 */
import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MARINA_WORKSPACE_CUSTOM_TYPE,
  readBranchWorkspaceId,
  readLastWorkspaceBinding,
  type BindingSessionManagerLike,
} from '../../packages/pi-marina-bridge/extensions/binding';

type Entry = { type: string; customType?: string; data?: unknown };

/** 造一个 marina-workspace custom entry。 */
function wsEntry(workspaceId: string): Entry {
  return { type: 'custom', customType: MARINA_WORKSPACE_CUSTOM_TYPE, data: { workspaceId } };
}

/** 普通消息 entry(树上的非绑定节点)。 */
function msgEntry(id: string): Entry {
  return { type: 'message', data: { id } };
}

describe('readBranchWorkspaceId — branch-aware 绑定读', () => {
  it('getBranch 返回 root→leaf 顺序:取离 leaf 最近的绑定(数组末尾向前第一个)', () => {
    // 模拟回收累积场景(G1):W-old 在分支前部(已死),W-new 在 leaf 附近。
    // getBranch 返回 [root...leaf],W-new 离 leaf 近 → 必须读到 W-new。
    const sm: BindingSessionManagerLike = {
      getEntries: () => [wsEntry('W-old'), msgEntry('m1'), wsEntry('W-new'), msgEntry('m2')],
      getBranch: () => [wsEntry('W-old'), msgEntry('m1'), wsEntry('W-new'), msgEntry('m2')],
    };
    expect(readBranchWorkspaceId(sm)).toBe('W-new');
  });

  it('分支上只有老绑定(典型 resume 回收场景)→ 读到它(Marina 判死则新建)', () => {
    const sm: BindingSessionManagerLike = {
      getEntries: () => [wsEntry('W-1'), msgEntry('m1')],
      getBranch: () => [wsEntry('W-1'), msgEntry('m1')],
    };
    expect(readBranchWorkspaceId(sm)).toBe('W-1');
  });

  it('当前分支无绑定但其他分支有 → null(位置语义:别的分支的绑定不算)', () => {
    const sm: BindingSessionManagerLike = {
      getEntries: () => [wsEntry('W-other-branch'), msgEntry('m1')],
      getBranch: () => [msgEntry('only-message')],
    };
    expect(readBranchWorkspaceId(sm)).toBeNull();
  });

  it('旧版 pi 无 getBranch → 回退 getEntries 取最后一个(最新追加),不再是 first-match', () => {
    // 同一文件多条绑定(回收→重建累积):回退路径也必须读最新的,否则旧版
    // pi 用户继续踩 G1 无限新建。
    const sm: BindingSessionManagerLike = {
      getEntries: () => [wsEntry('W-stale'), msgEntry('m1'), wsEntry('W-current')],
    };
    expect(readBranchWorkspaceId(sm)).toBe('W-current');
  });

  it('无任何绑定 entry(新对话/子会话)→ null', () => {
    const sm: BindingSessionManagerLike = {
      getEntries: () => [msgEntry('m1')],
      getBranch: () => [msgEntry('m1')],
    };
    expect(readBranchWorkspaceId(sm)).toBeNull();
  });
});

describe('readLastWorkspaceBinding — 父会话文件尾读亲缘绑定', () => {
  it('取文件里最后追加的绑定(父对话当前 workspace),跳过中间更老的', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'marina-bridge-binding-'));
    try {
      const file = join(dir, 'parent.jsonl');
      const lines = [
        JSON.stringify({ type: 'header', id: 'p1' }),
        JSON.stringify(wsEntry('W-parent-old')),
        JSON.stringify({ type: 'message', data: { text: 'long conversation'.repeat(50) } }),
        JSON.stringify(wsEntry('W-parent-current')),
        JSON.stringify({ type: 'message', data: { text: 'after binding' } }),
      ];
      await fs.writeFile(file, lines.join('\n'), 'utf8');
      await expect(readLastWorkspaceBinding(file)).resolves.toBe('W-parent-current');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('父文件无绑定 → null;文件不存在 → null(静默降级,不抛)', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'marina-bridge-binding-'));
    try {
      const noBinding = join(dir, 'no-binding.jsonl');
      await fs.writeFile(
        noBinding,
        [JSON.stringify({ type: 'header' }), JSON.stringify(msgEntry('m'))].join('\n'),
        'utf8',
      );
      await expect(readLastWorkspaceBinding(noBinding)).resolves.toBeNull();
      await expect(readLastWorkspaceBinding(join(dir, 'no-such-file.jsonl'))).resolves.toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('绑定在文件头部、文件远大于 64KB(现场回归:父 1.06MB/绑定 L4,尾窗读不到)', async () => {
    // 2026-09-03 真实 fork 现场抓的缺陷:父对话只在开始时绑过一次(entry 在头部),
    // 之后对话长到 MB 级——旧的「尾窗反扫」读不到,亲缘字段静默变 null。
    // 回归断言:头部绑定必须被读到。
    const dir = await fs.mkdtemp(join(tmpdir(), 'marina-bridge-binding-'));
    try {
      const file = join(dir, 'parent.jsonl');
      const parts = [
        JSON.stringify({ type: 'header', id: 'p1' }),
        JSON.stringify(wsEntry('W-bind-at-start')),
      ];
      // 对话主体长到远超旧尾窗:每行 ~1.2KB × 200 行 ≈ 240KB,无绑定 entry。
      for (let i = 0; i < 200; i += 1) {
        parts.push(JSON.stringify({ type: 'message', data: { text: `m${i} `.repeat(300) } }));
      }
      await fs.writeFile(file, parts.join('\n'), 'utf8');
      const size = (await fs.stat(file)).size;
      expect(size).toBeGreaterThan(128 * 1024); // 确认真的超过了旧尾窗量级
      await expect(readLastWorkspaceBinding(file)).resolves.toBe('W-bind-at-start');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
