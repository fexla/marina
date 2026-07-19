/**
 * @file fileListRowContextMenu.test.ts
 * @purpose 统一菜单生成器 buildFileEntryMenu 单测。
 *
 * 覆盖:能力→项映射、菜单顺序、divider 规则、disabled 传播、
 * 复制绝对路径的 async resolve、空 ctx。
 *
 * 这是 renderer 侧的纯函数(不渲染 UI),按 AGENTS.md §5.1「纯逻辑可测」纳入。
 */
import { describe, expect, it, vi } from 'vitest';
import { buildFileEntryMenu, dividerItem, type FileEntryContext, type FileMenuDeps } from './fileListRowContextMenu';

const tx = (zh: string): string => zh;

function makeDeps(overrides: Partial<FileMenuDeps> = {}): FileMenuDeps {
  return {
    copyToClipboard: vi.fn(),
    toastError: vi.fn(),
    tx,
    ...overrides,
  };
}

/** 提取菜单 label 列表(divider 显示为 '---'),便于断言顺序。 */
function labels(items: ReturnType<typeof buildFileEntryMenu>): string[] {
  return items.map((it) => (it.divider ? '---' : it.label));
}

describe('buildFileEntryMenu', () => {
  it('空 ctx 返回空数组', () => {
    expect(buildFileEntryMenu({}, makeDeps())).toEqual([]);
  });

  it('只提供 primary → 单项,无 divider', () => {
    const ctx: FileEntryContext = { primary: { label: '打开', run: vi.fn() } };
    const items = buildFileEntryMenu(ctx, makeDeps());
    expect(labels(items)).toEqual(['打开']);
    expect(items.some((i) => i.divider)).toBe(false);
  });

  it('git 全套:操作族 + divider + 路径族', () => {
    const ctx: FileEntryContext = {
      primary: { label: '打开 diff', run: vi.fn() },
      openFile: { run: vi.fn() },
      relativePath: 'src/foo.ts',
      resolveAbsolutePath: async () => '/abs/foo.ts',
      reveal: vi.fn(),
    };
    const items = buildFileEntryMenu(ctx, makeDeps());
    expect(labels(items)).toEqual([
      '打开 diff',
      '打开文件',
      '---',
      '复制相对路径',
      '复制绝对路径',
      '在 Explorer 中显示',
    ]);
  });

  it('file-tree:primary + relativePath + reveal(无 openFile / 无 resolveAbsolutePath)', () => {
    const ctx: FileEntryContext = {
      primary: { label: '打开', run: vi.fn() },
      relativePath: 'foo.txt',
      reveal: vi.fn(),
    };
    const items = buildFileEntryMenu(ctx, makeDeps());
    expect(labels(items)).toEqual(['打开', '---', '复制相对路径', '在 Explorer 中显示']);
  });

  it('file-panel:close 族 + divider + 绝对路径 + reveal(无 primary / 无 relativePath)', () => {
    const ctx: FileEntryContext = {
      close: {
        close: vi.fn(),
        closeOthers: vi.fn(),
        closeAll: vi.fn(),
      },
      resolveAbsolutePath: async () => '/abs',
      reveal: vi.fn(),
    };
    const items = buildFileEntryMenu(ctx, makeDeps());
    expect(labels(items)).toEqual([
      '关闭',
      '关闭其他',
      '关闭所有',
      '---',
      '复制绝对路径',
      '在 Explorer 中显示',
    ]);
  });

  it('只有路径族(无操作族) → 不插前置 divider', () => {
    const ctx: FileEntryContext = { relativePath: 'a', reveal: vi.fn() };
    const items = buildFileEntryMenu(ctx, makeDeps());
    expect(labels(items)).toEqual(['复制相对路径', '在 Explorer 中显示']);
    expect(items.some((i) => i.divider)).toBe(false);
  });

  it('close 族 disabled 传播(closeOthers / closeAll)', () => {
    const ctx: FileEntryContext = {
      close: {
        close: vi.fn(),
        closeOthers: vi.fn(),
        closeAll: vi.fn(),
        closeOthersDisabled: true,
        closeAllDisabled: true,
      },
    };
    const items = buildFileEntryMenu(ctx, makeDeps());
    // close(0) / closeOthers(1) / closeAll(2)
    expect(items[1]?.disabled).toBe(true);
    expect(items[2]?.disabled).toBe(true);
    expect(items[0]?.disabled).toBeUndefined();
  });

  it('openFile disabled 传播', () => {
    const ctx: FileEntryContext = {
      primary: { label: '打开 diff', run: vi.fn() },
      openFile: { run: vi.fn(), disabled: true },
    };
    const items = buildFileEntryMenu(ctx, makeDeps());
    expect(items[1]?.label).toBe('打开文件');
    expect(items[1]?.disabled).toBe(true);
  });

  it('primary.run / openFile.run / reveal 点击时被调用', () => {
    const primary = vi.fn();
    const openFile = vi.fn();
    const reveal = vi.fn();
    const ctx: FileEntryContext = {
      primary: { label: 'P', run: primary },
      openFile: { run: openFile },
      reveal,
    };
    const items = buildFileEntryMenu(ctx, makeDeps());
    items[0]?.onSelect?.(); // primary
    items[1]?.onSelect?.(); // openFile
    // reveal 在路径族(reveal 前有 divider)。find it:
    const revealItem = items.find((i) => !i.divider && i.label === '在 Explorer 中显示');
    revealItem?.onSelect?.();
    expect(primary).toHaveBeenCalledOnce();
    expect(openFile).toHaveBeenCalledOnce();
    expect(reveal).toHaveBeenCalledOnce();
  });

  it('复制相对路径 → copyToClipboard 收到 relativePath', () => {
    const copyToClipboard = vi.fn();
    const ctx: FileEntryContext = { relativePath: 'src/x.ts' };
    const items = buildFileEntryMenu(ctx, makeDeps({ copyToClipboard }));
    items[0]?.onSelect?.();
    expect(copyToClipboard).toHaveBeenCalledWith('src/x.ts', '相对路径');
  });

  it('复制绝对路径 → async resolve 后 copyToClipboard', async () => {
    const copyToClipboard = vi.fn();
    const resolve = vi.fn(async () => '/resolved/abs.ts');
    const ctx: FileEntryContext = { resolveAbsolutePath: resolve };
    const items = buildFileEntryMenu(ctx, makeDeps({ copyToClipboard }));
    items[0]?.onSelect?.(); // onSelect 不返回 Promise(fire-and-forget),手动 flush
    await vi.waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith('/resolved/abs.ts', '绝对路径'));
    expect(resolve).toHaveBeenCalledOnce();
  });

  it('复制绝对路径 resolve 失败 → toastError', async () => {
    const toastError = vi.fn();
    const ctx: FileEntryContext = {
      resolveAbsolutePath: async () => {
        throw new Error('boom');
      },
    };
    const items = buildFileEntryMenu(ctx, makeDeps({ toastError }));
    items[0]?.onSelect?.();
    await vi.waitFor(() => expect(toastError).toHaveBeenCalledOnce());
    expect(toastError.mock.calls[0][0]).toContain('boom');
  });

  it('dividerItem 返回 divider 标记', () => {
    expect(dividerItem()).toEqual({ divider: true, label: '' });
  });
});
