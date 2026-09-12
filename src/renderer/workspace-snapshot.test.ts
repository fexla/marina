/**
 * @file workspace-snapshot.test.ts
 * @purpose 守护 deriveRestoredScroll(ADR-039:快照恢复时命令条目与面板内视图的
 *   推导规则)。只测纯函数 —— restoreWorkspaceSnapshot/doWriteSnapshot 的 IPC
 *   编排依赖 window.api,由 store 层与 main 侧测试覆盖。
 */
import { describe, expect, it } from 'vitest';
import { deriveRestoredScroll } from './workspace-snapshot';
import type { WorkspaceFilePanelSnapshot } from '@shared/protocol';

function makeSnapshot(
  partial: Partial<WorkspaceFilePanelSnapshot> = {},
): WorkspaceFilePanelSnapshot {
  return {
    version: 1,
    openedFiles: [],
    activeFilePath: null,
    scroll: {},
    runs: [],
    ...partial,
  };
}

describe('deriveRestoredScroll(ADR-039 命令页与文档同一快照)', () => {
  it('文件条目:kind 从 openedFiles 推,不在列表的孤儿条目跳过', () => {
    const { scroll, view } = deriveRestoredScroll(
      makeSnapshot({
        openedFiles: [{ path: 'a.md', kind: 'markdown', external: false }],
        scroll: {
          'a.md': { scrollTop: 10, scrollLeft: 0 },
          'gone.md': { scrollTop: 99, scrollLeft: 0 },
        },
      }),
    );
    expect(scroll).toEqual({ 'a.md': { scrollTop: 10, scrollLeft: 0, kind: 'markdown' } });
    expect(view).toBe('file');
  });

  it('命令条目:kind=command,按 commandPanel.commands 的 key 校验,孤儿跳过', () => {
    const { scroll } = deriveRestoredScroll(
      makeSnapshot({
        commandPanel: {
          version: 2,
          commands: [
            {
              key: 'k1',
              command: 'git status',
              title: null,
              refreshPolicy: { scope: 'foreground', interval: '30s' },
              lastRunId: null,
              lastExitCode: 0,
              status: 'idle',
              output: '',
              lastRunAt: null,
            },
          ],
          activeKey: 'k1',
        },
        scroll: {
          'command:k1': { scrollTop: 300, scrollLeft: 2 },
          'command:closed': { scrollTop: 50, scrollLeft: 0 },
        },
      }),
    );
    expect(scroll).toEqual({
      'command:k1': { scrollTop: 300, scrollLeft: 2, kind: 'command' },
    });
  });

  it('视图:显式 panelView 优先(即使与推导规则相反)', () => {
    const { view } = deriveRestoredScroll(
      makeSnapshot({
        openedFiles: [{ path: 'a.md', kind: 'markdown', external: false }],
        activeFilePath: 'a.md',
        commandPanel: { version: 2, commands: [], activeKey: 'k9' },
        panelView: 'command',
      }),
    );
    expect(view).toBe('command');
  });

  it('视图:旧快照无 panelView → 按 active 推导(有 active 命令且无 active 文件=命令侧)', () => {
    const commandSide = deriveRestoredScroll(
      makeSnapshot({
        commandPanel: {
          version: 2,
          commands: [
            {
              key: 'k1',
              command: 'x',
              title: null,
              refreshPolicy: { scope: 'foreground', interval: 'manual' },
              lastRunId: null,
              lastExitCode: 0,
              status: 'idle',
              output: '',
              lastRunAt: null,
            },
          ],
          activeKey: 'k1',
        },
      }),
    );
    expect(commandSide.view).toBe('command');

    const fileSide = deriveRestoredScroll(
      makeSnapshot({
        openedFiles: [{ path: 'a.md', kind: 'markdown', external: false }],
        activeFilePath: 'a.md',
        commandPanel: { version: 2, commands: [], activeKey: null },
      }),
    );
    expect(fileSide.view).toBe('file');

    // 旧格式(完全没有命令切片)→ 默认文件侧。
    expect(deriveRestoredScroll(makeSnapshot()).view).toBe('file');
  });
});
