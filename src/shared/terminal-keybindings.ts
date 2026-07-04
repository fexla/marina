/**
 * @file src/shared/terminal-keybindings.ts
 * @purpose 终端键盘绑定单一权威表 — spec §7.2.2 的代码侧实现锚。
 *
 *   背景:此前 TerminalView.tsx 内有一段长 attachCustomKeyEventHandler,
 *   6 处早返、4 处 return false、5 个特例 if 嵌套。可读性差,加新键位易
 *   漏改,且 spec / 设置页 / 代码三处无单一来源 → 漂移。
 *
 *   现在 TerminalView 的键盘 handler 退化为"扫表 match → dispatch action",
 *   所有键位、guard、action 集中在本文件。任何 PR 新增 / 改 / 删键位必须
 *   同时改:
 *     1. docs/软件定义书.md §7.2.2 终端键位清单
 *     2. docs/键盘交互规范.md
 *     3. 本文件 TERMINAL_KEYBINDINGS
 *     4. 设置页 SettingsView 快捷键速查卡片(数据源即本文件)
 *
 * @设计原则:
 * - **action 是描述,不是函数**:matchKeybinding 返回数据,dispatch 在
 *   TerminalView 内做 — 便于纯函数单测,无需 mock xterm / DOM
 * - **mod = Ctrl || Cmd 等价**:Windows/Linux 用 Ctrl,macOS 用 Cmd,本表
 *   不区分。如果未来要做 mac-only 键位,加 `platform?: 'mac' | 'other'` 字段
 * - **guard 隔离上下文**:select 状态、搜索栏可见状态等不进 match,由 guard
 *   读取 KeybindingContext 决定。避免 match 函数依赖 DOM
 *
 * @不变式:
 * 1. 任何返回 binding 的 keydown 事件,TerminalView 都必须 return false
 *    (consume,不让 xterm 发字节给 PTY)。例外:`copy-or-sigint` 无选区时
 *    return true(透传 ^C 给 PTY 发 SIGINT)
 * 2. paste 动作的真正执行在 capture-phase 'paste' DOM listener
 *    (PR #3 修法),本表的 paste 类 action 仅负责 consume keyboard event
 * 3. IME composition 期间(isComposing || keyCode===229)调用方不应进入
 *    本表的 match — TerminalView 在第一行已守卫
 */

export type KeybindingAction =
  /** 打开搜索栏 */
  | 'open-search'
  /** 关闭搜索栏(guard:仅搜索栏可见时) */
  | 'close-search'
  /** 有选区→复制+清选区(consume);无选区→透传给 PTY 发 SIGINT */
  | 'copy-or-sigint'
  /** 有选区→复制+清选区(consume);无选区→consume(不发字节) */
  | 'copy-and-clear'
  /**
   * Consume keyboard event,真正粘贴由 capture-phase 'paste' DOM listener
   * 接管。Ctrl+V 不再发 0x16 (Unix literal-next),Ctrl+Shift+V / Shift+Insert
   * 也显式 consume 防止未来 xterm 默认行为变化
   */
  | 'consume-for-paste';

export interface KeybindingMatcher {
  /** Ctrl 或 Cmd(等价处理)是否按下 */
  mod: boolean;
  shift: boolean;
  alt: boolean;
  /** ev.key.toLowerCase() — 字母 / 'insert' / 'escape' / 'f' 等 */
  key: string;
}

export interface KeybindingContext {
  /** 搜索栏当前是否可见(决定 Esc 是否被 close-search 吃) */
  searchVisible: boolean;
}

export interface Keybinding {
  id: string;
  /** 人类可读 spec(给设置页速查卡片显示);Windows / Linux 写法 */
  spec: string;
  /** macOS 等价写法(speech 用);若与 spec 相同可省略 */
  specMac?: string;
  /** 功能简介(给速查卡片显示) */
  description: string;
  match: KeybindingMatcher;
  action: KeybindingAction;
  /** 上下文谓词;返回 false 时此 binding 不匹配 */
  guard?: (ctx: KeybindingContext) => boolean;
}

/**
 * spec §7.2.2 终端键位清单 — 唯一权威。
 *
 * 顺序按"优先级"排:更具体 / 带 guard 的在前,泛匹配在后。
 * matchKeybinding 是线性扫描 + 首个 match 返回。
 */
export const TERMINAL_KEYBINDINGS: readonly Keybinding[] = [
  {
    id: 'open-search',
    spec: 'Ctrl+F',
    specMac: 'Cmd+F',
    description: '打开终端搜索栏',
    match: { mod: true, shift: false, alt: false, key: 'f' },
    action: 'open-search',
  },
  {
    id: 'close-search',
    spec: 'Esc',
    description: '关闭搜索栏(仅搜索栏可见时;其他时刻 Esc 透传给 PTY)',
    match: { mod: false, shift: false, alt: false, key: 'escape' },
    action: 'close-search',
    guard: (c) => c.searchVisible,
  },
  {
    id: 'copy-ctrl-c',
    spec: 'Ctrl+C',
    specMac: 'Cmd+C',
    description: '有选区时复制并清选区;无选区时透传 SIGINT',
    match: { mod: true, shift: false, alt: false, key: 'c' },
    action: 'copy-or-sigint',
  },
  {
    id: 'copy-shift-c',
    spec: 'Ctrl+Shift+C',
    description: '复制(有选区时;无选区时静默 consume)',
    match: { mod: true, shift: true, alt: false, key: 'c' },
    action: 'copy-and-clear',
  },
  {
    id: 'copy-insert',
    spec: 'Ctrl+Insert',
    description: '复制(经典 Windows 兼容键位)',
    match: { mod: true, shift: false, alt: false, key: 'insert' },
    action: 'copy-and-clear',
  },
  {
    id: 'paste-ctrl-v',
    spec: 'Ctrl+V',
    specMac: 'Cmd+V',
    description: '粘贴(真正动作由 capture-phase paste listener 执行)',
    match: { mod: true, shift: false, alt: false, key: 'v' },
    action: 'consume-for-paste',
  },
  {
    id: 'paste-shift-v',
    spec: 'Ctrl+Shift+V',
    description: '粘贴',
    match: { mod: true, shift: true, alt: false, key: 'v' },
    action: 'consume-for-paste',
  },
  {
    id: 'paste-shift-insert',
    spec: 'Shift+Insert',
    description: '粘贴(经典 Windows 兼容键位)',
    match: { mod: false, shift: true, alt: false, key: 'insert' },
    action: 'consume-for-paste',
  },
];

/** matchKeybinding 入参 — 只取 KeyboardEvent 必要字段,方便 mock 测试 */
export interface KeyEventLike {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  key: string;
}

/**
 * 扫表匹配。返回首个 binding 或 null。
 *
 * 调用方必须在调用前自行守卫 IME(isComposing || keyCode===229),本函数
 * 不读这两个字段。
 */
export function matchKeybinding(
  ev: KeyEventLike,
  ctx: KeybindingContext,
): Keybinding | null {
  const mod = ev.ctrlKey || ev.metaKey;
  const shift = ev.shiftKey;
  const alt = ev.altKey;
  const key = ev.key.toLowerCase();
  for (const b of TERMINAL_KEYBINDINGS) {
    if (b.match.mod !== mod) continue;
    if (b.match.shift !== shift) continue;
    if (b.match.alt !== alt) continue;
    if (b.match.key !== key) continue;
    if (b.guard && !b.guard(ctx)) continue;
    return b;
  }
  return null;
}
