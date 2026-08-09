/**
 * @file src/shared/diff-path.ts
 * @purpose 从 unified diff 文本里解析「打开源文件」所需的路径信息,
 *   供 DiffViewer 的工具栏按钮(Feature C / v0.3.3)决定启用态与点击行为。
 *
 * @背景:GitService.openDiff 现在会把原始 relativePath 作为 OpenedFile.origin
 *   透传，Marina 自产 diff 不再依赖文本反解析。这里保留两类降级能力：用户直接
 *   打开的普通 `.diff`，以及旧 workspace 快照恢复后尚无 origin 的临时 diff。
 *   Git 默认 core.quotePath=true，会把中文 UTF-8 字节写成 C 风格八进制转义，
 *   因此降级解析也必须完整解码，不能只剥双引号。
 *
 * @为什么放 shared:纯字符串解析、无 DOM/React/Electron 依赖,可在 src/shared 下
 *   单测覆盖(对齐 AGENTS.md §5.1「renderer UI 不测,纯逻辑测」纪律)。DiffViewer
 *   与未来其它消费方共享同一份语义。
 *
 * @对应文档:docs/规划-v0.3.3-AI交互丰富度-20260801.md Feature C(决策 #5 图标=file-text)
 */
import type { OpenedFile } from './types';

/** Git C 风格路径中的文本片段编码/解码器；浏览器与 Node 均原生可用。 */
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8');

/**
 * 解码 Git 双引号路径。core.quotePath=true(默认)会把非 ASCII UTF-8 字节写成
 * `\\344\\270...` 八进制序列；直接去双引号会把展示串误当成真实文件名。
 *
 * Git 的 quoted.c 语法还会产生 `\\\\` / `\\"` / `\\t` 等 C 转义。这里按字节
 * 还原后统一 UTF-8 decode，既能正确组合中文的多字节序列，也保留普通 Unicode。
 * 非双引号 token 返回 null，由调用方按原文本处理。
 */
function decodeGitQuotedPath(value: string): string | null {
  if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) return null;
  const inner = value.slice(1, -1);
  const bytes: number[] = [];
  const simpleEscapes: Record<string, number> = {
    a: 0x07,
    b: 0x08,
    t: 0x09,
    n: 0x0a,
    v: 0x0b,
    f: 0x0c,
    r: 0x0d,
    '"': 0x22,
    '\\': 0x5c,
  };

  for (let index = 0; index < inner.length; ) {
    const char = inner[index]!;
    if (char !== '\\') {
      const codePoint = inner.codePointAt(index)!;
      const literal = String.fromCodePoint(codePoint);
      bytes.push(...UTF8_ENCODER.encode(literal));
      index += literal.length;
      continue;
    }

    index += 1;
    if (index >= inner.length) {
      // 畸形尾反斜杠：保留字面量，让降级路径可见而不是静默吞字符。
      bytes.push(0x5c);
      break;
    }
    const escaped = inner[index]!;
    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      index += 1;
      while (octal.length < 3 && index < inner.length && /[0-7]/.test(inner[index]!)) {
        octal += inner[index]!;
        index += 1;
      }
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }
    const simple = simpleEscapes[escaped];
    if (simple !== undefined) {
      bytes.push(simple);
    } else {
      // Git 当前不会产生其它 escape；防御性按被转义字符本身保留。
      bytes.push(...UTF8_ENCODER.encode(escaped));
    }
    index += 1;
  }

  return UTF8_DECODER.decode(Uint8Array.from(bytes));
}

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
export function parseDiffFileHeader(line: string): { path: string | null } | null {
  // 形如 `+++ b/<rest>` 或 `--- a/<rest>`。git 对含空格/特殊字符的路径加引号。
  const m = /^(?:\+\+\+|---)\s+(.*)$/.exec(line);
  if (!m || m[1] === undefined) return null; // 不是文件头行
  let rest = m[1].trim();
  // Git 的真实输出对中文路径会把**完整** token 引用："b/\\344..."；历史测试里的
  // b/"my file.ts" 则只引用前缀后的部分。先尝试整 token 解码，再剥 a/b 前缀，
  // 最后再尝试一次后半 token，兼容两种形态且不依赖 quotePath 配置。
  rest = decodeGitQuotedPath(rest) ?? rest;
  rest = rest.replace(/^[ab]\//, '');
  rest = decodeGitQuotedPath(rest) ?? rest;
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

/** 已打开 diff 的完整来源判定；renderer 据此决定 payload 与 legacy 提示。 */
export interface OpenedDiffSourceState extends DiffOpenFileState {
  /** GitService 生成时绑定的 repo 指纹；普通外部 .diff 为 null。 */
  repoIdentity: string | null;
  /** true = 旧受管 Git diff 快照缺少 origin，为避免跨仓库误开必须要求重新打开。 */
  requiresReopen: boolean;
}

/**
 * 组合 OpenedFile 元数据与文本降级，得到「打开源文件」的唯一判定入口。
 *
 * 优先级:
 * 1. GitService origin 是导航真值（中文路径不解析展示文本，且带 repoIdentity）。
 * 2. `__marina_diff__` 下却无 origin = 旧快照。它本应有仓库身份；继续按当前 repo
 *    解析会绕过跨仓库保护，因此禁用并要求从 Git 面板重新打开。
 * 3. 用户直接打开的普通 .diff 没有 origin，保留文本解析能力。
 */
export function resolveOpenedDiffSourceState(
  file: Pick<OpenedFile, 'path' | 'origin'>,
  text: string,
): OpenedDiffSourceState {
  if (file.origin?.kind === 'git-diff') {
    return {
      relativePath: file.origin.relativePath,
      deleted: file.origin.sourceMissing,
      repoIdentity: file.origin.repoIdentity,
      requiresReopen: false,
    };
  }
  const isManagedGitDiff = file.path.split(/[\\/]+/).includes('__marina_diff__');
  if (isManagedGitDiff) {
    return {
      relativePath: null,
      deleted: false,
      repoIdentity: null,
      requiresReopen: true,
    };
  }
  return {
    ...resolveDiffOpenFileState(text),
    repoIdentity: null,
    requiresReopen: false,
  };
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
    if (sawOld && sawNew && line.startsWith('@@')) break;
  }

  // 删除文件:新侧 = /dev/null(newPath===null 且确实看到 +++ /dev/null)。
  // 注意区分「+++ /dev/null」(deleted)与「根本没 +++ 头」(畸形)。sawNew 才可信。
  const deleted = sawNew && newPath === null;

  // relativePath 优先取新侧(打开工作区当前文件);删除文件新侧是 /dev/null → 退到旧侧。
  const relativePath = !deleted ? newPath : oldPath;

  // 若既无新侧也无旧侧(完全解析不出路径),relativePath 保持 null → 按钮禁用。
  return { relativePath, deleted };
}
