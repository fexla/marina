/**
 * @file src/renderer/components/command-panel/CommandPanel.tsx
 * @purpose 命令侧 UI 组件(v0.3.3 Feature G / ADR-028;ADR-037 起不再有独立
 *   dock 面板,本模块导出的三件套由「已打开」面板 FilePanel 组合渲染):
 *   - CommandTabStrip:统一 tab 列表里的命令 tab(状态点 + 标题 + ×)
 *   - CommandToolbar:前后台范围 / 刷新间隔 / 立即刷新 / SSH sudo
 *   - CommandPane:输出区 adapter(命令 → 共享 MarkdownDocument)+ sudo 密码条
 *
 * @关键设计:
 * - program-push:AI 经 `marina run "<cmd>"` / HTTP /run / marina:run 链接推任意
 *   命令字符串,main 端 CommandPanelService 跑它(bash,复用 CodeBlockRunner),
 *   输出渲染进这里。状态来自 store.commandPanels(main 经
 *   evt:command-panel:updated 推 snapshot);output 在 entry.output(main 端聚合),
 *   第一版不做流式实时(命令通常秒级完成)。
 * - 输出正文复用「已打开」面板的 MarkdownDocument(主题 / GFM / 外链 / 代码块 /
 *   搜索/目录/本地链接/图片/gallery 同一实现,ADR-036)。命令输出只有内存字符串,
 *   只传稳定 command key 作缓存身份,不伪造文件路径;路径解析基准是该指令运行时
 *   cwd(CommandEntry.runCwd,main 端真值)。
 * - per-指令刷新拆成两个正交控件:前台/后台 toggle 只决定隐藏时是否继续,
 *   刷新间隔 select 只决定手动/5s/30s;面板可见性(demand)由 FilePanel 上报
 *   (ADR-037:本组件挂载 ≠ 可见)。
 * - tab 列表/空态/工具条的宿主是 FilePanel;这里不渲染面板级容器
 *   (.file-panel-tabs / .file-panel-body),保证文件侧与命令侧同一套布局。
 *
 * @对应文档: ADR-028(docs/方案-命令面板-20260802.md)、ADR-023(CodeBlockRunner)、
 *   ADR-036(能力全源复用)、ADR-037(面板整合)。
 *
 * @不要在这里做的事:
 * - 不直接 spawn 命令(走 IPC → CommandPanelService → CodeBlockRunner)。
 * - 不缓存指令列表到 localStorage(状态由 main 真值源推;切面板 <16ms 靠 store
 *   快照本身,LayoutHost 卸载组件但 store 不丢)。
 */
import { useState } from 'react';
import {
  COMMAND_CHANNELS,
  type CommandEntry,
  type CommandRefreshInterval,
  type CommandRefreshPolicy,
} from '@shared/protocol';
import type { PanelSearchProps } from '../layout/panel-registry';
import { useToast } from '../Toast';
import { useTranslation } from '../LanguageProvider';
import { HighlightedText } from '../common/HighlightedText';
import { MarkdownDocument } from '../file-panel/MarkdownDocument';
import { Icon } from '../icons';

/** 刷新间隔独立于前台/后台范围;manual 仍可点右侧 ↻ 立即刷新。 */
const INTERVAL_OPTIONS: ReadonlyArray<{
  value: CommandRefreshInterval;
  zh: string;
  en: string;
}> = [
  { value: 'manual', zh: '手动', en: 'Manual' },
  { value: '30s', zh: '每 30 秒', en: 'Every 30s' },
  { value: '5s', zh: '每 5 秒', en: 'Every 5s' },
];

/**
 * 重跑 = 再推一次同 command(upsert 复用 key,立即跑一次;runCommand 总是切回
 * 该 tab 并请求激活 —— ADR-037 后激活等价于跳到「已打开」面板的命令侧,幂等)。
 * sudoOverride 用于「翻 sudo toggle 后立即重跑」;缺省沿 entry.sudo(远程 sudo
 * 状态保留在 entry 里)。
 */
