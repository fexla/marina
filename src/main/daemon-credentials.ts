/**
 * @file src/main/daemon-credentials.ts
 * @purpose daemon 端 token 的持久化管理(safeStorage 加密)。
 *
 * @关键设计:
 * - daemon 启动需要稳定的 token,使得 client 配对一次后,daemon 重启无需重新配对
 *   (软件定义书 §14.9.4)。所以 token 必须**跨 daemon 进程重启保持不变**。
 * - token 是 daemon 的"身份凭证",任何拿到它的 client 都能连上 daemon。因此
 *   落盘时必须用 safeStorage 加密(Windows = DPAPI),不能明文存。
 * - 文件:%APPDATA%/Marina/marina-daemon-credentials.json
 *   内容:{ version, tokenEncrypted(base64), generatedAt(ISO) }
 * - safeStorage 不可用时(如 Linux 无 libsecret):回退明文 + warn 日志。
 *   daemon 主场景是 Windows(DPAPI 必可用),Linux 是 dev/测试场景,明文可接受。
 *   明文回退会在文件里写 tokenPlain 字段(而非 tokenEncrypted),加载时识别。
 *
 * @对应文档:软件定义书 §14.9.4 / ADR-014;方案-远程后端 §XI 决议 #2
 *
 * @不要在这里做的事:
 * - 不要管 client 端 profile 存储(那是 remote-profile-manager.ts 的职责)
 * - 不要管 WS 握手(那是 remote-daemon.ts)
 * - 不要管 TLS / 证书(阶段2b 决策中)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * safeStorage 的最小抽象,便于测试注入(测试环境无 Electron)。
 * 与 Electron safeStorage API 形状一致。
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** 加载/生成的结果。token 是明文(仅在 daemon 内存中)。 */
export interface DaemonCredentials {
  /** 明文 token,daemon 用来校验 client 握手。 */
  token: string;
  /** token 生成时间(ISO),用于 UI 展示"配对于 X"。 */
  generatedAt: string;
}

export interface DaemonCredentialsLoadResult extends DaemonCredentials {
  /** true = 本次启动新生成(首次 / 文件损坏 / 被重置后);false = 从盘上加载。 */
  isNew: boolean;
  /**
   * true = 当前用明文回退存储(safeStorage 不可用)。UI 应提示用户"凭据未加密"。
   * Windows / macOS 永远 false。
   */
  storedPlaintext: boolean;
}

const FILENAME = 'marina-daemon-credentials.json';
const CURRENT_VERSION = 1;

interface StoredFile {
  version: number;
  /** safeStorage.encryptString(token).toString('base64')。 */
  tokenEncrypted?: string;
  /** safeStorage 不可用时的明文回退(仅 Linux dev)。 */
  tokenPlain?: string;
  generatedAt: string;
}

function filePath(userDataDir: string): string {
  return path.join(userDataDir, FILENAME);
}

/**
 * 加载 daemon 凭据;不存在 / 损坏 / safeStorage 解密失败时,生成新的并落盘。
 *
 * 幂等:多次调用返回同一文件内容(除非文件被外部删除)。
 */
export async function loadOrGenerateDaemonCredentials(
  userDataDir: string,
  safe: SafeStorageLike,
): Promise<DaemonCredentialsLoadResult> {
  const file = filePath(userDataDir);
  const loaded = await tryLoad(file, safe);
  if (loaded) {
    return { ...loaded, isNew: false };
  }
  // 生成新的
  const creds = generateFresh();
  const storedPlaintext = !safe.isEncryptionAvailable();
  await writeCreds(file, creds, safe);
  return { ...creds, isNew: true, storedPlaintext };
}

/**
 * 重置 token(吊销所有已配对 client)。生成新 token + 新 generatedAt,落盘。
 * 已连的 client 下次握手会因 token 不匹配被拒(4003),触发 client 端“需重新配对”提示。
 */
export async function resetDaemonCredentials(
  userDataDir: string,
  safe: SafeStorageLike,
): Promise<DaemonCredentialsLoadResult> {
  const creds = generateFresh();
  await writeCreds(filePath(userDataDir), creds, safe);
  return { ...creds, isNew: true, storedPlaintext: !safe.isEncryptionAvailable() };
}

/**
 * 用户自设密码(覆盖自动生成的 token)。明文 plaintext 经 safeStorage 加密落盘。
 * generatedAt 用当下(标记为“用户设置”)。返回的 token === plaintext。
 * 空字符串 → 拒绝(密码不能为空)。
 */
export async function setDaemonPassword(
  userDataDir: string,
  safe: SafeStorageLike,
  plaintext: string,
): Promise<DaemonCredentialsLoadResult> {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('[daemon-credentials] 密码不能为空');
  }
  const creds: DaemonCredentials = { token: plaintext, generatedAt: new Date().toISOString() };
  await writeCreds(filePath(userDataDir), creds, safe);
  return { ...creds, isNew: true, storedPlaintext: !safe.isEncryptionAvailable() };
}

async function tryLoad(
  file: string,
  safe: SafeStorageLike,
): Promise<(DaemonCredentials & { storedPlaintext: boolean }) | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return null; // 首次启动,文件不存在
  }
  let parsed: StoredFile;
  try {
    parsed = JSON.parse(raw) as StoredFile;
  } catch {
    // 文件损坏(JSON 不合法)→ 当作不存在,走生成路径
    return null;
  }
  if (parsed.version !== CURRENT_VERSION || !parsed.generatedAt) {
    return null;
  }
  // 优先解密;无加密字段时尝试明文回退
  if (typeof parsed.tokenEncrypted === 'string' && safe.isEncryptionAvailable()) {
    try {
      const token = safe.decryptString(Buffer.from(parsed.tokenEncrypted, 'base64'));
      return { token, generatedAt: parsed.generatedAt, storedPlaintext: false };
    } catch {
      // 解密失败(eg. 文件从另一台机器拷来,DPAPI key 不同)→ 走生成路径
      return null;
    }
  }
  if (typeof parsed.tokenPlain === 'string') {
    return { token: parsed.tokenPlain, generatedAt: parsed.generatedAt, storedPlaintext: true };
  }
  return null;
}

async function writeCreds(
  file: string,
  creds: DaemonCredentials,
  safe: SafeStorageLike,
): Promise<void> {
  const stored: StoredFile = {
    version: CURRENT_VERSION,
    generatedAt: creds.generatedAt,
  };
  if (safe.isEncryptionAvailable()) {
    stored.tokenEncrypted = safe.encryptString(creds.token).toString('base64');
  } else {
    stored.tokenPlain = creds.token;
  }
  // 原子写:先写临时文件再 rename,避免 daemon 崩溃留下半截文件
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(stored, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

function generateFresh(): DaemonCredentials {
  // token 用 UUID v4(122 位熵),足够防爆破;配对时一次性展示给用户输入。
  return { token: randomUUID(), generatedAt: new Date().toISOString() };
}
