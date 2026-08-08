/**
 * @file src/main/http/local-http-gateway.test.ts
 * @purpose 验证 LocalHttpGateway 的 HTTP 传输层:鉴权 / health 免鉴权 / quiesce gate /
 *   路由分发到 file-panel handler(service)与各业务 ops。M3 从 file-panel-service.test.ts
 *   的 HTTP describe 迁移而来,gateway.start() 替代原 svc.start()。
 *
 * 覆盖:
 * - 鉴权(/health 免鉴权 / 无 token 401 / 错 token 401)
 * - disabled → start 返回 null + getUrl null
 * - 路由分发:file-panel 端点调 service handler、/screenshot 调 windowCapture、
 *   /workspace* 调 workspaceOps、/run 调 commandRunOps、/pi-session-event 调 piEventOps
 * - 404 未知路由
 * - quiesce gate:isQuiescing()=true → 非 /health 一律 503(H4)
 * - 各 handler 的输入校验(body 缺参 400、非法 JSON 400、错误映射 404/409 等)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilePanelService } from '../file-panel-service';
import { LocalHttpGateway } from './local-http-gateway';

// quiesce gate 测试:mock app-lifecycle.isQuiescing 返回 true。
// 注意 vi.mock 会 hoist 到文件顶部,必须在任何 import 之前 —— vitest 自动处理。
const { isQuiescing } = vi.hoisted(() => ({ isQuiescing: vi.fn(() => false) }));
vi.mock('../app-lifecycle', () => ({ isQuiescing }));

interface LookupEntry {
  currentCwd: string;
  ownerWindowId: string | null;
}

function makeLookup(entries: Record<string, LookupEntry>) {
  return {
    get: (id: string): LookupEntry | null => entries[id] ?? null,
  };
}

/** workspaceOps 的完整 stub(各测试按需覆盖字段)。 */
function makeWorkspaceOpsStub(
  overrides: Partial<Parameters<LocalHttpGateway['attachWorkspaceOps']>[0]> = {},
) {
  return {
    getCurrentPath: () => null,
    bind: async () => ({ kind: 'created' as const, workspaceId: 'w', dir: 'd' }),
    list: async () => [],
    newWorkspace: async () => ({ workspaceId: 'w', dir: 'd' }),
    unpin: async () => ({ workspaceId: 'w' }),
    ...overrides,
  };
}

