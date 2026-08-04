/**
 * @file directory-picker-service.ts
 * @purpose 为 renderer 自绘文件夹选择器分层列举“当前 backend”上的目录。
 *
 * @关键设计:
 * - 只返回目录，不返回文件；renderer 只能点击导航，不能手敲路径
 * - path 省略时从 backend 的 home 目录开始；远程窗口经 WS 在 daemon 上执行
 * - 每次仅列当前层，避免一次递归扫描大目录，也避免把整棵文件系统塞进 IPC
 * - 符号链接若指向目录也显示；坏链/无权限单项静默跳过，不让整层失效
 *
 * @对应文档章节:软件定义书.md 第 2 章原则 2、第 5.1.1、6.2.4、7.1 节
 *
 * @不要在这里做的事:
 * - 不要接受“相对某 session”的路径语义；本模块是 backend 文件系统选择器
 * - 不要递归枚举或读取文件内容
 * - 不要把本命令标为 local-control；远程窗口必须浏览 daemon 文件系统
 */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import type {
  DirectoryPickerEntry,
  ListDirectoryPickerResponse,
} from '@shared/protocol';

/**
 * 列举一个 backend 目录的直接子目录。
 *
 * @param requestedPath 要浏览的绝对目录；省略/空白时使用 backend home
 * @param fallbackHome 测试注入点；生产不传，使用 `os.homedir()`
 * @returns 当前路径、home/root/父路径和按名称排序的直接子目录
 *
 * @throws Error 当目标不存在、不是目录或整层无法读取。错误包含目标路径、
 *   常见原因和下一步，renderer 可原样显示在选择器内。
 */
export async function listDirectoryPickerEntries(
  requestedPath?: string,
  fallbackHome = homedir(),
): Promise<ListDirectoryPickerResponse> {
  const homePath = resolve(fallbackHome);
  const currentPath = resolve(requestedPath?.trim() || homePath);

  let stats;
  try {
    stats = await fs.stat(currentPath);
  } catch (error) {
    throw new Error(
      `[DirectoryPicker] Failed to inspect path="${currentPath}". ` +
        'Possible causes: (1) the directory was moved or deleted, (2) the Marina backend user ' +
        'does not have permission, (3) the path belongs to another machine. ' +
        `Navigate from home/root and choose an accessible folder. Cause: ${formatCause(error)}`,
    );
  }
  if (!stats.isDirectory()) {
    throw new Error(
      `[DirectoryPicker] Cannot browse path="${currentPath}" because it is not a directory. ` +
        'Possible causes: (1) a file was selected, (2) a symlink target changed. ' +
        'Go back and choose a folder.',
    );
  }

  let rawEntries;
  try {
    rawEntries = await fs.readdir(currentPath, { withFileTypes: true });
  } catch (error) {
    throw new Error(
      `[DirectoryPicker] Failed to list directory path="${currentPath}". ` +
        'Possible causes: (1) permission was denied, (2) the directory disappeared while open, ' +
        '(3) the filesystem is unavailable. Go to the parent/home directory and retry. ' +
        `Cause: ${formatCause(error)}`,
    );
  }

  const resolvedEntries = await Promise.all(
    rawEntries.map(async (entry): Promise<DirectoryPickerEntry | null> => {
      const childPath = join(currentPath, entry.name);
      if (entry.isDirectory()) return { name: entry.name, path: childPath };
      if (!entry.isSymbolicLink()) return null;
      try {
        return (await fs.stat(childPath)).isDirectory()
          ? { name: entry.name, path: childPath }
          : null;
      } catch {
        // 单个坏链或无权限链接不应该让整个目录选择器不可用。
        return null;
      }
    }),
  );
  const directories = resolvedEntries
    .filter((entry): entry is DirectoryPickerEntry => entry !== null)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

  const parent = dirname(currentPath);
  return {
    currentPath,
    parentPath: parent === currentPath ? null : parent,
    homePath,
    rootPath: parse(currentPath).root,
    directories,
  };
}

function formatCause(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
