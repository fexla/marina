/**
 * @file src/main/ipc.test.ts
 * @purpose IPC handler 集成测试 — 验证 envelope 解包、Manager 调用契约、关键
 *   分支的回归。
 *
 * v1.3 起加(TST-2):覆盖 IPC-1 修复 — SESSION_CREATE 的 `takeOwnership=false`
 * 分支以前会先创建带 owner 再调 releaseOwner,因 createSession 把空 owner 折叠
 * 成 null → releaseOwner 抛 NotOwner,该路径在 IPC 层根本走不通。修复后:
 * takeOwnership=false 直接传空 owner,不再事后 release;ownerWindowId 落到 null。
 *
 * 关键设计:
 * - vi.hoisted + vi.mock 替换 electron 的 ipcMain,捕获 (channel, handler) 对
 * - vi.mock('./index') 打断 ipc.ts → index.ts 的循环 import(测试期不需要 setQuitting)
 * - vi.mock('./explorer-integration') 屏蔽 PowerShell / native 调用
 * - Manager 用最小桩(只实现 SESSION_CREATE 路径用到的方法),不拉真 PTY
 * - 每个 test 用 beforeEach 重置 handler registry + installed 标志
 *
 * 不在这里覆盖:大部分 handler 走 manager 内部逻辑,manager 自己有完整单测;
 * ipc.ts 是薄编排层,只测那些"编排本身就能错"的命令。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMAND_CHANNELS } from '@shared/protocol';
import type { CommandEnvelope, CreateSessionPayload } from '@shared/protocol';
import type { SessionInfo } from '@shared/types';
import type * as IpcModule from './ipc';
import { makePathId } from './path-manager';

// ──────────────────────────────────────────────────────────────────
// electron mock — ipcMain.handle 捕获 handler 到 handlers Map
// ──────────────────────────────────────────────────────────────────

const { handlers, mockApp, mockBrowserWindow, mockClipboard, mockDialog, mockShell, mockIpcMain } =
  vi.hoisted(() => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const mockIpcMain = {
      handle: (channel: string, handler: (...args: unknown[]) => unknown): void => {
        handlers.set(channel, handler);
      },
      removeHandler: (channel: string): void => {
        handlers.delete(channel);
      },
    };
    const mockApp = {
      getPath: (): string => '/tmp/marina-test',
      getVersion: (): string => '0.0.0-test',
      on: (): void => {},
      quit: (): void => {},
      isPackaged: false,
    };
    const mockBrowserWindow = {
      getAllWindows: (): unknown[] => [],
      fromWebContents: (): unknown => null,
    };
    const mockClipboard = {
      readText: (): string => '',
      writeText: (): void => {},
    };
    const mockDialog = {
      showSaveDialog: (): Promise<unknown> => Promise.resolve({ canceled: true }),
      showOpenDialog: (): Promise<unknown> => Promise.resolve({ canceled: true }),
    };
    const mockShell = {
      openExternal: (): Promise<void> => Promise.resolve(),
      openPath: (): Promise<string> => Promise.resolve(''),
      showItemInFolder: (): void => {},
    };
    return { handlers, mockApp, mockBrowserWindow, mockClipboard, mockDialog, mockShell, mockIpcMain };
  });

vi.mock('electron', () => ({
  ipcMain: mockIpcMain,
  app: mockApp,
  BrowserWindow: mockBrowserWindow,
  clipboard: mockClipboard,
  dialog: mockDialog,
  shell: mockShell,
}));

// 打断 ipc.ts → index.ts 的循环 import(测试期不需要真实 setQuitting)
vi.mock('./index', () => ({
  setQuitting: vi.fn(),
}));

// explorer-integration 走 native 命令,测试期不应触发
vi.mock('./explorer-integration', () => ({
  getExplorerIntegrationStatus: vi.fn(async () => ({})),
  setClassicIntegration: vi.fn(async () => ({ ok: true, message: '', status: {} })),
  setModernIntegration: vi.fn(async () => ({ ok: true, message: '', status: {} })),
  getPsCommands: vi.fn(() => ({
    installModern: '',
    uninstallModern: '',
    installClassic: '',
    uninstallClassic: '',
  })),
}));

// build-type 是纯函数但读 app.isPackaged,mock 安全
vi.mock('./build-type', () => ({
  getBuildType: vi.fn(() => 'dev'),
}));

// ──────────────────────────────────────────────────────────────────
// 桩 Manager — 只实现 SESSION_CREATE 路径需要的方法
// ──────────────────────────────────────────────────────────────────

interface CreateSessionCall {
  pathId: string;
  templateId: string;
  ownerWindowId: string;
  cols: number;
  rows: number;
  shellIdOverride?: string;
  sshProfile?: {
    id: string;
    name: string;
    host: string;
    port: number;
    username: string;
    authType: 'agent' | 'keyFile' | 'password';
    tmuxMode?: 'disabled' | 'attach-or-create';
    tmuxOnMissing?: 'fallback-shell' | 'fail';
  };
}

function makeStubs() {
  const createCalls: CreateSessionCall[] = [];
  const stubSession: SessionInfo = {
    id: 'sess-1',
    pathId: '',
    templateId: 'shell',
    originalCwd: '/tmp',
    currentCwd: '/tmp',
    cols: 80,
    rows: 24,
    pid: 1234,
    displayName: 'shell',
    ownerWindowId: null,
    state: 'active',
    createdAt: Date.now(),
  };

  const sessionManager = {
    createSession: vi.fn(async (input: CreateSessionCall): Promise<SessionInfo> => {
      createCalls.push(input);
      return {
        ...stubSession,
        // 模拟真实 SessionManager 的折叠语义:`'' || null` → null
        ownerWindowId: input.ownerWindowId || null,
      };
    }),
    // 关键:releaseOwner 若被错误调用,要抛 NotOwner — 这是 IPC-1 回归检测点
    releaseOwner: vi.fn((_sessionId: string, _windowId: string) => {
      throw new Error('IPC-1 regression: releaseOwner should NOT be called');
    }),
    list: vi.fn(() => []),
    handleWindowClosed: vi.fn(),
    on: vi.fn(),
  };

  interface TreeNode {
    id: string;
    path: string;
  }
  interface PathTreeShape {
    bookmarked: TreeNode[];
    temporary: TreeNode[];
    recent: TreeNode[];
  }
  const pathManager = {
    getTree: vi.fn<[], PathTreeShape>(() => ({
      bookmarked: [],
      temporary: [],
      recent: [],
    })),
    on: vi.fn(),
    listBookmarks: vi.fn(() => []),
    listRecent: vi.fn(() => []),
  };

  const templatesManager = {
    getDefaultTemplateId: vi.fn(() => 'shell'),
    list: vi.fn(() => []),
    on: vi.fn(),
  };

  const settingsManager = {
    get: vi.fn(() => ({})),
    on: vi.fn(),
  };

  const windowManager = {
    list: vi.fn(() => []),
    count: vi.fn(() => 0),
    getById: vi.fn(() => null),
    onWindowCreated: vi.fn(),
    onWindowClosed: vi.fn(),
    on: vi.fn(),
  };

  const sshProfileFixture = (id: string) =>
    id === 'ssh-1'
      ? {
          id: 'ssh-1',
          name: 'prod',
          host: 'example.com',
          port: 22,
          username: 'alice',
          authType: 'agent' as const,
          tmuxMode: 'attach-or-create' as const,
          tmuxOnMissing: 'fail' as const,
          addedAt: 1,
        }
      : null;

  const sshProfileManager = {
    get: vi.fn(sshProfileFixture),
    getInternal: vi.fn(sshProfileFixture),
    list: vi.fn(() => []),
    on: vi.fn(),
  };

  return {
    createCalls,
    deps: {
      sessionManager: sessionManager as unknown,
      pathManager: pathManager as unknown,
      templatesManager: templatesManager as unknown,
      settingsManager: settingsManager as unknown,
      windowManager: windowManager as unknown,
      sshProfileManager: sshProfileManager as unknown,
    },
    stubs: {
      sessionManager,
      pathManager,
      templatesManager,
      settingsManager,
      windowManager,
      sshProfileManager,
    },
  };
}

// ──────────────────────────────────────────────────────────────────
// 测试 fixture — 每个 it 重新装载 ipc.ts(installed 单例需要 reset)
// ──────────────────────────────────────────────────────────────────

async function freshIpc(): Promise<typeof IpcModule> {
  vi.resetModules();
  // 重新 mock 在 resetModules 后仍然生效(vi.mock 由 vi.hoisted 提到模块顶部)
  return (await import('./ipc')) as typeof IpcModule;
}

beforeEach(() => {
  handlers.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ──────────────────────────────────────────────────────────────────
// 测试
// ──────────────────────────────────────────────────────────────────

describe('IPC SESSION_CREATE', () => {
  it('takeOwnership=true(默认): 把 envelope.windowId 透传为 ownerWindowId', async () => {
    const { installIpcLayer } = await freshIpc();
    const { createCalls, deps, stubs } = makeStubs();
    installIpcLayer(deps as Parameters<typeof installIpcLayer>[0]);

    const handler = handlers.get(COMMAND_CHANNELS.SESSION_CREATE);
    expect(handler).toBeTruthy();

    const envelope: CommandEnvelope<CreateSessionPayload> = {
      windowId: 'win-aaa',
      requestId: 'req-1',
      payload: { pathId: 'C:\\foo', cols: 80, rows: 24 }, // takeOwnership 默认 true
    };

    const result = (await handler!({}, envelope)) as { session: SessionInfo; pathTreeChanged: boolean };
    expect(result.session.id).toBe('sess-1');
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]!.ownerWindowId).toBe('win-aaa');
    // 不应触发 releaseOwner
    expect(stubs.sessionManager.releaseOwner).not.toHaveBeenCalled();
  });

  it('takeOwnership=false(IPC-1 修复): 传空 owner,绝不调 releaseOwner', async () => {
    const { installIpcLayer } = await freshIpc();
    const { createCalls, deps, stubs } = makeStubs();
    installIpcLayer(deps as Parameters<typeof installIpcLayer>[0]);

    const handler = handlers.get(COMMAND_CHANNELS.SESSION_CREATE);
    const envelope: CommandEnvelope<CreateSessionPayload> = {
      windowId: 'win-bbb',
      requestId: 'req-2',
      payload: { pathId: 'C:\\foo', cols: 80, rows: 24, takeOwnership: false },
    };

    // 旧实现会抛 NotOwner(stub.releaseOwner 模拟该行为);新实现应不调 releaseOwner
    // 且 ownerWindowId 应为空串(createSession 内部再折叠为 null)
    const result = (await handler!({}, envelope)) as { session: SessionInfo };

    expect(result.session.ownerWindowId).toBeNull();
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]!.ownerWindowId).toBe('');
    expect(stubs.sessionManager.releaseOwner).not.toHaveBeenCalled();
  });

  it('templateId 缺省 → 用 templatesManager.getDefaultTemplateId()', async () => {
    const { installIpcLayer } = await freshIpc();
    const { createCalls, deps, stubs } = makeStubs();
    installIpcLayer(deps as Parameters<typeof installIpcLayer>[0]);

    const handler = handlers.get(COMMAND_CHANNELS.SESSION_CREATE);
    const envelope: CommandEnvelope<CreateSessionPayload> = {
      windowId: 'win-ccc',
      requestId: 'req-3',
      payload: { cols: 80, rows: 24 }, // 无 templateId / pathId
    };

    await handler!({}, envelope);
    expect(stubs.templatesManager.getDefaultTemplateId).toHaveBeenCalled();
    expect(createCalls[0]!.templateId).toBe('shell');
    expect(createCalls[0]!.pathId).toBe(''); // pathId ?? ''
  });

  it('pathTreeChanged 由 getTree() 前后 JSON 对比得出', async () => {
    const { installIpcLayer } = await freshIpc();
    const { deps, stubs } = makeStubs();
    // 模拟 createSession 触发了 path 树变化:第二次 getTree 返回不同结构
    let callN = 0;
    stubs.pathManager.getTree.mockImplementation(() => {
      callN++;
      return callN === 1
        ? { bookmarked: [], temporary: [], recent: [] }
        : { bookmarked: [], temporary: [{ id: 'C:\\new', path: 'C:\\new' }], recent: [] };
    });
    installIpcLayer(deps as Parameters<typeof installIpcLayer>[0]);

    const handler = handlers.get(COMMAND_CHANNELS.SESSION_CREATE);
    const envelope: CommandEnvelope<CreateSessionPayload> = {
      windowId: 'win-ddd',
      requestId: 'req-4',
      payload: { pathId: 'C:\\new', cols: 80, rows: 24 },
    };

    const result = (await handler!({}, envelope)) as { pathTreeChanged: boolean };
    expect(result.pathTreeChanged).toBe(true);
  });

  it('SSH 普通连接忽略旧 profile tmux 设置,强制 plain ssh', async () => {
    const { installIpcLayer } = await freshIpc();
    const { createCalls, deps } = makeStubs();
    installIpcLayer(deps as Parameters<typeof installIpcLayer>[0]);

    const pathId = makePathId({ kind: 'ssh', sshProfileId: 'ssh-1', path: '~/repo' });
    const handler = handlers.get(COMMAND_CHANNELS.SESSION_CREATE);
    const envelope: CommandEnvelope<CreateSessionPayload> = {
      windowId: 'win-ssh',
      requestId: 'req-ssh-1',
      payload: { pathId, cols: 80, rows: 24, sshTmuxMode: 'disabled' },
    };

    await handler!({}, envelope);
    expect(createCalls[0]!.sshProfile).toMatchObject({
      id: 'ssh-1',
      tmuxMode: 'disabled',
      tmuxOnMissing: 'fallback-shell',
    });
  });

  it('SSH tmux 入口按本次启动参数启用 tmux,失败时回退 shell', async () => {
    const { installIpcLayer } = await freshIpc();
    const { createCalls, deps } = makeStubs();
    installIpcLayer(deps as Parameters<typeof installIpcLayer>[0]);

    const pathId = makePathId({ kind: 'ssh', sshProfileId: 'ssh-1', path: '~/repo' });
    const handler = handlers.get(COMMAND_CHANNELS.SESSION_CREATE);
    const envelope: CommandEnvelope<CreateSessionPayload> = {
      windowId: 'win-ssh',
      requestId: 'req-ssh-2',
      payload: { pathId, cols: 80, rows: 24, sshTmuxMode: 'attach-or-create' },
    };

    await handler!({}, envelope);
    expect(createCalls[0]!.sshProfile).toMatchObject({
      id: 'ssh-1',
      tmuxMode: 'attach-or-create',
      tmuxOnMissing: 'fallback-shell',
    });
  });
});
