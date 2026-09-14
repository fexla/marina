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
 * @连接取消(v0.3.4 用户反馈):connecting 态提供「取消」——端口扫描(串行 ×10)
 *   最坏 30s+,不能让用户干等。取消经 connectRemoteDaemon 的 shouldAbort 轮询
 *   (见 shared/remote-connect.ts),已建立成功的 transport 在安装前作废关闭。
 *
 * @不要在这里做的事:
 * - 不要在这里碰 renderer 的 UI 逻辑(连接后的世界全部属于共享 renderer)
 * - 不要在连接前 installWebApi(invoke 会打到未就绪的 transport)
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  connectRemoteDaemon,
  browserWsFactory,
  ConnectAbortedError,
} from '@shared/remote-connect';
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

// ── 系统栏 inset(状态栏/手势条避让)───────────────────────────────
//
// MainActivity 在 systemBars insets 变化时会把 --android-inset-top/bottom
// 注入 :root;但**首次 attach 时页面可能还没 load**,主动推会丢 —— 这里在
// 任何 UI 渲染前经 MarinaNative 桥同步拉一次兜底(mobile.css 的 safe-area
// 位消费这些变量)。见 docs/standards/mobile-interactions.md §3。
declare global {
  interface Window {
    __marinaAndroidBack?: () => boolean;
    MarinaNative?: { getInsets(): string };
  }
}

if (window.MarinaNative) {
  try {
    const parts = window.MarinaNative.getInsets().split(',');
    const top = Number(parts[0]);
    const bottom = Number(parts[1]);
    if (Number.isFinite(top) && top >= 0) {
      document.documentElement.style.setProperty('--android-inset-top', `${top}px`);
      document.documentElement.style.setProperty('--android-inset-bottom', `${bottom}px`);
    }
  } catch (err) {
    console.warn('[mobile] MarinaNative inset pull failed', err);
  }
}

// ── 安卓返回键桥(MainActivity.onBackPressed → 这里) ────────────────
//
// 协议:返回 true = web 层已消费(退了一层浮层),原生侧不动;
// 返回 false = 未消费 → 原生 moveTaskToBack 回后台。
// 消费链:'marina-back' cancelable 事件,监听者由内层到外层依次注册
// (React mount 顺序子先父 → CategoryPanel 子页 → SettingsView → App),
// 最内层浮层 preventDefault 即消费。renderer 挂载前(boot 页)无监听者,
// 返回 false → 回后台,符合预期(boot 页没有可退的浮层)。

window.__marinaAndroidBack = (): boolean => {
  const consumed = window.dispatchEvent(
    new CustomEvent('marina-back', { cancelable: true }),
  );
  // dispatchEvent 返回 false = 有监听者调用了 preventDefault。
  return !consumed;
};

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
  | { kind: 'manage'; profiles: MobileDaemonProfile[]; mode: 'list' | 'add' }
  | { kind: 'manage-edit'; profiles: MobileDaemonProfile[]; target: MobileDaemonProfile }
  | { kind: 'exiting' };

function Boot({ view }: { view: BootView }) {
  return (
    <div className="mobile-boot">
      <div className="mobile-boot-card">
        {view.kind === 'connecting' && (
          <>
            <div className="mobile-boot-title">Marina</div>
            <div className="mobile-boot-sub">正在连接 {view.profile.displayName}…</div>
            <div className="mobile-boot-spinner" aria-hidden="true" />
            <div className="mobile-boot-actions">
              <button type="button" className="mobile-boot-btn" onClick={cancelConnect}>
                取消连接
              </button>
            </div>
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
              <button type="button" className="mobile-boot-btn" onClick={renderManage}>
                选择其他电脑
              </button>
            </div>
          </>
        )}
        {view.kind === 'manage' && (
          <ManagePanel profiles={view.profiles} mode={view.mode} />
        )}
        {view.kind === 'manage-edit' && (
          <ProfileForm
            initial={view.target}
            onCancel={renderManage}
            onSaved={(p) => void startConnect(p)}
          />
        )}
        {view.kind === 'exiting' && <div className="mobile-boot-sub">启动中…</div>}
      </div>
    </div>
  );
}

