/**
 * @file src/shared/diff-path.ts
 * @purpose 从 unified diff 文本里解析「打开源文件」所需的路径信息,
 *   供 DiffViewer 的工具栏按钮(Feature C / v0.3.3)决定启用态与点击行为。
 *
 * @背景:Marina 的 diff 由 GitService.openDiff 产出(单文件 `git diff HEAD -- <path>`
 *   或 untracked 的 `git diff --no-index /dev/null <path>`),写进 session 的
 *   MARINA_WORKSPACE/__marina_diff__/<sha>.diff 临时文件。DiffViewer 只拿到这段
 *   文本,需要自己反推出「这是哪个文件、是否已删除」,才能决定「打开源文件」按钮
 *   点下去该走 cmd:git:open-file 的哪个 relativePath、以及是否该禁用。
 *
 * @为什么放 shared:纯字符串解析、无 DOM/React/Electron 依赖,可在 src/shared 下
 *   单测覆盖(对齐 AGENTS.md §5.1「renderer UI 不测,纯逻辑测」纪律)。DiffViewer
 *   与未来其它消费方共享同一份语义。
 *
 * @对应文档:docs/规划-v0.3.3-AI交互丰富度-20260801.md Feature C(决策 #5 图标=file-text)
 */

/**
 * 解析单条 `--- ` / `+++ ` 文件头行,提取去掉 `a/` / `b/` 前缀与引号后的纯路径。
 * 与 highlight.ts 的 detectLanguageFromPathLine 同源正则,但本函数关注的是「路径」
 * 而非「语言」,且要区分 /dev/null(表示该侧不存在)。
 *
 * @param line 形如 `--- a/foo.ts` / `+++ b/foo.ts` / `--- /dev/null` / `+++ b/"quoted path.ts"`
 * @returns {path} 去前缀去引号后的路径;`/dev/null` 或解析失败时为 null。
 *          (注意:null 在调用方语义 = 「这一侧没有文件」,与「空字符串路径」不同。)
 *
 * @例子:
 *   parseDiffFileHeader('+++ b/src/foo.ts')        → { path: 'src/foo.ts' }
 *   parseDiffFileHeader('--- a/src/foo.ts')        → { path: 'src/foo.ts' }
 *   parseDiffFileHeader('+++ /dev/null')           → { path: null }   ← 删除侧
 *   parseDiffFileHeader('+++ b/"weird name.ts"')   → { path: 'weird name.ts' }
 *   parseDiffFileHeader('not a header')            → null             ← 不是文件头行
 */
export function parseDiffFileHeader(
  line: string,
): { path: string | null } | null {
  // 形如 `+++ b/<rest>` 或 `--- a/<rest>`。git 对含空格/特殊字符的路径加引号。
  const m = /^(?:\+\+\+|---)\s+(.*)$/.exec(line);
  if (!m || m[1] === undefined) return null; // 不是文件头行
  let rest = m[1].trim();
  // 先去 a/ b/ 前缀(git 默认头格式 +++ b/<path> / --- a/<path>)。注意:含空格/特殊字符
  // 的路径会被 git 整体加引号,如 b/"my file.ts"——引号包住的是 b/ 之后的部分,所以
  // 必须先剥前缀再剥引号,顺序不能反。
  rest = rest.replace(/^[ab]\//, '');
  // 再去引号(git 对含空格的路径加引号,如 "my file.ts")
  if (rest.startsWith('"') && rest.endsWith('"') && rest.length >= 2) {
    rest = rest.slice(1, -1);
  }
  // /dev/null 是 git 的「该侧文件不存在」标记(新增文件的 --- 侧 / 删除文件的 +++ 侧)。
  // 放在剥前缀/剥引号之后判断,以便 "/dev/null" 带引号写法也能识别。
  if (rest === '/dev/null') return { path: null };
  return { path: rest };
}

/** DiffViewer「打开源文件」按钮所需的状态判定结果。 */
export interface DiffOpenFileState {
  /**
   * 可打开的 relativePath(相对 repoRoot,可直接塞进 cmd:git:open-file payload)。
   * null = 无法确定单一路径(多文件 diff,或解析不出任何头)→ 按钮禁用。
   */
  relativePath: string | null;
  /**
   * 工作区里文件是否已删除(`+++ /dev/null` 或其它「新侧不存在」信号)。
   * true → 按钮禁用 + tooltip「文件已删除」。删除时 relativePath 仍尽量填旧路径
   * (来自 --- a/),便于将来若要扩展「恢复」类操作时有目标,但当前按钮禁用不触发。
   */
  deleted: boolean;
}

/**
 * 扫描整段 unified diff 文本,判定「打开源文件」按钮的状态。
 *
 * 语义规则(对齐 git diff HEAD 单文件场景):
 * - **单文件 diff**:只有一个 `diff --git` 块。取该块的 `+++ b/<path>`(新侧)作为
 *   relativePath;若 `+++ /dev/null`(新侧不存在)= 删除文件 → deleted=true。
 *   删除时 relativePath 回退到 `--- a/<path>`(旧路径,供 UI 展示/未来用),仍 null 表示
 *   两头都解析不出(畸形 diff)。
 * - **多文件 diff**:出现 ≥2 个 `diff --git` 块 → relativePath=null(无法判定「打开
 *   哪个文件」,按钮禁用)。这是磁盘上随便打开一个 .patch 的退化场景,GitPanel 正常
 *   产出的是单文件 diff,不会命中。
 * - **无 `diff --git` 头的裸 diff**(只有 @@ hunk,罕见):取首个 `+++ b/<path>` 作为
 *   relativePath;无任何 +++ 头 → null。
 *
 * @param text 完整 diff 文本(DiffViewer 读到的 content.text)
 */
export function resolveDiffOpenFileState(text: string): DiffOpenFileState {
  const lines = text.split('\n');

  // 统计 diff --git 块数。多块 = 多文件 diff,按钮无确定目标 → 禁用。
  // (git diff 多文件时每个文件一个 diff --git 头。)
  let blockCount = 0;
  for (const line of lines) {
    if (line.startsWith('diff --git')) blockCount++;
  }
  if (blockCount > 1) {
    return { relativePath: null, deleted: false };
  }

  // 扫描文件头,记录最后一个遇到的 --- (old) 与 +++ (new) 路径。
  // 单文件 diff 里只有一对;裸 diff 可能只有 +++。
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let sawOld = false;
  let sawNew = false;
  for (const line of lines) {
    if (line.startsWith('--- ')) {
      const parsed = parseDiffFileHeader(line);
      if (parsed) {
        oldPath = parsed.path;
        sawOld = true;
      }
    } else if (line.startsWith('+++ ')) {
      const parsed = parseDiffFileHeader(line);
      if (parsed) {
        newPath = parsed.path;
        sawNew = true;
      }
    }
    // 遇到下一个块的 hunk 就停(防止多块边界情况下读到错的头;上面已挡多块,这里防御)。
    if ((sawOld && sawNew) && line.startsWith('@@')) break;
  }

  // 删除文件:新侧 = /dev/null(newPath===null 且确实看到 +++ /dev/null)。
  // 注意区分「+++ /dev/null」(deleted)与「根本没 +++ 头」(畸形)。sawNew 才可信。
  const deleted = sawNew && newPath === null;

  // relativePath 优先取新侧(打开工作区当前文件);删除文件新侧是 /dev/null → 退到旧侧。
  const relativePath = !deleted ? newPath : oldPath;

  // 若既无新侧也无旧侧(完全解析不出路径),relativePath 保持 null → 按钮禁用。
  return { relativePath, deleted };
}
