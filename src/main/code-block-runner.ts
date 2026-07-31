/**
 * @file src/main/code-block-runner.ts
 * @purpose Markdown 代码块一键执行的后端服务(v0.3.3,ADR-023)。
 *
 * @关键设计:
 * - 执行模型:不碰 PTY / xterm,不创建 Marina session,不调 SessionManager
 *   .sendInput。直接用 node:child_process.spawn 启动对应 shell 跑整段 code。
 *   这样当前终端前台无论是 Claude Code / Codex / vim / 普通 shell,都不会被
 *   干扰 —— 命令在独立的系统进程里跑。
 * - 工作目录:由 sourceSessionId 的服务端 currentCwd 决定。renderer 不传 cwd,
 *   也不被信任;main/daemon 从 SessionManager 真值读取,与"窗口平等 / 路径中心"
 *   哲学一致(命令在用户当前聚焦的路径下跑)。
 * - backend 路由:本服务在 main 进程里跑。本地窗口的请求经 Electron IPC 直达;
 *   远程窗口的请求经 preload 自动路由到远程 daemon 上的同一服务(ADR-014)。
 *   远程 daemon 上的 session 若是 SSH session(指向第三台机器),currentCwd 是
 *   远程路径 —— daemon 无法在那台机器上 spawn,故 SSH session 一律拒绝(与
 *   file-tree / git-service 的 SSH 拒绝策略对称,不引入远程协议)。
 * - 事件回推:stdout/stderr 经 'output' 事件(按 64KB 聚合切块,防逐字符砸 IPC);
 *   退出经 'exited' 事件(exitCode / signal)。两者都带 runId + 发起 clientId,
 *   ipc 层据此定向 sendEventTo 发起窗口。
 * - shell 解析(2026-08-01 修复):不靠 PATH。Electron main 的 PATH 经常没有
 *   pwsh.exe(用户装了但不在 PATH)/ bash(Git Bash 仅在绝对路径) —— 直接
 *   spawn 报 ENOENT(close 时 exitCode=-4058)。改用应用自身 detectShells 的
 *   绝对路径(与 SessionManager 同一检测源):pwsh→ProgramFiles\PowerShell\7,
 *   bash→Git\bin\bash.exe(git-bash),powershell/cmd→System32。getShells
 *   可选注入;缺省回退 PATH(行为同旧版)。
 * - 输出编码(2026-08-01 修复):powershell/pwsh 命令前缀强制 UTF-8 输出;
 *   bash(Git Bash)原生 UTF-8;cmd.exe 按系统 ANSI 代码页(中文 Windows = GBK)
 *   输出,用 DetectingOutputDecoder 自动判定 UTF-8 / GBK 解码。多字节字符跨
 *   chunk 切分由 StringDecoder / TextDecoder(stream) 处理。
 * - 生命周期:切 terminal/面板不影响独立进程;源 Session 真正销毁 → removeSession
 *   停止该 session 启动的运行;发起窗口关闭 → removeClient 杀掉该 client 的全部
 *   运行,避免向已销毁的 webContents 推事件。自然退出/stop 后从 run map 清除。
 *   run map 有界(MAX_RUNS),溢出按 FIFO 强杀最旧运行。
 *
 * @对应文档章节: docs/方案-markdown代码块执行-20260731.md;
 *   软件定义书 ADR-023;AGENTS.md 附录 I(本服务是有状态短生命周期子进程,
 *   不属于 ADR-021 的周期后台任务,故不走 BackgroundWorkScheduler)。
 *
 * @不要在这里做的事:
 * - 不经 PTY / 不写终端字节流(那是 SessionManager 的职责)。
 * - 不做命令扫描 / 风险分级 / 确认弹窗 —— 这些交互约束已按产品决策移除。
 * - 不持久化运行记录(进程退出即丢弃);不做命令历史。
 * - 不把命令正文 / stdout 写进日志或性能报告(隐私:附录 H 红线)。
 */
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import type { CodeBlockLanguage } from '@shared/protocol';
import type { SessionInfo, ShellInfo } from '@shared/types';
import { logger } from './logger';

const MODULE = 'CodeBlockRunner';