export function rerunCommand(
  sessionId: string,
  entry: CommandEntry,
  sudoOverride?: boolean,
): void {
  const sudo = sudoOverride ?? !!entry.sudo;
  window.api
    .invoke(COMMAND_CHANNELS.COMMAND_PANEL_RUN, {
      sessionId,
      command: entry.command,
      title: entry.title,
      sudo,
    })
    .catch((err: unknown) => console.warn('[command-panel] rerun failed', err));
}

/**
 * 统一 tab 列表里的命令 tab 段。纯展示 + 回调:列表数据 / activeKey 由 FilePanel
 * 从 store 传入,点击(切 tab+切面板内视图)与关闭走回调 —— IPC 与 dispatch 都在
 * FilePanel,保持命令侧交互入口与文件侧(同在 FilePanel)一致。
 */
export function CommandTabStrip({
  commands,
  activeKey,
  onSelect,
  onClose,
  search,
}: {
  commands: CommandEntry[];
  activeKey: string | null;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
  /** dock 级搜索状态;visible 时按标题/命令文本过滤并高亮(FilePanel 预过滤,这里只高亮)。 */
  search: PanelSearchProps;
}): JSX.Element | null {
  const { tx } = useTranslation();
  if (commands.length === 0) return null;
  const isSearching = search.visible && search.query.length > 0;
  return (
    <>
      {commands.map((entry) => (
        <div
          key={entry.key}
          className={'command-tab' + (entry.key === activeKey ? ' command-tab-active' : '')}
          onClick={() => onSelect(entry.key)}
          title={entry.command}
        >
          <span className={'command-tab-status command-status-' + entry.status} aria-hidden />
          <span className="command-tab-label">
            <HighlightedText
              text={entry.title ?? entry.command.slice(0, 30)}
              query={isSearching ? search.query : ''}
              caseSensitive={search.caseSensitive}
            />
          </span>
          <button
            className="command-tab-close"
            onClick={(e) => {
              e.stopPropagation();
              onClose(entry.key);
            }}
            aria-label={tx('关闭', 'Close')}
          >
            ×
          </button>
        </div>
      ))}
    </>
  );
}

/**
 * 命令侧工具条(前后台范围 / 刷新间隔 / 立即刷新 / SSH sudo)。由 FilePanel 渲染
 * 在 tab 列表与正文之间,仅当前视图在命令侧且有 active 指令时出现。
 */
