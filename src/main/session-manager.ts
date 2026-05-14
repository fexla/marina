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
import { randomUUID } from 'node:crypto';
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
import { Osc1337Parser } from './osc1337-parser';
import { getPlatformAdapter, type PlatformAdapter, type ShellInfo } from './platform';
import { buildSpawnEnv, validateDimensions } from './pty-utils';
import { logger } from './logger';

const SPAWN_ENV_SKIP = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL'];

/**
 * Scrollback ring buffer 上限 (软件定义书 5.1.4)。2MB 远小于 PTY 输出
 * 速率,实际很少触顶。超过则尾部裁切。
 */
export const SCROLLBACK_LIMIT = 2 * 1024 * 1024;

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
      return resolvePath(hookDir, 'bash.sh');
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
   * Ring buffer:存所有透传后字节流 (OSC 1337 已剥离)。
   * 软件定义书 5.1.4 + 8.4 (跨窗口接管时新 owner 拉历史回放)。
   */
  scrollback: Buffer;
  /** scrollback 中最末一条 PTY data 对应的 outputSeq。-1 表示尚未有输出。 */
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
}

export interface CreateSessionInput {
  pathId: string; // 已 normalize 的绝对路径
  templateId: string;
  ownerWindowId: string;
  cols: number;
  rows: number;
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
    // 测试或非 Windows 不走 getPlatformAdapter (会 throw)
    this.platformAdapter =
      options.platformAdapter ??
      (process.platform === 'win32' ? getPlatformAdapter() : createNoopAdapter());
    this.hookFileResolver = options.hookFileResolver ?? defaultHookFileResolver;
    this.resizeQuietMs = options.resizeQuietMs ?? RESIZE_QUIET_MS;
    this.startupGraceMs = options.startupGraceMs ?? STARTUP_GRACE_MS;
    this.inputQuietMs = options.inputQuietMs ?? INPUT_QUIET_MS;
    this.skipCwdValidation = options.skipCwdValidation ?? false;
    // 测试缺省传 0(立即 emit,保持时序断言)
    this.emitBatchMs = options.emitBatchMs ?? EMIT_BATCH_MS;
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
    const cwd = input.pathId || homedir();

