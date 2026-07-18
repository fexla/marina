/**
 * @file src/shared/build-git-tree.ts
 * @purpose 把 Git 变更的扁平 path 列表转成目录树(v0.3.0 GitPanel 树形视图)。
 *
 * @背景:
 * Git status 返回的是扁平 relativePath 列表(如 src/main/foo.ts, src/main/bar.ts)。
 * 树形视图要按目录层级聚合:src/ → main/ → foo.ts + bar.ts。本模块负责这个转换,
 * 是纯函数(无 fs / 无 React),放 shared 便于单测。
 *
 * @设计:
 * - 路径分隔符:Git porcelain 输出用 POSIX `/`(Windows 仓库也是)。本模块按 `/` split。
 * - 目录节点:聚合子项,继承「子树里最严重的 tone」用于目录名染色(VS Code Source Control 风格)。
 * - 叶子节点:保留原 entry(path/tone/oldPath),供 GitPanel 点击 openDiff。
 * - 排序:目录在前,文件在后;同级按 name 字母序(忽略大小写)。稳定且可预测。
 * - tone 优先级(用于目录继承 + 分组排序):conflict > modified > added > untracked > deleted > renamed
 *
 * @不做:
 * - 不做 gitignore 过滤(git status 本身已尊重 .gitignore)
 * - 不做循环符号链接检测(罕见,git 已处理)
 * - 不做路径转义校验(调用方 GitService 已 realpath + repoRoot 包含校验)
 */
import type { GitStatusTone } from './protocol';

/** 叶子节点:对应一个变更文件。 */
export interface GitTreeLeaf {
  type: 'leaf';
  /** 目录树内显示的短名(如 foo.ts)。 */
  name: string;
  /** 相对 repoRoot 的完整路径(供 openDiff 用,POSIX 风格)。 */
  relativePath: string;
  /** rename 的旧路径(若有,用于 hover/显示)。 */
  oldPath?: string | undefined;
  tone: GitStatusTone;
}

/** 目录节点:聚合子项。 */
export interface GitTreeDir {
  type: 'dir';
  /** 目录短名(如 src、main)。 */
  name: string;
  /** 相对 repoRoot 的目录路径(POSIX 风格,无尾斜杠)。 */
  dirPath: string;
  /** 子节点(目录 + 文件混合,已排序)。 */
  children: GitTreeNode[];
  /** 子树里最严重的 tone(用于目录名染色)。 */
  tone: GitStatusTone;
}

export type GitTreeNode = GitTreeLeaf | GitTreeDir;

/** tone 严重程度(数值越大越严重)。用于目录继承 + 排序。 */
const TONE_SEVERITY: Record<GitStatusTone, number> = {
  conflict: 5,
  modified: 4,
  added: 3,
  untracked: 2,
  deleted: 1,
  renamed: 0,
};

/** 取两个 tone 中更严重的。用于目录聚合。 */
export function moreSevereTone(a: GitStatusTone, b: GitStatusTone): GitStatusTone {
  return TONE_SEVERITY[a] >= TONE_SEVERITY[b] ? a : b;
}

interface InputEntry {
  relativePath: string;
  oldPath?: string | undefined;
  tone: GitStatusTone;
}

/** 临时构建节点(运行中状态,子节点的 tone 尚未向上聚合)。 */
interface BuildDir {
  type: 'dir';
  name: string;
  dirPath: string;
  children: BuildNode[];
  /** 直属及间接子叶子的 tone 列表(供 finalize 聚合)。 */
  leafTones: GitStatusTone[];
}

/** 构建期节点:dir 是 BuildDir(有 leafTones),leaf 直接是 GitTreeLeaf(最终型)。 */
type BuildNode = BuildDir | GitTreeLeaf;

/**
 * 把扁平 entry 列表构建成目录树森林(多个根,如 src/ + docs/ + README.md)。
 *
 * @example
 *   buildGitTree([
 *     { relativePath: 'src/a.ts', tone: 'modified' },
 *     { relativePath: 'src/b.ts', tone: 'added' },
 *     { relativePath: 'README.md', tone: 'modified' },
 *   ])
 *   // → [
 *   //   { type:'dir', name:'src', tone:'modified', children:[a.ts(modified), b.ts(added)] },
 *   //   { type:'leaf', name:'README.md', tone:'modified' },
 *   // ]
 *
 * 算法:用 dirPath → BuildDir 的 Map 确保每个目录只创建一次,叶子挂到父目录的 children,
 * 同时把 tone 收集到所有祖先目录的 leafTones。最后 finalize 把 BuildDir 转成 GitTreeDir
 * (聚合 tone + 排序)。用 Map 而非递归,避免深路径栈溢出。
 */
export function buildGitTree(entries: InputEntry[]): GitTreeNode[] {
  const dirMap = new Map<string, BuildDir>();
  const roots: BuildNode[] = [];

  /** 确保 dirPath(含所有祖先)存在,返回该 BuildDir。空 dirPath 返回 null(根级)。 */
  function ensureDir(dirPath: string): BuildDir {
    const existing = dirMap.get(dirPath);
    if (existing) return existing;
    const segs = dirPath.split('/');
    const name = segs[segs.length - 1] ?? dirPath;
    const dir: BuildDir = { type: 'dir', name, dirPath, children: [], leafTones: [] };
    dirMap.set(dirPath, dir);
    // 挂到父(或根)
    if (segs.length <= 1) {
      roots.push(dir);
    } else {
      const parentPath = segs.slice(0, -1).join('/');
      ensureDir(parentPath).children.push(dir);
    }
    return dir;
  }

  for (const entry of entries) {
    const segs = entry.relativePath.split('/');
    const leafName = segs[segs.length - 1] ?? entry.relativePath;
    const leaf: GitTreeLeaf =
      entry.oldPath !== undefined
        ? { type: 'leaf', name: leafName, relativePath: entry.relativePath, oldPath: entry.oldPath, tone: entry.tone }
        : { type: 'leaf', name: leafName, relativePath: entry.relativePath, tone: entry.tone };
    if (segs.length === 1) {
      // 根级文件
      roots.push(leaf);
    } else {
      const parentPath = segs.slice(0, -1).join('/');
      ensureDir(parentPath).children.push(leaf);
      // 向上收集 tone 到所有祖先
      let p: string | null = parentPath;
      while (p !== null && p !== '') {
        const d = dirMap.get(p);
        if (!d) break;
        d.leafTones.push(entry.tone);
        const idx = p.lastIndexOf('/');
        p = idx > 0 ? p.slice(0, idx) : null;
      }
    }
  }

  /** 把 BuildNode 递归转成 GitTreeNode(dir 聚合 leafTones → tone,排序 children)。 */
  function finalize(node: BuildNode): GitTreeNode {
    if (node.type !== 'dir') return node;
    const tone: GitStatusTone =
      node.leafTones.length > 0 ? node.leafTones.reduce(moreSevereTone) : 'renamed';
    return {
      type: 'dir',
      name: node.name,
      dirPath: node.dirPath,
      tone,
      children: node.children.map(finalize).sort(compareNodes),
    };
  }

  return roots.map(finalize).sort(compareNodes);
}

/** 排序比较:目录在前,文件在后;同级按 name 字母序(忽略大小写)。 */
function compareNodes(a: GitTreeNode, b: GitTreeNode): number {
  if (a.type !== b.type) {
    return a.type === 'dir' ? -1 : 1;
  }
  return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
}
