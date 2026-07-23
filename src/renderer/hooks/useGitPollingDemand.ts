/**
 * @file src/renderer/hooks/useGitPollingDemand.ts
 * @purpose 把当前 Session/Git 面板/窗口可见性折算为 HOT/WARM/NONE 绝对需求并上报后端。
 *
 * @关键设计:
 * - PanelStack mount = 当前 Session 正在本窗口显示；unmount cleanup 必发 NONE
 * - Git 可见 + document visible + 窗口 focus = HOT；仍显示但隐藏/失焦 = WARM
 * - 非 owner 永远 NONE；owner false→true 即使组件不 remount 也会重新上报
 * - 命令走 backend-data，远程窗口会把需求发给当前 daemon
 *
 * @对应文档:docs/方案-需求感知后台任务调度-20260722.md §5；ADR-021
 */
import { useCallback, useEffect, useRef } from 'react';
import { COMMAND_CHANNELS, type BackgroundDemandLevel } from '@shared/protocol';

interface GitPollingDemandOptions {
  sessionId: string;
  gitAvailable: boolean;
  gitVisible: boolean;
  isOwner: boolean;
}

export function useGitPollingDemand({
  sessionId,
  gitAvailable,
  gitVisible,
  isOwner,
}: GitPollingDemandOptions): void {
  const latestRef = useRef({ gitAvailable, gitVisible, isOwner });
  latestRef.current = { gitAvailable, gitVisible, isOwner };
  const lastSentRef = useRef<BackgroundDemandLevel | null>(null);

  const send = useCallback(
    (level: BackgroundDemandLevel, force = false): void => {
      if (!force && lastSentRef.current === level) return;
      lastSentRef.current = level;
      void window.api
        .invoke(COMMAND_CHANNELS.GIT_SET_POLLING_DEMAND, { sessionId, level })
        .catch((error: unknown) => {
          // 失败不影响面板；清 lastSent 让下一次 focus/visibility/state 变化可重试。
          if (lastSentRef.current === level) lastSentRef.current = null;
          console.warn('[useGitPollingDemand] demand update failed', error);
        });
    },
    [sessionId],
  );

  const publishCurrent = useCallback((): void => {
    const current = latestRef.current;
    if (!current.gitAvailable || !current.isOwner) {
      send('none');
      return;
    }
    const foreground = document.visibilityState === 'visible' && document.hasFocus();
    send(current.gitVisible && foreground ? 'hot' : 'warm');
  }, [send]);

  // 只在 session 变化时重绑浏览器生命周期事件；面板/owner 变化由下一个 effect
  // 上报，避免 tab 切换时 cleanup NONE + 新等级的无意义抖动。
  useEffect(() => {
    lastSentRef.current = null;
    const onVisibility = (): void => publishCurrent();
    window.addEventListener('focus', onVisibility);
    window.addEventListener('blur', onVisibility);
    document.addEventListener('visibilitychange', onVisibility);
    publishCurrent();
    return () => {
      window.removeEventListener('focus', onVisibility);
      window.removeEventListener('blur', onVisibility);
      document.removeEventListener('visibilitychange', onVisibility);
      // force:即使 lastSent 已是 NONE，也让 main/remote daemon 的 cleanup 绝对幂等。
      send('none', true);
    };
  }, [publishCurrent, send]);

  useEffect(() => {
    publishCurrent();
  }, [gitAvailable, gitVisible, isOwner, publishCurrent]);
}
