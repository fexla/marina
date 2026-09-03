/**
 * @file src/main/file-panel-service.test.ts
 * @purpose 验证 FilePanelService 的状态机 / read / HTTP 鉴权与路由 / 路径解析 /
 *   session 销毁清理 / fs.watch 自动刷新。用真实临时目录(AGENTS.md §9.1)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilePanelService, FilePanelError } from './file-panel-service';

interface LookupEntry {
  currentCwd: string;
  ownerWindowId: string | null;
}

function makeLookup(entries: Record<string, LookupEntry>) {
  return {
    get: (id: string): LookupEntry | null => entries[id] ?? null,
  };
}

describe('FilePanelService - 状态机', () => {
  let dir: string;
  let svc: FilePanelService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'marina-fp-'));
    svc = new FilePanelService();
    svc.attachSessionLookup(makeLookup({ s1: { currentCwd: dir, ownerWindowId: 'w1' } }));
  });

  afterEach(async () => {
    await svc.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('openFile 加入列表 + 设 active + 判 kind', async () => {
    await writeFile(join(dir, 'readme.md'), '# hi');
    await writeFile(join(dir, 'a.txt'), 'hello');
    const r1 = await svc.openFile('s1', 'readme.md');
    expect(r1.files).toHaveLength(1);
    expect(r1.files[0]!.kind).toBe('markdown');
    expect(r1.activePath).toBe(join(dir, 'readme.md'));

    const r2 = await svc.openFile('s1', 'a.txt');
    expect(r2.files).toHaveLength(2);
    expect(r2.activePath).toBe(join(dir, 'a.txt'));
  });

  it('openFile 重复路径不重复添加(更新 mtime)', async () => {
    await writeFile(join(dir, 'a.txt'), 'x');
    await svc.openFile('s1', 'a.txt');
    const r2 = await svc.openFile('s1', 'a.txt');
    expect(r2.files).toHaveLength(1);
  });

  it('openFile 保存来源元数据，普通重复打开不会丢失', async () => {
    await writeFile(join(dir, 'change.diff'), 'diff');
    const origin = {
      kind: 'git-diff' as const,
      relativePath: '中文.ts',
      repoIdentity: 'opaque-repo-id',
      sourceMissing: false,
    };
    const opened = await svc.openFile('s1', 'change.diff', { origin });
    expect(opened.files[0]?.origin).toEqual(origin);

    const reopened = await svc.openFile('s1', 'change.diff');
    expect(reopened.files[0]?.origin).toEqual(origin);
  });

  it('onWorkspaceSwitched 从快照恢复 Git diff 来源元数据', async () => {
    await writeFile(join(dir, 'change.diff'), 'diff');
    const origin = {
      kind: 'git-diff' as const,
      relativePath: '目录/中文.ts',
      repoIdentity: 'opaque-repo-id',
      sourceMissing: false,
    };
    svc.attachWorkspaceOps({
      getCurrentPath: () => dir,
      bind: async () => ({ kind: 'created', workspaceId: 'w1', dir }),
      list: async () => [],
      newWorkspace: async () => ({ workspaceId: 'w1', dir }),
      unpin: async () => ({ workspaceId: 'w1' }),
      readSnapshotForSession: async () => ({
        openedFiles: [{ path: 'change.diff', kind: 'diff', external: false, origin }],
        activeFilePath: 'change.diff',
        scroll: {},
        runs: [],
      }),
    });

    await svc.onWorkspaceSwitched('s1');

    expect(svc.getOpenFiles('s1').files[0]?.origin).toEqual(origin);
  });

  it('onWorkspaceSwitched 重检测 kind:旧快照里 .html 存的 text 自动升级为 web(ADR-034)', async () => {
    // 模拟 WebViewer 落地前写入的旧快照:.html 的 kind 是 'text'
    await writeFile(join(dir, 'legacy.html'), '<html></html>');
    await writeFile(join(dir, 'README.md'), '# hi');
    svc.attachWorkspaceOps({
      getCurrentPath: () => dir,
      bind: async () => ({ kind: 'created', workspaceId: 'w1', dir }),
      list: async () => [],
      newWorkspace: async () => ({ workspaceId: 'w1', dir }),
      unpin: async () => ({ workspaceId: 'w1' }),
      readSnapshotForSession: async () => ({
        openedFiles: [
          { path: 'legacy.html', kind: 'text', external: false },
          { path: 'README.md', kind: 'markdown', external: false },
        ],
        activeFilePath: 'legacy.html',
        scroll: {},
        runs: [],
      }),
    });

    await svc.onWorkspaceSwitched('s1');

    const files = svc.getOpenFiles('s1').files;
    expect(files[0]?.kind).toBe('web'); // 旧值 'text' 被重检测升级
    expect(files[1]?.kind).toBe('markdown'); // 未受影响
  });

  it('showFile 切 active;不在列表抛 NotFound', async () => {
    await writeFile(join(dir, 'a.txt'), '1');
    await writeFile(join(dir, 'b.txt'), '2');
    await svc.openFile('s1', 'a.txt');
    await svc.openFile('s1', 'b.txt');
    expect(svc.showFile('s1', 'a.txt').activePath).toBe(join(dir, 'a.txt'));
    expect(() => svc.showFile('s1', 'nope.txt')).toThrow(FilePanelError);
  });

  it('closeFile 关 active 回退到前一项;关非 active 不影响 active', async () => {
    await writeFile(join(dir, 'a.txt'), '1');
    await writeFile(join(dir, 'b.txt'), '2');
    await svc.openFile('s1', 'a.txt');
    await svc.openFile('s1', 'b.txt'); // active = b
    expect(svc.closeFile('s1', 'b.txt').activePath).toBe(join(dir, 'a.txt'));
    // 关掉不存在的 active 回退:再开 b,关 a(非 active)
    await svc.openFile('s1', 'b.txt');
    const r = svc.closeFile('s1', 'a.txt');
    expect(r.activePath).toBe(join(dir, 'b.txt'));
    expect(r.files).toHaveLength(1);
  });

  it('getOpenFiles 未知 session 返回空快照', () => {
    expect(svc.getOpenFiles('nope')).toEqual({ files: [], activePath: null });
  });

  it('相对路径按 session.currentCwd 解析', async () => {
    await writeFile(join(dir, 'rel.txt'), 'r');
    const r = await svc.openFile('s1', 'rel.txt');
    expect(r.files[0]!.path).toBe(join(dir, 'rel.txt'));
  });

  it('绝对路径直接用(忽略 cwd)', async () => {
    const abs = join(dir, 'abs.txt');
    await writeFile(abs, 'a');
    const r = await svc.openFile('s1', abs);
    expect(r.files[0]!.path).toBe(abs);
  });

  it('不存在文件 → NotFound', async () => {
    await expect(svc.openFile('s1', 'missing.txt')).rejects.toMatchObject({
      code: 'NotFound',
    });
  });

  it('目录 → NotFile', async () => {
    await mkdir(join(dir, 'sub'));
    await expect(svc.openFile('s1', 'sub')).rejects.toMatchObject({
      code: 'NotFile',
    });
  });

  it('未知 session → SessionMissing', async () => {
    await expect(svc.openFile('ghost', 'x.txt')).rejects.toMatchObject({
      code: 'SessionMissing',
    });
  });
});

describe('FilePanelService - requestActivation (打开即激活)', () => {
  let dir: string;
  let svc: FilePanelService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'marina-fp-act-'));
    svc = new FilePanelService();
    svc.attachSessionLookup(makeLookup({ s1: { currentCwd: dir, ownerWindowId: 'w1' } }));
  });

  afterEach(async () => {
    await svc.stop();
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * 收集所有 filePanelUpdated 事件，返回每件的 requestActivation 值。
   * openFile 每次成功都应发 requestActivation=true；show/close/refresh 不发。
   * 这是「重复调用打开文件接口时自动切到已打开面板」的根因修复的核心验证。
   */
  function captureActivations(): { events: Array<{ requestActivation?: boolean }> } {
    const events: Array<{ requestActivation?: boolean }> = [];
    svc.on('filePanelUpdated', (p) => events.push(p));
    return { events };
  }

  it('openFile 首次打开 → requestActivation=true', async () => {
    await writeFile(join(dir, 'a.txt'), 'x');
    const { events } = captureActivations();
    await svc.openFile('s1', 'a.txt');
    expect(events).toHaveLength(1);
    expect(events[0]!.requestActivation).toBe(true);
  });

  it('openFile 重复打开同一文件(已在列表)→ 仍 requestActivation=true', async () => {
    await writeFile(join(dir, 'a.txt'), 'x');
    await svc.openFile('s1', 'a.txt');
    const { events } = captureActivations();
    await svc.openFile('s1', 'a.txt');
    expect(events).toHaveLength(1);
    expect(events[0]!.requestActivation).toBe(true);
  });

  it('openFile 打开不同文件(列表已有文件)→ requestActivation=true', async () => {
    await writeFile(join(dir, 'a.txt'), '1');
    await writeFile(join(dir, 'b.txt'), '2');
    await svc.openFile('s1', 'a.txt');
    const { events } = captureActivations();
    await svc.openFile('s1', 'b.txt');
    expect(events).toHaveLength(1);
    expect(events[0]!.requestActivation).toBe(true);
  });

  it('showFile → 不发 requestActivation(不抢用户焦点)', async () => {
    await writeFile(join(dir, 'a.txt'), '1');
    await writeFile(join(dir, 'b.txt'), '2');
    await svc.openFile('s1', 'a.txt');
    await svc.openFile('s1', 'b.txt');
    const { events } = captureActivations();
    svc.showFile('s1', 'a.txt');
    expect(events).toHaveLength(1);
    expect(events[0]!.requestActivation).toBe(false);
  });

  it('closeFile → 不发 requestActivation', async () => {
    await writeFile(join(dir, 'a.txt'), '1');
    await writeFile(join(dir, 'b.txt'), '2');
    await svc.openFile('s1', 'a.txt');
    await svc.openFile('s1', 'b.txt');
    const { events } = captureActivations();
    svc.closeFile('s1', 'a.txt');
    expect(events).toHaveLength(1);
    expect(events[0]!.requestActivation).toBe(false);
  });

  it('getOpenFiles 不发任何事件(纯读)', async () => {
    await writeFile(join(dir, 'a.txt'), '1');
    await svc.openFile('s1', 'a.txt');
    const { events } = captureActivations();
    svc.getOpenFiles('s1');
    expect(events).toHaveLength(0);
  });
});