/** 代码块原文字节上限,防 AI / 误粘巨型内容喂给 spawn 撑爆参数缓冲。 */
const MAX_CODE_BYTES = 256 * 1024;
/** 同时存活运行数硬上限。溢出按 FIFO 强杀最旧,防失控累积。 */
const MAX_RUNS = 64;
/** stdout/stderr 聚合到该字节数再推一次事件,避免逐字符广播砸 IPC。 */
const OUTPUT_FLUSH_BYTES = 64 * 1024;
/** 聚合 flush 的最大延迟,保证短输出也能及时看到(不等满 64KB)。 */
const OUTPUT_FLUSH_MS = 100;

/** IPC 可识别的代码块执行错误。详情足够诊断,但不回显命令正文。 */
export class CodeBlockError extends Error {
  constructor(
    public readonly code:
      | 'SessionMissing'
      | 'SshUnsupported'
      | 'ShellMissing'
      | 'CodeTooLarge'
      | 'SpawnFailed',
    message: string,
  ) {
    super(message);
    this.name = 'CodeBlockError';
  }
}

/** run() 的入参(由 ipc handler 从 envelope payload 组装)。 */
export interface RunInput {
  sourceSessionId: string;
  language: CodeBlockLanguage;
  code: string;
  /** 发起 client(本地窗口 = windowId,远程 = WS clientId)。事件定向回它。 */
  requestingClientId: string;
}

/** 服务发出的 'output' 事件。ipc 层映射成 evt:system:code-block-output。 */
export interface CodeBlockOutputEvent {
  runId: string;
  clientId: string;
  stream: 'stdout' | 'stderr';
  data: string;
}

/** 服务发出的 'exited' 事件。ipc 层映射成 evt:system:code-block-exited。 */
export interface CodeBlockExitedEvent {
  runId: string;
  clientId: string;
  exitCode: number | null;
  signal: string | null;
}

export interface CodeBlockRunnerEvents {
  output: (e: CodeBlockOutputEvent) => void;
  exited: (e: CodeBlockExitedEvent) => void;
}

/**
 * 可注入的 spawn 函数签名。生产用 node:child_process.spawn;测试用 fake
 * 覆盖,避免真起系统进程(AGENTS.md 9.3:测试不许 spawn 真进程)。
 */
export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; windowsHide: boolean },
) => ChildProcess;

/** 真实 spawn。单独导出便于测试默认注入。 */
export const defaultSpawn: SpawnFn = (command, args, options) =>
  spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * 语言 → 优先使用的 detectShells shell id(按序尝试)。
 * - bash/sh:优先 Git Bash(绝对路径),其次系统 bash/sh(Linux)
 * - pwsh:优先 PowerShell 7;未装则回退 Windows PowerShell 5.1(Windows 上
 *   powershell.exe 必装)。两者 UTF-8 前缀通用,对绝大多数代码块行为一致。
 * - powershell:优先 5.1;5.1 不在(罕见,如精简版 Windows)则用 PS7。
 * - cmd:cmd.exe
 */
const SHELL_ID_PREFERENCE: Record<CodeBlockLanguage, readonly string[]> = {
  bash: ['git-bash', 'bash', 'sh'],
  sh: ['git-bash', 'bash', 'sh'],
  pwsh: ['pwsh', 'powershell'],
  powershell: ['powershell', 'pwsh'],
  cmd: ['cmd'],
};

/** 在 detectShells 结果里按偏好序找第一个命中 shell 的绝对路径;找不到返回 null。 */
function resolveShellPath(
  language: CodeBlockLanguage,
  shells: readonly ShellInfo[],
): string | null {
  for (const id of SHELL_ID_PREFERENCE[language]) {
    const hit = shells.find((s) => s.id === id);
    if (hit && hit.executablePath) return hit.executablePath;
  }
  return null;
}

/** PowerShell 系强制 UTF-8 输出的命令前缀(中文 Windows 默认 GBK 会乱码)。 */
export const PS_UTF8_PREFIX =
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' +
  '$OutputEncoding=[System.Text.Encoding]::UTF8;';

