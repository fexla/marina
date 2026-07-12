/**
 * @file session-workspace-manager.test.ts
 * @purpose 覆盖 session 临时展示工作区的创建、崩溃恢复、保留期和受管删除边界。
 *
 * @安全约束:每个 case 使用 createTempDataDir；绝不读写真实 Marina userData。
 * @对应文档章节: AGENTS.md 5.3 / 5.6、session-workspace-manager.ts 文件头。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createTempDataDir, removeTempDataDir } from './persistence';
import { SessionWorkspaceManager } from './session-workspace-manager';

const SID_1 = '11111111-1111-4111-8111-111111111111';
const SID_2 = '22222222-2222-4222-8222-222222222222';
const DAY_MS = 24 * 60 * 60 * 1000;

describe('SessionWorkspaceManager', () => {
  let dir: string;
  let now: number;
  let retentionDays: number;
  let manager: SessionWorkspaceManager;

  beforeEach(async () => {
    dir = await createTempDataDir('marina-workspace-test-');
    now = 1_700_000_000_000;
    retentionDays = 7;
    manager = new SessionWorkspaceManager({
      rootDir: join(dir, 'file-panel-workspaces'),
      getRetentionDays: () => retentionDays,
      now: () => now,
    });
    await manager.initialize();
  });

  afterEach(async () => {
    await manager.flush();
    await removeTempDataDir(dir);
  });

  it('为 UUID session 创建受管工作区并记录 active 状态', async () => {
    const workspace = await manager.create(SID_1);

    expect(workspace).toBe(join(dir, 'file-panel-workspaces', SID_1));
    await expect(fs.stat(workspace)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    expect(manager.getPathForSession(SID_1)).toBe(workspace);

    await manager.flush();
    const manifest = JSON.parse(
      await fs.readFile(join(dir, 'file-panel-workspaces', 'manifest.json'), 'utf8'),
    ) as { workspaces: Record<string, { closedAt: number | null }> };
    expect(manifest.workspaces[SID_1]).toEqual({ closedAt: null });
  });

  it('关闭后在保留期内保留，到期才删除', async () => {
    const workspace = await manager.create(SID_1);
    manager.release(SID_1);

    now += 7 * DAY_MS - 1;
    await manager.cleanupExpired();
    await expect(fs.stat(workspace)).resolves.toBeDefined();

    now += 1;
    await manager.cleanupExpired();
    await expect(fs.access(workspace)).rejects.toThrow();
    expect(manager.getPathForSession(SID_1)).toBeNull();
  });

  it('保留期设为 0 时，关闭后的显式清理立即删除', async () => {
    retentionDays = 0;
    const workspace = await manager.create(SID_1);
    manager.release(SID_1);
    await manager.cleanupExpired();

    await expect(fs.access(workspace)).rejects.toThrow();
  });

  it('启动恢复把崩溃前 active 的记录视为刚关闭，不会立即删除', async () => {
    const workspace = await manager.create(SID_1);
    await manager.flush();

    const restarted = new SessionWorkspaceManager({
      rootDir: join(dir, 'file-panel-workspaces'),
      getRetentionDays: () => retentionDays,
      now: () => now + DAY_MS,
    });
    await restarted.initialize();
    expect(restarted.getPathForSession(SID_1)).toBe(workspace);
    await restarted.flush();
  });

  it('discard 仅清理尚未启动 PTY 的指定目录，其他 session 不受影响', async () => {
    const first = await manager.create(SID_1);
    const second = await manager.create(SID_2);

    await manager.discard(SID_1);

    await expect(fs.access(first)).rejects.toThrow();
    await expect(fs.stat(second)).resolves.toBeDefined();
    expect(manager.getPathForSession(SID_2)).toBe(second);
  });

  it('拒绝非 UUID session id，避免 manifest 或调用方把删除路径导向根目录外', async () => {
    await expect(manager.create('../outside')).rejects.toThrow('Invalid session id');
    await expect(fs.access(join(dir, 'outside'))).rejects.toThrow();
  });
});
