/**
 * @file src/main/remote-profile-manager.ts
 * @purpose client 端"远程 daemon 连接 profile"的 CRUD 管理。
 *
 * @关键设计:
 * - 复用 JsonStore + EventEmitter 模式(对齐 SshProfileManager)。
 * - token **不在本模块加密**:add/update 接收已加密的 tokenEncrypted(由 ipc 层
 *   用 encryptPasswordOrThrow 加密),本模块只存。读取给 renderer 时剥去 tokenEncrypted,
 *   加 hasToken 标志(对齐 SSH password 模式)。
 * - **无全局 active**:每窗口独立连后端(WindowInfo.backendProfileId),后端选择
 *   是窗口属性不是全局状态(软件定义书原则4)。本模块只管 profile 列表 CRUD。
 *
 * @对应文档:软件定义书 §14.9.4 / ADR-014 / 阶段2 架构修正(每窗口后端)
 *
 * @不要在这里做的事:
 * - 不要加密 token(ipc 层做,同 SSH password)
 * - 不要建立 WS 连接(preload/RemoteTransport 做)
 * - 不要管 daemon 端凭据(daemon-credentials.ts)
 * - 不要管"当前连哪个"(那是 WindowManager 的窗口属性)
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type {
  RemoteDaemonProfile,
  RemoteDaemonProfilesFile,
} from '@shared/types';
import type { JsonStore } from './persistence';

const DEFAULT_FILE: RemoteDaemonProfilesFile = { version: 1, profiles: [] };

export class RemoteProfileManagerError extends Error {
  constructor(
    public readonly code:
      | 'RemoteProfileNotFound'
      | 'InvalidRemoteProfile'
      | 'RemoteProfileInUse',
    message: string,
  ) {
    super(`[RemoteProfileManager] ${code}: ${message}`);
    this.name = 'RemoteProfileManagerError';
  }
}

/**
 * 管理 client 端的远程 daemon profile 列表(纯 CRUD)。
 * 事件:'changed'(增删改时触发,renderer 刷新 profile 列表)。
 */
export class RemoteProfileManager extends EventEmitter {
  private profiles: RemoteDaemonProfile[] = [];

  constructor(private readonly store: JsonStore<RemoteDaemonProfilesFile>) {
    super();
  }

  async initialize(): Promise<'main' | 'bak' | 'default'> {
    const loaded = await this.store.load(DEFAULT_FILE);
    const file = loaded.value;
    this.profiles = Array.isArray(file.profiles) ? file.profiles : [];
    // 兼容:旧版本文件可能含 activeProfileId(全局 active 已废),忽略它。
    return loaded.source;
  }

  async flush(): Promise<void> {
    await this.store.flush();
  }

  /** 给 renderer 用:剥去 tokenEncrypted,加 hasToken。 */
  list(): RemoteDaemonProfile[] {
    return this.profiles.map((p) => toPublic(p));
  }

  /** main 内部用:返回含 tokenEncrypted 的完整 profile(ipc GET_CONNECTION 解密 token 用)。 */
  getInternal(id: string): RemoteDaemonProfile | null {
    const f = this.profiles.find((p) => p.id === id);
    return f ? { ...f } : null;
  }

  get(id: string): RemoteDaemonProfile | null {
    const f = this.profiles.find((p) => p.id === id);
    return f ? toPublic(f) : null;
  }

  /**
   * 新增 profile。input.tokenEncrypted 由 ipc 层加密后传入(明文 token 不进本模块)。
   */
  add(input: Omit<RemoteDaemonProfile, 'id' | 'addedAt'>): RemoteDaemonProfile {
    const profile = validateProfile({
      ...input,
      id: randomUUID(),
      addedAt: Date.now(),
    });
    this.profiles.push(profile);
    this.persist();
    this.emit('changed');
    return toPublic(profile);
  }

  update(
    id: string,
    partial: Partial<Omit<RemoteDaemonProfile, 'id' | 'addedAt'>>,
  ): RemoteDaemonProfile {
    const idx = this.profiles.findIndex((p) => p.id === id);
    if (idx < 0) {
      throw new RemoteProfileManagerError('RemoteProfileNotFound', `id="${id}"`);
    }
    const merged = { ...this.profiles[idx]!, ...partial };
    this.profiles[idx] = validateProfile(merged);
    this.persist();
    this.emit('changed');
    return toPublic(this.profiles[idx]!);
  }

  delete(id: string): void {
    const idx = this.profiles.findIndex((p) => p.id === id);
    if (idx < 0) {
      throw new RemoteProfileManagerError('RemoteProfileNotFound', `id="${id}"`);
    }
    this.profiles.splice(idx, 1);
    this.persist();
    this.emit('changed');
  }

  private persist(): void {
    this.store.set({
      version: 1,
      profiles: this.profiles.map((p) => ({ ...p })),
    });
  }
}

/** 剥去敏感字段(tokenEncrypted),加 hasToken 标志,给 renderer。 */
function toPublic(p: RemoteDaemonProfile): RemoteDaemonProfile {
  const { tokenEncrypted, ...rest } = p;
  return { ...rest, hasToken: typeof tokenEncrypted === 'string' && tokenEncrypted.length > 0 };
}

/** 校验 + 规范化 profile 字段。tokenEncrypted 透传(已由 ipc 层加密)。 */
function validateProfile(input: RemoteDaemonProfile): RemoteDaemonProfile {
  const displayName = input.displayName.trim();
  const host = input.host.trim();
  const port = Math.trunc(input.port);
  if (!displayName || displayName.length > 100) {
    throw new RemoteProfileManagerError('InvalidRemoteProfile', 'displayName 必须为 1-100 字符');
  }
  if (!host || host.length > 255 || /[\s]/.test(host)) {
    throw new RemoteProfileManagerError('InvalidRemoteProfile', 'host 非法(不能含空白)');
  }
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new RemoteProfileManagerError('InvalidRemoteProfile', 'port 必须在 1-65535');
  }
  return {
    ...input,
    displayName,
    host,
    port,
  };
}
