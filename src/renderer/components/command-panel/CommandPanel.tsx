/**
 * @file src/renderer/components/command-panel/CommandPanel.tsx
 * @purpose 命令面板(v0.3.3 Feature G / ADR-027)—— 第 4 个 dock 面板的 renderer。
 *
 * @关键设计:
 * - program-push:AI 经 `marina run "<cmd>"` / HTTP /run / IPC 推任意命令字符串,
 *   main 端 CommandPanelService 跑它(bash,复用 CodeBlockRunner),输出渲染进这里。
 * - 与 FilePanel 同构(多 tab + program-push),区别:tab 是「指令」而非「文件」。
 * - 状态来自 store.commandPanels(main 经 evt:command-panel:updated 推 snapshot)。
 *   output 在 entry.output 里(main 端聚合),第一版不做流式实时(命令通常秒级完成)。
 * - per-指令 刷新策略(D4):toolbar 下拉改 strategy;面板可见性上报 demand
 *   (COMMAND_PANEL_SET_DEMAND,驱动 BackgroundWorkScheduler 的 per-指令 task)。
 * - 渲染用轻量 markdown(ReactMarkdown + remarkGfm + 外链 open-external),
 *   不复用 MarkdownViewer(它耦合 OpenedFile 磁盘路径;命令输出是内存字符串,
 *   抽取它改动面大,违反已封箱代码最小改动原则。后续如需图片/代码块执行再抽取)。
 *
 * @对应文档: ADR-027(docs/方案-命令面板-20260802.md)、ADR-023(CodeBlockRunner)。
 *
 * @不要在这里做的事:
 * - 不直接 spawn 命令(走 IPC → CommandPanelService → CodeBlockRunner)。
 * - 不缓存指令列表到 localStorage(状态由 main 真值源推;切面板 <16ms 靠 store
 *   快照本身,LayoutHost 卸载组件但 store 不丢)。
 */
import { useEffect, useMemo, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  COMMAND_CHANNELS,
  type CommandEntry,
  type CommandPanelSnapshot,
  type CommandRefreshStrategy,
} from '@shared/protocol';
import type { PanelSearchProps } from '../layout/panel-registry';
import { useAppDispatch, useAppState } from '../../store';
import { useToast } from '../Toast';
import { useTranslation } from '../LanguageProvider';

interface CommandPanelProps {
  /** 绑定的终端 session id;父级按 session 切换重新挂载。 */
  sessionId: string;
  /** dock 级搜索状态(命令面板暂不用,保留接口对称)。 */
  search: PanelSearchProps;
}

/** 刷新策略选项(toolbar 下拉)。 */
const STRATEGY_OPTIONS: ReadonlyArray<{ value: CommandRefreshStrategy; label: string }> = [
  { value: 'foreground', label: '仅前台' },
  { value: 'background-30s', label: '后台 30s' },
  { value: 'background-5s', label: '后台 5s' },
  { value: 'manual', label: '手动' },
  { value: 'off', label: '暂停' },
];

/** 判断字符串是否为外链(http(s)/mailto),命令输出里的链接点开走系统浏览器。 */
function isExternalLink(href: string): boolean {
  return /^https?:\/\//i.test(href) || /^mailto:/i.test(href);
}

