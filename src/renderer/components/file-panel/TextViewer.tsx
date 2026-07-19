/**
 * @file src/renderer/components/file-panel/TextViewer.tsx
 * @purpose 以等宽行级 <div> 显示文本/源码文件。
 *
 * @v0.3.2 三层能力:
 *   1) hljs 语法高亮(按扩展名选语言,逐行 highlight)—— 复用共享 highlight.ts。
 *   2) 行号槽 —— 每行行首固定宽行号,user-select:none 不参与复制。
 *   3) 文件内查找(Ctrl+F)—— useDomTextHighlight 用 CSS Custom Highlight overlay
 *      高亮匹配字符,不改 DOM,与 hljs 的 span 嵌套互不干扰(A1+A2 统一方案)。
 *
 * @为什么搜索不用行内 <mark>(v0.3.1 旧方案):
 *   hljs 输出嵌套 span,行内 <mark> 叠加需解析 HTML 切分,复杂且易错。CSS Custom
 *   Highlight 在渲染后 DOM 上 overlay,天然适配任意 HTML 结构,一套逻辑通吃
 *   text/diff/markdown。详见 useDomTextHighlight.ts 头注。
 *
 * 超过 main 端 MAX_READ_TEXT_BYTES 的尾部被截断,显示截断标记(A6 客户端兜底另见)。
 */
import { useMemo, useRef } from 'react';
import type { OpenedFile } from '@shared/types';
import type { PanelSearchProps } from '../layout/panel-registry';
import { useFileContent } from './useFileContent';
import { useDomTextHighlight } from '../../hooks/useDomTextHighlight';
import { useTranslation } from '../LanguageProvider';
import { highlightLine, detectLanguageByExt } from './highlight';

interface ViewerProps {
  sessionId: string;
  file: OpenedFile;
  /** dock 级搜索状态(C3 文件内查找)。 */
  search: PanelSearchProps;
}

/** 大文件客户端兜底:超过此行数只渲染头部 + 截断提示(A6,防卡死)。 */
const MAX_RENDER_LINES = 50000;

export function TextViewer({ sessionId, file, search }: ViewerProps): JSX.Element {
  const { tx } = useTranslation();
  const content = useFileContent(sessionId, file.path, file.mtimeMs);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // 行级切分 + hljs 语法高亮(按扩展名选语言)。useMemo 保证 content 不变时引用稳定。
  const { lines, htmlLines, truncatedClient } = useMemo(() => {
    if (!content || content.kind !== 'text') {
      return { lines: EMPTY, htmlLines: EMPTY, truncatedClient: false };
    }
    const all = splitLines(content.text);
    const ext = extOf(file.name);
    const detected = ext ? detectLanguageByExt(ext) : undefined;
    const language = detected ?? 'diff'; // 未识别 → 纯文本(diff 语言无 token 着色)
    // A6 大文件保护:超阈值只渲染前 N 行,其余截断。
    if (all.length > MAX_RENDER_LINES) {
      const head = all.slice(0, MAX_RENDER_LINES);
      return {
        lines: head,
        htmlLines: head.map((l) => highlightLine(l, language)),
        truncatedClient: true,
      };
    }
    return {
      lines: all,
      htmlLines: all.map((l) => highlightLine(l, language)),
      truncatedClient: false,
    };
  }, [content, file.name]);

  // 文件内查找:在渲染后 DOM 上 overlay 高亮(CSS Custom Highlight)。
  // skipSelector 跳过行号槽(.file-line-number)——否则行号数字会被误匹配。
  useDomTextHighlight({
    sessionId,
    containerRef,
    query: search.query,
    caseSensitive: search.caseSensitive,
    active: search.visible,
    contentVersion: content,
    skipSelector: '.file-line-number',
  });

  if (!content) {
    return <div className="file-viewer-loading">{tx('加载中…', 'Loading…')}</div>;
  }
  if (content.kind !== 'text') {
    return (
      <div className="file-viewer-error">
        {content.kind === 'unknown'
          ? content.message
          : tx('内容类型不匹配', 'content kind mismatch')}
      </div>
    );
  }

  return (
    <div className="file-text-viewer" ref={containerRef}>
      {lines.map((_line, i) => (
        <div key={i} data-line={i} className="file-text-line">
          <span className="file-line-number">{i + 1}</span>
          {/* hljs 输出只含 class span,无脚本/事件,安全。来源是受控文件读取。 */}
          <span
            className="file-text-line-content"
            dangerouslySetInnerHTML={{ __html: htmlLines[i] || ' ' }}
          />
        </div>
      ))}
      {(content.truncated || truncatedClient) && (
        <div className="file-truncated-mark">
          {truncatedClient
            ? tx(
                `…(文件过大,仅显示前 ${MAX_RENDER_LINES} 行)`,
                `…(file too large, showing first ${MAX_RENDER_LINES} lines only)`,
              )
            : tx('…(文件过大,仅显示前 2MB)', '…(file too large, showing first 2MB only)')}
        </div>
      )}
    </div>
  );
}

const EMPTY: readonly string[] = [];

/** 按 \n 切分,保留空行。trailing \n 产生的末尾空行去掉(与编辑器行号一致)。 */
function splitLines(text: string): string[] {
  if (!text) return [''];
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** 取文件名扩展名(不含点,小写)。无扩展名返回 undefined。 */
function extOf(name: string): string | undefined {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return undefined;
  return name.slice(dot + 1).toLowerCase();
}
