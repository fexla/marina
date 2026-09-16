/**
 * @file src/main/session-fs.ts
 * @purpose per-session 文件系统视角层(方案-远程文件面板一致性-20260917 P1)。
 *   文件面板的一切路径解析/校验/读取/监视不再假设「session 的文件系统 =
 *   daemon 本地 fs」,而是按 session 类型选实现:本地会话走 node:fs(行为与
 *   接入本层之前完全一致),SSH 会话走系统 ssh 一次性 exec(优先复用
 *   ControlMaster 控制连接,认证/跳板/key 与交互终端同一套配置)。
 *
 * @关键设计:
 * - 接口对齐 FilePanelService 原有的 node:fs 使用面(resolve/stat/readFile/
 *   watch/basename/dirname),让接入层改动是机械替换而非重写。
 * - stat 不抛 ENOENT 而是返回 {exists:false}:「不存在」是正常业务结果
 *   (调用方映射成 NotFound 用户提示);真正异常(远端不可达/工具缺失/
 *   权限错误)抛 code='EIO' 的 Error,调用方映射 ResolveFailed。
 * - SSH 读取经 base64 传输(exec 通道无 TTY、二进制安全);stat 用 GNU
 *   `stat -c '%s %Y'` + BSD `stat -f '%z %m'` 双兼容,mtime 精度秒
 *   (mtimeMs = Y*1000,刷新检测粒度比本地粗,可接受)。
 * - SSH 无变更监视(SFTP 也没有 inotify,推送在协议上不存在)→ watch()
 *   返回 null,调用方降级为「面板激活/切文件时 stat 比对 + 手动刷新」。
 * - 远端 $HOME 惰性获取一次并缓存(~ 展开用);ensureHome() 供异步调用方
 *   在首次解析前显式刷新。同步 resolve 在 home 未缓存时对 '~' 原样保留
 *   (stat 会失败并报错,不静默猜路径)。
 *
 * @明确边界(方案 §6):
 * - 不引入 ssh2(AGENTS.md 边界 2,开发者裁决采用系统 ssh 路线)。
 * - 远端为 Windows 主机时 POSIX 工具缺失 → stat/read 抛 EIO,调用方走
 *   「打不开」提示,与文件不存在同一路径。
 * - password 认证经 sshpass(SSHPASS env,与 code-block-runner.spawnRemote
 *   同款);key/agent 认证加 BatchMode=yes 防交互挂起。
 *
 * @对应文档:docs/方案-远程文件面板一致性-20260917.md(支柱 P1);
 *   docs/ipc-protocol.md file-panel 域;src/main/file-panel-service.ts(接入点)。
 */
import type { ChildProcess } from 'node:child_process';
import { promises as fs, watch as fsWatch } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { homedir } from 'node:os';
import { normalizePath } from './path-manager';
import { logger } from './logger';

const MODULE = 'SessionFs';

/** 单次远端 exec 的硬超时(ms)。head -c 上限 ~2MB,base64 后 ~2.7MB,慢速
 *  WAN 链路下余量给足;超时 kill,调用方按失败处理。 */
const SSH_EXEC_TIMEOUT_MS = 30_000;

/** SSH 一次性 exec 的连接超时(秒)。BatchMode/key 场景防挂起。 */
const SSH_CONNECT_TIMEOUT_S = 15;

/** stat 结果的归一形态。「不存在」是正常结果(exists:false),不抛错。 */
export interface SessionFsStat {
  exists: boolean;
  isFile: boolean;
  /** 字节。exists=false 时为 0。 */
  size: number;
  /** epoch ms。SSH 实现精度为秒(远端 stat 只有 %Y/%m 秒粒度)。 */
  mtimeMs: number;
}

/** 变更监视句柄;与 fs.FSWatcher 同形态(close 幂等)。 */
export interface SessionFsWatchHandle {
  close(): void;
}

/** 远端不可达 / 工具缺失 / 权限错误等真异常。code 区分于 ENOENT 语义。 */
export interface SessionFsIoError extends Error {
  code: 'EIO';
}

function ioError(message: string): SessionFsIoError {
  const err = new Error(message) as SessionFsIoError;
  err.code = 'EIO';
  return err;
}

/**
 * Session 的文件系统视角。实现必须无状态或自缓存(同一 session 复用同一实例)。
 * 所有方法以「该 session 眼中的绝对路径」为通货:本地实现是 OS 路径,SSH 实现
 * 是远端 POSIX 路径。调用方(FilePanelService)不感知差异。
 */
