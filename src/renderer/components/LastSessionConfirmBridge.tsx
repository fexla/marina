/**
 * @file src/renderer/components/LastSessionConfirmBridge.tsx
 * @purpose BETA-003b · ADR-013:复用已有 ModalProvider.confirm() API 实现
 *   "最后窗口 + 仍有 alive session → 弹二次确认 modal"。
 *
 *   工作机制:
 *   1. 订阅 evt:ui:show-last-session-confirm(主进程在拦截到本窗口 close 时发出)
 *   2. 收到事件 → await useModal().confirm({title, message, danger:true})
 *   3. 用户确认 → invoke cmd:app:quit;取消 → 什么也不做(主进程已 preventDefault
 *      过 close,窗口仍开)
 *
 *   Linux 场景:最后窗口 + 至少一个 alive session 时弹。
 *   Windows / macOS 场景:复用同一事件 / 同一 modal,触发位置分别是托盘菜单
 *   "完全退出"和 Cmd+Q / App Menu Quit(将来接入)。
 *
 * @对应工单: BETA-003b
 */
import { useEffect } from 'react';
import { COMMAND_CHANNELS, EVENT_CHANNELS } from '@shared/protocol';
import { useTranslation } from './LanguageProvider';
import { useModal } from './Modal';

export function LastSessionConfirmBridge(): null {
  const modal = useModal();
  const { t } = useTranslation();

  useEffect(() => {
    const off = window.api.on<{ sessionCount: number }>(
      EVENT_CHANNELS.UI_SHOW_LAST_SESSION_CONFIRM,
      async (payload) => {
        const confirmed = await modal.confirm({
          title: t('lastSession.title'),
          message: t('lastSession.message', { count: payload.sessionCount }),
          confirmLabel: t('lastSession.confirm'),
          cancelLabel: t('lastSession.cancel'),
          danger: true,
        });
        if (confirmed) {
          // 确认 → 让主进程进入退出流程(setQuitting + app.quit)
          try {
            await window.api.invoke(COMMAND_CHANNELS.APP_QUIT, undefined);
          } catch {
            /* 主进程已退出,invoke 失败属正常 */
          }
        }
        // 取消 → 不做事,主进程已 preventDefault,窗口保持开启
      },
    );
    return off;
  }, [modal, t]);

  return null;
}
