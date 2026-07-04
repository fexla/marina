import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { SshProfile, SshProfilesFile } from '@shared/types';
import { normalizeRemotePath } from '@shared/remote-path';
import type { JsonStore } from './persistence';

const DEFAULT_SSH_PROFILES_FILE: SshProfilesFile = { version: 1, profiles: [] };

export class SshProfileManagerError extends Error {
  constructor(
    public readonly code:
      | 'SshProfileNotFound'
      | 'InvalidSshProfile'
      | 'SshProfileInUse',
    message: string,
  ) {
    super(`[SshProfileManager] ${code}: ${message}`);
    this.name = 'SshProfileManagerError';
  }
}

export class SshProfileManager extends EventEmitter {
  private profiles: SshProfile[] = [];

  constructor(private readonly store: JsonStore<SshProfilesFile>) {
    super();
  }

  async initialize(): Promise<'main' | 'bak' | 'default'> {
    const loaded = await this.store.load(DEFAULT_SSH_PROFILES_FILE);
    this.profiles = validateProfilesArray(loaded.value.profiles);
    return loaded.source;
  }

  async flush(): Promise<void> {
    await this.store.flush();
  }

  list(): SshProfile[] {
    return this.profiles.map((p) => toPublicProfile(p));
  }

  /** 内部使用:返回包含 passwordEncrypted 的完整 profile,绝不能直接发给 renderer。 */
  getInternal(id: string): SshProfile | null {
    const found = this.profiles.find((p) => p.id === id);
    return found ? { ...found } : null;
  }

  get(id: string): SshProfile | null {
    const found = this.profiles.find((p) => p.id === id);
    return found ? toPublicProfile(found) : null;
  }

  add(input: Omit<SshProfile, 'id' | 'addedAt'>): SshProfile {
    const profile = normalizeProfile({
      ...input,
      id: randomUUID(),
      addedAt: Date.now(),
    });
    this.profiles.push(profile);
    this.persist();
    this.emit('sshProfilesUpdated', { profiles: this.list() });
    return toPublicProfile(profile);
  }

  update(id: string, partial: Partial<Omit<SshProfile, 'id' | 'addedAt'>>): SshProfile {
    const idx = this.profiles.findIndex((p) => p.id === id);
    if (idx < 0) {
      throw new SshProfileManagerError('SshProfileNotFound', `id="${id}"`);
    }
    const next = normalizeProfile({ ...this.profiles[idx]!, ...partial, id });
    this.profiles[idx] = next;
    this.persist();
    this.emit('sshProfilesUpdated', { profiles: this.list() });
    return toPublicProfile(next);
  }

  delete(id: string): void {
    const idx = this.profiles.findIndex((p) => p.id === id);
    if (idx < 0) {
      throw new SshProfileManagerError('SshProfileNotFound', `id="${id}"`);
    }
    this.profiles.splice(idx, 1);
    this.persist();
    this.emit('sshProfilesUpdated', { profiles: this.list() });
  }

  replaceAll(input: SshProfile[]): void {
    this.profiles = validateProfilesArray(input);
    this.persist();
    this.emit('sshProfilesUpdated', { profiles: this.list() });
  }

  private persist(): void {
    this.store.set({ version: 1, profiles: this.profiles.map((p) => ({ ...p })) });
  }
}

