/**
 * @file src/shared/build-git-tree.test.ts
 * @purpose 验证 buildGitTree 的目录聚合、tone 继承、排序。
 */
import { describe, expect, it } from 'vitest';
import { buildGitTree, moreSevereTone, type GitTreeDir, type GitTreeNode } from './build-git-tree';

function leafNames(nodes: GitTreeNode[]): string[] {
  return nodes.flatMap(function collect(n: GitTreeNode): string[] {
    if (n.type === 'leaf') return [n.name];
    return n.children.flatMap(collect);
  });
}

describe('buildGitTree', () => {
  it('空输入返回空数组', () => {
    expect(buildGitTree([])).toEqual([]);
  });

  it('根级文件(无目录)→ 全叶子', () => {
    const tree = buildGitTree([
      { relativePath: 'README.md', tone: 'modified' },
      { relativePath: 'a.txt', tone: 'added' },
    ]);
    expect(tree).toHaveLength(2);
    expect(tree.every((n) => n.type === 'leaf')).toBe(true);
    expect(leafNames(tree).sort()).toEqual(['README.md', 'a.txt']);
  });

  it('嵌套文件聚合到目录', () => {
    const tree = buildGitTree([
      { relativePath: 'src/a.ts', tone: 'modified' },
      { relativePath: 'src/b.ts', tone: 'added' },
    ]);
    expect(tree).toHaveLength(1);
    const src = tree[0];
    expect(src?.type).toBe('dir');
    expect(src?.name).toBe('src');
    expect((src as GitTreeDir).children).toHaveLength(2);
    expect(leafNames(tree).sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('多级目录嵌套', () => {
    const tree = buildGitTree([
      { relativePath: 'src/main/foo.ts', tone: 'modified' },
      { relativePath: 'src/test/bar.ts', tone: 'untracked' },
    ]);
    expect(tree).toHaveLength(1);
    const src = tree[0];
    expect(src?.type).toBe('dir');
    expect(src?.name).toBe('src');
    const srcDir = src as GitTreeDir;
    expect(srcDir.children).toHaveLength(2); // main/ + test/
    const mainDir = srcDir.children.find((c) => c.type === 'dir' && c.name === 'main') as GitTreeDir | undefined;
    expect(mainDir?.type).toBe('dir');
    expect(mainDir?.children).toHaveLength(1);
  });

  it('目录继承子树最严重 tone(modified vs added → modified)', () => {
    const tree = buildGitTree([
      { relativePath: 'src/a.ts', tone: 'added' },
      { relativePath: 'src/b.ts', tone: 'modified' },
    ]);
    expect(tree[0]?.type).toBe('dir');
    expect((tree[0] as { tone: string }).tone).toBe('modified');
  });

  it('目录 tone 沿祖先链向上传播(深层 conflict 提升到根)', () => {
    const tree = buildGitTree([
      { relativePath: 'src/a.ts', tone: 'modified' },
      { relativePath: 'src/deep/conflict.ts', tone: 'conflict' },
    ]);
    // src 的 tone 应是 conflict(子树有 conflict)
    expect(tree[0]?.type).toBe('dir');
    expect((tree[0] as { tone: string }).tone).toBe('conflict');
  });

  it('排序:目录在前,文件在后;同级字母序', () => {
    const tree = buildGitTree([
      { relativePath: 'zfile.ts', tone: 'modified' },
      { relativePath: 'src/x.ts', tone: 'modified' },
      { relativePath: 'src/y.ts', tone: 'modified' },
      { relativePath: 'adir/a.ts', tone: 'modified' },
    ]);
    expect(tree[0]?.type).toBe('dir'); // adir
    expect(tree[1]?.type).toBe('dir'); // src
    expect(tree[2]?.type).toBe('leaf'); // zfile
    expect((tree[0] as { name: string }).name).toBe('adir');
    expect((tree[1] as { name: string }).name).toBe('src');
  });

  it('rename 保留 oldPath', () => {
    const tree = buildGitTree([
      { relativePath: 'new.ts', oldPath: 'old.ts', tone: 'renamed' },
    ]);
    const leaf = tree[0];
    expect(leaf?.type).toBe('leaf');
    expect((leaf as { oldPath?: string }).oldPath).toBe('old.ts');
  });

  it('混合根文件 + 嵌套', () => {
    const tree = buildGitTree([
      { relativePath: 'README.md', tone: 'modified' },
      { relativePath: 'src/a.ts', tone: 'added' },
      { relativePath: 'docs/guide.md', tone: 'untracked' },
    ]);
    expect(tree).toHaveLength(3);
    expect(tree.every((n) => n.type === 'dir' || n.type === 'leaf')).toBe(true);
    // 目录在前
    expect(tree[0]?.type).toBe('dir');
    expect(tree[2]?.type).toBe('leaf');
  });

  it('同目录多文件:叶子间不互相影响 tone', () => {
    const tree = buildGitTree([
      { relativePath: 'd/a.ts', tone: 'added' },
      { relativePath: 'd/b.ts', tone: 'added' },
    ]);
    const d = tree[0];
    expect(d?.type).toBe('dir');
    expect((d as { tone: string }).tone).toBe('added');
    expect((d as GitTreeDir).children.every((c) => c.type === 'leaf')).toBe(true);
  });
});

describe('moreSevereTone', () => {
  it('conflict 压一切', () => {
    expect(moreSevereTone('conflict', 'modified')).toBe('conflict');
    expect(moreSevereTone('added', 'conflict')).toBe('conflict');
  });
  it('modified > added > untracked > deleted > renamed', () => {
    expect(moreSevereTone('modified', 'added')).toBe('modified');
    expect(moreSevereTone('untracked', 'deleted')).toBe('untracked');
    expect(moreSevereTone('deleted', 'renamed')).toBe('deleted');
  });
  it('相同 tone 返回自身', () => {
    expect(moreSevereTone('modified', 'modified')).toBe('modified');
  });
});
