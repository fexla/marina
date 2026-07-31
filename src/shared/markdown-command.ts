/**
 * @file src/shared/markdown-command.ts
 * @purpose Markdown 代码块一键执行的纯逻辑层:从 react-markdown 渲染出的
 *   fenced code block 语言标签,归一化到受支持的 shell 语言,并判断该代码块
 *   是否可以出现"运行"按钮。
 *
 * @关键设计:
 * - 纯函数 + 零依赖,main 与 renderer 都可用(目前仅 renderer 用,但归一化规则
 *   集中在此,避免 UI 与 main spawn 分支各维护一份别名表而漂移)。
 * - 语言别名表是本模块的唯一真相源;main 的 CodeBlockRunner 据此选 spawn 命令。
 * - 代码块可执行判定只看语言标签;不做命令扫描、风险分级、长度截断 —— 这些
 *   交互约束已按产品决策移除(详见 docs/方案-markdown代码块执行-20260731.md)。
 *
 * @对应文档章节: docs/方案-markdown代码块执行-20260731.md;
 *   软件定义书 ADR-023(Markdown 代码块一键执行)。
 *
 * @不要在这里做的事:
 * - 不解析 / 执行命令(那是 main/CodeBlockRunner 的职责,经 child_process.spawn)。
 * - 不做任何 IPC / React —— 本模块可被任何上下文 import。
 */

import type { CodeBlockLanguage } from './protocol';

/**
 * 受支持的归一化 shell 语言集合。与 CodeBlockLanguage union 一一对应,
 * 作为 `language in SUPPORTED_LANGUAGES` 判定的真相源。
 */
export const SUPPORTED_LANGUAGES: ReadonlySet<CodeBlockLanguage> = new Set<CodeBlockLanguage>([
  'bash',
  'sh',
  'powershell',
  'pwsh',
  'cmd',
]);

/**
 * 语言别名 → 归一化语言。覆盖 Markdown / 文档里常见的写法:
 * - bash 系:`bash` / `sh` / `shell` / `zsh` / `fish` → 统一用 POSIX shell
 *   spawn(在 Windows 上回退到 Git Bash,详见 CodeBlockRunner)。
 * - PowerShell 系:`powershell` / `powershell.exe` / `posh` → Windows PowerShell 5.1;
 *   `pwsh` / `pwsh.exe` → PowerShell 7+。
 * - cmd 系:`cmd` / `cmd.exe` / `bat` / `batch` / `dos` → cmd.exe /c。
 *
 * 未列出的语言(undefined / 'python' / 'json' / ...)返回 null,renderer
 * 据此只显示"复制"不显示"运行"。
 */
const LANGUAGE_ALIASES: ReadonlyMap<string, CodeBlockLanguage> = new Map<string, CodeBlockLanguage>([
  // POSIX shell 系
  ['bash', 'bash'],
  ['sh', 'sh'],
  ['shell', 'sh'],
  ['zsh', 'sh'],
  ['fish', 'sh'],
  ['ksh', 'sh'],
  ['dash', 'sh'],
  // Windows PowerShell 5.1
  ['powershell', 'powershell'],
  ['powershell.exe', 'powershell'],
  ['posh', 'powershell'],
  ['ps1', 'powershell'],
  // PowerShell 7+
  ['pwsh', 'pwsh'],
  ['pwsh.exe', 'pwsh'],
  // cmd / 批处理
  ['cmd', 'cmd'],
  ['cmd.exe', 'cmd'],
  ['bat', 'cmd'],
  ['batch', 'cmd'],
  ['dos', 'cmd'],
]);

/**
 * 把 react-markdown 给出的 `className`(形如 `language-bash`)或裸语言字符串
 * 归一化为受支持语言。不支持的语言返回 null。
 *
 * @param className react-markdown code 节点的 className,通常 `language-xxx`。
 * @param fallbackRaw 若调用方已抽出裸语言标签可直接传,优先用 className。
 */
export function resolveLanguage(
  className: string | undefined,
  fallbackRaw?: string,
): CodeBlockLanguage | null {
  let raw = fallbackRaw?.trim().toLowerCase();
  if (className) {
    // react-markdown 输出 "language-bash";也容错空格分隔多 class。
    const match = /language-([\w.+-]+)/.exec(className);
    if (match) raw = match[1]!.toLowerCase();
  }
  if (!raw) return null;
  return LANGUAGE_ALIASES.get(raw) ?? null;
}

/**
 * 代码块是否应该出现"运行"按钮。当前唯一判据:语言归一化命中受支持集合。
 * 空 code(纯空白)也算不可运行 —— 没东西可跑,且避免 AI 误输出空块时按钮
 * 点了立即报"code 为空"。
 */
export function isRunnable(language: CodeBlockLanguage | null, code: string): boolean {
  if (language === null) return false;
  if (!SUPPORTED_LANGUAGES.has(language)) return false;
  return code.trim().length > 0;
}