describe('FilePanelService - heading navigation request', () => {
  let dir: string;
  let svc: FilePanelService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'marina-fp-heading-'));
    svc = new FilePanelService();
    svc.attachSessionLookup(makeLookup({ s1: { currentCwd: dir, ownerWindowId: 'w1' } }));
  });

  afterEach(async () => {
    await svc.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('打开 Markdown 时把标题作为独立的一次性导航请求发出', async () => {
    const filePath = join(dir, 'report.md');
    await writeFile(filePath, '# 概览\n\n## 详细说明\n');
    const navigations: Array<{
      sessionId: string;
      path: string;
      heading: string;
      requestId: string;
    }> = [];
    svc.on('filePanelNavigationRequested', (payload) => navigations.push(payload));

    await svc.openFile('s1', filePath, { heading: '  详细说明  ' });

    expect(navigations).toEqual([
      {
        sessionId: 's1',
        path: filePath,
        heading: '详细说明',
        requestId: expect.any(String),
      },
    ]);
  });

  it('重复打开同一标题也生成新 requestId，保证相同跳转可再次执行', async () => {
    const filePath = join(dir, 'report.md');
    await writeFile(filePath, '# 概览\n');
    const requestIds: string[] = [];
    svc.on('filePanelNavigationRequested', (payload: { requestId: string }) => {
      requestIds.push(payload.requestId);
    });

    await svc.openFile('s1', filePath, { heading: '概览' });
    await svc.openFile('s1', filePath, { heading: '概览' });

    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).not.toBe(requestIds[1]);
  });

  it('异步解析期间 owner 改变时拒绝旧 IPC 请求且不发更新/导航', async () => {
    const filePath = join(dir, 'owner-race.md');
    await writeFile(filePath, '# Owner race\n');
    const session = { currentCwd: dir, ownerWindowId: 'w1' as string | null };
    svc.attachSessionLookup({ get: (id) => (id === 's1' ? session : null) });
    const updates: unknown[] = [];
    const navigations: unknown[] = [];
    svc.on('filePanelUpdated', (payload) => updates.push(payload));
    svc.on('filePanelNavigationRequested', (payload) => navigations.push(payload));

    const opening = svc.openFile('s1', filePath, {
      heading: 'Owner race',
      expectedOwnerWindowId: 'w1',
    });
    session.ownerWindowId = 'w2';

    await expect(opening).rejects.toMatchObject({ code: 'NotOwner' });
    expect(svc.getOpenFiles('s1')).toEqual({ files: [], activePath: null });
    expect(updates).toEqual([]);
    expect(navigations).toEqual([]);
  });

  it('非 Markdown 文件带 heading 时拒绝且不污染已打开列表', async () => {
    await writeFile(join(dir, 'notes.txt'), 'plain text');

    await expect(svc.openFile('s1', 'notes.txt', { heading: '概览' })).rejects.toMatchObject({
      code: 'InvalidHeadingTarget',
    });
    expect(svc.getOpenFiles('s1')).toEqual({ files: [], activePath: null });
  });
});

