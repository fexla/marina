/**
 * @file src/renderer/components/file-panel/MarkdownCodeBlock.tsx
 * @purpose Markdown fenced code block 的可交互外壳:语言标签 + 复制 + 一键运行
 *   + 流式输出区 + exit code。
 *
 * @关键设计:
 * - 执行模型(v0.3.3,ADR-023):点击"运行"调 cmd:system:run-code-block,main/daemon
 *   直接 child_process.spawn 对应 shell(不经 PTY/xterm)。stdout/stderr 经
 *   evt:system:code-block-output 流式回推,退出经 evt:system:code-block-exited。
 *   当前终端是 Claude Code / vim 等任何程序都不会被干扰。
 * - 无确认弹窗:产品决策明确移除风险分级/确认框,点击即跑。失败只弹 toast
 *   (session 已退出 / shell 未装 / 不是 owner 等)。
 * - 状态:running 时按钮变"停止",再次点击调 cmd:system:stop-code-block(SIGKILL)。
 *   退出后显示 exit code(0=绿,非 0=红),输出区保留供用户阅读。
 * - 多次运行:每次点击产生独立 runId;只在当前无运行时才允许新启动(避免连点
 *   起一堆重复进程)。停止/退出后可再次运行,清除按钮把已结束结果重置为空。
 * - 生命周期:运行状态与事件桥在 code-block-run-cache.ts 的组件外 L1 缓存中。
 *   切 terminal/面板导致本组件卸载时不停止进程;切回按 cache key 恢复流式输出。
 *   真正关闭窗口仍由 main CodeBlockRunner.removeClient 杀掉该 client 的任务。
 *
 * @对应文档章节: docs/方案-markdown代码块执行-20260731.md;软件定义书 ADR-023。
 *
 * @不要在这里做的事:
 * - 不做命令扫描 / 风险分级 / 确认弹窗 —— 产品决策已移除。
 * - 不把输出持久化到 localStorage/磁盘;组件外缓存仅是窗口生命周期 L1 工作态。
 * - 不经 PTY(sendInput 是终端交互的职责,代码块执行走独立 spawn)。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { COMMAND_CHANNELS, type CodeBlockLanguage } from '@shared/protocol';
import { isRunnable, resolveLanguage } from '@shared/markdown-command';
import { Icon } from '../icons';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { useToast } from '../Toast';
import { useTranslation } from '../LanguageProvider';
import {
  attachCodeBlockRun,
  beginCodeBlockRun,
  clearCodeBlockRun,
  createCodeBlockRunKey,
  failCodeBlockRun,
  useCodeBlockRunSnapshot,
} from './code-block-run-cache';

interface MarkdownCodeBlockProps {
  /** Markdown 面板绑定的 session;main/daemon 据此读 backend 与 currentCwd。 */
  sessionId: string;
  /** 文档稳定身份,只用于窗口内 cache identity,不要求是文件路径,不写日志/磁盘。 */
  documentIdentity: string;
  /** react-markdown 源位置(offset 优先,line:column 兜底),区分同文档重复代码块。 */
  sourcePosition: string | number;
  /** react-markdown code 节点的 className,形如 `language-bash`。 */
  className: string | undefined;
  /** 代码块原文(react-markdown code 节点的 children 字符串)。 */
  code: string;
  /** v0.3.3 远程 sudo:SSH session 时为 true,显示「🛡 sudo 运行」按钮(仅远程生效)。 */
  allowSudo?: boolean;
}

/**
 * 单个 fenced code block 的可交互外壳。由共享 MarkdownDocument 的 pre renderer
 * 在识别到 code 子节点后挂载;非 shell 语言仍渲染普通 <pre><code>(无运行按钮)。
 */
