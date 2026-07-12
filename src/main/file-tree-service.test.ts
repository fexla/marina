/**
 * @file src/main/file-tree-service.test.ts
 * @purpose 验证 ADR-016 FileTreeService 的双根授权、owner 隔离、路径越界防护及
 *   与既有 FilePanelService 的可信打开衔接。所有文件系统操作均在临时目录。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilePanelService } from './file-panel-service';
import { FileTreeService } from './file-tree-service';

interface SessionEntry {
  pathId: string;
  currentCwd: string;
  ownerWindowId: string | null;
}

describe('FileTreeService', () => {
  let baseDir: string;
  let cwdDir: string;
  let workspaceDir: string;
  let externalDir: string;
  let sessions: Record<string, SessionEntry>;
  let filePanelService: FilePanelService;
  let service: FileTreeService;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'marina-file-tree-'));
    cwdDir = join(baseDir, 'cwd');
    workspaceDir = join(baseDir, 'workspace');
    externalDir = join(baseDir, 'external');
    await Promise.all([mkdir(cwdDir), mkdir(workspaceDir), mkdir(externalDir)]);
    sessions = {
      s1: { pathId: cwdDir, currentCwd: cwdDir, ownerWindowId: 'owner-1' },
    };
    filePanelService = new FilePanelService();
    filePanelService.attachSessionLookup({ get: (sessionId) => sessions[sessionId] ?? null });
    service = new FileTreeService(
      { get: (sessionId) => sessions[sessionId] ?? null },
      { getPathForSession: (sessionId) => (sessionId === 's1' ? workspaceDir : null) },
      filePanelService,
    );
  });

  afterEach(async () => {
    await filePanelService.stop();
    await rm(baseDir, { recursive: true, force: true });
  });

  it('声明 currentCwd 与 managed workspace 两个可用的 session 局部根', async () => {
    await expect(service.getRoots('s1', 'owner-1')).resolves.toEqual([
      { id: 'session-cwd', label: '当前目录', available: true },
      { id: 'managed-workspace', label: '临时工作区', available: true },
    ]);
  });

  it('只列直接子项，目录排在文件前，并返回相对根路径', async () => {
    await mkdir(join(cwdDir, 'z-dir'));
    await writeFile(join(cwdDir, 'a.txt'), 'a');
    await writeFile(join(cwdDir, 'b.md'), '# b');

    const snapshot = await service.listDirectory('s1', 'owner-1', 'session-cwd');

    expect(snapshot.relativePath).toBe('');
    expect(snapshot.entries.map((entry) => [entry.kind, entry.relativePath])).toEqual([
      ['directory', 'z-dir'],
      ['file', 'a.txt'],
      ['file', 'b.md'],
    ]);
    expect(snapshot.truncated).toBe(false);
  });

  it('传统 SSH session 即使 cwd 字符串恰好对应本机目录也一律不暴露文件导航', async () => {
    sessions.ssh = {
      pathId: 'ssh:profile-1:%2Fremote%2Frepo',
      currentCwd: cwdDir,
      ownerWindowId: 'owner-1',
    };

    await expect(service.getRoots('ssh', 'owner-1')).resolves.toEqual([
      expect.objectContaining({ id: 'session-cwd', available: false }),
      expect.objectContaining({ id: 'managed-workspace', available: false }),
    ]);
    await expect(service.listDirectory('ssh', 'owner-1', 'session-cwd')).rejects.toMatchObject({
      code: 'RootUnavailable',
    });
  });

  it('拒绝非 owner client、绝对路径与 .. 路径', async () => {
    await expect(service.getRoots('s1', 'another-window')).rejects.toMatchObject({
      code: 'NotOwner',
    });
    await expect(
      service.listDirectory('s1', 'owner-1', 'session-cwd', cwdDir),
    ).rejects.toMatchObject({
      code: 'InvalidPath',
    });
    await expect(
      service.listDirectory('s1', 'owner-1', 'session-cwd', '../external'),
    ).rejects.toMatchObject({
      code: 'OutsideAllowedRoot',
    });
    await expect(
      service.openFile('s1', 'owner-1', 'session-cwd', '../external/anything.txt'),
    ).rejects.toMatchObject({
      code: 'OutsideAllowedRoot',
    });
    expect(filePanelService.getOpenFiles('s1').files).toHaveLength(0);
  });

  it('只允许树内已 canonicalize 的文件送进既有 FilePanelService', async () => {
    await writeFile(join(workspaceDir, 'generated.md'), '# generated');

    const snapshot = await service.openFile('s1', 'owner-1', 'managed-workspace', 'generated.md');

    // FileTreeService 故意把 canonical realpath 交给 FilePanel；Windows 可能把
    // 8.3 临时目录路径展开为长路径，不能用 join(workspaceDir, ...) 做字面比较。
    expect(snapshot.activePath).toBe(await realpath(join(workspaceDir, 'generated.md')));
    expect(snapshot.files).toHaveLength(1);
    expect(snapshot.files[0]?.name).toBe('generated.md');
  });

  it('隐藏指向允许根外部的 symlink/junction，避免通过树泄露或打开外部文件', async () => {
    await writeFile(join(externalDir, 'secret.txt'), 'not visible');
    const escapedLink = join(cwdDir, 'escaped-link');
    try {
      // Windows 用 junction 不要求管理员的 symlink privilege；POSIX 的 dir symlink
      // 在同一 API 下可用。CI 若策略明确禁链接，则跳过该环境特有断言。
      await symlink(externalDir, escapedLink, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
      throw err;
    }

    const snapshot = await service.listDirectory('s1', 'owner-1', 'session-cwd');
    expect(snapshot.entries.some((entry) => entry.name === 'escaped-link')).toBe(false);
    await expect(
      service.listDirectory('s1', 'owner-1', 'session-cwd', 'escaped-link'),
    ).rejects.toMatchObject({ code: 'OutsideAllowedRoot' });
    // list 与 open 是两条独立的 IPC 入口；必须同时证明不能直接绕过未显示的
    // escaped link 打开根外文件，更不能把它送进 FilePanelService。
    await expect(
      service.openFile('s1', 'owner-1', 'session-cwd', 'escaped-link/secret.txt'),
    ).rejects.toMatchObject({ code: 'OutsideAllowedRoot' });
    expect(filePanelService.getOpenFiles('s1').files).toHaveLength(0);
  });
});