export interface SessionFs {
  readonly kind: 'local' | 'ssh';
  /** 相对基准解析为规范绝对路径(含 ~ 展开;SSH 用 POSIX 语义)。 */
  resolve(base: string, p: string): string;
  /** 该视角下的绝对路径判定(本地 = node isAbsolute;SSH = POSIX / 开头)。 */
  isAbsolute(p: string): boolean;
  /** basename / dirname(展示名与 md 相对解析基准;SSH 必须 POSIX 语义)。 */
  basename(p: string): string;
  dirname(p: string): string;
  stat(abs: string): Promise<SessionFsStat>;
  /** 读文件,超过 maxBytes 截断并置 truncated(尾部裁切哲学,镜像旧实现)。 */
  readLimited(abs: string, maxBytes: number): Promise<{ buf: Buffer; truncated: boolean }>;
  /** 读整个文件(调用方须先用 stat.size 校验上限,防超大文件进内存)。 */
  readFull(abs: string): Promise<Buffer>;
  /** 变更监视;实现无监视能力返回 null,调用方降级(SSH 恒 null)。 */
  watch(abs: string, onChange: () => void): SessionFsWatchHandle | null;
  /** 惰性准备 ~ 展开所需信息(仅 SSH 实现需要;本地为 no-op)。 */
  ensureHome(): Promise<void>;
}

// ──────────────────────────────────────────────────────────────────
// 本地实现:行为与接入本层之前的内联 node:fs 代码逐行等价
// ──────────────────────────────────────────────────────────────────

class LocalSessionFs implements SessionFs {
  readonly kind = 'local' as const;

