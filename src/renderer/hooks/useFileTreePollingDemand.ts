/**
 * @file src/renderer/hooks/useFileTreePollingDemand.ts
 * @purpose 把当前 Session/文件面板可见性/窗口聚焦折算为文件树轮询需求并上报后端。
 *
 * @关键设计:
 * - 与 useGitPollingDemand 同构(同一套 ADR-021 demand 机制),但**只分
 *   HOT/NONE 两档,没有 WARM**:需求是"只有处于前台的终端的文件面板需要
 *   刷新" —— 面板可见 + 窗口聚焦 = HOT(每 3s 重验展开目录),其余一律 NONE。
 *   (Git 面板保留 WARM 是因为 status 刷新便宜且用户常切回来就看;文件树按
 *   产品需求不做后台保温。)
 * - PanelStack mount = 当前 Session 正在本窗口显示;unmount cleanup 必发 NONE
 * - 非 owner 永远 NONE;owner false→true 即使组件不 remount 也会重新上报
 * - 命令走 backend-data,远程窗口会把需求发给当前 daemon(与 git 一致)
 *
 * @对应文档:docs/方案-需求感知后台任务调度-20260722.md;ADR-021;
 *   FileTreePanel.tsx(展开目录集合由面板经 FILE_TREE_SET_WATCHED_DIRS 另报)。
 */
import { useCallback, useEffect, useRef } from 'react';
import { COMMAND_CHANNELS, type BackgroundDemandLevel } from '@shared/protocol';
import { waitForClaim } from './claim-gate';

interface FileTreePollingDemandOptions {
  sessionId: string;
  /** 文件面板是当前 active tab 且右 dock 未折叠(与 useGitPollingDemand 同源真值)。 */
  fileTreeVisible: boolean;
  isOwner: boolean;
}

export function useFileTreePollingDemand({
  sessionId,
  fileTreeVisible,
  isOwner,
}: FileTreePollingDemandOptions): void {
  const latestRef = useRef({ fileTreeVisible, isOwner });
  latestRef.current = { fileTreeVisible, isOwner };
  const lastSentRef = useRef<BackgroundDemandLevel | null>(null);

  const send = useCallback(
    (level: BackgroundDemandLevel, force = false): void => {
      if (!force && lastSentRef.current === level) return;
      lastSentRef.current = level;
      // 与 useGitPollingDemand 同:session 正在被 claim 时等 owner 就位再报,
      // 消除 NotOwner race;demand 是 best-effort(失败已吞,清 lastSent 可重试)。
      void waitForClaim(sessionId).then((outcome) => {
        if (!outcome.ok) return;
        window.api
          .invoke(COMMAND_CHANNELS.FILE_TREE_SET_POLLING_DEMAND, { sessionId, level })
          .catch((error: unknown) => {
            if (lastSentRef.current === level) lastSentRef.current = null;
            console.warn('[useFileTreePollingDemand] demand update failed', error);
          });
      });
    },
    [sessionId],
  );

  const publishCurrent = useCallback((): void => {
    const current = latestRef.current;
    if (!current.fileTreeVisible || !current.isOwner) {
      send('none');
      return;
    }
    // 只有"前台终端"(窗口聚焦且 document 可见)才需要刷新,其余 NONE。
    const foreground = document.visibilityState === 'visible' && document.hasFocus();
    send(foreground ? 'hot' : 'none');
  }, [send]);

  // 只在 session 变化时重绑浏览器生命周期事件;面板/owner 变化由下一个 effect
  // 上报,避免 tab 切换时 cleanup NONE + 新等级的无意义抖动(同 git hook)。
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
      // force:即使 lastSent 已是 NONE,也让 main/remote daemon 的 cleanup 绝对幂等。
      send('none', true);
    };
  }, [publishCurrent, send]);

  useEffect(() => {
    publishCurrent();
  }, [fileTreeVisible, isOwner, publishCurrent]);
}
