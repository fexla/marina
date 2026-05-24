/**
 * @file src/main/ssh-config-parser.ts
 * @purpose 解析 OpenSSH `ssh_config(5)` 的 Host 块,把每个具体主机暴露成
 *   Marina 可消费的 SshConfigEntry。
 *
 * 范围(SSH 方案 v2.1 §阶段 2.1):
 * - ✅ Host 块(忽略含 `*` `?` 的通配符 Host,因为没法当 profile 用)
 * - ✅ HostName / User / Port / IdentityFile / ProxyJump 五个最常用 key
 * - ✅ Include 指令(递归展开,深度上限 16,~ 展开 / 相对路径 base 是 ~/.ssh/)
 * - ❌ Match 块(语义复杂,需要 hostname/user 上下文,V1 不实现 — 跳过)
 * - ❌ 其他 200+ 个 ssh_config key(NetworkTimeout / Tunnel / RemoteForward
 *   …):非 connection 必需,Marina 不接管,直接由 ssh 自身读 ssh_config 时
 *   生效(因为 buildSshLaunchParams 不会显式覆盖)。
 *
 * 设计:
 * - 全程同步 fs 读(ssh_config 通常 < 5KB,Include 链通常 < 5 个文件)
 * - 文件不存在 / 读失败 → 返回空数组并 warn,不抛
 * - 解析采用最简朴方式:逐行 trim、跳注释 / 空行、按空白拆 key + value;
 *   value 单引号 / 双引号去包(OpenSSH 也支持但少见)
 * - 不实现 token 展开(%h / %p / %u 等)— 那是 ssh 自己 connect 时的事;
 *   Marina 只展示原值给用户
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { logger } from './logger';

const MAX_INCLUDE_DEPTH = 16;

/**
 * 从 ssh_config 派生的"具体主机条目"。每条对应一个或多个非通配 Host 名
 * (例如 `Host prod web1 web2` 拆 3 条同 settings 的 entry)。
 *
 * 与 Marina 自管的 SshProfile 是同源数据,但来源标记为 'ssh_config',前端
 * 把它做成只读 — 改 settings 请用户直接编辑 ~/.ssh/config。
 */
export interface SshConfigEntry {
  /** Host 别名(已展开,不含通配符) */
  alias: string;
  /** HostName = 真实主机名或 IP;缺省时回退到 alias(OpenSSH 行为) */
  hostName: string;
  /** User;缺省时 undefined,连接时由 OpenSSH 自身回退到 $USER */
  user?: string;
  /** Port;缺省 22 */
  port: number;
  /** IdentityFile(本地路径,~ 已展开);可能多个,数组顺序 = 原文件顺序 */
  identityFiles: string[];
  /** ProxyJump 主机列表,逗号分隔的原值拆数组 */
  proxyJump: string[];
  /** 该条目来源的 ssh_config 文件绝对路径(诊断用) */
  sourceFile: string;
}

/**
 * 解析入口。默认读 `~/.ssh/config`;传入自定义路径用于测试。
 *
 * @returns 解析出的 entry 列表;文件缺失返回 `[]`。永不抛 — 损坏行 / Include
 *   失败都退化为 warn + 跳过。
 */
export function parseSshConfig(opts?: {
  rootPath?: string;
  /** 给测试用:覆盖 fs.readFileSync 行为(返回内容或抛错) */
  readFile?: (p: string) => string;
}): SshConfigEntry[] {
  const root = opts?.rootPath ?? defaultSshConfigPath();
  const reader =
    opts?.readFile ??
    ((p: string) => {
      const st = statSync(p);
      if (!st.isFile()) throw new Error(`${p} 不是普通文件`);
      return readFileSync(p, 'utf8');
    });
  const entries: SshConfigEntry[] = [];
  parseFile(root, entries, reader, 0);
  return entries;
}

export function defaultSshConfigPath(): string {
  return join(homedir(), '.ssh', 'config');
}

