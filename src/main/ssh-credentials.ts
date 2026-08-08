/**
 * @file src/main/ssh-credentials.ts
 * @purpose SSH profile 密码的 safeStorage 解密小工具,供 index.ts(装配远程 sudo
 *   的 sshProfileLookup)与 ipc.ts(SESSION_CREATE 解密)共用,避免解密逻辑散落
 *   两处。加密仍留在 ipc.ts(含 IpcError 语义,不动)。
 *
 * @关键设计:与 daemon-credentials.ts 同哲学——密钥落盘 safeStorage 加密,明文
 *   只在 main 内存。此处只做「读出来用」的解密;不解密时不抛(返回 {}),由调用
 *   方决定降级(走交互式密码输入 / 拒绝)。
 *
 * @对应文档: AGENTS.md 附录 H(隐私);docs/方案-命令面板远程sudo-20260807.md §5。
 */
import type { SafeStorageLike } from './daemon-credentials';

/**
 * 解密 safeStorage 加密的 SSH 密码(base64)。safeStorage 不可用或解密失败(文件
 * 来自另一台机器 / DPAPI key 不同)时返回 {}(无 password 字段),不抛。
 */
export function decryptStoredPassword(blob: string, safe: SafeStorageLike): { password?: string } {
  if (!safe.isEncryptionAvailable()) return {};
  try {
    return { password: safe.decryptString(Buffer.from(blob, 'base64')) };
  } catch {
    return {};
  }
}