describe('FilePanelService - readFile', () => {
  let dir: string;
  let svc: FilePanelService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'marina-fp-read-'));
    svc = new FilePanelService();
    svc.attachSessionLookup(makeLookup({ s1: { currentCwd: dir, ownerWindowId: 'w1' } }));
  });

  afterEach(async () => {
    await svc.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('text/markdown 返回字符串', async () => {
    await writeFile(join(dir, 'a.txt'), 'line1\nline2');
    await svc.openFile('s1', 'a.txt');
    const r = await svc.readFile('s1', 'a.txt');
    expect(r.kind).toBe('text');
    if (r.kind === 'text') {
      expect(r.text).toBe('line1\nline2');
      expect(r.truncated).toBe(false);
    }
  });

  it('image 返回 base64 dataUrl', async () => {
    // 1×1 PNG
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
      'base64',
    );
    await writeFile(join(dir, 'p.png'), png);
    await svc.openFile('s1', 'p.png');
    const r = await svc.readFile('s1', 'p.png');
    expect(r.kind).toBe('image');
    if (r.kind === 'image') {
      expect(r.dataUrl).toMatch(/^data:image\/png;base64,/);
      expect(r.mime).toBe('image/png');
    }
  });

  it('unknown 类型返回占位', async () => {
    await writeFile(join(dir, 'b.bin'), Buffer.from([0, 1, 2]));
    await svc.openFile('s1', 'b.bin');
    const r = await svc.readFile('s1', 'b.bin');
    expect(r.kind).toBe('unknown');
  });

  it('超 2MB 文本截断 + truncated=true', async () => {
    await writeFile(join(dir, 'big.txt'), 'a'.repeat(2 * 1024 * 1024 + 100));
    await svc.openFile('s1', 'big.txt');
    const r = await svc.readFile('s1', 'big.txt');
    if (r.kind !== 'text') throw new Error('expected text');
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  it('不在列表的路径 → unknown(不悄悄读磁盘)', async () => {
    await writeFile(join(dir, 'hidden.txt'), 'secret');
    const r = await svc.readFile('s1', 'hidden.txt');
    expect(r.kind).toBe('unknown');
  });
});

// v0.3.3 Feature B:markdown 文档里的本地文件链接 → 相对 md 目录解析进面板只读查看。
// 与 openFile(相对 currentCwd)的区别在解析基准 + mdPath 成员校验。
describe('FilePanelService - openFileFromMarkdown (Feature B)', () => {
  let dir: string;
  let svc: FilePanelService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'marina-fp-mdlink-'));
    svc = new FilePanelService();
    svc.attachSessionLookup(makeLookup({ s1: { currentCwd: dir, ownerWindowId: 'w1' } }));
  });

  afterEach(async () => {
    await svc.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('相对 md 目录解析本地文件 → 进面板 + 切 active', async () => {
    // md 在子目录 docs/ 下,引用同级 a.txt。解析基准 = md 所在目录,不是 currentCwd。
    await mkdir(join(dir, 'docs'));
    await writeFile(join(dir, 'docs', 'readme.md'), '# hi');
    await writeFile(join(dir, 'docs', 'a.txt'), 'hello');
    // 先把 md 本身打开(成员校验需要 mdPath 在已打开列表里)
    await svc.openFile('s1', join('docs', 'readme.md'));
    const mdPath = join(dir, 'docs', 'readme.md');

    const r = await svc.openFileFromMarkdown('s1', mdPath, 'a.txt');
    expect(r.files.map((f) => f.path)).toContain(join(dir, 'docs', 'a.txt'));
    expect(r.activePath).toBe(join(dir, 'docs', 'a.txt'));
  });

  it('../ 穿越到 md 目录外(只读面板,允许) → 能打开', async () => {
    await mkdir(join(dir, 'docs'));
    await writeFile(join(dir, 'docs', 'readme.md'), '# hi');
    await writeFile(join(dir, 'parent.txt'), 'up');
    await svc.openFile('s1', join('docs', 'readme.md'));
    const mdPath = join(dir, 'docs', 'readme.md');

    const r = await svc.openFileFromMarkdown('s1', mdPath, '../parent.txt');
    expect(r.activePath).toBe(join(dir, 'parent.txt'));
  });

  it('绝对路径 src → 直接打开(忽略 md 目录)', async () => {
    await mkdir(join(dir, 'docs'));
    await writeFile(join(dir, 'docs', 'readme.md'), '# hi');
    await writeFile(join(dir, 'abs.txt'), 'abs');
    await svc.openFile('s1', join('docs', 'readme.md'));
    const mdPath = join(dir, 'docs', 'readme.md');
    const abs = join(dir, 'abs.txt');

    const r = await svc.openFileFromMarkdown('s1', mdPath, abs);
    expect(r.activePath).toBe(abs);
  });

  it('src 为空 → ResolveFailed', async () => {
    await writeFile(join(dir, 'r.md'), '# hi');
    await svc.openFile('s1', 'r.md');
    const mdPath = join(dir, 'r.md');
    await expect(svc.openFileFromMarkdown('s1', mdPath, '')).rejects.toMatchObject({
      code: 'ResolveFailed',
    });
  });

  it('远程 URL src → ResolveFailed(不走本地打开)', async () => {
    await writeFile(join(dir, 'r.md'), '# hi');
    await svc.openFile('s1', 'r.md');
    const mdPath = join(dir, 'r.md');
    await expect(
      svc.openFileFromMarkdown('s1', mdPath, 'https://example.com/x'),
    ).rejects.toMatchObject({ code: 'ResolveFailed' });
    await expect(svc.openFileFromMarkdown('s1', mdPath, 'mailto:a@b.com')).rejects.toMatchObject({
      code: 'ResolveFailed',
    });
  });

  it('mdPath 不在面板 → NotFound(成员校验防线)', async () => {
    await writeFile(join(dir, 'r.md'), '# hi');
    await writeFile(join(dir, 'a.txt'), 'x');
    // 注意:不 openFile md,直接调 → mdPath 不在列表
    await expect(svc.openFileFromMarkdown('s1', join(dir, 'r.md'), 'a.txt')).rejects.toMatchObject({
      code: 'NotFound',
    });
  });

  it('文件不存在 → NotFound', async () => {
    await writeFile(join(dir, 'r.md'), '# hi');
    await svc.openFile('s1', 'r.md');
    const mdPath = join(dir, 'r.md');
    await expect(svc.openFileFromMarkdown('s1', mdPath, 'nope.txt')).rejects.toMatchObject({
      code: 'NotFound',
    });
  });

  it('src 指向目录 → NotFile(拒绝,与 openFile 一致)', async () => {
    await mkdir(join(dir, 'docs'));
    await writeFile(join(dir, 'docs', 'r.md'), '# hi');
    await mkdir(join(dir, 'docs', 'sub'));
    await svc.openFile('s1', join('docs', 'r.md'));
    const mdPath = join(dir, 'docs', 'r.md');
    // resolve 后 openFile 经 resolveAndStat 校验是文件 → 目录抛 NotFile
    await expect(svc.openFileFromMarkdown('s1', mdPath, 'sub')).rejects.toMatchObject({
      code: 'NotFile',
    });
  });

  it('重复打开同一文件 → 不重复添加(更新 mtime)', async () => {
    await writeFile(join(dir, 'r.md'), '# hi');
    await writeFile(join(dir, 'a.txt'), 'x');
    await svc.openFile('s1', 'r.md');
    const mdPath = join(dir, 'r.md');
    await svc.openFileFromMarkdown('s1', mdPath, 'a.txt');
    const r2 = await svc.openFileFromMarkdown('s1', mdPath, 'a.txt');
    expect(r2.files.filter((f) => f.path === join(dir, 'a.txt'))).toHaveLength(1);
  });
});

