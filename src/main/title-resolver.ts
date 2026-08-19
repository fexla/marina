/**
 * @file src/main/title-resolver.ts
 * @purpose 终端标题的「来源分级 + 纯函数裁决」(ADR-032)。displayName 不再是
 * 谁最后写谁赢的可变字段,而是从多个带来源标签的插槽里按权威性派生。
 *
 * @关键设计(为什么是这个形状):
 * - 根因(TIT-1 三个月未根治):同一个 OSC 0 字节通道里混着两类语义完全不同的
 *   发声者 —— 前台程序(pi / vim / claude)与 shell 及其子进程 —— 接收端
 *   无法区分,只能猜内容。本模块把「谁说的话算数」从写入顺序/字符串内容
 *   改成来源身份:每个写入者只声明自己是谁,裁决集中在一处。
 * - 与 ADR-030(TerminalStateGetter)同构但**不共用抽象**:state 是事件流拉取
 *   (需要 getter 回调),title 是多槽派生(只有值)。共享的是设计原则
 *   (来源分级 + 兜底恢复),不是代码。
 * - OSC 133 的唯一职责是「D 释放 program 槽」:pi 自己会往输出里写
 *   133;A/B/C 作为消息分区标记(pi dist assistant-message.js),若用 A/B/C
 *   驱动任何状态会被 pi 污染;pi 从不发 D,shell hook 只在「上一条命令结束、
 *   新 prompt 渲染」时发 D —— 那正是前台程序确定退出的时刻。
 *
 * @分类器顺序(故意名单在前,见 ADR-032「实施修正」):
 * 1. looksLikeShellStartupGarbage → 丢弃(TIT-1 裸路径防线原样保留)
 * 2. isShellSelfTitle(精确匹配) → shell 槽
 * 3. 其余一律 → program 槽
 * 不用「OSC 133 阶段推断 shell/program」:pi 的 A/B/C 分区标记会在 program
 * 运行中途把阶段翻回 shell,把 pi 自己的标题错分进 shell 槽,与子进程标题
 * 同槽互相覆盖 —— 恰好复现本 ADR 要修的 bug。
 *
 * @对应文档章节: 软件定义书.md ADR-032;
 *   docs/方案-终端标题来源分层-20260819.md(设计全文)
 *
 * @不要在这里做的事:
 * - 不要 emit IPC / 摸 SessionInfo(那是 SessionManager.declareTitle 的职责)
 * - 不要持久化(title 状态是内存态,session 不跨重启,ADR-008)
 */

/**
 * 标题声明来源,按权威性排序。数值即优先级,高者胜。
 * 同 ADR-030 的分层精神:来源分级,非平级覆盖。
 */
export const TITLE_SOURCE_PRIORITY = {
  /** 模板名 / shell 推断名(pickDisplayName),永远存在的地板值 */
  default: 0,
  /** shell 自身及其子进程的 OSC 0 精确自报(「Windows PowerShell」等) */
  shell: 10,
  /** 前台程序的 OSC 0(pi / vim / claude / make) */
  program: 20,
  /** agent bridge 明确声明(onPiName),比裸 OSC 更可信 */
  agent: 30,
  /** 用户手动命名(renameSession),永久最高 */
  user: 40,
} as const;

export type TitleSourceKind = keyof typeof TITLE_SOURCE_PRIORITY;

/**
 * 每个来源一个插槽;null = 该来源尚未发声(或已释放)。
 * default 槽由 createTitleState 保证永不为 null → resolveTitle 必有返回值。
 */
export type TitleState = Record<TitleSourceKind, string | null>;

/** 创建初始 TitleState:default 槽 = session 创建时的推断名,其余空。 */
export function createTitleState(defaultName: string): TitleState {
  return { default: defaultName, shell: null, program: null, agent: null, user: null };
}

/**
 * 纯函数裁决:取优先级最高的非空插槽。
 *
 * 这是 displayName 的**唯一**取值规则 —— 它使得「pi 的标题被 shell 子进程
 * 抢走」在结构上不可能:program(20) > shell(10),无论字节谁后到。
 */
export function resolveTitle(state: TitleState): string {
  let best: string | null = null;
  let bestPriority = -1;
  for (const kind of Object.keys(TITLE_SOURCE_PRIORITY) as TitleSourceKind[]) {
    const value = state[kind];
    if (value !== null && TITLE_SOURCE_PRIORITY[kind] > bestPriority) {
      best = value;
      bestPriority = TITLE_SOURCE_PRIORITY[kind];
    }
  }
  // createTitleState 契约保证 default 非空,这里只是防御性兜底
  return best ?? '';
}

/**
 * OSC 0/1/2 标题规范化:
 *   - 控制字符(C0 + DEL)替成空格
 *   - Unicode 双向重写字符替成空格(防 RTL override 视觉欺骗)
 *   - 合并连续空格、trim、截到 100 字符
 *
 * 空串返回 ''(调用方据此跳过)。
 */
const TITLE_MAX_LEN = 100;
export function sanitizeTitle(raw: string): string {
  let s = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) {
      s += ' ';
      continue;
    }
    // OSC-6:Unicode 双向重写字符 — 防止恶意 OSC 通过 RTL override 让
    // tab 标题视觉上反转("safe.txt exe.live" 看上去像 "evil.exe safe.txt"
    // 反向版)。U+200B / U+200E / U+200F / U+202A-202E / U+2066-2069。
    if (
      code === 0x200b ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      s += ' ';
      continue;
    }
    s += ch;
  }
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > TITLE_MAX_LEN) s = s.slice(0, TITLE_MAX_LEN);
  return s;
}