/**
 * 解析某归一化语言对应的可执行命令与参数。
 *
 * 抽成纯函数(导出)便于单测守护“语言 → spawn argv”契约,main spawn 分支不再散落。
 * - bash / sh  → 优先 Git Bash 绝对路径(Windows),否则系统 `bash`/`sh`;跑 `bash -c`
 *   (非登录非交互,避免登录 shell 读 profile 造成的副作用 / 输出丢失)。Git Bash
 *   原生 UTF-8 输出。
 * - powershell / pwsh → 优先绝对路径(System32 的 powershell.exe / ProgramFiles 的
 *   pwsh.exe)。pwsh 未装时回退 powershell(SHELL_ID_PREFERENCE),`-NoProfile -Command`,
 *   前缀强制 UTF-8 输出(5.1 / 7 通用)。
 * - cmd → System32\cmd.exe,`/d /s /c`。cmd 输出按系统 ANSI 代码页(GBK),
 *   解码交给 DetectingOutputDecoder,不做 chcp(chcp 对管道输出无效且会把中文
 *   变问号,实测)。
 *
 * shells 为空时回退 PATH 名(旧行为);spawn 失败由 run() 捕获转 ShellMissing。
 */
export function buildSpawnArgs(
  language: CodeBlockLanguage,
  code: string,
  isWin: boolean,
  shells: readonly ShellInfo[] = [],
): { command: string; args: string[] } {
  switch (language) {
    case 'bash':
    case 'sh': {
      const command = resolveShellPath(language, shells) ?? (isWin ? 'bash' : 'sh');
      // -c(非登录非交互):一次性跑完整 code。不用 -l(登录)——登录 shell 读
      //   profile 会产生副作用、可能吞掉/重定向输出(实测 Git Bash 登录 shell
      //   下输出异常)。一次性脚本执行标准用法就是 -c。
      return { command, args: ['-c', code] };
    }
    case 'powershell':
    case 'pwsh': {
      const command = resolveShellPath(language, shells) ?? (isWin ? `${language}.exe` : language);
      return { command, args: ['-NoProfile', '-Command', `${PS_UTF8_PREFIX}${code}`] };
    }
    case 'cmd': {
      const command = resolveShellPath('cmd', shells) ?? 'cmd.exe';
      return { command, args: ['/d', '/s', '/c', code] };
    }
    default: {
      // 穷尽性守卫:language 来自 shared 归一化,理论不会到这。
      const _exhaustive: never = language;
      throw new CodeBlockError('SpawnFailed', `不支持的语言:${String(_exhaustive)}`);
    }
  }
}

/**
 * @param sessionLookup 从 SessionManager 读真值;不持有 SessionManager 引用以
 *   保持与 git-service 一致的"每请求回查防陈旧授权"模式。
 * @param spawnFn 可注入的 spawn(测试覆盖);默认 node:child_process.spawn。
 */
export class CodeBlockRunner extends EventEmitter {
  private readonly sessionLookup: (id: string) => SessionInfo | null;
  private readonly spawnFn: SpawnFn;
  /** 可选:应用自身 detectShells 结果(绝对路径),解决 PATH 里没有 pwsh/bash 的问题。 */
  private readonly getShells?: () => Promise<ShellInfo[]>;
  /** runId → 运行记录。有界,溢出 FIFO 强杀最旧。 */
  private readonly runs = new Map<string, RunRecord>();
  /** 维护插入顺序用于 FIFO 淘汰(Map 迭代按插入序)。 */
  private runOrder: string[] = [];

  constructor(
    sessionLookup: (id: string) => SessionInfo | null,
    spawnFn: SpawnFn = defaultSpawn,
    getShells?: () => Promise<ShellInfo[]>,
  ) {
    super();
    this.sessionLookup = sessionLookup;
    this.spawnFn = spawnFn;
    this.getShells = getShells;
  }

