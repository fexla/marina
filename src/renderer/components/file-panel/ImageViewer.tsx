/**
 * @file src/renderer/components/file-panel/ImageViewer.tsx
 * @purpose 显示图片(base64 dataUrl,由 main 端 cmd:file-panel:read 返回)。
 *   居中、可滚动;超大图(超 MAX_READ_IMAGE_BYTES)在 main 端就被拒,这里收到
 *   unknown+message 时回退显示提示。
 */
import type { OpenedFile } from '@shared/types';
import { useFileContent } from './useFileContent';
import { useTranslation } from '../LanguageProvider';

interface ViewerProps {
  sessionId: string;
  file: OpenedFile;
}

export function ImageViewer({ sessionId, file }: ViewerProps): JSX.Element {
  const { tx } = useTranslation();
  const content = useFileContent(sessionId, file.path, file.mtimeMs);

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
    <div className="file-image-viewer">
      <img src={content.dataUrl} alt={file.name} />
    </div>
  );
}
