/**
 * @file src/renderer/components/file-panel/DiffViewer.tsx
 * @purpose 渲染 unified diff,做「双层高亮」:外层 diff 行色(add=绿底/del=红底/
 *   hunk=蓝/meta=淡灰),内层代码语法高亮(从 +++ b/foo.ts 推断语言,对 +/- 行的
 *   内容部分用该语言 highlight.js 着色)。
 *
 * @v0.3.2 改造(A1/A2/A4):
 *   - hljs 栈抽到共享 highlight.ts(TextViewer 也用),本文件只消费。
 *   - 文件内查找改用 useDomTextHighlight(CSS Custom Highlight overlay)——补上 v0.3.1
 *     刻意没做的「行内字符高亮」。overlay 不改 DOM,与 hljs span 嵌套互不干扰,
 *     是绕过当初难题的正确方案。详见 useDomTextHighlight.ts 头注。
 *
 * @v0.3.3 布局对齐 TextViewer(行号槽 + grid 双列 + 水平滚动):
 *   - 加行号槽:从 hunk header @@ -a,b +c,d @@ 解析行号(ctx 用 new-side、del 用
 *     old-side、add 用 new-side),对齐 GitHub/VS Code。v0.3.2 时刻意没加,本批补齐。
 *   - DOM 改三段:gutter(行号+符号,sticky left:0 水平滚动钉住)+ body(white-space:pre)。
 *   - 行号 background:inherit 跟随行底色(add 绿/del 红/hunk 蓝),挡住横向滚过来的代码。
 *
 * @双层高亮原理(对齐 GitHub / VS Code / GitLab):
 *   diff --git a/foo.ts b/foo.ts      ← header(diff 元数据,diff 语言着色)
 *   @@ -1,3 +1,4 @@                   ← hunk(diff 元数据)
 *    const x = 1;                     ← ctx(代码语法着色)
 *   -const old = 2;                   ← del(红底 + 代码语法着色)
 *   +const newVal = 3;                ← add(绿底 + 代码语法着色)
 *   行底色 + token 色共存:外层 .diff-line-add 控制背景,内层 .hljs-keyword/string/number
 *   控制 token 前景色。两层正交,互不覆盖。
 *
 * @逐行 highlight(非整段):对每行单独 hljs.highlight,产出独立 HTML(无跨行 span)。
 *   多语言场景下,context/+/- 行用「推断的代码语言」,header/hunk/meta/nl 行用 diff 语言。
 *
 * @安全:hljs 输出只含 <span class="hljs-...">text</span>,无 <script>/事件/js:URL。
 *   CSP style-src 'unsafe-inline' 已含,这里不用 inline style(纯 class + 外部 CSS)。
 *   diff 内容来自 GitService 受控文件(非用户任意输入),双重保险。
 *
 * @不做(刻意克制,对齐 §13.2 / 方案-diff高亮-20260719.md §5.2):
 * - 词级 intra-line word diff(LCS,GitHub 默认也不开)
 * - 并排 side-by-side 视图(IDE 级能力,滑向 Git GUI)
 *
 * @对应文档:docs/方案-diff高亮-20260719.md(方案 B 双层高亮)、ADR-017、ADR-019
 */