function ManagePanel({
  profiles,
  mode,
}: {
  profiles: MobileDaemonProfile[];
  mode: 'list' | 'add';
}) {
  return (
    <>
      <div className="mobile-boot-title">Marina</div>
      <div className="mobile-boot-sub">
        {profiles.length === 0 ? '添加一台运行 Marina 的电脑开始使用' : '选择要连接的电脑'}
      </div>
      <div className="mobile-boot-list">
        {profiles.map((p) => (
          <div key={p.id} className="mobile-boot-profile-row">
            <button
              type="button"
              className="mobile-boot-profile"
              onClick={() => void startConnect(p)}
            >
              <span className="mobile-boot-profile-name">{p.displayName}</span>
              <span className="mobile-boot-profile-host">{p.host}</span>
            </button>
            <button
              type="button"
              className="mobile-boot-profile-edit"
              aria-label={`编辑 ${p.displayName}`}
              onClick={() => renderEdit(p)}
            >
              ✎
            </button>
          </div>
        ))}
      </div>
      {mode === 'add' ? (
        <ProfileForm onCancel={renderManage} onSaved={(p) => void startConnect(p)} />
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

/**
 * 新增/编辑共用的 profile 表单。initial 非空 = 编辑模式(预填 + 可删除);
 * 空则新增。onSaved 在持久化完成后回调,调用方决定后续(两种模式都直接连)。
 */
function ProfileForm({
  initial,
  onCancel,
  onSaved,
}: {
  initial?: MobileDaemonProfile;
  onCancel: () => void;
  onSaved: (p: MobileDaemonProfile) => void;
}) {
  const onSubmit = (e: React.FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const displayName = String(form.get('displayName') ?? '').trim();
    const host = String(form.get('host') ?? '').trim();
    const password = String(form.get('password') ?? '');
    if (!host || !password) return; // 必填校验交给 input required
    // 编辑模式:密码留空 = 保留原密码(与设置页「留空表示不改」语义一致)
    const saved: MobileDaemonProfile = {
      id: initial?.id ?? globalThis.crypto.randomUUID(),
      displayName: displayName || host,
      host,
      password: password || initial?.password || '',
      addedAt: initial?.addedAt ?? Date.now(),
    };
    const next = initial
      ? readProfilesForBoot().map((p) => (p.id === saved.id ? saved : p))
      : [...readProfilesForBoot(), saved];
    saveProfilesForBoot(next);
    onSaved(saved);
  };
  const onDelete = (): void => {
    if (!initial) return;
    saveProfilesForBoot(readProfilesForBoot().filter((p) => p.id !== initial.id));
    if (getLastProfileId() === initial.id) setLastProfileId(null);
    renderManage();
  };
  return (
    <form className="mobile-boot-form" onSubmit={onSubmit}>
      <label>
        名称
        <input
          name="displayName"
          defaultValue={initial?.displayName}
          placeholder="如:工作电脑"
          autoComplete="off"
        />
      </label>
      <label>
        地址(必填)
        <input
          name="host"
          required
          defaultValue={initial?.host}
          placeholder="Marina 电脑的 IP / 主机名"
          autoComplete="off"
          inputMode="url"
        />
      </label>
      <label>
        连接密码{initial ? '(留空保持不变)' : '(必填)'}
        <input
          name="password"
          required={!initial}
          type="password"
          placeholder="daemon 设置页配置的连接密码"
          autoComplete="off"
        />
      </label>
      <div className="mobile-boot-actions">
        <button type="submit" className="mobile-boot-btn primary">
          {initial ? '保存并连接' : '保存并连接'}
        </button>
        <button type="button" className="mobile-boot-btn" onClick={onCancel}>
          取消
        </button>
      </div>
      {initial && (
        <button type="button" className="mobile-boot-btn danger" onClick={onDelete}>
          删除此电脑
        </button>
      )}
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
  setView({ kind: 'manage', profiles: readProfilesForBoot(), mode: 'list' });
}

function renderManageAdding(): void {
  setView({ kind: 'manage', profiles: readProfilesForBoot(), mode: 'add' });
}

function renderEdit(target: MobileDaemonProfile): void {
  setView({ kind: 'manage-edit', profiles: readProfilesForBoot(), target });
}

/** 当前连接流程的取消标记(同一时刻只有一个连接流程)。 */
let connectCancelled = false;

function cancelConnect(): void {
  connectCancelled = true;
  renderManage();
}

async function startConnect(profile: MobileDaemonProfile): Promise<void> {
  connectCancelled = false;
  setView({ kind: 'connecting', profile });
  setLastProfileId(profile.id);
  try {
    const transport = await connectRemoteDaemon({
      connection: { host: profile.host, token: profile.password },
      wsFactory: browserWsFactory,
      shouldAbort: () => connectCancelled,
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
    // 扫描期间用户取消了但连接恰好成功:结果作废,不留半开连接。
    if (connectCancelled) {
      transport.close();
      return;
    }
    // 连接成功:安装 window.api,撤下 boot UI,放行共享 renderer。
    installWebApi({ transport, profileId: profile.id, windowId: ensureWindowId() });
    exiting = true;
    bootRoot.unmount();
    // renderer 入口自己 createRoot(#root) 并挂 App(见 src/renderer/index.tsx)。
    await import('../../../src/renderer/index');
  } catch (err) {
    if (connectCancelled || err instanceof ConnectAbortedError) {
      return; // 用户取消,不是错误;视图已由 cancelConnect 切回列表
    }
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
