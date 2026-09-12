/**
 * @file src/renderer/components/file-panel/FilePanel.tsx
 * @purpose 终端程序经 MARINA_SERVICE 推送的"已打开文件"内容面板;v0.3.3 ADR-037
 *   起同时承载 AI 推送指令的输出(原独立「命令」dock 面板整合进来)。
 *
 * @关键设计:
 * - 面板仍严格绑定单个 session；MainPane/PanelRegistry 用 sessionId 变化重挂，
 *   因而切终端、接管或切窗口时绝不混用其他 session 的打开文件状态。
 * - 文件开关/切换走 IPC → FilePanelService 真值 → evt:file-panel:updated 回推，
 *   不做乐观本地文件列表，避免 renderer 与 main 状态漂移。命令侧同理
 *   (CommandPanelService 真值 + evt:command-panel:updated)。
 * - ADR-037 统一 tab 列表:文件 tab 在前、命令 tab 在后,一个列表一套样式;
 *   面板内"正在看哪一侧"由 store.openPanelViews 记录(resolveOpenPanelView 兜底),
 *   程序推送(openFile / runCommand 的 requestActivation)与用户点 tab 都写它。
 *   命令侧的 tab/工具条/输出由 command-panel/CommandPanel.tsx 的三件套提供,
 *   本文件只做宿主与数据编排 —— 能力复用不再出现"命令面板落后文件面板"的漂移。
 * - 命令刷新调度 demand(ADR-021)在本面板上报:命令输出真的可见(面板是
 *   active dock 面板 + 未折叠 + 正在看命令侧)才报 HOT;main 端再结合 activeKey
 *   映射 foreground→NONE 真停 / background→WARM 保温。
 * - 尺寸、折叠和 dock chrome 已移交 LayoutHost。这里仅渲染内容，不决定自己
 *   在窗口中的位置；这是 ADR-016 Panel Registry 的边界。
 *
 * @对应文档章节:软件定义书.md §14.6、ADR-016、ADR-021、ADR-037;
 *   docs/ipc-protocol.md file-panel / command-panel 域。
 *
 * @不要在这里做的事:
 * - 不浏览目录（FileTreePanel + FileTreeService 的职责）。
 * - 不直接读本地文件系统；所有内容读取经 main IPC。
 * - 不保存 width/collapsed 等布局状态。
 * - 不渲染命令输出正文(那是 command-panel/CommandPanel.tsx CommandPane 的职责,
 *   与 MarkdownViewer 对文件的正职对称)。
 */
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import {
  COMMAND_CHANNELS,
  type FilePanelSnapshot,
  type FilePanelHeadingNavigationPayload,
  type CommandEntry,
  type CommandPanelSnapshot,
} from '@shared/protocol';
import type { OpenedFile } from '@shared/types';
import type { PanelSearchProps } from '../layout/panel-registry';
import { matchText } from '@shared/text-search';
import { fileIconFor } from '@shared/file-icon';
import { HighlightedText } from '../common/HighlightedText';
import { buildFileEntryMenu } from '../common/fileListRowContextMenu';
import { FileListRow } from '../common/FileListRow';
import { useAppDispatch, useAppState, useAppStateRef } from '../../store';
import { useTranslation } from '../LanguageProvider';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { waitForClaim } from '../../hooks/claim-gate';
import { scheduleWorkspaceSnapshotWrite } from '../../workspace-snapshot';
import { useToast } from '../Toast';
import type { ContextMenuItem } from '../ContextMenu';
import { FileViewer } from './FileViewer';
import { markdownSurfaceClass } from './markdown-surface';
import { resolveOpenPanelView } from './open-panel-view';
import {
  CommandTabStrip,
  CommandToolbar,
  CommandPane,
  rerunCommand,
} from '../command-panel/CommandPanel';

interface FilePanelProps {
  /** 绑定的终端 session id；父级按 session 切换重新挂载。 */
  sessionId: string;
  /** v0.3.1:dock 级搜索状态(C2 tab 过滤 / C3 文件内查找)。 */
  search: PanelSearchProps;
}

