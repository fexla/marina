/**
 * @file src/renderer/components/file-panel/FileViewer.tsx
 * @purpose 按 OpenedFile.kind 分发到对应 viewer(text/markdown/image/unknown)。
 *
 * @未来扩展:若 types.FileKind 加入 'web'(本地 HTML / 远程 URL),这里加一个
 *   case 渲染 <iframe>/<webview> 即可 —— 分发结构已为它留位。本轮 detectFileKind
 *   不返回 'web',所以不会有文件走到那里。
 */
import { useRef, type RefObject } from 'react';
import type { OpenedFile } from '@shared/types';
import type { PanelSearchProps } from '../layout/panel-registry';
import { useTranslation } from '../LanguageProvider';
import { TextViewer } from './TextViewer';
import { MarkdownViewer } from './MarkdownViewer';
import { ImageViewer } from './ImageViewer';
import { DiffViewer } from './DiffViewer';
import { useFileViewerScroll } from '../../hooks/useFileViewerScroll';
import { useAutoscroll } from '../../hooks/useAutoscroll';

interface FileViewerProps {
  sessionId: string;
  file: OpenedFile;
  /** v0.3.1:dock 级搜索状态(C3 文件内查找)。 */
  search: PanelSearchProps;
  /** Markdown/Image/Unknown 的真实文档滚动容器(.file-panel-body)。 */
  outerScrollRef: RefObject<HTMLDivElement | null>;
}

export function FileViewer({
  sessionId,
  file,
  search,
  outerScrollRef,
}: FileViewerProps): JSX.Element {
  switch (file.kind) {
    case 'text':
      return <TextViewer sessionId={sessionId} file={file} search={search} />;
    case 'markdown':
      return (
        <MarkdownViewer
          sessionId={sessionId}
          file={file}
          search={search}
          scrollRef={outerScrollRef}
        />
      );
    case 'image':
      return <ImageViewer sessionId={sessionId} file={file} scrollRef={outerScrollRef} />;
    case 'diff':
      return <DiffViewer sessionId={sessionId} file={file} search={search} />;
    case 'unknown':
      return <UnknownView sessionId={sessionId} file={file} scrollRef={outerScrollRef} />;
    default:
      // 穷尽保护:未来新增 kind 忘了加 case 时,这里编译期 + 运行期都拦住。
      return <UnknownView sessionId={sessionId} file={file} scrollRef={outerScrollRef} />;
  }
}

function UnknownView({
  sessionId,
  file,
  scrollRef,
}: {
  sessionId: string;
  file: OpenedFile;
  scrollRef: RefObject<HTMLElement | null>;
}): JSX.Element {
  const { tx } = useTranslation();
  const layoutRef = useRef<HTMLDivElement | null>(null);
  useFileViewerScroll({
    sessionId,
    path: file.path,
    kind: file.kind,
    scrollRef,
    layoutRef,
    ready: true,
    restoreVersion: file.mtimeMs,
  });
  // 中键自动滚动(v0.3.3):不支持的文件类型也可能很长(如纯文本 fallback),
  //  补齐与其它 viewer 一致的中键交互。
  useAutoscroll(scrollRef);
  return (
    <div className="file-unknown-viewer" ref={layoutRef}>
      <p>{tx('该文件类型暂不支持预览', 'Preview not supported for this file type')}</p>
      <p className="file-unknown-path" title={file.path}>
        {file.name}
      </p>
    </div>
  );
}
