/**
 * @file src/shared/marina-link.ts
 * @purpose 解析 Markdown 文档里的 marina: 动作链接(v0.3.3 ADR-035)。
 *   `[点我](marina:show other.md)` 点击后等价于 agent 在终端里跑
 *   `./marina show other.md` —— 文档变成可交互菜单/导航的载体。
 *
 * @语法规范(与 skill 的 CLI 子命令对齐,只收用户可点的两个动词):
 * - `marina:show <path> [--heading <标题文字>]`
 *     在本 session 的「已打开」面板里只读打开目标文件(相对 md 文件目录;命令
 *     面板输出等无 mdPath 来源则相对 session cwd,与 CLI show 一致)。
 * - `marina:run [--title <标签>] <command...>`
 *     把命令推给命令面板执行并渲染输出(与 CLI run 同一条 CommandPanelService
 *     路径)。--title 必须写在命令之前(与 CLI 文档示例同位);命令自身的
 *     --flag 不会被误吞。
 * - 其它子命令(workspace/list/close/screenshot/ping)是 agent 侧工具,不提供
 *     文档内点击形态 —— 见方案文档的取舍记录。
 *
 * @解码与分词规则(两层,顺序固定,文档里要写清楚):
 * 1. percent-decode 一次:CommonMark 链接目标里空格必须写 %20(或 <> 包裹),
 *    所以 %20 等转义先还原成字面字符 —— 这是 URL 传输层编码,不是语义的一部分。
 * 2. shell 风格分词:空白分隔;'...' 与 "..." 包含空格的参数;引号前的反斜杠
 *    仅转义紧跟的同款引号( \" → " ),其余反斜杠保持字面(Windows 路径 D:\x
 *    不能被吃掉)。未闭合的引号容忍到底(容错被截断的写法)。
 * 3. show 的路径 / run 的命令 = 位置参数按单空格拼接(%20 自然写法因此可用;
 *    引号内空格原样保留)。
 *
 * @安全模型(为什么解析后直接执行、无确认弹窗):
 *   与可运行代码块(ADR-023)同一决策:能让用户看到这份文档的 agent 本身就有
 *   调 CLI 执行任意指令的能力,文档内嵌动作不提升权限面;任意来源的 md 文件
 *   同样早已有一键运行代码块的能力,不引入新的暴露。renderer 永远只把原始
 *   href 交给 main,解析/路径解析/成员校验都在 main 端(与 openFileFromMarkdown
 *   同防线)。
 *
 * @对应文档: docs/方案-marina动作链接-20260909.md;软件定义书 ADR-035;
 *   packages/pi-marina-bridge/skills/show-in-marina/SKILL.md(marina: 链接节)。
 *
 * @不要在这里做的事:
 * - 不做 IPC / 不 import electron —— 本文件必须可被 node 环境(renderer 的
 *   url-transform 测试 / main 的 dispatch 测试)直接单测的纯函数。
 * - 不解析除 show/run 之外的子命令(要扩先改方案文档 + 这里 + skill 文档)。
 */

import { isMarinaActionHref } from './url-scheme';

/** 参数串长度上限(解码前)。防超大 href 撑爆解析/日志;正常路径/命令远小于此。 */
const MAX_PARAMS_LENGTH = 4096;

/** 解析成功得到的动作命令(renderer 只透传 href,结构化结果只给 main 用)。 */
export type MarinaLinkCommand =
  | { kind: 'show'; path: string; heading?: string }
  | { kind: 'run'; command: string; title?: string };

/** 解析结果:ok=false 时 error 是可直接 toast 给用户的中文说明。 */
export type MarinaLinkParseResult =
  | { ok: true; command: MarinaLinkCommand }
  | { ok: false; error: string };

/**
 * percent-decode 一次,失败(malformed % 序列)保留原值 —— 与
 * FilePanelService.openFileFromMarkdown 对 src 的容错一致。
 */