function normalizeProfile(input: SshProfile): SshProfile {
  const name = input.name.trim();
  const host = input.host.trim();
  const username = input.username.trim();
  const port = Math.trunc(input.port);
  const authType = input.authType;
  if (!name || name.length > 100) {
    throw new SshProfileManagerError('InvalidSshProfile', 'name 必须为 1-100 字符');
  }
  if (!host || host.length > 255 || /[\s@]/.test(host)) {
    throw new SshProfileManagerError('InvalidSshProfile', 'host 非法');
  }
  if (!username || username.length > 100 || /[\s@]/.test(username)) {
    throw new SshProfileManagerError('InvalidSshProfile', 'username 非法');
  }
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new SshProfileManagerError('InvalidSshProfile', 'port 必须在 1-65535');
  }
  if (authType !== 'agent' && authType !== 'keyFile' && authType !== 'password') {
    throw new SshProfileManagerError('InvalidSshProfile', 'authType 非法');
  }
  const next: SshProfile = {
    id: input.id,
    name,
    host,
    port,
    username,
    authType,
    addedAt: input.addedAt,
  };
  const keyFilePath = input.keyFilePath?.trim();
  if (authType === 'keyFile') {
    if (!keyFilePath) {
      throw new SshProfileManagerError('InvalidSshProfile', 'keyFile 认证必须填写 keyFilePath');
    }
    next.keyFilePath = keyFilePath;
  } else if (keyFilePath) {
    next.keyFilePath = keyFilePath;
  }
  if (typeof input.passwordEncrypted === 'string' && input.passwordEncrypted.length > 0) {
    // 上限保守:safeStorage 加密后的 base64 不会很大,128 KB 足以容纳任何
    // 合理长度密码,过大说明数据损坏或被篡改,直接丢弃。
    if (input.passwordEncrypted.length > 131072) {
      throw new SshProfileManagerError('InvalidSshProfile', 'passwordEncrypted 过长');
    }
    next.passwordEncrypted = input.passwordEncrypted;
  }
  const defaultRemoteCwd = normalizeRemotePath(input.defaultRemoteCwd ?? '~');
  if (defaultRemoteCwd) next.defaultRemoteCwd = defaultRemoteCwd;
  const tmuxMode = input.tmuxMode === 'attach-or-create' ? 'attach-or-create' : 'disabled';
  next.tmuxMode = tmuxMode;
  next.tmuxSessionPolicy =
    input.tmuxSessionPolicy === 'new-per-launch' ? 'new-per-launch' : 'reuse';
  next.tmuxOnMissing =
    input.tmuxOnMissing === 'fail' ? 'fail' : 'fallback-shell';
  const tmuxSessionName = normalizeTmuxSessionName(input.tmuxSessionName ?? '');
  if (tmuxSessionName) next.tmuxSessionName = tmuxSessionName;
  // ProxyJump v2.1 §阶段 2.3:多跳板,每段最多 255 字符;空段过滤;最多 5 段
  // 防滥用(OpenSSH 没硬上限但 5 段已极少见)。OpenSSH -J 接受 user@host:port
  // 形式,Marina 不校验段格式,直接透传。
  const proxyJump = Array.isArray(input.proxyJump)
    ? input.proxyJump
        .map((s) => (typeof s === 'string' ? s.trim() : ''))
        .filter((s) => s.length > 0 && s.length <= 255)
        .slice(0, 5)
    : [];
  if (proxyJump.length > 0) next.proxyJump = proxyJump;
  return next;
}

function validateProfilesArray(input: unknown): SshProfile[] {
  if (!Array.isArray(input)) return [];
  const out: SshProfile[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    try {
      const profileInput: SshProfile = {
        id: typeof r['id'] === 'string' ? r['id'] : randomUUID(),
        name: typeof r['name'] === 'string' ? r['name'] : '',
        host: typeof r['host'] === 'string' ? r['host'] : '',
        port: typeof r['port'] === 'number' ? r['port'] : 22,
        username: typeof r['username'] === 'string' ? r['username'] : '',
        authType:
          r['authType'] === 'keyFile' || r['authType'] === 'password'
            ? r['authType']
            : 'agent',
        defaultRemoteCwd:
          typeof r['defaultRemoteCwd'] === 'string' ? r['defaultRemoteCwd'] : '~',
        tmuxMode:
          r['tmuxMode'] === 'attach-or-create' ? 'attach-or-create' : 'disabled',
        tmuxSessionPolicy:
          r['tmuxSessionPolicy'] === 'new-per-launch' ? 'new-per-launch' : 'reuse',
        tmuxOnMissing:
          r['tmuxOnMissing'] === 'fail' ? 'fail' : 'fallback-shell',
        addedAt: typeof r['addedAt'] === 'number' ? r['addedAt'] : Date.now(),
      };
      if (typeof r['keyFilePath'] === 'string') {
        profileInput.keyFilePath = r['keyFilePath'];
      }
      if (typeof r['passwordEncrypted'] === 'string') {
        profileInput.passwordEncrypted = r['passwordEncrypted'];
      }
      if (typeof r['tmuxSessionName'] === 'string') {
        profileInput.tmuxSessionName = r['tmuxSessionName'];
      }
      if (Array.isArray(r['proxyJump'])) {
        profileInput.proxyJump = r['proxyJump'].filter(
          (s): s is string => typeof s === 'string',
        );
      }
      out.push(
        normalizeProfile(profileInput),
      );
    } catch {
      // 损坏条目跳过,保留其它可用 profile。
    }
  }
  return out;
}

function normalizeTmuxSessionName(input: string): string {
  const value = input.trim();
  if (!value) return '';
  if (value.length > 80) {
    throw new SshProfileManagerError(
      'InvalidSshProfile',
      'tmux session 名称必须不超过 80 字符',
    );
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new SshProfileManagerError(
      'InvalidSshProfile',
      'tmux session 名称只能包含字母、数字、下划线、点和连字符',
    );
  }
  return value;
}

function toPublicProfile(p: SshProfile): SshProfile {
  const { passwordEncrypted: _omit, ...rest } = p;
  void _omit;
  const out: SshProfile = { ...rest };
  if (p.passwordEncrypted) out.hasSavedPassword = true;
  return out;
}
