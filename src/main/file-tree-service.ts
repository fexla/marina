/**
 * @file src/main/file-tree-service.ts
 * @purpose 为 FileTreePanel 提供 session 绑定的、双根、只读目录导航。
 *
 * @关键设计:
 * - 仅允许当前 owner client 浏览 session.currentCwd 与同 session 的
 *   MARINA_WORKSPACE；两者都是 session 临时能力，不构成 Project/Workspace。
 * - 每一次列目录或打开文件都重新 realpath 根和目标，并按 path.relative 的路径段
 *   边界验证包含关系。normalize/resolve 的词法检查不足以防符号链接或 Windows
 *   junction 逃逸，因此不能用它替代本服务。
 * - 本服务只列直接子项（最多 500 项），不递归扫描，也不提供写操作。选中文件
 *   通过可信的 canonical absolute path 交给 FilePanelService 打开，继续复用既有
 *   Viewer、大小上限与文件变更监听。
 *
 * @对应文档章节:软件定义书.md §14.6 受限文件导航例外、ADR-016；
 *   docs/ipc-protocol.md file-tree 域。
 *
 * @不要在这里做的事:
 * - 不做 SFTP、SSH 远程目录或任意本地路径浏览。
 * - 不创建/编辑/删除/上传/下载文件。
 * - 不管理 MARINA_WORKSPACE 生命周期（SessionWorkspaceManager 的职责）。
 */
import { promises as fs } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { shell } from 'electron';
import type { FileTreeEntry, FileTreeRootId } from '@shared/types';
import type { FilePanelSnapshot, ListFileTreeRecursiveResponse } from '@shared/protocol';
import type { FilePanelService } from './file-panel-service';
import { pathRefFromId } from './path-manager';
import { logger } from './logger';

const MODULE = 'FileTreeService';
/** 单次目录请求最多返回的直接子项，避免 node_modules 等目录撑爆 IPC。 */
const MAX_DIRECTORY_ENTRIES = 500;
/** v0.3.2:list-recursive 全量递归扫描的上限(防止巨型仓库 撑爆 IPC + renderer)。 */
const MAX_RECURSIVE_ENTRIES = 5000;
/** 递归最大深度(防止符号链接环 / 无限嵌套)。 */
const MAX_RECURSIVE_DEPTH = 15;

export interface FileTreeSessionLookup {
  get(sessionId: string): {
    /** 用 pathId 的 kind 区分 daemon 本地路径与传统 SSH 远程 shell，不能猜 cwd 字符串。 */
    pathId: string;
    currentCwd: string;
    ownerWindowId: string | null;
  } | null;
}

export interface FileTreeWorkspaceLookup {
  /** 仅 live session 有可用目录；实现方不得接受任意外部路径。 */
  getPathForSession(sessionId: string): string | null;
}

export interface FileTreeRootInfo {
  id: FileTreeRootId;
  label: string;
  available: boolean;
  /** 不暴露底层绝对路径；仅给 UI 显示安全、可操作的原因。 */
  reason?: string;
}

export interface FileTreeDirectorySnapshot {
  rootId: FileTreeRootId;
  /** 相对 root 的规范化 POSIX 风格路径；根目录为 ''。 */
  relativePath: string;
  entries: FileTreeEntry[];
  truncated: boolean;
}

/** IPC 可识别的只读导航错误。详情足够诊断，但不回显未授权绝对路径。 */
export class FileTreeError extends Error {
  constructor(
    public readonly code:
      | 'SessionMissing'
      | 'NotOwner'
      | 'RootUnavailable'
      | 'InvalidPath'
      | 'OutsideAllowedRoot'
      | 'NotDirectory'
      | 'NotFile'
      | 'ReadFailed',
    message: string,
  ) {
    super(`[${MODULE}:${code}] ${message}`);
    this.name = 'FileTreeError';
  }
}

interface ResolvedRoot {
  id: FileTreeRootId;
  realPath: string;
}

/**
 * 受限文件树的主服务。
 *
 * 所有公开方法都要求 requesterId 与 session.ownerWindowId 相等。这样一个窗口即使
 * 知道其他窗口的 sessionId，也不能把文件树当作跨 session 文件读取接口。
 */
export class FileTreeService {
  constructor(
    private readonly sessionLookup: FileTreeSessionLookup,
    private readonly workspaceLookup: FileTreeWorkspaceLookup,
    private readonly filePanelService: FilePanelService,
  ) {}

