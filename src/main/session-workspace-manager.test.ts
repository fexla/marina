/**
 * @file session-workspace-manager.test.ts
 * @purpose 覆盖 workspace 生命周期：创建、命名/绑定复用(bind)、关闭保留、到期回收、
 *   pinned 免回收、v1→v2 manifest 迁移、文件面板状态快照读写。
 *
 * v0.3.3 ADR-024：workspaceId 与 sessionId 解耦，API 改 workspaceId-keyed。
 *
 * @安全约束:每个 case 使用 createTempDataDir；绝不读写真实 Marina userData。
 * @对应文档章节: AGENTS.md 5.3 / 5.6、ADR-024、session-workspace-manager.ts 文件头。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createTempDataDir, removeTempDataDir } from './persistence';
import { SessionWorkspaceManager } from './session-workspace-manager';
import type { FilePanelSnapshotData } from './session-workspace-manager';

/** 测试用确定性 UUID 序列（注入 uuid 选项）。 */
const WS_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WS_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DAY_MS = 24 * 60 * 60 * 1000;
const PATH_SCOPE = 'C:\\proj';

describe('SessionWorkspaceManager', () => {
  let dir: string;
  let now: number;
  let retentionDays: number;
  let uuidSeq: number;
  const uuidPool = [WS_A, WS_B];
  let manager: SessionWorkspaceManager;

  beforeEach(async () => {
    dir = await createTempDataDir('marina-workspace-test-');
    now = 1_700_000_000_000;
    retentionDays = 7;
    uuidSeq = 0;
    manager = new SessionWorkspaceManager({
      rootDir: join(dir, 'file-panel-workspaces'),
      getRetentionDays: () => retentionDays,
      now: () => now,
      uuid: () => uuidPool[uuidSeq++ % uuidPool.length]!,
    });
    await manager.initialize();
  });

  afterEach(async () => {
    await manager.flush();
    await removeTempDataDir(dir);
  });

  // ── 创建 / 生命周期 ──────────────────────────────────────────────

  it('create 生成 workspaceId UUID + 受管目录，记录 active(closedAt=null)', async () => {
    const created = await manager.create();

    expect(created.workspaceId).toBe(WS_A);
    expect(created.dir).toBe(join(dir, 'file-panel-workspaces', WS_A));
    await expect(fs.stat(created.dir)).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
    expect(manager.getPathForWorkspace(WS_A)).toBe(created.dir);

    await manager.flush();
    const manifest = JSON.parse(
      await fs.readFile(join(dir, 'file-panel-workspaces', 'manifest.json'), 'utf8'),
    ) as {
      version: number;
      workspaces: Record<string, { closedAt: number | null; name: string | null; pinned: boolean }>;
    };
    expect(manifest.version).toBe(2);
    expect(manifest.workspaces[WS_A]).toEqual({
      name: null,
      createdAt: now,
      closedAt: null,
      pinned: false,
      pathScope: null,
    });
  });

  it('关闭后在保留期内保留，到期才删除', async () => {
    const created = await manager.create();
    manager.release(WS_A);

    now += 7 * DAY_MS - 1;
    await manager.cleanupExpired();
    await expect(fs.stat(created.dir)).resolves.toBeDefined();

    now += 1;
    await manager.cleanupExpired();
    await expect(fs.access(created.dir)).rejects.toThrow();
    expect(manager.getPathForWorkspace(WS_A)).toBeNull();
  });

  it('保留期设为 0 时，关闭后的显式清理立即删除', async () => {
    retentionDays = 0;
    const created = await manager.create();
    manager.release(WS_A);
    await manager.cleanupExpired();

    await expect(fs.access(created.dir)).rejects.toThrow();
  });

  it('启动恢复把崩溃前 active 的记录视为刚关闭，不会立即删除', async () => {
    const created = await manager.create();
    await manager.flush();

    const restarted = new SessionWorkspaceManager({
      rootDir: join(dir, 'file-panel-workspaces'),
      getRetentionDays: () => retentionDays,
      now: () => now + DAY_MS,
      uuid: () => uuidPool[uuidSeq++ % uuidPool.length]!,
    });
    await restarted.initialize();
    expect(restarted.getPathForWorkspace(WS_A)).toBe(created.dir);
    await restarted.flush();
  });

  it('discard 仅清理尚未启动 PTY 的指定目录，其他 workspace 不受影响', async () => {
    const first = await manager.create();
    const second = await manager.create();

    await manager.discard(WS_A);

    await expect(fs.access(first.dir)).rejects.toThrow();
    await expect(fs.stat(second.dir)).resolves.toBeDefined();
    expect(manager.getPathForWorkspace(WS_B)).toBe(second.dir);
  });

  it('拒绝非 UUID workspace id，避免 manifest 或调用方把删除路径导向根目录外', async () => {
    // create 用注入 uuid，但 getPathForWorkspace / bind 等对非法 id 的拒绝仍要测。
    // workspacePath 是 private 同步方法，非法 id 同步抛错（rejects 仅用于 await 性测试）。
    expect(() =>
      (manager as unknown as { workspacePath: (id: string) => string }).workspacePath('../outside'),
    ).toThrow('Invalid workspace id');
    await expect(fs.access(join(dir, 'outside'))).rejects.toThrow();
  });

  // ── v0.3.3 ADR-024:bind / list / new / unpin ────────────────────

  it('bind 新建路径：把当前 workspace 命名 + pinned=true + 记 pathScope', async () => {
    const created = await manager.create();
    const result = await manager.bind(WS_A, 'feature-x', PATH_SCOPE, false);

    expect(result).toEqual({ kind: 'created', workspaceId: WS_A, dir: created.dir });
    const rec = manager.getRecord(WS_A);
    expect(rec?.name).toBe('feature-x');
    expect(rec?.pinned).toBe(true);
    expect(rec?.pathScope).toBe(PATH_SCOPE);
  });

  it('bind 切换路径：name 已存在(pathScope 匹配)→ 返回该 workspace + 元数据', async () => {
    // 先建 WS_A 并命名为 'shared'
    await manager.create();
    await manager.bind(WS_A, 'shared', PATH_SCOPE, false);
    // 再建 WS_B 作为"当前 session"的新临时
    await manager.create();
    // bind 同名 'shared'（WS_A 拥有它）→ 应切换到 WS_A
    const result = await manager.bind(WS_B, 'shared', PATH_SCOPE, false);

    expect(result.kind).toBe('switched');
    if (result.kind === 'switched') {
      expect(result.workspaceId).toBe(WS_A);
      expect(result.dir).toBe(join(dir, 'file-panel-workspaces', WS_A));
      expect(result.createdAt).toBe(manager.getRecord(WS_A)?.createdAt);
      expect(result.fileCount).toBe(0);
    }
  });

  it('bind --new(name 已存在)→ 抛 NameConflict', async () => {
    await manager.create();
    await manager.bind(WS_A, 'shared', PATH_SCOPE, false);
    await manager.create();
    await expect(manager.bind(WS_B, 'shared', PATH_SCOPE, true)).rejects.toMatchObject({
      code: 'NameConflict',
    });
  });

  it('bind name 唯一性是 pathScope 内：不同 pathScope 可重名', async () => {
    await manager.create();
    await manager.bind(WS_A, 'shared', PATH_SCOPE, false);
    await manager.create();
    // 不同 pathScope 同名 → 视为新建命名（不切换到 WS_A）
    const result = await manager.bind(WS_B, 'shared', 'D:\\other', false);
    expect(result.kind).toBe('created');
    expect(result.workspaceId).toBe(WS_B);
  });

  it('bind name 校验：空 / 含分隔符 / 超长 → InvalidName', async () => {
    await manager.create();
    await expect(manager.bind(WS_A, '   ', PATH_SCOPE, false)).rejects.toMatchObject({
      code: 'InvalidName',
    });
    await expect(manager.bind(WS_A, 'a/b', PATH_SCOPE, false)).rejects.toMatchObject({
      code: 'InvalidName',
    });
    await expect(manager.bind(WS_A, 'a\\b', PATH_SCOPE, false)).rejects.toMatchObject({
      code: 'InvalidName',
    });
    await expect(manager.bind(WS_A, 'x'.repeat(65), PATH_SCOPE, false)).rejects.toMatchObject({
      code: 'InvalidName',
    });
  });

  it('bind 当前 workspaceId 不在 manifest → WorkspaceNotFound', async () => {
    await expect(manager.bind(WS_B, 'x', PATH_SCOPE, false)).rejects.toMatchObject({
      code: 'WorkspaceNotFound',
    });
  });

  it('list 返回当前 pathScope 下的命名 workspace（未命名不列），按 createdAt 倒序', async () => {
    await manager.create(); // WS_A
    now += 1000;
    await manager.bind(WS_A, 'older', PATH_SCOPE, false);
    now += 1000;
    await manager.create(); // WS_B
    await manager.bind(WS_B, 'newer', PATH_SCOPE, false);

    const items = await manager.list(PATH_SCOPE);
    expect(items.map((i) => i.name)).toEqual(['newer', 'older']);
    expect(items.every((i) => i.pinned && i.pathScope === PATH_SCOPE)).toBe(true);
  });

  it('list 不含其它 pathScope 的命名 workspace', async () => {
    await manager.create();
    await manager.bind(WS_A, 'x', PATH_SCOPE, false);
    await manager.create();
    await manager.bind(WS_B, 'y', 'D:\\other', false);

    const items = await manager.list(PATH_SCOPE);
    expect(items.map((i) => i.name)).toEqual(['x']);
  });

  it('unpin 剥 name+pinned：无人占用→closedAt=now 可回收', async () => {
    await manager.create();
    await manager.bind(WS_A, 'shared', PATH_SCOPE, false);
    await manager.unpin(WS_A, false);

    const rec = manager.getRecord(WS_A);
    expect(rec?.name).toBeNull();
    expect(rec?.pinned).toBe(false);
    expect(rec?.closedAt).toBe(now);
    expect(rec?.pathScope).toBeNull();
  });

  it('unpin 剥 name+pinned：当前 session 仍占用→closedAt 保持 null', async () => {
    await manager.create();
    await manager.bind(WS_A, 'shared', PATH_SCOPE, false);
    await manager.unpin(WS_A, true);

    const rec = manager.getRecord(WS_A);
    expect(rec?.closedAt).toBeNull();
  });

  it('pinned 的 workspace 即使 release 后 cleanupExpired 也不删（免回收）', async () => {
    await manager.create();
    await manager.bind(WS_A, 'keep', PATH_SCOPE, false);
    manager.release(WS_A); // pinned 仍 true
    now += 100 * DAY_MS; // 远超保留期
    await manager.cleanupExpired();

    // pinned 免回收，目录还在
    await expect(fs.stat(manager.getPathForWorkspace(WS_A)!)).resolves.toBeDefined();
    expect(manager.getRecord(WS_A)?.name).toBe('keep');
  });

  it('unpin 后再 release → 到期可正常回收', async () => {
    const created = await manager.create();
    await manager.bind(WS_A, 'tmp', PATH_SCOPE, false);
    await manager.unpin(WS_A, false); // closedAt=now, 不再 pinned
    now += 100 * DAY_MS;
    await manager.cleanupExpired();

    await expect(fs.access(created.dir)).rejects.toThrow();
    expect(manager.getRecord(WS_A)).toBeNull();
  });

  it('resolveByName：按 name+pathScope 查 workspaceId', async () => {
    await manager.create();
    await manager.bind(WS_A, 'shared', PATH_SCOPE, false);
    expect(manager.resolveByName('shared', PATH_SCOPE)).toBe(WS_A);
    expect(manager.resolveByName('shared', 'D:\\other')).toBeNull();
    expect(manager.resolveByName('nope', PATH_SCOPE)).toBeNull();
  });

  it('switchToNew 创建一个新空临时 workspace', async () => {
    const created = await manager.switchToNew();
    expect(created.workspaceId).toBe(WS_A);
    const rec = manager.getRecord(WS_A);
    expect(rec?.name).toBeNull();
    expect(rec?.pinned).toBe(false);
  });

  // ── v0.3.3 ADR-024:v1→v2 manifest 迁移 ──────────────────────────

  it('v1→v2 迁移：旧 sessionId 当 workspaceId，补默认字段，幂等', async () => {
    // 手写一个 v1 manifest（旧 schema：key=sessionId, record={closedAt}）。
    const OLD_SID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const v1Manifest = { version: 1, workspaces: { [OLD_SID]: { closedAt: now } } };
    await fs.mkdir(join(dir, 'file-panel-workspaces'), { recursive: true });
    await fs.writeFile(
      join(dir, 'file-panel-workspaces', 'manifest.json'),
      JSON.stringify(v1Manifest),
      'utf8',
    );

    const restarted = new SessionWorkspaceManager({
      rootDir: join(dir, 'file-panel-workspaces'),
      getRetentionDays: () => retentionDays,
      now: () => now,
      uuid: () => uuidPool[uuidSeq++ % uuidPool.length]!,
    });
    await restarted.initialize();

    // 旧 key 保留为 workspaceId，record 补默认字段。
    const rec = restarted.getRecord(OLD_SID);
    expect(rec).toEqual({
      name: null,
      createdAt: now,
      closedAt: now,
      pinned: false,
      pathScope: null,
    });
    expect(restarted.getPathForWorkspace(OLD_SID)).toBe(
      join(dir, 'file-panel-workspaces', OLD_SID),
    );

    // 落盘已是 v2。
    await restarted.flush();
    const written = JSON.parse(
      await fs.readFile(join(dir, 'file-panel-workspaces', 'manifest.json'), 'utf8'),
    ) as { version: number };
    expect(written.version).toBe(2);

    // 幂等：再启动一次不重复迁移、字段不变。
    const restarted2 = new SessionWorkspaceManager({
      rootDir: join(dir, 'file-panel-workspaces'),
      getRetentionDays: () => retentionDays,
      now: () => now,
    });
    await restarted2.initialize();
    expect(restarted2.getRecord(OLD_SID)).toEqual(rec);
    await restarted2.flush();
  });

  it('v1→v2 迁移：active(closedAt=null) 的旧记录补 createdAt=now', async () => {
    const OLD_SID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const v1Manifest = { version: 1, workspaces: { [OLD_SID]: { closedAt: null } } };
    await fs.mkdir(join(dir, 'file-panel-workspaces'), { recursive: true });
    await fs.writeFile(
      join(dir, 'file-panel-workspaces', 'manifest.json'),
      JSON.stringify(v1Manifest),
      'utf8',
    );

    const restarted = new SessionWorkspaceManager({
      rootDir: join(dir, 'file-panel-workspaces'),
      getRetentionDays: () => retentionDays,
      now: () => now,
      uuid: () => uuidPool[uuidSeq++ % uuidPool.length]!,
    });
    await restarted.initialize();

    // active 旧记录：恢复时 closedAt 标 now（崩溃恢复语义），createdAt 也取 now（v1 无此字段）。
    const rec = restarted.getRecord(OLD_SID);
    expect(rec?.closedAt).toBe(now);
    expect(rec?.createdAt).toBe(now);
    await restarted.flush();
  });

  it('损坏 manifest → 从空开始（不抛、不丢目录外文件）', async () => {
    await fs.mkdir(join(dir, 'file-panel-workspaces'), { recursive: true });
    await fs.writeFile(
      join(dir, 'file-panel-workspaces', 'manifest.json'),
      '{not valid json',
      'utf8',
    );
    const restarted = new SessionWorkspaceManager({
      rootDir: join(dir, 'file-panel-workspaces'),
      getRetentionDays: () => retentionDays,
      now: () => now,
    });
    await restarted.initialize();
    expect(restarted.getRecord(WS_A)).toBeNull();
    await restarted.flush();
  });

  // ── v0.3.3 ADR-024:文件面板状态快照 ────────────────────────────

  it('writeSnapshot/readSnapshot 往返：openedFiles/active/scroll/runs', async () => {
    await manager.create();
    const snap: FilePanelSnapshotData = {
      version: 1,
      openedFiles: [
        { path: 'review.md', kind: 'markdown', external: false },
        {
          path: 'change.diff',
          kind: 'diff',
          external: false,
          origin: {
            kind: 'git-diff',
            relativePath: '目录/中文.ts',
            repoIdentity: 'opaque-repo-id',
            sourceMissing: false,
          },
        },
        { path: 'C:\\abs\\user.md', kind: 'markdown', external: true },
      ],
      activeFilePath: 'review.md',
      scroll: { 'review.md': { scrollTop: 240, scrollLeft: 0 } },
      runs: [
        {
          key: ['k1', 'doc', 'pos', '1:42'].join(String.fromCharCode(0)),
          state: 'exited',
          output: 'hello',
          exitCode: 0,
        },
        {
          key: ['k2', 'doc', 'pos', '21:0'].join(String.fromCharCode(0)),
          state: 'running',
          output: '',
          exitCode: null,
        },
      ],
    };
    await manager.writeSnapshot(WS_A, snap);
    const read = await manager.readSnapshot(WS_A);
    expect(read).toEqual(snap);

    // 落在 __marina_state__/file-panel.json
    const file = join(dir, 'file-panel-workspaces', WS_A, '__marina_state__', 'file-panel.json');
    const onDisk = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(onDisk.version).toBe(1);
  });

  it('readSnapshot 文件缺失 → null（调用方按空状态恢复）', async () => {
    await manager.create();
    expect(await manager.readSnapshot(WS_A)).toBeNull();
  });

  it('readSnapshot 损坏 → null（不抛）', async () => {
    await manager.create();
    const file = join(dir, 'file-panel-workspaces', WS_A, '__marina_state__', 'file-panel.json');
    await fs.mkdir(join(dir, 'file-panel-workspaces', WS_A, '__marina_state__'), {
      recursive: true,
    });
    await fs.writeFile(file, '{broken', 'utf8');
    expect(await manager.readSnapshot(WS_A)).toBeNull();
  });

  // ── cloneWorkspace(pi /fork 继承,方案 20260817 裁决 1)──────────

  it('cloneWorkspace 复制受管文件 + 快照,内部路径重写指向新目录,源不动', async () => {
    const src = await manager.create(); // WS_A
    // 源里放一份受管文件(agent 产物) + 一份带内外路径的快照。
    const reportDir = join(src.dir, 'reports');
    await fs.mkdir(reportDir, { recursive: true });
    await fs.writeFile(join(reportDir, 'r.md'), '# fork me', 'utf8');
    const internalPath = join(reportDir, 'r.md');
    const externalPath = 'D:\\proj\\src\\main.ts';
    await manager.writeSnapshot(WS_A, {
      version: 1,
      openedFiles: [
        { path: internalPath, kind: 'text', external: false },
        { path: externalPath, kind: 'text', external: true },
      ],
      activeFilePath: internalPath,
      scroll: { [internalPath]: { scrollTop: 42, scrollLeft: 0 } },
      runs: [],
    });

    const cloned = await manager.cloneWorkspace(WS_A); // WS_B
    expect(cloned.workspaceId).toBe(WS_B);
    // 受管文件已复制,内容一致;
    const copied = await fs.readFile(join(cloned.dir, 'reports', 'r.md'), 'utf8');
    expect(copied).toBe('# fork me');
    // 快照:内部路径重写到新目录,外部路径不动,scroll 跟着重写。
    const snap = await manager.readSnapshot(WS_B);
    expect(snap).not.toBeNull();
    const internalClonePath = join(cloned.dir, 'reports', 'r.md');
    expect(snap!.openedFiles.map((f) => f.path)).toEqual([internalClonePath, externalPath]);
    expect(snap!.activeFilePath).toBe(internalClonePath);
    expect(snap!.scroll[internalClonePath]).toEqual({ scrollTop: 42, scrollLeft: 0 });
    expect(snap!.scroll[internalPath]).toBeUndefined();
    // 新 record active;源的快照/文件未被改动(继承是副本,不共享)。
    expect(manager.getRecord(WS_B)).toMatchObject({ closedAt: null });
    const srcSnap = await manager.readSnapshot(WS_A);
    expect(srcSnap!.openedFiles[0]!.path).toBe(internalPath);
    // 状态目录不是顶层文件复制出来的(dirty copy)而是写入新快照:无双重状态。
    const stateFiles = await fs.readdir(join(cloned.dir, '__marina_state__'));
    expect(stateFiles).toEqual(['file-panel.json']);
  });

  it('cloneWorkspace 源不存在 → 抛 WorkspaceNotFound(调用方判活后应退回 create)', async () => {
    await expect(manager.cloneWorkspace('no-such-ws')).rejects.toMatchObject({
      code: 'WorkspaceNotFound',
    });
  });

  it('cloneWorkspace 源无快照/无文件 → 空副本,不抛(全新 fork 的降级路径)', async () => {
    await manager.create();
    const cloned = await manager.cloneWorkspace(WS_A);
    expect(manager.getRecord(cloned.workspaceId)).not.toBeNull();
    await expect(manager.readSnapshot(cloned.workspaceId)).resolves.toBeNull();
  });
});
