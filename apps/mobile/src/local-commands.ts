/**
 * @file apps/mobile/src/local-commands.ts
 * @purpose Android 壳的「客户端本地控制面」:local-control 域命令的 web 实现
 *   (Electron 端这些走本地 main 进程 IPC,Android 没有本地 main,由本模块用
 *   localStorage / 浏览器 API 等价实现)。命令路由声明见
 *   src/shared/protocol.ts 的 LOCAL_CONTROL_COMMANDS_SET —— 本模块只实现
 *   Android 会触达的子集,其余明确报「不支持」而非静默。
 *
 * @关键设计:
 * - profile 存储:localStorage 明文存配对密码。与 PC 端 safeStorage(DPAPI)
 *   有安全差距,已知降级(v1):WebView 的 localStorage 落在 app 私有沙箱目录,
 *   未 root 不可读;后续可换 Android Keystore 加密(Capacitor 原生桥)。
 * - 外观(appearance)归客户端(ADR-029 唯一例外):localStorage 存本机外观块,
 *   变更时向本进程广播 SETTINGS_LOCAL_APPEARANCE_CHANGED(进程内 EventEmitter,
 *   不经 WS —— 与 preload 的 LOCAL_CONTROL_EVENTS 语义一致)。
 * - 事件总线:LOCAL_CONTROL_EVENTS 四个通道(WINDOW_MAX_STATE_CHANGED /
 *   REMOTE_PROFILES_UPDATED / REMOTE_DAEMON_STATUS_CHANGED /
 *   SETTINGS_LOCAL_APPEARANCE_CHANGED)进程内分发。
 *
 * @不要在这里做的事:
 * - 不要实现 REMOTE_DAEMON_START/STOP/SET_PORT/SET_PASSWORD(Android 不当
 *   daemon,设置页相应区块已裁剪;误触达时报不支持)
 * - 不要在这里碰 backend-data 命令(那些走 transport,与本模块无关)
 */

import {
  COMMAND_CHANNELS,
  type ListRemoteProfilesResponse,
  type GetRemoteConnectionResponse,
  type GetAppearanceSettingsResponse,
  type UpdateAppearanceSettingsPayload,
  type RemoteDaemonStatusResponse,
  EVENT_CHANNELS,
} from '@shared/protocol';
import type { Settings } from '@shared/types';

// ── localStorage 存储 ────────────────────────────────────────────────

/**
 * Android 壳本地存的 daemon profile。形状对齐 main 端 RemoteDaemonProfile,
 * 但密码是明文(PC 端为 safeStorage 加密的 tokenEncrypted)—— 见文件头安全降级说明。
 */
export interface MobileDaemonProfile {
  id: string;
  displayName: string;
  host: string;
  /** 明文配对密码(daemon 端 token)。 */
  password: string;
  /** 创建时间戳(ms),与 main 端 RemoteDaemonProfile.addedAt 对齐(UI 排序)。 */
  addedAt: number;
}

const LS_PROFILES = 'marina.mobile.profiles';
const LS_LAST_PROFILE = 'marina.mobile.lastProfileId';
const LS_APPEARANCE = 'marina.mobile.appearance';

function readProfiles(): MobileDaemonProfile[] {
  try {
    const raw = localStorage.getItem(LS_PROFILES);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // 形状宽松校验:坏条目丢弃而不是整体崩(与 main 端持久化降级思路一致)
    return parsed.filter(
      (p): p is MobileDaemonProfile =>
        !!p &&
        typeof p === 'object' &&
        typeof (p as MobileDaemonProfile).id === 'string' &&
        typeof (p as MobileDaemonProfile).host === 'string',
    );
  } catch {
    return [];
  }
}

function writeProfiles(profiles: MobileDaemonProfile[]): void {
  localStorage.setItem(LS_PROFILES, JSON.stringify(profiles));
}

/** MobileBoot(main.tsx)用的 profile 读写 —— 与命令 handler 共享同一存储。 */
export function readProfilesForBoot(): MobileDaemonProfile[] {
  return readProfiles();
}

export function saveProfilesForBoot(profiles: MobileDaemonProfile[]): void {
  writeProfiles(profiles);
}

export function getLastProfileId(): string | null {
  return localStorage.getItem(LS_LAST_PROFILE);
}

export function setLastProfileId(id: string | null): void {
  if (id === null) localStorage.removeItem(LS_LAST_PROFILE);
  else localStorage.setItem(LS_LAST_PROFILE, id);
}

/** renderer 副本形状(hasToken 布尔,不回传明文 —— 与 main 端对齐)。 */
function toRendererProfile(p: MobileDaemonProfile) {
  return {
    id: p.id,
    displayName: p.displayName || p.host,
    host: p.host,
    hasToken: p.password.length > 0,
    addedAt: p.addedAt,
  };
}

// ── 外观(ADR-029:归客户端机器) ─────────────────────────────────────

