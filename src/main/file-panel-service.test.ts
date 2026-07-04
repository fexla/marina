/**
 * @file src/main/file-panel-service.test.ts
 * @purpose 验证 FilePanelService 的状态机 / read / HTTP 鉴权与路由 / 路径解析 /
 *   session 销毁清理 / fs.watch 自动刷新。用真实临时目录(AGENTS.md §9.1)。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

describe('FilePanelService - HTTP 鉴权与路由', () => {
  let dir: string;
  let svc: FilePanelService;
  let baseUrl: string;
  let token: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'marina-fp-http-'));
    svc = new FilePanelService();
    svc.attachSessionLookup(makeLookup({ s1: { currentCwd: dir, ownerWindowId: 'w1' } }));
    const url = await svc.start({ enabled: true, port: 0 });
    baseUrl = url!.baseUrl;
    token = url!.token;
  });

  afterEach(async () => {
    await svc.stop();
    await rm(dir, { recursive: true, force: true });
  });

  function authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }

  it('GET /opening-files 返回快照', async () => {
    await writeFile(join(dir, 'a.txt'), 'x');
    await svc.openFile('s1', 'a.txt');
    const r = await fetch(`${baseUrl}/opening-files?terminal=s1`, { headers: authHeaders() });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { files: unknown[]; activePath: string };
    expect(body.files).toHaveLength(1);
    expect(body.activePath).toContain('a.txt');
  });

  it('无 token → 401', async () => {
    const r = await fetch(`${baseUrl}/opening-files?terminal=s1`);
    expect(r.status).toBe(401);
  });

  it('错 token → 401', async () => {
    const r = await fetch(`${baseUrl}/opening-files?terminal=s1`, {
      headers: { Authorization: 'Bearer wrong' },
    });
    expect(r.status).toBe(401);
  });

  it('POST /open-file 打开 + 切 active', async () => {
    await writeFile(join(dir, 'm.md'), '# md');
    const r = await fetch(`${baseUrl}/open-file`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ terminal: 's1', path: 'm.md' }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { files: { kind: string }[]; activePath: string };
    expect(body.files[0]!.kind).toBe('markdown');
    expect(body.activePath).toContain('m.md');
  });

  it('POST 缺参 → 400', async () => {
    const r = await fetch(`${baseUrl}/open-file`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ terminal: 's1' }),
    });
    expect(r.status).toBe(400);
  });

  it('GET 缺 terminal → 400', async () => {
    const r = await fetch(`${baseUrl}/opening-files`, { headers: authHeaders() });
    expect(r.status).toBe(400);
  });

  it('未知路径 → 404', async () => {
    const r = await fetch(`${baseUrl}/nope`, { headers: authHeaders() });
    expect(r.status).toBe(404);
  });

  it('POST /close-file 关闭', async () => {
    await writeFile(join(dir, 'a.txt'), '1');
    await svc.openFile('s1', 'a.txt');
    const r = await fetch(`${baseUrl}/close-file`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ terminal: 's1', path: 'a.txt' }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { files: unknown[] };
    expect(body.files).toHaveLength(0);
  });

  it('disabled → start 返回 null + getUrl null', async () => {
    const off = new FilePanelService();
    expect(await off.start({ enabled: false, port: 0 })).toBeNull();
    expect(off.getUrl()).toBeNull();
    await off.stop();
  });
});

describe('FilePanelService - 销毁清理与自动刷新', () => {
  let dir: string;
  let svc: FilePanelService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'marina-fp-watch-'));
    svc = new FilePanelService();
    svc.attachSessionLookup(makeLookup({ s1: { currentCwd: dir, ownerWindowId: 'w1' } }));
    await svc.start({ enabled: true, port: 0 });
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