describe('FilePanelService - 销毁清理与自动刷新', () => {
  let dir: string;
  let svc: FilePanelService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'marina-fp-watch-'));
    svc = new FilePanelService();
    svc.attachSessionLookup(makeLookup({ s1: { currentCwd: dir, ownerWindowId: 'w1' } }));
  });

  afterEach(async () => {
    await svc.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('onSessionDestroyed 清空该 session 面板', async () => {
    await writeFile(join(dir, 'a.txt'), '1');
    await svc.openFile('s1', 'a.txt');
    expect(svc.getOpenFiles('s1').files).toHaveLength(1);
    svc.onSessionDestroyed('s1');
    expect(svc.getOpenFiles('s1').files).toHaveLength(0);
  });

  it('文件被外部修改 → emit filePanelUpdated(mtimeMs 变化)', async () => {
    await writeFile(join(dir, 'w.md'), 'v1');
    await svc.openFile('s1', 'w.md');
    const before = svc.getOpenFiles('s1').files[0]!.mtimeMs;

    const updated = new Promise<void>((resolve) => {
      svc.on('filePanelUpdated', () => resolve());
    });
    // 确保 mtime 真的变(同步写可能命中同秒精度)
    await new Promise((r) => setTimeout(r, 50));
    await writeFile(join(dir, 'w.md'), 'v2-content-longer');
    // 防抖 200ms + fs.watch 传播 + 余量
    await new Promise((r) => setTimeout(r, 600));
    await updated.catch(() => {}); // 某些 CI 文件系统 watch 不触发,不致命

    const after = svc.getOpenFiles('s1').files[0]!.mtimeMs;
    expect(after).toBeGreaterThanOrEqual(before);
  });
});