export function MarkdownCodeBlock({
  sessionId,
  documentIdentity,
  sourcePosition,
  className,
  code,
  allowSudo,
}: MarkdownCodeBlockProps): JSX.Element {
  const { tx } = useTranslation();
  const copyToClipboard = useCopyToClipboard();
  const toast = useToast();

  // 归一化语言 + 可运行判定。resolveLanguage 命中受支持 shell 才显示"运行"。
  const language = resolveLanguage(className);
  const runnable = isRunnable(language, code);
  // 语言标签文案:优先归一化后的 shell 名,否则从 className 抽原标签,再否则隐藏。
  const label = language ?? extractRawLabel(className);

  const cacheKey = useMemo(
    () => createCodeBlockRunKey(sessionId, documentIdentity, sourcePosition, code),
    [code, documentIdentity, sessionId, sourcePosition],
  );
  const { state, runId, output, exitCode } = useCodeBlockRunSnapshot(cacheKey);

  // 代码块内文本选区:选中后在所属代码块内部浮出“运行选中”按钮,点它只跑
  // 选中片段。工具栏“运行”始终跑整块,两者独立。
  //
  // selectionchange 在拖选过程中高频触发,只负责作废旧按钮;位置仅在 mouseup
  // 计算一次。原始 Selection Range 另存 ref,避免 mouseup 后到达的同一次
  // selectionchange 把刚显示的按钮清掉。选中文本也存 ref,防止点击按钮时浏览器
  // 清空选区后 onClick 读不到命令。
  const blockRef = useRef<HTMLDivElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const selectionRef = useRef<string | null>(null);
  const acceptedSelectionRef = useRef<Range | null>(null);
  const [floatPos, setFloatPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    interface ClippedSelection {
      range: Range;
      startPosition: number;
      endPosition: number;
    }

    /** 把选区钳到指定 <pre> 内容范围。完全不相交返回 null。 */
    const clipRangeToPre = (selected: Range, pre: HTMLPreElement): ClippedSelection | null => {
      const preContents = pre.ownerDocument.createRange();
      preContents.selectNodeContents(pre);
      // comparePoint:-1=点在 pre 内容前,0=在内容内,1=在内容后。
      const startPosition = preContents.comparePoint(selected.startContainer, selected.startOffset);
      const endPosition = preContents.comparePoint(selected.endContainer, selected.endOffset);
      if (startPosition > 0 || endPosition < 0) return null;

      const range = selected.cloneRange();
      if (startPosition < 0) range.setStart(pre, 0);
      if (endPosition > 0) range.setEnd(pre, pre.childNodes.length);
      return range.collapsed ? null : { range, startPosition, endPosition };
    };

    /**
     * 把当前 Selection 归属到唯一一个代码块。
     *
     * 普通拖选必须完整位于一个 <pre> 内;横跨两个代码块时 intersectedCount > 1,
     * 所有块均拒绝。唯一例外是 Chromium 三击代码块末行:实测浏览器会自动把
     * focus 扩到后续 H2,尽管用户只三击了代码行。只有 mouseup.detail >= 3 且
     * 选区起点在 pre 内、终点越过 pre 尾部时才裁掉多选部分;普通跨界拖选不裁。
     */
    const matchSelection = (
      sel: Selection,
      allowTripleClickTailClip: boolean,
    ): { range: Range; text: string } | null => {
      const currentPre = preRef.current;
      if (!currentPre || sel.isCollapsed || sel.rangeCount === 0) return null;
      const selected = sel.getRangeAt(0);

      let intersectedCount = 0;
      let currentClip: ClippedSelection | null = null;
      for (const candidate of document.querySelectorAll<HTMLPreElement>('.md-code-block > pre')) {
        const clipped = clipRangeToPre(selected, candidate);
        if (!clipped || !clipped.range.toString().trim()) continue;
        intersectedCount += 1;
        if (candidate === currentPre) currentClip = clipped;
        // 横跨多个代码块:任何块都不应显示自己的按钮。
        if (intersectedCount > 1) return null;
      }
      if (intersectedCount !== 1 || !currentClip) return null;

      const fullyInside = currentClip.startPosition === 0 && currentClip.endPosition === 0;
      const chromiumTripleClickTail =
        allowTripleClickTailClip && currentClip.startPosition === 0 && currentClip.endPosition > 0;
      if (!fullyInside && !chromiumTripleClickTail) return null;

      const text = currentClip.range.toString();
      return text.trim() ? { range: currentClip.range, text } : null;
    };

    const rangesEqual = (a: Range, b: Range): boolean =>
      a.startContainer === b.startContainer &&
      a.startOffset === b.startOffset &&
      a.endContainer === b.endContainer &&
      a.endOffset === b.endOffset;

    const clearSelection = (): void => {
      acceptedSelectionRef.current = null;
      selectionRef.current = null;
      setFloatPos(null);
    };

    const onSelectionChange = (): void => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        clearSelection();
        return;
      }
      // mouseup 已接受的同一个 Selection:selectionchange 可能晚到,不得清掉新按钮。
      const accepted = acceptedSelectionRef.current;
      if (accepted && rangesEqual(sel.getRangeAt(0), accepted)) return;

      // 拖选过程中先隐藏旧按钮;只有 mouseup 才决定新选区是否合法并重新定位。
      acceptedSelectionRef.current = null;
      selectionRef.current = matchSelection(sel, false)?.text ?? null;
      setFloatPos(null);
    };

    // document 级 mouseup 保证鼠标在代码块边缘外松手也会触发;归属规则仍由
    // matchSelection 严格检查,普通跨界或横跨多个代码块都会被拒绝。
    const onMouseUp = (event: MouseEvent): void => {
      // 点击悬浮按钮本身也会冒泡一个新的 document mouseup。三击末行的原始
      // Selection 越过 pre 尾部,而按钮点击的 detail=1;若重新做普通选区校验会
      // 在 click 之前 clearSelection,导致 handleRunSelection 读不到命令。按钮的
      // mousedown 已 preventDefault 保留选区,所以这里必须保留刚接受的 ref。
      const target = event.target;
      if (target instanceof Element && target.closest('.md-code-block-run-float')) return;

      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        clearSelection();
        return;
      }
      const match = matchSelection(sel, event.detail >= 3);
      const block = blockRef.current;
      if (!match || !block) {
        clearSelection();
        return;
      }

      acceptedSelectionRef.current = sel.getRangeAt(0).cloneRange();
      selectionRef.current = match.text;

      // fixed 会把按钮钉在 viewport,页面滚动后它留在屏幕原地。这里把选区的
      // viewport rect 换算成代码块内部坐标,配合 wrapper position:relative +
      // 按钮 position:absolute;滚动时按钮自然随文档和代码块一起移动。
      const rect = match.range.getBoundingClientRect();
      const blockRect = block.getBoundingClientRect();
      // 悬浮按钮复用顶部运行按钮的基础 class;定位也直接读后者真实宽高,
      // 避免 CSS padding/font 变化后两者尺寸一致但边界钳位仍按旧 30×30 计算。
      const runButton = block.querySelector<HTMLButtonElement>('.md-code-block-run');
      const btnWidth = runButton?.offsetWidth ?? 30;
      const btnHeight = runButton?.offsetHeight ?? 20;
      const gap = 4;
      const maxLeft = Math.max(gap, blockRect.width - btnWidth - gap);
      const left = Math.max(gap, Math.min(rect.right - blockRect.left, maxLeft));
      const above = rect.top - blockRect.top - btnHeight - gap;
      const rawTop = above >= gap ? above : rect.bottom - blockRect.top + gap;
      const maxTop = Math.max(gap, blockRect.height - btnHeight - gap);
      const top = Math.max(gap, Math.min(rawTop, maxTop));
      setFloatPos({ top, left });
    };

    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  const startRun = useCallback(
    (codeToRun: string, sudo = false): void => {
      if (state === 'running' || !language) return;
      // cache 先进入 running 并清空旧结果;事件桥在组件卸载后仍持续收输出。
      beginCodeBlockRun(cacheKey);
      window.api
        .invoke(COMMAND_CHANNELS.SYSTEM_RUN_CODE_BLOCK, {
          sourceSessionId: sessionId,
          language,
          code: codeToRun,
          // 远程 sudo:仅 SSH session 生效;密码由 main 内存仓库喂 ssh stdin。
          // sudo 命令缺密码时 main 扌 SudoPasswordRequired → reject,这里走 catch 提示。
          sudo,
        })
        .then((res) => {
          attachCodeBlockRun(cacheKey, res.runId);
        })
        .catch((err: unknown) => {
          // main 端 CodeBlockError(code/message)经 IPC reject 回来。
          // 不回显命令正文,只展示错误码对应的友好提示。
          const message = err instanceof Error ? err.message : String(err);
          failCodeBlockRun(cacheKey, message);
          toast.push({
            kind: 'error',
            message: tx('代码块执行失败', 'Code block run failed'),
          });
        });
    },
    [cacheKey, state, language, sessionId, toast, tx],
  );

  // 工具栏“运行”:始终跑整块(不读选区 —— 选中片段走悬浮按钮)。
  const handleRun = useCallback((): void => {
    startRun(code);
  }, [startRun, code]);

  // 工具栏“sudo 运行”:远程 SSH session 才有意义(allowSudo 由 MarkdownDocument
  // 依 session.pathId 传入)。密码缺失时 main 扌 SudoPasswordRequired,reject 进 catch。
  const handleRunSudo = useCallback((): void => {
    startRun(code, true);
  }, [startRun, code]);

  // 悬浮“运行选中”:只跑选中片段。点击后隐藏悬浮 + 清选区。
  const handleRunSelection = useCallback((): void => {
    const selected = selectionRef.current;
    if (!selected) return;
    startRun(selected);
    acceptedSelectionRef.current = null;
    selectionRef.current = null;
    setFloatPos(null);
    window.getSelection()?.removeAllRanges();
  }, [startRun]);

  const handleStop = useCallback((): void => {
    if (!runId) return;
    window.api.invoke(COMMAND_CHANNELS.SYSTEM_STOP_CODE_BLOCK, { runId }).catch(() => {
      /* ignore */
    });
  }, [runId]);

  /** 清除已结束结果并回到初始状态;running 时按钮不渲染,cache 也会拒绝误清。 */
  const handleClear = useCallback((): void => {
    clearCodeBlockRun(cacheKey);
  }, [cacheKey]);

  return (
    <div className="md-code-block" ref={blockRef}>
      <div className="md-code-block-toolbar">
        {label && <span className="md-code-block-lang">{label}</span>}
        <div className="md-code-block-actions">
          <button
            type="button"
            className="md-code-block-btn"
            onClick={() => copyToClipboard(code, tx('代码', 'code'))}
            title={tx('复制', 'Copy')}
            aria-label={tx('复制', 'Copy')}
          >
            <Icon name="copy" size={12} />
          </button>
          {runnable && state !== 'running' && (
            <button
              type="button"
              className="md-code-block-btn md-code-block-run"
              onClick={handleRun}
              title={tx('运行', 'Run')}
              aria-label={tx('运行', 'Run')}
            >
              <Icon name="play" size={12} />
            </button>
          )}
          {allowSudo && runnable && state !== 'running' && (
            <button
              type="button"
              className="md-code-block-btn md-code-block-sudo"
              onClick={handleRunSudo}
              title={tx('以 sudo 运行(会要求 sudo 密码)', 'Run with sudo (password required)')}
              aria-label={tx('以 sudo 运行', 'Run with sudo')}
            >
              🛡
            </button>
          )}
          {runnable && state === 'running' && (
            <button
              type="button"
              className="md-code-block-btn md-code-block-stop"
              onClick={handleStop}
              title={tx('停止', 'Stop')}
              aria-label={tx('停止', 'Stop')}
            >
              <Icon name="stop" size={12} />
            </button>
          )}
        </div>
      </div>
      <pre ref={preRef}>
        <code className={className}>{code}</code>
      </pre>
      {/* 选中代码片段后浮出的“运行选中”按钮:代码块内部绝对定位,随页面滚动。 */}
      {floatPos && runnable && state !== 'running' && (
        <button
          type="button"
          className="md-code-block-btn md-code-block-run md-code-block-run-float"
          style={{ top: `${floatPos.top}px`, left: `${floatPos.left}px` }}
          // mousedown 阻止默认:防止点击按钮时浏览器清空选区 → onClick 读不到选中。
          onMouseDown={(e) => e.preventDefault()}
          onClick={handleRunSelection}
          title={tx('运行选中', 'Run selection')}
          aria-label={tx('运行选中', 'Run selection')}
        >
          <Icon name="play" size={12} />
        </button>
      )}
      {(state === 'running' || state === 'exited' || output.length > 0) && (
        <div className={`md-code-block-output md-code-block-output--${state}`}>
          <pre>
            {output}
            {state === 'running' && <span className="md-code-block-cursor">▌</span>}
          </pre>
          {state === 'exited' && (
            <div className="md-code-block-footer">
              <div
                className={`md-code-block-exitcode md-code-block-exitcode--${exitCode === 0 ? 'ok' : 'err'}`}
              >
                {exitCode === 0
                  ? tx('已完成 (退出码 0)', 'Done (exit 0)')
                  : tx(`退出码 ${String(exitCode)}`, `Exit ${String(exitCode)}`)}
              </div>
              <button
                type="button"
                className="md-code-block-btn md-code-block-output-clear"
                onClick={handleClear}
                title={tx('清除输出', 'Clear output')}
                aria-label={tx('清除输出', 'Clear output')}
              >
                <Icon name="clear" size={12} />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 从 `language-xxx` className 抽出裸语言标签(用于不可运行块的角落标识)。 */
function extractRawLabel(className: string | undefined): string | null {
  if (!className) return null;
  const match = /language-([\w.+-]+)/.exec(className);
  return match ? match[1]! : null;
}

/**
 * 判断一个 react-markdown pre 的 children 是否是单个 code 子节点。
 * 是 → 返回 { className, code },供 MarkdownCodeBlock 挂载;否 → 返回 null
 * (调用方回退到默认 <pre>)。code 文本要求是纯字符串(react-markdown 对 fenced
 * code block 保证如此);含嵌套元素的异常结构不当作 code block 处理。
 */
export function extractCodeBlockInfo(
  children: React.ReactNode,
): { className: string | undefined; code: string } | null {
  if (!Array.isArray(children) && typeof children === 'object' && children !== null) {
    const child = children as React.ReactElement<{ className?: string; children?: unknown }>;
    if (child.type === 'code' && typeof child.props?.children === 'string') {
      return { className: child.props.className, code: child.props.children };
    }
  }
  // 单元素数组(react-markdown 有时包一层):递归一层。
  if (Array.isArray(children) && children.length === 1) {
    return extractCodeBlockInfo(children[0]);
  }
  return null;
}

// 让 TS 把 CodeBlockLanguage 当作"已被使用"的类型引用(组件对外暴露语义)。
export type { CodeBlockLanguage };
