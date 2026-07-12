/**
 * @file src/main/remote-profile-manager.test.ts
 * @purpose RemoteProfileManager 单测:CRUD / tokenEncrypted 剥离 / 校验 / 持久化 / 事件。
 *   用内存 fake JsonStore,不碰磁盘。(每窗口后端模型已删全局 active,无 active 测试。)
 */
import { describe, it, expect, vi } from 'vitest';
import { RemoteProfileManager, RemoteProfileManagerError } from './remote-profile-manager';
import type { RemoteDaemonProfile, RemoteDaemonProfilesFile } from '@shared/types';
import type { JsonStore } from './persistence';

/** 内存 fake JsonStore,实现 manager 用到的 load/set/flush/getInMemory。 */
function makeFakeStore(
  initial: RemoteDaemonProfilesFile = { version: 1, profiles: [] },
): JsonStore<RemoteDaemonProfilesFile> & { captured: RemoteDaemonProfilesFile[] } {
  let value = initial;
  const captured: RemoteDaemonProfilesFile[] = [];
  return {
    async load() {
      return { value, source: 'main' as const };
    },
    set(v: RemoteDaemonProfilesFile) {
      value = v;
      captured.push(JSON.parse(JSON.stringify(v)));
    },
    async flush() {},
    getInMemory() {
      return value;
    },
    captured,
  } as unknown as JsonStore<RemoteDaemonProfilesFile> & { captured: RemoteDaemonProfilesFile[] };
}

function baseInput(): Omit<RemoteDaemonProfile, 'id' | 'addedAt'> {
  return {
    displayName: '工作笔记本',
    host: '192.168.1.10',
    tokenEncrypted: 'enc-base64-fake',
  };
}

async function makeManager() {
  const store = makeFakeStore();
  const mgr = new RemoteProfileManager(store);
  await mgr.initialize();
  return { mgr, store };
}

describe('RemoteProfileManager CRUD', () => {
  it('add:生成 id + addedAt,返回 public 副本(剥去 tokenEncrypted + hasToken=true)', async () => {
    const { mgr } = await makeManager();
    const p = mgr.add(baseInput());
    expect(p.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.addedAt).toBeGreaterThan(0);
    expect(p.displayName).toBe('工作笔记本');
    expect((p as RemoteDaemonProfile).tokenEncrypted).toBeUndefined();
    expect(p.hasToken).toBe(true);
  });

  it('list:返回 public 副本数组(tokenEncrypted 全剥)', async () => {
    const { mgr } = await makeManager();
    mgr.add(baseInput());
    mgr.add({ ...baseInput(), displayName: '家里台式' });
    const all = mgr.list();
    expect(all).toHaveLength(2);
    expect(all.every((p) => p.tokenEncrypted === undefined)).toBe(true);
    expect(all.every((p) => p.hasToken === true)).toBe(true);
  });

  it('getInternal:返回含 tokenEncrypted 的完整 profile(main 内部用)', async () => {
    const { mgr } = await makeManager();
    const p = mgr.add(baseInput());
    const internal = mgr.getInternal(p.id)!;
    expect(internal.tokenEncrypted).toBe('enc-base64-fake');
  });

  it('update:合并字段,重新校验;tokenEncrypted 可单独更新', async () => {
    const { mgr } = await makeManager();
    const p = mgr.add(baseInput());
    const updated = mgr.update(p.id, { displayName: '公司笔记本', tokenEncrypted: 'new-enc' });
    expect(updated.displayName).toBe('公司笔记本');
    expect(mgr.getInternal(p.id)!.tokenEncrypted).toBe('new-enc');
  });

  it('update 不存在的 id → RemoteProfileNotFound', async () => {
    const { mgr } = await makeManager();
    expect(() => mgr.update('nope', { displayName: 'x' })).toThrow(RemoteProfileManagerError);
    expect(() => mgr.update('nope', { displayName: 'x' })).toThrow(/RemoteProfileNotFound/);
  });

  it('delete:移除 profile', async () => {
    const { mgr } = await makeManager();
    const p = mgr.add(baseInput());
    mgr.delete(p.id);
    expect(mgr.list()).toHaveLength(0);
    expect(mgr.get(p.id)).toBeNull();
  });

  it('delete 不存在的 id → RemoteProfileNotFound', async () => {
    const { mgr } = await makeManager();
    expect(() => mgr.delete('nope')).toThrow(/RemoteProfileNotFound/);
  });
});

describe('RemoteProfileManager 校验', () => {
  it('displayName 空 → InvalidRemoteProfile', async () => {
    const { mgr } = await makeManager();
    expect(() => mgr.add({ ...baseInput(), displayName: '   ' })).toThrow(/InvalidRemoteProfile/);
  });

  it('host 含空白 → InvalidRemoteProfile', async () => {
    const { mgr } = await makeManager();
    expect(() => mgr.add({ ...baseInput(), host: 'has space' })).toThrow(/InvalidRemoteProfile/);
  });

  it('port 越界(0 / 65536)→ InvalidRemoteProfile', async () => {
    // port 已废(client 扫描 12580 起一段,profile 不存 port)。该校验已删,
    // 此测试保留为历史记录占位 —— 实际 port 字段已从类型移除,add 不接受 port。
    expect(true).toBe(true);
  });
});

describe('RemoteProfileManager 持久化 + 事件', () => {
  it('add/update/delete 都触发 persist(set 调用)', async () => {
    const { mgr, store } = await makeManager();
    expect(store.captured).toHaveLength(0);
    const p = mgr.add(baseInput());
    mgr.update(p.id, { displayName: 'Y' });
    mgr.delete(p.id);
    expect(store.captured.length).toBeGreaterThanOrEqual(3);
  });

  it('每次操作触发 changed 事件', async () => {
    const { mgr } = await makeManager();
    const handler = vi.fn();
    mgr.on('changed', handler);
    const p = mgr.add(baseInput());
    mgr.update(p.id, { displayName: 'Z' });
    mgr.delete(p.id);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('persist 写入的文件不含 activeProfileId(已废)', async () => {
    const { mgr, store } = await makeManager();
    mgr.add(baseInput());
    const last = store.captured[store.captured.length - 1]!;
    // 每窗口后端模型:文件只含 version + profiles,无 activeProfileId(已废)
    expect(Object.keys(last).sort()).toEqual(['profiles', 'version']);
    expect(last.version).toBe(1);
    expect(last.profiles).toHaveLength(1);
  });

  it('兼容:旧文件含 activeProfileId 时 initialize 忽略它(不报错)', async () => {
    const store = makeFakeStore({
      version: 1,
      activeProfileId: 'legacy-id',
      profiles: [
        { id: 'persisted-id', displayName: 'X', host: 'h', port: 1, addedAt: 1 },
      ],
    } as unknown as RemoteDaemonProfilesFile);
    const mgr = new RemoteProfileManager(store);
    await expect(mgr.initialize()).resolves.toBe('main');
    expect(mgr.list()).toHaveLength(1);
  });
});
