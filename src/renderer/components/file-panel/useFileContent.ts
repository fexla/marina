/**
 * @file src/renderer/components/file-panel/useFileContent.ts
 * @purpose 封装 cmd:file-panel:read,并在文件 mtimeMs 变化时自动重新拉取。
 *
 * @自动刷新链路:
 *   main 端 fs.watch 检测文件被外部改 → FilePanelService emit filePanelUpdated
 *   (带新 mtimeMs) → ipc 路由到本窗口 → store 的 OpenedFile.mtimeMs 更新 →
 *   本 hook 的 useEffect 依赖含 mtimeMs → effect 重跑 → 重新 read。
 *
 * loading 期返回 null(viewer 显示"加载中");read 失败回落到 unknown+message。
 */
import { useEffect, useState } from 'react';
import { COMMAND_CHANNELS, type ReadFilePayload, type ReadFileResponse } from '@shared/protocol';

export function useFileContent(
  sessionId: string,
  path: string,
  mtimeMs: number,
): ReadFileResponse | null {
  const [content, setContent] = useState<ReadFileResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    setContent(null); // 切换文件 / 刷新时先清空,viewer 显示 loading
    window.api
      .invoke<ReadFilePayload, ReadFileResponse>(COMMAND_CHANNELS.FILE_PANEL_READ, {
        sessionId,
        path,
      })
      .then((res) => {
        if (!cancelled) setContent(res);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setContent({
            kind: 'unknown',
            message: `读取失败: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, path, mtimeMs]);

  return content;
}
