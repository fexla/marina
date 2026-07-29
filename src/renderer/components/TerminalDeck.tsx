/**
 * @file TerminalDeck.tsx
 * @purpose 保留本窗口访问过的 xterm 实例；切 session 只切换可见 slot，不销毁/
 * 重放终端，从源头保留 xterm viewport、selection、normal/alternate buffer 状态。
 *
 * @关键设计:
 * - 最多缓存 10 个 session(LRU)，对齐项目 10-session 内存验收基线；超限才 unmount。
 * - inactive slot 使用 visibility:hidden + inert，保留真实几何与 Terminal 对象，
 *   但不能 focus/input；只有 active slot fit/resize/focus。
 * - TerminalView 的 main view lease 让 owner=null 的 parked slot 继续接收输出。
 * - lease 断流(曾被别的 client 接管)时只替换该 slot 的 generation key，完整 replay。
 *
 * @对应文档章节:软件定义书.md 8.4 owner；AGENTS.md §10 内存基线。
 *
 * @不要在这里做的事:
 * - 不要缓存 LayoutHost/File/Git panel；隐藏 panel 必须 unmount 并上报 NONE demand。
 * - 不要把 cache 放模块级 Map；LRU/generation 是显式 React view state。
 */
import { useCallback, useEffect, useState } from 'react';
import { useAppState } from '../store';
import { TerminalView } from './TerminalView';

const MAX_CACHED_TERMINALS = 10;

interface CachedTerminal {
  sessionId: string;
  generation: number;
}

interface TerminalDeckProps {
  activeSessionId: string | null;
}

export function TerminalDeck({ activeSessionId }: TerminalDeckProps): JSX.Element {
  const state = useAppState();
  const [cached, setCached] = useState<CachedTerminal[]>(() =>
    activeSessionId ? [{ sessionId: activeSessionId, generation: 0 }] : [],
  );

  // 访问即移到 LRU 尾；React key 不变,移动数组位置不会重建 xterm。
  useEffect(() => {
    if (!activeSessionId) return;
    setCached((previous) => {
      const existing = previous.find((entry) => entry.sessionId === activeSessionId);
      const withoutActive = previous.filter((entry) => entry.sessionId !== activeSessionId);
      const next = [...withoutActive, existing ?? { sessionId: activeSessionId, generation: 0 }];
      return next.length > MAX_CACHED_TERMINALS
        ? next.slice(next.length - MAX_CACHED_TERMINALS)
        : next;
    });
  }, [activeSessionId]);

  // session 真销毁时移除；普通 owner=null/切 path 不移除。
  useEffect(() => {
    setCached((previous) => previous.filter((entry) => state.sessions.has(entry.sessionId)));
  }, [state.sessions]);

  const handleContinuityLost = useCallback((sessionId: string): void => {
    setCached((previous) =>
      previous.map((entry) =>
        entry.sessionId === sessionId
          ? { ...entry, generation: entry.generation + 1 }
          : entry,
      ),
    );
  }, []);

  return (
    <div className="terminal-deck">
      {cached.map((entry) => {
        const session = state.sessions.get(entry.sessionId);
        if (!session) return null;
        const active = entry.sessionId === activeSessionId;
        return (
          <div
            key={`${entry.sessionId}:${entry.generation}`}
            className={`terminal-deck-slot${active ? ' active' : ' parked'}`}
            data-terminal-active={active ? 'true' : 'false'}
            data-session-id={entry.sessionId}
            aria-hidden={active ? undefined : true}
            inert={active ? undefined : ''}
          >
            <TerminalView
              session={session}
              active={active}
              onContinuityLost={handleContinuityLost}
            />
          </div>
        );
      })}
    </div>
  );
}