export function CommandToolbar({
  sessionId,
  entry,
  isSsh,
}: {
  sessionId: string;
  entry: CommandEntry;
  isSsh: boolean;
}): JSX.Element {
  const { tx } = useTranslation();
  const toast = useToast();

  const updateRefreshPolicy = (patch: Partial<CommandRefreshPolicy>): void => {
    // 只提交当前控件负责的字段,main 在最新真值上 merge。成功态由有序的
    // commandPanelUpdated 事件统一进 store,避免两个并发响应倒序覆盖。
    window.api
      .invoke(COMMAND_CHANNELS.COMMAND_PANEL_UPDATE_REFRESH_POLICY, {
        sessionId,
        commandKey: entry.key,
        patch,
      })
      .catch((err: unknown) =>
        toast.push({ kind: 'error', message: err instanceof Error ? err.message : String(err) }),
      );
  };

  return (
    <div className="command-panel-toolbar">
      <button
        className={
          'command-scope-btn' + (entry.refreshPolicy.scope === 'background' ? ' is-background' : '')
        }
        onClick={() =>
          updateRefreshPolicy({
            scope: entry.refreshPolicy.scope === 'foreground' ? 'background' : 'foreground',
          })
        }
        title={tx('切换仅前台/后台刷新', 'Toggle foreground/background refresh')}
        aria-pressed={entry.refreshPolicy.scope === 'background'}
      >
        {entry.refreshPolicy.scope === 'foreground' ? tx('仅前台', 'Foreground') : tx('后台', 'Background')}
      </button>
      <select
        className="command-interval-select"
        value={entry.refreshPolicy.interval}
        onChange={(e) =>
          updateRefreshPolicy({ interval: e.target.value as CommandRefreshInterval })
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
        className={'command-rerun-btn' + (entry.status === 'running' ? ' is-running' : '')}
        onClick={() => rerunCommand(sessionId, entry)}
        disabled={entry.status === 'running'}
        title={
          entry.status === 'running' ? tx('正在刷新', 'Refreshing') : tx('立即刷新', 'Refresh now')
        }
        aria-label={
          entry.status === 'running' ? tx('正在刷新', 'Refreshing') : tx('立即刷新', 'Refresh now')
        }
        aria-busy={entry.status === 'running'}
      >
        <Icon name="refresh" size={12} className="command-rerun-icon" />
      </button>
      {isSsh && (
        <button
          className={'command-sudo-btn' + (entry.sudo ? ' is-sudo' : '')}
          onClick={() => rerunCommand(sessionId, entry, !entry.sudo)}
          disabled={entry.status === 'running'}
          title={
            entry.sudo
              ? tx('下次以普通用户重跑', 'Re-run without sudo')
              : tx('下次以 sudo 重跑(会要求 sudo 密码)', 'Re-run with sudo (password required)')
          }
          aria-pressed={!!entry.sudo}
        >
          🛡 sudo
        </button>
      )}
      {entry.status === 'running' && (
        <span className="command-refreshing-indicator" role="status">
          {tx('刷新中', 'Refreshing')}
        </span>
      )}
    </div>
  );
}

/**
 * 命令侧输出区,渲染在 .file-panel-body 内(滚动容器由 FilePanel 持有;
 * MarkdownDocument 经 closest('.file-panel-body') 找到它做标题跳转/目录滚动)。
 * awaiting-sudo-password 态先渲染密码条;输出 adapter 见 CommandOutput。
 */
export function CommandPane({
  sessionId,
  entry,
  search,
  isSsh,
  sshProfileId,
}: {
  sessionId: string;
  entry: CommandEntry;
  search: PanelSearchProps;
  /** SSH session 才渲染 sudo 密码条 / sudo toggle(本地 bash 无 sudo 语义)。 */
  isSsh: boolean;
  sshProfileId: string;
}): JSX.Element {
  return (
    <>
      {entry.status === 'awaiting-sudo-password' && isSsh ? (
        <SudoPasswordBar sshProfileId={sshProfileId} onSubmit={() => rerunCommand(sessionId, entry, true)} />
      ) : null}
      <CommandOutput sessionId={sessionId} entry={entry} search={search} />
    </>
  );
}

/**
 * 单条命令的来源 adapter:entry.output 是 main 原子提交的"最近一次已完成结果"。
 * 刷新期间继续渲染它,不在正文插入 running 文案或清空 DOM,避免阅读位置和代码
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
  // 空字符串既可能是"从未完成过",也可能是上一轮成功但确实没有输出。
  // running 期间 main 保留上一轮 lastExitCode,让这里能保持"无输出"完成态,
  // 不会错误闪回"等待首次结果"。有文本的 spawn/signal 错误自然走 output 分支。
  const hasCompletedResult = entry.output.length > 0 || entry.lastExitCode !== null;
  return (
    <div className="command-output">
      {entry.output ? (
        <MarkdownDocument
          sessionId={sessionId}
          markdown={entry.output}
          documentIdentity={`command:${entry.key}`}
          commandKey={entry.key}
          search={search}
        />
      ) : entry.status === 'running' && !hasCompletedResult ? (
        <p className="command-output-pending">{tx('等待首次结果…', 'Waiting for the first result…')}</p>
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
