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
 * - vi.mock('./explorer-integration') 屏蔽 PowerShell / native 调用
 * - Manager 用最小桩(只实现 SESSION_CREATE 路径用到的方法),不拉真 PTY
 * - 每个 test 用 beforeEach 重置 handler registry + installed 标志
 *
 * 不在这里覆盖:大部分 handler 走 manager 内部逻辑,manager 自己有完整单测;
 * ipc.ts 是薄编排层,只测那些"编排本身就能错"的命令。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMAND_CHANNELS, EVENT_CHANNELS } from '@shared/protocol';
import type { CommandEnvelope, CreateSessionPayload } from '@shared/protocol';
import type { SessionInfo } from '@shared/types';
import type * as IpcModule from './ipc';
import { FilePanelService } from './file-panel-service';
import { GitService } from './git-service';
import type { FileTreeService } from './file-tree-service';
import { FileTreePollingService } from './file-tree-polling-service';
import { MarkdownThemeManager } from './markdown-theme-manager';
import { CodeBlockRunner } from './code-block-runner';
import { CommandPanelService } from './command-panel-service';
import { SudoPasswordStore } from './sudo-password-store';
import { ClientRegistry } from './client-registry';
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
      getFocusedWindow: (): unknown => null,
      // Electron 的真实 fromWebContents(undefined) 会在内部访问
      // webContents.getOwnerBrowserWindow 并抛 TypeError；mock 必须保留这个失败模式，
      // 否则 WS fakeEvent.sender=undefined 的远程回归永远测不出来。
      fromWebContents: (webContents: unknown): unknown => {
        if (!webContents) {
          throw new TypeError(
            "Cannot read properties of undefined (reading 'getOwnerBrowserWindow')",
          );
        }
        return null;
      },
    };
    const mockClipboard = {
      readText: (): string => '',
      writeText: (): void => {},
    };
    const mockDialog = {
      showSaveDialog: vi.fn((): Promise<unknown> => Promise.resolve({ canceled: true })),
      showOpenDialog: vi.fn((): Promise<unknown> => Promise.resolve({ canceled: true })),
      showMessageBox: vi.fn((): Promise<unknown> => Promise.resolve({ response: 0 })),
    };
    const mockShell = {
      openExternal: vi.fn((): Promise<void> => Promise.resolve()),
      openPath: vi.fn((): Promise<string> => Promise.resolve('')),
      showItemInFolder: vi.fn(),
    };
    return {
      handlers,
      mockApp,
      mockBrowserWindow,
      mockClipboard,
      mockDialog,
      mockShell,
      mockIpcMain,
    };
  });