export function CommandPanel({ sessionId }: CommandPanelProps): JSX.Element {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const { tx } = useTranslation();
  const toast = useToast();
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const snapshot: CommandPanelSnapshot = state.commandPanels.get(sessionId) ?? {
    commands: [],
    activeKey: null,
  };
  const activeEntry: CommandEntry | null =
    snapshot.commands.find((c) => c.key === snapshot.activeKey) ?? null;

  // mount / sessionId 变化时拉一次真值(接管/claim 后本组件订阅前可能已有事件)。
  useEffect(() => {
    let cancelled = false;
    window.api
      .invoke<unknown, CommandPanelSnapshot>(COMMAND_CHANNELS.COMMAND_PANEL_GET_STATE, {
        sessionId,
      })
      .then((snap) => {
        if (cancelled) return;
        dispatch({
          type: 'command-panel/updated',
          sessionId,
          commands: snap.commands,
          activeKey: snap.activeKey,
          requestActivation: false,
        });
      })
      .catch((err: unknown) => {
        console.warn('[command-panel] get-state failed', err);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, dispatch]);

  // demand 上报:面板可见(session 绑定本窗口)= HOT。卸载/切走 → NONE。
  // 与 useGitPollingDemand 同策略,驱动 per-指令 后台 task(BackgroundWorkScheduler)。
  // 第一版简化:挂载即 HOT,卸载即 NONE(不做 document.visibilityState/hasFocus 细分,
  // 后续如需更精细可仿 useGitPollingDemand 增强)。
  useEffect(() => {
    window.api
      .invoke(COMMAND_CHANNELS.COMMAND_PANEL_SET_DEMAND, { sessionId, level: 'hot' })
      .catch((err: unknown) => console.warn('[command-panel] set-demand hot failed', err));
    return () => {
      window.api
        .invoke(COMMAND_CHANNELS.COMMAND_PANEL_SET_DEMAND, { sessionId, level: 'none' })
        .catch((err: unknown) => console.warn('[command-panel] set-demand none failed', err));
    };
  }, [sessionId]);

  // 操作:切 tab / 关 tab / 改策略 / 立即刷新(重跑)
  const showCommand = (key: string): void => {
    window.api
      .invoke<unknown, CommandPanelSnapshot>(COMMAND_CHANNELS.COMMAND_PANEL_SHOW, {
        sessionId,
        commandKey: key,
      })
      .then((snap) =>
        dispatch({
          type: 'command-panel/updated',
          sessionId,
          commands: snap.commands,
          activeKey: snap.activeKey,
          requestActivation: false,
        }),
      )
      .catch((err: unknown) => toast.show(err instanceof Error ? err.message : String(err)));
  };

  const closeCommand = (key: string): void => {
    window.api
      .invoke<unknown, CommandPanelSnapshot>(COMMAND_CHANNELS.COMMAND_PANEL_CLOSE, {
        sessionId,
        commandKey: key,
      })
      .then((snap) =>
        dispatch({
          type: 'command-panel/updated',
          sessionId,
          commands: snap.commands,
          activeKey: snap.activeKey,
          requestActivation: false,
        }),
      )
      .catch((err: unknown) => toast.show(err instanceof Error ? err.message : String(err)));
  };

  const setStrategy = (key: string, strategy: CommandRefreshStrategy): void => {
    window.api
      .invoke<unknown, CommandPanelSnapshot>(COMMAND_CHANNELS.COMMAND_PANEL_SET_STRATEGY, {
        sessionId,
        commandKey: key,
        strategy,
      })
      .then((snap) =>
        dispatch({
          type: 'command-panel/updated',
          sessionId,
          commands: snap.commands,
          activeKey: snap.activeKey,
          requestActivation: false,
        }),
      )
      .catch((err: unknown) => toast.show(err instanceof Error ? err.message : String(err)));
  };

  const rerun = (entry: CommandEntry): void => {
    // 重跑 = 再推一次同 command(upsert 复用 key,立即跑一次)
    window.api
      .invoke<unknown, CommandPanelSnapshot>(COMMAND_CHANNELS.COMMAND_PANEL_RUN, {
        sessionId,
        command: entry.command,
        title: entry.title,
      })
      .catch((err: unknown) => toast.show(err instanceof Error ? err.message : String(err)));
  };

  return (
    <div className="command-panel-content">
      {/* tab 列表(指令) */}
      {snapshot.commands.length > 0 && (
        <div className="command-panel-tabs">
          {snapshot.commands.map((entry) => (
            <div
              key={entry.key}
              className={
                'command-tab' + (entry.key === snapshot.activeKey ? ' command-tab-active' : '')
              }
              onClick={() => showCommand(entry.key)}
              title={entry.command}
            >
              <span
                className={
                  'command-tab-status command-status-' + entry.status
                }
                aria-hidden
              />
              <span className="command-tab-label">{entry.title ?? entry.command.slice(0, 30)}</span>
              <button
                className="command-tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeCommand(entry.key);
                }}
                aria-label={tx('关闭', 'Close')}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* toolbar:刷新策略 + 立即刷新(per-指令) */}
      {activeEntry && (
        <div className="command-panel-toolbar">
          <select
            className="command-strategy-select"
            value={activeEntry.strategy}
            onChange={(e) =>
              setStrategy(activeEntry.key, e.target.value as CommandRefreshStrategy)
            }
            title={tx('刷新策略', 'Refresh strategy')}
          >
            {STRATEGY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <button
            className="command-rerun-btn"
            onClick={() => rerun(activeEntry)}
            disabled={activeEntry.status === 'running'}
          >
            {activeEntry.status === 'running' ? '…' : '↻'}
          </button>
        </div>
      )}

      {/* 输出区(markdown 渲染) */}
      <div className="command-panel-body" ref={bodyRef}>
        {!activeEntry ? (
          <div className="command-panel-empty">
            <p>{tx('尚无命令', 'No commands yet')}</p>
            <p className="command-panel-hint">
              {tx('在终端里跑：marina run "<命令>"', 'Run in terminal: marina run "<cmd>"')}
            </p>
          </div>
        ) : (
          <CommandOutput entry={activeEntry} />
        )}
      </div>
    </div>
  );
}

/** 单条命令的输出渲染(markdown)。外链点开走系统浏览器。 */
function CommandOutput({ entry }: { entry: CommandEntry }): JSX.Element {
  // markdown components:外链 → open-external;其余默认。命令输出无 mdPath 概念,
  // 本地路径链接不支持(那是 T14 Feature F 的范畴,命令面板不承担)。
  const components = useMemo(
    () => ({
      a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
        const handle = (e: React.MouseEvent): void => {
          if (!href || href.startsWith('#')) return;
          e.preventDefault();
          if (isExternalLink(href)) {
            window.api
              .invoke(COMMAND_CHANNELS.SYSTEM_OPEN_EXTERNAL, { url: href })
              .catch((err: unknown) => console.warn('[command] openExternal failed', err));
          }
        };
        return (
          <a href={href} onClick={handle} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        );
      },
    }),
    [],
  );

  return (
    <div className="command-output">
      {entry.status === 'running' && (
        <div className="command-running-indicator">running…</div>
      )}
      {entry.output ? (
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {entry.output}
        </ReactMarkdown>
      ) : entry.status === 'running' ? (
        <p className="command-output-pending">…</p>
      ) : (
        <p className="command-output-empty">(无输出)</p>
      )}
    </div>
  );
}
