/**
 * @file src/main/marina-link-dispatch.ts
 * @purpose marina: 动作链接(v0.3.3 ADR-035)的 main 端分发:把文档里
 *   `[x](marina:show a.md)` 的点击,分发到与 CLI 同源的服务路径
 *   (FilePanelService.openFileFromMarkdown / openFile、CommandPanelService.runCommand)。
 *
 * @关键设计:
 * - 「视为触发 CLI」而非「spawn CLI」:CLI 脚本(marina.ps1/sh)本体只是
 *   HTTP→网关→这些服务的客户端。main 进程就在服务侧,直接方法调用语义等价,
 *   免去每次点击 spawn PowerShell 的 300ms+ 启动延迟与 env 注入(面板交互
 *   <300ms 的性能底线见 AGENTS.md 第 10 章)。子命令集合只收 show/run
 *   (用户可点的两个动词),解析见 src/shared/marina-link.ts。
 * - show 的路径基准:有 mdPath(「已打开」面板里的文件)→ 相对 md 文件目录
 *   + 成员校验(openFileFromMarkdown,与普通本地链接同防线);无 mdPath
 *   (命令面板输出)→ 相对 session.currentCwd(openFile,与 CLI show 一致 ——
 *   这是命令输出里开本地文件的第一条通道,权限面与 UI「打开文件」按钮的
 *   FILE_PANEL_OPEN 完全相同,不引入新边界)。
 * - run:与 HTTP /run 网关路由同一条 CommandPanelService.runCommand。CLI 通道
 *   的 requestingClientId 传 null(service 兜底到 session owner);IPC 通道
 *   有明确发起窗口,传 windowId 让输出事件定向回点击的窗口。
 * - 错误透传:服务抛的 FilePanelError / CommandPanelError 直接上抛,ipc 层
 *   包成 IpcError,renderer 端 MdLink 捕获后 toast(与本地链接失败同 UX)。
 *
 * @对应文档: docs/方案-marina动作链接-20260909.md;软件定义书 ADR-035;
 *   src/shared/marina-link.ts(语法/分词/安全模型)。
 *
 * @不要在这里做的事:
 * - 不做确认弹窗/命令扫描 —— 与 ADR-023 可运行代码块同一产品决策(见
 *   marina-link.ts 文件头安全模型),这里再挂一层确认属于决策回退。
 * - 不解析 workspace/list/close/screenshot —— 要扩先改方案文档 + skill 文档。
 * - 不写 PTY / 不经终端字节流(那是 SessionManager 的职责)。
 */
import { parseMarinaLinkHref, type MarinaLinkCommand } from '@shared/marina-link';
import { logger } from './logger';
import type { FilePanelService } from './file-panel-service';
import type { CommandPanelService } from './command-panel-service';

const MODULE = 'MarinaLinkDispatch';

/** 分发依赖的服务面(窄接口,便于单测注入 fake;真身由 ipc 装配传入)。 */
export interface MarinaLinkDispatchDeps {
  filePanelService: Pick<FilePanelService, 'openFile' | 'openFileFromMarkdown'>;
  commandPanelService: Pick<CommandPanelService, 'runCommand'>;
}

/** 分发结果(renderer 只用来确认动作类别;面板状态经既有事件推送更新)。 */
export interface MarinaLinkDispatchResult {
  kind: MarinaLinkCommand['kind'];
}

/** 解析失败(语法错)专用的错误码;renderer toast message 即 parse error。 */
export class MarinaLinkError extends Error {
  constructor(
    public readonly code: 'InvalidLink',
    message: string,
  ) {
    super(message);
    this.name = 'MarinaLinkError';
  }
}

/**
 * 执行一次 marina: 动作链接点击。
 *
 * @param deps 服务依赖(filePanelService + commandPanelService)。
 * @param sessionId 链接所在文档归属的 session(动作的作用域:show 开进该
 *   session 的面板,run 在该 session 的 cwd 下执行)。
 * @param mdPath 「已打开」面板来源的文档绝对路径;命令面板输出无文档路径传
 *   undefined(show 退化为按 session cwd 解析)。
 * @param href 渲染层透传的链接原始值(含 marina: 前缀与 percent-encoding)。
 * @param requestingClientId 发起窗口(windowId);run 的事件定向用,可为 null。
 * @returns 动作类别;失败抛 MarinaLinkError(语法)或服务原生错误(状态机)。
 *
 * @副作用(按子命令):
 * - show:目标文件进该 session 的面板并切 active(可能新增 watcher);
 *   带 --heading 时发一次 filePanelNavigationRequested。
 * - run:命令面板 upsert/执行该命令(spawn bash,输出流回推)。
 */
export async function dispatchMarinaLink(
  deps: MarinaLinkDispatchDeps,
  sessionId: string,
  mdPath: string | undefined,
  href: string,
  requestingClientId: string | null,
): Promise<MarinaLinkDispatchResult> {
  const parsed = parseMarinaLinkHref(href);
  if (!parsed.ok) {
    throw new MarinaLinkError('InvalidLink', parsed.error);
  }
  const command = parsed.command;
  logger.info(
    MODULE,
    `dispatch: sid=${sessionId} kind=${command.kind} mdPath=${mdPath ?? '(none)'}`,
  );

  if (command.kind === 'show') {
    if (mdPath !== undefined) {
      await deps.filePanelService.openFileFromMarkdown(sessionId, mdPath, command.path, {
        ...(command.heading === undefined ? {} : { heading: command.heading }),
      });
    } else {
      await deps.filePanelService.openFile(sessionId, command.path, {
        ...(command.heading === undefined ? {} : { heading: command.heading }),
      });
    }
    return { kind: 'show' };
  }

  await deps.commandPanelService.runCommand(
    sessionId,
    command.command,
    command.title ?? null,
    requestingClientId,
    false,
  );
  return { kind: 'run' };
}
