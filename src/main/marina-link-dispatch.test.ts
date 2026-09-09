/**
 * @file src/main/marina-link-dispatch.test.ts
 * @purpose 守护 marina: 动作链接的 main 端分发契约(v0.3.3 ADR-035):
 *   show(run 有/无 mdPath、--heading 透传)/ run(title、clientId)/ 语法错透传。
 *
 * @为什么值得测:分发直接决定「点击文档里的链接会发生什么」—— 路径解析基准
 *   (mdPath 目录 vs session cwd)与服务参数(title/clientId)任何漂移都是
 *   静默的行为变化,IPC 层不测(重装配),这里用 fake 服务钉住调用形状。
 */
import { describe, expect, it } from 'vitest';
import { dispatchMarinaLink, MarinaLinkError } from './marina-link-dispatch';
import type { FilePanelService } from './file-panel-service';
import type { CommandPanelService } from './command-panel-service';
import type { FilePanelSnapshot } from '@shared/protocol';

/** 空快照:fake 服务只需要「被怎么调」,返回值走个合法形状即可。 */
const emptySnapshot = (): FilePanelSnapshot => ({ files: [], activePath: null });

/** 调用记录 fake:只需要「被怎么调」,不需要真状态机。 */
function makeDeps() {
  const calls: {
    openFile?: unknown[];
    openFileFromMarkdown?: unknown[];
    runCommand?: unknown[];
  } = {};
  const deps = {
    filePanelService: {
      async openFile(...args: unknown[]): Promise<FilePanelSnapshot> {
        calls.openFile = args;
        return emptySnapshot();
      },
      async openFileFromMarkdown(...args: unknown[]): Promise<FilePanelSnapshot> {
        calls.openFileFromMarkdown = args;
        return emptySnapshot();
      },
    },
    commandPanelService: {
      // runCommand 的真身返回 CommandPanelSnapshot;fake 只需合法形状,这里
      // 复用 emptySnapshot 并在整体 as 断言下对齐(调用形状才是被测对象)。
      async runCommand(...args: unknown[]): Promise<unknown> {
        calls.runCommand = args;
        return emptySnapshot();
      },
    },
  } as unknown as Parameters<typeof dispatchMarinaLink>[0];
  return { deps, calls };
}

describe('dispatchMarinaLink: show', () => {
  it('有 mdPath → openFileFromMarkdown(文档目录基准 + 成员校验防线)', async () => {
    const { deps, calls } = makeDeps();
    const result = await dispatchMarinaLink(
      deps,
      'sid-1',
      'D:/ws/report.md',
      'marina:show issue-42.md',
      'win-1',
    );
    expect(result).toEqual({ kind: 'show' });
    expect(calls.openFileFromMarkdown).toEqual(['sid-1', 'D:/ws/report.md', 'issue-42.md', {}]);
    expect(calls.openFile).toBeUndefined();
  });

  it('有 mdPath + --heading → heading 透传(exactOptionalPropertyTypes 下不带 undefined 键)', async () => {
    const { deps, calls } = makeDeps();
    await dispatchMarinaLink(
      deps,
      'sid-1',
      'D:/ws/report.md',
      'marina:show issue-42.md --heading "Root Cause"',
      'win-1',
    );
    expect(calls.openFileFromMarkdown).toEqual([
      'sid-1',
      'D:/ws/report.md',
      'issue-42.md',
      { heading: 'Root Cause' },
    ]);
  });

  it('无 mdPath(命令面板输出)→ openFile(session cwd 基准,与 CLI show 一致)', async () => {
    const { deps, calls } = makeDeps();
    await dispatchMarinaLink(deps, 'sid-1', undefined, 'marina:show%20a%20b.md', 'win-1');
    expect(calls.openFile).toEqual(['sid-1', 'a b.md', {}]);
    expect(calls.openFileFromMarkdown).toBeUndefined();
  });
});

describe('dispatchMarinaLink: run', () => {
  it('命令 + title → runCommand(title 为 null 当缺省;clientId 定向点击窗口)', async () => {
    const { deps, calls } = makeDeps();
    const result = await dispatchMarinaLink(
      deps,
      'sid-2',
      'D:/ws/report.md',
      'marina:run --title "PR 列表" gh pr list',
      'win-9',
    );
    expect(result).toEqual({ kind: 'run' });
    expect(calls.runCommand).toEqual(['sid-2', 'gh pr list', 'PR 列表', 'win-9', false]);
  });

  it('无 title → runCommand 收到 null', async () => {
    const { deps, calls } = makeDeps();
    await dispatchMarinaLink(deps, 'sid-2', undefined, 'marina:run git status', null);
    expect(calls.runCommand).toEqual(['sid-2', 'git status', null, null, false]);
  });
});

describe('dispatchMarinaLink: 错误', () => {
  it('语法错抛 MarinaLinkError(message 可直接 toast)', async () => {
    const { deps } = makeDeps();
    await expect(dispatchMarinaLink(deps, 'sid', undefined, 'marina:close --all', null)).rejects.toThrow(
      MarinaLinkError,
    );
    await expect(
      dispatchMarinaLink(deps, 'sid', undefined, 'marina:show', null),
    ).rejects.toThrow(/需要一个文件路径/);
  });

  it('非 marina: href 拒绝(renderer 误传常规链接时防误执行)', async () => {
    const { deps } = makeDeps();
    await expect(dispatchMarinaLink(deps, 'sid', undefined, './local.md', null)).rejects.toThrow(
      MarinaLinkError,
    );
  });

  it('服务错误原样上抛(FilePanelError 等,由 ipc 层包装)', async () => {
    const boom = new Error('文件不存在: x.md');
    const deps = {
      filePanelService: {
        async openFile(): Promise<null> {
          throw boom;
        },
        async openFileFromMarkdown(): Promise<null> {
          throw new Error('不应该走这条');
        },
      },
      commandPanelService: {
        async runCommand(): Promise<null> {
          return null;
        },
      },
    } as unknown as Parameters<typeof dispatchMarinaLink>[0];
    await expect(dispatchMarinaLink(deps, 'sid', undefined, 'marina:show x.md', null)).rejects.toBe(
      boom,
    );
  });
});

// 让 type-only import 不被 lint 报未使用:本测试通过 makeDeps 的结构对齐服务面,
// 这里显式引用类型确保签名漂移(方法改名/删除)在 typecheck 期暴露。
export type _DepsShapeCheck = {
  filePanel: Pick<FilePanelService, 'openFile' | 'openFileFromMarkdown'>;
  commandPanel: Pick<CommandPanelService, 'runCommand'>;
};
