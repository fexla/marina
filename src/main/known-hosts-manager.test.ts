/**
 * @file src/main/known-hosts-manager.test.ts
 * @purpose KnownHostsManager 单测(SSH 方案 v2.1 §阶段 3.1)。
 *
 * 用临时文件 + FakeJsonStore;parseKnownHostsFile 是纯函数也直接覆盖。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnownHostsManager, parseKnownHostsFile } from './known-hosts-manager';
import type { KnownHostsHistoryFile } from './known-hosts-manager';
import type { JsonStore } from './persistence';

class FakeJsonStore<T> {
  private current: T | null = null;
  public readonly setHistory: T[] = [];
  setInitial(value: T): void {
    this.current = value;
  }
  async load(defaultValue: T): Promise<{ value: T; source: 'main' | 'bak' | 'default' }> {
    if (this.current !== null) return { value: this.current, source: 'main' };
    return { value: defaultValue, source: 'default' };
  }
  set(value: T): void {
    this.current = value;
    this.setHistory.push(value);
  }
  async flush(): Promise<void> {
    /* no-op */
  }
}

// 一个合法的 ed25519 base64 公钥(伪造但形状对) — 32 字节随机数据
const FAKE_KEY_1 = Buffer.alloc(32, 0xaa).toString('base64');
const FAKE_KEY_2 = Buffer.alloc(32, 0xbb).toString('base64');

describe('parseKnownHostsFile — 解析 known_hosts 行', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'marina-kh-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('普通行解析为 KnownHostEntry,指纹是 SHA256:base64', () => {
    const path = join(dir, 'known_hosts');
    writeFileSync(path, `example.com ssh-ed25519 ${FAKE_KEY_1}\n`);
    const entries = parseKnownHostsFile(path);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.hosts).toBe('example.com');
    expect(entries[0]!.keyType).toBe('ssh-ed25519');
    expect(entries[0]!.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(entries[0]!.isHashed).toBe(false);
  });

  it('hashed host(|1|...|)识别为 isHashed=true', () => {
    const path = join(dir, 'known_hosts');
    writeFileSync(path, `|1|salt|hash ssh-rsa ${FAKE_KEY_1}\n`);
    const entries = parseKnownHostsFile(path);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.isHashed).toBe(true);
  });

  it('注释 / 空行 / @cert-authority @revoked 跳过', () => {
    const path = join(dir, 'known_hosts');
    writeFileSync(
      path,
      [
        '# top comment',
        '',
        '@cert-authority *.example.com ssh-ed25519 ' + FAKE_KEY_1,
        '@revoked olduser ssh-rsa ' + FAKE_KEY_1,
        `keep.example.com ssh-ed25519 ${FAKE_KEY_2}`,
      ].join('\n'),
    );
    const entries = parseKnownHostsFile(path);
    expect(entries.map((e) => e.hosts)).toEqual(['keep.example.com']);
  });

  it('文件不存在返回空数组(干净系统)', () => {
    const entries = parseKnownHostsFile(join(dir, 'missing'));
    expect(entries).toEqual([]);
  });
});

describe('KnownHostsManager — 指纹历史 + 变化检测', () => {
  let dir: string;
  let store: FakeJsonStore<KnownHostsHistoryFile>;
  let mgr: KnownHostsManager;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'marina-khm-'));
    store = new FakeJsonStore<KnownHostsHistoryFile>();
    mgr = new KnownHostsManager(store as unknown as JsonStore<KnownHostsHistoryFile>);
    await mgr.initialize();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('首次 refresh 把所有 host 写入 history,changes 为空', () => {
    const path = join(dir, 'known_hosts');
    writeFileSync(
      path,
      [
        `a.example.com ssh-ed25519 ${FAKE_KEY_1}`,
        `b.example.com ssh-rsa ${FAKE_KEY_2}`,
      ].join('\n'),
    );
    const { entries, changes } = mgr.refresh({ path });
    expect(entries).toHaveLength(2);
    expect(changes).toEqual([]);
    expect(mgr.listHistory().entries).toHaveLength(2);
  });

  it('同 host 同指纹再次 refresh 不重复 append,changes 仍为空', () => {
    const path = join(dir, 'known_hosts');
    writeFileSync(path, `same.example.com ssh-ed25519 ${FAKE_KEY_1}\n`);
    mgr.refresh({ path });
    const { changes } = mgr.refresh({ path });
    expect(changes).toEqual([]);
    expect(mgr.listHistory().entries[0]!.timeline).toHaveLength(1);
  });

  it('host 指纹变了 → changes 报告 previousFingerprint / newFingerprint', () => {
    const path = join(dir, 'known_hosts');
    writeFileSync(path, `mitm.example.com ssh-ed25519 ${FAKE_KEY_1}\n`);
    mgr.refresh({ path });
    writeFileSync(path, `mitm.example.com ssh-ed25519 ${FAKE_KEY_2}\n`);
    const { changes } = mgr.refresh({ path });
    expect(changes).toHaveLength(1);
    expect(changes[0]!.host).toBe('mitm.example.com');
    expect(changes[0]!.previousFingerprint).toMatch(/^SHA256:/);
    expect(changes[0]!.newFingerprint).toMatch(/^SHA256:/);
    expect(changes[0]!.previousFingerprint).not.toBe(changes[0]!.newFingerprint);
    // timeline 现在 2 条
    expect(mgr.listHistory().entries[0]!.timeline).toHaveLength(2);
  });

  it('history 跨重启恢复(从 store load)', async () => {
    const path = join(dir, 'known_hosts');
    writeFileSync(path, `persist.example.com ssh-ed25519 ${FAKE_KEY_1}\n`);
    mgr.refresh({ path });
    // 用 store 当前状态新建一个 mgr2,模拟重启
    const persisted = store.setHistory[store.setHistory.length - 1]!;
    const store2 = new FakeJsonStore<KnownHostsHistoryFile>();
    store2.setInitial(persisted);
    const mgr2 = new KnownHostsManager(
      store2 as unknown as JsonStore<KnownHostsHistoryFile>,
    );
    await mgr2.initialize();
    expect(mgr2.listHistory().entries[0]!.host).toBe('persist.example.com');
  });
});
