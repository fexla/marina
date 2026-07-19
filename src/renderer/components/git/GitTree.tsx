/**
 * @file src/renderer/components/git/GitTree.tsx
 * @purpose GitPanel 树形视图:把变更列表按目录层级聚合渲染(v0.3.0)。
 *
 * @关键设计:
 * - 复用 <FileListRow>(variant=list) 渲染每个节点,与 file-tree 视觉一致:
 *   目录=folder icon + depth 缩进 + 展开箭头;文件=file icon + tone badge。
 * - 展开态:本地 useState<Set<string>> 存「收起的目录」(默认全展开 — 用户看变更
 *   要一眼看到全部,收起是主动操作)。Set 存 dirPath,toggle 时增删。
 * - 目录 tone 继承:buildGitTree 已算好「子树最严重 tone」赋给目录,这里用 toneBadge
 *   显示在目录行(让用户知道这个目录里有哪种变更)。
 * - 点击文件 → openDiff(relativePath)(与 flat 模式同回调,行为一致)。
 * - 右键菜单复用 flat 模式的 buildEntryMenu(打开 diff / 复制相对路径)。
 *
 * @不做:
 * - 不做目录级右键菜单(折叠/全部展开等),保持简单;用户手动点目录展开/收起。
 * - 不做懒加载(变更通常 < 500,全展开渲染无压力)。
 */
import { useState } from 'react';
import type { GitStatusTone } from '@shared/protocol';
import { FileListRow, type StatusBadge, type StatusTone } from '../common/FileListRow';
import { HighlightedText } from '../common/HighlightedText';
import type { ContextMenuItem } from '../ContextMenu';
import { Icon } from '../icons';
import type { GitTreeNode } from '@shared/build-git-tree';

interface GitTreeProps {
  nodes: GitTreeNode[];
  /** 文件节点点击 → 打开 diff。 */
  onOpenDiff: (relativePath: string) => void;
  /** 文件节点右键菜单构建器(与 flat 模式共用)。 */
  buildEntryMenu: (relativePath: string, tone?: GitStatusTone) => ContextMenuItem[];
  /** v0.3.2 B1:目录节点右键菜单构建器。onToggle 由 GitTree 传入(访问内部 collapsed
   * state),其余能力(relativePath/resolveAbsolutePath/reveal/openExternal)由
   * GitPanel 注入 —— 与 file-tree 目录菜单对称。 */
  buildDirMenu: (
    dirPath: string,
    tone: GitStatusTone,
    onToggle: () => void,
  ) => ContextMenuItem[];
  /** v0.3.1:搜索高亮查询(空串 = 不高亮)。 */
  highlightQuery?: string;
  /** v0.3.1:搜索高亮大小写敏感。 */
  highlightCaseSensitive?: boolean;
}

/** tone → 字母(与 GitPanel.badgeFor 对齐)。 */
function badgeFor(tone: GitStatusTone): StatusBadge | null {
  const letter: Record<GitStatusTone, string> = {
    conflict: 'C',
    modified: 'M',
    added: 'A',
    deleted: 'D',
    renamed: 'R',
    untracked: '?',
  };
  return { letter: letter[tone], tone: tone as StatusTone };
}

export function GitTree({
  nodes,
  onOpenDiff,
  buildEntryMenu,
  buildDirMenu,
  highlightQuery = '',
  highlightCaseSensitive = false,
}: GitTreeProps): JSX.Element {
  // 默认全展开:存「收起的目录集合」(空 = 全展开)。用户点目录 toggle 收起。
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (dirPath: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
      }
      return next;
    });
  };

  const renderNode = (node: GitTreeNode, depth: number): JSX.Element => {
    if (node.type === 'leaf') {
      const label = node.oldPath ? `${node.oldPath} → ${node.relativePath}` : node.relativePath;
      const shortName = node.name;
      return (
        <FileListRow
          key={`leaf:${node.relativePath}`}
          variant="list"
          icon="file"
          label={
            <HighlightedText
              text={shortName}
              query={highlightQuery}
              caseSensitive={highlightCaseSensitive}
            />
          }
          title={label}
          depth={depth}
          statusBadge={badgeFor(node.tone)}
          onClick={() => onOpenDiff(node.relativePath)}
          buildContextMenu={() => buildEntryMenu(node.relativePath, node.tone)}
        />
      );
    }
    // 目录节点
    const isCollapsed = collapsed.has(node.dirPath);
    const childCount = countLeaves(node);
    return (
      // Fragment:目录行 + (展开时)子节点。key 在外层 ensureTreeNodeKey。
      <div key={`dir:${node.dirPath}`}>
        <FileListRow
          variant="list"
          icon="folder"
          label={`${node.name} (${childCount})`}
          title={node.dirPath}
          depth={depth}
          statusBadge={badgeFor(node.tone)}
          ariaExpanded={!isCollapsed}
          leading={<Icon name={isCollapsed ? 'chevronRight' : 'chevronDown'} size={12} />}
          onClick={() => toggle(node.dirPath)}
          buildContextMenu={() =>
            buildDirMenu(node.dirPath, node.tone, () => toggle(node.dirPath))
          }
        />
        {!isCollapsed &&
          node.children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  return <div className="git-tree">{nodes.map((node) => renderNode(node, 0))}</div>;
}

/** 统计目录子树里的叶子数(用于目录标签 "src (5)")。 */
function countLeaves(node: GitTreeNode): number {
  if (node.type === 'leaf') return 1;
  return node.children.reduce((sum, c) => sum + countLeaves(c), 0);
}
