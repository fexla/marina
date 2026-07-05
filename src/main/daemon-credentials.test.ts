/**
 * @file src/main/daemon-credentials.test.ts
 * @purpose daemon 凭据持久化单测:首次生成 / 二次加载稳定 / 损坏恢复 /
 *   reset 吊销 / safeStorage 不可用明文回退 / 解密失败重新生成 / 原子写。
 *   用临时目录 + fake SafeStorageLike,不碰真实用户数据目录,不依赖 Electron。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  loadOrGenerateDaemonCredentials,
  resetDaemonCredentials,
  type SafeStorageLike,
} from './daemon-credentials';

/** 造一个 fake safeStorage:identity(不要求真加密,只为测逻辑)。 */
function makeFakeSafe(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain: string) => Buffer.from(plain, 'utf8'),
    decryptString: (buf: Buffer) => buf.toString('utf8'),
  };
}

/** 解密恒抛错的 fake(模拟 DPAPI key 不匹配 / 文件来自另一台机器)。 */
function makeFailingSafe(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (p: string) => Buffer.from(p, 'utf8'),
    decryptString: () => {
      throw new Error('decrypt failed');
    },
  };
}

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'marina-daemon-cred-test-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});
const credFile = (d: string) => path.join(d, 'marina-daemon-credentials.json');

describe('loadOrGenerateDaemonCredentials', () => {
  it('首次启动:生成新 token,isNew=true,落盘', async () => {
    const safe = makeFakeSafe();
    const r = await loadOrGenerateDaemonCredentials(dir, safe);
    expect(r.isNew).toBe(true);
    expect(r.token).toMatch(/^[0-9a-f-]{36}$/); // UUID v4
    expect(r.generatedAt).toBeTruthy();
    expect(r.storedPlaintext).toBe(false);
    // 文件存在 + 加密字段
    const raw = JSON.parse(await fs.readFile(credFile(dir), 'utf8'));
    expect(raw.version).toBe(1);
    expect(raw.tokenEncrypted).toBeTruthy();
    expect(raw.tokenPlain).toBeUndefined();
  });

  it('二次启动:加载同一 token,isNew=false,token 不变', async () => {
    const safe = makeFakeSafe();
    const first = await loadOrGenerateDaemonCredentials(dir, safe);
    const second = await loadOrGenerateDaemonCredentials(dir, safe);
    expect(second.isNew).toBe(false);
    expect(second.token).toBe(first.token);
    expect(second.generatedAt).toBe(first.generatedAt);
  });

  it('文件损坏(JSON 不合法)→ 重新生成', async () => {
    const safe = makeFakeSafe();
    await loadOrGenerateDaemonCredentials(dir, safe);
    // 写坏文件
    await fs.writeFile(credFile(dir), '{ not valid json !!!', 'utf8');
    const r = await loadOrGenerateDaemonCredentials(dir, safe);
    expect(r.isNew).toBe(true);
    expect(r.token).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('safeStorage 不可用 → 明文回退落盘 + storedPlaintext=true', async () => {
    const safe = makeFakeSafe(false);
    const r = await loadOrGenerateDaemonCredentials(dir, safe);
    expect(r.storedPlaintext).toBe(true);
    const raw = JSON.parse(await fs.readFile(credFile(dir), 'utf8'));
    expect(raw.tokenEncrypted).toBeUndefined();
    expect(raw.tokenPlain).toBe(r.token);
  });

  it('safeStorage 不可用时写明文 → 后续仍能加载(明文路径)', async () => {
    const safe = makeFakeSafe(false);
    const first = await loadOrGenerateDaemonCredentials(dir, safe);
    const second = await loadOrGenerateDaemonCredentials(dir, safe);
    expect(second.token).toBe(first.token);
    expect(second.storedPlaintext).toBe(true);
  });

  it('safeStorage 解密失败(文件来自另一台机器)→ 重新生成', async () => {
    // 用正常 safe 写一个文件
    const writeSafe = makeFakeSafe();
    await loadOrGenerateDaemonCredentials(dir, writeSafe);
    // 用解密恒失败的 safe 加载
    const failSafe = makeFailingSafe();
    const r = await loadOrGenerateDaemonCredentials(dir, failSafe);
    expect(r.isNew).toBe(true);
  });

  it('version 不匹配的旧文件 → 重新生成', async () => {
    await fs.writeFile(
      credFile(dir),
      JSON.stringify({ version: 99, tokenEncrypted: 'xx', generatedAt: '2020-01-01' }),
      'utf8',
    );
    const safe = makeFakeSafe();
    const r = await loadOrGenerateDaemonCredentials(dir, safe);
    expect(r.isNew).toBe(true);
  });
});

describe('resetDaemonCredentials', () => {
  it('reset 生成新 token,与旧 token 不同', async () => {
    const safe = makeFakeSafe();
    const first = await loadOrGenerateDaemonCredentials(dir, safe);
    const after = await resetDaemonCredentials(dir, safe);
    expect(after.token).not.toBe(first.token);
    expect(after.isNew).toBe(true);
    // 后续加载拿到的是新 token
    const reload = await loadOrGenerateDaemonCredentials(dir, safe);
    expect(reload.token).toBe(after.token);
  });
});

describe('原子写', () => {
  it('写完后无残留 .tmp 文件', async () => {
    const safe = makeFakeSafe();
    await loadOrGenerateDaemonCredentials(dir, safe);
    const files = await fs.readdir(dir);
    expect(files).toEqual(['marina-daemon-credentials.json']);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
  });
});
