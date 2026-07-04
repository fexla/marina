/**
 * @file src/main/known-hosts-manager.ts
 * @purpose 读 ~/.ssh/known_hosts 解析出每个 host 的指纹清单,并跟 Marina
 *   自管的 known-hosts-history.json 比对 — 指纹变化即记 timeline 条目,
 *   未来 HostKeyPromptModal(阶段 3 后续工单)消费这份历史做 MITM 警告。
 *
 * SSH 方案 v2.1 §阶段 3.1 范围:
 * - ✅ 读 ~/.ssh/known_hosts(plaintext + hashed entries 都列;hashed 时
 *   alias 不可逆,我们存 hash 原文给前端展示)
 * - ✅ 计算 SHA256 指纹(`SHA256:base64`,跟 OpenSSH 8.x+ 默认显示格式一致)
 * - ✅ 历史 timeline(host → 指纹变化时间戳数组)
 * - ❌ 写回 known_hosts(超阶段 3.1 范围,留给 HostKeyPromptModal)
 * - ❌ 拦截 ssh CLI 首次连接 "Are you sure" prompt(同上,留后续)
 */
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { JsonStore } from './persistence';
import { logger } from './logger';

/** 一条 known_hosts 行解析后的形状。 */
export interface KnownHostEntry {
  /**
   * 原始 host 字段(逗号分隔的多 host / IP / `[host]:port`)。hashed 时是
   * `|1|salt|hash` 形式,Marina 不还原 — 直接展示。
   */
  hosts: string;
  /** 'ssh-rsa' / 'ssh-ed25519' / 'ecdsa-sha2-nistp256' 等 */
  keyType: string;
  /**
   * SHA256 公钥指纹,格式 `SHA256:<base64>`,与 `ssh-keygen -lf` 输出一致。
   * 用于 UI 对比 + 历史比对。
   */
  fingerprint: string;
  /** known_hosts 文件路径(诊断 / UI tooltip) */
  sourceFile: string;
  /** 是否 hashed host(以 `|1|` 开头) */
  isHashed: boolean;
}

/**
 * 指纹历史记录文件 schema(known-hosts-history.json)。
 *
 * 设计:host 字符串(已 normalize:括号 / port / 多个逗号都保留原文)→
 * 指纹时间线数组。新指纹追加,旧条目保留。MITM 警告条件:host 当前指纹
 * != 最后一条 history fingerprint。
 */
export interface KnownHostsHistoryFile {
  version: 1;
  entries: Array<{
    host: string;
    /** 多种 keyType 共存的 host 用 fingerprint 唯一标识;按发现顺序 append */
    timeline: Array<{
      fingerprint: string;
      keyType: string;
      /** Unix ms;Marina 首次看到此指纹的时间(不是 known_hosts 文件本身的 mtime) */
      firstSeenAt: number;
    }>;
  }>;
}

const DEFAULT_HISTORY: KnownHostsHistoryFile = { version: 1, entries: [] };

export class KnownHostsManager extends EventEmitter {
  private history: KnownHostsHistoryFile = { ...DEFAULT_HISTORY };

  constructor(private readonly historyStore: JsonStore<KnownHostsHistoryFile>) {
    super();
  }

  async initialize(): Promise<void> {
    const loaded = await this.historyStore.load(DEFAULT_HISTORY);
    this.history = { version: 1, entries: loaded.value.entries.slice() };
  }

  async flush(): Promise<void> {
    await this.historyStore.flush();
  }

  /**
   * 主入口:读当前 ~/.ssh/known_hosts → 返回解析结果 + 与历史 diff 后的
   * "指纹变化"事件列表。调用方决定怎么展示(列表 / 弹 modal / 写 log)。
   *
   * 这一次读会更新内部 history(并落盘),把新出现的指纹追加到 timeline。
   * 已存在的 host:fingerprint 不重复追加。
   */
  refresh(opts?: { path?: string }): {
    entries: KnownHostEntry[];
    changes: Array<{
      host: string;
      previousFingerprint: string;
      newFingerprint: string;
      keyType: string;
    }>;
  } {
    const path = opts?.path ?? defaultKnownHostsPath();
    const entries = parseKnownHostsFile(path);
    const changes: Array<{
      host: string;
      previousFingerprint: string;
      newFingerprint: string;
      keyType: string;
    }> = [];

    for (const entry of entries) {
      const histIdx = this.history.entries.findIndex((h) => h.host === entry.hosts);
      if (histIdx < 0) {
        // 首次看到 host,创建 timeline
        this.history.entries.push({
          host: entry.hosts,
          timeline: [
            {
              fingerprint: entry.fingerprint,
              keyType: entry.keyType,
              firstSeenAt: Date.now(),
            },
          ],
        });
        continue;
      }
      const hist = this.history.entries[histIdx]!;
      const same = hist.timeline.find(
        (t) => t.fingerprint === entry.fingerprint && t.keyType === entry.keyType,
      );
      if (same) continue;
      // 指纹变了 — 把之前 timeline 最后一条作为 "previous" 报告,然后 append
      const last = hist.timeline[hist.timeline.length - 1];
      if (last && last.keyType === entry.keyType) {
        changes.push({
          host: entry.hosts,
          previousFingerprint: last.fingerprint,
          newFingerprint: entry.fingerprint,
          keyType: entry.keyType,
        });
      }
      hist.timeline.push({
        fingerprint: entry.fingerprint,
        keyType: entry.keyType,
        firstSeenAt: Date.now(),
      });
    }

    this.persist();
    return { entries, changes };
  }

  /** 测试 / 诊断:列出当前 history 浅拷贝 */
  listHistory(): KnownHostsHistoryFile {
    return {
      version: 1,
      entries: this.history.entries.map((e) => ({
        host: e.host,
        timeline: e.timeline.map((t) => ({ ...t })),
      })),
    };
  }

  private persist(): void {
    this.historyStore.set({
      version: 1,
      entries: this.history.entries.map((e) => ({
        host: e.host,
        timeline: e.timeline.map((t) => ({ ...t })),
      })),
    });
  }
}

/** 默认 known_hosts 路径(POSIX / Windows 都用 ~/.ssh/known_hosts) */
export function defaultKnownHostsPath(): string {
  return join(homedir(), '.ssh', 'known_hosts');
}

/**
 * 直接解析一个 known_hosts 文件,不更新 history。给前端展示用的纯函数。
 * 文件不存在 / 读失败返回 []。
 */
export function parseKnownHostsFile(path: string): KnownHostEntry[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    logger.warn(
      'KnownHostsManager',
      `读 known_hosts 失败:${path} (${err instanceof Error ? err.message : String(err)})`,
    );
    return [];
  }
  const result: KnownHostEntry[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('@')) {
      // `@cert-authority` / `@revoked` 跳过 — 它们不是普通主机条目
      continue;
    }
    const parts = line.split(/\s+/);
    // 标准格式:hosts keytype base64key [comment]
    if (parts.length < 3) continue;
    const [hosts, keyType, keyData] = parts as [string, string, string];
    if (!hosts || !keyType || !keyData) continue;
    let keyBytes: Buffer;
    try {
      keyBytes = Buffer.from(keyData, 'base64');
    } catch {
      continue;
    }
    if (keyBytes.length === 0) continue;
    const sha = createHash('sha256').update(keyBytes).digest('base64').replace(/=+$/, '');
    result.push({
      hosts,
      keyType,
      fingerprint: `SHA256:${sha}`,
      sourceFile: path,
      isHashed: hosts.startsWith('|1|'),
    });
  }
  return result;
}
