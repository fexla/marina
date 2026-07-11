/**
 * @file src/renderer/components/WindowChrome.tsx
 * @purpose 自绘标题栏 (M1-A) — 取代 OS frame。
 *
 *   两套布局,由 settings.appearance.windowStyle 决定:
 *   - 'windows':传统右侧三按钮 — 最小化 / 最大化-还原 / 关闭。lucide 图标。
 *   - 'macos':左侧 traffic light — 红黄绿圆点。点击红=关闭,黄=最小化,绿=切最大化。
 *     hover 时显示 × / − / ⤢ 内部符号(macOS 一致)。
 *
 *   两套都通过同样的 IPC 命令(cmd:window:minimize/toggle-maximize/close-self),
 *   只是位置和视觉不同。
 *
 *   主进程已 `frame: false`,这里要负责:
 *   - 提供 -webkit-app-region: drag 拖动区
 *   - 显示应用标题 + 窗口编号 + 版本号
 *   - 监听 evt:window:max-state-changed 切按钮图标 / app-root 圆角
 *
 * @对应文档章节: 软件定义书 6.7 (窗口视觉),M1 待办 P0-1
 */
import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import {
  COMMAND_CHANNELS,
  EVENT_CHANNELS,
  type GetWindowMaxStateResponse,
  type WindowMaxStateChangedPayload,
} from '@shared/protocol';
import type { RemoteDaemonProfile, WindowStyle } from '@shared/types';
import {
  Minus,
  Square,
  Copy as RestoreIcon,
  X,
} from 'lucide-react';
import { focusTerminalDom } from '../focus';
import { useAppState } from '../store';

interface Props {
  windowStyle: WindowStyle;
  buildVersion: string;
  /**
   * DEV-COEXIST 2026-05-16:'dev' / 'portable' 时在 "Marina" 字样后追加
   * 后缀,避免 npm run dev 与打包版同时跑混淆。'installed' 保持原样。
   */
  buildType: 'dev' | 'portable' | 'installed';
}