    // cwd 预校验:不存在 / 不是目录 → 直接抛 CwdNotAccessible,带友好消息。
    // 否则交给 node-pty,ConPTY 在 CreateProcess 时会因 lpCurrentDirectory 失败
    // 抛 ERROR_DIRECTORY (267),用户看到的是"Cannot create process, error code: 267",
    // 完全看不出问题在 cwd。此外 Explorer 集成场景下用户可能把右键时存在的
    // 文件夹在 Marina 处理过程中删了,这里给出明确兜底。
    // 单测用伪路径,通过 options.skipCwdValidation=true 跳过此检查。
    if (!this.skipCwdValidation) {
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
    const launchParams = this.platformAdapter.buildShellLaunchParams(
      shell,
      hookFile,
      template.command
        ? { command: template.command, args: template.args }
        : undefined,
    );

    const env = buildSpawnEnv(process.env, SPAWN_ENV_SKIP);
    Object.assign(env, launchParams.env);
    Object.assign(env, template.env);

    let pty: IPty;
    try {
      pty = this.spawnFn(shell.executablePath, launchParams.args, {
        name: 'xterm-color',
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
        `无法启动 "${shell.executablePath}" cwd="${cwd}". ` +
          `可能原因: (1) shell 不在 PATH; (2) cwd 不可访问; ` +
          `(3) node-pty 原生模块未为当前 Electron 重编译。原始错误: ${
            err instanceof Error ? err.message : String(err)
          }`,
        { shellPath: shell.executablePath, cwd },
      );
    }

    const sessionId = randomUUID();
    const info: SessionInfo = {
      id: sessionId,
      pathId: input.pathId,
      templateId: template.id,
      originalCwd: cwd,
      currentCwd: cwd,
      cols: dims.cols,
      rows: dims.rows,
      pid: pty.pid,
      displayName: pickDisplayName(template, shell),
      ownerWindowId: input.ownerWindowId || null,
      state: 'active',
      createdAt: Date.now(),
    };

    const disposables: IDisposable[] = [];
    const managed: ManagedSession = {
      info,
      pty,
      outputSeq: 0,
      disposables,
      scrollback: Buffer.alloc(0),
      scrollbackLastSeq: -1,
      parser: new Osc1337Parser(),
      idleTimer: null,
      cwdGraceTimer: null,
      cwdPollTimer: null,
      oscReceived: false,
      resizeQuietUntil: 0,
      startupGraceUntil: Date.now() + this.startupGraceMs,
      inputQuietUntil: 0,
      manuallyRenamed: false,
      pendingEmit: null,
      pendingEmitTimer: null,
    };
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

    // CP-4 勘误 #5:初始 state='active' 时立即起 idle 计时器。
    //
    // 原 bug:有的 shell 启动期第一波 PTY 数据可能是纯 OSC 1337(passthrough 为空),
    // 此时 markActive 不被调用,scheduleIdleCheck 永不启动,state 永远卡在 'active'。
    // 表现 = 用户看到"终端状态卡在活跃"(绿点不变黄)。
    //
    // 修复:创建时直接 schedule 一次 idle 检查;后续任何有效字节流到达 markActive
    // 会重置该 timer,不影响"有输出 → 保持 active"的语义。
    this.scheduleIdleCheck(managed);

    // 把 session 挂到 path 上 (PathManager 自动触发分类流转 + emit)
    this.pathManager.attachSession(sessionId, input.pathId);

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
    // CUR-1:用户按 Enter (\r 或 \n) → 关闭 input quiet 窗口,让紧随的
    // 真实命令输出立即触发 markActive。否则 200ms 内的真输出被压成
    // "状态点保持 idle 黄色",直到 200ms 后才变绿 — 用户视角"按 Enter
    // 后命令延迟一拍才显示在跑"。
    // 普通按键(非 Enter)仍走原逻辑顺延 quiet 窗口。
    if (text.includes('\r') || text.includes('\n')) {
      managed.inputQuietUntil = 0;
    } else {
      managed.inputQuietUntil = Date.now() + this.inputQuietMs;
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
   * 取 session 的 scrollback ring buffer 内容。
   *
   * 返回 base64 编码 + 当前 scrollbackLastSeq。Renderer 用 lastSeq 对后续
   * evt:session:output 去重 (seq > lastSeq 才 write)。
   *
   * session 不存在返回 { data: '', lastSeq: -1 } — 与 sendInput / resize
   * 等"竞态时静默"的语义一致。
   */
  getScrollback(sessionId: string): { data: string; lastSeq: number } {
    const managed = this.sessions.get(sessionId);
    if (!managed) return { data: '', lastSeq: -1 };
    return {
      data: managed.scrollback.toString('base64'),
      lastSeq: managed.scrollbackLastSeq,
    };
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

      // 状态机:有输出 → active,重置 idle 计时器。
      // 跳过 markActive 的三种 quiet 窗口(scrollback / sessionOutput 仍正常,
      // 只跳过 markActive):
      //   - resize quiet (CP-3 勘误 #3 v2):避免 ConPTY/SIGWINCH 重绘字节让
      //     tab 闪绿;TerminalView mount 时也无条件触发此窗口
      //   - startup grace (M1-I):session 初创 1.5s 内的 banner/prompt 输出
      //     视作"应有的启动声",不让它"创建 → 立即 active → 1.5s 后 idle"
      //     这套抖动闪过去;创建时 state='active' + scheduleIdleCheck 已起好,
      //     grace 内 markActive 跳过,grace 结束后正常变 idle
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
        // STM-4:grace 期内有字节流入,虽然跳过 markActive(避免抖动),
        // 但仍重置 idle timer — 否则 banner 在 1.49s 才结束的极端 case
        // 下,createSession 起的 idle timer 2s 到点 fire → "刚结束 banner
        // 就 idle"。重置后 idle timer 顺延,grace 后实际进 idle 的时机
        // = 最后一条 banner 字节 + activeIdleThresholdSeconds(默认 2s),
        // 符合用户预期。
        this.scheduleIdleCheck(managed);
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
      // 立即路径 — append + 推 lastSeq + emit 在同一同步块内完成,
      // 与延迟路径在 flush 时的原子性等价。
      this.appendScrollback(managed, bytes);
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
    // 原子前进顺序:先 scrollback append,再 scrollbackLastSeq,再 emit。
    // 这三步在 Node 单线程下同步完成,中间不会被 IPC 调用 getScrollback
    // 打断 — 任何观察者看到的都是一致状态。
    this.appendScrollback(managed, bytes);
    managed.scrollbackLastSeq = lastSeq;
    const payload: SessionOutputPayload = {
      sessionId: managed.info.id,
      data: bytes.toString('base64'),
      seq: lastSeq,
    };
    this.emit('sessionOutput', payload);
  }

  private appendScrollback(managed: ManagedSession, bytes: Buffer): void {
    if (managed.scrollback.length === 0) {
      managed.scrollback = bytes;
    } else {
      managed.scrollback = Buffer.concat([managed.scrollback, bytes]);
    }
    if (managed.scrollback.length > SCROLLBACK_LIMIT) {
      // OSC-2:尾部裁切对齐 ESC/换行边界,避免接管首屏乱码。
      //
      // 历史:`subarray(length - LIMIT)` 在裸字节上做裁切,落点可能在:
      //   - 多字节 UTF-8 序列中间 → 首字符 U+FFFD(轻微)
      //   - CSI/OSC/DCS 转义序列中间 → xterm 进 OSC parse 状态吞数十-数百
      //     字节直到下一个 BEL/ST(严重,首屏大段隐形或状态污染)
      //   - SGR 颜色序列中间 → 颜色错位直到下一个完整 SGR
      //
      // 修复:findSafeTruncationBoundary 从目标偏移向前找最近的 \n,把
      // 实际裁切点对齐到完整 ANSI 行的边界。最多回退 4KB(防极端 case
      // 整段没换行时永远回退)。
      const minStart = managed.scrollback.length - SCROLLBACK_LIMIT;
      const safeStart = findSafeTruncationBoundary(
        managed.scrollback,
        minStart,
      );
      managed.scrollback = managed.scrollback.subarray(safeStart);
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
    if (managed.pendingEmitTimer) {
      clearTimeout(managed.pendingEmitTimer);
      managed.pendingEmitTimer = null;
    }
    if (managed.pendingEmit) {
      this.flushPendingEmit(managed);
    }

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
    if (managed.pendingEmitTimer) {
      clearTimeout(managed.pendingEmitTimer);
      managed.pendingEmitTimer = null;
    }
    if (managed.pendingEmit) {
      this.flushPendingEmit(managed);
    }

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
      if (managed.info.state === 'active') {
        managed.info.state = 'idle';
        this.emitStateChanged(managed, { state: 'idle' });
      }
    }, ms);
  }

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
 * OSC-2:scrollback 尾部裁切对齐 ANSI/UTF-8 边界。
 *
 * 从 minStart 开始向后扫描,找到最近的 `\n`(0x0A)作为安全起点。
 * 没找到时最多向后扫 4KB,仍没找到 → 用 minStart 兜底(整段无换行的
 * 极端 case,只能接受可能的 ANSI 半截);防止扫遍整段 buffer。
 *
 * 为什么找 \n 而不是找 ESC 边界:
 *   - 找 ESC 边界更精确(任何完整 SGR/CSI 之后都是安全的),但实现复杂
 *     (需识别完整 vt 状态机)
 *   - \n 总是 ANSI 行边界,xterm 解析时一定回到 ground state,简单可靠
 *   - 4KB 上限保证最坏情况下损失数十行,远好过乱码风险
 *
 * 测试覆盖:OSC-2 test case 见 session-manager.test.ts。
 */
export function findSafeTruncationBoundary(
  buf: Buffer,
  minStart: number,
): number {
  if (minStart <= 0) return 0;
  const maxScanEnd = Math.min(buf.length, minStart + 4096);
  for (let i = minStart; i < maxScanEnd; i++) {
    if (buf[i] === 0x0a /* \n */) {
      return i + 1; // \n 后的下一个字节才是安全起点
    }
  }
  // 没找到合理边界 — 用 minStart 兜底,接受可能的 ANSI 半截
  return minStart;
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
    async detectShells() {
      return [
        {
          id: 'sh',
          displayName: 'sh',
          executablePath: process.env['SHELL'] ?? '/bin/sh',
        },
      ];
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
  };
}
