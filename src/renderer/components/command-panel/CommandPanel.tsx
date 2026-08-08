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
import { useEffect, useState } from 'react';
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
import { Icon } from '../icons';

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
      .invoke(COMMAND_CHANNELS.COMMAND_PANEL_GET_STATE, {
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
      .invoke(COMMAND_CHANNELS.COMMAND_PANEL_SHOW, {
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
      .invoke(COMMAND_CHANNELS.COMMAND_PANEL_CLOSE, {
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

  const rerun = (entry: CommandEntry, sudoOverride?: boolean): void => {
    // 重跑 = 再推一次同 command(upsert 复用 key,立即跑一次)。sudoOverride 用于「翻
    // sudo toggle 后立即重跑」;缺省沿 entry.sudo(远程 sudo 状态保留在 entry 里)。
    const sudo = sudoOverride ?? !!entry.sudo;
    window.api
      .invoke(COMMAND_CHANNELS.COMMAND_PANEL_RUN, {
        sessionId,
        command: entry.command,
        title: entry.title,
        sudo,
      })
      .catch((err: unknown) =>
        toast.push({ kind: 'error', message: err instanceof Error ? err.message : String(err) }),
      );
  };

  // 远程 sudo 仅对 SSH session 有意义:pathId = ssh:<profileId>:<remotePath>。
  // 本地 session 不显 sudo 控件(命令在本机 bash 跑,无 sudo 语义)。
  const sessionPathId = state.sessions.get(sessionId)?.pathId ?? '';
  const isSsh = sessionPathId.startsWith('ssh:');
  const sshProfileId = isSsh ? decodeURIComponent(sessionPathId.split(':')[1] ?? '') : '';

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
            className={
              'command-rerun-btn' + (activeEntry.status === 'running' ? ' is-running' : '')
            }
            onClick={() => rerun(activeEntry)}
            disabled={activeEntry.status === 'running'}
            title={
              activeEntry.status === 'running'
                ? tx('正在刷新', 'Refreshing')
                : tx('立即刷新', 'Refresh now')
            }
            aria-label={
              activeEntry.status === 'running'
                ? tx('正在刷新', 'Refreshing')
                : tx('立即刷新', 'Refresh now')
            }
            aria-busy={activeEntry.status === 'running'}
          >
            <Icon name="refresh" size={12} className="command-rerun-icon" />
          </button>
          {isSsh && (
            <button
              className={'command-sudo-btn' + (activeEntry.sudo ? ' is-sudo' : '')}
              onClick={() => rerun(activeEntry, !activeEntry.sudo)}
              disabled={activeEntry.status === 'running'}
              title={
                activeEntry.sudo
                  ? tx('下次以普通用户重跑', 'Re-run without sudo')
                  : tx('下次以 sudo 重跑(会要求 sudo 密码)', 'Re-run with sudo (password required)')
              }
              aria-pressed={!!activeEntry.sudo}
            >
              🛡 sudo
            </button>
          )}
          {activeEntry.status === 'running' && (
            <span className="command-refreshing-indicator" role="status">
              {tx('刷新中', 'Refreshing')}
            </span>
          )}
        </div>
      )}

      {/* 输出区(markdown 渲染) */}
      <div className="command-panel-body">
        {activeEntry && activeEntry.status === 'awaiting-sudo-password' && isSsh ? (
          <SudoPasswordBar sshProfileId={sshProfileId} onSubmit={() => rerun(activeEntry, true)} />
        ) : null}
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
 * 单条命令的来源 adapter：entry.output 是 main 原子提交的“最近一次已完成结果”。
 * 刷新期间继续渲染它，不在正文插入 running 文案或清空 DOM，避免阅读位置和代码
 * 选区跳动。只有首次运行尚无结果时显示等待占位。
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
  const { tx } = useTranslation();
  // 空字符串既可能是“从未完成过”，也可能是上一轮成功但确实没有输出。
  // running 期间 main 保留上一轮 lastExitCode，让这里能保持“无输出”完成态，
  // 不会错误闪回“等待首次结果”。有文本的 spawn/signal 错误自然走 output 分支。
  const hasCompletedResult = entry.output.length > 0 || entry.lastExitCode !== null;
  return (
    <div className="command-output">
      {entry.output ? (
        <MarkdownDocument
          sessionId={sessionId}
          markdown={entry.output}
          documentIdentity={`command:${entry.key}`}
          search={search}
        />
      ) : entry.status === 'running' && !hasCompletedResult ? (
        <p className="command-output-pending">
          {tx('等待首次结果…', 'Waiting for the first result…')}
        </p>
      ) : (
        <p className="command-output-empty">{tx('(无输出)', '(No output)')}</p>
      )}
    </div>
  );
}

/**
 * sudo 密码录入条(SSH session 远程 sudo)。该命令进入 awaiting-sudo-password 态时出现:
 * masked 输入 → SUDO_PASSWORD_SET(main 内存,绝不落盘)→ onSubmit 触发重跑。
 * 也可主动调出改密(此版本仅在 awaiting 态出现,「忘记密码」走设置或重录覆盖)。
 *
 * 密码本身只从 renderer 发出(SET 入参),永不从 main 读回(has/state 只回 boolean)。
 */
function SudoPasswordBar({
  sshProfileId,
  onSubmit,
}: {
  sshProfileId: string;
  onSubmit: () => void;
}): JSX.Element {
  const { tx } = useTranslation();
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = (): void => {
    if (!password) {
      toast.push({ kind: 'error', message: tx('请输入 sudo 密码', 'Enter the sudo password') });
      return;
    }
    setSaving(true);
    window.api
      .invoke(COMMAND_CHANNELS.SUDO_PASSWORD_SET, { sshProfileId, password })
      .then(() => {
        setPassword('');
        onSubmit(); // 密码已入内存,重跑该 sudo 命令
      })
      .catch((err: unknown) =>
        toast.push({ kind: 'error', message: err instanceof Error ? err.message : String(err) }),
      )
      .finally(() => setSaving(false));
  };

  return (
    <div className="sudo-password-bar">
      <input
        className="sudo-password-input"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder={tx('输入 sudo 密码(仅存内存)', 'sudo password (memory only)')}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
        autoFocus
        autoComplete="off"
        spellCheck={false}
        disabled={saving}
      />
      <button className="sudo-password-submit" onClick={submit} disabled={saving}>
        {saving ? tx('提交中…', 'Submitting…') : tx('提交并重跑', 'Submit & re-run')}
      </button>
    </div>
  );
}