import {
  useLayoutEffect,
  useMemo,
  useRef,
  type UIEvent as ReactUIEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import type { OpenedFile } from '@shared/types';
import type { PanelSearchProps } from '../layout/panel-registry';
import { COMMAND_CHANNELS } from '@shared/protocol';
import { resolveOpenedDiffSourceState } from '@shared/diff-path';
import { useFileContent } from './useFileContent';
import { useDomTextHighlight } from '../../hooks/useDomTextHighlight';
import { useFileViewerScroll } from '../../hooks/useFileViewerScroll';
import { useTranslation } from '../LanguageProvider';
import { useToast } from '../Toast';
import { Icon } from '../icons';
import { highlightLine, detectLanguageFromPathLine } from './highlight';

/** 行视觉种类(外层 diff 行色,由行首字符决定)。 */
type DiffRowKind = 'header' | 'meta' | 'hunk' | 'add' | 'del' | 'nl' | 'ctx';

/** 按行首字符判定行的视觉种类(diff 元数据 vs 代码内容)。 */
function classifyLine(line: string): DiffRowKind {
  if (line.startsWith('\\ ')) return 'nl';
  if (line.startsWith('@@')) return 'hunk';
  // file header:注意 +++ 必须在 + 之前判,--- 必须在 - 之前判
  if (line.startsWith('diff --git') || line.startsWith('--- ') || line.startsWith('+++ ')) {
    return 'header';
  }
  if (
    line.startsWith('index ') ||
    line.startsWith('similarity ') ||
    line.startsWith('dissimilarity ') ||
    line.startsWith('rename ') ||
    line.startsWith('copy ') ||
    line.startsWith('new file ') ||
    line.startsWith('deleted file ') ||
    line.startsWith('old mode ') ||
    line.startsWith('new mode ') ||
    line.startsWith('new simlink ') ||
    line.startsWith('deleted simlink ') ||
    line.startsWith('old tree ') ||
    line.startsWith('new tree ') ||
    line.startsWith('Binary files ')
  ) {
    return 'meta';
  }
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}

/** 行首符号(add=+, del=-, 其余=空格槽保持对齐)。 */
function signFor(kind: DiffRowKind): string {
  switch (kind) {
    case 'add':
      return '+';
    case 'del':
      return '-';
    default:
      return ' ';
  }
}

/**
 * 大 diff 客户端兜底。diff 同时挂 gutter + code 两套行 DOM，预算低于 TextViewer。
 * 真实 Electron 31 基准:旧 50k 行冻结 7.0s；500 行处理/挂载无 >100ms Long Task。
 */
const MAX_RENDER_ROWS = 500;

interface DiffRow {
  key: number;
  kind: DiffRowKind;
  /** 文件行号(v0.3.3):代码行按 hunk 行号计数;元数据/header/hunk/nl 行为 null(不显示)。
   * ctx 行用 new-side 行号,del 行用 old-side 行号(add 用 new-side),对齐 GitHub/VS Code。 */
  lineNum: number | null;
  /** 行内 HTML(hljs 产出),仅供 dangerouslySetInnerHTML 消费。 */
  html: string;
}

/**
 * 把已按预算截取的 diff 行切成 DiffRow[]。逐行 highlight,跟踪当前块的语言(遇 +++ b/path 切换),
 * 并按 hunk header @@ -a,b +c,d @@ 维护 old/new 双侧行号计数器(v0.3.3 行号槽)。
 *
 * 语言选择规则:
 * - header / hunk / meta / nl 行:用 'diff' 语言(它们是 diff 元数据,不是代码)
 * - add / del / ctx 行:用当前块推断的代码语言(未推断出则回退 'diff')
 *
 * 行号规则(unified diff):
 * - 遇 @@ -oldStart,oldLen +newStart,newLen @@:oldLn=oldStart,newLn=newStart
 * - ctx 行(行首空格):显示 newLn,然后 oldLn++、newLn++
 * - del 行(-):显示 oldLn,然后 oldLn++
 * - add 行(+):显示 newLn,然后 newLn++
 * - header/hunk/meta/nl:无行号(null)
 *
 * 单文件 diff:开头一个 +++ b/foo.ts 设定全块语言。
 * 多文件 diff:每个 diff --git 块重新解析 +++ b/... 切换。
 */
function buildRows(lines: readonly string[]): DiffRow[] {
  let currentLang = 'diff'; // 默认 diff 语言(纯行级,无 token)
  // hunk 行号计数器(null = 还没进第一个 hunk,此时代码行不该出现,但防御性给 null)
  let oldLn: number | null = null;
  let newLn: number | null = null;
  const rows: DiffRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const kind = classifyLine(line);
    // 遇 hunk header @@ -a,b +c,d @@:重置双侧计数器。
    if (kind === 'hunk') {
      const parsed = parseHunkHeader(line);
      oldLn = parsed?.oldStart ?? null;
      newLn = parsed?.newStart ?? null;
    }
    // 遇文件头行(+++ b/path 或 --- a/path)更新当前语言。
    if (kind === 'header') {
      const detected = detectLanguageFromPathLine(line);
      if (detected) {
        currentLang = detected;
      } else if (line.startsWith('+++ ') || line.startsWith('--- ')) {
        // /dev/null 或无法识别扩展名 → 回退 diff 语言(本块不再尝试代码高亮)
        currentLang = 'diff';
      }
    }
    const lang = kind === 'add' || kind === 'del' || kind === 'ctx' ? currentLang : 'diff';
    const stripped =
      kind === 'add' || kind === 'del' || kind === 'ctx' ? line.replace(/^[+\-\\ ]/, '') : line;

    // 行号:ctx 显示 newLn,del 显示 oldLn,add 显示 newLn;计数后递增。
    let lineNum: number | null = null;
    if (kind === 'ctx' && newLn != null) {
      lineNum = newLn;
      oldLn = oldLn != null ? oldLn + 1 : null;
      newLn = newLn + 1;
    } else if (kind === 'del' && oldLn != null) {
      lineNum = oldLn;
      oldLn = oldLn + 1;
    } else if (kind === 'add' && newLn != null) {
      lineNum = newLn;
      newLn = newLn + 1;
    }

    rows.push({ key: i, kind, lineNum, html: highlightLine(stripped, lang) });
  }
  return rows;
}