function decodeOnce(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * shell 风格分词。规则见文件头「解码与分词规则」。
 * 关键点:反斜杠是字面字符(Windows 路径),仅「反斜杠+同款引号」转义成引号。
 */
function tokenizeParams(params: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let hasToken = false; // 空引号 "" 也算一个 token,与 shell 一致
  let i = 0;
  while (i < params.length) {
    const ch = params.charAt(i);
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      if (hasToken) {
        tokens.push(current);
        current = '';
        hasToken = false;
      }
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      let closed = false;
      while (i < params.length) {
        const c = params.charAt(i);
        // 唯一的转义:反斜杠紧贴同款引号 → 字面引号进 token。
        if (c === '\\' && params.charAt(i + 1) === quote) {
          current += quote;
          i += 2;
          continue;
        }
        if (c === quote) {
          closed = true;
          i += 1;
          break;
        }
        current += c;
        i += 1;
      }
      hasToken = true;
      // 未闭合:剩余字符已被吃进 token,自然结束(容错)。
      if (!closed) break;
      continue;
    }
    current += ch;
    hasToken = true;
    i += 1;
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

/**
 * 解析 marina: 动作链接的原始 href(renderer 透传,含 marina: 前缀与
 * percent-encoding)。非 marina: 前缀 / 空 / 超限 / 语法错都返回 ok=false +
 * 可 toast 的 error;调用方不需要区分错误级别。
 *
 * flag 识别规则(刻意极简,避免误吞命令自己的 flag):
 * - run 只认「命令开始之前」的 --title(与 CLI 文档示例 `run --title X "cmd"`
 *   同位)。一旦出现第一个位置参数,后续一切 token(含 --flag/-q)都是命令内容
 *   —— `marina:run gh issue list --limit 5` 里的 --limit 属于 gh。
 * - show 只认 --heading(出现在路径前后都行,与 CLI 示例 `show x.md --heading Y`
 *   同形),其余 token 一律拼进路径。误写的参数会以「文件不存在: <完整名>」
 *   自然浮错,不需要前置校验。
 */
export function parseMarinaLinkHref(href: string): MarinaLinkParseResult {
  if (!isMarinaActionHref(href)) {
    return { ok: false, error: `不是 marina: 动作链接: "${href.slice(0, 64)}"` };
  }
  // 'marina:'.length === 7;前缀大小写不敏感(scheme 语义),slice 位置不受影响。
  const raw = href.slice('marina:'.length);
  if (raw.length > MAX_PARAMS_LENGTH) {
    return {
      ok: false,
      error: `marina: 链接参数 ${raw.length} 字符超过 ${MAX_PARAMS_LENGTH} 上限。请拆短命令或改用代码块。`,
    };
  }
  const params = decodeOnce(raw);
  const tokens = tokenizeParams(params);
  const sub = (tokens[0] ?? '').toLowerCase();

  if (sub === 'show') {
    // 位置参数按单空格拼接成路径(与 run 的命令拼接同规则):CommonMark 裸链接目标
    // 里空格必须写 %20,解码后自然拆成多个 token,拼接让「自然写法」直接可用;
    // 引号包住的参数保留内部精确空格。多个独立 token 当一个含空格路径处理。
    const parts: string[] = [];
    let heading: string | undefined;
    for (let i = 1; i < tokens.length; i += 1) {
      const token = tokens[i]!;
      if (token === '--heading') {
        const value = tokens[i + 1];
        if (value === undefined) {
          return { ok: false, error: 'marina:show 的 --heading 需要一个值(标题文字,可加引号)。' };
        }
        heading = value;
        i += 1;
      } else {
        parts.push(token);
      }
    }
    const path = parts.join(' ');
    if (path.length === 0) {
      return { ok: false, error: 'marina:show 需要一个文件路径,如 marina:show report.md。' };
    }
    return {
      ok: true,
      command: heading === undefined ? { kind: 'show', path } : { kind: 'show', path, heading },
    };
  }

  if (sub === 'run') {
    const parts: string[] = [];
    let title: string | undefined;
    let commandStarted = false;
    for (let i = 1; i < tokens.length; i += 1) {
      const token = tokens[i]!;
      // --title 只在命令开始前识别;之后出现的同名/任意 flag 都属于命令本身。
      if (token === '--title' && !commandStarted) {
        const value = tokens[i + 1];
        if (value === undefined) {
          return { ok: false, error: 'marina:run 的 --title 需要一个值(命令面板标签,可加引号)。' };
        }
        title = value;
        i += 1;
        continue;
      }
      parts.push(token);
      commandStarted = true;
    }
    const command = parts.join(' ');
    if (command.length === 0) {
      return { ok: false, error: 'marina:run 需要命令,如 marina:run gh issue list。' };
    }
    return {
      ok: true,
      command: title === undefined ? { kind: 'run', command } : { kind: 'run', command, title },
    };
  }

  return {
    ok: false,
    error:
      `marina: 链接不支持子命令 "${sub || '(空)'}"。文档内可用的只有 show(打开文件)与 ` +
      'run(命令面板执行);其它 CLI 子命令请在终端里跑。',
  };
}

/**
 * 渲染层用的轻量窥探:href 是否 marina: 动作链接、是哪个动词(决定 chip 图标)。
 * 不做完整校验 —— 解析失败的链接照样渲染成 chip,点击时 main 端报错 toast。
 */
export function peekMarinaLinkKind(href: string): 'show' | 'run' | null {
  if (!isMarinaActionHref(href)) return null;
  const first = tokenizeParams(decodeOnce(href.slice('marina:'.length)))[0] ?? '';
  const lower = first.toLowerCase();
  return lower === 'show' || lower === 'run' ? lower : null;
}

/**
 * chip 的 hover 提示文本:解码后的参数原文(让用户在点击前看到会执行什么 ——
 * 这是 marina: 链接最重要的知情通道)。非 marina: href 返回 null。
 */
export function marinaLinkDisplayCommand(href: string): string | null {
  if (!isMarinaActionHref(href)) return null;
  return decodeOnce(href.slice('marina:'.length)).trim();
}