  /**
   * 返回两个固定逻辑根的当前可用性。
   *
   * @param sessionId 被浏览的 live session
   * @param requesterId 发起请求的 client/window id，必须是当前 owner
   * @returns 不包含绝对路径的根能力快照
   */
  async getRoots(sessionId: string, requesterId: string): Promise<FileTreeRootInfo[]> {
    this.requireOwner(sessionId, requesterId);
    const result: FileTreeRootInfo[] = [];
    for (const id of ['session-cwd', 'managed-workspace'] as const) {
      try {
        await this.resolveRoot(sessionId, id);
        result.push({ id, label: rootLabel(id), available: true });
      } catch (err) {
        const safeReason =
          err instanceof FileTreeError ? rootErrorMessage(err.code) : '目录暂不可用';
        result.push({ id, label: rootLabel(id), available: false, reason: safeReason });
      }
    }
    return result;
  }

  /**
   * 懒加载一个目录的直接子项。
   *
   * @throws FileTreeError 当 session/owner/root/路径不合法、路径越界或读取失败。
   */
  async listDirectory(
    sessionId: string,
    requesterId: string,
    rootId: FileTreeRootId,
    relativePath = '',
  ): Promise<FileTreeDirectorySnapshot> {
    this.requireOwner(sessionId, requesterId);
    const root = await this.resolveRoot(sessionId, rootId);
    const target = await this.resolveInsideRoot(root, relativePath);
    const stat = await this.statOrThrow(target, '目录读取');
    if (!stat.isDirectory()) {
      throw new FileTreeError(
        'NotDirectory',
        '请求目标不是目录。请从文件夹节点展开，或刷新文件树后重试。',
      );
    }

    const entries: FileTreeEntry[] = [];
    let truncated = false;
    try {
      const directory = await fs.opendir(target);
      for await (const dirent of directory) {
        const childLexical = resolve(target, dirent.name);
        let childReal: string;
        let childStat: Awaited<ReturnType<typeof fs.stat>>;
        try {
          // 每个 child 都 canonicalize：普通文件无额外成本，symbolic link/junction
          // 则能被这里识别并在越界时完全从结果中隐藏。
          childReal = await fs.realpath(childLexical);
          if (!isWithinRoot(root.realPath, childReal)) {
            logger.warn(
              MODULE,
              `listDirectory: omitted escaped link root=${rootId} entry=${dirent.name}`,
            );
            continue;
          }
          childStat = await fs.stat(childReal);
        } catch (err) {
          // 文件在 readdir 与 stat 间被删、无权限或坏链接是正常 race；单项跳过，
          // 不能让一个目录项阻断整个面板。
          logger.debug(
            MODULE,
            `listDirectory: skipped unreadable entry root=${rootId} name=${dirent.name} reason=${
              err instanceof Error
                ? ((err as NodeJS.ErrnoException).code ?? err.message)
                : String(err)
            }`,
          );
          continue;
        }
        if (!childStat.isFile() && !childStat.isDirectory()) continue;
        entries.push({
          relativePath: toProtocolRelativePath(root.realPath, childReal),
          name: dirent.name,
          kind: childStat.isDirectory() ? 'directory' : 'file',
          size: childStat.size,
          mtimeMs: childStat.mtimeMs,
        });
        if (entries.length >= MAX_DIRECTORY_ENTRIES) {
          truncated = true;
          break;
        }
      }
    } catch (err) {
      if (err instanceof FileTreeError) throw err;
      throw new FileTreeError(
        'ReadFailed',
        `无法读取所选目录。可能原因：(1)目录已被删除，(2)没有读取权限，(3)文件系统暂时不可用。` +
          `建议刷新文件树或检查目录权限。原始错误：${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 文件夹在前、同类按名称稳定排序。列表上限前停止是刻意的性能上限；不承诺
    // 超过上限时“全目录全局排序”，UI 会显示“仅显示前 500 项”。
    entries.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    return {
      rootId,
      relativePath: toProtocolRelativePath(root.realPath, target),
      entries,
      truncated,
    };
  }

  /**
   * v0.3.2:递归列出 root 下全量后代 entries(扁平),供 renderer 搜索时本地过滤。
   *
   * 为什么需要:file-tree 懒加载(展开才拉子目录),搜索时未展开目录的内容不在
   * renderer state 里 → 搜不到。本方法一次拉全量,renderer 缓存后多次过滤(query
   * 变化不重拉),搜索体验即时。
   *
   * 算法:BFS(广度优先)—— 先扫完当前层再下一层,保证同名文件浅层优先出现,比 DFS
   * 更符合搜索直觉(常见文件在浅层)。
   *
   * 上限保护:MAX_RECURSIVE_ENTRIES(总数 5000) + MAX_RECURSIVE_DEPTH(深度 15),
   * 防 node_modules 等巨型目录撑爆。超限 truncated=true,renderer 显示提示。
   *
   * 安全:同 listDirectory —— 每项 realpath + isWithinRoot 校验,符号链接/junction
   * 越界的完全跳过(不暴露根外文件)。
   */
  async listRecursive(
    sessionId: string,
    requesterId: string,
    rootId: FileTreeRootId,
  ): Promise<ListFileTreeRecursiveResponse> {
    this.requireOwner(sessionId, requesterId);
    const root = await this.resolveRoot(sessionId, rootId);
    // BFS:queue 存 {absPath, depth}。从 root 开始。
    const queue: Array<{ absPath: string; depth: number }> = [
      { absPath: root.realPath, depth: 0 },
    ];
    const entries: FileTreeEntry[] = [];
    let dirCount = 0;
    let truncated = false;

    while (queue.length > 0) {
      if (entries.length >= MAX_RECURSIVE_ENTRIES) {
        truncated = true;
        break;
      }
      const { absPath, depth } = queue.shift() as { absPath: string; depth: number };
      dirCount++;
      try {
        const directory = await fs.opendir(absPath);
        for await (const dirent of directory) {
          if (entries.length >= MAX_RECURSIVE_ENTRIES) {
            truncated = true;
            break;
          }
          const childLexical = resolve(absPath, dirent.name);
          let childReal: string;
          let childStat: Awaited<ReturnType<typeof fs.stat>>;
          try {
            // 同 listDirectory:每项 canonicalize,符号链接/junction 越界则跳过。
            childReal = await fs.realpath(childLexical);
            if (!isWithinRoot(root.realPath, childReal)) {
              logger.debug(
                MODULE,
                `listRecursive: omitted escaped link root=${rootId} entry=${dirent.name}`,
              );
              continue;
            }
            childStat = await fs.stat(childReal);
          } catch (err) {
            logger.debug(
              MODULE,
              `listRecursive: skipped unreadable entry root=${rootId} name=${dirent.name} reason=${
                err instanceof Error
                  ? ((err as NodeJS.ErrnoException).code ?? err.message)
                  : String(err)
              }`,
            );
            continue;
          }
          if (!childStat.isFile() && !childStat.isDirectory()) continue;
          const isDir = childStat.isDirectory();
          entries.push({
            relativePath: toProtocolRelativePath(root.realPath, childReal),
            name: dirent.name,
            kind: isDir ? 'directory' : 'file',
            size: childStat.size,
            mtimeMs: childStat.mtimeMs,
          });
          // 子目录且未超深度 → 入队继续扫。
          if (isDir && depth + 1 < MAX_RECURSIVE_DEPTH) {
            queue.push({ absPath: childReal, depth: depth + 1 });
          } else if (isDir) {
            truncated = true; // 深度超限:该子目录的内容无法包含,提示
          }
        }
      } catch (err) {
        // 单个目录读失败(权限/已删)不阻断整体,跳过继续扫其他目录。
        logger.debug(
          MODULE,
          `listRecursive: skipped unreadable dir root=${rootId} path=${absPath} reason=${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // 同 listDirectory 的稳定排序:文件夹在前、同类按名排序。
    entries.sort((a, b) => a.kind.localeCompare(b.kind) || a.relativePath.localeCompare(b.relativePath));
    return { rootId, entries, truncated, dirCount };
  }

  /**
   * 验证树中选中的文件仍位于受限根内，再交给既有 FilePanelService 打开预览。
   *
   * 这里不能让 renderer 直接调用 FILE_PANEL_OPEN：后者的历史职责允许终端程序
   * 打开 currentCwd 外的绝对路径，而 FileTreePanel 必须维持双根限制。
   */
  async openFile(
    sessionId: string,
    requesterId: string,
    rootId: FileTreeRootId,
    relativePath: string,
  ): Promise<FilePanelSnapshot> {
    this.requireOwner(sessionId, requesterId);
    const root = await this.resolveRoot(sessionId, rootId);
    const target = await this.resolveInsideRoot(root, relativePath);
    const stat = await this.statOrThrow(target, '文件打开');
    if (!stat.isFile()) {
      throw new FileTreeError('NotFile', '请求目标不是文件。请选择文件节点后再打开预览。');
    }
    // target 是 canonical path；FilePanelService 二次 stat 后以它作为 opened-file
    // 主键，避免相同文件经过不同 symlink 路径重复打开。
    return this.filePanelService.openFile(sessionId, target);
  }

  /**
   * 在系统文件管理器中定位并选中树中选择的文件(v0.3.0)。
   *
   * 与 openFile 同一套根包含校验，但不调 FilePanelService、不向 renderer 返回
   * 绝对路径 —— 校验通过后直接由 main 端调 electron shell.showItemInFolder。
   * 这样 renderer 始终拿不到受限根外的绝对路径，保持「不暴露任意路径」的安全面。
   *
   * @throws FileTreeError 与 openFile 同样语义(SessionMissing/NotOwner/RootUnavailable/
   *   InvalidPath/OutsideAllowedRoot/NotFile/ReadFailed)。
   */
  async revealPath(
    sessionId: string,
    requesterId: string,
    rootId: FileTreeRootId,
    relativePath: string,
  ): Promise<void> {
    this.requireOwner(sessionId, requesterId);
    const root = await this.resolveRoot(sessionId, rootId);
    const target = await this.resolveInsideRoot(root, relativePath);
    const stat = await this.statOrThrow(target, '文件定位');
    if (!stat.isFile() && !stat.isDirectory()) {
      throw new FileTreeError(
        'NotFile',
        '请求目标不是文件或目录，无法在文件管理器中定位。',
      );
    }
    // showItemInFolder 对文件和目录都有效：文件会高亮选中，目录会打开该目录窗口。
    // Electron 在 Win/macOS/Linux 上分别调用 explorer/Finder/xdg-open。
    shell.showItemInFolder(target);
  }

  /**
   * v0.3.2:用系统默认应用打开 file-tree 节点(右键「用默认应用打开」)。
   *
   * 对称 revealPath,保持 rootId 抽象 —— renderer 始终不持绝对路径,由 main 端
   * resolve + openPath。校验同 revealPath(owner + root 包含 + 存在性)。
   *
   * 文件用关联程序打开(.png → 图片查看器 / .pdf → 阅读器);
   * 目录用资源管理器打开(与 reveal 语义重叠但用户预期不同:reveal 是"定位选中",
   * open 是"进去")。file-tree 前端只对文件节点暴露此能力。
   */
  async openPath(
    sessionId: string,
    requesterId: string,
    rootId: FileTreeRootId,
    relativePath: string,
  ): Promise<void> {
    this.requireOwner(sessionId, requesterId);
    const root = await this.resolveRoot(sessionId, rootId);
    const target = await this.resolveInsideRoot(root, relativePath);
    const stat = await this.statOrThrow(target, '文件打开');
    if (!stat.isFile() && !stat.isDirectory()) {
      throw new FileTreeError(
        'NotFile',
        '请求目标不是文件或目录，无法打开。',
      );
    }
    await shell.openPath(target);
  }

  /** 每个请求均重新检查 owner，避免 session 被接管后旧窗口继续读取文件。 */
  private requireOwner(sessionId: string, requesterId: string): void {
    const session = this.sessionLookup.get(sessionId);
    if (!session) {
      throw new FileTreeError(
        'SessionMissing',
        '会话不存在或已关闭，无法浏览其文件。请切换到仍在运行的终端。',
      );
    }
    if (!requesterId || session.ownerWindowId !== requesterId) {
      throw new FileTreeError(
        'NotOwner',
        '当前窗口不持有该会话，无法浏览其文件。请先在会话标签页中接管或切换到 owner 窗口。',
      );
    }
  }

  /** 从实时 session / workspace manager 解析并 canonicalize 固定逻辑根。 */
  private async resolveRoot(sessionId: string, id: FileTreeRootId): Promise<ResolvedRoot> {
    const session = this.sessionLookup.get(sessionId);
    if (!session) {
      throw new FileTreeError('SessionMissing', '会话不存在，无法定位文件导航根目录。');
    }
    // SSH 的 currentCwd 是远程机器上的语义路径。即便它恰巧长得像 daemon
    // 主机上一条真实路径，也绝不能把它当成本地根，否则等价于偷偷实现 SFTP。
    // remote-backend session 在 daemon 上仍是 local PathKind，故可安全复用本服务。
    if (pathRefFromId(session.pathId).kind === 'ssh') {
      throw new FileTreeError(
        'RootUnavailable',
        '传统 SSH 会话不支持文件导航；Marina 不会为此引入 SFTP。请在远程终端中使用现有工具。',
      );
    }
    const configuredPath =
      id === 'session-cwd' ? session.currentCwd : this.workspaceLookup.getPathForSession(sessionId);
    if (!configuredPath) {
      throw new FileTreeError(
        'RootUnavailable',
        id === 'managed-workspace'
          ? '该会话没有可用的受管临时工作区。可能原因是会话正在创建、已关闭或工作区已回收。'
          : '该会话没有可用的本地当前目录。',
      );
    }
    let realPath: string;
    try {
      realPath = await fs.realpath(configuredPath);
    } catch (err) {
      throw new FileTreeError(
        'RootUnavailable',
        `${rootLabel(id)}不可访问。可能原因：(1)这是 SSH 远程目录，Marina 不提供 SFTP，` +
          `(2)目录已被删除，(3)没有读取权限。建议检查会话状态。原始错误：${
            err instanceof Error ? err.message : String(err)
          }`,
      );
    }
    const stat = await this.statOrThrow(realPath, `${rootLabel(id)}校验`);
    if (!stat.isDirectory()) {
      throw new FileTreeError('RootUnavailable', `${rootLabel(id)}不是目录，拒绝建立文件导航根。`);
    }
    return { id, realPath };
  }

  /** 验证 renderer 传入的相对路径，并在 realpath 后再次验证根包含关系。 */
  private async resolveInsideRoot(root: ResolvedRoot, rawRelativePath: string): Promise<string> {
    if (
      typeof rawRelativePath !== 'string' ||
      rawRelativePath.includes('\0') ||
      isAbsolute(rawRelativePath)
    ) {
      throw new FileTreeError(
        'InvalidPath',
        '文件树请求只能携带非空字符的相对路径，不能携带绝对路径、NUL 字符或盘符路径。',
      );
    }
    // UI 只回传 service 给出的 relativePath；显式拒绝 ..，而不是仅依赖 resolve
    // 后的包含判断，让日志/错误语义更清晰，并隔绝跨平台分隔符差异。
    if (rawRelativePath.split(/[\\/]+/).some((part) => part === '..')) {
      throw new FileTreeError(
        'OutsideAllowedRoot',
        '文件树路径不能包含 ".."，只能在所选根目录内导航。',
      );
    }
    const lexicalTarget = resolve(root.realPath, rawRelativePath || '.');
    if (!isWithinRoot(root.realPath, lexicalTarget)) {
      throw new FileTreeError('OutsideAllowedRoot', '请求路径位于允许根目录之外，已拒绝读取。');
    }
    let realTarget: string;
    try {
      realTarget = await fs.realpath(lexicalTarget);
    } catch (err) {
      throw new FileTreeError(
        'ReadFailed',
        `目标不存在或不可访问。可能原因是文件刚被删除、权限变化或链接失效。原始错误：${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (!isWithinRoot(root.realPath, realTarget)) {
      throw new FileTreeError(
        'OutsideAllowedRoot',
        '目标经符号链接或 junction 解析后位于允许根目录之外，已拒绝读取。',
      );
    }
    return realTarget;
  }

  private async statOrThrow(path: string, operation: string) {
    try {
      return await fs.stat(path);
    } catch (err) {
      throw new FileTreeError(
        'ReadFailed',
        `${operation}失败。可能原因是路径已被删除、权限不足或文件系统不可用。原始错误：${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/** 前缀字符串比较不安全(C:\foo 与 C:\foobar)，必须使用 path.relative 的段边界。 */
function isWithinRoot(root: string, target: string): boolean {
  const relation = relative(root, target);
  return (
    relation === '' ||
    (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation))
  );
}

function toProtocolRelativePath(root: string, target: string): string {
  return relative(root, target).split(sep).join('/');
}

function rootLabel(id: FileTreeRootId): string {
  return id === 'session-cwd' ? '当前目录' : '临时工作区';
}

function rootErrorMessage(code: FileTreeError['code']): string {
  switch (code) {
    case 'RootUnavailable':
      return '目录不可用（SSH 会话不提供 SFTP）';
    case 'SessionMissing':
      return '会话已关闭';
    case 'NotOwner':
      return '当前窗口未持有会话';
    default:
      return '目录暂不可用';
  }
}
