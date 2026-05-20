import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { SshProfile, SshProfilesFile } from '@shared/types';
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
    return this.profiles.map((p) => ({ ...p }));
  }

  get(id: string): SshProfile | null {
    const found = this.profiles.find((p) => p.id === id);
    return found ? { ...found } : null;
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
    return { ...profile };
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
    return { ...next };
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
      if (typeof r['tmuxSessionName'] === 'string') {
        profileInput.tmuxSessionName = r['tmuxSessionName'];
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

export function normalizeRemotePath(input: string): string {
  let value = input.trim();
  if (!value) value = '~';
  value = value.replace(/\\/g, '/');
  value = value.replace(/\/+/g, '/');
  if (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
  return value;
}