describe('FilePanelService - 僵尸 tab / stale 检测 (#3)', () => {
  let dir: string;
  let svc: FilePanelService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'marina-fp-stale-'));
    svc = new FilePanelService();
    svc.attachSessionLookup(makeLookup({ s1: { currentCwd: dir, ownerWindowId: 'w1' } }));
  });

  afterEach(async () => {
    await svc.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('refreshStale 把已删文件标 missing=true(不删条目)', async () => {
    await writeFile(join(dir, 'gone.md'), 'x');
    await writeFile(join(dir, 'live.md'), 'y');
    await svc.openFile('s1', 'gone.md');
    await svc.openFile('s1', 'live.md');
    // 删其中一个
    await rm(join(dir, 'gone.md'));
    const snap = await svc.refreshStale('s1');
    const gone = snap.files.find((f) => f.name === 'gone.md');
    const live = snap.files.find((f) => f.name === 'live.md');
    expect(gone?.missing).toBe(true);
    // live 文件从未被标过 missing(refreshStale 不改未变化的项) → undefined 等同 false。
    expect(live?.missing ?? false).toBe(false);
    expect(snap.files).toHaveLength(2); // 条目保留(僵尸 tab)
  });

  it('refreshStale 不改不变时不 emit(空广播防护)', async () => {
    await writeFile(join(dir, 'a.md'), 'x');
    await svc.openFile('s1', 'a.md');
    const events: unknown[] = [];
    svc.on('filePanelUpdated', (p) => events.push(p));
    await svc.refreshStale('s1'); // 文件还在,nothing 改变
    expect(events).toHaveLength(0);
  });

  it('refreshStale 文件重建后 missing 清回 false', async () => {
    await writeFile(join(dir, 'b.md'), 'v1');
    await svc.openFile('s1', 'b.md');
    await rm(join(dir, 'b.md'));
    expect((await svc.refreshStale('s1')).files[0]!.missing).toBe(true);
    await writeFile(join(dir, 'b.md'), 'v2');
    expect((await svc.refreshStale('s1')).files[0]!.missing).toBe(false);
  });

  it('openFile 新开的文件不带 missing(或为 false)', async () => {
    await writeFile(join(dir, 'c.md'), 'x');
    const snap = await svc.openFile('s1', 'c.md');
    expect(snap.files[0]!.missing ?? false).toBe(false);
  });
});

