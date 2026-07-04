/**
 * @file src/renderer/components/file-panel/FileViewer.tsx
 * @purpose 按 OpenedFile.kind 分发到对应 viewer(text/markdown/image/unknown)。
 *
 * @未来扩展:若 types.FileKind 加入 'web'(本地 HTML / 远程 URL),这里加一个
 *   case 渲染 <iframe>/<webview> 即可 —— 分发结构已为它留位。本轮 detectFileKind
 *   不返回 'web',所以不会有文件走到那里。
 */
import type { OpenedFile } from '@shared/types';
import { useTranslation } from '../LanguageProvider';
import { TextViewer } from './TextViewer';
import { MarkdownViewer } from './MarkdownViewer';
import { ImageViewer } from './ImageViewer';

interface FileViewerProps {
  sessionId: string;
  file: OpenedFile;
}

export function FileViewer({ sessionId, file }: FileViewerProps): JSX.Element {
  switch (file.kind) {
    case 'text':
      return <TextViewer sessionId={sessionId} file={file} />;
    case 'markdown':
      return <MarkdownViewer sessionId={sessionId} file={file} />;
    case 'image':
      return <ImageViewer sessionId={sessionId} file={file} />;
    case 'unknown':
      return <UnknownView file={file} />;
    default:
      // 穷尽保护:未来新增 kind 忘了加 case 时,这里编译期 + 运行期都拦住。
      return <UnknownView file={file} />;
  }
}

function UnknownView({ file }: { file: OpenedFile }): JSX.Element {
  const { tx } = useTranslation();
  return (
    <div className="file-unknown-viewer">
      <p>{tx('该文件类型暂不支持预览', 'Preview not supported for this file type')}</p>
      <p className="file-unknown-path" title={file.path}>
        {file.name}
      </p>
    </div>
  );
}