describe('LocalHttpGateway - HTTP 鉴权与路由', () => {
  let dir: string;
  let svc: FilePanelService;
  let gateway: LocalHttpGateway;
  let baseUrl: string;
  let token: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'marina-gw-http-'));
    svc = new FilePanelService();
    svc.attachSessionLookup(makeLookup({ s1: { currentCwd: dir, ownerWindowId: 'w1' } }));
    gateway = new LocalHttpGateway(svc);
    const url = await gateway.start({ enabled: true, port: 0 });
    baseUrl = url!.baseUrl;
    token = url!.token;
  });

  afterEach(async () => {
    await gateway.stop();
    await svc.stop();
    await rm(dir, { recursive: true, force: true });
  });

  function authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }

  it('GET /opening-files 返回快照(路由到 service handler)', async () => {
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

  it('GET /health 免鉴权返回 200 (给 marina ping 用)', async () => {
    // /health 是唯一的免鉴权端点:终端里的 agent 脚本(marina.ps1 ping)
    // 在未注入 MARINA_TOKEN 时也要能探活,否则无法和"Marina 没在跑"区分。
    const r = await fetch(`${baseUrl}/health`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; marina: boolean };
    expect(body).toEqual({ ok: true, marina: true });
  });

  it('GET /health 带 token 也 200 (不破坏鉴权流程)', async () => {
    const r = await fetch(`${baseUrl}/health`, { headers: authHeaders() });
    expect(r.status).toBe(200);
  });

  it('错 token → 401', async () => {
    const r = await fetch(`${baseUrl}/opening-files?terminal=s1`, {
      headers: { Authorization: 'Bearer wrong' },
    });
    expect(r.status).toBe(401);
  });

  it('POST /open-file 打开 + 切 active(路由到 service handler)', async () => {
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

  it('POST /close-file 关闭(路由到 service handler)', async () => {
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
    const off = new LocalHttpGateway(new FilePanelService());
    expect(await off.start({ enabled: false, port: 0 })).toBeNull();
    expect(off.getUrl()).toBeNull();
    await off.stop();
  });

  it('quiesce gate:isQuiescing=true → 非 /health 一律 503(H4)', async () => {
    isQuiescing.mockReturnValueOnce(true);
    // /health 仍放行(存活探测不受退出影响)
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    // 其他路由(即使带正确 token)拒绝
    const r = await fetch(`${baseUrl}/opening-files?terminal=s1`, { headers: authHeaders() });
    expect(r.status).toBe(503);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('shutting down');
  });
});

// v0.3.3 T12(testability enabler):GET /screenshot —— agent/CLI 远程截图自测 UI。
// windowCapture 注入式(mock webContents),验证鉴权 / 成功返 image/png / 错误返 400 / 未注入返 503。
describe('LocalHttpGateway - HTTP /screenshot (T12)', () => {
  let svc: FilePanelService;
  let gateway: LocalHttpGateway;
  let baseUrl: string;
  let token: string;

  beforeEach(async () => {
    svc = new FilePanelService();
    svc.attachSessionLookup(makeLookup({ s1: { currentCwd: '/', ownerWindowId: 'w1' } }));
    gateway = new LocalHttpGateway(svc);
    const url = await gateway.start({ enabled: true, port: 0 });
    baseUrl = url!.baseUrl;
    token = url!.token;
  });

  afterEach(async () => {
    await gateway.stop();
    await svc.stop();
  });

  function authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${token}` };
  }

  it('无鉴权 → 401(同其他路由)', async () => {
    const r = await fetch(`${baseUrl}/screenshot?terminal=s1`);
    expect(r.status).toBe(401);
  });

  it('windowCapture 未注入 → 503(功能未启用,不崩)', async () => {
    const r = await fetch(`${baseUrl}/screenshot?terminal=s1`, { headers: authHeaders() });
    expect(r.status).toBe(503);
  });

  it('缺 terminal 查询参数 → 400', async () => {
    gateway.attachWindowCapture(async () => ({ png: Buffer.alloc(0) }));
    const r = await fetch(`${baseUrl}/screenshot`, { headers: authHeaders() });
    expect(r.status).toBe(400);
  });

  it('capture 成功 → 200 + image/png + PNG 字节', async () => {
    // 模拟一个 1×1 PNG(webContents.capturePage→toPNG 的替身)
    const fakePng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
      'base64',
    );
    gateway.attachWindowCapture(async (sessionId) => {
      expect(sessionId).toBe('s1');
      return { png: fakePng };
    });
    const r = await fetch(`${baseUrl}/screenshot?terminal=s1`, { headers: authHeaders() });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    const buf = Buffer.from(await r.arrayBuffer());
    expect(buf.equals(fakePng)).toBe(true);
  });

  it('capture 返 {error}(无 owner/窗口销毁)→ 400 + JSON error', async () => {
    gateway.attachWindowCapture(async () => ({ error: 'owner 窗口已关闭' }));
    const r = await fetch(`${baseUrl}/screenshot?terminal=s1`, { headers: authHeaders() });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toContain('owner');
  });

  it('capture 抛异常 → 500(服务端 bug 兜底)', async () => {
    gateway.attachWindowCapture(async () => {
      throw new Error('boom');
    });
    const r = await fetch(`${baseUrl}/screenshot?terminal=s1`, { headers: authHeaders() });
    expect(r.status).toBe(500);
  });
});

// v0.3.3 ADR-024 / Feature D:workspace HTTP 路由(CLI `marina workspace*` 用)。
describe('LocalHttpGateway - HTTP /workspace* (T10)', () => {
  let svc: FilePanelService;
  let gateway: LocalHttpGateway;
  let baseUrl: string;
  let token: string;

  beforeEach(async () => {
    svc = new FilePanelService();
    svc.attachSessionLookup(makeLookup({ s1: { currentCwd: '/', ownerWindowId: 'w1' } }));
    gateway = new LocalHttpGateway(svc);
    const url = await gateway.start({ enabled: true, port: 0 });
    baseUrl = url!.baseUrl;
    token = url!.token;
  });

  afterEach(async () => {
    await gateway.stop();
    await svc.stop();
  });

  function authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }

  it('workspaceOps 未注入 → 所有路由 503', async () => {
    const r = await fetch(`${baseUrl}/workspace?terminal=s1`, { headers: authHeaders() });
    expect(r.status).toBe(503);
  });

  it('GET /workspace → 当前 session 绑定路径;无绑定 → 404', async () => {
    let path = 'C:\\ws\\abc';
    gateway.attachWorkspaceOps(
      makeWorkspaceOpsStub({
        getCurrentPath: () => path,
      }),
    );
    const r = await fetch(`${baseUrl}/workspace?terminal=s1`, { headers: authHeaders() });
    expect(r.status).toBe(200);
    expect((await r.json()) as { path: string }).toEqual({ path });

    path = '';
    const r2 = await fetch(`${baseUrl}/workspace?terminal=s1`, { headers: authHeaders() });
    expect(r2.status).toBe(404);
  });

  it('GET /workspace/list → items', async () => {
    gateway.attachWorkspaceOps(
      makeWorkspaceOpsStub({
        list: async () => [
          {
            workspaceId: 'w1',
            name: 'a',
            createdAt: 1,
            closedAt: null,
            pinned: true,
            pathScope: 'P',
            fileCount: 2,
          },
        ],
      }),
    );
    const r = await fetch(`${baseUrl}/workspace/list?terminal=s1`, { headers: authHeaders() });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(1);
  });

  it('POST /workspace/bind → created 结果;NameConflict → 409', async () => {
    let forceNewSeen = false;
    gateway.attachWorkspaceOps(
      makeWorkspaceOpsStub({
        bind: async (_sid: string, _name: string, fn: boolean) => {
          forceNewSeen = fn;
          return { kind: 'created' as const, workspaceId: 'w', dir: 'd' };
        },
      }),
    );
    const r = await fetch(`${baseUrl}/workspace/bind`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ terminal: 's1', name: 'feat', new: true }),
    });
    expect(r.status).toBe(200);
    expect(forceNewSeen).toBe(true);
    expect((await r.json()) as { kind: string }).toEqual({
      kind: 'created',
      workspaceId: 'w',
      dir: 'd',
    });

    // NameConflict → 409
    gateway.attachWorkspaceOps(
      makeWorkspaceOpsStub({
        bind: async () => {
          const e = new Error('name conflict') as Error & { code?: string };
          e.code = 'NameConflict';
          throw e;
        },
      }),
    );
    const r2 = await fetch(`${baseUrl}/workspace/bind`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ terminal: 's1', name: 'feat', new: true }),
    });
    expect(r2.status).toBe(409);
  });

  it('POST /workspace/bind 缺字段 → 400', async () => {
    gateway.attachWorkspaceOps(makeWorkspaceOpsStub());
    const r = await fetch(`${baseUrl}/workspace/bind`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ terminal: 's1' }),
    });
    expect(r.status).toBe(400);
  });

  it('POST /workspace/new → 新 workspace', async () => {
    gateway.attachWorkspaceOps(
      makeWorkspaceOpsStub({
        newWorkspace: async () => ({ workspaceId: 'nw', dir: 'nd' }),
      }),
    );
    const r = await fetch(`${baseUrl}/workspace/new`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ terminal: 's1' }),
    });
    expect(r.status).toBe(200);
    expect((await r.json()) as { workspaceId: string }).toEqual({ workspaceId: 'nw', dir: 'nd' });
  });

  it('POST /workspace/unpin → 结果;未找到 → 404', async () => {
    let found = true;
    gateway.attachWorkspaceOps(
      makeWorkspaceOpsStub({
        unpin: async () => (found ? { workspaceId: 'w' } : null),
      }),
    );
    const r = await fetch(`${baseUrl}/workspace/unpin`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ terminal: 's1', name: 'x' }),
    });
    expect(r.status).toBe(200);

    found = false;
    const r2 = await fetch(`${baseUrl}/workspace/unpin`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ terminal: 's1' }),
    });
    expect(r2.status).toBe(404);
  });

  it('workspace switch 时通知 service 重建面板(onWorkspaceSwitched)', async () => {
    // bind 返回 switched → gateway 调 service.onWorkspaceSwitched(重建 PanelState)。
    // 用 readSnapshotForSession stub 验证 service 被通知到(经 gateway 转发)。
    let switchedCalled = false;
    svc.attachWorkspaceOps(
      makeWorkspaceOpsStub({
        readSnapshotForSession: async () => {
          switchedCalled = true;
          return null;
        },
      }),
    );
    gateway.attachWorkspaceOps(
      makeWorkspaceOpsStub({
        bind: async () => ({
          kind: 'switched' as const,
          workspaceId: 'w',
          dir: 'd',
          createdAt: 1,
          fileCount: 0,
        }),
      }),
    );
    const r = await fetch(`${baseUrl}/workspace/bind`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ terminal: 's1', name: 'x' }),
    });
    expect(r.status).toBe(200);
    // onWorkspaceSwitched 是 async fire-and-forget,稍等它跑完。
    await new Promise((res) => setTimeout(res, 10));
    expect(switchedCalled).toBe(true);
  });
});

// v0.3.3 ADR-027:POST /run(转发 commandRunOps)。
describe('LocalHttpGateway - HTTP /run (ADR-027)', () => {
  let svc: FilePanelService;
  let gateway: LocalHttpGateway;
  let baseUrl: string;
  let token: string;

  beforeEach(async () => {
    svc = new FilePanelService();
    svc.attachSessionLookup(makeLookup({ s1: { currentCwd: '/', ownerWindowId: 'w1' } }));
    gateway = new LocalHttpGateway(svc);
    const url = await gateway.start({ enabled: true, port: 0 });
    baseUrl = url!.baseUrl;
    token = url!.token;
  });

  afterEach(async () => {
    await gateway.stop();
    await svc.stop();
  });

  function authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }

  it('commandRunOps 未注入 → 503', async () => {
    const r = await fetch(`${baseUrl}/run`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ terminal: 's1', command: 'ls' }),
    });
    expect(r.status).toBe(503);
  });

  it('正常 run → 200 + 命令面板快照(转发到 ops)', async () => {
    let seen: { sid: string; command: string } | null = null;
    gateway.attachCommandRunOps({
      runCommand: async (sid, command) => {
        seen = { sid, command };
        return { commands: [], activeKey: null };
      },
    });
    const r = await fetch(`${baseUrl}/run`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ terminal: 's1', command: 'git status', title: 'status' }),
    });
    expect(r.status).toBe(200);
    expect(seen).toEqual({ sid: 's1', command: 'git status' });
  });

  it('缺 command → 400', async () => {
    gateway.attachCommandRunOps({
      runCommand: async () => ({ commands: [], activeKey: null }),
    });
    const r = await fetch(`${baseUrl}/run`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ terminal: 's1' }),
    });
    expect(r.status).toBe(400);
  });

  it('非法 JSON → 400', async () => {
    gateway.attachCommandRunOps({
      runCommand: async () => ({ commands: [], activeKey: null }),
    });
    const r = await fetch(`${baseUrl}/run`, {
      method: 'POST',
      headers: authHeaders(),
      body: 'not-json{',
    });
    expect(r.status).toBe(400);
  });
});

// v0.3.3 ADR-028:POST /pi-session-event(转发 piEventOps)。
describe('LocalHttpGateway - HTTP /pi-session-event (ADR-028)', () => {
  let svc: FilePanelService;
  let gateway: LocalHttpGateway;
  let baseUrl: string;
  let token: string;

  beforeEach(async () => {
    svc = new FilePanelService();
    svc.attachSessionLookup(makeLookup({ s1: { currentCwd: '/', ownerWindowId: 'w1' } }));
    gateway = new LocalHttpGateway(svc);
    const url = await gateway.start({ enabled: true, port: 0 });
    baseUrl = url!.baseUrl;
    token = url!.token;
  });

  afterEach(async () => {
    await gateway.stop();
    await svc.stop();
  });

  function authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }

  it('piEventOps 未注入 → 503', async () => {
    const r = await fetch(`${baseUrl}/pi-session-event`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ terminal: 's1', piSessionId: 'p1', event: 'session_start' }),
    });
    expect(r.status).toBe(503);
  });

  it('合法事件 → 200 {ok:true} + 转发到 ops', async () => {
    let seen: { terminal: string; event: string } | null = null;
    gateway.attachPiEventOps({
      applyPiSessionEvent: async (terminal, payload) => {
        seen = { terminal, event: payload.event };
      },
    });
    const r = await fetch(`${baseUrl}/pi-session-event`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        terminal: 's1',
        piSessionId: 'p1',
        event: 'session_start',
        reason: 'startup',
      }),
    });
    expect(r.status).toBe(200);
    expect((await r.json()) as { ok: boolean }).toEqual({ ok: true });
    expect(seen).toEqual({ terminal: 's1', event: 'session_start' });
  });

  it('缺 piSessionId → 400', async () => {
    gateway.attachPiEventOps({
      applyPiSessionEvent: async () => {},
    });
    const r = await fetch(`${baseUrl}/pi-session-event`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ terminal: 's1', event: 'session_start' }),
    });
    expect(r.status).toBe(400);
  });

  it('非法 event → 400', async () => {
    gateway.attachPiEventOps({
      applyPiSessionEvent: async () => {},
    });
    const r = await fetch(`${baseUrl}/pi-session-event`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ terminal: 's1', piSessionId: 'p1', event: 'bogus' }),
    });
    expect(r.status).toBe(400);
  });

  it('ops 抛错 → 500 + error(pi 不等业务结果,不卡)', async () => {
    gateway.attachPiEventOps({
      applyPiSessionEvent: async () => {
        throw new Error('boom');
      },
    });
    const r = await fetch(`${baseUrl}/pi-session-event`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ terminal: 's1', piSessionId: 'p1', event: 'name_changed', name: 'x' }),
    });
    expect(r.status).toBe(500);
  });
});

// v0.3.3 ADR-024 / Feature D:workspace HTTP 路由(CLI `marina workspace*` 用)。
// GET /opening-files stale + /close-files 批量关 —— 验证 gateway 路由到 service
// handler 后,handler 与核心面板状态机(刷新/关闭)协作正确。
describe('LocalHttpGateway - HTTP /opening-files stale + /close-files (#3,#4)', () => {
  let dir: string;
  let svc: FilePanelService;
  let gateway: LocalHttpGateway;
  let baseUrl: string;
  let token: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'marina-gw-http2-'));
    svc = new FilePanelService();
    svc.attachSessionLookup(makeLookup({ s1: { currentCwd: dir, ownerWindowId: 'w1' } }));
    gateway = new LocalHttpGateway(svc);
    const url = await gateway.start({ enabled: true, port: 0 });
    baseUrl = url!.baseUrl;
    token = url!.token;
  });

  afterEach(async () => {
    await gateway.stop();
    await svc.stop();
    await rm(dir, { recursive: true, force: true });
  });

  function authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }

  it('GET /opening-files 自动刷 stale:返回体里 missing 反映磁盘真值', async () => {
    await writeFile(join(dir, 'gone.md'), 'x');
    await svc.openFile('s1', 'gone.md');
    await rm(join(dir, 'gone.md'));
    const r = await fetch(`${baseUrl}/opening-files?terminal=s1`, { headers: authHeaders() });
    const body = (await r.json()) as { files: { missing?: boolean; name: string }[] };
    expect(body.files[0]!.missing).toBe(true);
  });

  it('POST /close-files mode=all 清空并返回 closed 列表', async () => {
    await writeFile(join(dir, 'a.md'), '1');
    await writeFile(join(dir, 'b.md'), '2');
    await svc.openFile('s1', 'a.md');
    await svc.openFile('s1', 'b.md');
    const r = await fetch(`${baseUrl}/close-files`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ terminal: 's1', mode: 'all' }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { files: unknown[]; closed: string[] };
    expect(body.files).toHaveLength(0);
    expect(body.closed).toHaveLength(2);
  });

  it('POST /close-files mode=stale 先刷真值再关僵尸', async () => {
    await writeFile(join(dir, 'keep.md'), 'k');
    await writeFile(join(dir, 'gone.md'), 'g');
    await svc.openFile('s1', 'keep.md');
    await svc.openFile('s1', 'gone.md');
    await rm(join(dir, 'gone.md'));
    const r = await fetch(`${baseUrl}/close-files`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ terminal: 's1', mode: 'stale' }),
    });
    const body = (await r.json()) as { files: { name: string }[]; closed: string[] };
    expect(body.closed).toHaveLength(1);
    expect(body.files[0]!.name).toBe('keep.md');
  });

  it('POST /close-files mode=glob 按 basename 通配关', async () => {
    await writeFile(join(dir, 'a.md'), '1');
    await writeFile(join(dir, 'b.md'), '2');
    await writeFile(join(dir, 'c.txt'), '3');
    await svc.openFile('s1', 'a.md');
    await svc.openFile('s1', 'b.md');
    await svc.openFile('s1', 'c.txt');
    const r = await fetch(`${baseUrl}/close-files`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ terminal: 's1', mode: 'glob', pattern: '*.md' }),
    });
    const body = (await r.json()) as { files: { name: string }[]; closed: string[] };
    expect(body.closed).toHaveLength(2);
    expect(body.files).toHaveLength(1);
    expect(body.files[0]!.name).toBe('c.txt');
  });

  it('POST /close-files 非法 mode → 400', async () => {
    const r = await fetch(`${baseUrl}/close-files`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ terminal: 's1', mode: 'bogus' }),
    });
    expect(r.status).toBe(400);
  });

  it('POST /close-files mode=glob 缺 pattern → 400', async () => {
    const r = await fetch(`${baseUrl}/close-files`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ terminal: 's1', mode: 'glob' }),
    });
    expect(r.status).toBe(400);
  });
});
