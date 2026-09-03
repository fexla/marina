/**
 * @file src/renderer/components/WebDownloadBridge.tsx
 * @purpose ADR-034:订阅 evt:web:download-complete(WebViewer sandbox iframe 内
 *   发起的下载,如 archify 导出按钮),main 端 will-download handler 存盘后
 *   广播,这里弹 in-app toast 告知落盘位置。
 *
 *   为什么是 App 级桥而非 WebViewer 内订阅:下载完成时用户可能已切走面板/
 *   关闭 tab(WebViewer 已卸载),App 级订阅保证通知不丢 —— 与
 *   LastSessionConfirmBridge 同款模式。
 *
 * @对应文档: ADR-034(软件定义书);docs/ipc-protocol.md §6.6
 */
import { useEffect } from 'react';
import { EVENT_CHANNELS, type WebDownloadCompletePayload } from '@shared/protocol';
import { useTranslation } from './LanguageProvider';
import { useToast } from './Toast';

export function WebDownloadBridge(): null {
  const toast = useToast();
  const { tx } = useTranslation();

  useEffect(() => {
    const off = window.api.on<WebDownloadCompletePayload>(
      EVENT_CHANNELS.WEB_DOWNLOAD_COMPLETE,
      (payload) => {
        if (payload.state === 'completed') {
          toast.push({
            kind: 'success',
            message: tx(
              `已下载:${payload.filename}(下载文件夹)`,
              `Downloaded: ${payload.filename} (Downloads folder)`,
            ),
          });
        } else {
          toast.push({
            kind: 'warn',
            message: tx(
              `下载未完成(${payload.state}):${payload.filename}`,
              `Download ${payload.state}: ${payload.filename}`,
            ),
          });
        }
      },
    );
    return off;
  }, [toast, tx]);

  return null;
}