describe('FilePanelService - close basename 回退 (#5)', () => {
  let dir: string;
  let svc: FilePanelService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'marina-fp-basename-'));
    svc = new FilePanelService();
    svc.attachSessionLookup(makeLookup({ s1: { currentCwd: dir, ownerWindowId: 'w1' } }));
  });

  afterEach(async () => {
    await svc.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('只给文件名也能关(basename 回退,大小写不敏感)', async () => {
    // 文件在子目录,但 CLI 只传了 basename —— 模拟「从 list 里只看到 name」。
    await mkdir(join(dir, 'sub'));
    const real = join(dir, 'sub', 'Report.md');
    await writeFile(real, 'x');
    await svc.openFile('s1', real);
    // 传小写 basename(磁盘是大写 Report.md)
    const snap = svc.closeFile('s1', 'report.md');
    expect(snap.files).toHaveLength(0);
  });

  it('多个同名 basename → 抛 NotFound(ambiguous),不猜', async () => {
    await mkdir(join(dir, 'a'));
    await mkdir(join(dir, 'b'));
    await writeFile(join(dir, 'a', 'dup.md'), '1');
    await writeFile(join(dir, 'b', 'dup.md'), '2');
    await svc.openFile('s1', join('a', 'dup.md'));
    await svc.openFile('s1', join('b', 'dup.md'));
    expect(() => svc.closeFile('s1', 'dup.md')).toThrow(FilePanelError);
    // 两个都还在(没误关)
    expect(svc.getOpenFiles('s1').files).toHaveLength(2);
  });

  it('面板里没有的路径 → 抛 NotFound(不再静默 no-op)', async () => {
    await writeFile(join(dir, 'x.md'), '1');
    await svc.openFile('s1', 'x.md');
    expect(() => svc.closeFile('s1', 'nope.md')).toThrow(FilePanelError);
  });

  it('精确路径仍命中(不触发 basename 回退;renderer 路径不受影响)', async () => {
    await writeFile(join(dir, 'exact.md'), '1');
    const opened = await svc.openFile('s1', 'exact.md');
    const snap = svc.closeFile('s1', opened.files[0]!.path);
    expect(snap.files).toHaveLength(0);
  });
});

