/**
 * @file apps/mobile/src/main.tsx
 * @purpose Android 壳启动入口:MobileBoot(连接管理/连接中/错误态)→ 连接成功后
 *   安装 window.api(web shim)→ 动态 import 桌面 renderer 入口挂 #root。
 *
 * @启动序(为什么这么排):
 * 1. renderer 源码假设 window.api 已存在且已连接(Electron preload 模型),
 *    所以 MobileBoot 必须在连接成功后才放行 renderer —— #boot 与 #root 两个
 *    根节点隔离,renderer 零改动。
 * 2. 「上次连接的 profile」自动重连:app 冷启动直接进 connecting,失败才落回
 *    manage 列表 —— 手机用户的主要路径是「打开就看」。
 * 3. 断线重连成功 = location.reload():remote-transport 恢复同一 clientId,但
 *    daemon 侧 session owner 已在断线时被 release,reload 重走 boot 序重拉
 *    snapshot(与 Electron 远程窗口的 reload 策略一致,见 preload)。
 *
 * @不要在这里做的事:
 * - 不要在这里碰 renderer 的 UI 逻辑(连接后的世界全部属于共享 renderer)
 * - 不要在连接前 installWebApi(invoke 会打到未就绪的 transport)
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { connectRemoteDaemon, browserWsFactory } from '@shared/remote-connect';
import { installWebApi } from './web-api-shim';
import type { MobileDaemonProfile } from './local-commands';
import {
  getLastProfileId,
  setLastProfileId,
  readProfilesForBoot,
  saveProfilesForBoot,
} from './local-commands';
import './mobile.css';

const bootEl = document.getElementById('boot');
const rootEl = document.getElementById('root');
if (!bootEl || !rootEl) {
  throw new Error('[mobile] index.html 缺少 #boot / #root 挂载点');
}
const bootRoot = createRoot(bootEl);

/** 设备稳定 clientId:daemon 侧 owner / view lease / 事件定向的标识。 */
function ensureWindowId(): string {
  const KEY = 'marina.mobile.clientId';
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = globalThis.crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}

// ── MobileBoot UI ────────────────────────────────────────────────────

type BootView =
  | { kind: 'connecting'; profile: MobileDaemonProfile }
  | { kind: 'error'; profile: MobileDaemonProfile; message: string }
  | { kind: 'manage'; profiles: MobileDaemonProfile[]; adding: boolean }
  | { kind: 'exiting' };

function Boot({ view }: { view: BootView }) {
  // 连接动作由 effect 驱动而不是点击 handler:自动重连(冷启动)与手动重试
  // 走同一条路径,UI 只负责展示状态。
  return (
    <div className="mobile-boot">
      <div className="mobile-boot-card">
        {view.kind === 'connecting' && (
          <>
            <div className="mobile-boot-title">Marina</div>
            <div className="mobile-boot-sub">正在连接 {view.profile.displayName}…</div>
            <div className="mobile-boot-spinner" aria-hidden="true" />
          </>
        )}
        {view.kind === 'error' && (
          <>
            <div className="mobile-boot-title">连接失败</div>
            <pre className="mobile-boot-error">{view.message}</pre>
            <div className="mobile-boot-actions">
              <button
                type="button"
                className="mobile-boot-btn primary"
                onClick={() => void startConnect(view.profile)}
              >
                重试
              </button>
              <button
                type="button"
                className="mobile-boot-btn"
                onClick={() => renderManage()}
              >
                选择其他电脑
              </button>
            </div>
          </>
        )}
        {view.kind === 'manage' && <ManagePanel profiles={view.profiles} adding={view.adding} />}
        {view.kind === 'exiting' && <div className="mobile-boot-sub">启动中…</div>}
      </div>
    </div>
  );
}