  /**
   * 启动一次代码块执行。异步(需等待 detectShells 解析 shell 绝对路径);
   * 输出/退出经 'output' / 'exited' 事件回推。
   *
   * @throws CodeBlockError SessionMissing / SshUnsupported / CodeTooLarge / SpawnFailed
   */
  async run(input: RunInput): Promise<{ runId: string }> {
    const { sourceSessionId, language, code, requestingClientId } = input;

    // 1) session 真值校验:不存在 / 已 destroyed → 友好报错,不 spawn。
    const session = this.sessionLookup(sourceSessionId);
    if (!session) {
      throw new CodeBlockError(
        'SessionMissing',
        `sourceSessionId="${sourceSessionId}" 不存在或已销毁。可能该终端已关闭。`,
      );
    }

    // 2) SSH session 拒绝:currentCwd 在第三台机器,本进程无法在那 spawn。
    //    与 file-tree / git-service 的 SSH 拒绝策略对称(不引入远程协议)。
    if (session.pathId.startsWith('ssh:')) {
      throw new CodeBlockError(
        'SshUnsupported',
        'SSH 终端的代码块执行暂不支持(命令需在远程主机上跑,当前服务只能在本机 spawn)。请在本地终端里运行。',
      );
    }

    // 3) 代码长度上限:防 AI / 误粘巨型内容撑爆命令行参数缓冲。
    const codeBytes = Buffer.byteLength(code, 'utf8');
    if (codeBytes > MAX_CODE_BYTES) {
      throw new CodeBlockError(
        'CodeTooLarge',
        `代码块 ${codeBytes} 字节超过 ${MAX_CODE_BYTES} 上限。请拆分或在外部脚本里跑。`,
      );
    }

    // 4) 解析 spawn argv + 启动。cwd = 服务端 currentCwd(renderer 不被信任)。
    //    shell 绝对路径来自应用自身 detectShells(与 SessionManager 同源),
    //    解决 Electron main 的 PATH 里没有 pwsh.exe / bash 导致的 ENOENT。
    //    getShells 失败回退空列表(走 PATH 名),不阻塞执行。
    const cwd = session.currentCwd || session.originalCwd;
    const shells = this.getShells ? await this.safeGetShells() : [];
    const { command, args } = buildSpawnArgs(language, code, process.platform === 'win32', shells);

    let child: ChildProcess;
    try {
      child = this.spawnFn(command, args, {
        cwd,
        // 继承父进程环境(PATU / 别名 / 用户装的 CLI 都在 PATH 里)。不注入
        // MARINA_SERVICE / TERMINAL_ID —— 这是一次性命令,不是常驻终端。
        env: { ...process.env },
        windowsHide: true,
      });
    } catch (err) {
      // spawn 同步抛(ENOENT 等)→ 转 ShellMissing,提示用户装对应 shell。
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(MODULE, `spawn failed for language=${language}`, err);
      throw new CodeBlockError(
        'ShellMissing',
        `启动 ${command} 失败:${msg}。可能该 shell 未安装或不在 PATH 里。`,
      );
    }

    // 5) 注册 run,溢出 FIFO 强杀最旧。
    const runId = randomUUID();
    const record: RunRecord = {
      runId,
      child,
      clientId: requestingClientId,
      sourceSessionId,
      language,
    };
    this.registerRun(runId, record);

    logger.info(
      MODULE,
      `run: runId=${runId} lang=${language} sid=${sourceSessionId} client=${requestingClientId} pid=${child.pid ?? 'n/a'}`,
    );

    // 6) 接管 stdout/stderr 聚合输出 + 退出处理。child 的事件回调里 guard
    //    record 是否还在 map(可能已被 stop / removeClient 清掉)。
    this.pipeOutput(record);

    return { runId };
  }

  /**
   * 停止某次运行。幂等:未运行 / 未知 runId 静默。
   * SIGKILL 而非 SIGTERM:这些是短命令,用户点了"停止"就是要立刻停;
   * Windows 上无 SIGTERM 语义,ConPTY/tree-kill 才需要 grace,这里单进程直接 kill。
   */
  stop(runId: string): void {
    const record = this.runs.get(runId);
    if (!record) return;
    try {
      record.child.kill('SIGKILL');
    } catch {
      /* 已退出 / kill 失败静默;close 事件会兜底清理 */
    }
  }

  /**
   * 源 Session 真正销毁时停止它启动的全部运行。普通 terminal 切换不销毁
   * Session,因此不会命中。记录保留到 child close,让仍存活的发起窗口收到
   * exited 并把 renderer L1 cache 从 running 收口。
   */
  removeSession(sessionId: string): void {
    for (const [runId, record] of this.runs) {
      if (record.sourceSessionId === sessionId) this.stop(runId);
    }
  }