export function WindowChrome({ windowStyle, buildVersion, buildType }: Props): JSX.Element {
  // P2-18:本组件唯一需要的全局值是 windowNumber,而它在本窗口生命周期内不变
  // (preload 从 URL query 解析,见 ipc-protocol.md 2.2)。直接读 window.api,
  // 避免 useAppState 订阅整个 state 引发的无关重渲。
  const windowNumber = window.api.windowNumber;
  const [maximized, setMaximized] = useState(false);
  const state = useAppState();
  const hoverSymbols = state.settings.appearance?.macOSTrafficLightHoverSymbols ?? false;

  // 初次拉一次 + 订阅变化
  useEffect(() => {
    let cancelled = false;
    void window.api
      .invoke<undefined, GetWindowMaxStateResponse>(
        COMMAND_CHANNELS.WINDOW_GET_MAX_STATE,
        undefined,
      )
      .then((res) => {
        if (!cancelled) setMaximized(res.maximized);
      })
      .catch(() => {});
    const off = window.api.on<WindowMaxStateChangedPayload>(
      EVENT_CHANNELS.WINDOW_MAX_STATE_CHANGED,
      (p) => setMaximized(p.maximized),
    );
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  // BETA-003b 圆角修复:同步 data-maximized 到 <html>,Linux 上 .app-root 的
  // border-radius 在最大化时通过 CSS 选择器去掉(避免最大化后窗口角不贴屏边)。
  useEffect(() => {
    document.documentElement.setAttribute('data-maximized', maximized ? 'true' : 'false');
  }, [maximized]);

  const callMin = (): void => {
    void window.api.invoke(COMMAND_CHANNELS.WINDOW_MINIMIZE, undefined);
    // FOC-3:最小化不需要立刻归还(窗口都缩了),但用户从托盘点回来后
    // (最小化 → 任务栏点回来)Chromium 焦点会落在最后聚焦的 button。
    // 立即归还 — Win 重新显示时 xterm 已经有焦点。
    focusTerminalDom();
  };
  const callToggleMax = (): void => {
    void window.api.invoke(COMMAND_CHANNELS.WINDOW_TOGGLE_MAXIMIZE, undefined);
    // FOC-3:切最大化后焦点应该回 xterm,让用户立即可打字。
    focusTerminalDom();
  };
  const callClose = (): void => {
    // 关闭按钮不归还焦点 — 窗口都关了,无意义。
    void window.api.invoke(COMMAND_CHANNELS.WINDOW_CLOSE_SELF, undefined);
  };

  // 双击标题栏拖动区切最大化(原生 frame 默认行为,自绘后需要自己接)
  const handleDragRegionDblClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    // 只在拖动区本身触发,不要被按钮冒泡进来
    if ((e.target as HTMLElement).closest('.titlebar-btn,.titlebar-traffic')) return;
    callToggleMax();
  };

  // DEV-COEXIST:'Marina (dev) — Window 1' / 'Marina (portable) — ...' / 'Marina — ...'
  const appLabel =
    buildType === 'dev' ? 'Marina (dev)' : buildType === 'portable' ? 'Marina (portable)' : 'Marina';

  // 远程后端标识(每窗口后端 §14.9):本窗口若连了远程 daemon,在标题栏显示
  // 窗口编号后追加上游电脑名字。远程窗口跟本地窗口长得一样会让用户混淆
  // “我是在本地还是远程操作”,必须有视觉区分。
  //
  // 远程后端标识(每窗口后端 §14.9):本窗口若连了远程 daemon,在标题栏显示
  // 窗口编号后追加上游电脑名字。远程窗口跟本地窗口长得一样会让用户混淆
  // “我是在本地还是远程操作”,必须有视觉区分。
  //
  // 数据来源:profileId 读 window.api.backendProfileId(preload 从 URL ?backend=
  // 解析,窗口创建时定死,绝对可靠)。profile 名/host 异步拉本地
  // REMOTE_PROFILE_LIST —— 这是客户端本地凭据(local-control,走客户端本地 IPC,
  // 不经 daemon)。
  // **不**能从 state.remoteBackendProfiles 查:远程窗口的 snapshot 来自 daemon,
  // daemon 的 remoteProfiles 是它自己“能连的电脑”,不含客户端连本 daemon 的凭据。
  const backendProfileId = window.api.backendProfileId;
  const [backendLabel, setBackendLabel] = useState<string | null>(null);
  useEffect(() => {
    if (!backendProfileId) {
      setBackendLabel(null);
      return;
    }
    let cancelled = false;
    // REMOTE_PROFILE_LIST 是 local-control(见 protocol.ts LOCAL_CONTROL_COMMANDS_SET),
    // 远程窗口里也走客户端本地 IPC,返回客户端本地保存的 profile 列表。
    void window.api
      .invoke<undefined, { profiles: RemoteDaemonProfile[] }>(
        COMMAND_CHANNELS.REMOTE_PROFILE_LIST,
        undefined,
      )
      .then((res) => {
        if (cancelled) return;
        const profile = res.profiles.find((p) => p.id === backendProfileId);
        // profile 被删了但窗口还开着 — 显示 id 兒底,至少让用户知道这是远程窗口。
        setBackendLabel(profile ? `${profile.displayName} (${profile.host})` : backendProfileId);
      })
      .catch(() => {
        if (!cancelled) setBackendLabel(backendProfileId);
      });
    return () => {
      cancelled = true;
    };
  }, [backendProfileId]);

  if (windowStyle === 'macos') {
    return (
      <MacosTitlebar
        buildVersion={buildVersion}
        appLabel={appLabel}
        windowNumber={windowNumber}
        backendLabel={backendLabel}
        maximized={maximized}
        callMin={callMin}
        callClose={callClose}
        callToggleMax={callToggleMax}
        hoverSymbols={hoverSymbols}
        handleDragRegionDblClick={handleDragRegionDblClick}
      />
    );
  }

  // Windows 风格(默认):标题在左,控制按钮在右
  return (
    <div
      className="app-titlebar app-titlebar-windows"
      onDoubleClick={handleDragRegionDblClick}
    >
      <div className="titlebar-title titlebar-drag">
        <span className="titlebar-app-name">{appLabel}</span>
        <span className="titlebar-window-badge">Window {windowNumber || '?'}</span>
        {backendLabel && (
          <span className="titlebar-backend-badge" title={`连接到: ${backendLabel}`}>
            <span className="titlebar-backend-arrow" aria-hidden="true">→</span>
            <span className="titlebar-backend-name">{backendLabel}</span>
          </span>
        )}
      </div>
      <div className="titlebar-spacer titlebar-drag" />
      <span className="titlebar-version titlebar-drag">v{buildVersion}</span>
      <div className="titlebar-controls" aria-label="窗口控制(Windows 风格)">
        <button
          type="button"
          className="titlebar-btn min"
          onClick={callMin}
          title="最小化"
          aria-label="最小化窗口"
        >
          <Minus size={14} strokeWidth={1.6} />
        </button>
        <button
          type="button"
          className="titlebar-btn max"
          onClick={callToggleMax}
          title={maximized ? '还原' : '最大化'}
          aria-label={maximized ? '还原窗口' : '最大化窗口'}
        >
          {maximized ? <RestoreIcon size={13} strokeWidth={1.6} /> : <Square size={13} strokeWidth={1.6} />}
        </button>
        <button
          type="button"
          className="titlebar-btn close"
          onClick={callClose}
          title="关闭"
          aria-label="关闭窗口"
        >
          <X size={15} strokeWidth={1.6} />
        </button>
      </div>
    </div>
  );
}

/**
 * macOS 风格标题栏(BETA-023 起从主组件抽出 — 需要读 settings)。
 *
 * 红绿灯按钮的内部符号:
 * - 默认(macOSTrafficLightHoverSymbols=false)hover 不显示符号,保 CP-4 勘误第二轮决定的"极简"观感
 * - 用户开启该 setting 后,hover 时按钮内显示 ×/−/+(对齐原生 macOS)
 *
 * 反转记录:CP-4 勘误第二轮砍掉了 hover 符号,BETA-023(beta 用户反馈)
 * 又把它做成开关,默认仍关。两派(极简派 vs 原生派)都能用。
 *
 * 标题染色(BETA-024 二次修复):与 Windows 风格完全一致 ——
 * "Marina" 用 .titlebar-app-name(iris 紫),"Window N" 用 .titlebar-window-badge(gold 金),
 * 两者直接靠 .titlebar-title 的 gap 8px 分开,不加分隔符。
 */
function MacosTitlebar({
  buildVersion,
  appLabel,
  windowNumber,
  backendLabel,
  maximized,
  callMin,
  callClose,
  callToggleMax,
  hoverSymbols,
  handleDragRegionDblClick,
}: {
  buildVersion: string;
  appLabel: string;
  windowNumber: number;
  backendLabel: string | null;
  maximized: boolean;
  callMin: () => void;
  callClose: () => void;
  callToggleMax: () => void;
  hoverSymbols: boolean;
  handleDragRegionDblClick: (e: ReactMouseEvent<HTMLDivElement>) => void;
}): JSX.Element {
  void maximized; // 当前 UI 中 max 按钮不区分图标,标记 used
  return (
    <div
      className={`app-titlebar app-titlebar-macos${hoverSymbols ? ' show-hover-symbols' : ''}`}
      onDoubleClick={handleDragRegionDblClick}
    >
      <div className="titlebar-traffic" aria-label="窗口控制(macOS 风格)">
        <button
          type="button"
          className="titlebar-traffic-btn close"
          onClick={callClose}
          title="关闭"
          aria-label="关闭窗口"
        >
          {hoverSymbols && (
            <span className="traffic-symbol" aria-hidden="true">
              ×
            </span>
          )}
        </button>
        <button
          type="button"
          className="titlebar-traffic-btn min"
          onClick={callMin}
          title="最小化"
          aria-label="最小化窗口"
        >
          {hoverSymbols && (
            <span className="traffic-symbol" aria-hidden="true">
              −
            </span>
          )}
        </button>
        <button
          type="button"
          className="titlebar-traffic-btn max"
          onClick={callToggleMax}
          title={maximized ? '还原' : '最大化'}
          aria-label={maximized ? '还原窗口' : '最大化窗口'}
        >
          {hoverSymbols && (
            <span className="traffic-symbol" aria-hidden="true">
              +
            </span>
          )}
        </button>
      </div>
      <div className="titlebar-spacer titlebar-drag" />
      <div className="titlebar-title titlebar-drag">
        <span className="titlebar-app-name">{appLabel}</span>
        <span className="titlebar-window-badge">Window {windowNumber || '?'}</span>
        {backendLabel && (
          <span className="titlebar-backend-badge" title={`连接到: ${backendLabel}`}>
            <span className="titlebar-backend-arrow" aria-hidden="true">→</span>
            <span className="titlebar-backend-name">{backendLabel}</span>
          </span>
        )}
      </div>
      <div className="titlebar-spacer titlebar-drag" />
      <span className="titlebar-version titlebar-drag">v{buildVersion}</span>
    </div>
  );
}
