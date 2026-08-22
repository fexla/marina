/**
 * @file src/renderer/components/file-panel/ImageViewer.tsx
 * @purpose 显示图片(base64 dataUrl,由 main 端 cmd:file-panel:read 返回)。
 *   居中、可滚动;超大图(超 MAX_READ_IMAGE_BYTES)在 main 端就被拒,这里收到
 *   unknown+message 时回退显示提示。
 *
 *   v0.3.3 图片交互:单击用系统图片查看器打开(OpenedFile.path 是 main 端
 *   规范化的绝对路径,直接走 SYSTEM_OPEN_PATH);右键菜单与 Markdown 内联图 /
 *   gallery 同形态(打开 / 复制图片 / 在 Explorer 中显示),生成器在
 *   imageActions.ts。
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import { COMMAND_CHANNELS } from '@shared/protocol';
import type { OpenedFile } from '@shared/types';
import { useFileContent } from './useFileContent';
import { useTranslation } from '../LanguageProvider';
import { useToast } from '../Toast';
import { useContextMenuApi } from '../ContextMenu';
import { buildImageActionMenu } from './imageActions';
import { useFileViewerScroll } from '../../hooks/useFileViewerScroll';

interface ViewerProps {
  sessionId: string;
  file: OpenedFile;
  scrollRef: RefObject<HTMLElement | null>;
}

export function ImageViewer({ sessionId, file, scrollRef }: ViewerProps): JSX.Element {
  const { tx } = useTranslation();
  const toast = useToast();
  const ctxMenu = useContextMenuApi();
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

  // 中键自动滚动:走 Chromium 原生 autoscroll。图片查看器用外层 file-panel-body
  //  滚动(与 markdown/unknown 共享容器),原生对该可滚动容器直接生效。

  /** SYSTEM_OPEN_PATH / SYSTEM_SHOW_IN_EXPLORER 失败(通道 throw)的统一提示。 */
  const toastActionError = (action: string, err: unknown): void => {
    toast.push({
      kind: 'error',
      message: `${action}${err instanceof Error ? err.message : String(err)}`,
    });
  };

  /** 用系统图片查看器打开本文件(左键与右键菜单共用)。 */
  const openExternally = (): void => {
    window.api
      .invoke(COMMAND_CHANNELS.SYSTEM_OPEN_PATH, { path: file.path })
      .catch((err: unknown) => toastActionError(tx('打开图片失败:', 'Open image failed: '), err));
  };

  const handleContextMenu = (event: React.MouseEvent<HTMLDivElement>): void => {
    event.preventDefault();
    ctxMenu.open({
      x: event.clientX,
      y: event.clientY,
      items: buildImageActionMenu(
        {
          open: openExternally,
          reveal: () => {
            window.api
              .invoke(COMMAND_CHANNELS.SYSTEM_SHOW_IN_EXPLORER, { path: file.path })
              .catch((err: unknown) =>
                toastActionError(tx('在资源管理器中显示失败:', 'Reveal in Explorer failed: '), err),
              );
          },
          // read 返回的 image 内容必然是 dataUrl(read-image 同一来源)。
          copyImageDataUrl: content?.kind === 'image' ? content.dataUrl : undefined,
        },
        { toast, tx },
      ),
    });
  };

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
    <div className="file-image-viewer" ref={layoutRef} onContextMenu={handleContextMenu}>
      <img
        src={content.dataUrl}
        alt={file.name}
        title={tx('点击用系统图片查看器打开', 'Click to open in system image viewer')}
        onLoad={() => setImageLoaded(true)}
        onClick={openExternally}
      />
    </div>
  );
}
