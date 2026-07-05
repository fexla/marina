/**
 * @file src/main/window-manager.test.ts
 * @purpose WindowManager 单元测试。覆盖编号分配、增删查、回调、上限。
 *
 * @关键设计:
 * - 用 vi.mock + vi.hoisted 替换 electron 模块,提供最小 BrowserWindow stub。
 *   vi.hoisted 把 mock class 的定义和 vi.mock 一起提升到模块顶部,
 *   避免 "Cannot access before initialization" 错误。
 * - 不需要真的 Electron runtime — WindowManager 的逻辑本身和 Electron
 *   解耦,只调用 BrowserWindow 的少数方法。
 * - 测试关注"分配/查询/计数/回调"这些可以确定性断言的行为。
 *
 * @对应文档章节: AGENTS.md 5.3 (核心管理器必测);
 *   软件定义书.md 6.7 (窗口编号规则)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted: 把 mock class 定义连同 vi.mock 提升到模块顶部,
// 解决"Cannot access X before initialization"问题
const { MockBrowserWindow } = vi.hoisted(() => {
  type MockListener = (...args: unknown[]) => void;

  class MockBrowserWindow {
    static instances: MockBrowserWindow[] = [];
    static nextWebContentsId = 100;

    public readonly webContents: {
      id: number;
      openDevTools: () => void;
      toggleDevTools: () => void;
      on: (event: string, listener: MockListener) => unknown;
      // J1:setWindowOpenHandler stub
      setWindowOpenHandler: (
        handler: (details: { url: string }) => { action: 'deny' | 'allow' },
      ) => void;
      reload: () => void;
      send: (channel: string, payload: unknown) => void;
    };
    private listeners = new Map<string, MockListener[]>();
    private onceListeners = new Map<string, MockListener[]>();
    public closed = false;
    public minimized = false;
    public focused = false;
    public destroyed = false;
    /** 最近一次 loadURL 的 url(createWindow 测试验 ?backend= 注入用)。 */
    public lastUrl: string | null = null;

    constructor(public readonly options: Record<string, unknown>) {
      this.webContents = {
        id: MockBrowserWindow.nextWebContentsId++,
        openDevTools: vi.fn(),
        toggleDevTools: vi.fn(),
        on: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        reload: vi.fn(),
        send: vi.fn(),
      };
      MockBrowserWindow.instances.push(this);
    }

    on(event: string, listener: MockListener): this {
      const list = this.listeners.get(event) ?? [];
      list.push(listener);
      this.listeners.set(event, list);
      return this;
    }

    once(event: string, listener: MockListener): this {
      const list = this.onceListeners.get(event) ?? [];
      list.push(listener);
      this.onceListeners.set(event, list);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
      const onceList = this.onceListeners.get(event) ?? [];
      this.onceListeners.delete(event);
      for (const listener of onceList) listener(...args);
    }

    loadURL(url: string): Promise<void> {
      this.lastUrl = url;
      return Promise.resolve();
    }
    loadFile(_path: string, _options?: { search: string }): Promise<void> {
      return Promise.resolve();
    }
    show(): void {}
    close(): void {
      if (this.closed) return;
      this.closed = true;
      this.destroyed = true;
      this.emit('closed');
    }
    focus(): void {
      this.focused = true;
      this.emit('focus');
    }
    isMinimized(): boolean {
      return this.minimized;
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    restore(): void {
      this.minimized = false;
    }

    static reset(): void {
      MockBrowserWindow.instances = [];
      MockBrowserWindow.nextWebContentsId = 100;
    }
  }

  return { MockBrowserWindow };
});

vi.mock('electron', () => ({
  BrowserWindow: MockBrowserWindow,
}));

// 必须在 vi.mock 注册之后再 import 被测模块
import { WindowManager } from './window-manager';

