/**
 * @file SshConnectionDialog.tsx
 * @purpose 在侧栏 SSH 任务内选择已有连接，或新建 profile 后立即连接。
 *
 * @关键设计:
 * - 0/1/N 个 profile 都进入同一面板，“新建连接”始终可发现
 * - 新建成功后直接使用返回的 public profile 启动 session，不跳设置页
 * - 必填字段保持最少；端口、默认目录、ProxyJump 收进“更多选项”
 * - main 的 SshProfileManager 是校验真值；错误留在表单内且不清空输入
 * - 复用全局 overlay 栈、焦点 trap和焦点归还，关闭后回到触发按钮
 *
 * @对应文档章节:docs/plans/sidebar-interaction-redesign-rationale-20260804.md 第 7 节
 *
 * @不要在这里做的事:
 * - 不跳转设置页完成首次连接
 * - 不让 profile 数量暗中改变交互模式
 * - 不在 renderer 保存明文密码
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { KeyRound, Plus, Server } from 'lucide-react';
import {
  COMMAND_CHANNELS,
  type AddSshProfileResponse,
  type PickSshKeyFileResponse,
} from '@shared/protocol';
import type { SshProfile } from '@shared/types';
import { useOverlayRegistration } from '../ui-overlay-stack';
import { useTranslation } from './LanguageProvider';

interface SshConnectionDialogProps {
  profiles: SshProfile[];
  onCancel: () => void;
  onConnect: (profile: SshProfile) => Promise<void>;
}

type DialogMode = 'choose' | 'create';
type AuthType = 'agent' | 'keyFile' | 'password';

/** 选择已有 SSH profile，或原地创建并连接。 */
export function SshConnectionDialog({
  profiles,
  onCancel,
  onConnect,
}: SshConnectionDialogProps): JSX.Element {
  const { tx } = useTranslation();
  const [mode, setMode] = useState<DialogMode>(profiles.length === 0 ? 'create' : 'choose');
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [username, setUsername] = useState('');
  const [port, setPort] = useState('22');
  const [authType, setAuthType] = useState<AuthType>('agent');
  const [keyFilePath, setKeyFilePath] = useState('');
  const [password, setPassword] = useState('');
  const [savePassword, setSavePassword] = useState(true);
  const [defaultRemoteCwd, setDefaultRemoteCwd] = useState('~');
  const [proxyJump, setProxyJump] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previousActiveElementRef = useRef<Element | null>(null);
  const { isTop } = useOverlayRegistration(true);

  useEffect(() => {
    previousActiveElementRef.current = document.activeElement;
    return () => {
      const previous = previousActiveElementRef.current;
      previousActiveElementRef.current = null;
      requestAnimationFrame(() => {
        const current = document.activeElement;
        if (current && current !== document.body && current !== document.documentElement) return;
        if (previous instanceof HTMLElement && document.body.contains(previous)) previous.focus();
      });
    };
  }, []);

  // choose/create 切换会卸载当前焦点控件；每次 mode 改变都把焦点放到新视图
  // 的首个主控件，避免焦点落到 body 后用户必须额外按一次 Tab。
  useEffect(() => {
    requestAnimationFrame(() => {
      const panel = panelRef.current;
      const preferred =
        mode === 'create'
          ? panel?.querySelector<HTMLInputElement>('input[placeholder="example.com"]')
          : panel?.querySelector<HTMLButtonElement>('.ssh-connection-row');
      preferred?.focus();
    });
  }, [mode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || event.keyCode === 229 || !isTop()) return;
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        if (mode === 'create' && profiles.length > 0) {
          setMode('choose');
          setError(null);
        } else {
          onCancel();
        }
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) return;
      const active = document.activeElement as HTMLElement | null;
      if (!active || !panel.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, isTop, mode, onCancel, profiles.length]);

  const connectExisting = async (profile: SshProfile): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onConnect(profile);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    }
  };

  const pickKeyFile = async (): Promise<void> => {
    setError(null);
    try {
      const result = await window.api.invoke<unknown, PickSshKeyFileResponse>(
        COMMAND_CHANNELS.SSH_PROFILE_PICK_KEY_FILE,
        keyFilePath.trim() ? { defaultPath: keyFilePath.trim() } : {},
      );
      if (result.path) setKeyFilePath(result.path);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const submitNewProfile = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const normalizedHost = host.trim();
      const normalizedUsername = username.trim();
      const response = await window.api.invoke<unknown, AddSshProfileResponse>(
        COMMAND_CHANNELS.SSH_PROFILE_ADD,
        {
          name: name.trim() || `${normalizedUsername}@${normalizedHost}`,
          host: normalizedHost,
          username: normalizedUsername,
          port: Number.parseInt(port, 10),
          authType,
          ...(authType === 'keyFile' && keyFilePath.trim()
            ? { keyFilePath: keyFilePath.trim() }
            : {}),
          ...(authType === 'password' && savePassword && password ? { password } : {}),
          defaultRemoteCwd: defaultRemoteCwd.trim() || '~',
          proxyJump: proxyJump
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
        },
      );
      await onConnect(response.profile);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    }
  };

  return (
    <div className="app-modal-backdrop" role="presentation">
      <div
        ref={panelRef}
        className="app-modal-panel ssh-connection-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={tx('连接 SSH', 'Connect SSH')}
        data-testid="ssh-connection-dialog"
      >
        <div className="app-modal-title">{tx('连接 SSH', 'Connect SSH')}</div>

        {mode === 'choose' ? (
          <>
            <div className="ssh-connection-list" aria-label={tx('已有连接', 'Saved connections')}>
              {profiles.map((profile) => (
                <button
                  key={profile.id}
                  type="button"
                  className="ssh-connection-row"
                  disabled={busy}
                  onClick={() => void connectExisting(profile)}
                >
                  <Server size={15} aria-hidden="true" />
                  <span className="ssh-connection-row-main">
                    <strong>{profile.name}</strong>
                    <small>{`${profile.username}@${profile.host}:${profile.port}`}</small>
                  </span>
                </button>
              ))}
            </div>
            {error && (
              <div className="ssh-connection-error" role="alert">
                {error}
              </div>
            )}
            <div className="app-modal-actions ssh-connection-actions">
              <button type="button" className="app-modal-button" disabled={busy} onClick={onCancel}>
                {tx('取消', 'Cancel')}
              </button>
              <button
                type="button"
                className="app-modal-button app-modal-button-primary"
                disabled={busy}
                onClick={() => {
                  setMode('create');
                  setError(null);
                }}
              >
                <Plus size={14} aria-hidden="true" /> {tx('新建 SSH 连接', 'New SSH connection')}
              </button>
            </div>
          </>
        ) : (
          <form className="ssh-connection-form" onSubmit={(event) => void submitNewProfile(event)}>
            <label>
              <span>{tx('主机', 'Host')}</span>
              <input
                autoFocus
                className="app-modal-input"
                value={host}
                required
                placeholder="example.com"
                disabled={busy}
                onChange={(event) => setHost(event.target.value)}
              />
            </label>
            <label>
              <span>{tx('用户名', 'Username')}</span>
              <input
                className="app-modal-input"
                value={username}
                required
                placeholder="alice"
                disabled={busy}
                onChange={(event) => setUsername(event.target.value)}
              />
            </label>
            <label>
              <span>{tx('名称（可选）', 'Name (optional)')}</span>
              <input
                className="app-modal-input"
                value={name}
                placeholder={tx('默认使用 user@host', 'Defaults to user@host')}
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label>
              <span>{tx('认证方式', 'Authentication')}</span>
              <select
                className="app-modal-input"
                value={authType}
                disabled={busy}
                onChange={(event) => setAuthType(event.target.value as AuthType)}
              >
                <option value="agent">
                  {tx('SSH agent / 系统默认', 'SSH agent / system default')}
                </option>
                <option value="keyFile">{tx('密钥文件', 'Key file')}</option>
                <option value="password">{tx('密码', 'Password')}</option>
              </select>
            </label>

            {authType === 'keyFile' && (
              <div className="ssh-key-file-row">
                <label>
                  <span>{tx('密钥文件', 'Key file')}</span>
                  <input
                    className="app-modal-input"
                    value={keyFilePath}
                    readOnly
                    required
                    placeholder={tx('请选择密钥文件', 'Choose a key file')}
                  />
                </label>
                <button
                  type="button"
                  className="app-modal-button"
                  disabled={busy}
                  onClick={() => void pickKeyFile()}
                >
                  <KeyRound size={14} aria-hidden="true" /> {tx('选择', 'Choose')}
                </button>
              </div>
            )}

            {authType === 'password' && (
              <>
                <label>
                  <span>{tx('密码', 'Password')}</span>
                  <input
                    type="password"
                    className="app-modal-input"
                    value={password}
                    disabled={busy || !savePassword}
                    placeholder={
                      savePassword
                        ? tx('由系统安全存储保存', 'Saved in system secure storage')
                        : tx('连接后在终端中输入', 'Enter in terminal after connecting')
                    }
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </label>
                <label className="ssh-connection-checkbox">
                  <input
                    type="checkbox"
                    checked={savePassword}
                    disabled={busy}
                    onChange={(event) => {
                      setSavePassword(event.target.checked);
                      if (!event.target.checked) setPassword('');
                    }}
                  />
                  <span>
                    {tx('使用系统安全存储保存密码', 'Save password in system secure storage')}
                  </span>
                </label>
              </>
            )}

            <button
              type="button"
              className="ssh-connection-advanced-toggle"
              aria-expanded={advanced}
              onClick={() => setAdvanced((value) => !value)}
            >
              {advanced ? '▾' : '▸'} {tx('更多选项', 'More options')}
            </button>
            {advanced && (
              <div className="ssh-connection-advanced">
                <label>
                  <span>{tx('端口', 'Port')}</span>
                  <input
                    type="number"
                    min="1"
                    max="65535"
                    className="app-modal-input"
                    value={port}
                    required
                    disabled={busy}
                    onChange={(event) => setPort(event.target.value)}
                  />
                </label>
                <label>
                  <span>{tx('默认目录', 'Default directory')}</span>
                  <input
                    className="app-modal-input"
                    value={defaultRemoteCwd}
                    disabled={busy}
                    onChange={(event) => setDefaultRemoteCwd(event.target.value)}
                  />
                </label>
                <label>
                  <span>ProxyJump</span>
                  <input
                    className="app-modal-input"
                    value={proxyJump}
                    placeholder="jump-a, jump-b"
                    disabled={busy}
                    onChange={(event) => setProxyJump(event.target.value)}
                  />
                </label>
              </div>
            )}

            {error && (
              <div className="ssh-connection-error" role="alert">
                {error}
              </div>
            )}
            <div className="app-modal-actions ssh-connection-actions">
              <button
                type="button"
                className="app-modal-button"
                disabled={busy}
                onClick={() => {
                  if (profiles.length > 0) {
                    setMode('choose');
                    setError(null);
                  } else {
                    onCancel();
                  }
                }}
              >
                {profiles.length > 0 ? tx('返回', 'Back') : tx('取消', 'Cancel')}
              </button>
              <button
                type="submit"
                className="app-modal-button app-modal-button-primary"
                disabled={busy}
              >
                {busy ? tx('正在连接…', 'Connecting…') : tx('保存并连接', 'Save and connect')}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