function parseFile(
  filePath: string,
  out: SshConfigEntry[],
  reader: (p: string) => string,
  depth: number,
): void {
  if (depth > MAX_INCLUDE_DEPTH) {
    logger.warn(
      'SshConfigParser',
      `Include 深度超过 ${MAX_INCLUDE_DEPTH},跳过 ${filePath}(疑似循环引用)`,
    );
    return;
  }
  let raw: string;
  try {
    raw = reader(filePath);
  } catch (err) {
    if (depth === 0) {
      // 根文件不存在是常态(从来没用过 ssh 的用户),静默返回。
      return;
    }
    logger.warn(
      'SshConfigParser',
      `读 Include 文件失败,跳过:${filePath} (${err instanceof Error ? err.message : String(err)})`,
    );
    return;
  }
  const lines = raw.split(/\r?\n/);
  let currentHosts: string[] | null = null;
  let current: WorkingEntry | null = null;
  const baseDir = dirname(filePath);

  const flushCurrent = (): void => {
    if (!current || !currentHosts) return;
    for (const alias of currentHosts) {
      // 跳过通配符 Host(`*` / `?` / `!`),无法当具体 profile
      if (/[*?!]/.test(alias)) continue;
      out.push({
        alias,
        hostName: current.hostName || alias,
        ...(current.user ? { user: current.user } : {}),
        port: current.port,
        identityFiles: current.identityFiles.slice(),
        proxyJump: current.proxyJump.slice(),
        sourceFile: filePath,
      });
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parsed = parseLine(line);
    if (!parsed) continue;
    const keyLower = parsed.key.toLowerCase();

    if (keyLower === 'include') {
      // Include 路径支持 ~ 和 glob;V1 简化 — 只支持单文件,不展开 glob
      // (大多数用户的 Include 是单文件 / 已展开路径,glob 是少数派,留 V2)
      for (const includePath of resolveIncludePaths(parsed.value, baseDir)) {
        parseFile(includePath, out, reader, depth + 1);
      }
      continue;
    }

    if (keyLower === 'host') {
      flushCurrent();
      currentHosts = parsed.value.split(/\s+/).filter(Boolean);
      current = { hostName: '', port: 22, identityFiles: [], proxyJump: [] };
      continue;
    }

    if (keyLower === 'match') {
      // §阶段 2.1 范围外:Match 需要 connect 时上下文,V1 跳过整段。
      // 表现:Match 内的 settings 不被 Marina 看到,但 OpenSSH connect 时
      // 仍正常生效。用户感受 = 这部分配置不在 sidebar 显示但能连。
      flushCurrent();
      currentHosts = null;
      current = null;
      continue;
    }

    if (!current) continue; // Match 段内的 settings 直接忽略
    switch (keyLower) {
      case 'hostname':
        current.hostName = parsed.value;
        break;
      case 'user':
        current.user = parsed.value;
        break;
      case 'port': {
        const n = Number.parseInt(parsed.value, 10);
        if (Number.isFinite(n) && n >= 1 && n <= 65535) current.port = n;
        break;
      }
      case 'identityfile':
        current.identityFiles.push(expandTilde(parsed.value));
        break;
      case 'proxyjump':
        current.proxyJump.push(
          ...parsed.value.split(',').map((s) => s.trim()).filter(Boolean),
        );
        break;
      default:
        // 其他 key 透传给 ssh 自身处理 — Marina 不展示也不消费。
        break;
    }
  }
  flushCurrent();
}

interface WorkingEntry {
  hostName: string;
  user?: string;
  port: number;
  identityFiles: string[];
  proxyJump: string[];
}

/**
 * 解析单行:key + value。OpenSSH 支持 `Key Value`、`Key=Value`、
 * `Key "Quoted Value"`,这里覆盖前两种 + 单/双引号去包。
 */
function parseLine(line: string): { key: string; value: string } | null {
  // `Key=Value` 或 `Key Value`(允许多个空格 / tab)
  const eqIdx = line.indexOf('=');
  const wsIdx = line.search(/\s/);
  let splitAt: number;
  if (eqIdx > 0 && (wsIdx < 0 || eqIdx < wsIdx)) {
    splitAt = eqIdx;
  } else if (wsIdx > 0) {
    splitAt = wsIdx;
  } else {
    return null;
  }
  const key = line.slice(0, splitAt).trim();
  let value = line.slice(splitAt + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  if (!key || !value) return null;
  return { key, value };
}

function resolveIncludePaths(value: string, baseDir: string): string[] {
  // OpenSSH Include 默认相对 ~/.ssh/,而非当前文件目录(细节差异)。
  // 把绝对路径直接用、~ 展开、相对路径解释为 ~/.ssh/ 下。
  const expanded = expandTilde(value);
  if (isAbsolute(expanded)) return [expanded];
  const sshDir = join(homedir(), '.ssh');
  // 用 resolve 把相对路径锚到 ~/.ssh/(不是 baseDir,符合 OpenSSH 行为)
  // 留 baseDir 参数是为了未来扩展(例如 system-wide /etc/ssh/ssh_config 时
  // Include 相对解释规则不同)。
  void baseDir;
  return [resolve(sshDir, expanded)];
}

function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}
