/**
 * @file directory-picker-service.test.ts
 * @purpose 锁定自绘 backend 文件夹选择器的分层列举、导航元数据与错误语义。
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listDirectoryPickerEntries } from './directory-picker-service';

describe('listDirectoryPickerEntries', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'marina-directory-picker-'));
    await mkdir(join(root, 'alpha'));
    await mkdir(join(root, 'beta'));
    await writeFile(join(root, 'not-a-folder.txt'), 'ignored', 'utf8');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('省略 path 时从 backend home 开始，只返回排序后的直接子目录', async () => {
    const result = await listDirectoryPickerEntries(undefined, root);

    expect(result).toEqual({
      currentPath: root,
      parentPath: dirname(root),
      homePath: root,
      rootPath: parse(root).root,
      directories: [
        { name: 'alpha', path: join(root, 'alpha') },
        { name: 'beta', path: join(root, 'beta') },
      ],
    });
  });

  it('进入子目录后返回可点击的父路径，根目录没有父路径', async () => {
    await mkdir(join(root, 'alpha', 'nested'));

    const nested = await listDirectoryPickerEntries(join(root, 'alpha'), root);
    expect(nested.currentPath).toBe(join(root, 'alpha'));
    expect(nested.parentPath).toBe(root);
    expect(nested.directories).toEqual([
      { name: 'nested', path: join(root, 'alpha', 'nested') },
    ]);

    const filesystemRoot = parse(root).root;
    const atRoot = await listDirectoryPickerEntries(filesystemRoot, root);
    expect(atRoot.parentPath).toBeNull();
  });

  it('路径不存在时给出操作、关键参数、可能原因和下一步', async () => {
    const missing = join(root, 'missing');
    await expect(listDirectoryPickerEntries(missing, root)).rejects.toThrow(
      new RegExp(
        `\\[DirectoryPicker\\] Failed to inspect path=.*missing.*Possible causes:.*Navigate from home/root`,
      ),
    );
  });

  it('目标是文件时明确拒绝，不把空列表伪装成目录', async () => {
    const file = join(root, 'not-a-folder.txt');
    await expect(listDirectoryPickerEntries(file, root)).rejects.toThrow(
      /not a directory.*Go back and choose a folder/,
    );
  });
});
