/**
 * @file src/renderer/terminal-link-router.test.ts
 * @purpose 测 terminal-link-router.ts 的 URI 分类路由(方案-终端可交互链接-20260912)。
 *   纯函数,actions 用记录型 fake,断言「点了什么 → 走哪条路、参数是什么」。
 */
import { describe, expect, it } from 'vitest';
import {
  routeTerminalUri,
  terminalLinkTooltipText,
  type TerminalLinkActions,
} from './terminal-link-router';

function makeActions() {
  const calls: { external?: string; marina?: string; path?: [string[], number | undefined] } = {};
  const actions: TerminalLinkActions = {
    openExternal(url) {
      calls.external = url;
    },
    runMarinaLink(href) {
      calls.marina = href;
    },
    openPath(candidates, line) {
      calls.path = [candidates, line];
    },
  };
  return { actions, calls };
}

describe('routeTerminalUri 分类', () => {
  it('https / http / mailto → openExternal(大小写不敏感)', () => {
    for (const uri of ['https://a.dev/x', 'HTTP://A.DEV', 'mailto:a@b.dev']) {
      const { actions, calls } = makeActions();
      routeTerminalUri(uri, actions);
      expect(calls.external).toBe(uri);
    }
  });

  it('marina: 动作链接 → runMarinaLink(href 原样透传,renderer 不解析)', () => {
    const { actions, calls } = makeActions();
    const href = 'marina:show%20%22C%3A%5Cx.ts%22%20--line%2042';
    routeTerminalUri(href, actions);
    expect(calls.marina).toBe(href);
  });

  it('#anchor → 无操作(终端无文档内导航语义)', () => {
    const { actions, calls } = makeActions();
    routeTerminalUri('#section', actions);
    expect(calls).toEqual({});
  });

  it('其余 URI → 路径分支(path:line 支持行号)', () => {
    const { actions, calls } = makeActions();
    routeTerminalUri('src/x.ts:42', actions);
    expect(calls.path).toEqual([['src/x.ts'], 42]);

    const { actions: a2, calls: c2 } = makeActions();
    routeTerminalUri('D:/docs/report.md', a2);
    expect(c2.path).toEqual([['D:/docs/report.md'], undefined]);
  });

  it('空 / 非字符串 → 静默 no-op', () => {
    const { actions, calls } = makeActions();
    routeTerminalUri('', actions);
    expect(calls).toEqual({});
  });
});

describe('terminalLinkTooltipText 知情通道', () => {
  it('marina: 链接显示解码后的命令原文(长 URL 缩短 / run 无确认的知情兜底)', () => {
    expect(terminalLinkTooltipText('marina:show%20a.md%20--line%2042')).toBe('show a.md --line 42');
  });

  it('其它 URI 原样显示', () => {
    expect(terminalLinkTooltipText('https://a.dev/very/long/url')).toBe(
      'https://a.dev/very/long/url',
    );
  });
});
