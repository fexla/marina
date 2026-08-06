/**
 * @file src/renderer/components/file-panel/ImageViewer.tsx
 * @purpose 显示图片(base64 dataUrl,由 main 端 cmd:file-panel:read 返回)。
 *   居中、可滚动;超大图(超 MAX_READ_IMAGE_BYTES)在 main 端就被拒,这里收到
 *   unknown+message 时回退显示提示。
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { OpenedFile } from '@shared/types';
import { useFileContent } from './useFileContent';
import { useTranslation } from '../LanguageProvider';
import { useFileViewerScroll } from '../../hooks/useFileViewerScroll';
import { useAutoscroll } from '../../hooks/useAutoscroll';

interface ViewerProps {
  sessionId: string;
  file: OpenedFile;
  scrollRef: RefObject<HTMLElement | null>;
}

export function ImageViewer({ sessionId, file, scrollRef }: ViewerProps): JSX.Element {
  const { tx } = useTranslation();
  const content = useFileContent(sessionId, file.path, file.mtimeMs);
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const [imageLoaded, setImageLoaded] = useState(false);

  useEffect(() => setImageLoaded(false), [file.path, file.mtimeMs]);

  useFileViewerScroll({
    sessionId,
    path: file.path,
    kind: file.kind,
    scrollRef,
    layoutRef,
    ready: content?.kind === 'image' && imageLoaded,
    restoreVersion: file.mtimeMs,
  });

  // 中键自动滚动(v0.3.3):图片查看器用外层 file-panel-body 滚动,与 markdown
  //  /unknown 共享容器,各自挂各自的 autoscroll(一次只一种 kind 挂载,不冲突)。
  useAutoscroll(scrollRef);

  if (!content) {
    return <div className="file-viewer-loading">{tx('加载中…', 'Loading…')}</div>;
  }
  if (content.kind !== 'image') {
    return (
      <div className="file-viewer-error">
        {content.kind === 'unknown'
          ? content.message
          : tx('内容类型不匹配', 'content kind mismatch')}
      </div>
    );
  }
  return (
    <div className="file-image-viewer" ref={layoutRef}>
      <img src={content.dataUrl} alt={file.name} onLoad={() => setImageLoaded(true)} />
    </div>
  );
}
