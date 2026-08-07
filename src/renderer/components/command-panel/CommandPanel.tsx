/**
 * @file src/renderer/components/command-panel/CommandPanel.tsx
 * @purpose 命令面板(v0.3.3 Feature G / ADR-028)—— 第 4 个 dock 面板的 renderer。
 *
 * @关键设计:
 * - program-push:AI 经 `marina run "<cmd>"` / HTTP /run / IPC 推任意命令字符串,
 *   main 端 CommandPanelService 跑它(bash,复用 CodeBlockRunner),输出渲染进这里。
 * - 与 FilePanel 同构(多 tab + program-push),区别:tab 是「指令」而非「文件」。
 * - 状态来自 store.commandPanels(main 经 evt:command-panel:updated 推 snapshot)。
 *   output 在 entry.output 里(main 端聚合),第一版不做流式实时(命令通常秒级完成)。
 * - per-指令刷新拆成两个正交控件：前台/后台 toggle 只决定隐藏时是否继续，
 *   刷新间隔 select 只决定手动/5s/30s；面板可见性另行上报 demand。
 * - 输出正文复用“已打开”面板的 MarkdownDocument（主题 / GFM / 外链 / 代码块 /
 *   搜索同一实现）。命令输出只有内存字符串，所以只传稳定 command key 作缓存身份，
 *   不伪造文件路径；本地链接/图片/gallery 等路径能力仍只属于真实 OpenedFile。
 *
 * @对应文档: ADR-028(docs/方案-命令面板-20260802.md)、ADR-023(CodeBlockRunner)。
 *
 * @不要在这里做的事:
 * - 不直接 spawn 命令(走 IPC → CommandPanelService → CodeBlockRunner)。
 * - 不缓存指令列表到 localStorage(状态由 main 真值源推;切面板 <16ms 靠 store
 *   快照本身,LayoutHost 卸载组件但 store 不丢)。
 */
import { useEffect } from 'react';
import {
  COMMAND_CHANNELS,
  type CommandEntry,
  type CommandPanelSnapshot,
  type CommandRefreshInterval,
  type CommandRefreshPolicy,
} from '@shared/protocol';
import type { PanelSearchProps } from '../layout/panel-registry';
import { useAppDispatch, useAppState } from '../../store';
import { useToast } from '../Toast';
import { useTranslation } from '../LanguageProvider';
import { MarkdownDocument } from '../file-panel/MarkdownDocument';

interface CommandPanelProps {
  /** 绑定的终端 session id;父级按 session 切换重新挂载。 */
  sessionId: string;
  /** dock 级搜索状态；透传给共享 MarkdownDocument 做正文查找。 */
  search: PanelSearchProps;
}

/** 刷新间隔独立于前台/后台范围；manual 仍可点右侧 ↻ 立即刷新。 */
const INTERVAL_OPTIONS: ReadonlyArray<{
  value: CommandRefreshInterval;
  zh: string;
  en: string;
}> = [
  { value: 'manual', zh: '手动', en: 'Manual' },
  { value: '30s', zh: '每 30 秒', en: 'Every 30s' },
  { value: '5s', zh: '每 5 秒', en: 'Every 5s' },
];

