/**
 * @file src/main/session-manager.ts
 * @purpose 完整 Session 管理器 — CP-3 接入状态机 (active/idle/exited)、
 *   OSC 1337 cwd 跟踪、启动模板、scrollback ring buffer、cwd 兜底轮询。
 *
 * @关键设计:
 * - sessionId UUID,与 windowId 完全解耦
 * - **path 与 cwd 解耦** (ADR-008):session.pathId 由创建时确定,生命周期内
 *   不变。OSC 1337 报告的 cwd 仅写到 currentCwd 字段,触发 UI ⚠️ 提示,
 *   不再驱动 path 在分类间迁移。
 * - **砍掉 5 分钟墓地** (ADR-008):PTY 退出后 session 进入 'exited' 状态,
 *   scrollback 保留,owner 不变,**无时限自动消失**;只能由用户右键关闭
 *   或应用退出销毁。重启功能不再提供。
 * - PTY 字节流仅推送给 owner;新 owner 通过 cmd:session:get-scrollback 拉
 *   历史,渲染端用 lastSeq 去重 evt:session:output
 * - **OSC 1337 解析器**每个 session 一份,从字节流剥离序列后再转发
 *   xterm,避免 OSC 在终端里渲染成乱码
 * - **active / idle 计时**:每次有 passthrough 字节 → state=active + 重置
 *   idle 计时器;计时器到 → state=idle (默认 2s 阈值,可配)
 * - **cwd 兜底**:启动后 5 秒未收到 OSC 1337 → 启动 5 秒间隔的进程查询
 *   (PlatformAdapter.getProcessCwd);收到第一条 OSC 后立即关掉所有 cwd
 *   timer,永不再启
 * - 启动模板:从 TemplatesManager 拉,空 command → 纯 shell;有 command →
 *   通过 PlatformAdapter.buildShellLaunchParams 让 hook 之后再 exec command
 * - spawn 函数可注入 (PtySpawnFn) 便于测试;PlatformAdapter 也可注入
 *   (默认从 getPlatformAdapter() 拿)
 *
 * @对应文档章节:
 *   软件定义书.md 5.1.2、5.1.3、5.1.8、8.3、ADR-003、ADR-008
 *   ipc-protocol.md 5.2、6.2
 *   AGENTS.md CP-3 完成标志
 *
 * @AGENTS.md 5.3 必测:
 * - SessionManager 创建/销毁/状态查询/owner 切换/状态机所有转移
 * - OSC 1337 解析器 (osc1337-parser.ts 单测)
 * - active/idle 计时
 * - exited 状态语义 (无自动销毁)
 */
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, resolve as resolvePath } from 'node:path';
import { spawn as defaultSpawnPty, type IPty, type IDisposable } from 'node-pty';
import type {
  SessionExitedPayload,
  SessionOutputPayload,
  SessionStateChangedPayload,
} from '@shared/protocol';
import type { SessionInfo, Template, Settings } from '@shared/types';
import type { WindowManager } from './window-manager';
import type { PathManager } from './path-manager';
import type { TemplatesManager } from './templates-manager';
import type { SettingsManager } from './settings-manager';
import type { AIClient } from './ai-client';
// @xterm/headless 是纯 CommonJS(无 ESM exports 字段),Electron 主进程
// ESM loader 不接受 named import — 必须 default import 拿整个 module 再
// 解构。类型用 `InstanceType<typeof HeadlessTerminal>` 推,避免重复声明。
import xtermHeadless from '@xterm/headless';
const { Terminal: HeadlessTerminal } = xtermHeadless;
type HeadlessTerminal = InstanceType<typeof HeadlessTerminal>;
// CURSOR-1 根治(state-replay):headless terminal 装 SerializeAddon,
// getScrollback 不再返回裸字节流,改为序列化"当前完整终端状态"的 ANSI
// 重建流。详见 docs/issues/cursor-1-alt-buffer-blink-policy-broke-codex.md
// 续档"架构级根治方案"。
// 0.14.0 stable _serializeModes 不覆盖 ?25l 与 DECSTBM,本文件下面 getScrollback
// 内手动补两条 — 详见 docs/issues/xterm-serialize-mode-polyfill.md。
import xtermSerialize from '@xterm/addon-serialize';
const { SerializeAddon } = xtermSerialize;
type SerializeAddon = InstanceType<typeof SerializeAddon>;
import { Osc1337Parser } from './osc1337-parser';
import { pathRefFromId } from './path-manager';
import { getPlatformAdapter, type PlatformAdapter, type ShellInfo } from './platform';
import { buildSpawnEnv, injectTerminalHintEnv, validateDimensions } from './pty-utils';
import { logger } from './logger';

const SPAWN_ENV_SKIP = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL'];

/**
 * cwd 兜底参数:
 * - GRACE_MS:启动后多少毫秒未收到 OSC 才启动轮询
 * - POLL_INTERVAL_MS:轮询周期
 * 与 ADR-003 一致。
 */
const CWD_GRACE_MS = 5000;
const CWD_POLL_INTERVAL_MS = 5000;

/**
 * Resize quiet 窗口 (CP-3 勘误 #3 v2)。
 *
 * 解决:用户在另一窗口持有的 idle session tab 上点击 → 主进程改 owner → 渲染
 * 端 mount TerminalView → xterm fit → cmd:session:resize → Windows ConPTY
 * 收到 resize 把屏幕 buffer 按新尺寸重新排版,**整屏字节流再发一遍**(已知问题
 * docs/known-issues.md KI-001 同一机制,这里关心的是状态副作用而非视觉副作用)
 * → handlePtyData 误触 markActive → tab 闪一下绿色再回黄色。
 *
 * 修复:resize 后的 RESIZE_QUIET_MS 内 PTY 出来的字节认为是 ConPTY/SIGWINCH
 * 重绘的回声,**不触发 markActive**(但仍然写 scrollback、仍然 emit
 * sessionOutput,xterm 视觉上要正常看到重绘内容)。
 *
 * 500ms 是足够 ConPTY 完成重排 + child SIGWINCH 重绘的"安静期"。
 */
const RESIZE_QUIET_MS = 500;

/**
 * PER-2 / F1:sessionOutput IPC 聚合窗口 (ms)。
 * 8ms 在 125 FPS 频率 — 视觉上无延迟,但能把 burst 输出场景下每秒数百次
 * IPC 压成 ~30-60 次,降低 renderer base64 解码 + xterm parse CPU 占用。
 */
const EMIT_BATCH_MS = 8;

/**
 * 启动期 grace 窗口 (M1-I,P1-4)。
 *
 * 解决:PowerShell 启动横幅 + prompt 出现时 PTY 短暂喷字节,markActive 立即
 * 触发 — 然后没新字节 → 1.5s 后变 idle → 用户看到"刚开就闪了一下"。
 *
 * 修复:session 创建后 STARTUP_GRACE_MS 内 PTY 字节虽然进 scrollback / 触发
 * 给 owner 推 sessionOutput,但**不触发 markActive 的状态广播**(idle timer
 * 在 createSession 末尾已起好,grace 内不重置该 timer)。这样 banner 期视觉上
 * 直接稳定在 active(初始即 active),grace 结束后正常切 idle。
 */
const STARTUP_GRACE_MS = 1500;

/**
 * BETA-006 v2.2:按键事件 ring buffer 上限 + 保留窗口。
 *
 * 用于 recheckIdle 元数据(scrollback 末"prompt> some text"两种情况完全
 * 同形,光看 tail 区分不开"用户在敲字"vs"命令在跑")。20 条 × 30s 窗口够
 * LLM 看到最近的输入节奏(节奏一致 = 正在打字,完全静止 = 等输出)。
 *
 * **隐私**:这里只记**时间戳 + 按键类别**(char / enter / backspace / other),
 * 永远不记按键内容(密码 / token / 命令体)。详见 classifyInput。
 */
const RECENT_KEYS_CAP = 20;
const RECENT_KEYS_TTL_MS = 30_000;

/**
 * BETA-006 v2.2:按键类别。**绝不记内容,只记类别**(隐私保护)。
 *
 * - char: 可打印字符(单个 ASCII 字母 / 数字 / 标点 / 单个 CJK 字符 UTF-8)
 * - enter: \r 或 \n(提交)
 * - backspace: \b 或 \x7f(删除)
 * - other: 控制字符 / 方向键 / 粘贴块 / 其它(对 active/idle 判断信号弱)
 */
type KeyKind = 'char' | 'enter' | 'backspace' | 'other';

interface KeyEvent {
  /** Date.now() */
  ts: number;
  kind: KeyKind;
}

/**
 * BETA-006 v2.2:按键类别识别。**不解析内容,只看头几个字节模式**。
 *
 * 输入 `text` 是 sendInput 一次写入 PTY 的字节流(xterm onData 通常一次一个
 * 逻辑按键;粘贴可能一次几百字符)。识别规则保守 — 拿不准就归 `other`。
 */
function classifyInput(text: string): KeyKind {
  if (text === '\r' || text === '\n' || text === '\r\n') return 'enter';
  if (text === '\x7f' || text === '\b') return 'backspace';
  // ESC 起头 = CSI / SS3 / OSC 等控制序列(方向键、F 键、bracketed paste 标记等)
  if (text.startsWith('\x1b')) return 'other';
  if (text.length === 1) {
    const code = text.charCodeAt(0);
    // 单字节控制字符 (Ctrl+letter 等) 归 other
    if (code < 0x20 || code === 0x7f) return 'other';
    return 'char';
  }
  // 多字节但短(≤4 字节)— 很可能是单个 CJK 字符的 UTF-8 编码
  if (text.length <= 4) return 'char';
  // 再长就当粘贴块/其它 — 不暴露具体长度也是隐私考虑
  return 'other';
}

/**
 * Input echo quiet 窗口(抖动源 C/E)。
 *
 * 解决:用户在终端里敲键 → cooked mode shell echo 字节回来(或 raw mode TUI
 * 触发整屏重绘)→ handlePtyData 收到字节 → markActive → idle 状态点闪绿。
 * 用户视角:**我只是在敲键,不是程序在跑**,这个闪绿是噪音。
 *
 * 修复:sendInput 调用时把 inputQuietUntil = now + INPUT_QUIET_MS。窗口内
 * PTY 出来的字节认为是按键自己的回声 / 重绘,**不触发 markActive**(但仍
 * 写 scrollback、仍 emit sessionOutput,xterm 视觉上要正常看到回显)。
 *
 * 200ms 的来源:本机 echo 通常几毫秒到几十毫秒;200ms 给 ConPTY + raw mode
 * TUI 重绘留足余量,又短到不会把"按 Enter 后立即开始的真实输出"全吞掉。
 *
 * 连续敲键时每次都顺延窗口 → 整段打字过程都不变绿:这是想要的语义,
 * 因为打字阶段终端语义上是 prompt/idle 而非 active。命令真的开始跑、且
 * 超过 200ms 还在输出 → markActive 正常触发。50ms 跑完的"快命令"
 * (如 `ls`)全程在窗口内 → 状态不闪 → 可接受,精确的命令边界
 * 等 OSC 133 接入后才有解。
 */
const INPUT_QUIET_MS = 200;

/**
 * spawn 工厂,与 node-pty 的 spawn 兼容。测试中用 mock 替换。
 */
export type PtySpawnFn = (
  file: string,
  args: string[] | string,
  options: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string>;
    /** 强制走 ConPTY (Win10 1809+ 默认 true,显式开避免 winpty fallback 闪窗) */
    useConpty?: boolean;
  },
) => IPty;

/**
 * 由 shell 可执行路径推断 session 的默认 displayName。
 *
 * 用 basename + 小写比对常见 shell。命中 → 返回规范化大小写的 shell 名;
 * 未命中 → 返回去 .exe 后的 basename (用户自定义 shell 时也有合理回退)。
 */
export function inferDisplayName(shellPath: string): string {
  const base = basename(shellPath).toLowerCase();
  const stem = base.replace(/\.[^.]+$/, '');
  switch (stem) {
    case 'powershell':
    case 'pwsh':
      return 'PowerShell';
    case 'bash':
      return 'Bash';
    case 'cmd':
      return 'cmd';
    case 'zsh':
      return 'Zsh';
    case 'fish':
      return 'fish';
    case 'sh':
      return 'sh';
    default:
      return stem || 'Shell';
  }
}