/**
 * 解析 hunk header `@@ -oldStart,oldLen +newStart,newLen @@` 的 old/new 起始行号。
 * len 省略时默认 1(如 `@@ -5 +5 @@`)。解析失败返回 null(行号计数器保持不变)。
 */
function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  // 形如 @@ -10,7 +10,9 @@ 或 @@ -1 +1 @@(省略 len)。只取首组 -a 和 +c。
  const m = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
  if (!m || m[1] == null || m[2] == null) return null;
  const oldStart = Number(m[1]);
  const newStart = Number(m[2]);
  if (!Number.isFinite(oldStart) || !Number.isFinite(newStart)) return null;
  return { oldStart, newStart };
}

interface ViewerProps {
  sessionId: string;
  file: OpenedFile;
  /** dock 级搜索状态(文件内查找)。 */
  search: PanelSearchProps;
}

export function DiffViewer({ sessionId, file, search }: ViewerProps): JSX.Element {
  const { tx } = useTranslation();
  const toast = useToast();
  const content = useFileContent(sessionId, file.path, file.mtimeMs);
  // 行号/符号与代码是两个物理分离的滚动 pane。代码 pane 独占横/纵滚动,
  // gutter 只镜像 scrollTop；这样正文从布局层就不可能滚进行号栏,不需要
  // sticky + 不透明背景“遮住”正文。
  const bodyScrollRef = useRef<HTMLDivElement | null>(null);
  const gutterScrollRef = useRef<HTMLDivElement | null>(null);
  const codeLinesRef = useRef<HTMLDivElement | null>(null);

  const syncGutterScroll = (event: ReactUIEvent<HTMLDivElement>): void => {
    if (gutterScrollRef.current) {
      gutterScrollRef.current.scrollTop = event.currentTarget.scrollTop;
    }
  };

  // 鼠标停在 gutter 上滚轮时仍应滚代码 pane；水平滚轮也只交给代码 pane。
  const forwardGutterWheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    const body = bodyScrollRef.current;
    if (!body) return;
    // 不 preventDefault:React/Chromium 的 wheel root listener 可能是 passive。
    // gutter/outer 都是 overflow:hidden,浏览器默认滚动不会产生第二次位移。
    body.scrollBy({ left: event.deltaX, top: event.deltaY });
  };

  const { rows, truncatedClient } = useMemo(() => {
    if (!content || content.kind !== 'diff') return { rows: null, truncatedClient: false };
    // 旧实现先对完整 2MB/最多 50k 行逐行 highlight，再 slice 前 N 行；即使 DOM
    // 截断了，隐藏的 49k 行仍在主线程做 hljs，实测单次冻结 7 秒。split 的 limit
    // 只取 N+1 行用于判断截断，buildRows 从源头只处理可见预算。
    const visibleLines = content.text.split('\n', MAX_RENDER_ROWS + 1);
    const truncatedClient = visibleLines.length > MAX_RENDER_ROWS;
    return {
      rows: buildRows(truncatedClient ? visibleLines.slice(0, MAX_RENDER_ROWS) : visibleLines),
      truncatedClient,
    };
  }, [content]);

  // 统一来源判定优先用 main 透传的 origin；普通外部 .diff 才解析文本。旧版受管
  // __marina_diff__ 快照若没有 origin，会明确要求重新从 Git 面板打开，不能在
  // session 已 cd 到其它 repo 后用当前仓库解释旧 relativePath。
  const openFileState = useMemo(() => {
    if (!content || content.kind !== 'diff') {
      return {
        relativePath: null,
        deleted: false,
        repoIdentity: null,
        requiresReopen: false,
      } as const;
    }
    return resolveOpenedDiffSourceState(file, content.text);
  }, [content, file]);

  // 点「打开源文件」:走 GIT_OPEN_FILE(与 GitPanel 右键 openFile 同通道),main 端
  // GitService.openFile 读工作区当前内容进面板只读查看。删除/多文件态已在 UI 禁用,
  // 这里只兜底网络/main 侧异常(如 SSH、NotARepo)→ toast 提示。
  const handleOpenFile = (): void => {
    const { relativePath } = openFileState;
    if (!relativePath) return; // 防御:disabled 态不应触发,但仍 guard
    window.api
      .invoke(COMMAND_CHANNELS.GIT_OPEN_FILE, {
        sessionId,
        relativePath,
        // 只有 GitService 生成的 diff 才有 repoIdentity。指纹让 main 检查 session
        // 是否仍位于生成该 diff 的仓库；普通外部 .diff 仍按当前 repo 的文本路径打开。
        ...(openFileState.repoIdentity ? { repoIdentity: openFileState.repoIdentity } : {}),
      })
      .catch((err: unknown) => {
        console.warn('[DiffViewer] open-file failed', err);
        toast.push({
          kind: 'error',
          message: `${tx('打开文件失败:', 'Open file failed: ')}${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      });
  };

  // 右 pane 的水平滚动条会占掉自身 clientHeight；左 pane 没有滚动条。
  // 若不补同高的尾部空间,滚到最底时两边 maxScrollTop 不同,最后一行会错位。
  // 把实际 scrollbar 高度写成 CSS 变量,由 gutter-lines 作为 bottom padding。
  useLayoutEffect(() => {
    const body = bodyScrollRef.current;
    const gutter = gutterScrollRef.current;
    if (!body || !gutter) return undefined;
    const updateInset = (): void => {
      const horizontalScrollbarHeight = Math.max(0, body.offsetHeight - body.clientHeight);
      gutter.style.setProperty(
        '--diff-horizontal-scrollbar-height',
        `${horizontalScrollbarHeight}px`,
      );
    };
    updateInset();
    const frame = requestAnimationFrame(updateInset);
    const observer = new ResizeObserver(updateInset);
    observer.observe(body);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [content, rows]);

  // 文件内查找:只遍历右侧代码 pane。数字/符号栏已是 sibling pane,
  // 从 DOM 结构上不在搜索容器里,无需 skipSelector 排除。
  useDomTextHighlight({
    sessionId,
    containerRef: bodyScrollRef,
    query: search.query,
    caseSensitive: search.caseSensitive,
    active: search.visible,
    contentVersion: content,
  });

  useFileViewerScroll({
    sessionId,
    path: file.path,
    kind: file.kind,
    scrollRef: bodyScrollRef,
    layoutRef: codeLinesRef,
    ready: content?.kind === 'diff',
    restoreVersion: file.mtimeMs,
    searchActive: search.visible && search.query.length > 0,
    onApply: (scrollTop) => {
      if (gutterScrollRef.current) gutterScrollRef.current.scrollTop = scrollTop;
    },
  });

  // 中键自动滚动:走 Chromium 原生 autoscroll(与 TextViewer 一致),不 preventDefault
  //  中键 mousedown,点中键即触发浏览器原生圆圈图标 + 持续滚动。

  if (!content) {
    return <div className="file-viewer-loading">{tx('加载中…', 'Loading…')}</div>;
  }
  if (content.kind !== 'diff') {
    return (
      <div className="file-viewer-error">
        {content.kind === 'unknown'
          ? content.message
          : tx('内容类型不匹配', 'content kind mismatch')}
      </div>
    );
  }
  const displayRows = rows as DiffRow[];
  const showTruncated = content.truncated || truncatedClient;

  // 「打开源文件」按钮启用态:有明确 relativePath 且非删除时才可点。
  // deleted → 禁用 + tooltip「文件已删除」;relativePath=null(多文件/畸形)→ 禁用 +
  // tooltip「无法确定文件」。
  const openFileDisabled = !openFileState.relativePath || openFileState.deleted;
  const openFileTooltip = openFileState.requiresReopen
    ? tx('来源信息已过期，请从 Git 面板重新打开 diff', 'Source expired; reopen from Git')
    : openFileState.deleted
      ? tx('文件已删除', 'File has been deleted')
      : !openFileState.relativePath
        ? tx('无法确定文件', 'Cannot determine file')
        : tx('打开源文件', 'Open source file');

  return (
    <div className="diff-viewer">
      {/* v0.3.3 Feature C:顶部工具栏(跨两列全宽)。当前只有「打开源文件」一个按钮:
       * 走 GIT_OPEN_FILE 在面板只读打开工作区原文(非 diff)。图标题决策 #5 = file-text
       * (语义中性「这是个文件」,不暗示编辑/外部查看,与面板只读定位匹配)。 */}
      <div className="diff-viewer-toolbar">
        <button
          type="button"
          className="diff-viewer-toolbar-btn"
          onClick={handleOpenFile}
          disabled={openFileDisabled}
          title={openFileTooltip}
          aria-label={openFileTooltip}
        >
          <Icon name="fileText" size={14} />
          <span className="diff-viewer-toolbar-label">{tx('打开源文件', 'Open source file')}</span>
        </button>
      </div>
      {/* gutter 与正文是物理分离的 sibling pane。gutter 不参与正文的横向滚动,
       * 因而不存在“正文滚到下面、再靠 sticky 背景遮住”的重叠关系。 */}
      <div
        ref={gutterScrollRef}
        className="diff-gutter-pane"
        aria-hidden="true"
        onWheel={forwardGutterWheel}
      >
        <div className="diff-gutter-lines">
          {displayRows.map((row) => (
            <div key={row.key} className={`diff-gutter-row diff-line-${row.kind}`}>
              <span className="diff-gutter-number">{row.lineNum != null ? row.lineNum : ''}</span>
              <span className="diff-line-sign">{signFor(row.kind)}</span>
            </div>
          ))}
          {showTruncated && <div className="diff-gutter-truncated-spacer" />}
        </div>
      </div>

      {/* 右 pane 独占横/纵滚动。onScroll 只把 scrollTop 镜像给左 pane；
       * scrollLeft 永远只存在于此处，所以代码不可能进入数字栏。 */}
      <div ref={bodyScrollRef} className="diff-code-pane" onScroll={syncGutterScroll}>
        <div className="diff-code-lines" ref={codeLinesRef}>
          {displayRows.map((row) => (
            <div key={row.key} data-line={row.key} className={`diff-line diff-line-${row.kind}`}>
              {/* hljs 输出只含 class span,无脚本/事件,安全。来源是 GitService 受控文件。 */}
              <span
                className="diff-line-body"
                dangerouslySetInnerHTML={{ __html: row.html || ' ' }}
              />
            </div>
          ))}
          {showTruncated && (
            <div className="file-truncated-mark">
              {truncatedClient
                ? tx(
                    `…(diff 过大,仅显示前 ${MAX_RENDER_ROWS} 行)`,
                    `…(diff too large, showing first ${MAX_RENDER_ROWS} lines only)`,
                  )
                : tx('…(diff 过大,仅显示前 2MB)', '…(diff too large, showing first 2MB only)')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
