/**
 * @file src/renderer/hooks/useBackendLabel.ts
 * @purpose 当前窗口所连远程 daemon 的显示名「电脑名 (host)」;本地窗口返回 null。
 *
 * @关键设计:
 * - backendProfileId 从 preload URL 解析(window.api.backendProfileId,窗口创建时
 *   定死,绝对可靠),profile 名/host 用 REMOTE_PROFILE_LIST 拉 —— 该命令是
 *   local-control(protocol.ts LOCAL_CONTROL_COMMANDS_SET),远程窗口里也走客户端
 *   本地 IPC,返回的是客户端本机保存的凭据,不含 token。
 * - 与 WindowChrome.tsx 的 backendLabel 逻辑同款(那里是已封箱代码,不动;
 *   新代码统一从这里取)。
 *
 * @对应文档章节:软件定义书.md §14.9.6;docs/方案-远程UI统一-20260803.md §III.3
 */
import { useEffect, useState } from 'react';
import { COMMAND_CHANNELS } from '@shared/protocol';

/**
 * @returns 远程窗口显示名「displayName (host)」;本地窗口 / profile 已删 = null/id 兜底。
 */
export function useBackendLabel(): string | null {
  const backendProfileId = window.api.backendProfileId;
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    if (!backendProfileId) {
      setLabel(null);
      return;
    }
    let cancelled = false;
    void window.api
      .invoke(
        COMMAND_CHANNELS.REMOTE_PROFILE_LIST,
        undefined,
      )
      .then((res) => {
        if (cancelled) return;
        const profile = res.profiles.find((p) => p.id === backendProfileId);
        // profile 被删了但窗口还开着 — 显示 id 兜底,至少让用户知道这是远程窗口。
        setLabel(profile ? `${profile.displayName} (${profile.host})` : backendProfileId);
      })
      .catch(() => {
        if (!cancelled) setLabel(backendProfileId);
      });
    return () => {
      cancelled = true;
    };
  }, [backendProfileId]);

  return label;
}
