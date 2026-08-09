/**
 * @file src/shared/diff-path.test.ts
 * @purpose 单测 resolveDiffOpenFileState / parseDiffFileHeader,覆盖 Feature C
 *   「打开源文件」按钮的降级判定(normal/added/deleted/renamed/multi-file/畸形)，
 *   以及 Git core.quotePath 对中文 UTF-8 的 C 风格八进制引用。
 *
 * @对应文档:docs/规划-v0.3.3-AI交互丰富度-20260801.md Feature C;AGENTS.md §5.3 解析类必测。
 */
import { describe, expect, it } from 'vitest';
import {
  parseDiffFileHeader,
  resolveDiffOpenFileState,
  resolveOpenedDiffSourceState,
} from './diff-path';

describe('parseDiffFileHeader', () => {
  it('解析 +++ b/ 新侧路径', () => {
    expect(parseDiffFileHeader('+++ b/src/foo.ts')).toEqual({ path: 'src/foo.ts' });
  });

  it('解析 --- a/ 旧侧路径', () => {
    expect(parseDiffFileHeader('--- a/src/foo.ts')).toEqual({ path: 'src/foo.ts' });
  });

  it('/dev/null 标记该侧不存在 → path null', () => {
    expect(parseDiffFileHeader('+++ /dev/null')).toEqual({ path: null });
    expect(parseDiffFileHeader('--- /dev/null')).toEqual({ path: null });
  });

  it('去引号(含空格路径)', () => {
    expect(parseDiffFileHeader('+++ b/"weird name.ts"')).toEqual({ path: 'weird name.ts' });
  });

  it('裸路径(无 a/ b/ 前缀)也接受', () => {
    expect(parseDiffFileHeader('+++ foo.ts')).toEqual({ path: 'foo.ts' });
  });

  it('非文件头行返回 null', () => {
    expect(parseDiffFileHeader('not a header')).toBeNull();
    expect(parseDiffFileHeader('@@ -1,3 +1,4 @@')).toBeNull();
    expect(parseDiffFileHeader('+const x = 1;')).toBeNull();
  });

  it('空引号路径不崩(防御)', () => {
    // `+++ b/""` 去引号后空字符串,视为合法(虽然 git 不会产出,但不该崩)
    expect(parseDiffFileHeader('+++ b/""')).toEqual({ path: '' });
  });
});