export function FilePanel({ sessionId, search }: FilePanelProps): JSX.Element {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const stateRef = useAppStateRef();
  const { tx } = useTranslation();
  // 右键菜单依赖。提到顶层取一次,避免每个 tab row 各起一份 hook —— tab 数量
  // 可能较多(打开 10+ 文件),统一取更简。buildContextMenu 闭包捕获即可。
  const copyToClipboard = useCopyToClipboard();
  const toast = useToast();
  const bodyScrollRef = useRef<HTMLDivElement | null>(null);
  const backgroundProbeRef = useRef<HTMLDivElement | null>(null);
  const markdownStyle = state.settings.filePanel?.markdownStyle ?? 'auto';
  const snapshot: FilePanelSnapshot = state.filePanels.get(sessionId) ?? {
    files: [],
    activePath: null,
  };
  const commandSnapshot: CommandPanelSnapshot = state.commandPanels.get(sessionId) ?? {
    commands: [],
    activeKey: null,
  };

  // mount / sessionId 变化时拉一次真值：接管已有 session、窗口刚聚焦等场景可能
  // 在本组件订阅前已经收到事件。FilePanelService 是唯一状态源。
  //
  // H2 owner 校验配套：与 FileTreePanel/GitPanel 同模式，拉取前 waitForClaim，
  // 消除「renderer 乐观接管(owner 仍 null) → FilePanel mount 立即拉取 → 命中
  // main 端 requireFilePanelOwner 的 NotOwner」的 race。claim 失败时中止拉取
  // (不发注定 NotOwner 的 IPC)，由调用方 rollback + 组件卸载处理。
  useEffect(() => {
    let cancelled = false;
    void waitForClaim(sessionId).then((outcome) => {
      if (!outcome.ok || cancelled) return;
      window.api
        .invoke(COMMAND_CHANNELS.FILE_PANEL_GET_OPEN_FILES, {
          sessionId,
        })
        .then((snap) => {
          if (cancelled) return;
          dispatch({
            type: 'file-panel/updated',
            sessionId,
            files: snap.files,
            activePath: snap.activePath,
            // 初始化拉取/同步已有快照，不是 openFile，不请求激活面板。
            requestActivation: false,
          });
        })
        .catch((err: unknown) => console.warn('[FilePanel] get-open-files failed', err));
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, dispatch]);

  // 命令侧真值拉取(ADR-037 起由本面板负责;原 CommandPanel 组件同款逻辑,
  // 该通道不做 owner 校验所以无需 waitForClaim)。
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
        // ADR-039 兜底落盘:无 owner 期间 push 的命令没有触发过任何 renderer
        // 事件(commandPanelUpdated 是 owner-only,orphan 时被丢弃),owner 重新
        // 挂载的这次拉取是它进 workspace 快照的第一个机会。幂等:重复调度只是
        // debounce 合并,commandPanel 切片由 main 在写边界取内存真值。
        scheduleWorkspaceSnapshotWrite(
          sessionId,
          () => stateRef.current,
          () => null,
        );
      })
      .catch((err: unknown) => {
        console.warn('[FilePanel] command get-state failed', err);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, dispatch, stateRef]);

  const activeFile: OpenedFile | null =
    snapshot.files.find((file) => file.path === snapshot.activePath) ?? null;
  const activeCommand: CommandEntry | null =
    commandSnapshot.commands.find((c) => c.key === commandSnapshot.activeKey) ?? null;
  // ADR-037:面板内正在看哪一侧。stored 由程序推送/用户点击写入;一侧被清空时
  // 回退另一侧(纯显示层决策,不回写 store)。
  const view = resolveOpenPanelView(
    state.openPanelViews.get(sessionId),
    snapshot.files.length,
    commandSnapshot.commands.length,
  );

  // ADR-021 demand 上报(ADR-037 起从命令面板移到这里):只描述"命令输出是否
  // 真的可见" —— 本组件挂载 = 已打开面板是 active dock 面板(LayoutHost 卸载
  // 非 active 面板),再叠加 dock 未折叠 + 正在看命令侧。后端结合每条
  // refreshPolicy.scope 映射:foreground 的 NONE 真停,background 的 NONE 转
  // WARM。renderer 不把产品策略混进可见性信号;切文件侧/折叠 dock 即降档。
  const dockCollapsed = state.sessions.get(sessionId)?.uiLayout?.docks.right?.collapsed ?? false;
  useEffect(() => {
    const level = view === 'command' && !dockCollapsed ? 'hot' : 'none';
    window.api
      .invoke(COMMAND_CHANNELS.COMMAND_PANEL_SET_DEMAND, { sessionId, level })
      .catch((err: unknown) => console.warn('[FilePanel] command set-demand failed', err));
    return () => {
      window.api
        .invoke(COMMAND_CHANNELS.COMMAND_PANEL_SET_DEMAND, { sessionId, level: 'none' })
        .catch((err: unknown) => console.warn('[FilePanel] command set-demand none failed', err));
    };
  }, [sessionId, view, dockCollapsed]);

  const pendingHeadingNavigation: FilePanelHeadingNavigationPayload | undefined =
    state.filePanelHeadingNavigations.get(sessionId)?.[0];

  // 同一 loading 窗口内可能排入多个不同文件的导航。严格按 FIFO 先 show 对应文件，
  // 文件内容挂载后再由 MarkdownDocument 消费；这样后来的 open 不会吞掉前一个 requestId。
  useEffect(() => {
    if (!pendingHeadingNavigation || pendingHeadingNavigation.path === activeFile?.path) return;
    if (!snapshot.files.some((file) => file.path === pendingHeadingNavigation.path)) {
      dispatch({
        type: 'file-panel/heading-navigation-consumed',
        sessionId,
        requestId: pendingHeadingNavigation.requestId,
      });
      return;
    }
    window.api
      .invoke(COMMAND_CHANNELS.FILE_PANEL_SHOW, {
        sessionId,
        path: pendingHeadingNavigation.path,
      })
      .catch((error: unknown) => {
        console.warn('[FilePanel] queued heading navigation show failed', error);
        dispatch({
          type: 'file-panel/heading-navigation-consumed',
          sessionId,
          requestId: pendingHeadingNavigation.requestId,
        });
      });
  }, [activeFile?.path, dispatch, pendingHeadingNavigation, sessionId, snapshot.files]);

  // 命令输出也是 markdown(共享 MarkdownDocument + markdown 主题),取色 probe
  // 与文件侧同一待遇;其他 viewer 用默认 bg。
  const preloadSurfaceClass =
    activeFile?.kind === 'markdown' || (view === 'command' && activeCommand)
      ? markdownSurfaceClass(markdownStyle)
      : '';

  /**
   * activePath 更新时 OpenedFile.kind 已知，但 FileViewer 仍要异步读内容。利用与最终
   * Markdown 容器完全相同的隐藏 probe（含用户 custom CSS）读取背景，并在浏览器绘制
   * 前写到 body；普通 viewer 的 probe 使用 --color-bg-primary。无依赖数组意味着主题
   * 切换引发的任意 render 也会重新取色，不把旧主题的 resolved rgb 留在 inline style。
   */
  useLayoutEffect(() => {
    const body = bodyScrollRef.current;
    const probe = backgroundProbeRef.current;
    if (!body || !probe) return;
    const probed = window.getComputedStyle(probe).backgroundColor;
    body.style.backgroundColor =
      probed === 'transparent' || probed === 'rgba(0, 0, 0, 0)'
        ? 'var(--color-bg-primary, #f0f)'
        : probed;
  });

  // Text/Diff/Web 自己拥有内层滚动（Text/Diff 是双轴 scroller，Web 是 iframe
  // 内部滚动）；清掉外层 body 可能由上一个 Markdown/Image 留下的 scrollTop，
  // 避免出现两个滚动坐标叠加。命令侧同理:切进命令视图/换命令 tab 都是新的
  // 正文 identity,旧 scrollTop 属于上一个内容(滚动记忆恢复由 useFileViewerScroll
  // 在正文 mount 后接管);文件侧 markdown 不在这里清 —— 它经 useFileContent 的
  // loading 期(!ready)由 hook 自己清。
  useLayoutEffect(() => {
    const isInnerScrollKind =
      activeFile?.kind === 'text' || activeFile?.kind === 'diff' || activeFile?.kind === 'web';
    if (view === 'command' || isInnerScrollKind) {
      bodyScrollRef.current?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    }
  }, [view, activeFile?.kind, activeFile?.path, commandSnapshot.activeKey]);

  // v0.3.1 C2:tab 列表过滤(文件按文件名、命令按标题/命令文本)。内容查找是 C3
  // (在 FileViewer / 命令输出的 MarkdownDocument)。过滤不影响 activeFile /
  // activeCommand —— 搜索时仍显示当前内容,只是 tab 列表收窄。
  const isSearchingTabs = search.visible && search.query.length > 0;
  const filteredFiles = useMemo<OpenedFile[]>(() => {
    if (!isSearchingTabs) return snapshot.files;
    return snapshot.files.filter((f) => matchText(f.name, search.query, search.caseSensitive));
  }, [isSearchingTabs, search.query, search.caseSensitive, snapshot.files]);
  const filteredCommands = useMemo<CommandEntry[]>(() => {
    if (!isSearchingTabs) return commandSnapshot.commands;
    return commandSnapshot.commands.filter(
      (c) =>
        matchText(c.title ?? '', search.query, search.caseSensitive) ||
        matchText(c.command, search.query, search.caseSensitive),
    );
  }, [isSearchingTabs, search.query, search.caseSensitive, commandSnapshot.commands]);

  const handleShow = (path: string): void => {
    // 点文件 tab:面板内切到文件侧 + 让 main 置 activePath(真值)。
    dispatch({ type: 'view/set-open-panel-view', sessionId, view: 'file' });
    window.api
      .invoke(COMMAND_CHANNELS.FILE_PANEL_SHOW, { sessionId, path })
      .catch((err: unknown) => console.warn('[FilePanel] show failed', err));
  };

  const handleClose = (path: string): void => {
    window.api
      .invoke(COMMAND_CHANNELS.FILE_PANEL_CLOSE, { sessionId, path })
      .catch((err: unknown) => console.warn('[FilePanel] close failed', err));
  };

  /** 点命令 tab:面板内切到命令侧 + 让 main 置 activeKey(真值,快照同步进 store)。 */
  const handleSelectCommand = (key: string): void => {
    dispatch({ type: 'view/set-open-panel-view', sessionId, view: 'command' });
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

  const handleCloseCommand = (key: string): void => {
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

  // 「关闭其他」与「关闭所有」:逐个调 close。main 端没有批量 close IPC
  // (也不值得为 tab 菜单加一个);每个 close 各发一次 evt:file-panel:updated,
  // reducer 幂等累积,视觉上 tab 逐个消失。并发 close 同一 session 不冲突 ——
  // FilePanelService 的 panels Map 操作在 Node 单线程里串行。
  const handleCloseOthers = (keepPath: string): void => {
    for (const f of snapshot.files) {
      if (f.path !== keepPath) handleClose(f.path);
    }
  };

  const handleCloseAll = (): void => {
    for (const f of snapshot.files) handleClose(f.path);
  };

  // 命令侧同款(逐个 close,理由同上;closeCommand 快照由 main 推事件回 store)。
  const handleCloseOtherCommands = (keepKey: string): void => {
    for (const c of commandSnapshot.commands) {
      if (c.key !== keepKey) handleCloseCommand(c.key);
    }
  };

  const handleCloseAllCommands = (): void => {
    for (const c of commandSnapshot.commands) handleCloseCommand(c.key);
  };

  /**
   * v0.3.3:命令 tab 右键菜单(此前命令 tab 完全没有右键)。与文件 tab 同宿主构建
   * —— IPC / dispatch 留在 FilePanel,对齐 CommandPanel.tsx 头注声明的组件边界。
   * 形态与文件 tab 对齐:查看族(重新运行)→ 关闭族 → 复制命令。
   * 重新运行复用工具栏 ↻ 的 rerunCommand,running 态同样禁用(防并发重跑)。
   */
  const buildCommandContextMenu = (entry: CommandEntry): ContextMenuItem[] => [
    {
      label: tx('重新运行', 'Run again'),
      onSelect: () => rerunCommand(sessionId, entry),
      disabled: entry.status === 'running',
    },
    { divider: true, label: '' },
    {
      label: tx('关闭', 'Close'),
      onSelect: () => handleCloseCommand(entry.key),
    },
    {
      label: tx('关闭其他', 'Close others'),
      onSelect: () => handleCloseOtherCommands(entry.key),
      disabled: commandSnapshot.commands.length <= 1,
    },
    {
      label: tx('关闭所有', 'Close all'),
      onSelect: () => handleCloseAllCommands(),
      disabled: commandSnapshot.commands.length === 0,
    },
    { divider: true, label: '' },
    {
      label: tx('复制命令', 'Copy command'),
      onSelect: () => copyToClipboard(entry.command, '命令'),
    },
  ];

  // 远程 sudo 仅对 SSH session 有意义:pathId = ssh:<profileId>:<remotePath>。
  // 本地 session 不显 sudo 控件(命令在本机 bash 跑,无 sudo 语义)。
  const sessionPathId = state.sessions.get(sessionId)?.pathId ?? '';
  const isSsh = sessionPathId.startsWith('ssh:');
  const sshProfileId = isSsh ? decodeURIComponent(sessionPathId.split(':')[1] ?? '') : '';

  const nothingOpen = snapshot.files.length === 0 && commandSnapshot.commands.length === 0;

  return (
    <div className="file-panel-content">
      {/* has-mixed-tabs:文件 tab 与命令 tab 都可见时加,分隔线(CSS ::before 挂在
          首个命令 tab 上)才画 —— 用条件类而非独立分隔线元素,换行时线跟着命令
          tab 组走,不会留在上一行末尾。搜索过滤后某侧为空则不加(不可见就不分)。 */}
      <div
        className={
          'file-panel-tabs' +
          (filteredFiles.length > 0 && filteredCommands.length > 0 ? ' has-mixed-tabs' : '')
        }
      >
        {nothingOpen ? (
          <span className="file-panel-empty-hint">
            {tx(
              '从"文件"面板选择文件,或让终端内程序调用 MARINA_SERVICE 打开文件;AI 推送的命令输出也在这里。',
              'Select a file from Files, or let a terminal program open one through MARINA_SERVICE; AI-pushed command output also lives here.',
            )}
          </span>
        ) : isSearchingTabs && filteredFiles.length === 0 && filteredCommands.length === 0 ? (
          <span className="file-panel-empty-hint">{tx('无匹配', 'No matches')}</span>
        ) : (
          <>
            {filteredFiles.map((file) => {
              const isActive = view === 'file' && file.path === snapshot.activePath;
              // 受管 git-diff tab(GitService 写入 origin)与普通文件 tab 菜单分化:
              // diff tab 围绕"源文件"组织(打开源文件 / 复制源文件相对路径),不暴露
              // 指向 __marina_diff__ 临时文件的路径族(reveal/默认应用/绝对路径无使用
              // 价值);外部打开的裸 .diff(无 origin)保持普通文件 tab 形态。
              const diffOrigin = file.origin?.kind === 'git-diff' ? file.origin : null;
              // 关闭族两种形态共用(同一 tab 列表,同一套 close IPC)。
              const closeCapability = {
                close: () => handleClose(file.path),
                closeOthers: () => handleCloseOthers(file.path),
                closeAll: () => handleCloseAll(),
                closeOthersDisabled: snapshot.files.length <= 1,
                closeAllDisabled: snapshot.files.length === 0,
              };
              const buildContextMenu = (): ContextMenuItem[] =>
                buildFileEntryMenu(
                  diffOrigin
                    ? {
                        // 与 DiffViewer 工具栏「打开源文件」同通道同参数(origin 真值,
                        // repoIdentity 让 main 校验 session 仍在生成该 diff 的仓库)。
                        openFile: {
                          label: tx('打开源文件', 'Open source file'),
                          run: () => {
                            window.api
                              .invoke(COMMAND_CHANNELS.GIT_OPEN_FILE, {
                                sessionId,
                                relativePath: diffOrigin.relativePath,
                                repoIdentity: diffOrigin.repoIdentity,
                              })
                              .catch((err: unknown) =>
                                toast.push({
                                  kind: 'error',
                                  message: `打开源文件失败:${err instanceof Error ? err.message : String(err)}`,
                                }),
                              );
                          },
                          // 生成 diff 时源文件已删(deleted 变更)→ 打开必失败,禁用。
                          disabled: diffOrigin.sourceMissing,
                        },
                        relativePath: diffOrigin.relativePath,
                        close: closeCapability,
                      }
                    : {
                        // file-panel tab 无强主操作(左键已切 active),不提供 primary。
                        // 查看族:文本类 tab 提供「打开 diff」—— absolutePath 变体让
                        // main 按文件自身位置定位仓库(文件可能不属于 session cwd 的
                        // 仓库)。二进制(image/unknown)不提供:main 对二进制的处理
                        // 就是重新打开文件本身,对已打开的 tab 是无意义往返。
                        ...(file.kind === 'text' || file.kind === 'markdown' || file.kind === 'web'
                          ? {
                              openDiff: {
                                run: () => {
                                  window.api
                                    .invoke(COMMAND_CHANNELS.GIT_OPEN_DIFF, {
                                      sessionId,
                                      absolutePath: file.path,
                                    })
                                    .catch((err: unknown) =>
                                      toast.push({
                                        kind: 'error',
                                        message: `打开 diff 失败:${err instanceof Error ? err.message : String(err)}`,
                                      }),
                                    );
                                },
                                // 僵尸 tab:磁盘文件已删,main realpath 必失败 → 禁用而非点击报错。
                                disabled: file.missing === true,
                              },
                            }
                          : {}),
                        close: closeCapability,
                        // OpenedFile.path 是 main 端规范化的绝对路径(file-panel HTTP
                        // 在 SSH 上架构性失效 → 能看到 tab 一定是本地路径,不担心 SSH 灰显)。
                        resolveAbsolutePath: async () => file.path,
                        reveal: () => {
                          window.api
                            .invoke(COMMAND_CHANNELS.SYSTEM_SHOW_IN_EXPLORER, { path: file.path })
                            .catch((err: unknown) =>
                              toast.push({
                                kind: 'error',
                                message: `打开 Explorer 失败:${err instanceof Error ? err.message : String(err)}`,
                              }),
                            );
                        },
                        // v0.3.2:用系统默认应用打开(调关联程序,如图片/PDF)。
                        openExternal: () => {
                          window.api
                            .invoke(COMMAND_CHANNELS.SYSTEM_OPEN_PATH, { path: file.path })
                            .catch((err: unknown) =>
                              toast.push({
                                kind: 'error',
                                message: `打开失败:${err instanceof Error ? err.message : String(err)}`,
                              }),
                            );
                        },
                      },
                  {
                    copyToClipboard,
                    toastError: (m) => toast.push({ kind: 'error', message: m }),
                    tx,
                  },
                );
              return (
                <FileListRow
                  key={file.path}
                  variant="tab"
                  icon={fileIconFor(file.name)}
                  iconCornerBadge={file.kind === 'diff' ? 'D' : undefined}
                  label={
                    <HighlightedText
                      text={file.name}
                      query={isSearchingTabs ? search.query : ''}
                      caseSensitive={search.caseSensitive}
                    />
                  }
                  title={file.path}
                  selected={isActive}
                  onClick={() => handleShow(file.path)}
                  buildContextMenu={buildContextMenu}
                  /* × 关闭按钮保留原视觉与交互:点击不触发 onClick(切 tab),
                     只调 close。trailing 槽挂在 row 容器上,与 button 分离。 */
                  trailing={
                    <span
                      className="file-list-row-tab-close"
                      role="button"
                      tabIndex={0}
                      onClick={() => handleClose(file.path)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') handleClose(file.path);
                      }}
                      title={tx('关闭', 'Close')}
                    >
                      ×
                    </span>
                  }
                />
              );
            })}
            <CommandTabStrip
              commands={filteredCommands}
              activeKey={view === 'command' ? commandSnapshot.activeKey : null}
              onSelect={handleSelectCommand}
              onClose={handleCloseCommand}
              search={search}
              buildContextMenu={buildCommandContextMenu}
            />
          </>
        )}
      </div>
      {view === 'command' && activeCommand && (
        <CommandToolbar sessionId={sessionId} entry={activeCommand} isSsh={isSsh} />
      )}
      <div
        ref={bodyScrollRef}
        className="file-panel-body"
        data-viewer-kind={view === 'command' ? 'command' : (activeFile?.kind ?? 'none')}
        data-viewer-path={view === 'command' ? (activeCommand?.key ?? '') : (activeFile?.path ?? '')}
      >
        <div
          ref={backgroundProbeRef}
          className={`file-panel-background-probe${
            preloadSurfaceClass ? ` ${preloadSurfaceClass}` : ''
          }`}
          aria-hidden="true"
        />
        {view === 'command' ? (
          activeCommand ? (
            <CommandPane
              sessionId={sessionId}
              entry={activeCommand}
              search={search}
              isSsh={isSsh}
              sshProfileId={sshProfileId}
              scrollRef={bodyScrollRef}
            />
          ) : (
            <div className="command-panel-empty">
              <p>{tx('尚无命令', 'No commands yet')}</p>
              <p className="command-panel-hint">
                {tx('在终端里跑：marina run "<命令>"', 'Run in terminal: marina run "<cmd>"')}
              </p>
            </div>
          )
        ) : activeFile ? (
          <FileViewer
            sessionId={sessionId}
            file={activeFile}
            search={search}
            outerScrollRef={bodyScrollRef}
            {...(pendingHeadingNavigation?.path === activeFile.path
              ? { headingNavigation: pendingHeadingNavigation }
              : {})}
          />
        ) : (
          <div className="file-panel-placeholder">
            {tx('选择上方文件查看内容', 'Select a file above to view')}
          </div>
        )}
      </div>
    </div>
  );
}