/**
 * 解析 shell hook 文件路径。
 *
 * **dev 模式**:hook 在源码 src/shell-hooks/,__dirname 指向 .ts 真实位置。
 * **packed 模式**:hook 通过 electron-builder.yml 的 `extraResources` 拷到
 *   `<install>\resources\shell-hooks\` (`process.resourcesPath/shell-hooks`)。
 *   asar 内的 src/shell-hooks 不可达 — pwsh.exe / bash.exe 是外部进程,
 *   读不到 asar 虚拟 FS。
 *
 * 决策依据:`app.isPackaged` 在 Electron 31 可靠区分两种模式。
 */
export function defaultHookFileResolver(shellId: string): string {
  let hookDir: string;
  // 静态判定:若 process.resourcesPath 存在 + __dirname 含 'app.asar' → packed。
  // 直接读 app.isPackaged 会引入对 electron 的硬依赖,不利于 SessionManager
  // 单测;用文件系统线索就够。
  const isPacked = __dirname.includes('app.asar');
  if (isPacked && process.resourcesPath) {
    hookDir = resolvePath(process.resourcesPath, 'shell-hooks');
  } else {
    // dev 模式 / 单测:src/main/ → 项目根 → src/shell-hooks/
    hookDir = resolvePath(__dirname, '..', '..', 'src', 'shell-hooks');
  }
  switch (shellId) {
    case 'pwsh':
    case 'powershell':
      return resolvePath(hookDir, 'pwsh.ps1');
    case 'cmd':
      return resolvePath(hookDir, 'cmd.bat');
    case 'git-bash':
    case 'bash':
      // Linux native bash 与 Git Bash 走同一份 bash hook (cygpath 探测做了
      // POSIX / Windows 两套路径处理,POSIX 环境直接走 $PWD 分支)。
      return resolvePath(hookDir, 'bash.sh');
    // BETA-003a:zsh / fish 占位 — 直接给到源文件,SessionManager 当前还没
    // 给 zsh 拷成 .zshrc / 给 fish 拷成 fish/config.fish,所以 zsh hook 实际
    // 不会被 zsh 加载(ZDOTDIR=<dir>/.zshrc 找不到 → 跳过),session 仍能跑但
    // cwd 跟踪暂时丧失。后续 patch 补"临时副本铺设"流程。
    case 'zsh':
      return resolvePath(hookDir, 'zsh.sh');
    case 'fish':
      return resolvePath(hookDir, 'fish.fish');
    default:
      return resolvePath(hookDir, 'pwsh.ps1');
  }
}

interface ManagedSession {
  info: SessionInfo;
  /** PTY 实例,exited 状态下置为 null */
  pty: IPty | null;
  /** evt:session:output 单调序号,从 0 开始,每次 emit 后 ++ */
  outputSeq: number;
  /** PTY 监听句柄,destroy 时释放 */
  disposables: IDisposable[];
  /**
   * 已经向 renderer emit 过的最后一条 PTY data 的 outputSeq。-1 表示尚未
   * 有输出。renderer 重挂时拿这个 seq 去重 live 通道的 pending 字节(只
   * write seq > lastSeq 的 chunk,避免与 state-replay 输出双写)。
   *
   * CURSOR-1 前:同时也是 `managed.scrollback` 裸字节 ring 的"已 emit"边界
   * (PER-2 不变量)。CURSOR-1 后裸字节 ring 已删除,边界只保留 seq 语义。
   */
  scrollbackLastSeq: number;
  /** OSC 1337 解析器 (每 session 一份,持有未完结 stash) */
  parser: Osc1337Parser;
  /** active → idle 转移计时器 */
  idleTimer: NodeJS.Timeout | null;
  /** 启动后等 OSC 1337 的宽限计时器;到点未收到则启动 cwd 轮询 */
  cwdGraceTimer: NodeJS.Timeout | null;
  /** cwd 兜底轮询计时器 */
  cwdPollTimer: NodeJS.Timeout | null;
  /** 是否已收到过任意 OSC 1337。一旦 true,所有 cwd 兜底永久关闭 */
  oscReceived: boolean;
  /**
   * Resize quiet 窗口截止时间戳 (ms epoch)。
   * 详见 RESIZE_QUIET_MS 注释 (CP-3 勘误 #3 v2)。
   * 0 = 无窗口 (从未 resize)。
   */
  resizeQuietUntil: number;
  /** M1-I:启动期 grace 截止 ts (createSession 时 = now + STARTUP_GRACE_MS) */
  startupGraceUntil: number;
  /**
   * Input echo quiet 窗口截止 ts。sendInput 时 = now + INPUT_QUIET_MS;
   * handlePtyData 在该窗口内不触发 markActive(详见 INPUT_QUIET_MS 注释)。
   * 0 = 无窗口 (从未 sendInput)。
   */
  inputQuietUntil: number;
  /**
   * BETA-006 v2.1:用户上次按 Enter (\r 或 \n) 的时刻 (ms epoch)。
   * 0 = 从未按过。recheckIdle 把"距上次 Enter 多久"作为元数据喂给 LLM,
   * 帮它区分"长命令在跑(Enter 刚按过)"与"用户在打字但没提交(Enter 老
   * 没按过)"— scrollback 末尾两种情况文本相同,LLM 单看 tail 无法区分。
   */
  lastEnterAt: number;
  /**
   * BETA-006 v2.1:用户上次任何按键 sendInput 的时刻 (ms epoch)。
   * 0 = 从未输入。配合 lastEnterAt 让 LLM 判断"敲了字但没回车"的边界:
   * lastInputAt 近 + lastEnterAt 远 → 用户在打字 → idle。
   */
  lastInputAt: number;
  /**
   * BETA-006 v2.2:最近按键事件 ring buffer(时间戳 + 类别,**不存内容**)。
   * 上限 RECENT_KEYS_CAP 条 + RECENT_KEYS_TTL_MS 窗口,sendInput 时维护。
   * 让 LLM 看到"用户最近敲键的节奏":连续 char 流 = 在打字,只有一个 enter
   * 后归零 = 命令在跑,no events = 完全闲置。详见 classifyInput 注释。
   */
  recentKeys: KeyEvent[];
  /**
   * 用户是否已手动改过 displayName。一旦为 true,后续 OSC 0/1/2 标题事件
   * 不再覆盖 displayName — 手动改名优先级永久高于 shell 标题(Claude Code、
   * Windows Terminal hostname 等会持续刷标题,不锁住会冲掉用户的命名)。
   */
  manuallyRenamed: boolean;
  /**
   * PER-2 / F1:IPC 聚合缓冲 — 8ms 窗口内积累的 sessionOutput,timer 到点
   * 一次性 emit。降低高速 PTY 输出场景下 IPC 消息数,缓解 renderer 反压。
   *
   * 每条 emit 都带它代表的 seq 范围(开始 / 结束),但由于我们用"合并后
   * 单条 payload",renderer 只看到一个 seq(最后一条字节对应的)。
   * scrollback append 仍同步,scrollbackLastSeq 仍准。
   */
  pendingEmit: { bytes: Buffer; lastSeq: number } | null;
  pendingEmitTimer: NodeJS.Timeout | null;
  /**
   * BETA-006 v2:headless terminal 镜像。每个 session 跟着 PTY passthrough
   * 字节同步 write,buffer 维护"已渲染"字符矩阵 — 复核时读这里拿干净文本,
   * 跳过 ANSI 转义和 PSReadLine 重绘残影,LLM 看到的与用户视觉一致。
   *
   * CURSOR-1 根治后(state-replay):headlessTerm 同时承担"重挂时状态恢复"
   * 的权威数据源 — getScrollback 通过下面 serializeAddon.serialize() 从这里
   * 吐 ANSI 重建流,而不再用裸字节 ring buffer。
   *
   * null = 该 session 没有 headless 镜像(理论上 createSession 总会建,
   * 留 null 是为了 destroy 后访问安全)。
   */
  headlessTerm: HeadlessTerminal | null;
  /**
   * CURSOR-1 根治:绑在 headlessTerm 上的 SerializeAddon,getScrollback 调
   * serializeAddon.serialize() 拿到能完全重建当前终端状态的 ANSI 字节流
   * (含 alt-buffer / cursor 位置 / SGR / 大部分 DEC 模式)。
   *
   * null 同 headlessTerm 一同语义(destroy 后访问安全)。
   */
  serializeAddon: SerializeAddon | null;
}

export interface CreateSessionInput {
  pathId: string; // 已 normalize 的绝对路径
  templateId: string;
  ownerWindowId: string;
  cols: number;
  rows: number;
  sshProfile?: {
    id: string;
    name: string;
    host: string;
    port: number;
    username: string;
    authType: 'agent' | 'keyFile' | 'password';
    keyFilePath?: string;
    /** 明文密码;ipc 层用 safeStorage 解密后传入,会注入 sshpass 自动登录 */
    password?: string;
    /** SSH 方案 §阶段 2.3:多级跳板,buildSshLaunchParams 转为 -J host1,host2 */
    proxyJump?: string[];
    tmuxMode?: 'disabled' | 'attach-or-create';
    tmuxSessionName?: string;
    tmuxSessionPolicy?: 'reuse' | 'new-per-launch';
    tmuxOnMissing?: 'fallback-shell' | 'fail';
  };
  /**
   * 勘误第二轮 #3:可选 shell id 覆盖。给定时跳过 pickShell 的 settings 兜底,
   * 直接用此 id 命中 detectShells 列表里的 shell。EmptyPathState 的"检测到的
   * Shell"按钮通过此字段让用户对单 session 指定 shell。
   * 命中失败 (id 不存在) 时回退到 pickShell 默认逻辑。
   */
  shellIdOverride?: string;
}

export class SessionManagerError extends Error {
  constructor(
    public readonly code:
      | 'PathNotFound'
      | 'TemplateNotFound'
      | 'SessionNotFound'
      | 'SessionAlreadyOwned'
      | 'NotOwner'
      | 'PtySpawnFailed'
      | 'CwdNotAccessible'
      | 'NoShellAvailable',
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(`[SessionManager] ${code}: ${message}`);
    this.name = 'SessionManagerError';
  }
}

/**
 * 可选的注入项,主要给测试用。生产代码不传则用默认实现。
 */
export interface SessionManagerOptions {
  spawnFn?: PtySpawnFn;
  platformAdapter?: PlatformAdapter;
  hookFileResolver?: (shellId: string) => string;
  /**
   * Resize 后的 quiet 窗口时长 (ms)。生产 500;测试可传 0 跳过窗口逻辑。
   * 详见 RESIZE_QUIET_MS 注释。
   */
  resizeQuietMs?: number;
  /**
   * M1-I:启动期 grace 时长 (ms)。生产 1500;测试可传 0 跳过 grace,
   * 让 createSession 之后第一波字节立即走 markActive。详见 STARTUP_GRACE_MS。
   */
  startupGraceMs?: number;
  /**
   * Input echo quiet 时长 (ms)。生产 200;测试可传 0 跳过窗口逻辑。
   * 详见 INPUT_QUIET_MS。
   */
  inputQuietMs?: number;
  /**
   * prelease 前勘误 #18:createSession 前对 cwd 做 fs.existsSync + isDirectory
   * 校验,在非常态路径(被删/编码异常)上提前抛 CwdNotAccessible,避免 ConPTY
   * 直接报 "error code: 267"。
   * 单测里大量用伪路径 'C:\\proj\\a',文件系统层不存在;测试场景下传 false 跳过。
   * 生产代码不显式传,默认 true。
   */
  skipCwdValidation?: boolean;
  /**
   * PER-2 / F1:sessionOutput IPC 聚合窗口 (ms)。生产 8;测试传 0 → 每个
   * PTY chunk 立即 emit (保持现有断言的时序假设)。
   */
  emitBatchMs?: number;
  /**
   * 写到子 shell `TERM_PROGRAM_VERSION` 的版本号。生产从 `app.getVersion()`
   * 注入;测试默认不传,injectTerminalHintEnv 会主动 delete 继承的旧值
   * (避免 CI 上从 VS Code 终端继承到的 vscode 版本号污染断言)。
   */
  appVersion?: string;
}