describe('resolveDiffOpenFileState', () => {
  // 单文件 modified diff(最常见):按钮启用,relativePath 取新侧。
  const MODIFIED_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..2222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 const x = 1;
-const old = 2;
+const newVal = 3;
 const z = 4;`;

  it('modified 单文件:启用,取新侧路径,非删除', () => {
    const state = resolveDiffOpenFileState(MODIFIED_DIFF);
    expect(state.relativePath).toBe('src/foo.ts');
    expect(state.deleted).toBe(false);
  });

  const ADDED_DIFF = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+const a = 1;
+const b = 2;`;

  it('added(新文件):启用,取新侧路径,非删除(旧侧 /dev/null 不算删除)', () => {
    const state = resolveDiffOpenFileState(ADDED_DIFF);
    expect(state.relativePath).toBe('src/new.ts');
    expect(state.deleted).toBe(false);
  });

  const DELETED_DIFF = `diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-const a = 1;
-const b = 2;`;

  it('deleted(删除文件):deleted=true,relativePath 退到旧路径(供 UI 展示)', () => {
    const state = resolveDiffOpenFileState(DELETED_DIFF);
    expect(state.deleted).toBe(true);
    expect(state.relativePath).toBe('src/gone.ts');
  });

  const RENAMED_DIFF = `diff --git a/src/old.ts b/src/new.ts
similarity index 90%
rename from src/old.ts
rename to src/new.ts
--- a/src/old.ts
+++ b/src/new.ts
@@ -1,3 +1,3 @@
-const old = 1;
+const renamed = 1;
 const x = 2;`;

  it('renamed(重命名):启用,取新路径(打开重命名后的文件)', () => {
    const state = resolveDiffOpenFileState(RENAMED_DIFF);
    expect(state.relativePath).toBe('src/new.ts');
    expect(state.deleted).toBe(false);
  });

  const MULTI_DIFF = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-a
+a2
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -1 +1 @@
-b
+b2`;

  it('多文件 diff:relativePath=null(无法确定打开哪个),按钮禁用', () => {
    const state = resolveDiffOpenFileState(MULTI_DIFF);
    expect(state.relativePath).toBeNull();
    expect(state.deleted).toBe(false);
  });

  it('含空格的文件路径正确解析', () => {
    const diff = `diff --git a/"my file.ts" b/"my file.ts"
--- a/"my file.ts"
+++ b/"my file.ts"
@@ -1 +1 @@
-old
+new`;
    const state = resolveDiffOpenFileState(diff);
    expect(state.relativePath).toBe('my file.ts');
    expect(state.deleted).toBe(false);
  });

  it('Git C 风格引用的中文路径还原为真实 relativePath', () => {
    // core.quotePath=true(默认)时，Git 会把 UTF-8 路径按字节写成八进制转义，
    // 并把完整的 a/... / b/... 路径包在双引号里。按钮必须回传真实中文路径，
    // 不能把展示层的 `b/\\344...` 原样交给 cmd:git:open-file。
    const diff = String.raw`diff --git "a/\344\270\255\346\226\207.ts" "b/\344\270\255\346\226\207.ts"
index 1111111..2222222 100644
--- "a/\344\270\255\346\226\207.ts"
+++ "b/\344\270\255\346\226\207.ts"
@@ -1 +1 @@
-old
+new`;
    const state = resolveDiffOpenFileState(diff);
    expect(state.relativePath).toBe('中文.ts');
    expect(state.deleted).toBe(false);
  });

  it('只有 hunk 无文件头的裸 diff:无 +++ 头 → relativePath=null', () => {
    const diff = `@@ -1,3 +1,4 @@
 const x = 1;
-old
+new`;
    const state = resolveDiffOpenFileState(diff);
    expect(state.relativePath).toBeNull();
    expect(state.deleted).toBe(false);
  });

  it('二进制文件 diff 也能解析路径(Binary files 头之后的 ---/+++ 对)', () => {
    // git 对二进制文件输出形如:
    //   Binary files a/foo.png and b/foo.png differ
    // 但仍带 --- /+++ 头(git diff --no-index /dev/null 对二进制新增也会给头)。
    // 这里验证「带头的二进制 diff」仍按路径规则解析;真实二进制未必带头,
    // 那种情况按「无头」处理(relativePath=null)也合理。
    const diff = `diff --git a/bin.dat b/bin.dat
index 111..222 100644
Binary files a/bin.dat and b/bin.dat differ
--- a/bin.dat
+++ b/bin.dat`;
    const state = resolveDiffOpenFileState(diff);
    expect(state.relativePath).toBe('bin.dat');
    expect(state.deleted).toBe(false);
  });
});

describe('resolveOpenedDiffSourceState', () => {
  it('优先使用 GitService origin，不解析展示文本', () => {
    const state = resolveOpenedDiffSourceState(
      {
        path: 'C:\\workspace\\__marina_diff__\\escaped.diff',
        origin: {
          kind: 'git-diff',
          relativePath: '目录/中文.ts',
          repoIdentity: 'opaque-repo-id',
          sourceMissing: false,
        },
      },
      '+++ "b/\\344\\270\\255.diff"',
    );
    expect(state).toEqual({
      relativePath: '目录/中文.ts',
      deleted: false,
      repoIdentity: 'opaque-repo-id',
      requiresReopen: false,
    });
  });

  it('旧受管 Git diff 缺 origin 时禁用打开源文件，避免绕过 repo 身份校验', () => {
    const state = resolveOpenedDiffSourceState(
      { path: 'C:\\workspace\\__marina_diff__\\legacy.diff' },
      '--- a/same.ts\n+++ b/same.ts\n',
    );
    expect(state).toEqual({
      relativePath: null,
      deleted: false,
      repoIdentity: null,
      requiresReopen: true,
    });
  });

  it('普通外部 .diff 无 origin 时保留文本解析降级', () => {
    const state = resolveOpenedDiffSourceState(
      { path: 'C:\\downloads\\review.diff' },
      '--- a/src/foo.ts\n+++ b/src/foo.ts\n',
    );
    expect(state).toEqual({
      relativePath: 'src/foo.ts',
      deleted: false,
      repoIdentity: null,
      requiresReopen: false,
    });
  });
});