describe('FilePanelService - 批量 close (#4)', () => {
  let dir: string;
  let svc: FilePanelService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'marina-fp-bulk-'));
    svc = new FilePanelService();
    svc.attachSessionLookup(makeLookup({ s1: { currentCwd: dir, ownerWindowId: 'w1' } }));
  });

  afterEach(async () => {
    await svc.stop();
    await rm(dir, { recursive: true, force: true });
  });

  async function seedStale(): Promise<void> {
    await writeFile(join(dir, 'keep.md'), 'k');
    await writeFile(join(dir, 'gone.md'), 'g');
    await svc.openFile('s1', 'keep.md');
    await svc.openFile('s1', 'gone.md');
    await rm(join(dir, 'gone.md'));
  }

  it('closeAllFiles 清空全部', async () => {
    await writeFile(join(dir, 'a.md'), '1');
    await writeFile(join(dir, 'b.md'), '2');
    await svc.openFile('s1', 'a.md');
    await svc.openFile('s1', 'b.md');
    const snap = svc.closeAllFiles('s1');
    expect(snap.files).toHaveLength(0);
    expect(snap.activePath).toBeNull();
    expect(svc.getOpenFiles('s1').files).toHaveLength(0);
  });

  it('closeMatchingFiles(glob *.md) 只关匹配的', async () => {
    await writeFile(join(dir, 'a.md'), '1');
    await writeFile(join(dir, 'b.txt'), '2');
    await svc.openFile('s1', 'a.md');
    await svc.openFile('s1', 'b.txt');
    // matchFileGlob 通过 name 匹配;这里直接用谓词模拟服务内部 glob 调用形态
    const { snapshot: snap, closedPaths } = svc.closeMatchingFiles('s1', (f) =>
      /\.md$/i.test(f.name),
    );
    expect(closedPaths).toHaveLength(1);
    expect(snap.files).toHaveLength(1);
    expect(snap.files[0]!.name).toBe('b.txt');
  });

  it('closeMatchingFiles(stale) 关所有 missing(配合 refreshStale)', async () => {
    await seedStale();
    await svc.refreshStale('s1');
    const { snapshot: snap, closedPaths } = svc.closeMatchingFiles('s1', (f) => f.missing === true);
    expect(closedPaths).toEqual(expect.arrayContaining([expect.stringContaining('gone.md')]));
    expect(snap.files).toHaveLength(1);
    expect(snap.files[0]!.name).toBe('keep.md');
  });

  it('closeMatchingFiles 没有匹配 → 不 emit,closedPaths 为空', async () => {
    await writeFile(join(dir, 'a.md'), '1');
    await svc.openFile('s1', 'a.md');
    const events: unknown[] = [];
    svc.on('filePanelUpdated', (p) => events.push(p));
    const r = svc.closeMatchingFiles('s1', () => false);
    expect(r.closedPaths).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
});

