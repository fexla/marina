/**
 * @file src/main/remote-profile-manager.test.ts
 * @purpose RemoteProfileManager 单测:CRUD / active 切换 / tokenEncrypted 剥离 /
 *   校验 / 事件触发。用内存 fake JsonStore,不碰磁盘。
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
    port: 12580,
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

  it('delete:移除;若删的是 active,active 清空', async () => {
    const { mgr } = await makeManager();
    const p = mgr.add(baseInput());
    mgr.setActiveProfile(p.id);
    mgr.delete(p.id);
    expect(mgr.list()).toHaveLength(0);
    expect(mgr.getActiveProfileId()).toBeUndefined();
  });

  it('delete 不存在的 id → RemoteProfileNotFound', async () => {
    const { mgr } = await makeManager();
    expect(() => mgr.delete('nope')).toThrow(/RemoteProfileNotFound/);
  });
});

describe('RemoteProfileManager active', () => {
  it('初始 active = undefined(本地模式)', async () => {
    const { mgr } = await makeManager();
    expect(mgr.getActiveProfileId()).toBeUndefined();
  });

  it('setActive 设 id;切回 undefined = 本地模式', async () => {
    const { mgr } = await makeManager();
    const p = mgr.add(baseInput());
    mgr.setActiveProfile(p.id);
    expect(mgr.getActiveProfileId()).toBe(p.id);
    mgr.setActiveProfile(undefined);
    expect(mgr.getActiveProfileId()).toBeUndefined();
  });

  it('setActive 不存在的 id → RemoteProfileNotFound', async () => {
    const { mgr } = await makeManager();
    expect(() => mgr.setActiveProfile('nope')).toThrow(/RemoteProfileNotFound/);
  });

  it('activeProfileId 从磁盘加载(持久化)', async () => {
    const store = makeFakeStore({
      version: 1,
      activeProfileId: 'persisted-id',
      profiles: [
        { id: 'persisted-id', displayName: 'X', host: 'h', port: 1, addedAt: 1 },
      ],
    });
    const mgr = new RemoteProfileManager(store);
    await mgr.initialize();
    expect(mgr.getActiveProfileId()).toBe('persisted-id');
    expect(mgr.list()).toHaveLength(1);
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
    const { mgr } = await makeManager();
    expect(() => mgr.add({ ...baseInput(), port: 0 })).toThrow(/InvalidRemoteProfile/);
    expect(() => mgr.add({ ...baseInput(), port: 65536 })).toThrow(/InvalidRemoteProfile/);
  });
});

describe('RemoteProfileManager 持久化 + 事件', () => {
  it('add/update/delete/setActive 都触发 persist(set 调用)', async () => {
    const { mgr, store } = await makeManager();
    expect(store.captured).toHaveLength(0);
    const p = mgr.add(baseInput());
    mgr.update(p.id, { displayName: 'Y' });
    mgr.setActiveProfile(p.id);
    mgr.delete(p.id);
    // add/update/setActive/delete 各一次 set
    expect(store.captured.length).toBeGreaterThanOrEqual(4);
  });

  it('每次操作触发 changed 事件', async () => {
    const { mgr } = await makeManager();
    const handler = vi.fn();
    mgr.on('changed', handler);
    const p = mgr.add(baseInput());
    mgr.update(p.id, { displayName: 'Z' });
    mgr.setActiveProfile(p.id);
    mgr.delete(p.id);
    expect(handler).toHaveBeenCalledTimes(4);
  });

  it('persist 写入的文件含 activeProfileId', async () => {
    const { mgr, store } = await makeManager();
    const p = mgr.add(baseInput());
    mgr.setActiveProfile(p.id);
    const last = store.captured[store.captured.length - 1]!;
    expect(last.activeProfileId).toBe(p.id);
    expect(last.version).toBe(1);
  });
});
