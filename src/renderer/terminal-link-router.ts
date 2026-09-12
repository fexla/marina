/**
 * @file src/renderer/terminal-link-router.ts
 * @purpose 终端链接点击的统一路由(方案-终端可交互链接-20260912)。
 *   两个入口共用:① xterm `linkHandler.activate`(OSC 8 超链接,pi TUI 输出);
 *   ② 自研 []() LinkProvider 的 activate(pi -p / cat md / 其它工具的裸 markdown)。
 *   分类路由与 markdown 面板 MdLink 的分流语义对齐:
 *   - `https?:` / `mailto:` → IPC SYSTEM_OPEN_EXTERNAL(系统浏览器,main 白名单)。
 *   - `marina:` 动作链接 → IPC MARINA_LINK_RUN(复用 ADR-035 分发:show 进本
 *     session 文件面板、run 命令面板执行)。终端链接**不带** mdPath/commandKey
 *     基准 —— show 相对 session.currentCwd 解析(bridge transformer 已把路径
 *     绝对化,自包含)。
 *   - `#anchor` → 无操作(文档内导航在终端无意义)。
 *   - 其余 → 当路径处理,走 openPathFromTerminal 候选链(FILE_PANEL_OPEN,
 *     相对 currentCwd 解析,支持 path:line)。
 *
 * @安全:
 * - 未知 scheme 一律落「路径」分支 → resolveAndStat 校验,不存在即 toast,
 *   不会 openExternal 任意协议(与 window-manager setWindowOpenHandler 同防线)。
 * - marina:run 的无确认信任模型与 ADR-035 一致(hover tooltip 始终展示命令
 *   原文 = 知情点击;执行在命令面板可见可停)。
 *
 * @不要在这里做的事:
 * - 不做 UI(toast 由 TerminalView 注入的 actions 处理);
 * - 不解析 marina: 语法(main 端 marina-link.ts 是唯一真值,renderer 只透传 href)。
 */
import { marinaLinkDisplayCommand } from '@shared/marina-link';
import { isMarinaActionHref } from '@shared/url-scheme';
import { parsePathWithLineCol } from '@shared/terminal-path-detector';

/** 路由动作集(由 TerminalView 注入:IPC 调用 + toast + 候选链)。 */
export interface TerminalLinkActions {
  /** http(s)/mailto → 系统浏览器。 */
  openExternal(url: string): void;
  /** marina: 动作链接 → main 分发。 */
  runMarinaLink(href: string): void;
  /** 路径类 → 「已打开」面板(候选逐试,相对 session currentCwd)。 */
  openPath(candidates: string[], line?: number): void;
}

/**
 * 路由一个终端链接 URI。永不抛异常(分类错了最坏落到路径分支 toast)。
 *
 * @param uri OSC 8 URI 或 markdown href 原值
 * @param actions 见 TerminalLinkActions
 */
export function routeTerminalUri(uri: string, actions: TerminalLinkActions): void {
  if (typeof uri !== 'string' || uri.length === 0) return;
  if (/^(https?|mailto):/i.test(uri)) {
    actions.openExternal(uri);
    return;
  }
  if (isMarinaActionHref(uri)) {
    actions.runMarinaLink(uri);
    return;
  }
  if (uri.startsWith('#')) return; // 文档内 anchor,终端无文档语义
  // 其余按路径处理(宽松解析:裸文件名也认,`path:line` 支持行号)
  const parsed = parsePathWithLineCol(uri);
  actions.openPath([parsed.path], parsed.line);
}

/**
 * 链接 hover tooltip 文案:marina: 链接显示解码后的命令原文(知情通道,
 * 长链接被缩短 label 后这里展示完整语义);其余显示 URI 原值。
 */
export function terminalLinkTooltipText(uri: string): string {
  return marinaLinkDisplayCommand(uri) ?? uri;
}