  /**
   * 发起 client(窗口)关闭时调:杀掉它启动的全部运行,避免向已销毁的
   * webContents 推事件 + 回收子进程。ipc.ts 的 onWindowClosed 钩到这里。
   */
  removeClient(clientId: string): void {
    for (const runId of [...this.runs.keys()]) {
      const record = this.runs.get(runId);
      if (record?.clientId === clientId) {
        try {
          record.child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        // 不在这发 exited —— 客户端都没了,发了也没人收。直接清记录。
        this.cleanupRun(runId);
      }
    }
  }

  /** 当前存活运行数(测试 / 诊断用)。 */
  size(): number {
    return this.runs.size;
  }

  // ──────────────────────────────────────────────────────────────────
  // 内部
  // ──────────────────────────────────────────────────────────────────

  /** getShells 容错包装:失败回退空列表(走 PATH 名),不阻塞执行也不炸 run。 */
  private async safeGetShells(): Promise<ShellInfo[]> {
    try {
      return (await this.getShells?.()) ?? [];
    } catch (err) {
      logger.warn(MODULE, 'getShells failed, fallback to PATH resolution', err);
      return [];
    }
  }

  private registerRun(runId: string, record: RunRecord): void {
    this.runs.set(runId, record);
    this.runOrder.push(runId);
    // 子进程意外不退出时,Map 会无限增长。溢出 FIFO 强杀最旧,保住有界。
    while (this.runOrder.length > MAX_RUNS) {
      const oldest = this.runOrder[0]!;
      this.stop(oldest);
    }
  }

  private pipeOutput(record: RunRecord): void {
    const { runId, clientId, child, language } = record;

    // 编码策略:
    // - powershell/pwsh:命令前缀已强制 UTF-8,用 StringDecoder('utf8') 处理多字节
    //   字符跨 chunk 切分(直接 Buffer.toString('utf8') 会在 UTF-8 序列被拆到两个
    //   'data' chunk 时产生 U+FFFD 替换符)。
    // - cmd:按系统 ANSI 代码页(中文 Windows = GBK)输出,用 DetectingOutputDecoder
    //   自动判定 UTF-8 / GBK(ASCII 部分两种编码字节一致,不影响流式)。
    // - bash:Git Bash 原生 UTF-8。
    const cmdMode = language === 'cmd';
    const stdoutDecoder = cmdMode ? new DetectingOutputDecoder() : new StringDecoder('utf8');
    const stderrDecoder = cmdMode ? new DetectingOutputDecoder() : new StringDecoder('utf8');

    // 聚合 buffer:攒到 OUTPUT_FLUSH_BYTES 或 OUTPUT_FLUSH_MS 推一次。
    // 避免逐字符 / 逐 chunk 广播 —— IPC 序列化开销会主导短输出的体验。
    let stdoutBuf = '';
    let stderrBuf = '';
    let stdoutTimer: NodeJS.Timeout | null = null;
    let stderrTimer: NodeJS.Timeout | null = null;

    const flush = (stream: 'stdout' | 'stderr'): void => {
      const buf = stream === 'stdout' ? stdoutBuf : stderrBuf;
      if (buf.length === 0) return;
      if (stream === 'stdout') {
        stdoutBuf = '';
        if (stdoutTimer) {
          clearTimeout(stdoutTimer);
          stdoutTimer = null;
        }
      } else {
        stderrBuf = '';
        if (stderrTimer) {
          clearTimeout(stderrTimer);
          stderrTimer = null;
        }
      }
      this.emit('output', { runId, clientId, stream, data: buf } satisfies CodeBlockOutputEvent);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += stdoutDecoder.write(chunk);
      if (stdoutBuf.length >= OUTPUT_FLUSH_BYTES) {
        flush('stdout');
      } else if (!stdoutTimer) {
        stdoutTimer = setTimeout(() => flush('stdout'), OUTPUT_FLUSH_MS);
        stdoutTimer.unref?.();
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += stderrDecoder.write(chunk);
      if (stderrBuf.length >= OUTPUT_FLUSH_BYTES) {
        flush('stderr');
      } else if (!stderrTimer) {
        stderrTimer = setTimeout(() => flush('stderr'), OUTPUT_FLUSH_MS);
        stderrTimer.unref?.();
      }
    });

    child.on('error', (err) => {
      // spawn 后异步错误:最常见的 ENOENT(可执行文件找不到——PATH 缺失或已卸载),
      // Node 不抛同步异常,而是发 'error' 事件后 close(exitCode=-4058)。给用户
      // 可读的提示而不是裸的 -4058。
      logger.warn(MODULE, `child error runId=${runId}`, err);
      const code = (err as NodeJS.ErrnoException).code;
      const hint =
        code === 'ENOENT'
          ? `[marina] 找不到可执行命令(可能未安装,或不在应用检测到的 shell 列表里):${err.message}`
          : `[marina] 执行出错:${err.message}`;
      this.emit('output', {
        runId,
        clientId,
        stream: 'stderr',
        data: `\n${hint}\n`,
      } satisfies CodeBlockOutputEvent);
    });

    child.on('close', (exitCode, signal) => {
      // close 而非 exit:确保 stdout/stderr 的剩余 chunk 都已 'data' 完。
      // close 总在最后触发,在这 flush decoder 残留(尾字节)+ flush 聚合 buffer +
      // 发 exited 最安全。
      stdoutBuf += stdoutDecoder.end();
      stderrBuf += stderrDecoder.end();
      flush('stdout');
      flush('stderr');
      logger.info(
        MODULE,
        `exited: runId=${runId} exitCode=${exitCode ?? 'null'} signal=${signal ?? 'null'}`,
      );
      this.emit('exited', {
        runId,
        clientId,
        exitCode,
        signal,
      } satisfies CodeBlockExitedEvent);
      this.cleanupRun(runId);
    });
  }

  private cleanupRun(runId: string): void {
    this.runs.delete(runId);
    this.runOrder = this.runOrder.filter((id) => id !== runId);
  }
}

interface RunRecord {
  runId: string;
  child: ChildProcess;
  clientId: string;
  sourceSessionId: string;
  language: CodeBlockLanguage;
}

/**
 * cmd.exe 输出流的智能解码器:UTF-8 / GBK 自动判定。
 *
 * 背景:cmd.exe 的输出按“系统 ANSI 代码页”编码(中文 Windows = GBK/936),
 * 不是 UTF-8;直接按 UTF-8 解码中文必乱码。另一方面 Win10+ 用户可能开了
 * “使用 Unicode UTF-8 提供全球语言支持”(ACP = UTF-8),此时 cmd 输出是
 * UTF-8。两种机器上同一个 cmd 代码块需要不同的解码,故按内容自动判定。
 *
 * 判定策略:
 * - 未决定前,纯 ASCII chunk 直接输出(ASCII 在 UTF-8 与 GBK 下字节一致,不
 *   影响后续判定);含非 ASCII 的 chunk 先攒着。
 * - 攒到非 ASCII 字节后,用 fatal UTF-8 解码整段:成功 → UTF-8;失败 → GBK。
 * - 已决定后,TextDecoder(stream) 流式解码,跨 chunk 的多字节字符由 decoder
 *   内部缓存处理。
 *
 * 已知局限:若 UTF-8 输出恰好把多字节字符拆在 chunk 边界(罕见),fatal 解码
 * 首段会失败误判 GBK,之后该流的中文变乱码 —— cmd 短命令输出通常单 chunk,
 * 可接受。
 */
export class DetectingOutputDecoder {
  private held: Buffer[] = [];
  private heldBytes = 0;
  private stream: TextDecoder | null = null;

  write(chunk: Buffer): string {
    if (this.stream) return this.stream.decode(chunk, { stream: true });
    if (chunk.length === 0) return '';
    // 纯 ASCII:两种编码字节一致,直接输出,不触发判定。
    if (!chunk.some((b) => b >= 0x80)) return chunk.toString('latin1');
    // 首次出现非 ASCII:判定整个已攒缓冲(含本次 chunk)。
    this.held.push(chunk);
    this.heldBytes += chunk.length;
    const buf = Buffer.concat(this.held);
    this.held = [];
    this.heldBytes = 0;
    let enc: 'utf-8' | 'gbk';
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buf);
      enc = 'utf-8';
    } catch {
      enc = 'gbk';
    }
    this.stream = new TextDecoder(enc);
    return this.stream.decode(buf, { stream: true });
  }

  end(): string {
    if (!this.stream) {
      return Buffer.concat(this.held).toString('latin1');
    }
    return this.stream.decode();
  }
}