export function CommandPanel({ sessionId, search }: CommandPanelProps): JSX.Element {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const { tx } = useTranslation();
  const toast = useToast();

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

  // demand 上报只描述面板本身是否可见：挂载=HOT，卸载=NONE。后端再结合每条
  // refreshPolicy.scope 映射：foreground 的 NONE 真停，background 的 NONE 转 WARM。
  // 因而 renderer 不需要把产品策略混进可见性信号。
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

  // 操作:切 tab / 关 tab / 独立改前后台范围与间隔 / 立即刷新(重跑)
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
      .catch((err: unknown) =>
        toast.push({ kind: 'error', message: err instanceof Error ? err.message : String(err) }),
      );
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
      .catch((err: unknown) =>
        toast.push({ kind: 'error', message: err instanceof Error ? err.message : String(err) }),
      );
  };

  const updateRefreshPolicy = (key: string, patch: Partial<CommandRefreshPolicy>): void => {
    // 只提交当前控件负责的字段，main 在最新真值上 merge。成功态由有序的
    // commandPanelUpdated 事件统一进 store，避免两个并发响应倒序覆盖。
    window.api
      .invoke(COMMAND_CHANNELS.COMMAND_PANEL_UPDATE_REFRESH_POLICY, {
        sessionId,
        commandKey: key,
        patch,
      })
      .catch((err: unknown) =>
        toast.push({ kind: 'error', message: err instanceof Error ? err.message : String(err) }),
      );
  };

  const rerun = (entry: CommandEntry): void => {
    // 重跑 = 再推一次同 command(upsert 复用 key,立即跑一次)
    window.api
      .invoke<unknown, CommandPanelSnapshot>(COMMAND_CHANNELS.COMMAND_PANEL_RUN, {
        sessionId,
        command: entry.command,
        title: entry.title,
      })
      .catch((err: unknown) =>
        toast.push({ kind: 'error', message: err instanceof Error ? err.message : String(err) }),
      );
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
              <span className={'command-tab-status command-status-' + entry.status} aria-hidden />
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

      {/* toolbar:前后台范围 / 刷新间隔 / 立即刷新——三个职责不混合。 */}
      {activeEntry && (
        <div className="command-panel-toolbar">
          <button
            className={
              'command-scope-btn' +
              (activeEntry.refreshPolicy.scope === 'background' ? ' is-background' : '')
            }
            onClick={() =>
              updateRefreshPolicy(activeEntry.key, {
                scope:
                  activeEntry.refreshPolicy.scope === 'foreground' ? 'background' : 'foreground',
              })
            }
            title={tx('切换仅前台/后台刷新', 'Toggle foreground/background refresh')}
            aria-pressed={activeEntry.refreshPolicy.scope === 'background'}
          >
            {activeEntry.refreshPolicy.scope === 'foreground'
              ? tx('仅前台', 'Foreground')
              : tx('后台', 'Background')}
          </button>
          <select
            className="command-interval-select"
            value={activeEntry.refreshPolicy.interval}
            onChange={(e) =>
              updateRefreshPolicy(activeEntry.key, {
                interval: e.target.value as CommandRefreshInterval,
              })
            }
            title={tx('自动刷新间隔', 'Auto-refresh interval')}
          >
            {INTERVAL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {tx(opt.zh, opt.en)}
              </option>
            ))}
          </select>
          <button
            className="command-rerun-btn"
            onClick={() => rerun(activeEntry)}
            disabled={activeEntry.status === 'running'}
            title={tx('立即刷新', 'Refresh now')}
          >
            {activeEntry.status === 'running' ? '…' : '↻'}
          </button>
        </div>
      )}

      {/* 输出区(markdown 渲染) */}
      <div className="command-panel-body">
        {!activeEntry ? (
          <div className="command-panel-empty">
            <p>{tx('尚无命令', 'No commands yet')}</p>
            <p className="command-panel-hint">
              {tx('在终端里跑：marina run "<命令>"', 'Run in terminal: marina run "<cmd>"')}
            </p>
          </div>
        ) : (
          <CommandOutput sessionId={sessionId} entry={activeEntry} search={search} />
        )}
      </div>
    </div>
  );
}

/**
 * 单条命令的来源 adapter：保留 running / pending / empty 状态，只把已经聚合好的
 * stdout Markdown 交给与“已打开”面板相同的 MarkdownDocument。entry.output 已由
 * CommandPanelService 按 OUTPUT_MAX_BYTES 有界裁切，本层不再复制另一套截断规则。
 */
function CommandOutput({
  sessionId,
  entry,
  search,
}: {
  sessionId: string;
  entry: CommandEntry;
  search: PanelSearchProps;
}): JSX.Element {
  return (
    <div className="command-output">
      {entry.status === 'running' && <div className="command-running-indicator">running…</div>}
      {entry.output ? (
        <MarkdownDocument
          sessionId={sessionId}
          markdown={entry.output}
          documentIdentity={`command:${entry.key}`}
          search={search}
        />
      ) : entry.status === 'running' ? (
        <p className="command-output-pending">…</p>
      ) : (
        <p className="command-output-empty">(无输出)</p>
      )}
    </div>
  );
}
