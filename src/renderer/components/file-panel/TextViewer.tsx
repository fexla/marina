/**
 * @file src/renderer/components/file-panel/TextViewer.tsx
 * @purpose 以等宽 <pre> 显示文本/源码文件。wrap 长行,顶部对齐,便于扫读代码。
 *   超过 main 端 MAX_READ_TEXT_BYTES 的尾部被截断,显示截断标记。
 */
import type { OpenedFile } from '@shared/types';
import { useFileContent } from './useFileContent';
import { useTranslation } from '../LanguageProvider';

interface ViewerProps {
  sessionId: string;
  file: OpenedFile;
}

export function TextViewer({ sessionId, file }: ViewerProps): JSX.Element {
  const { tx } = useTranslation();
  const content = useFileContent(sessionId, file.path, file.mtimeMs);

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
    <pre className="file-text-viewer">
      {content.text}
      {content.truncated && (
        <span className="file-truncated-mark">
          {'\n'}
          {tx('…(文件过大,仅显示前 2MB)', '…(file too large, showing first 2MB only)')}
        </span>
      )}
    </pre>
  );
}