function ManagePanel({
  profiles,
  adding,
}: {
  profiles: MobileDaemonProfile[];
  adding: boolean;
}) {
  return (
    <>
      <div className="mobile-boot-title">Marina</div>
      <div className="mobile-boot-sub">
        {profiles.length === 0
          ? '添加一台运行 Marina 的电脑开始使用'
          : '选择要连接的电脑'}
      </div>
      <div className="mobile-boot-list">
        {profiles.map((p) => (
          <button
            key={p.id}
            type="button"
            className="mobile-boot-profile"
            onClick={() => void startConnect(p)}
          >
            <span className="mobile-boot-profile-name">{p.displayName}</span>
            <span className="mobile-boot-profile-host">{p.host}</span>
          </button>
        ))}
      </div>
      {adding ? (
        <AddProfileForm
          onCancel={() => renderManage()}
          onSaved={(p) => void startConnect(p)}
        />
      ) : (
        <div className="mobile-boot-actions">
          <button
            type="button"
            className="mobile-boot-btn primary"
            onClick={() => renderManageAdding()}
          >
            + 添加电脑
          </button>
        </div>
      )}
    </>
  );
}

function AddProfileForm({
  onCancel,
  onSaved,
}: {
  onCancel: () => void;
  onSaved: (p: MobileDaemonProfile) => void;
}) {
  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const displayName = String(form.get('displayName') ?? '').trim();
    const host = String(form.get('host') ?? '').trim();
    const password = String(form.get('password') ?? '');
    if (!host || !password) return; // 必填校验交给 input required
    const created: MobileDaemonProfile = {
      id: globalThis.crypto.randomUUID(),
      displayName: displayName || host,
      host,
      password,
      addedAt: Date.now(),
    };
    saveProfilesForBoot([...readProfilesForBoot(), created]);
    onSaved(created);
  };
  return (
    <form className="mobile-boot-form" onSubmit={onSubmit}>
      <label>
        名称
        <input name="displayName" placeholder="如:工作电脑" autoComplete="off" />
      </label>
      <label>
        地址(必填)
        <input
          name="host"
          required
          placeholder="Marina 电脑的 IP / 主机名"
          autoComplete="off"
          inputMode="url"
        />
      </label>
      <label>
        连接密码(必填)
        <input
          name="password"
          required
          type="password"
          placeholder="daemon 设置页配置的连接密码"
          autoComplete="off"
        />
      </label>
      <div className="mobile-boot-actions">
        <button type="submit" className="mobile-boot-btn primary">
          保存并连接
        </button>
        <button type="button" className="mobile-boot-btn" onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}

// ── 启动状态机 ───────────────────────────────────────────────────────

let exiting = false;

function setView(view: BootView): void {
  if (exiting) return;
  bootRoot.render(
    <StrictMode>
      <Boot view={view} />
    </StrictMode>,
  );
}

function renderManage(): void {
  setView({ kind: 'manage', profiles: readProfilesForBoot(), adding: false });
}

function renderManageAdding(): void {
  setView({ kind: 'manage', profiles: readProfilesForBoot(), adding: true });
}

async function startConnect(profile: MobileDaemonProfile): Promise<void> {
  setView({ kind: 'connecting', profile });
  setLastProfileId(profile.id);
  try {
    const transport = await connectRemoteDaemon({
      connection: { host: profile.host, token: profile.password },
      wsFactory: browserWsFactory,
      onReconnectSuccess: () => {
        console.warn('[mobile] reconnected — reload to refresh snapshot');
        window.location.reload();
      },
      onReconnectStart: () => {
        console.warn('[mobile] connection lost — reconnecting...');
      },
      onReconnectFail: (reason) => {
        console.error('[mobile] reconnect failed (terminal):', reason);
      },
    });
    // 连接成功:安装 window.api,撤下 boot UI,放行共享 renderer。
    installWebApi({ transport, profileId: profile.id, windowId: ensureWindowId() });
    exiting = true;
    bootRoot.unmount();
    // renderer 入口自己 createRoot(#root) 并挂 App(见 src/renderer/index.tsx)。
    await import('../../../src/renderer/index');
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : typeof err === 'object' && err && 'message' in err
          ? String((err as { message: unknown }).message)
          : String(err);
    setView({ kind: 'error', profile, message });
  }
}

// ── 冷启动 ───────────────────────────────────────────────────────────

(function boot(): void {
  const lastId = getLastProfileId();
  const last = lastId ? readProfilesForBoot().find((p) => p.id === lastId) : null;
  if (last) {
    void startConnect(last);
  } else {
    renderManage();
  }
})();