/**
 * 与 main 端 settings-manager DEFAULT_SETTINGS.appearance 保持一致,
 * terminalFontSize 除外:手机视口(约 411 CSS px 宽)上 13px 每行只有 ~52 列
 * 且观感过小,移动端默认 15(2026-09-14 真机确认;用户可双指缩放调回)。
 * 只影响本机 localStorage 首次写入前的默认 —— appearance 归客户端(ADR-029),
 * 不会与 daemon 侧设置互相覆盖。
 */
const DEFAULT_APPEARANCE: Settings['appearance'] = {
  theme: 'rose-pine',
  windowStyle: 'windows',
  language: 'system',
  terminalFontFamily: "'Cascadia Mono', 'JetBrains Mono', 'Consolas', 'LXGW WenKai Mono'",
  terminalFallbackFont: '',
  terminalFontSize: 15,
  terminalLineHeight: 1.2,
  uiFontFamily: "'LXGW WenKai', system-ui, sans-serif",
  uiZoom: 1.0,
  macOSTrafficLightHoverSymbols: false,
  hideTopTabBar: false,
};

function readAppearance(): Settings['appearance'] {
  try {
    const raw = localStorage.getItem(LS_APPEARANCE);
    if (!raw) return { ...DEFAULT_APPEARANCE };
    return { ...DEFAULT_APPEARANCE, ...(JSON.parse(raw) as object) };
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

// ── 进程内事件总线(local-control events) ───────────────────────────

type Handler = (payload: unknown) => void;
const listeners = new Map<string, Set<Handler>>();

function emitLocal(channel: string, payload: unknown): void {
  listeners.get(channel)?.forEach((h) => h(payload));
}

export function subscribeLocal(channel: string, handler: Handler): () => void {
  let set = listeners.get(channel);
  if (!set) {
    set = new Set();
    listeners.set(channel, set);
  }
  set.add(handler);
  return () => set.delete(handler);
}

// ── 命令分发 ─────────────────────────────────────────────────────────

function notSupported(channel: string, reason: string): never {
  throw new Error(
    `[mobile] 命令 "${channel}" 在 Android 客户端不支持:${reason}。` +
      `这通常是 UI 裁剪遗漏(该入口本不应在移动端出现),请反馈给开发者。`,
  );
}

/**
 * 处理一条 local-control 命令。返回值形状与 main 端 handler 的 response 对齐
 * (renderer 代码不区分命令是谁实现的)。
 */
export function handleLocalCommand(channel: string, payload: unknown): Promise<unknown> {
  return (async () => {
    switch (channel) {
      // ── 远程 profile CRUD(连接管理,Android 的核心 local-control 面) ──
      case COMMAND_CHANNELS.REMOTE_PROFILE_LIST: {
        const res: ListRemoteProfilesResponse = {
          profiles: readProfiles().map(toRendererProfile),
        };
        return res;
      }
      case COMMAND_CHANNELS.REMOTE_PROFILE_ADD: {
        const p = payload as { displayName?: string; host?: string; password?: string };
        if (!p?.host) throw new Error('[mobile] 添加电脑配置缺少地址(host)');
        const profiles = readProfiles();
        const created: MobileDaemonProfile = {
          id: globalThis.crypto.randomUUID(),
          displayName: (p.displayName || '').trim() || (p.host ?? '').trim(),
          host: (p.host ?? '').trim(),
          password: p.password ?? '',
          addedAt: Date.now(),
        };
        profiles.push(created);
        writeProfiles(profiles);
        emitLocal(EVENT_CHANNELS.REMOTE_PROFILES_UPDATED, { profiles: profiles.map(toRendererProfile) });
        return { profile: toRendererProfile(created) };
      }
      case COMMAND_CHANNELS.REMOTE_PROFILE_UPDATE: {
        const p = payload as {
          id: string;
          partial?: { displayName?: string; host?: string; password?: string };
        };
        const profiles = readProfiles();
        const target = profiles.find((x) => x.id === p?.id);
        if (!target) throw new Error(`[mobile] 要更新的电脑配置不存在(id=${p?.id})`);
        if (p.partial?.displayName !== undefined) target.displayName = p.partial.displayName;
        if (p.partial?.host !== undefined) target.host = p.partial.host;
        // 密码留空 = 不改(与设置页「留空表示不改」的语义一致)
        if (p.partial?.password) target.password = p.partial.password;
        writeProfiles(profiles);
        emitLocal(EVENT_CHANNELS.REMOTE_PROFILES_UPDATED, { profiles: profiles.map(toRendererProfile) });
        return { profile: toRendererProfile(target) };
      }
      case COMMAND_CHANNELS.REMOTE_PROFILE_DELETE: {
        const p = payload as { id: string };
        const profiles = readProfiles();
        const next = profiles.filter((x) => x.id !== p?.id);
        if (next.length === profiles.length) {
          throw new Error(`[mobile] 要删除的电脑配置不存在(id=${p?.id})`);
        }
        writeProfiles(next);
        if (getLastProfileId() === p?.id) setLastProfileId(null);
        emitLocal(EVENT_CHANNELS.REMOTE_PROFILES_UPDATED, { profiles: next.map(toRendererProfile) });
        return { ok: true };
      }
      case COMMAND_CHANNELS.REMOTE_PROFILE_GET_CONNECTION: {
        const p = payload as { profileId: string };
        const target = readProfiles().find((x) => x.id === p?.profileId);
        const res: GetRemoteConnectionResponse = target
          ? {
              connection: {
                host: target.host,
                token: target.password,
                profileId: target.id,
                displayName: target.displayName,
              },
            }
          : { connection: null };
        return res;
      }

      // ── 外观(归客户端) ──
      case COMMAND_CHANNELS.SETTINGS_GET_APPEARANCE: {
        const res: GetAppearanceSettingsResponse = { appearance: readAppearance() };
        return res;
      }
      case COMMAND_CHANNELS.SETTINGS_UPDATE_APPEARANCE: {
        const p = payload as UpdateAppearanceSettingsPayload;
        const next = { ...readAppearance(), ...(p?.partial ?? {}) };
        localStorage.setItem(LS_APPEARANCE, JSON.stringify(next));
        emitLocal(EVENT_CHANNELS.SETTINGS_LOCAL_APPEARANCE_CHANGED, { appearance: next });
        return { appearance: next };
      }

      // ── 远程服务端状态:Android 永远不是 daemon ──
      case COMMAND_CHANNELS.REMOTE_DAEMON_GET_STATUS: {
        const res: RemoteDaemonStatusResponse = {
          status: { running: false, port: null, clientCount: 0, hasPassword: false },
        };
        return res;
      }

      // ── 剪贴板 / 外链:浏览器 API ──
      case COMMAND_CHANNELS.SYSTEM_CLIPBOARD_READ_TEXT: {
        const text = await navigator.clipboard.readText().catch(() => '');
        return { text };
      }
      case COMMAND_CHANNELS.SYSTEM_CLIPBOARD_WRITE_TEXT: {
        try {
          await navigator.clipboard.writeText((payload as { text: string }).text);
          return { ok: true };
        } catch {
          return { ok: false };
        }
      }
      case COMMAND_CHANNELS.SYSTEM_CLIPBOARD_WRITE_IMAGE: {
        notSupported(channel, '写图片剪贴板尚未接入浏览器 API');
      }
      case COMMAND_CHANNELS.SYSTEM_OPEN_EXTERNAL: {
        const url = (payload as { url: string }).url;
        // 安全:与 main 端同口径,只放行 http(s)/mailto
        if (/^https?:/i.test(url) || /^mailto:/i.test(url)) {
          window.open(url, '_blank', 'noopener,noreferrer');
          return { ok: true };
        }
        return { ok: false };
      }

      // ── 窗口/应用生命周期:Android 无多窗口 ──
      case COMMAND_CHANNELS.APP_QUIT:
        notSupported(channel, '移动端无「完全退出」;用系统手势划掉 app');

      case COMMAND_CHANNELS.WINDOW_CREATE:
        notSupported(channel, '移动端无多窗口;所有 session 在同一窗口内切换');

      case COMMAND_CHANNELS.WINDOW_CLOSE_SELF:
      case COMMAND_CHANNELS.WINDOW_CLOSE_ALL:
        // 远程错误页的「关闭窗口」按钮会走这里;移动端等价动作 = 断开回到连接页。
        // reload 会重新走 MobileBoot 流(见 main.tsx),即回到连接管理。
        window.location.reload();
        return { ok: true };

      case COMMAND_CHANNELS.WINDOW_FOCUS:
      case COMMAND_CHANNELS.WINDOW_MINIMIZE:
      case COMMAND_CHANNELS.WINDOW_TOGGLE_MAXIMIZE:
      case COMMAND_CHANNELS.WINDOW_GET_MAX_STATE:
        return { maximized: false };

      // ── Android 永远不当 daemon,服务端配置全部不支持 ──
      case COMMAND_CHANNELS.REMOTE_DAEMON_START:
      case COMMAND_CHANNELS.REMOTE_DAEMON_STOP:
      case COMMAND_CHANNELS.REMOTE_DAEMON_SET_PORT:
      case COMMAND_CHANNELS.REMOTE_DAEMON_SET_PASSWORD:
        notSupported(channel, '移动端不提供 daemon 服务(ADR-042:纯远程客户端)');

      // ── 性能诊断:本机无 main,无飞行记录器 ──
      case COMMAND_CHANNELS.PERFORMANCE_GET_STATUS:
        return { available: false, reason: 'mobile-client' };
      case COMMAND_CHANNELS.PERFORMANCE_WRITE_REPORT:
      case COMMAND_CHANNELS.PERFORMANCE_OPEN_REPORTS_DIR:
      case COMMAND_CHANNELS.PERFORMANCE_CAPTURE_CPU_PROFILE:
        notSupported(channel, '性能诊断属于 PC 客户端本机 main');

      case COMMAND_CHANNELS.DEBUG_SHIFT_CAPTURE:
        return { enabled: false };

      default:
        notSupported(channel, 'local-control 命令未在 mobile shim 实现');
    }
  })();
}
