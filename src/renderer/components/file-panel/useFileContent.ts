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
import { COMMAND_CHANNELS, type ReadFileResponse } from '@shared/protocol';

export function useFileContent(
  sessionId: string,
  path: string,
  mtimeMs: number,
): ReadFileResponse | null {
  const requestKey = `${sessionId}\u0000${path}\u0000${mtimeMs}`;
  const [loaded, setLoaded] = useState<{
    requestKey: string;
    content: ReadFileResponse;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null); // 切换文件 / 刷新时先清空,viewer 显示 loading
    window.api
      .invoke(COMMAND_CHANNELS.FILE_PANEL_READ, {
        sessionId,
        path,
      })
      .then((res) => {
        if (!cancelled) setLoaded({ requestKey, content: res });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoaded({
            requestKey,
            content: {
              kind: 'unknown',
              message: `读取失败: ${err instanceof Error ? err.message : String(err)}`,
            },
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, path, mtimeMs, requestKey]);

  // React 会先用上一轮 useState 渲染一次，再在 effect 里 setLoaded(null)。若直接
  // 返回旧 content，同 kind 文件 A→B 时 viewer 会在一个 commit 内把 A 的 DOM/
  // scrollTop 当成 B，导致 B 首次打开继承 A 的位置。identity 不匹配时同步返回
  // null，旧 viewer 的 layout cleanup 仍能先保存 A，随后 loading 期归零容器。
  return loaded?.requestKey === requestKey ? loaded.content : null;
}