  resolve(base: string, p: string): string {
    // ~ 展开(shell 语义:仅首字符;中间的 ~ 是合法文件名字符)。展开后是
    // 绝对路径,resolve(base, ...) 会忽略 base。
    let expanded = p;
    if (expanded === '~') {
      expanded = homedir();
    } else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
      expanded = join(homedir(), expanded.slice(2));
    }
    return normalizePath(resolve(base, expanded));
  }

  isAbsolute(p: string): boolean {
    return isAbsolute(p);
  }

  basename(p: string): string {
    return basename(p);
  }

  dirname(p: string): string {
    return dirname(p);
  }

  async stat(abs: string): Promise<SessionFsStat> {
    try {
      const s = await fs.stat(abs);
      return { exists: true, isFile: s.isFile(), size: s.size, mtimeMs: s.mtimeMs };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { exists: false, isFile: false, size: 0, mtimeMs: 0 };
      // EPERM / EACCES 等真异常照抛,调用方映射 ResolveFailed(与旧实现一致)。
      throw ioError(`stat 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async readLimited(abs: string, maxBytes: number): Promise<{ buf: Buffer; truncated: boolean }> {
    const buf = await fs.readFile(abs);
    const truncated = buf.byteLength > maxBytes;
    return { buf: truncated ? buf.subarray(0, maxBytes) : buf, truncated };
  }

  async readFull(abs: string): Promise<Buffer> {
    return fs.readFile(abs);
  }

  watch(abs: string, onChange: () => void): SessionFsWatchHandle {
    const w = fsWatch(abs, () => onChange());
    // FSWatcher 的 'error' 若无监听器,EventEmitter 语义会直接抛崩进程。
    // 吞掉并 warn:面板项保留,refreshStale 的 missing 标记负责兜底展示。
    w.on('error', (err: Error) => {
      logger.warn(MODULE, `watch error on ${abs}: ${err.message}`);
    });
    return {
      close: () => {
        try {
          w.close();
        } catch {
          /* 关闭幂等 */
        }
      },
    };
  }

  async ensureHome(): Promise<void> {
    /* 本地 ~ 展开用 os.homedir(),无需远端查询 */
  }
}

/** 本地实现无状态,模块级单例即可。 */
export const localSessionFs: SessionFs = new LocalSessionFs();

// ──────────────────────────────────────────────────────────────────
// SSH 实现:系统 ssh 一次性 exec
// ──────────────────────────────────────────────────────────────────

/** SSH 会话的远端 exec 目标(由组装层 index.ts 从 pathId + SshProfile 还原)。 */
export interface SshSessionFsTarget {
  host: string;
  port: number;
  username: string;
  authType: 'agent' | 'keyFile' | 'password';
  keyFilePath?: string;
  proxyJump?: string[];
  /** password 认证的明文(与 CodeBlockRunner 的 SshExecProfile 同隐私级别,
   *  由 index.ts 解密注入,不落盘不进日志)。 */
  password?: string;
  /** ControlMaster 复用 ControlPath(存在则 exec 也走控制连接,免重复握手)。 */
  controlPath?: string;
}

/** SSH exec 的可注入依赖(生产 = 系统解析 + child_process.spawn;测试 = fake)。 */
export interface SshSessionFsDeps {
  /** 解析可执行绝对路径。返回 null = 缺依赖,SSH 视角不可用。 */
  resolveExecutable: (name: 'ssh' | 'sshpass') => string | null;
  /** spawn(测试注入用)。 */
  spawn: (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => ChildProcess;
}

/** 单引号安全转义(POSIX shell;与 session-manager.shQuote 同实现,不 import
 *  后者避免把 SessionManager 的 PTY 依赖链拉进本模块的单测)。 */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

class SshSessionFs implements SessionFs {
  readonly kind = 'ssh' as const;
  private home: string | null = null;

  constructor(
    private readonly target: SshSessionFsTarget,
    private readonly deps: SshSessionFsDeps,
  ) {}

  resolve(base: string, p: string): string {
    let expanded = p;
    if (this.home) {
      if (expanded === '~') {
        expanded = this.home;
      } else if (expanded.startsWith('~/')) {
        expanded = posix.join(this.home, expanded.slice(2));
      }
    }
    // posix.resolve:p 绝对则忽略 base;相对则拼到 session 的远端 cwd 上。
    // '~' 未展开(home 未缓存)时原样进入,posix.resolve 视为相对路径拼接,
    // 后续 stat 失败会给出明确错误 —— 不静默猜。
    return posix.resolve(base, expanded);
  }

  isAbsolute(p: string): boolean {
    return posix.isAbsolute(p);
  }

  basename(p: string): string {
    return posix.basename(p);
  }

  dirname(p: string): string {
    return posix.dirname(p);
  }

  async ensureHome(): Promise<void> {
    if (this.home) return;
    const { stdout } = await this.exec(`printf %s "$HOME"`, { allowMissingSshpass: true });
    const home = stdout.toString('utf8').trim();
    // 空结果视为不可用(~ 展开禁用),不缓存,下次再试。
    if (home.startsWith('/')) this.home = home;
  }

  async stat(abs: string): Promise<SessionFsStat> {
    // GNU `stat -c '%s %Y'` 优先(绝大多数 Linux 服务器),失败回落 BSD
    // `stat -f '%z %m'`(macOS 等)。两者都输出 "size mtimeSec"。
    // DIR / MISSING 由 shell test 分流 —— [ -f ] 在所有 POSIX sh 上可用,
    // 不依赖 stat 的类型字段格式差异。
    const script =
      `f=${shQuote(abs)}; ` +
      `if [ -f "$f" ]; then ` +
      `stat -c '%s %Y' "$f" 2>/dev/null || stat -f '%z %m' "$f"; ` +
      `elif [ -e "$f" ]; then echo __DIR__; ` +
      `else echo __MISSING__; fi`;
    const { stdout } = await this.exec(script, {});
    const text = stdout.toString('utf8').trim();
    if (text === '__DIR__') return { exists: true, isFile: false, size: 0, mtimeMs: 0 };
    if (text === '__MISSING__') return { exists: false, isFile: false, size: 0, mtimeMs: 0 };
    const parts = text.split(/\s+/);
    const size = Number(parts[0]);
    const mtimeSec = Number(parts[1]);
    if (!Number.isFinite(size) || !Number.isFinite(mtimeSec)) {
      throw ioError(
        `[SessionFs] 远端 stat 输出无法解析: host="${this.target.host}" path="${abs}" output="${text.slice(0, 80)}". ` +
          'Possible causes: (1) 远端 stat 不是 GNU/BSD 标准实现(BusyBox 精简版?), ' +
          "(2) 远端 shell 输出被 profile 改写。在远端手动跑 `stat -c '%s %Y' <file>` 对照。",
      );
    }
    return { exists: true, isFile: true, size, mtimeMs: mtimeSec * 1000 };
  }

  async readLimited(abs: string, maxBytes: number): Promise<{ buf: Buffer; truncated: boolean }> {
    // 多读 1 字节用于判断截断(与本地 readFile-then-subarray 语义对齐)。
    // base64 把二进制安全地搬过 exec 通道;Buffer#from 对换行容错(GNU 单行、
    // BSD 76 列折行都吃得下)。
    const script = `f=${shQuote(abs)}; head -c ${maxBytes + 1} "$f" | base64`;
    const { stdout } = await this.exec(script, {});
    const buf = Buffer.from(stdout.toString('ascii').replace(/\s+/g, ''), 'base64');
    const truncated = buf.byteLength > maxBytes;
    return { buf: truncated ? buf.subarray(0, maxBytes) : buf, truncated };
  }

  async readFull(abs: string): Promise<Buffer> {
    const script = `f=${shQuote(abs)}; base64 < "$f"`;
    const { stdout } = await this.exec(script, {});
    return Buffer.from(stdout.toString('ascii').replace(/\s+/g, ''), 'base64');
  }

  watch(): SessionFsWatchHandle | null {
    // SSH 远端没有变更推送(SFTP 也无 inotify)。降级策略在调用方:
    // 面板激活/切文件时 stat 比对 mtime + 手动刷新(方案 §6 明确不做 watch)。
    return null;
  }

  /**
   * 跑一次远端命令并收集 stdout/stderr/exit code。
   *
   * @param options.allowMissingSshpass password 认证但 sshpass 缺失时改为直接
   *   跑 ssh(ensureHome 的低频探针:若 ControlMaster 控制连接存在,attach
   *   不需要密码;否则快速失败,~ 展开降级)。其余调用缺 sshpass 直接抛 EIO。
   */
  private async exec(
    command: string,
    options: { allowMissingSshpass?: boolean } = {},
  ): Promise<{ stdout: Buffer; stderr: string; code: number | null }> {
    const sshPath = this.deps.resolveExecutable('ssh');
    if (!sshPath) {
      throw ioError(
        `[SessionFs] 未找到 ssh 可执行文件,无法读取 SSH 会话的远端文件。 ` +
          'Possible causes: (1) 系统未安装 OpenSSH client, (2) PATH 未包含它。' +
          'SSH 文件面板需要本机 ssh(与交互终端同一依赖)。',
      );
    }
    const args: string[] = ['-p', String(this.target.port)];
    if (this.target.authType === 'keyFile' && this.target.keyFilePath) {
      args.push('-i', this.target.keyFilePath);
    }
    const hops = (this.target.proxyJump ?? []).map((s) => s.trim()).filter(Boolean);
    if (hops.length > 0) args.push('-J', hops.join(','));
    // ControlMaster:与交互终端同款参数。控制连接存在时 attach(免握手免认证);
    // 不存在时本进程成为 master,ControlPersist 让它延续 10 分钟加速后续读取。
    if (this.target.controlPath) {
      args.push(
        '-o',
        'ControlMaster=auto',
        '-o',
        `ControlPath=${this.target.controlPath}`,
        '-o',
        'ControlPersist=10m',
      );
    }
    // key/agent 认证加 BatchMode 防交互式密码提示挂起(exec 无人应答);
    // password 认证走 sshpass(需要 prompt),不能加 BatchMode。
    if (this.target.authType !== 'password') {
      args.push('-o', 'BatchMode=yes');
    }
    args.push('-o', `ConnectTimeout=${SSH_CONNECT_TIMEOUT_S}`);
    args.push(`${this.target.username}@${this.target.host}`, command);

    let spawnCommand = sshPath;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') env[k] = v;
    }
    if (this.target.authType === 'password') {
      const sshpassPath = this.deps.resolveExecutable('sshpass');
      if (sshpassPath) {
        spawnCommand = sshpassPath;
        args.unshift('-e', sshPath);
        env.SSHPASS = this.target.password ?? '';
      } else if (!options.allowMissingSshpass) {
        throw ioError(
          `[SessionFs] 未找到 sshpass,无法用密码认证读取远端文件(host="${this.target.host}")。 ` +
            'Possible causes: sshpass 未安装。安装它,或把该 profile 改为 key/agent 认证, ' +
            '或开启 ControlMaster(settings.advanced,默认开)让读取复用交互终端的控制连接。',
        );
      }
    }

    const child = this.deps.spawn(spawnCommand, args, { env });
    const stdout: Buffer[] = [];
    const stderr: string[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, SSH_EXEC_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')));
    const code = await new Promise<number | null>((resolveExit) => {
      child.on('error', (err) => {
        logger.error(MODULE, `ssh exec spawn error: ${err.message}`);
        resolveExit(-1);
      });
      child.on('close', (exitCode) => resolveExit(exitCode));
    });
    clearTimeout(timer);
    if (timedOut) {
      throw ioError(
        `[SessionFs] 远端命令超时(${SSH_EXEC_TIMEOUT_MS}ms): host="${this.target.host}" command="${command.slice(0, 60)}". ` +
          'Possible causes: (1) 网络极慢, (2) 远端 shell 卡死, (3) ControlMaster 控制连接僵死。重试或检查网络。',
      );
    }
    if (code !== 0) {
      throw ioError(
        `[SessionFs] 远端命令失败(exit=${code}): host="${this.target.host}" command="${command.slice(0, 60)}" ` +
          `stderr="${stderr.join('').slice(0, 200)}". ` +
          'Possible causes: (1) 连接/认证失败, (2) 远端缺少 POSIX 工具(stat/head/base64), ' +
          '(3) 远端为 Windows 主机(不支持 POSIX 工具,方案 §6 边界)。',
      );
    }
    return { stdout: Buffer.concat(stdout), stderr: stderr.join(''), code };
  }
}

/** 创建 SSH 视角实例。FilePanelService 按 session 缓存(见其 fsFor)。 */
export function createSshSessionFs(target: SshSessionFsTarget, deps: SshSessionFsDeps): SessionFs {
  return new SshSessionFs(target, deps);
}