describe('WindowManager', () => {
  let mgr: WindowManager;

  beforeEach(() => {
    MockBrowserWindow.reset();
    mgr = new WindowManager();
  });

  afterEach(() => {
    // 清掉所有可能未关闭的 mock 窗口,避免 listener 泄漏到下一个测试
    for (const win of MockBrowserWindow.instances) {
      if (!win.closed) win.close();
    }
  });

  describe('createWindow', () => {
    it('分配单调递增的 windowNumber 从 1 开始', () => {
      const a = mgr.createWindow();
      const b = mgr.createWindow();
      const c = mgr.createWindow();
      expect(a.number).toBe(1);
      expect(b.number).toBe(2);
      expect(c.number).toBe(3);
    });

    it('windowId 是 UUID 格式且互不相同', () => {
      const ids = [mgr.createWindow().id, mgr.createWindow().id, mgr.createWindow().id];
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      for (const id of ids) {
        expect(id).toMatch(uuidRegex);
      }
      expect(new Set(ids).size).toBe(3);
    });

    it('electronWindowId 来自真实 webContents.id', () => {
      const info = mgr.createWindow();
      expect(typeof info.electronWindowId).toBe('number');
      expect(info.electronWindowId).toBeGreaterThanOrEqual(100);
    });

    it('关闭窗口后编号不复用 (软件定义书 6.7)', () => {
      const a = mgr.createWindow(); // 1
      const b = mgr.createWindow(); // 2
      mgr.closeWindow(a.id);
      const c = mgr.createWindow(); // 3,不是 1
      expect(c.number).toBe(3);
      // b 仍然在,且编号 2 不变
      expect(mgr.list().some((w) => w.id === b.id && w.number === 2)).toBe(true);
    });

    it('达到 MAX_WINDOWS (20) 时 throw', () => {
      // 创建 20 个,第 21 个应失败
      for (let i = 0; i < 20; i++) mgr.createWindow();
      expect(() => mgr.createWindow()).toThrow(/MaxWindowsReached/);
    });

    it('每窗口后端:backendProfileId 注入 URL ?backend= + 写入 WindowInfo', () => {
      MockBrowserWindow.reset();
      const mgr = new WindowManager();
      const info = mgr.createWindow({ backendProfileId: 'profile-xyz' });
      expect(info.backendProfileId).toBe('profile-xyz');
      const win = MockBrowserWindow.instances[MockBrowserWindow.instances.length - 1]!;
      expect(win.lastUrl).toContain('backend=profile-xyz');
    });

    it('每窗口后端:无 backendProfileId 时 URL 不含 backend= + WindowInfo.backendProfileId=null', () => {
      MockBrowserWindow.reset();
      const mgr = new WindowManager();
      const info = mgr.createWindow();
      expect(info.backendProfileId).toBeNull();
      const win = MockBrowserWindow.instances[MockBrowserWindow.instances.length - 1]!;
      expect(win.lastUrl).not.toContain('backend=');
    });
  });

  describe('closeWindow', () => {
    it('已存在的 windowId 关闭返回 true,从 list 中消失', () => {
      const a = mgr.createWindow();
      mgr.createWindow();
      expect(mgr.count()).toBe(2);

      const result = mgr.closeWindow(a.id);
      expect(result).toBe(true);
      expect(mgr.count()).toBe(1);
      expect(mgr.list().find((w) => w.id === a.id)).toBeUndefined();
    });

    it('不存在的 windowId 返回 false,不抛错', () => {
      expect(mgr.closeWindow('nonexistent-id')).toBe(false);
    });

    it('触发 onWindowClosed 回调,带正确 windowId', () => {
      const closedHandler = vi.fn();
      mgr.onWindowClosed(closedHandler);
      const a = mgr.createWindow();
      mgr.closeWindow(a.id);
      expect(closedHandler).toHaveBeenCalledTimes(1);
      expect(closedHandler).toHaveBeenCalledWith(a.id);
    });
  });

  describe('closeAll', () => {
    it('关闭所有窗口,count 归零', () => {
      mgr.createWindow();
      mgr.createWindow();
      mgr.createWindow();
      mgr.closeAll();
      expect(mgr.count()).toBe(0);
      expect(mgr.list()).toEqual([]);
    });
  });

  describe('查询 API', () => {
    it('getById 返回对应的 BrowserWindow,不存在返回 null', () => {
      const a = mgr.createWindow();
      expect(mgr.getById(a.id)).not.toBeNull();
      expect(mgr.getById('nonexistent')).toBeNull();
    });

    it('getByElectronId 通过 webContents.id 反查', () => {
      const a = mgr.createWindow();
      const win = mgr.getByElectronId(a.electronWindowId);
      expect(win).not.toBeNull();
      expect(mgr.getByElectronId(99999)).toBeNull();
    });

    it('list 返回当前所有窗口的 info 副本', () => {
      const a = mgr.createWindow();
      const b = mgr.createWindow();
      const list = mgr.list();
      expect(list).toHaveLength(2);
      expect(list.map((w) => w.id).sort()).toEqual([a.id, b.id].sort());
      // 修改副本不影响内部状态
      list[0]!.number = 999;
      expect(mgr.list().find((w) => w.number === 999)).toBeUndefined();
    });
  });

  describe('focus', () => {
    it('已存在的窗口 focus 返回 true', () => {
      const a = mgr.createWindow();
      expect(mgr.focus(a.id)).toBe(true);
    });

    it('不存在的窗口 focus 返回 false', () => {
      expect(mgr.focus('nonexistent')).toBe(false);
    });

    it('focus 时若窗口被最小化则恢复', () => {
      const a = mgr.createWindow();
      const win = mgr.getById(a.id) as unknown as InstanceType<typeof MockBrowserWindow>;
      win.minimized = true;
      mgr.focus(a.id);
      expect(win.minimized).toBe(false);
      expect(win.focused).toBe(true);
    });
  });

  describe('getMostRecentlyActive', () => {
    it('无窗口时返回 null', () => {
      expect(mgr.getMostRecentlyActive()).toBeNull();
    });

    it('返回最近 focus 过的窗口', async () => {
      const a = mgr.createWindow();
      // 等几毫秒确保时间戳能区分
      await new Promise((r) => setTimeout(r, 5));
      const b = mgr.createWindow();
      // b 是最新创建,默认 lastFocusedAt 比 a 晚
      expect(mgr.getMostRecentlyActive()).toBe(mgr.getById(b.id));

      // a 重新获得焦点
      await new Promise((r) => setTimeout(r, 5));
      mgr.focus(a.id);
      expect(mgr.getMostRecentlyActive()).toBe(mgr.getById(a.id));
    });
  });

  describe('onWindowCreated', () => {
    it('每次创建窗口时触发,带 info 与 BrowserWindow', () => {
      const handler = vi.fn();
      mgr.onWindowCreated(handler);
      const a = mgr.createWindow();
      const b = mgr.createWindow();
      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenNthCalledWith(1, a, expect.any(MockBrowserWindow));
      expect(handler).toHaveBeenNthCalledWith(2, b, expect.any(MockBrowserWindow));
    });

    it('handler 抛错不影响窗口创建本身', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mgr.onWindowCreated(() => {
        throw new Error('test handler failure');
      });
      expect(() => mgr.createWindow()).not.toThrow();
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });
});