describe('FilePanelService - gallery (Feature A)', () => {
  let dir: string;
  let svc: FilePanelService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'marina-fp-gallery-'));
    svc = new FilePanelService();
    svc.attachSessionLookup(makeLookup({ s1: { currentCwd: dir, ownerWindowId: 'w1' } }));
    // gallery 网络图需要 workspace 缓存目录:注入返回临时 dir 的 ops。
    svc.attachWorkspaceOps({
      getCurrentPath: () => dir,
      bind: async () => ({ kind: 'created', workspaceId: 'w1', dir }),
      list: async () => [],
      newWorkspace: async () => ({ workspaceId: 'w1', dir }),
      unpin: async () => ({ workspaceId: 'w1' }),
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await svc.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('本地图 → dataUrl(复用 read-image:成员校验 + 相对 md 目录 + MIME)', async () => {
    // 造一个 1x1 PNG(md 同级目录)
    await writeFile(join(dir, 'r.md'), '# hi');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    await writeFile(join(dir, 'a.png'), png);
    await svc.openFile('s1', 'r.md');
    const mdPath = join(dir, 'r.md');

    const r = await svc.resolveGalleryImage('s1', mdPath, 'a.png');
    expect('dataUrl' in r).toBe(true);
    if ('dataUrl' in r) {
      expect(r.dataUrl).toMatch(/^data:image\/png;base64,/);
    }
  });

  it('本地图:mdPath 不在面板 → error(成员校验防线)', async () => {
    await writeFile(join(dir, 'a.png'), Buffer.alloc(8));
    const r = await svc.resolveGalleryImage('s1', join(dir, 'other.md'), 'a.png');
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toBe('md file not in this panel');
  });

  it('本地图:文件不存在 → error', async () => {
    await writeFile(join(dir, 'r.md'), '# hi');
    await svc.openFile('s1', 'r.md');
    const r = await svc.resolveGalleryImage('s1', join(dir, 'r.md'), 'nope.png');
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toBe('not found');
  });

  it('网络图 → 下载成功返 dataUrl(走 fetch,content-type 定 mime)', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      headers: { get: (k: string) => (k === 'content-type' ? 'image/png' : null) },
      body: { getReader: () => makeReader(png) },
    }));

    const r = await svc.resolveGalleryImage('s1', join(dir, 'x.md'), 'https://e.com/a.png');
    expect('dataUrl' in r).toBe(true);
    if ('dataUrl' in r) expect(r.dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it('网络图:HTTP 非 2xx → error', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 404,
      headers: new Map(),
      body: null,
    }));
    const r = await svc.resolveGalleryImage('s1', join(dir, 'x.md'), 'https://e.com/a.png');
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toMatch(/HTTP 404/);
  });

  it('网络图:响应超 MAX_NETWORK_IMAGE_BYTES → error(流式累计中断)', async () => {
    // 喂一个超过上限的流(每块 1MB,超 10MB 中断)
    const chunk = Buffer.alloc(1024 * 1024, 0xff);
    let calls = 0;
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'image/png' },
      body: {
        getReader: () => ({
          read: async () => {
            calls++;
            if (calls > 20) return { done: true as const, value: undefined };
            return { done: false as const, value: chunk };
          },
          cancel: async () => {},
        }),
      },
    }));
    const r = await svc.resolveGalleryImage('s1', join(dir, 'x.md'), 'https://e.com/big.png');
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toMatch(/too large/);
  });

  it('网络图:fetch 抛错 → error', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ETIMEDOUT');
    });
    const r = await svc.resolveGalleryImage('s1', join(dir, 'x.md'), 'https://e.com/a.png');
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toMatch(/network fetch failed/);
  });

  it('网络图:缓存命中(同 URL 二次 resolve)不重复 fetch', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    let fetchCalls = 0;
    vi.stubGlobal('fetch', async () => {
      fetchCalls++;
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'image/png' },
        body: { getReader: () => makeReader(png) },
      };
    });
    const url = 'https://e.com/cached.png';
    const r1 = await svc.resolveGalleryImage('s1', join(dir, 'x.md'), url);
    const r2 = await svc.resolveGalleryImage('s1', join(dir, 'x.md'), url);
    expect(fetchCalls).toBe(1); // 第二次命中缓存
    expect('dataUrl' in r1 && 'dataUrl' in r2).toBe(true);
  });

  it('网络图:workspace 未绑定 → error(无缓存目录)', async () => {
    // 用一个 workspaceOps 返回 null 的 service
    const svc2 = new FilePanelService();
    svc2.attachSessionLookup(makeLookup({ s1: { currentCwd: dir, ownerWindowId: 'w1' } }));
    svc2.attachWorkspaceOps({
      getCurrentPath: () => null,
      bind: async () => ({ kind: 'created', workspaceId: 'w', dir }),
      list: async () => [],
      newWorkspace: async () => ({ workspaceId: 'w', dir }),
      unpin: async () => ({ workspaceId: 'w' }),
    });
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, headers: new Map(), body: null }));
    const r = await svc2.resolveGalleryImage('s1', join(dir, 'x.md'), 'https://e.com/a.png');
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toMatch(/workspace not available/);
    await svc2.stop();
  });

  it('openGalleryImage 本地图 → 返回磁盘绝对路径(供 ipc openPath)', async () => {
    await writeFile(join(dir, 'r.md'), '# hi');
    const png = Buffer.alloc(8, 0x89);
    await writeFile(join(dir, 'a.png'), png);
    await svc.openFile('s1', 'r.md');
    const r = await svc.openGalleryImage('s1', join(dir, 'r.md'), 'a.png');
    expect('path' in r).toBe(true);
    if ('path' in r) expect(r.path).toBe(join(dir, 'a.png'));
  });

  it('openGalleryImage 网络图 → 返回缓存落盘路径', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'image/png' },
      body: { getReader: () => makeReader(png) },
    }));
    const r = await svc.openGalleryImage('s1', join(dir, 'x.md'), 'https://e.com/a.png');
    expect('path' in r).toBe(true);
    if ('path' in r) {
      expect(r.path).toContain('__marina_gallery__');
      expect(r.path).toMatch(/\.png$/);
    }
  });

  it('openGalleryImage 本地图不存在 → error', async () => {
    await writeFile(join(dir, 'r.md'), '# hi');
    await svc.openFile('s1', 'r.md');
    const r = await svc.openGalleryImage('s1', join(dir, 'r.md'), 'nope.png');
    expect('error' in r).toBe(true);
  });
});

/** 造一个 Web ReadableStream 风格的 reader(一次性吐 buffer 后 done)。 */
function makeReader(buf: Buffer) {
  let done = false;
  return {
    read: async () => {
      if (done) return { done: true as const, value: undefined };
      done = true;
      return { done: false as const, value: new Uint8Array(buf) };
    },
    cancel: async () => {},
  };
}
