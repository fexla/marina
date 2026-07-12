/**
 * @file src/shared/protocol.test.ts
 * @purpose 协议常量的烟雾测试,主要目的是验证 Vitest 配置 + alias + TS 编译链路
 *   全部跑通,作为 CP-1 项目初始化阶段的"框架可用性"基线测试。
 *
 * @对应文档章节: AGENTS.md 5.3 (协议类必测)
 *
 * @CP-1 阶段:
 * 这里只断言不会变的常量。真正的 IPC schema 测试在 CP-2 起,handler 注册
 * 后才有意义。
 */
import { describe, expect, it } from 'vitest';
import {
  COMMAND_CHANNELS,
  EVENT_CHANNELS,
  PROTOCOL_VERSION,
  REMOTE_DAEMON_DEFAULT_PORT,
  REMOTE_DAEMON_PORT_MAX,
  REMOTE_DAEMON_PORT_MIN,
  getCommandRouting,
  type CommandEnvelope,
  type EventEnvelope,
} from './protocol';

describe('protocol constants', () => {
  it('PROTOCOL_VERSION is a positive integer', () => {
    expect(PROTOCOL_VERSION).toBe(2);
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });

  it('host-only daemon discovery uses one shared 10-port range', () => {
    expect(REMOTE_DAEMON_DEFAULT_PORT).toBe(32780);
    expect(REMOTE_DAEMON_PORT_MIN).toBe(32780);
    expect(REMOTE_DAEMON_PORT_MAX).toBe(32789);
    expect(REMOTE_DAEMON_PORT_MAX - REMOTE_DAEMON_PORT_MIN + 1).toBe(10);
  });

  it('all command channels start with cmd: prefix', () => {
    for (const channel of Object.values(COMMAND_CHANNELS)) {
      expect(channel).toMatch(/^cmd:[a-z-]+:[a-z-]+$/);
    }
  });

  it('all event channels start with evt: prefix', () => {
    // v1.3 起 domain 允许 kebab-case(与 cmd 一致,为容纳 explorer-integration)
    for (const channel of Object.values(EVENT_CHANNELS)) {
      expect(channel).toMatch(/^evt:[a-z-]+:[a-z-]+$/);
    }
  });

  it('command and event channel names are unique', () => {
    const all = [...Object.values(COMMAND_CHANNELS), ...Object.values(EVENT_CHANNELS)];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('command routing (每窗口后端架构边界)', () => {
  it('窗口控制命令路由为 local-control', () => {
    expect(getCommandRouting(COMMAND_CHANNELS.WINDOW_MINIMIZE)).toBe('local-control');
    expect(getCommandRouting(COMMAND_CHANNELS.WINDOW_TOGGLE_MAXIMIZE)).toBe('local-control');
    expect(getCommandRouting(COMMAND_CHANNELS.WINDOW_CLOSE_SELF)).toBe('local-control');
    expect(getCommandRouting(COMMAND_CHANNELS.WINDOW_CREATE)).toBe('local-control');
    expect(getCommandRouting(COMMAND_CHANNELS.WINDOW_FOCUS)).toBe('local-control');
  });

  it('远程 profile 凭据管理路由为 local-control(不能发给当前 daemon)', () => {
    expect(getCommandRouting(COMMAND_CHANNELS.REMOTE_PROFILE_LIST)).toBe('local-control');
    expect(getCommandRouting(COMMAND_CHANNELS.REMOTE_PROFILE_ADD)).toBe('local-control');
    expect(getCommandRouting(COMMAND_CHANNELS.REMOTE_PROFILE_GET_CONNECTION)).toBe('local-control');
  });

  it('剪贴板/外部链接路由为 local-control(客户端本机资源)', () => {
    expect(getCommandRouting(COMMAND_CHANNELS.SYSTEM_CLIPBOARD_READ_TEXT)).toBe('local-control');
    expect(getCommandRouting(COMMAND_CHANNELS.SYSTEM_CLIPBOARD_WRITE_TEXT)).toBe('local-control');
    expect(getCommandRouting(COMMAND_CHANNELS.SYSTEM_OPEN_EXTERNAL)).toBe('local-control');
  });

  it('daemon 服务端管理路由为 local-control(当前客户端机器的服务)', () => {
    expect(getCommandRouting(COMMAND_CHANNELS.REMOTE_DAEMON_START)).toBe('local-control');
    expect(getCommandRouting(COMMAND_CHANNELS.REMOTE_DAEMON_STOP)).toBe('local-control');
    expect(getCommandRouting(COMMAND_CHANNELS.REMOTE_DAEMON_GET_STATUS)).toBe('local-control');
    expect(getCommandRouting(COMMAND_CHANNELS.REMOTE_DAEMON_SET_PORT)).toBe('local-control');
    expect(getCommandRouting(COMMAND_CHANNELS.REMOTE_DAEMON_SET_PASSWORD)).toBe('local-control');
  });

  it('APP_QUIT 路由为 local-control(退出当前客户端进程)', () => {
    expect(getCommandRouting(COMMAND_CHANNELS.APP_QUIT)).toBe('local-control');
  });

  it('session/path/template/settings 等业务命令路由为 backend-data', () => {
    expect(getCommandRouting(COMMAND_CHANNELS.SESSION_CREATE)).toBe('backend-data');
    expect(getCommandRouting(COMMAND_CHANNELS.SESSION_GET_SCROLLBACK)).toBe('backend-data');
    expect(getCommandRouting(COMMAND_CHANNELS.BOOKMARK_ADD)).toBe('backend-data');
    expect(getCommandRouting(COMMAND_CHANNELS.SETTINGS_GET)).toBe('backend-data');
    expect(getCommandRouting(COMMAND_CHANNELS.APP_GET_SNAPSHOT)).toBe('backend-data');
  });

  it('文件面板命令路由为 backend-data(session 在 daemon 上,文件操作走 daemon)', () => {
    expect(getCommandRouting(COMMAND_CHANNELS.FILE_PANEL_GET_OPEN_FILES)).toBe('backend-data');
    expect(getCommandRouting(COMMAND_CHANNELS.FILE_PANEL_READ)).toBe('backend-data');
    expect(getCommandRouting(COMMAND_CHANNELS.FILE_PANEL_OPEN)).toBe('backend-data');
  });
});

describe('envelope shapes (compile-time)', () => {
  // 这些断言主要为编译期类型检查;运行时行为只是 sanity check。
  it('CommandEnvelope has windowId / requestId / payload', () => {
    const envelope: CommandEnvelope<{ foo: number }> = {
      windowId: 'w1',
      requestId: 'r1',
      payload: { foo: 42 },
    };
    expect(envelope.payload.foo).toBe(42);
  });

  it('EventEnvelope has eventId / timestamp / payload', () => {
    const envelope: EventEnvelope<string> = {
      eventId: 'e1',
      timestamp: Date.now(),
      payload: 'hello',
    };
    expect(typeof envelope.timestamp).toBe('number');
    expect(envelope.payload).toBe('hello');
  });
});