/**
 * OSC 标题「启动垃圾」识别(TIT-1,2026-05 起):
 *
 * Windows 上 powershell.exe / cmd.exe 启动早期调 Win32 SetConsoleTitle()
 * 把窗口标题设成自己的 exe 路径,ConPTY 把这次调用翻译成 OSC 0 序列;
 * Git Bash 默认 PS1 又在每次 prompt 时主动发 `\e]0;MINGW64:<cwd>\a`。
 * 这些标题对用户全是噪声(tab 该显示 "PowerShell" / "Bash" 或工具名)。
 *
 * 判别规则(整段完整匹配,不误杀 CLI 工具标题):
 *   整段标题 *本身就是* 一个裸路径 → 启动垃圾 → 拒
 *   标题里 *包含* 路径但前后有别的内容(vim /etc/hosts、✻ Claude · ~/p)→ 放行
 *
 * ADR-032 语义:命中 → **丢弃**(不进任何槽)。这些值作为 tab 标题永远是
 * 噪声,连 shell 槽都不该进(否则纯 shell session 的 tab 会显示 exe 路径,
 * 重新 break TIT-1 当年的用户可见修复)。36 个回归 case 见
 * session-manager.test.ts `describe('looksLikeShellStartupGarbage')`。
 */
export function looksLikeShellStartupGarbage(title: string): boolean {
  // 关键判别:整段标题 *以路径前缀起手* 即视为垃圾 —— 不要求剩余部分无
  // 空格,因为 "C:\Program Files\..." 这种合法 Windows 路径含空格。
  // 真实 CLI 工具的标题永远是 verb-leading("vim C:\foo" / "nano /etc/hosts"
  // / "✻ Claude ..."),不会以裸盘符或裸 "/" 起手,所以 ^ 锚就够区分。

  // 1. Windows 盘符路径起手 — "C:\..." / "C:/..." / "D:\Program Files\..."
  if (/^[A-Za-z]:[\\/]/.test(title)) return true;
  // 2. UNC 路径起手 — "\\server\share\..."
  if (/^\\\\/.test(title)) return true;
  // 3. Unix 绝对路径起手 — "/usr/bin/bash"
  if (title.startsWith('/')) return true;
  // 4. Git Bash / MSYS2 默认 PS1 前缀 — 每次 prompt 重复发
  //    "MINGW64:<cwd>" / "MINGW32:..." / "MSYS:..." / "MSYS2:..."
  if (/^(MINGW(32|64|ARM)?|MSYS\d?):/i.test(title)) return true;
  // 5. 裸 exe 文件名(无空格,以 .exe 结尾)— "cmd.exe" / "pwsh.exe"
  //    "Visual Studio Code.exe" 等空格 exe 名作为 *启动期* 标题极其罕见,
  //    放过比误杀稳。
  if (/^\S+\.exe$/i.test(title)) return true;
  return false;
}

/**
 * shell 自我介绍标题的精确匹配名单(ADR-032 第 2 层)。
 *
 * 这是「Windows PowerShell」bug 的直接对手:PowerShell host 初始化完成时
 * 调 SetConsoleTitle("Windows PowerShell")(注意与启动早期的 exe 路径形式
 * 是同一进程的两个阶段 —— 路径形式已被 TIT-1 拦下,这个友好名形式归这里)。
 * 命中 → shell 槽:纯 shell session 照常显示它(与旧版行为一致),但它
 * 永远压不过 program/agent/user 槽 —— pi 的标题从此抢不走。
 *
 * 名单刻意保持**精确 + 短**:误杀面是「某个 CLI 工具的标题恰好等于 shell
 * 名」(几乎不存在),漏杀面是「新 shell 的自报名不在名单里」→ 落 program 槽
 * → 行为退化到旧版 last-writer-wins,不会更糟。用正则匹配版本号变体。
 */
const SHELL_SELF_TITLE_PATTERNS: RegExp[] = [
  // PowerShell 5.1 / 7 的 host 标题("PowerShell 7"、"PowerShell 7.4.6")
  /^(Windows )?PowerShell( \d+(\.\d+)*)?$/,
  // cmd.exe(英文 / 中文系统)
  /^(Command Prompt|命令提示符)$/,
  // cmd 的裸名形式
  /^cmd$/,
];

/**
 * 是否 shell 自报标题(ADR-032 第 2 层)。先剥掉提权前缀再精确匹配:
 * 管理员控制台的标题是 "Administrator: Windows PowerShell" /
 * "管理员: Windows PowerShell"。
 */
export function isShellSelfTitle(cleanedTitle: string): boolean {
  const stripped = cleanedTitle
    .replace(/^(Administrator|管理员):\s*/i, '')
    .trim();
  return SHELL_SELF_TITLE_PATTERNS.some((re) => re.test(stripped));
}

/**
 * ADR-032 分类器:一段(已 sanitize 的)OSC 0/1/2 标题该归哪个槽。
 *
 * @returns 目标槽;null = 丢弃(TIT-1 启动垃圾)。
 */
export function classifyOscTitle(cleanedTitle: string): TitleSourceKind | null {
  if (looksLikeShellStartupGarbage(cleanedTitle)) return null;
  if (isShellSelfTitle(cleanedTitle)) return 'shell';
  return 'program';
}