export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, ManagedSession>();

  private readonly spawnFn: PtySpawnFn;
  private readonly platformAdapter: PlatformAdapter;
  private readonly hookFileResolver: (shellId: string) => string;
  private readonly resizeQuietMs: number;
  private readonly startupGraceMs: number;
  private readonly inputQuietMs: number;
  private readonly skipCwdValidation: boolean;
  private readonly emitBatchMs: number;
  private readonly appVersion: string;
  /**
   * 最近一次 createSession 的非阻塞警告(例如保存了密码但缺 sshpass)。
   * ipc 层在 createSession resolve 后立即读取并清空,传给 renderer 弹 toast。
   */
  lastLaunchWarning: string | null = null;

  /**
   * 缓存 detectShells 结果。首次 createSession 时填充,后续复用。
   *
   * PER-4:加 30s TTL — 用户装 / 卸载 PowerShell 7、改 PATH 后不必重启
   * Marina 也能在 EmptyPathState 的"检测到的 Shell"刷出新结果。30s 既给
   * 用户主动重新检测的及时性,又把热路径 createSession 的 detectShells
   * 调用数压到很低。
   */
  private cachedShells: ShellInfo[] | null = null;
  private cachedShellsAt = 0;
  private static readonly SHELL_CACHE_TTL_MS = 30_000;

  constructor(
    private readonly _windowManager: WindowManager,
    private readonly pathManager: PathManager,
    private readonly templatesManager: TemplatesManager,
    private readonly settingsManager: SettingsManager,
    options: SessionManagerOptions = {},
  ) {
    super();
    void this._windowManager; // 抑制 noUnusedLocals
    this.spawnFn = options.spawnFn ?? defaultSpawnPty;
    // 测试或 macOS 不走 getPlatformAdapter (macOS 仍 throw)。
    // BETA-003a:Windows / Linux 都有真实 adapter,各自 detectShells / buildShellLaunchParams。
    this.platformAdapter =
      options.platformAdapter ??
      (process.platform === 'darwin' ? createNoopAdapter() : getPlatformAdapter());
    this.hookFileResolver = options.hookFileResolver ?? defaultHookFileResolver;
    this.resizeQuietMs = options.resizeQuietMs ?? RESIZE_QUIET_MS;
    this.startupGraceMs = options.startupGraceMs ?? STARTUP_GRACE_MS;
    this.inputQuietMs = options.inputQuietMs ?? INPUT_QUIET_MS;
    this.skipCwdValidation = options.skipCwdValidation ?? false;
    // 测试缺省传 0(立即 emit,保持时序断言)
    this.emitBatchMs = options.emitBatchMs ?? EMIT_BATCH_MS;
    this.appVersion = options.appVersion ?? '';
  }

  // ──────────────────────────────────────────────────────────────────
  // 生命周期
  // ──────────────────────────────────────────────────────────────────

  /**
   * 创建一个 session 并启动 PTY。
   *
   * @throws SessionManagerError NoShellAvailable / TemplateNotFound /
   *   PtySpawnFailed / CwdNotAccessible
   */
  async createSession(input: CreateSessionInput): Promise<SessionInfo> {
    this.lastLaunchWarning = null;
    const template = this.templatesManager.resolve(input.templateId);
    const dims = validateDimensions(input.cols, input.rows);
    const shells = await this.getShells();
    if (shells.length === 0) {
      throw new SessionManagerError(
        'NoShellAvailable',
        '系统中未检测到任何 shell (pwsh / powershell / cmd / bash)。' +
          '请确保至少一个 shell 在 %ProgramFiles% 或 %SystemRoot%\\System32 下。',
      );
    }
    const shell = pickShell(shells, this.settingsManager.get(), input.shellIdOverride);
    const pathRef = pathRefFromId(input.pathId || homedir());
    const isSsh = pathRef.kind === 'ssh';
    if (isSsh && !input.sshProfile) {
      throw new SessionManagerError(
        'PathNotFound',
        `SSH 路径缺少 profile: pathId="${input.pathId}"`,
      );
    }
    const cwd = isSsh ? homedir() : pathRef.path || homedir();
    const sessionPathId = isSsh ? input.pathId : cwd;
    const displayShell = isSsh
      ? ({
          ...shell,
          displayName: 'SSH',
          executablePath: 'ssh',
        } satisfies ShellInfo)
      : shell;

    // cwd 预校验:不存在 / 不是目录 → 直接抛 CwdNotAccessible,带友好消息。
    // 否则交给 node-pty,ConPTY 在 CreateProcess 时会因 lpCurrentDirectory 失败
    // 抛 ERROR_DIRECTORY (267),用户看到的是"Cannot create process, error code: 267",
    // 完全看不出问题在 cwd。此外 Explorer 集成场景下用户可能把右键时存在的
    // 文件夹在 Marina 处理过程中删了,这里给出明确兜底。
    // 单测用伪路径,通过 options.skipCwdValidation=true 跳过此检查。
    if (!isSsh && !this.skipCwdValidation) {
      try {
        if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
          throw new SessionManagerError(
            'CwdNotAccessible',
            `工作目录 "${cwd}" 不存在或不是目录。可能它被删除 / 改名,或路径里含 Marina 无法访问的字符。`,
            { cwd },
          );
        }
      } catch (err) {
        if (err instanceof SessionManagerError) throw err;
        throw new SessionManagerError(
          'CwdNotAccessible',
          `读取工作目录 "${cwd}" 失败:${err instanceof Error ? err.message : String(err)}`,
          { cwd },
        );
      }
    }

    const hookFile = this.hookFileResolver(shell.id);
    const existingSshSessionsForPath = isSsh
      ? this.list().filter((s) => s.pathId === input.pathId && s.state !== 'exited').length
      : 0;
    const sshLaunchOptions: {
      forceTmuxChoice?: boolean;
      commandToRun?: { command: string; args: string[]; env?: Record<string, string> };
      enableControlMaster?: boolean;
      controlPath?: string;
    } = { forceTmuxChoice: existingSshSessionsForPath > 0 };
    if (template.command) {
      sshLaunchOptions.commandToRun = {
        command: template.command,
        args: template.args,
        env: template.env,
      };
    }
    // SSH 方案 §阶段 3.5:ControlMaster 由 settings.advanced.enableControlMaster
    // 控制。socket 放在 userData/ssh-control/ 下,文件名包含 %r %h %p 占位符,
    // OpenSSH 自动替换为 user / host / port。Windows OpenSSH 走 named pipe
    // (\\.\pipe\openssh-ssh-*) 不读 ControlPath,我们传它它会忽略 — 还是开
    // 收益:Linux/macOS / Cygwin OpenSSH 都吃这个路径。
    if (isSsh) {
      const settings = this.settingsManager.get();
      if (settings.advanced.enableControlMaster) {
        sshLaunchOptions.enableControlMaster = true;
        sshLaunchOptions.controlPath = this.platformAdapter.getSshControlPath
          ? this.platformAdapter.getSshControlPath()
          : '~/.ssh/cm-%r@%h:%p';
      }
    }
    const launchParams = isSsh
      ? buildSshLaunchParams(input.sshProfile!, pathRef.path, sshLaunchOptions)
      : this.platformAdapter.buildShellLaunchParams(
          shell,
          hookFile,
          template.command
            ? { command: template.command, args: template.args }
            : undefined,
        );

    const env = buildSpawnEnv(process.env, SPAWN_ENV_SKIP);
    // BETA-001:Windows 上 process.env.PATH 是启动时的快照,装新软件后不会自动
    // 刷新。每次 spawn 前从注册表合并最新 PATH 覆写过去,确保新装的 python.exe /
    // node.exe 立刻可用。失败回退 process.env.PATH(已在 env 里),不阻塞 spawn。
    const refreshedPath = this.platformAdapter.getRefreshedPath();
    if (refreshedPath) {
      env.PATH = refreshedPath;
      // Windows 部分组件读 Path(不是 PATH),冗余赋值一份保持兼容
      env.Path = refreshedPath;
    }
    // 终端宿主提示:TERM / COLORTERM / TERM_PROGRAM / TERM_PROGRAM_VERSION。
    // 必须在合并 launchParams.env / template.env 之前,这样用户在启动模板里
    // 显式写 `TERM=dumb` 仍能覆盖我们的默认值。详见 pty-utils.injectTerminalHintEnv。
    injectTerminalHintEnv(env, {
      programName: 'Marina',
      appVersion: this.appVersion,
    });
    Object.assign(env, launchParams.env);
    Object.assign(env, template.env);
    // BETA-ENV-1:Windows 上必做的最后一道防御 —— 补齐 canonical SystemRoot
    // 三种 casing,并展开 PATH-like 字段里残留的 %SystemRoot% / %windir% 等
    // 占位符。任一缺失都会让子进程的 system32 系命令(powershell / cmd /
    // reg / wmic / ssh 等)从 PATH 上消失。Linux / macOS 走 no-op。
    this.platformAdapter.normalizeSpawnEnv(env);

    let spawnFile: string;
    if (isSsh) {
      const resolvedSsh = this.platformAdapter.resolveExecutable('ssh', env);
      if (!resolvedSsh) {
        throw new SessionManagerError(
          'PtySpawnFailed',
          `无法定位本机 ssh.exe,无法连接 SSH profile "${input.sshProfile!.name}" cwd="${cwd}". ` +
            `可能原因: (1) Windows OpenSSH Client 未安装; ` +
            `(2) PATH 缺少 %SystemRoot%\\System32\\OpenSSH; ` +
            `(3) Marina 继承的环境变量损坏。请在 Windows 设置 → 可选功能中安装 OpenSSH Client,` +
            `或确认 C:\\Windows\\System32\\OpenSSH\\ssh.exe 存在。`,
          { executable: 'ssh', cwd, sshProfileId: input.sshProfile!.id },
        );
      }
      spawnFile = resolvedSsh;
      // 保存了密码且 sshpass 在 PATH 上 → 用 sshpass -e 包一层,把
      // SSHPASS 环境变量喂给 ssh,实现无交互登录。sshpass 不可用时静默
      // 回退到原始 ssh,密码框仍会出现,用户体验只是退化不破坏。
      const sshPassword = input.sshProfile!.password;
      if (
        input.sshProfile!.authType === 'password' &&
        typeof sshPassword === 'string' &&
        sshPassword.length > 0
      ) {
        const resolvedSshPass = this.platformAdapter.resolveExecutable('sshpass', env);
        if (resolvedSshPass) {
          env.SSHPASS = sshPassword;
          launchParams.args = ['-e', spawnFile, ...launchParams.args];
          spawnFile = resolvedSshPass;
        } else {
          this.lastLaunchWarning =
            'SshpassMissing: 已保存 SSH 密码,但未在 PATH 上找到 sshpass。' +
            '本次连接 ssh 仍会交互式提示密码。' +
            'Windows: winget install xhcoding.sshpass-win32;' +
            'Debian/Ubuntu: apt install sshpass;macOS: brew install sshpass。';
        }
      }
    } else {
      spawnFile = shell.executablePath;
    }

    let pty: IPty;
    try {
      pty = this.spawnFn(spawnFile, launchParams.args, {
        // 和 injectTerminalHintEnv 写到 env.TERM 的值保持一致 —— node-pty 的
        // `name` 主要影响内部 winpty 路径,但环境变量 TERM 才是子进程实际看到
        // 的值。两边对齐避免观察日志时困惑。
        name: 'xterm-256color',
        cols: dims.cols,
        rows: dims.rows,
        cwd,
        env,
        // 强制 ConPTY:Win 10 1809+ 默认就是它,但显式开避免某些环境
        // 下 node-pty fallback 到 winpty(winpty 会闪 conhost 窗口,
        // 用户报告 "新建 shell 时有一闪而过的新建窗口")。
        useConpty: true,
      });
    } catch (err) {
      throw new SessionManagerError(
        'PtySpawnFailed',
        `无法启动 "${spawnFile}" cwd="${cwd}". ` +
          `可能原因: ${isSsh ? '(1) ssh.exe 不存在或不可执行' : '(1) shell 不在 PATH'}; ` +
          `(2) cwd 不可访问; ` +
          `(3) node-pty 原生模块未为当前 Electron 重编译。原始错误: ${
            err instanceof Error ? err.message : String(err)
          }`,
        { shellPath: spawnFile, cwd },
      );
    }

    const sessionId = randomUUID();
    const info: SessionInfo = {
      id: sessionId,
      pathId: sessionPathId,
      templateId: template.id,
      originalCwd: isSsh ? pathRef.path : cwd,
      currentCwd: isSsh ? pathRef.path : cwd,
      cols: dims.cols,
      rows: dims.rows,
      pid: pty.pid,
      displayName: isSsh
        ? `${input.sshProfile!.name}:${pathRef.path}`
        : pickDisplayName(template, displayShell),
      ownerWindowId: input.ownerWindowId || null,
      state: 'idle',
      createdAt: Date.now(),
    };

    const disposables: IDisposable[] = [];
    const managed: ManagedSession = {
      info,
      pty,
      outputSeq: 0,
      disposables,
      scrollbackLastSeq: -1,
      parser: new Osc1337Parser(),
      idleTimer: null,
      cwdGraceTimer: null,
      cwdPollTimer: null,
      oscReceived: false,
      resizeQuietUntil: 0,
      startupGraceUntil: Date.now() + this.startupGraceMs,
      inputQuietUntil: 0,
      lastEnterAt: 0,
      lastInputAt: 0,
      recentKeys: [],
      manuallyRenamed: false,
      pendingEmit: null,
      pendingEmitTimer: null,
      // BETA-006 v2 + CURSOR-1:headless 镜像,scrollback 行数对齐 renderer
      // 端 xterm 的 5000(`TerminalView.tsx` Terminal 构造 scrollback: 5000)
      // —— headless serialize 出来的状态要能完整覆盖 renderer 可见 + 滚动区。
      // allowProposedApi:translateBufferLineToString 是 proposed api,xterm 5.x
      // 长期稳定,proposed 只是流程慢。
      headlessTerm: new HeadlessTerminal({
        cols: info.cols,
        rows: info.rows,
        scrollback: 5000,
        allowProposedApi: true,
      }),
      serializeAddon: null,
    };
    // CURSOR-1:绑 SerializeAddon。loadAddon 必须在 headless 实例创建后,
    // 字段挂回 managed.serializeAddon 供 getScrollback 调用。
    const serializeAddon = new SerializeAddon();
    managed.headlessTerm!.loadAddon(serializeAddon);
    managed.serializeAddon = serializeAddon;
    this.sessions.set(sessionId, managed);

    disposables.push(
      pty.onData((data) => this.handlePtyData(managed, data)),
      pty.onExit(({ exitCode, signal }) => this.handlePtyExit(managed, exitCode, signal)),
    );

    // 启动 cwd 兜底:5 秒未收到 OSC 1337 就开始轮询
    managed.cwdGraceTimer = setTimeout(() => {
      managed.cwdGraceTimer = null;
      if (managed.oscReceived) return; // 这期间正好收到了
      this.startCwdPolling(managed);
    }, CWD_GRACE_MS);

    // BETA-008(2026-05-15)推翻 CP-4 勘误 #5 的"初始 active"设计:
    //
    // 旧语义:active = 最近有字节 / idle = N 秒无输出。这导致新建终端瞬间是绿色 active,
    // 用户感知为"刚建就闪绿",且 startup banner 字节流让状态点反复跳。
    //
    // 新语义(v1.7 起):
    //   active(绿) = **用户的命令正在执行**
    //   idle(黄)  = 等待命令(含 banner 期 + prompt 等待)
    //   exited(灰) = 进程已退出(不变)
    //
    // 因此创建时直接 state='idle',无需 scheduleIdleCheck 兜底 — markActive 仅在
    // grace 期外的真字节流到达时触发,grace 内 banner 字节会跳过 markActive,
    // 状态自然停在 idle 不跳。"OSC-only banner 卡 active"的旧 bug 同步消失。
    //
    // 对应工单库 BETA-008、软件定义书 8.3 节(ADR-014)。

    // 把 session 挂到 path 上 (PathManager 自动触发分类流转 + emit)
    this.pathManager.attachSession(sessionId, sessionPathId);

    // 事件顺序见 CP-2 的 createSession (避免 renderer 闪 EmptyPathState)
    this.emit('sessionCreated', { ...info });
    if (input.ownerWindowId) {
      this.releaseAllOwnedBy(input.ownerWindowId, { exceptSessionId: sessionId });
    }
    return { ...info };
  }

  /**
   * M1-C:重命名 session 的 displayName。空字符串拒绝。幂等(同名无副作用)。
   * 不存在的 sessionId 静默(与 sendInput / resize 一致的"竞态时静默"语义)。
   *
   * 调用后 manuallyRenamed 永久置 true,后续 OSC 0/1/2 标题事件不再覆盖
   * 此 session 的 displayName(见 handleOscTitle)。即使新名 = 旧名也置位
   * — 用户明确说"我要这个名字"就是接管命名权。
   */
  renameSession(sessionId: string, newDisplayName: string): void {
    const managed = this.sessions.get(sessionId);
    if (!managed) return;
    const trimmed = newDisplayName.trim();
    if (!trimmed) {
      throw new SessionManagerError(
        'SessionNotFound', // 复用错误码:不至于因为校验另开一个枚举
        `[SessionManager] rename: 新名不能为空 (sessionId="${sessionId}")`,
      );
    }
    managed.manuallyRenamed = true;
    if (managed.info.displayName === trimmed) return;
    managed.info.displayName = trimmed;
    this.emitStateChanged(managed, { displayName: trimmed });
  }

  /**
   * STM-3:清除 manuallyRenamed 标记,让 OSC 0/1/2 标题事件重新覆盖
   * displayName。用户主动放弃手动命名以恢复 Claude Code 等持续刷新的
   * 自动标题。幂等(标记本来就 false 时 no-op)。
   * 不存在的 sessionId 静默(与 sendInput / resize 一致)。
   */
  clearManualRename(sessionId: string): void {
    const managed = this.sessions.get(sessionId);
    if (!managed) return;
    managed.manuallyRenamed = false;
  }

  /**
   * 关闭并销毁 session — 用户右键"关闭"或应用退出时调。
   *
   * 与 CP-2 不同:exited 状态的 session 也由此销毁 (软件定义书 8.3 ADR-008
   * 砍墓地后的唯一销毁路径)。幂等:不存在的 sessionId 不报错。
   */
  closeSession(sessionId: string): void {
    const managed = this.sessions.get(sessionId);
    if (!managed) return;
    this.destroySession(managed, 'user-closed');
  }

  /**
   * 关闭所有 session — 应用退出前调。
   */
  shutdown(): void {
    for (const sid of [...this.sessions.keys()]) {
      const managed = this.sessions.get(sid);
      if (managed) this.destroySession(managed, 'app-quit');
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Owner 管理
  // ──────────────────────────────────────────────────────────────────

  /**
   * 把 sessionId 的 owner 改为 windowId。
   *
   * 单焦点 owner 不变量:一个窗口同时只能 owner 1 个 session。
   * 接管时若 windowId 已经持有其他 session,先全部释放再切此 session。
   *
   * 跨窗口语义 (软件定义书 8.4):若 session 当前 owner 是别的窗口,不
   * 强制抢占 — 抛 SessionAlreadyOwned。IPC 层应在抛错前先调
   * SESSION_FOCUS_OWNER 把对方窗口浮起。
   *
   * @throws SessionManagerError SessionNotFound / SessionAlreadyOwned
   */
  claimOwner(sessionId: string, windowId: string): void {
    const managed = this.sessions.get(sessionId);
    if (!managed) {
      throw new SessionManagerError('SessionNotFound', `sessionId="${sessionId}"`);
    }
    const oldOwner = managed.info.ownerWindowId;
    if (oldOwner === windowId) return;
    if (oldOwner !== null && oldOwner !== windowId) {
      throw new SessionManagerError(
        'SessionAlreadyOwned',
        `sessionId="${sessionId}" 当前由 windowId="${oldOwner}" 持有,` +
          `不允许从 windowId="${windowId}" 强制抢占。请改为聚焦持有方窗口。`,
        { currentOwner: oldOwner, requestedOwner: windowId },
      );
    }
    managed.info.ownerWindowId = windowId;
    this.emit('sessionOwnerChanged', {
      sessionId,
      oldOwnerWindowId: oldOwner,
      newOwnerWindowId: windowId,
    });
    this.releaseAllOwnedBy(windowId, { exceptSessionId: sessionId });
  }

  private releaseAllOwnedBy(
    windowId: string,
    options?: { exceptSessionId?: string },
  ): void {
    const except = options?.exceptSessionId;
    for (const managed of this.sessions.values()) {
      if (
        managed.info.ownerWindowId === windowId &&
        managed.info.id !== except
      ) {
        managed.info.ownerWindowId = null;
        this.emit('sessionOwnerChanged', {
          sessionId: managed.info.id,
          oldOwnerWindowId: windowId,
          newOwnerWindowId: null,
        });
      }
    }
  }

  /**
   * 释放对 sessionId 的 ownership (变成无主)。
   * @throws SessionManagerError SessionNotFound / NotOwner
   */
  releaseOwner(sessionId: string, windowId: string): void {
    const managed = this.sessions.get(sessionId);
    if (!managed) {
      throw new SessionManagerError('SessionNotFound', `sessionId="${sessionId}"`);
    }
    if (managed.info.ownerWindowId !== windowId) {
      throw new SessionManagerError(
        'NotOwner',
        `windowId="${windowId}" 不是 sessionId="${sessionId}" 的 owner ` +
          `(实际 owner: ${managed.info.ownerWindowId})`,
      );
    }
    managed.info.ownerWindowId = null;
    this.emit('sessionOwnerChanged', {
      sessionId,
      oldOwnerWindowId: windowId,
      newOwnerWindowId: null,
    });
  }

  /**
   * 窗口被关闭时调用:该窗口持有的所有 session 的 owner 变 null,
   * **不杀 PTY** (软件定义书 9.3:关闭窗口完全不影响 session)。
   */
  handleWindowClosed(windowId: string): void {
    this.releaseAllOwnedBy(windowId);
  }

  // ──────────────────────────────────────────────────────────────────
  // PTY I/O
  // ──────────────────────────────────────────────────────────────────

  /**
   * 把 base64 数据写到 PTY stdin。返回 { accepted, reason } 让 renderer 据此
   * 给用户可见反馈(此前 void 静默,用户看到的是"敲键没反应,关窗口重开"
   * — TYP-1 / IPC-4 根因)。
   *
   * 顺手开 input echo quiet 窗口(抖动源 C/E):窗口期内 PTY 出来的字节
   * 视作按键自己的 echo / TUI 重绘回声,不触发 markActive,避免"敲键自己
   * 点亮状态点"。详见 INPUT_QUIET_MS。
   *
   * pty.write 同步抛错走 B2 加的 try/catch 返回 'pty-write-failed'。
   */
  sendInput(
    sessionId: string,
    base64Data: string,
  ): {
    accepted: boolean;
    reason?: 'session-not-found' | 'pty-exited' | 'pty-write-failed';
  } {
    const managed = this.sessions.get(sessionId);
    if (!managed) return { accepted: false, reason: 'session-not-found' };
    if (!managed.pty) return { accepted: false, reason: 'pty-exited' };
    const text = Buffer.from(base64Data, 'base64').toString('utf8');
    // BETA-006 v2.1:把"上次任意输入""上次按 Enter"两个时刻打戳,recheckIdle
    // 把它们作为元数据喂给 LLM 区分"长命令在跑"vs"用户打字未提交"。
    // 注意 lastInputAt 在每次 sendInput 都更新,即使内容只是箭头键 / Ctrl-X。
    const now = Date.now();
    managed.lastInputAt = now;
    // CUR-1:用户按 Enter (\r 或 \n) → 关闭 input quiet 窗口,让紧随的
    // 真实命令输出立即触发 markActive。否则 200ms 内的真输出被压成
    // "状态点保持 idle 黄色",直到 200ms 后才变绿 — 用户视角"按 Enter
    // 后命令延迟一拍才显示在跑"。
    // 普通按键(非 Enter)仍走原逻辑顺延 quiet 窗口。
    if (text.includes('\r') || text.includes('\n')) {
      managed.inputQuietUntil = 0;
      managed.lastEnterAt = now;
    } else {
      managed.inputQuietUntil = now + this.inputQuietMs;
    }
    // BETA-006 v2.2:按键事件 ring buffer。**绝不存内容,只存时间戳+类别**。
    // 进:classifyInput 返回 char/enter/backspace/other,push 一条。
    // 出:超 TTL 或超 cap 的从头部移除(典型 ring buffer)。
    const kind = classifyInput(text);
    managed.recentKeys.push({ ts: now, kind });
    const cutoff = now - RECENT_KEYS_TTL_MS;
    while (
      managed.recentKeys.length > 0 &&
      (managed.recentKeys[0]?.ts ?? Infinity) < cutoff
    ) {
      managed.recentKeys.shift();
    }
    while (managed.recentKeys.length > RECENT_KEYS_CAP) {
      managed.recentKeys.shift();
    }
    // TYP-2:pty.write 在 ConPTY pipe half-closed / 子进程已死但 onExit 还
    // 没到达等 race 情况下会同步抛错。原来无 try/catch → IPC handle 把
    // 异常包装成 promise reject → renderer .catch(console.error) 静默吞,
    // 每次敲键都失败而用户毫无感知。这里抓住 + 返回 pty-write-failed,
    // 让 renderer dataHandler 弹 toast。
    try {
      managed.pty.write(text);
    } catch (err) {
      logger.warn(
        'SessionManager',
        `pty.write failed sid=${sessionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { accepted: false, reason: 'pty-write-failed' };
    }
    return { accepted: true };
  }

  /**
   * 调整 PTY 终端尺寸。返回 { accepted, reason } 与 sendInput 同款语义。
   *
   * 顺手开"resize quiet 窗口" (CP-3 勘误 #3 v2):窗口期内 PTY 出来的字节
   * 视作 ConPTY/SIGWINCH 重绘回声,不触发 markActive,避免 idle session 在
   * 切窗口/接管时 tab 状态点闪绿。详见 RESIZE_QUIET_MS。
   */
  resize(
    sessionId: string,
    cols: number,
    rows: number,
  ): {
    accepted: boolean;
    reason?: 'session-not-found' | 'pty-exited' | 'invalid-dimensions';
  } {
    const managed = this.sessions.get(sessionId);
    if (!managed) return { accepted: false, reason: 'session-not-found' };
    if (!managed.pty) return { accepted: false, reason: 'pty-exited' };
    const dims = validateDimensions(cols, rows);
    // 勘误第二轮:即便 no-op 也开 quiet 窗口。原因 — Claude Code 这类 TUI 在
    // 终端被"重新显示"时会自发整屏重绘(切 tab 后用户回到它,xterm 重挂
    // → claude code 收到任意刺激 → 重绘 → markActive → idle tab 闪绿)。
    // TerminalView mount 后总会调一次 resize(即使 dims 与 spawn 时相同),
    // 这就是"我刚被显示"信号。原来的 no-op short-circuit 把该信号丢掉了,
    // 导致 idle session 闪绿。这里改为先开 quiet 窗口、再决定是否真 resize。
    managed.resizeQuietUntil = Date.now() + this.resizeQuietMs;
    if (dims.cols === managed.info.cols && dims.rows === managed.info.rows) {
      return { accepted: true };
    }
    managed.info.cols = dims.cols;
    managed.info.rows = dims.rows;
    try {
      managed.pty.resize(dims.cols, dims.rows);
      // BETA-006 v2:headless 镜像跟随 resize,buffer 折行才能与用户视觉对齐。
      // 失败忽略(headless 自己内部数组大小,不该抛 — 真抛了也不阻塞 PTY resize)。
      try {
        managed.headlessTerm?.resize(dims.cols, dims.rows);
      } catch {
        /* ignore */
      }
    } catch (err) {
      logger.warn(
        'SessionManager',
        `resize ignored sid=${sessionId} ${dims.cols}x${dims.rows}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // resize 失败不阻塞 UI:dims 已写入 SessionInfo,xterm 端已经按新尺寸
      // 渲染;PTY 端继续按旧尺寸工作只是 readline 折行可能轻微错位。
      // 上抛 invalid-dimensions 给 renderer 提示。
      return { accepted: false, reason: 'invalid-dimensions' };
    }
    return { accepted: true };
  }

  // ──────────────────────────────────────────────────────────────────
  // 查询
  // ──────────────────────────────────────────────────────────────────

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((m) => ({ ...m.info }));
  }

  get(sessionId: string): SessionInfo | null {
    const m = this.sessions.get(sessionId);
    return m ? { ...m.info } : null;
  }

  count(): number {
    return this.sessions.size;
  }

  /**
   * 取 session 重挂时需要回放的"完整终端状态"为 ANSI 字节流(base64) +
   * 当前 scrollbackLastSeq。
   *
   * **CURSOR-1 根治 — state-replay 架构**:
   *
   * 旧路径(`getScrollback`)把 main 端 `managed.scrollback: Buffer` 裸字节
   * ring(2MB 上限,头部裁切)的内容原样返回。问题:裁切按 \n 边界对齐,
   * 不识别 DEC 模式 setter,一旦 Claude Code / Codex / vim 这类 alt-buffer
   * 应用累积输出超 2MB,开头的 ?1049h / ?25l 等 setter 被裁掉 — renderer
   * 重挂时拿到的字节流缺关键模式,xterm 落不到正确 buffer。这是 BETA-019
   * / CURSOR-1 的根因。
   *
   * 新路径:每 session 各保一份 @xterm/headless terminal,跟在 PTY 字节流
   * 后面镜像状态机(buffer + modes + cursor + SGR)。本方法通过 SerializeAddon
   * 序列化"当前完整终端状态"为可重放的 ANSI 流 — 是状态机重建,不是字节流
   * 回灌,从根上不可能丢模式。
   *
   * 时序保证(避免 PER-2 invariant 在新架构下的等价问题):
   *
   *   1. flushPendingEmit:把 pendingEmit 里的字节立刻 emit 出去,
   *      scrollbackLastSeq 推进到该批次末尾
   *   2. await drainHeadless:写一个空 chunk 等回调,xterm parser 把所有已
   *      排队的 write 处理完,headless buffer 反映已收字节
   *   3. 同步块 serialize + 读 scrollbackLastSeq + return — 不再 flush
   *      (期间到达的新字节会走 8ms 自然 batch + live emit,renderer 用
   *      seq > lastSeq 过滤,不双写不丢)
   *
   * session 不存在返回 { data: '', lastSeq: -1 }。
   */
  async getScrollbackForReplay(
    sessionId: string,
  ): Promise<{ data: string; lastSeq: number }> {
    const managed = this.sessions.get(sessionId);
    if (!managed || !managed.headlessTerm || !managed.serializeAddon) {
      return { data: '', lastSeq: -1 };
    }
    const term = managed.headlessTerm;
    const addon = managed.serializeAddon;

    // 1) flush 任何 pendingEmit:emit 出去 + 推 scrollbackLastSeq。这一步
    //    保证"已经 emit 给 renderer 的字节"和"headless 状态机即将反映的
    //    字节"在调用本方法的瞬间是一致的边界。
    this.flushPendingEmit(managed);

    // 2) 等 parser drain。write('', cb) 在 cb 内说"我之前的 write 全部 parse 完
    //    了" — 这是 xterm 官方 API,等价于一个轻量 fence。
    await new Promise<void>((resolve) => {
      term.write('', () => resolve());
    });

    // 3) 同步块:此后任何 PTY 新字节只能在我们 return 之后才被事件循环处理,
    //    所以 serialize() 看到的 headless 状态 + scrollbackLastSeq 都对应
    //    drain 解析到的边界,不会有竞态。drain 后到达的字节会通过 8ms 自然
    //    batch 走 live emit,renderer seq > lastSeq 过滤兜底。
    let ansi = addon.serialize({ scrollback: 5000 });

    // XTERM-SERIALIZE-POLYFILL:0.14.0 stable 的 _serializeModes 不覆盖光标
    // 可见性(?25l)与滚动区(DECSTBM),master / 0.15.0-beta 已修。直读
    // headless _core 内部状态把这两条补到字节流末尾 — 与 master 自身实现
    // 字节级等价,不是猜测。完整背景与删除条件见
    // docs/issues/xterm-serialize-mode-polyfill.md。
    const core = (term as unknown as {
      _core?: {
        coreService?: { isCursorHidden?: boolean };
        buffer?: { scrollTop?: number; scrollBottom?: number };
      };
    })._core;
    if (core?.coreService?.isCursorHidden) {
      ansi += '\x1b[?25l';
    }
    const top = core?.buffer?.scrollTop;
    const bot = core?.buffer?.scrollBottom;
    if (
      typeof top === 'number' &&
      typeof bot === 'number' &&
      (top !== 0 || bot !== term.rows - 1)
    ) {
      ansi += `\x1b[${top + 1};${bot + 1}r`;
    }

    return {
      data: Buffer.from(ansi, 'utf8').toString('base64'),
      lastSeq: managed.scrollbackLastSeq,
    };
  }

  /**
   * BETA-028:返回 scrollback 的 UTF-8 字符串(供"复制全部"工具栏按钮)。
   *
   * CURSOR-1 后:从 headless terminal buffer 按行 translate(已渲染的字符
   * 矩阵,无 ANSI 转义、无 PSReadLine 重绘残影),换行用 '\n'。比旧的"裸
   * 字节直接 utf8 toString"更干净,直接可粘贴。
   *
   * async:headless write 是异步 parse 的,读 buffer 前先 await drain,否则
   * "刚 emit 的字节"可能还没进 buffer。getScrollbackForReplay 同样的时序。
   */
  async exportScrollback(sessionId: string): Promise<{ text: string }> {
    const managed = this.sessions.get(sessionId);
    if (!managed || !managed.headlessTerm) return { text: '' };
    // flush pendingEmit + drain parser,确保 buffer 反映所有已 emit 的字节
    this.flushPendingEmit(managed);
    const term = managed.headlessTerm;
    await new Promise<void>((resolve) => {
      term.write('', () => resolve());
    });
    const buf = term.buffer.active;
    const lines: string[] = [];
    // buf.length 是 scrollback + viewport 总行数,正向遍历
    for (let y = 0; y < buf.length; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      lines.push(line.translateToString(true)); // trim trailing whitespace
    }
    // 去掉末尾连续空行
    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return { text: lines.join('\n') };
  }

  /**
   * BETA-028:清空 main 端 scrollback。配合 renderer 的 term.clear() 使用 ——
   * 否则下次 TerminalView 重挂载时会把"看似清空"的历史又回灌一遍。
   *
   * CURSOR-1 后:直接调 headless.clear()(清 normal buffer scrollback + viewport,
   * 与 xterm 标准行为一致)。scrollbackLastSeq 不重置,保持序列号单调,避免
   * pending replay 出错。
   */
  clearScrollback(sessionId: string): void {
    const managed = this.sessions.get(sessionId);
    if (!managed || !managed.headlessTerm) return;
    managed.headlessTerm.clear();
  }

  // ──────────────────────────────────────────────────────────────────
  // 内部:PTY 数据处理
  // ──────────────────────────────────────────────────────────────────

  private handlePtyData(managed: ManagedSession, data: string): void {
    // CPT-3:ConPTY 异步关闭时仍可能 emit 一次 onData,此时 managed 可能已
    // 从 sessions Map 删除(destroySession 走完)或 pty 已置 null(handlePtyExit
    // 已走完但 disposable 还没完全 dispose)。早 return 显式 guard,避免依赖
    // 下游 ipc.ts 巧合兜住的脆弱链路。
    if (!this.sessions.has(managed.info.id) || !managed.pty) return;
    const bytes = Buffer.from(data, 'utf8');
    const parsed = managed.parser.parse(bytes);

    // 处理 OSC 事件
    for (const ev of parsed.events) {
      if (ev.kind === 'cwd') {
        this.handleOsc1337Cwd(managed, ev.value);
      } else if (ev.kind === 'title') {
        this.handleOscTitle(managed, ev.value);
      }
      // unknown 事件目前忽略 (V1.1 加 RemoteHost 等)
    }

    // 透传字节流入 scrollback + emit sessionOutput
    if (parsed.passthrough.length > 0) {
      // PER-2 修复(2026-05-14):scrollback append + scrollbackLastSeq 不
      // 在此处立即推进,而是与 emit 一起在 flushPendingEmit 里原子前进。
      //
      // 历史问题:51ab975 第一版 PER-2 在此处立即 appendScrollback +
      // 更新 scrollbackLastSeq,但 emit 延迟 8ms。renderer 在 pendingEmit
      // 窗口内调 getScrollback 会拿到含 pendingEmit 字节的快照 + 旧 lastSeq;
      // 后续 emit flush 出来的合并 payload seq > 快照 lastSeq → renderer
      // write 整段 → scrollback 已包含的字节被双写。
      //
      // 修复后语义:scrollbackLastSeq 始终 ==(已 emit 的最后 seq),
      // scrollback buffer 内容始终 == (已 emit 的字节累计);
      // pendingEmit 中尚未 flush 的字节对 renderer 不可见。
      const seq = managed.outputSeq++;
      this.queueEmit(managed, parsed.passthrough, seq);

      // BETA-006 v2:同步喂给 headless terminal — write 是异步的(内部
      // 调度到 next tick),但读 buffer 是同步的且会反映已 write 完的部分。
      // 复核时 buffer 可能比 PTY 实际状态滞后几 ms,可接受 — 复核本来
      // 就在 thresholdSec 静默后触发,几 ms 误差无关紧要。
      managed.headlessTerm?.write(parsed.passthrough);

      // 状态机:有输出 → active,重置 idle 计时器。
      // 跳过 markActive 的三种 quiet 窗口(scrollback / sessionOutput 仍正常,
      // 只跳过 markActive):
      //   - resize quiet (CP-3 勘误 #3 v2):避免 ConPTY/SIGWINCH 重绘字节让
      //     tab 闪绿;TerminalView mount 时也无条件触发此窗口
      //   - startup grace (M1-I):session 初创 1.5s 内的 banner/prompt 输出
      //     视作"应有的启动声",BETA-008 后初始 state='idle',grace 期 banner
      //     字节跳过 markActive,自然停在 idle 不闪绿
      //   - input echo quiet (抖动源 C/E):压住 sendInput 后 200ms 内的 echo /
      //     TUI 重绘字节,避免"敲键自己点亮状态点"
      const now = Date.now();
      if (
        now >= managed.resizeQuietUntil &&
        now >= managed.startupGraceUntil &&
        now >= managed.inputQuietUntil
      ) {
        this.markActive(managed);
      } else if (now < managed.startupGraceUntil) {
        // BETA-008 后:grace 期内初始 state='idle',banner 字节流不让它变 active,
        // 但也不需要 scheduleIdleCheck 兜底(根本就在 idle)。
        // markActive 流程在 grace 期外才走,scheduleIdleCheck 由 markActive 自己起。
      }
    }
  }

  /**
   * PER-2:把一次 PTY chunk 入 pendingEmit 缓冲,8ms 后(或 destroy 前)
   * 通过 flushPendingEmit 一起 append 进 scrollback、推 scrollbackLastSeq、
   * 发 sessionOutput event。
   *
   * 关键不变量:在 pendingEmit 窗口内,scrollback 内容和 scrollbackLastSeq
   * 都不变;getScrollback 看到的快照永远等于"已 emit 的全部历史",pending
   * 字节对 renderer 不可见。flush 之后三者一起原子前进。
   *
   * emitBatchMs <= 0 路径(测试用):立即同步 append + emit,保留与历史
   * 单测的时序断言一致。
   */
  private queueEmit(managed: ManagedSession, bytes: Buffer, seq: number): void {
    if (this.emitBatchMs <= 0) {
      // 立即路径 — 推 lastSeq + emit 在同一同步块内完成。CURSOR-1 后:
      // headless terminal 是状态源(handlePtyData 内同步 write),无需在此
      // append 任何裸字节存储。
      managed.scrollbackLastSeq = seq;
      const payload: SessionOutputPayload = {
        sessionId: managed.info.id,
        data: bytes.toString('base64'),
        seq,
      };
      this.emit('sessionOutput', payload);
      return;
    }
    if (managed.pendingEmit === null) {
      managed.pendingEmit = { bytes, lastSeq: seq };
    } else {
      managed.pendingEmit.bytes = Buffer.concat([
        managed.pendingEmit.bytes,
        bytes,
      ]);
      managed.pendingEmit.lastSeq = seq;
    }
    if (managed.pendingEmitTimer === null) {
      managed.pendingEmitTimer = setTimeout(() => {
        managed.pendingEmitTimer = null;
        this.flushPendingEmit(managed);
      }, this.emitBatchMs);
    }
  }

  private flushPendingEmit(managed: ManagedSession): void {
    if (!managed.pendingEmit) return;
    const { bytes, lastSeq } = managed.pendingEmit;
    managed.pendingEmit = null;
    // 原子前进:推 lastSeq + emit 同步完成。CURSOR-1 后:headless 状态机
    // 是 state-replay 的唯一源,write 已在 handlePtyData 内同步进入(line
    // headlessTerm?.write 调用),此处不再追加裸字节。getScrollbackForReplay
    // 通过 await drain + serialize 保证读到的状态与 lastSeq 一致。
    managed.scrollbackLastSeq = lastSeq;
    const payload: SessionOutputPayload = {
      sessionId: managed.info.id,
      data: bytes.toString('base64'),
      seq: lastSeq,
    };
    this.emit('sessionOutput', payload);
  }

  /**
   * 在 session 退出或销毁前同步发出仍在 8ms 聚合窗口内的输出。
   *
   * @param managed 待处理的 session
   *
   * @副作用:
   * - 取消 pendingEmitTimer
   * - 若存在 pendingEmit,立即 emit sessionOutput 并推进 scrollbackLastSeq
   *
   * @常见问题排查:
   * - 如果 renderer 在 exited/destroyed 之后才收到最后输出,检查调用方是否
   *   在 clearTimers() 之前调用了本函数。
   */
  private flushPendingEmitBeforeLifecycleChange(managed: ManagedSession): void {
    if (managed.pendingEmitTimer) {
      clearTimeout(managed.pendingEmitTimer);
      managed.pendingEmitTimer = null;
    }
    if (managed.pendingEmit) {
      this.flushPendingEmit(managed);
    }
  }

  private handlePtyExit(
    managed: ManagedSession,
    exitCode: number,
    signal: number | undefined,
  ): void {
    if (!this.sessions.has(managed.info.id)) return; // 已被 closeSession 清理过
    if (managed.info.state === 'exited') return; // 防御性:不双发

    // STM-1:在 emit sessionExited 之前把 pending 字节段先 flush 出去,
    // 保证 renderer 看到的因果序是"最后一段输出 → exited",而不是相反。
    // 否则 PER-2 引入的 8ms 聚合窗口可能含 PTY 退出前最后一波字节,等到
    // exited 已发出后才 fire → renderer 收到"已退出 session 的延迟输出"。
    this.flushPendingEmitBeforeLifecycleChange(managed);

    // emit session-exited 事件 (用于通知 renderer 显示 exitCode 等)
    const payload: SessionExitedPayload = {
      sessionId: managed.info.id,
      exitCode,
      ...(typeof signal === 'number' ? { signal } : {}),
    };
    this.emit('sessionExited', payload);

    // 状态转移到 exited (ADR-008 砍墓地:不再立即销毁)
    const oldState = managed.info.state;
    managed.info.state = 'exited';
    managed.info.exitCode = exitCode;
    managed.info.exitedAt = Date.now();
    // PTY 已死,清掉所有 active/idle/cwd 计时器,释放 PTY 句柄引用
    this.clearTimers(managed);
    managed.pty = null;

    this.emitStateChanged(managed, {
      state: managed.info.state,
      exitCode: managed.info.exitCode,
      exitedAt: managed.info.exitedAt,
      pid: -1,
    });
    void oldState; // 留给将来加日志用
  }

  private destroySession(
    managed: ManagedSession,
    reason: 'user-closed' | 'pty-exited' | 'app-quit',
  ): void {
    const sid = managed.info.id;
    if (!this.sessions.has(sid)) return;

    // PER-2:destroy 前 flush pending emit,让 owner 收到最后一段字节
    // 之后再标记 destroyed。否则会丢掉 destroy 前 8ms 内的最后 burst。
    this.flushPendingEmitBeforeLifecycleChange(managed);

    this.clearTimers(managed);
    for (const d of managed.disposables) {
      try {
        d.dispose();
      } catch {
        // ignore
      }
    }
    if (managed.pty) {
      try {
        managed.pty.kill();
      } catch (err) {
        logger.warn(
          'SessionManager',
          `kill failed sid=${sid}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      managed.pty = null;
    }
    // BETA-006 v2:释放 headless terminal,免得 buffer 行随 GC 慢慢飘
    if (managed.headlessTerm) {
      try {
        managed.headlessTerm.dispose();
      } catch {
        /* ignore */
      }
      managed.headlessTerm = null;
    }
    // CURSOR-1:SerializeAddon 在 headlessTerm.dispose 内会被一起释放
    // (它跟着 terminal 生命周期),这里只清字段引用,避免悬空指向
    managed.serializeAddon = null;
    this.sessions.delete(sid);
    this.pathManager.detachSession(sid);
    this.emit('sessionDestroyed', { sessionId: sid, reason });
  }

  // ──────────────────────────────────────────────────────────────────
  // 内部:状态机 (active / idle)
  // ──────────────────────────────────────────────────────────────────

  private markActive(managed: ManagedSession): void {
    if (managed.info.state === 'exited') return; // 不会从 exited 回来
    if (managed.info.state !== 'active') {
      managed.info.state = 'active';
      this.emitStateChanged(managed, { state: 'active' });
    }
    this.scheduleIdleCheck(managed);
  }

  private scheduleIdleCheck(managed: ManagedSession): void {
    if (managed.idleTimer) clearTimeout(managed.idleTimer);
    const thresholdSec = this.settingsManager.get().advanced.activeIdleThresholdSeconds;
    const ms = Math.max(100, thresholdSec * 1000);
    managed.idleTimer = setTimeout(() => {
      managed.idleTimer = null;
      if (managed.info.state !== 'active') return;
      // BETA-006:active→idle 跃迁前给 LLM 看一眼 scrollback 尾部判断。
      // 仅在用户开启 statusRecheckEnabled 且 aiClient.isConfigured() 时生效。
      // 失败 / LLM 异常时回退到原行为(直接转 idle),不阻塞主流程。
      const s = this.settingsManager.get();
      if (
        s.ai?.statusRecheckEnabled &&
        this.aiClient &&
        this.aiClient.isConfigured()
      ) {
        // BETA-006 v2:从 @xterm/headless buffer 拿"已渲染"文本(无 ANSI
        // 噪音 / 无 PSReadLine 重绘残影)。
        // CURSOR-1 后:原 settings.ai.statusRecheckSource='raw' 路径(裸字节
        // ring 末 2KB)已删除,headless 是唯一输入源。screenshot 选项仍预留。
        const tail = managed.headlessTerm
          ? this.getHeadlessTail(managed, 40)
          : '';
        // BETA-006 v2.1:把"上次 Enter / 上次任意输入距今多久"喂给 LLM,
        // 帮它区分"长命令在跑"vs"用户打字未按回车"。
        // BETA-006 v2.2:再附最近按键事件 ring buffer(类别+时间,无内容),
        // 让 LLM 看到节奏 — 连续 char 流 = 在打字,只一个 enter 后归零 = 命令在跑。
        const now = Date.now();
        const meta = {
          enterAgeMs: managed.lastEnterAt ? now - managed.lastEnterAt : null,
          inputAgeMs: managed.lastInputAt ? now - managed.lastInputAt : null,
          recentKeys: managed.recentKeys.map((k) => ({
            ageMs: now - k.ts,
            kind: k.kind,
          })),
        };
        this.aiClient
          .recheckIdle(tail, meta)
          .then((verdict) => {
            if (verdict === 'keep-active') {
              // LLM 判定还在跑 → 重新调度,不转 idle
              if (managed.info.state === 'active') this.scheduleIdleCheck(managed);
              return;
            }
            if (managed.info.state === 'active') {
              managed.info.state = 'idle';
              this.emitStateChanged(managed, { state: 'idle' });
            }
          })
          .catch((err) => {
            logger.warn('SessionManager', 'BETA-006 LLM recheck failed, fallback', err);
            if (managed.info.state === 'active') {
              managed.info.state = 'idle';
              this.emitStateChanged(managed, { state: 'idle' });
            }
          });
        return;
      }
      // 默认路径:直接转 idle
      managed.info.state = 'idle';
      this.emitStateChanged(managed, { state: 'idle' });
    }, ms);
  }

  /**
   * BETA-006 v2:从 headless terminal buffer 拿最后 maxRows 行非空文本。
   *
   * 实现:buffer.active 是当前 viewport(含 scrollback),从 baseY..baseY+rows
   * 是可视区,baseY 之前是 scrollback。从 buffer 末尾向上扫,跳过纯空白行,
   * 收集 maxRows 行,反转后用 \n 拼接。
   *
   * 为什么不直接取 viewport(rows 行):viewport 末尾可能有几行空白(光标
   * 还没到底),会浪费 LLM 看的窗口。从末尾找非空更接近"用户视觉看到的最后
   * 几行内容"。
   *
   * 不剪空格 / 不 strip 尾空白 — buffer 已经是"渲染后"的字符矩阵,没有
   * ANSI 转义,自然干净。
   */
  private getHeadlessTail(managed: ManagedSession, maxRows: number): string {
    if (!managed.headlessTerm) return '';
    const buf = managed.headlessTerm.buffer.active;
    // buf.length 是 scrollback + viewport 总行数
    const total = buf.length;
    const lines: string[] = [];
    for (let y = total - 1; y >= 0 && lines.length < maxRows; y--) {
      const line = buf.getLine(y);
      if (!line) continue;
      const text = line.translateToString(true); // trim trailing whitespace
      if (lines.length === 0 && text === '') continue; // 跳过末尾空行
      lines.push(text);
    }
    return lines.reverse().join('\n');
  }

  /**
   * BETA-031:bootstrap 启动后注入 AIClient,供 BETA-006 状态复核使用。
   * 可空(测试场景不注入);需要后从 settings.ai 现读配置。
   */
  setAiClient(client: AIClient | null): void {
    this.aiClient = client;
  }
  private aiClient: AIClient | null = null;

  // ──────────────────────────────────────────────────────────────────
  // 内部:OSC 1337 cwd 处理
  // ──────────────────────────────────────────────────────────────────

  private handleOsc1337Cwd(managed: ManagedSession, rawCwd: string): void {
    // OSC 收到了 → 永久关闭 cwd 兜底 (软件定义书 5.1.8、ADR-003)
    if (!managed.oscReceived) {
      managed.oscReceived = true;
      if (managed.cwdGraceTimer) {
        clearTimeout(managed.cwdGraceTimer);
        managed.cwdGraceTimer = null;
      }
      if (managed.cwdPollTimer) {
        clearInterval(managed.cwdPollTimer);
        managed.cwdPollTimer = null;
      }
    }
    const next = normalizeCwd(rawCwd);
    if (next === managed.info.currentCwd) return; // 无变化
    managed.info.currentCwd = next;
    this.emitStateChanged(managed, { currentCwd: next });
  }

  /**
   * 处理 OSC 0/1/2 标题事件 — 用 shell / Claude Code 报告的标题更新
   * session.displayName。
   *
   * 规则:
   * - manuallyRenamed=true → 跳过,用户手动改名优先(见 renameSession)
   * - 清掉控制字符(\r \n \t 等):标题如果含换行会把 sidebar 排版打乱;
   *   shell 实践里也极少把控制字符放进标题(Claude Code 用空格连接段)
   * - 长度上限 100:与 path-manager 收藏改名上限一致;过长 sidebar 显示不下,
   *   也防恶意 OSC 注入超长字符串
   * - 去前后空白后为空 → 忽略(有的 shell 启动期会发空标题清屏,不动当前名)
   * - 与现有 displayName 相同 → no-op,不发广播
   * - TIT-1:整段就是 shell exe 路径 / MINGW prefix 的"启动垃圾"标题 →
   *   忽略,不让 powershell.exe / cmd.exe / Git Bash 把 sidebar 里的友好名
   *   ("PowerShell" / "Bash")覆盖成 "C:\Windows\System32\cmd.exe"。
   *   合法 CLI 工具标题(vim / claude / make ...)前后有描述性内容,
   *   不会被 looksLikeShellStartupGarbage 误判,详见该函数注释。
   */
  private handleOscTitle(managed: ManagedSession, rawTitle: string): void {
    if (managed.manuallyRenamed) return;
    const cleaned = sanitizeTitle(rawTitle);
    if (!cleaned) return;
    if (looksLikeShellStartupGarbage(cleaned)) return;
    if (cleaned === managed.info.displayName) return;
    managed.info.displayName = cleaned;
    this.emitStateChanged(managed, { displayName: cleaned });
  }

  private startCwdPolling(managed: ManagedSession): void {
    if (managed.cwdPollTimer) return; // 已在跑
    managed.cwdPollTimer = setInterval(() => {
      void this.tickCwdPoll(managed);
    }, CWD_POLL_INTERVAL_MS);
  }

  private async tickCwdPoll(managed: ManagedSession): Promise<void> {
    if (managed.oscReceived) {
      // race:轮询启动后正好收到 OSC,清掉 (handleOsc1337Cwd 已清,这是双保险)
      if (managed.cwdPollTimer) {
        clearInterval(managed.cwdPollTimer);
        managed.cwdPollTimer = null;
      }
      return;
    }
    if (!managed.pty) {
      // PTY 已死,停轮询
      if (managed.cwdPollTimer) {
        clearInterval(managed.cwdPollTimer);
        managed.cwdPollTimer = null;
      }
      return;
    }
    try {
      const cwd = await this.platformAdapter.getProcessCwd(managed.pty.pid);
      if (cwd && !managed.oscReceived) {
        const next = normalizeCwd(cwd);
        if (next !== managed.info.currentCwd) {
          managed.info.currentCwd = next;
          this.emitStateChanged(managed, { currentCwd: next });
        }
      }
    } catch (err) {
      // 兜底失败属正常 (V1 WindowsAdapter 一直返回 null),不刷屏
      void err;
    }
  }

  private clearTimers(managed: ManagedSession): void {
    if (managed.idleTimer) {
      clearTimeout(managed.idleTimer);
      managed.idleTimer = null;
    }
    if (managed.cwdGraceTimer) {
      clearTimeout(managed.cwdGraceTimer);
      managed.cwdGraceTimer = null;
    }
    if (managed.cwdPollTimer) {
      clearInterval(managed.cwdPollTimer);
      managed.cwdPollTimer = null;
    }
    // STM-2:pendingEmitTimer 也是 session 生命周期内的计时器,clearTimers
    // 必须一并清理。否则 session 已 exited 但 timer 还在 8ms 后 fire,
    // 走 flushPendingEmit emit 一段 sessionOutput,renderer 收到"已退出 session
    // 的延迟输出"。调用方若需要在清理前先 flush,应在调 clearTimers 之前自行 flush。
    if (managed.pendingEmitTimer) {
      clearTimeout(managed.pendingEmitTimer);
      managed.pendingEmitTimer = null;
    }
  }

  private emitStateChanged(
    managed: ManagedSession,
    changes: Partial<SessionInfo>,
  ): void {
    const payload: SessionStateChangedPayload = {
      sessionId: managed.info.id,
      changes,
      full: { ...managed.info },
    };
    this.emit('sessionStateChanged', payload);
  }

  // ──────────────────────────────────────────────────────────────────
  // 内部:shell 检测缓存
  // ──────────────────────────────────────────────────────────────────

  private async getShells(): Promise<ShellInfo[]> {
    const now = Date.now();
    if (
      this.cachedShells &&
      now - this.cachedShellsAt < SessionManager.SHELL_CACHE_TTL_MS
    ) {
      return this.cachedShells;
    }
    this.cachedShells = await this.platformAdapter.detectShells();
    this.cachedShellsAt = now;
    return this.cachedShells;
  }

  /**
   * 公开版:供 IPC handler 给设置页"默认 shell"下拉框列出可用 shell 用。
   * 调用方需自行 await。结果会被缓存,与 createSession 共享。
   */
  async listAvailableShells(): Promise<ShellInfo[]> {
    return this.getShells();
  }

  /**
   * 测试用:直接重置 detectShells 缓存。
   */
  resetShellCache(): void {
    this.cachedShells = null;
  }
}

/**
 * 选 shell:
 *   1. override (来自 createSession 入参 — UI 显式选择,优先级最高)
 *   2. settings.shell.defaultShellId
 *   3. 数组第一个 (探测顺序已是 pwsh > powershell > cmd > git-bash)
 *
 * override 命中失败 (id 不在 detectShells 结果里) 时回退到 settings 兜底,
 * 不抛错 — 给用户的视觉效果是"用默认 shell 启动",比报错更友好。
 */
function pickShell(
  shells: ShellInfo[],
  settings: Settings,
  override?: string,
): ShellInfo {
  if (override) {
    const found = shells.find((s) => s.id === override);
    if (found) return found;
  }
  const preferred = settings.shell.defaultShellId;
  if (preferred) {
    const found = shells.find((s) => s.id === preferred);
    if (found) return found;
  }
  return shells[0]!;
}

/**
 * 推断 session 显示名:
 * - 有命令模板 (claude-code 等) → 模板名
 * - 纯 shell → shell 显示名 (PowerShell / Bash 等)
 */
function pickDisplayName(template: Template, shell: ShellInfo): string {
  if (template.command) return template.name;
  return inferDisplayName(shell.executablePath);
}

export function buildSshLaunchParams(
  profile: {
    id?: string;
    host: string;
    port: number;
    username: string;
    authType: 'agent' | 'keyFile' | 'password';
    keyFilePath?: string;
    proxyJump?: string[];
    tmuxMode?: 'disabled' | 'attach-or-create';
    tmuxSessionName?: string;
    tmuxSessionPolicy?: 'reuse' | 'new-per-launch';
    tmuxOnMissing?: 'fallback-shell' | 'fail';
  },
  remoteCwd: string,
  options: {
    forceTmuxChoice?: boolean;
    commandToRun?: { command: string; args: string[]; env?: Record<string, string> };
    /** SSH 方案 §阶段 3.5:启用 ControlMaster 复用同 host 连接。默认 false。 */
    enableControlMaster?: boolean;
    /** ControlPath 绝对路径模板(必含 %r %h %p 占位符),enableControlMaster=true 时必填。 */
    controlPath?: string;
  } = {},
): { args: string[]; env: Record<string, string> } {
  const args = [
    '-tt',
    '-p',
    String(profile.port),
    '-o',
    'ServerAliveInterval=30',
  ];
  if (profile.authType === 'keyFile' && profile.keyFilePath) {
    args.push('-i', profile.keyFilePath);
  }
  // ProxyJump:多跳板拼接成 -J host1,host2,host3。空数组等价于不跳板。
  // OpenSSH 接受 user@host:port 形式,这里只做空段过滤,不做格式校验
  // (跳板鉴权由 OpenSSH 复用主机已配置的 agent / key,Marina 不介入)。
  const proxyHops = (profile.proxyJump ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
  if (proxyHops.length > 0) {
    args.push('-J', proxyHops.join(','));
  }
  // ControlMaster:同 host 连接复用。auto = 第一次正常连,后续 attach 到
  // 已有 master(通过 ControlPath socket)。ControlPersist=10m 让 master
  // 在最后一个 client 断开后保留 10 分钟,期间新 session 0 握手。
  // Windows OpenSSH 8.x+ 支持但不太稳,失败时 OpenSSH 自动回退到新连接,
  // Marina 不需要兜底逻辑。
  if (options.enableControlMaster && options.controlPath) {
    args.push(
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=${options.controlPath}`,
      '-o', 'ControlPersist=10m',
    );
  }
  args.push(`${profile.username}@${profile.host}`);
  args.push(buildRemoteLoginCommand(remoteCwd, profile, options));
  return { args, env: {} };
}

function buildRemoteLoginCommand(
  remoteCwd: string,
  profile: {
    id?: string;
    host: string;
    username: string;
    tmuxMode?: 'disabled' | 'attach-or-create';
    tmuxSessionName?: string;
    tmuxSessionPolicy?: 'reuse' | 'new-per-launch';
    tmuxOnMissing?: 'fallback-shell' | 'fail';
  },
  options: {
    forceTmuxChoice?: boolean;
    commandToRun?: { command: string; args: string[]; env?: Record<string, string> };
  } = {},
): string {
  const cwd = remoteCwd.trim() || '~';
  let cdCommand: string;
  if (cwd === '~') {
    // `cd '~'` 会把 ~ 当普通目录名,不会展开到 home。无参数 cd 是 POSIX
    // shell 进入 $HOME 的标准写法,也避开不同远端 shell 对 tilde expansion
    // 的细节差异。
    cdCommand = 'cd';
  } else if (cwd.startsWith('~/')) {
    // 不能把整段 `~/repo` 单引号包起来,否则 ~ 不展开。用 "$HOME"/'repo'
    // 拼接:home 由远端 shell 展开,后半段仍保持严格 quote,支持空格等字符。
    cdCommand = `cd "$HOME"/${shQuote(cwd.slice(2))}`;
  } else {
    cdCommand = `cd ${shQuote(cwd)}`;
  }
  const shellCommand = 'exec "${SHELL:-/bin/sh}" -l';
  const commandLine = options.commandToRun
    ? buildRemoteTemplateCommand(options.commandToRun)
    : null;
  const launchCommand = commandLine
    // 远端模板(如 claude/codex)常写在交互式 shell 初始化文件里。
    // 这里用 `-ic` 让行为尽量贴近用户手动在终端里输入命令的路径。
    ? `exec "\${SHELL:-/bin/sh}" -ic ${shQuote(`${commandLine}; ${shellCommand}`)}`
    : shellCommand;
  if (profile.tmuxMode !== 'attach-or-create') {
    return `${cdCommand} && ${launchCommand}`;
  }
  const baseSessionName = defaultTmuxSessionName(cwd);
  // 目录派生是产品语义:同一个远程目录的 tmux 会话族必须统一落在
  // marina-<leaf> / marina-<leaf>-N。旧版 profile 里可能残留
  // tmuxSessionName 或 new-per-launch,这里故意不再读取,避免旧配置覆盖
  // "按目录智能选择"规则。
  const tmuxCommand = buildSmartTmuxCommand(
    baseSessionName,
    !!options.forceTmuxChoice,
  );
  const failCommand =
    'printf %s\\\\n "Marina: tmux attach/create failed on the remote host." >&2; exit 127';
  const fallbackAfterFailure =
    profile.tmuxOnMissing === 'fail' ? failCommand : launchCommand;
  // tmux 本身只是远端 shell 里的一个全屏程序,不是 Marina session 的终点。
  // 用户在 tmux pane 里输入 exit 后,tmux client 会正常返回;此时必须继续
  // exec 回登录 shell,否则 ssh.exe 会结束,Main 只能把整个 Marina session
  // 标成 exited。失败路径仍走 fallbackAfterFailure,避免把真正的 tmux 启动
  // 错误伪装成一次正常 shell 回落。
  const tmuxBootstrap =
    `${cdCommand} && if command -v tmux >/dev/null 2>&1; then ` +
    `if ${tmuxCommand}\nthen ${launchCommand}; else ` +
    `{ printf %s\\\\n "Marina: tmux attach/create failed; falling back to shell." >&2; ${fallbackAfterFailure}; }; fi; ` +
    `else ${fallbackAfterFailure}; fi`;
  // SSH remote command 默认由远端 login shell 以非登录/非交互方式执行。
  // 有些机器的 tmux 依赖 login shell 初始化出来的 PATH / locale / conda 等环境:
  // 用户回退到 shell 后手动 `tmux new-session -A` 能成功,但直接 remote command
  // 会报 "server exited unexpectedly"。启用 tmux 时先显式进入 login shell 执行
  // bootstrap,让自动路径尽量贴近用户手动成功的路径。
  return `exec "\${SHELL:-/bin/sh}" -lc ${shQuote(tmuxBootstrap)}`;
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildRemoteTemplateCommand(input: {
  command: string;
  args: string[];
  env?: Record<string, string>;
}): string {
  const envPairs = Object.entries(input.env ?? {})
    .filter(([key]) => key.length > 0)
    .map(([key, value]) => shQuote(`${key}=${value}`));
  const argv = [input.command, ...input.args].map(shQuote);
  const runCommand = envPairs.length === 0
    ? argv.join(' ')
    : ['env', ...envPairs, ...argv].join(' ');
  return (
    `${runCommand}; marina_template_status=$?; ` +
    `if [ "$marina_template_status" -eq 127 ]; then ` +
    `{ printf %s\\\\n "Marina: remote template command not found or not in PATH: ${input.command}" >&2; }; fi; ` +
    `unset marina_template_status`
  );
}

function defaultTmuxSessionName(remoteCwd: string): string {
  const normalized = remoteCwd.replace(/\/+$/g, '') || '~';
  const leaf = normalized === '~'
    ? 'home'
    : normalized.split('/').filter(Boolean).pop() || 'root';
  const safe = leaf
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  if (safe) return `marina-${safe}`;
  const digest = createHash('sha256').update(remoteCwd).digest('hex').slice(0, 8);
  return `marina-${digest}`;
}

function buildSmartTmuxCommand(baseSessionName: string, forceChoice: boolean): string {
  const base = shQuote(baseSessionName);
  const force = forceChoice ? '1' : '0';
  const script = Buffer.from(SMART_TMUX_SCRIPT, 'utf8').toString('base64');
  // 这里不能用 `sh -c ${shQuote(SMART_TMUX_SCRIPT)}`。外层 SSH 命令已经
  // 通过 `${SHELL:-/bin/sh} -lc '...'` 再解析一次;如果内层脚本里还有
  // `'#S'` / `'%s\n'` / `''|...` 这类单引号,第二层 shell 会把它们当作
  // `sh -c '...'` 参数的结束,最终在远端看到裸露的 `;;` 或文件结尾错误。
  // 也不能用 heredoc:它会占用子 shell 的 stdin,tmux/read 拿不到 SSH 分配
  // 的 tty,Ubuntu 上会报 "open terminal failed: not a terminal"。
  // base64 让脚本文本完全不参与 shell quote;再用 `sh -c "$(decode)"`
  // 作为一个子 shell 执行,stdin 仍保持连接到真实 tty。不能用 eval:
  // tmux 结束后脚本里的 `exit $?` 会退出当前 login shell,外层 `then
  // exec "${SHELL:-/bin/sh}" -l` 没机会执行,用户在 tmux 里 exit 后就会
  // 直接断开 SSH。
  return (
    `MARINA_TMUX_BASE=${base} MARINA_TMUX_FORCE_CHOICE=${force} ` +
    `sh -c "$(printf %s ${shQuote(script)} | base64 -d)"`
  );
}

const SMART_TMUX_SCRIPT = `
base=$MARINA_TMUX_BASE
force=$MARINA_TMUX_FORCE_CHOICE
sessions=$(tmux -L marina list-sessions -F '#S' 2>/dev/null | while IFS= read -r s; do
  if [ "$s" = "$base" ]; then
    printf '%s\\n' "$s"
    continue
  fi
  prefix=$base-
  suffix=\${s#$prefix}
  if [ "$suffix" != "$s" ] && printf '%s\\n' "$suffix" | grep -Eq '^[0-9]+$'; then
    printf '%s\\n' "$s"
  fi
done)
count=$(printf '%s\\n' "$sessions" | sed '/^$/d' | wc -l | tr -d ' ')
new_session() {
  i=1
  while tmux -L marina has-session -t "$base-$i" 2>/dev/null; do i=$((i + 1)); done
  tmux -L marina new-session -s "$base-$i"
  exit $?
}
if [ "$count" = "0" ]; then
  tmux -L marina new-session -s "$base"
  exit $?
fi
if [ "$count" = "1" ] && [ "$force" != "1" ]; then
  tmux -L marina attach-session -t "$sessions"
  exit $?
fi
printf '\\nMarina found tmux sessions for %s:\\n' "$base"
n=1
printf '%s\\n' "$sessions" | sed '/^$/d' | while IFS= read -r s; do printf '  %s) attach %s\\n' "$n" "$s"; n=$((n + 1)); done
printf '  n) create new session\\nSelect: '
read ans
if [ "$ans" = "n" ] || [ "$ans" = "N" ] || [ -z "$ans" ]; then
  new_session
fi
if ! printf '%s\\n' "$ans" | grep -Eq '^[0-9]+$'; then
  new_session
fi
if [ "$ans" -lt 1 ] 2>/dev/null; then
  new_session
fi
target=$(printf '%s\\n' "$sessions" | sed '/^$/d' | sed -n "$ans"p)
if [ -n "$target" ]; then
  tmux -L marina attach-session -t "$target"
  exit $?
fi
new_session
`;

/**
 * OSC 标题"启动垃圾"识别(TIT-1):
 *
 * ⚠️ 这是一个 workaround,不是根治。详见
 * `docs/issues/tit-1-osc-title-shell-startup-garbage.md` —— 有用户实测体感
 * 与代码考古结论之间未对齐的缺口,某处可能有过一道屏障后来失效了,真正
 * 根因尚未定位。下次回归此现象时先读那份 issue 文档。
 *
 * Windows 上 powershell.exe / cmd.exe 启动时调 Win32 SetConsoleTitle()
 * 把窗口标题设成自己的 exe 路径,ConPTY 把这次调用翻译成 OSC 0 序列发给
 * xterm 消费者;Git Bash 默认 PS1 又在每次 prompt 时主动发
 * `\e]0;MINGW64:<cwd>\a`。这些"shell 启动 / 内置 prompt"产出的标题对
 * Marina 用户而言全是噪声 — 他们希望 tab 显示的是 "PowerShell" / "Bash"
 * 或自己跑的工具名(vim / claude / node ...),不是 shell 自己的 exe 路径
 * 或 cwd 重复。
 *
 * 但绝不能误杀 CLI 工具的合法标题。CLI 工具(vim / claude / make ...)
 * 的标题特征是 **路径只是更长描述的一部分** —— "vim /etc/hosts" /
 * "✻ Claude · ~/p (working…)" / "make -j4"。所以判别规则是:
 *
 *   整段标题 *本身就是* 一个裸路径 → 启动垃圾 → 拒
 *   标题里 *包含* 路径但前后有别的内容 → 合法 → 放行
 *
 * 用 ^...$ 完整匹配实现这一区分。
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
 * OSC 0/1/2 标题规范化:
 *   - 控制字符(C0 + DEL)替成空格
 *   - OSC-6:Unicode 双向重写字符也替成空格(防 RTL override 视觉欺骗)
 *   - 合并连续空格、trim、截到 100 字符
 *
 * 空串返回 ''(调用方据此跳过)。
 */
const TITLE_MAX_LEN = 100;
function sanitizeTitle(raw: string): string {
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
 * 把 OSC 1337 报告的 cwd 规范化:trim、~ 展开、PSDrive 前缀剥离、转绝对。
 * 失败时原样返回。
 *
 * FLK-9:PowerShell 在某些 PSDrive(自定义、PSProvider 加载)上下文里
 * 会发 `Microsoft.PowerShell.Core\FileSystem::C:\foo` 这种全限定形式,
 * normalize 不一致让 cwdDrifted 比较抖动 — 每个 prompt 都"变 → 复原"
 * 让 statusbar ⚠️ 图标闪一下。剥离 PSDrive 前缀让等价路径归一。
 */
function normalizeCwd(raw: string): string {
  let value = raw.trim();
  if (!value) return value;
  // FLK-9:剥 PSDrive PSProvider 前缀(模式 `<Provider>::<path>`)
  // PowerShell 标准模式:Microsoft.PowerShell.Core\FileSystem::C:\xxx
  // 通用模式:任何 `\w+\.[\w.]+\\\w+::` 后跟实际路径
  const psDriveMatch = value.match(/^[\w.]+\\[\w.]+::(.+)$/);
  if (psDriveMatch) {
    value = psDriveMatch[1]!;
  }
  // ~ 展开 (有的 shell hook 在 git-bash 下可能会发 ~/...)
  if (value.startsWith('~')) {
    value = value.replace(/^~/, homedir());
  }
  try {
    return resolvePath(value);
  } catch {
    return value;
  }
}

/**
 * 测试 / 非 Windows 用的 noop adapter。所有方法返回最小可用值。
 *
 * 注:这里"用"是说 SessionManager 在 Linux/macOS 下也可以构造 (主要是
 * 为了让 session-manager.test.ts 在任何 OS 上跑得起来)。生产 Windows
 * 路径不会走到这。
 */
function createNoopAdapter(): PlatformAdapter {
  return {
    lifecycleModel: 'no-persistence',
    async detectShells() {
      return [
        {
          id: 'sh',
          displayName: 'sh',
          executablePath: process.env['SHELL'] ?? '/bin/sh',
        },
      ];
    },
    resolveExecutable(commandName) {
      if (!commandName.trim()) return null;
      return commandName;
    },
    buildShellLaunchParams(_shell, _hookFilePath, _commandToRun) {
      return { args: [], env: {} };
    },
    async registerFileManagerIntegration() {
      throw new Error('noop');
    },
    async unregisterFileManagerIntegration() {
      throw new Error('noop');
    },
    async getProcessCwd() {
      return null;
    },
    async setAutoStart() {
      throw new Error('noop');
    },
    async isAutoStartEnabled() {
      return false;
    },
    getRefreshedPath() {
      return process.env.PATH ?? '';
    },
    normalizeSpawnEnv(env: Record<string, string>) {
      // noop adapter:不做 Windows 占位符规整,直接放行
      return env;
    },
    getDefaultBookmarkSeeds() {
      return [];
    },
  };
}
