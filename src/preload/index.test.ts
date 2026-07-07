/**
 * @file src/preload/index.test.ts
 * @purpose 覆盖远程 preload 的关键安全分支:远程 profile 配置缺失 / 密码无法解密时,
 *   绝不能静默 fallback 到本地 IPC。
 *
 * @关键设计:
 * - preload/index.ts 是 Electron preload 入口,通常不做业务测试；但远程后端引入后,
 *   `ensureTransport()` 成为安全边界:用户明确打开远程窗口时,失败必须显式报错。
 * - 0.2.5 修复 connection=null 分支遗漏 throw 的问题。此前该分支会让
 *   `invoke()` 在 remoteTransport=null 时继续走本地 ipcRenderer.invoke,造成“看似连接上,
 *   实际操作本地后端”的隐蔽错误。
 *
 * @对应文档章节:docs/ipc-protocol.md 远程后端;软件定义书 ADR-015
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMAND_CHANNELS, EVENT_CHANNELS } from '@shared/protocol';

let exposedApi: any;
let invokeMock: any;
let onMock: any;
let removeListenerMock: any;

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn((_name: string, api: unknown) => {
      exposedApi = api;
    }),
  },
  ipcRenderer: {
    invoke: (...args: unknown[]) => invokeMock(...args),
    on: (...args: unknown[]) => onMock(...args),
    removeListener: (...args: unknown[]) => removeListenerMock(...args),
  },
  webFrame: {
    setZoomFactor: vi.fn(),
  },
}));

describe('preload remote backend guard', () => {
  beforeEach(() => {
    vi.resetModules();
    exposedApi = undefined;
    onMock = vi.fn();
    removeListenerMock = vi.fn();
    invokeMock = vi.fn(async (channel: string) => {
      if (channel === COMMAND_CHANNELS.REMOTE_PROFILE_GET_CONNECTION) {
        return { connection: null };
      }
      return { unexpectedLocalFallback: channel };
    });

    vi.stubGlobal('window', {
      location: {
        search: '?windowId=w-test&windowNumber=7&backend=remote-profile-1',
        href: 'file:///index.html?windowId=w-test&windowNumber=7&backend=remote-profile-1',
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      history: { replaceState: vi.fn() },
    });
  });

  it('connection=null 时抛 PROFILE_INCOMPLETE,不能 fallback 到本地 invoke', async () => {
    await import('./index');
    expect(exposedApi).toBeTruthy();

    await expect(exposedApi.invoke(COMMAND_CHANNELS.APP_GET_SNAPSHOT, {})).rejects.toMatchObject({
      code: 'PROFILE_INCOMPLETE',
    });

    // 只允许调用一次:拉远程连接信息。若 bug 复发,第二次会 fallback 到本地 APP_GET_SNAPSHOT。
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith(
      COMMAND_CHANNELS.REMOTE_PROFILE_GET_CONNECTION,
      expect.objectContaining({ payload: { profileId: 'remote-profile-1' } }),
    );
  });

  it('远程窗口 on() 不应先注册本地 ipcRenderer 事件', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await import('./index');
      expect(exposedApi).toBeTruthy();

      const off = exposedApi.on(EVENT_CHANNELS.SESSION_OUTPUT, vi.fn());
      await Promise.resolve();
      off();

      expect(onMock).not.toHaveBeenCalled();
      expect(removeListenerMock).not.toHaveBeenCalled();
      expect(invokeMock).toHaveBeenCalledWith(
        COMMAND_CHANNELS.REMOTE_PROFILE_GET_CONNECTION,
        expect.objectContaining({ payload: { profileId: 'remote-profile-1' } }),
      );
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