vi.mock('electron', () => ({
  ipcMain: mockIpcMain,
  app: mockApp,
  BrowserWindow: mockBrowserWindow,
  clipboard: mockClipboard,
  dialog: mockDialog,
  shell: mockShell,
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
    get: vi.fn((_sessionId: string) => null as SessionInfo | null),
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
    update: vi.fn(),
    on: vi.fn(),
  };

  const windowManager = {
    createWindowFromFactory: vi.fn(() => ({ id: 'new-window', number: 2 })),
    list: vi.fn(() => []),
    count: vi.fn(() => 0),
    getById: vi.fn(() => null),
    focus: vi.fn((_windowId: string) => false),
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

  const performanceStatus = {
    runId: 'run-test',
    startedAt: '2026-01-01T00:00:00.000Z',
    enabled: true,
    finalized: false,
    sampleCount: 2,
    stallCount100Ms: 0,
    stallCount250Ms: 0,
    stallCount1000Ms: 0,
    maxStallMs: 0,
    latestMainCpuPercent: 1,
    latestRssBytes: 1024,
    reportFileName: 'run-test.md',
    cpuProfileRunning: false,
  };
  const performanceDiagnostics = {
    getStatus: vi.fn(() => performanceStatus),
    writeReportNow: vi.fn(async () => performanceStatus),
    getReportDir: vi.fn(() => '/tmp/marina-test/performance-reports'),
    captureCpuProfile: vi.fn(async (durationSeconds: number) => ({
      path: '/tmp/marina-test/performance-reports/test.cpuprofile',
      durationSeconds,
    })),
  };

  const fileTreeService = {
    getRoots: vi.fn(async () => []),
    listDirectory: vi.fn(async () => ({
      rootId: 'session-cwd',
      relativePath: '',
      entries: [],
      truncated: false,
    })),
    openFile: vi.fn(async () => ({ files: [], activePath: null })),
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
      // 真实 FilePanelService 实例(不 start):ipc 层 wireEventBroadcasts 只用到
      // 它的 on('filePanelUpdated') / onSessionDestroyed,以及 registerFilePanelHandlers
      // 注册的 5 个方法。EventEmitter + 这些方法在不 start 时都能正常工作。
      filePanelService: new FilePanelService(),
      fileTreeService: fileTreeService as unknown,
      // 真实 GitService 实例(不调 setRuntimeConfig / 不启 watcher):ipc 层
      // wireEventBroadcasts 只用 on('gitStatusUpdated') / onSessionDestroyed,
      // registerGitHandlers 注册的 getStatus / openDiff 在测试中不会被调用
      // (没有专门的 git IPC 测试用例,git-service 自身有完整单测)。
      gitService: new GitService(
        { get: () => null, list: () => [] },
        { getPathForSession: () => null },
        new FilePanelService(),
      ),
      // 真实 FileTreePollingService(不注册 task):ipc 层 wireEventBroadcasts 只用
      // on('fileTreeChanged'),生命周期钩子无副作用;demand/目录集 handler 在
      // 测试中不会被调用(file-tree-polling-service 自身有完整单测)。
      fileTreePollingService: new FileTreePollingService(
        { get: () => null },
        fileTreeService as unknown as FileTreeService,
      ),
      performanceDiagnostics: performanceDiagnostics as unknown,
      skillInstaller: {
        install: vi.fn(async () => ({ installed: [], conflicts: [] })),
      } as unknown,
      // 真实 MarkdownThemeManager(不 ensureFirstRun / startWatch):ipc 层
      // wireEventBroadcasts 只用到它的 on('listUpdated'),以及 registerMdThemeHandlers
      // 注册的 3 个方法。构造无副作用(懒 getter),EventEmitter 在不 watch 时也正常。
      markdownThemeManager: new MarkdownThemeManager(),
      // v0.3.3:真实 CodeBlockRunner(注入 noop sessionLookup):ipc 层
      // wireEventBroadcasts 用它的 on('output'/'exited'),registerCodeBlockHandlers
      // 注册 run/stop。测试不触发真实 spawn(没有用例调 run-code-block)。
      codeBlockRunner: new CodeBlockRunner(() => null),
      // 命令面板:wireEventBroadcasts 用它的 on('commandPanelUpdated')。
      commandPanelService: new CommandPanelService(),
      // v0.3.3 远程 sudo:registerSudoPasswordHandlers 用它的 on('changed') + set/has。
      sudoPasswordStore: new SudoPasswordStore(),
      clientRegistry: new ClientRegistry(),
    },
    stubs: {
      sessionManager,
      pathManager,
      templatesManager,
      settingsManager,
      windowManager,
      sshProfileManager,
      fileTreeService,
      performanceDiagnostics,
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

describe('IPC SETTINGS_APPEARANCE (外观归属客户端, local-control)', () => {
  // 见 docs/plans/远程窗口外观继承本机.md。这两个 handler 操作的是【本进程】
  // settingsManager;在远程窗口里 preload 路由会把命令发到客户端本地 main,
  // 所以这里测的是"handler 正确读写本机 appearance",路由判定见 protocol.test.ts。
  const baseAppearance = {
    theme: 'rose-pine',
    windowStyle: 'windows',
    language: 'system',
    terminalFontFamily: 'Cascadia Code',
    terminalFallbackFont: '',
    terminalFontSize: 13,
    terminalLineHeight: 1.2,
    uiFontFamily: 'Segoe UI',
    uiZoom: 1,
    macOSTrafficLightHoverSymbols: false,
    hideTopTabBar: false,
  };

  it('SETTINGS_GET_APPEARANCE 返回本机 settingsManager 的 appearance 块', async () => {
    const { installIpcLayer } = await freshIpc();
    const { deps, stubs } = makeStubs();
    stubs.settingsManager.get = vi.fn(() => ({ appearance: baseAppearance })) as never;
    installIpcLayer(deps as Parameters<typeof installIpcLayer>[0]);

    const handler = handlers.get(COMMAND_CHANNELS.SETTINGS_GET_APPEARANCE);
    expect(handler).toBeTruthy();
    const res = (await handler!(
      {},
      {
        windowId: 'w1',
        requestId: 'r1',
        payload: undefined,
      },
    )) as { appearance: typeof baseAppearance };
    expect(res.appearance).toEqual(baseAppearance);
  });

  it('SETTINGS_UPDATE_APPEARANCE 合并到本机 appearance 后整体写入(只改传入字段)', async () => {
    const { installIpcLayer } = await freshIpc();
    const { deps, stubs } = makeStubs();
    stubs.settingsManager.get = vi.fn(() => ({ appearance: baseAppearance })) as never;
    stubs.settingsManager.update = vi.fn() as never;
    installIpcLayer(deps as Parameters<typeof installIpcLayer>[0]);

    const handler = handlers.get(COMMAND_CHANNELS.SETTINGS_UPDATE_APPEARANCE);
    expect(handler).toBeTruthy();
    await handler!(
      {},
      {
        windowId: 'w1',
        requestId: 'r1',
        payload: { partial: { theme: 'tokyonight', terminalFontSize: 15 } },
      },
    );

    // handler 合并 { ...current, ...partial } 后整体写回:传入字段覆盖,其余保留。
    // update 触发 settingsChanged → 广播 SETTINGS_CHANGED + SETTINGS_LOCAL_APPEARANCE_CHANGED
    // (广播在 wireEventBroadcasts,由 settingsManager.on 驱动,本测试不触发)。
    expect(stubs.settingsManager.update).toHaveBeenCalledTimes(1);
    expect(stubs.settingsManager.update).toHaveBeenCalledWith({
      appearance: { ...baseAppearance, theme: 'tokyonight', terminalFontSize: 15 },
    });
  });
});

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

    const result = (await handler!({}, envelope)) as {
      session: SessionInfo;
      pathTreeChanged: boolean;
    };
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

describe('IPC dialog commands over remote transport', () => {
  it.each([
    COMMAND_CHANNELS.BOOKMARK_PICK_FOLDER,
    COMMAND_CHANNELS.SSH_PROFILE_PICK_KEY_FILE,
    COMMAND_CHANNELS.SETTINGS_EXPORT,
    COMMAND_CHANNELS.SETTINGS_IMPORT,
  ])('%s 返回明确的不支持错误，而不是访问 undefined sender', async (channel) => {
    const { installIpcLayer, dispatchCommand } = await freshIpc();
    const { deps } = makeStubs();
    installIpcLayer(deps as Parameters<typeof installIpcLayer>[0]);

    const result = await dispatchCommand(channel, {
      windowId: 'remote-client',
      requestId: `remote-dialog-${channel}`,
      payload: {},
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'RemoteDialogUnavailable',
        message: expect.stringContaining(channel),
      },
    });
    expect(mockDialog.showOpenDialog).not.toHaveBeenCalled();
    expect(mockDialog.showSaveDialog).not.toHaveBeenCalled();
    expect(mockDialog.showMessageBox).not.toHaveBeenCalled();
  });
});

describe('IPC quiesce gate (H4)', () => {
  it('进入退出流程后 dispatchCommand 拒绝新 command(Quiescing)', async () => {
    const { installIpcLayer, dispatchCommand } = await freshIpc();
    const { deps } = makeStubs();
    installIpcLayer(deps as Parameters<typeof installIpcLayer>[0]);

    // 先注册一个正常 handler(如 SETTINGS_GET_APPEARANCE),确认 gate 只在 quiescing 后生效
    const normalHandler = handlers.get(COMMAND_CHANNELS.SETTINGS_GET_APPEARANCE);
    expect(normalHandler).toBeTruthy();

    // freshIpc 的 vi.resetModules 让 app-lifecycle 也是全新实例;ipc.ts 与这里
    // import 同一份(都是 reset 后首次加载),enterQuiescing 会作用于同一模块态。
    const lifecycle = await import('./app-lifecycle');
    lifecycle.enterQuiescing();

    const result = await dispatchCommand(COMMAND_CHANNELS.SETTINGS_GET_APPEARANCE, {
      windowId: 'test-window',
      requestId: 'quiescing-test',
      payload: {},
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'Quiescing',
        message: expect.stringContaining(COMMAND_CHANNELS.SETTINGS_GET_APPEARANCE),
      },
    });
  });
});

describe('IPC WINDOW_CREATE', () => {
  it('透传 backendProfileId/selectSessionId/simpleMode 给客户端本地 WindowManager', async () => {
    const { installIpcLayer } = await freshIpc();
    const { deps, stubs } = makeStubs();
    installIpcLayer(deps as Parameters<typeof installIpcLayer>[0]);

    const handler = handlers.get(COMMAND_CHANNELS.WINDOW_CREATE);
    const result = await handler!(
      {},
      {
        windowId: 'old-local-window',
        requestId: 'new-window-1',
        payload: {
          backendProfileId: 'remote-profile-1',
          selectSessionId: 'remote-session-1',
          simpleMode: true,
        },
      },
    );

    expect(stubs.windowManager.createWindowFromFactory).toHaveBeenCalledWith({
      backendProfileId: 'remote-profile-1',
      selectSessionId: 'remote-session-1',
      simpleMode: true,
    });
    expect(result).toEqual({ windowId: 'new-window', windowNumber: 2 });
  });
});

describe('IPC SESSION_FOCUS_OWNER', () => {
  it('owner 是远程 clientId 时即使 WindowManager 无法聚焦,仍定向发送 focus 事件', async () => {
    const { installIpcLayer } = await freshIpc();
    const { deps, stubs } = makeStubs();
    const remoteOwnerId = 'remote-client-owner';
    const session = {
      id: 'remote-session',
      pathId: 'C:\\remote',
      templateId: 'shell',
      originalCwd: 'C:\\remote',
      currentCwd: 'C:\\remote',
      cols: 80,
      rows: 24,
      pid: 123,
      displayName: 'PowerShell',
      ownerWindowId: remoteOwnerId,
      state: 'active',
      createdAt: Date.now(),
    } satisfies SessionInfo;
    stubs.sessionManager.get.mockReturnValue(session);

    const send = vi.fn();
    deps.clientRegistry.add({ clientId: remoteOwnerId, send });
    installIpcLayer(deps as Parameters<typeof installIpcLayer>[0]);

    const handler = handlers.get(COMMAND_CHANNELS.SESSION_FOCUS_OWNER);
    expect(handler).toBeTruthy();
    await handler!(
      {},
      {
        windowId: 'daemon-local-window',
        requestId: 'focus-1',
        payload: { sessionId: session.id },
      },
    );

    expect(stubs.windowManager.focus).toHaveBeenCalledWith(remoteOwnerId);
    expect(send).toHaveBeenCalledWith(
      EVENT_CHANNELS.WINDOW_FOCUS_REQUESTED,
      expect.objectContaining({
        payload: { reason: 'session-click', selectSessionId: session.id },
      }),
    );
  });
});

describe('IPC command-panel event routing', () => {
  it('commandPanelUpdated 只发给 session owner，不广播给其他 client', async () => {
    const { installIpcLayer } = await freshIpc();
    const { deps, stubs } = makeStubs();
    const ownerId = 'command-owner';
    stubs.sessionManager.get.mockReturnValue({
      id: 'session-1',
      pathId: 'path-1',
      templateId: 'shell',
      originalCwd: '/tmp',
      currentCwd: '/tmp',
      cols: 80,
      rows: 24,
      pid: 123,
      displayName: 'shell',
      ownerWindowId: ownerId,
      state: 'active',
      createdAt: Date.now(),
    } satisfies SessionInfo);
    const ownerSend = vi.fn();
    const otherSend = vi.fn();
    deps.clientRegistry.add({ clientId: ownerId, send: ownerSend });
    deps.clientRegistry.add({ clientId: 'other-client', send: otherSend });
    installIpcLayer(deps as Parameters<typeof installIpcLayer>[0]);

    deps.commandPanelService.emit('commandPanelUpdated', {
      sessionId: 'session-1',
      snapshot: { commands: [], activeKey: null },
      requestActivation: true,
      commandKey: 'cmd-key',
    });

    expect(ownerSend).toHaveBeenCalledWith(
      EVENT_CHANNELS.COMMAND_PANEL_UPDATED,
      expect.objectContaining({
        payload: expect.objectContaining({ sessionId: 'session-1', requestActivation: true }),
      }),
    );
    expect(otherSend).not.toHaveBeenCalled();
  });

  it('命令面板 run 不沿 CodeBlockRunner 原 clientId 外发流式 output/exited', async () => {
    const { installIpcLayer } = await freshIpc();
    const { deps } = makeStubs();
    const originSend = vi.fn();
    deps.clientRegistry.add({ clientId: 'old-owner-a', send: originSend });
    vi.spyOn(deps.commandPanelService, 'isCommandPanelRun').mockReturnValue(true);
    installIpcLayer(deps as Parameters<typeof installIpcLayer>[0]);

    deps.codeBlockRunner.emit('output', {
      runId: 'command-run-1',
      clientId: 'old-owner-a',
      stream: 'stdout',
      data: 'secret',
    });
    deps.codeBlockRunner.emit('exited', {
      runId: 'command-run-1',
      clientId: 'old-owner-a',
      exitCode: 0,
      signal: null,
    });

    expect(originSend).not.toHaveBeenCalled();
  });

  it('set-demand 只用可信 envelope.windowId 作为 consumerId', async () => {
    const { installIpcLayer } = await freshIpc();
    const { deps } = makeStubs();
    const setDemand = vi.spyOn(deps.commandPanelService, 'setDemand');
    installIpcLayer(deps as Parameters<typeof installIpcLayer>[0]);
    const handler = handlers.get(COMMAND_CHANNELS.COMMAND_PANEL_SET_DEMAND);
    expect(handler).toBeTruthy();

    await handler!(
      {},
      {
        windowId: 'trusted-client-id',
        requestId: 'command-demand-1',
        payload: { sessionId: 'session-1', level: 'hot', consumerId: 'spoofed' },
      },
    );

    expect(setDemand).toHaveBeenCalledWith('session-1', 'trusted-client-id', 'hot');
  });
});

describe('IPC GIT demand lifecycle wiring', () => {
  it('owner change 与本地窗口关闭分别清 task demand / consumer', async () => {
    const { installIpcLayer } = await freshIpc();
    const { deps, stubs } = makeStubs();
    const removeConsumer = vi.spyOn(deps.gitService, 'removePollingConsumer');
    installIpcLayer(deps as Parameters<typeof installIpcLayer>[0]);

    const ownerRegistration = stubs.sessionManager.on.mock.calls.find(
      ([event]) => event === 'sessionOwnerChanged',
    );
    expect(ownerRegistration).toBeTruthy();
    const ownerHandler = ownerRegistration![1] as (payload: unknown) => void;
    // M1:git/fileTree/commandPanel 的 demand 清理移到 RuntimeLifecycleCoordinator
    // (见 runtime-lifecycle-coordinator.test.ts)。wireEventBroadcasts 的该 handler
    // 现在只广播 SESSION_OWNER_CHANGED,这里验证 handler 已注册且调用不抛错。
    expect(() =>
      ownerHandler({
        sessionId: 'session-1',
        oldOwnerWindowId: 'window-old',
        newOwnerWindowId: 'window-new',
      }),
    ).not.toThrow();

    const closedHandler = stubs.windowManager.onWindowClosed.mock.calls.at(-1)![0] as (
      windowId: string,
    ) => void;
    closedHandler('window-closed');
    expect(removeConsumer).toHaveBeenCalledWith('window-closed');
    expect(stubs.sessionManager.handleWindowClosed).toHaveBeenCalledWith('window-closed');
  });
});

describe('IPC GIT polling demand', () => {
  it('只用可信 envelope.windowId 作为 consumerId 透传 HOT/WARM/NONE', async () => {
    const { installIpcLayer } = await freshIpc();
    const { deps } = makeStubs();
    const setDemand = vi.spyOn(deps.gitService, 'setPollingDemand').mockImplementation(() => {});
    installIpcLayer(deps as Parameters<typeof installIpcLayer>[0]);

    const handler = handlers.get(COMMAND_CHANNELS.GIT_SET_POLLING_DEMAND);
    expect(handler).toBeTruthy();
    await handler!(
      {},
      {
        windowId: 'trusted-client-id',
        requestId: 'git-demand-1',
        payload: { sessionId: 'session-1', level: 'hot', consumerId: 'spoofed' },
      },
    );

    expect(setDemand).toHaveBeenCalledWith('session-1', 'trusted-client-id', 'hot');
  });
});

describe('IPC PERFORMANCE', () => {
  it('status/write/profile 四条本地命令透传到诊断器且 profile 缺省为 15 秒', async () => {
    const { installIpcLayer } = await freshIpc();
    const { deps, stubs } = makeStubs();
    installIpcLayer(deps as Parameters<typeof installIpcLayer>[0]);
    const envelope = { windowId: 'local', requestId: 'perf-1', payload: {} };

    expect(handlers.get(COMMAND_CHANNELS.PERFORMANCE_GET_STATUS)!({}, envelope)).toBe(
      stubs.performanceDiagnostics.getStatus(),
    );
    await expect(
      handlers.get(COMMAND_CHANNELS.PERFORMANCE_WRITE_REPORT)!({}, envelope),
    ).resolves.toBe(stubs.performanceDiagnostics.getStatus());
    await expect(
      handlers.get(COMMAND_CHANNELS.PERFORMANCE_CAPTURE_CPU_PROFILE)!({}, envelope),
    ).resolves.toMatchObject({ durationSeconds: 15 });
    expect(stubs.performanceDiagnostics.writeReportNow).toHaveBeenCalledOnce();
    expect(stubs.performanceDiagnostics.captureCpuProfile).toHaveBeenCalledWith(15);
  });

  it('打开报告目录时传播 shell.openPath 的错误字符串', async () => {
    const reportDir = await mkdtemp(join(tmpdir(), 'marina-ipc-performance-'));
    try {
      const { installIpcLayer } = await freshIpc();
      const { deps, stubs } = makeStubs();
      stubs.performanceDiagnostics.getReportDir.mockReturnValue(reportDir);
      mockShell.openPath.mockResolvedValueOnce('Explorer unavailable');
      installIpcLayer(deps as Parameters<typeof installIpcLayer>[0]);

      const envelope = { windowId: 'local', requestId: 'perf-open', payload: {} };
      await expect(
        handlers.get(COMMAND_CHANNELS.PERFORMANCE_OPEN_REPORTS_DIR)!({}, envelope),
      ).rejects.toThrow('Explorer unavailable');
    } finally {
      await rm(reportDir, { recursive: true, force: true });
    }
  });
});

describe('IPC FILE_TREE', () => {
  it('将 envelope windowId 作为 requesterId 传给受限文件树服务', async () => {
    const { installIpcLayer } = await freshIpc();
    const { deps, stubs } = makeStubs();
    installIpcLayer(deps as Parameters<typeof installIpcLayer>[0]);

    const handler = handlers.get(COMMAND_CHANNELS.FILE_TREE_LIST_DIRECTORY);
    expect(handler).toBeTruthy();
    await handler!(
      {},
      {
        windowId: 'owner-client',
        requestId: 'file-tree-1',
        payload: { sessionId: 'session-1', rootId: 'managed-workspace', relativePath: 'docs' },
      },
    );

    expect(stubs.fileTreeService.listDirectory).toHaveBeenCalledWith(
      'session-1',
      'owner-client',
      'managed-workspace',
      'docs',
    );
  });
});

describe('IPC file-panel owner 校验 (H2)', () => {
  // H2(架构复核):file-panel/gallery 命令携带文件绝对路径/内容,只允许当前
  // owner client 操作。helper 在 IPC adapter 层(requireFilePanelOwner)校验,
  // 不进 FilePanelService core;终端内 HTTP agent 的 program-push 不经这些 IPC。

  function ownerSession(owner: string | null): SessionInfo {
    return {
      id: 'sess-owner',
      pathId: '',
      templateId: 'shell',
      originalCwd: '/tmp',
      currentCwd: '/tmp',
      cols: 80,
      rows: 24,
      pid: 1234,
      displayName: 'shell',
      ownerWindowId: owner,
      state: 'active',
      createdAt: Date.now(),
    };
  }

  it('owner 匹配时放行,filePanelService 被调用', async () => {
    const { installIpcLayer } = await freshIpc();
    const { deps, stubs } = makeStubs();
    stubs.sessionManager.get.mockImplementation((sessionId: string) =>
      sessionId === 'sess-owner' ? ownerSession('win-owner') : null,
    );
    installIpcLayer(deps as Parameters<typeof installIpcLayer>[0]);

    const handler = handlers.get(COMMAND_CHANNELS.FILE_PANEL_GET_OPEN_FILES);
    expect(handler).toBeTruthy();
    const result = await handler!(
      {},
      {
        windowId: 'win-owner',
        requestId: 'fp-1',
        payload: { sessionId: 'sess-owner' },
      },
    );

    // 放行:filePanelService.getOpenFiles 被真实调用(未 start 返回空快照)
    expect(result).toEqual({ files: [], activePath: null });
    // 确认没有提前抛 owner 错误:getOpenFiles 走到了 service 层
    expect(stubs.sessionManager.get).toHaveBeenCalledWith('sess-owner');
  });

  it('非 owner client 被拒: 抛 NotOwner(code)', async () => {
    const { installIpcLayer, dispatchCommand } = await freshIpc();
    const { deps, stubs } = makeStubs();
    stubs.sessionManager.get.mockImplementation((sessionId: string) =>
      sessionId === 'sess-owner' ? ownerSession('win-owner') : null,
    );
    installIpcLayer(deps as Parameters<typeof installIpcLayer>[0]);

    // WS 路径(dispatchCommand):envelope.windowId 被 daemon 强制填 clientId,
    // 非 owner 的 client 应收到结构化 NotOwner 错误。
    const result = await dispatchCommand(COMMAND_CHANNELS.FILE_PANEL_GET_OPEN_FILES, {
      windowId: 'intruder-client',
      requestId: 'fp-2',
      payload: { sessionId: 'sess-owner' },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'NotOwner',
        message: expect.stringContaining('sess-owner'),
      },
    });
  });

  it('session 不存在时被拒: 抛 SessionNotFound(code)', async () => {
    const { installIpcLayer, dispatchCommand } = await freshIpc();
    const { deps } = makeStubs();
    installIpcLayer(deps as Parameters<typeof installIpcLayer>[0]);

    const result = await dispatchCommand(COMMAND_CHANNELS.FILE_PANEL_OPEN, {
      windowId: 'any-client',
      requestId: 'fp-3',
      payload: { sessionId: 'no-such-session', path: '/etc/passwd' },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'SessionNotFound',
        message: expect.stringContaining('no-such-session'),
      },
    });
  });

  it('gallery 命令同样受 owner 校验约束', async () => {
    const { installIpcLayer, dispatchCommand } = await freshIpc();
    const { deps, stubs } = makeStubs();
    stubs.sessionManager.get.mockImplementation((sessionId: string) =>
      sessionId === 'sess-owner' ? ownerSession('win-owner') : null,
    );
    installIpcLayer(deps as Parameters<typeof installIpcLayer>[0]);

    const result = await dispatchCommand(COMMAND_CHANNELS.GALLERY_RESOLVE_IMAGE, {
      windowId: 'intruder-client',
      requestId: 'fp-4',
      payload: { sessionId: 'sess-owner', mdPath: '/tmp/x.md', src: './a.png' },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'NotOwner',
        message: expect.stringContaining('sess-owner'),
      },
    });
  });
});
