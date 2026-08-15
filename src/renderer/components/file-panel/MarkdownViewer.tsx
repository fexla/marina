/**
 * @file src/renderer/components/file-panel/MarkdownViewer.tsx
 * @purpose 把“已打开”面板中的 Markdown 文件读取生命周期适配到共享
 *   <MarkdownDocument> 正文模块。
 *
 * @关键设计:
 * - 本组件只负责 OpenedFile 路径 → IPC 内容、loading/error/truncated 状态，以及
 *   file viewer 的外层滚动恢复；GFM、主题、链接、图片、代码块和搜索统一由
 *   MarkdownDocument 实现，命令面板复用同一个 module。
 * - 真实 file.path 作为 fileContext 传入，共享正文才能让 main 做成员校验、相对
 *   链接/图片解析和 gallery；内存来源不得伪造这个能力。
 * - Markdown 根本身不滚动，scrollRef 指向外层 .file-panel-body。rootRef 只用于
 *   内容布局测量与 DOM 搜索，两者不能互换。
 *
 * @对应文档: docs/方案-命令面板-20260802.md D5；软件定义书 ADR-018、ADR-028。
 *
 * @不要在这里做的事:
 * - 不再配置 react-markdown components；修改正文行为请改 MarkdownDocument。
 * - 不直接读取本地图片或打开链接；所有路径操作必须经 main 的 FilePanelService。
 * - 不给根节点自建滚动；文档级滚动由 .file-panel-body 统一持有并缓存。
 */
import { useRef, type RefObject } from 'react';
import type { FilePanelHeadingNavigationPayload } from '@shared/protocol';
import type { OpenedFile } from '@shared/types';
import {
  useFileViewerScroll,
  type FileViewerNavigationResult,
} from '../../hooks/useFileViewerScroll';
import { useAppDispatch } from '../../store';
import { useTranslation } from '../LanguageProvider';
import type { PanelSearchProps } from '../layout/panel-registry';
import { MarkdownDocument } from './MarkdownDocument';
import { useFileContent } from './useFileContent';

interface ViewerProps {
  sessionId: string;
  file: OpenedFile;
  /** dock 级搜索状态（MarkdownDocument 负责 DOM 查找）。 */
  search: PanelSearchProps;
  /** Markdown 文档真正的纵向滚动容器（.file-panel-body）。 */
  scrollRef: RefObject<HTMLElement | null>;
  /** Main 定向发送、消费后即删除的一次性标题跳转。 */
  headingNavigation?: FilePanelHeadingNavigationPayload;
}

/**
 * 读取并展示一个已纳入 FilePanelService 的 Markdown 文件。
 *
 * 状态流：OpenedFile mtime 变化 → useFileContent 重新 IPC read → loading →
 * MarkdownDocument；滚动状态机参见 useFileViewerScroll 的文件头说明。
 */
export function MarkdownViewer({
  sessionId,
  file,
  search,
  scrollRef,
  headingNavigation,
}: ViewerProps): JSX.Element {
  const { tx } = useTranslation();
  const dispatch = useAppDispatch();
  const containerRef = useRef<HTMLDivElement>(null);
  const headingNavigationResultRef = useRef<FileViewerNavigationResult | null>(null);
  const headingSearchSuppressionRef = useRef<{ query: string; mtimeMs: number } | null>(null);
  if (!search.visible) headingSearchSuppressionRef.current = null;
  const headingSuppressesCurrentSearch =
    headingNavigation !== undefined ||
    (headingSearchSuppressionRef.current?.query === search.query &&
      headingSearchSuppressionRef.current.mtimeMs === file.mtimeMs);
  const content = useFileContent(sessionId, file.path, file.mtimeMs);

  useFileViewerScroll({
    sessionId,
    path: file.path,
    kind: file.kind,
    scrollRef,
    layoutRef: containerRef,
    ready: content?.kind === 'markdown',
    restoreVersion: file.mtimeMs,
    searchActive: search.visible && search.query.length > 0 && !headingSuppressesCurrentSearch,
    navigationResultRef: headingNavigationResultRef,
    ...(headingNavigation ? { navigationRequestId: headingNavigation.requestId } : {}),
  });

  // Markdown 根本身不滚动；文档级中键自动滚动作用于外层 file-panel-body。
  // 走 Chromium 原生 autoscroll：不 preventDefault 中键 mousedown，点中键即触发
  // 浏览器原生圆圈图标 + 持续滚动（与浏览器一致）。

  if (!content) {
    return <div className="file-viewer-loading">{tx('加载中…', 'Loading…')}</div>;
  }
  if (content.kind !== 'markdown') {
    return (
      <div className="file-viewer-error">
        {content.kind === 'unknown'
          ? content.message
          : tx('内容类型不匹配', 'content kind mismatch')}
      </div>
    );
  }

  return (
    <MarkdownDocument
      key={file.path}
      sessionId={sessionId}
      markdown={content.text}
      documentIdentity={file.path}
      fileContext={{ path: file.path, mtimeMs: file.mtimeMs }}
      search={search}
      rootRef={containerRef}
      {...(headingNavigation ? { headingNavigation } : {})}
      onHeadingNavigationHandled={(requestId, found) => {
        headingNavigationResultRef.current = { requestId, found };
        headingSearchSuppressionRef.current = { query: search.query, mtimeMs: file.mtimeMs };
        dispatch({
          type: 'file-panel/heading-navigation-consumed',
          sessionId,
          requestId,
        });
      }}
      trailingContent={
        content.truncated ? (
          <div className="file-truncated-mark">
            {tx('…(文件过大,仅显示前 2MB)', '…(file large, first 2MB only)')}
          </div>
        ) : null
      }
    />
  );
}
