/**
 * @file src/main/ssh-agent.ts
 * @purpose 探测 ssh-agent 是否在运行,如果在则跑 `ssh-add -l` 列出 agent 已加载
 *   的密钥。SSH 方案 v2.1 §阶段 2.2。
 *
 * 探测策略:
 * - POSIX:看 `process.env.SSH_AUTH_SOCK`(agent 在 unix socket 上监听)。
 * - Windows:看 OpenSSH Authentication Agent 服务是否在跑,或 SSH_AUTH_SOCK
 *   是否存在(WSL2 / msys / git-bash 等场景)。简化做法:只要 `ssh-add -l`
 *   exit 0/1 就视为 agent 可用(0 = 有 key,1 = 无 key,2 = 无 agent)。
 *
 * 实现选择:不直接调用 PuTTY pageant 或 Windows 服务 API,统一委托给
 * `ssh-add -l` 这个 OpenSSH 自带 CLI。优点:
 * - 平台无差异
 * - 自动尊重 SSH_AUTH_SOCK / 系统默认 agent
 * - 不需要额外依赖
 *
 * @调用约定
 *   不会抛(返回 status='agent-missing' 兜底)。响应可以直接经 IPC 给 renderer。
 */
import { spawnSync } from 'node:child_process';
import { logger } from './logger';

export interface SshAgentKey {
  /** key bit length(2048 / 256 / 3072 等) */
  bits: number;
  /** SHA256:base64 指纹(与 KnownHostsManager 一致) */
  fingerprint: string;
  /** 用户填的注释(通常是 user@host) */
  comment: string;
  /** key 类型,如 (RSA) / (ED25519) — ssh-add -l 用括号给出 */
  keyType: string;
}

export type SshAgentStatus =
  | { status: 'agent-running'; keys: SshAgentKey[] }
  | {
      status: 'agent-missing';
      /** 给前端展示的友好原因:'no-socket' / 'cli-missing' / 'cli-failed' */
      reason: 'no-socket' | 'cli-missing' | 'cli-failed';
      message: string;
    };

/**
 * 主入口。同步阻塞最多 ~3 秒(ssh-add CLI 一般 <100ms 返回)。
 * 不抛,任何错误退化为 status='agent-missing'。
 */
export function detectSshAgent(opts?: {
  /** 给测试用:覆盖 spawnSync 行为 */
  runner?: (file: string, args: string[]) => {
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error;
  };
  /** 给测试用:覆盖环境变量探测 */
  env?: Record<string, string | undefined>;
}): SshAgentStatus {
  const env = opts?.env ?? process.env;
  const runner =
    opts?.runner ??
    ((file, args) => {
      const r = spawnSync(file, args, {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
      });
      return {
        status: r.status,
        stdout: r.stdout ?? '',
        stderr: r.stderr ?? '',
        ...(r.error ? { error: r.error } : {}),
      };
    });

  // 1) Windows / WSL 上 SSH_AUTH_SOCK 可能不存在,但 Windows OpenSSH Service
  //    仍能让 ssh-add 工作(走 named pipe);所以不能只靠 socket 判断 — 直接
  //    跑 ssh-add -l。
  // 2) POSIX 上没 SSH_AUTH_SOCK 通常意味着没 agent,提前 short-circuit 省下
  //    一次 spawn(ssh-add 会失败但返回 2)。
  if (process.platform !== 'win32' && !env['SSH_AUTH_SOCK']) {
    return {
      status: 'agent-missing',
      reason: 'no-socket',
      message: 'SSH_AUTH_SOCK 未设置,ssh-agent 未运行(执行 `eval $(ssh-agent)` 启动)',
    };
  }

  let result;
  try {
    result = runner('ssh-add', ['-l']);
  } catch (err) {
    logger.warn(
      'SshAgent',
      `ssh-add -l 调用异常:${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      status: 'agent-missing',
      reason: 'cli-failed',
      message: `ssh-add 调用失败:${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (result.error) {
    // ENOENT — ssh-add 不在 PATH 上(很少见,因为带 OpenSSH client 一定带 ssh-add)
    return {
      status: 'agent-missing',
      reason: 'cli-missing',
      message: `未找到 ssh-add(${result.error.message});请确认 OpenSSH 客户端已安装且在 PATH 上`,
    };
  }

  if (result.status === 2) {
    return {
      status: 'agent-missing',
      reason: 'no-socket',
      message: `ssh-agent 未运行(ssh-add 退出码 2;stderr=${result.stderr.trim()})`,
    };
  }

  // status 1:agent 在运行但没 key(空 agent),仍算 'agent-running' + keys=[]
  if (result.status === 1) {
    return { status: 'agent-running', keys: [] };
  }

  // status 0:成功,解析 stdout 每行
  if (result.status === 0) {
    return { status: 'agent-running', keys: parseSshAddOutput(result.stdout) };
  }

  return {
    status: 'agent-missing',
    reason: 'cli-failed',
    message: `ssh-add 返回非预期退出码 ${result.status}(stderr=${result.stderr.trim()})`,
  };
}

/**
 * 解析 `ssh-add -l` 输出。每行格式:`<bits> <fingerprint> <comment> (<keyType>)`
 *
 * 例:
 *   `256 SHA256:AbCdEf... alice@thinkpad (ED25519)`
 *   `2048 SHA256:XyZ123... ci-bot@build-01 (RSA)`
 */
export function parseSshAddOutput(stdout: string): SshAgentKey[] {
  const out: SshAgentKey[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // 正则:bits<space>fingerprint<space>...comment...<space>(<keyType>)
    const m = trimmed.match(/^(\d+)\s+(\S+)\s+(.+)\s+\(([^)]+)\)\s*$/);
    if (!m) continue;
    const bits = Number.parseInt(m[1]!, 10);
    if (!Number.isFinite(bits)) continue;
    out.push({
      bits,
      fingerprint: m[2]!,
      comment: m[3]!.trim(),
      keyType: m[4]!,
    });
  }
  return out;
}
