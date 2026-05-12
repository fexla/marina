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
import type { WindowStyle } from '@shared/types';
import { Minimize2, Minus, Square, Copy as RestoreIcon, X } from 'lucide-react';
import { useAppState } from '../store';

void Minimize2; // 暂未使用,保留 import 防止 tree-shake 误删

interface Props {
  windowStyle: WindowStyle;
  buildVersion: string;
}

export function WindowChrome({ windowStyle, buildVersion }: Props): JSX.Element {
  const state = useAppState();
  const [maximized, setMaximized] = useState(false);

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

  const callMin = (): void => {
    void window.api.invoke(COMMAND_CHANNELS.WINDOW_MINIMIZE, undefined);
  };
  const callToggleMax = (): void => {
    void window.api.invoke(COMMAND_CHANNELS.WINDOW_TOGGLE_MAXIMIZE, undefined);
  };
  const callClose = (): void => {
    void window.api.invoke(COMMAND_CHANNELS.WINDOW_CLOSE_SELF, undefined);
  };

  // 双击标题栏拖动区切最大化(原生 frame 默认行为,自绘后需要自己接)
  const handleDragRegionDblClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    // 只在拖动区本身触发,不要被按钮冒泡进来
    if ((e.target as HTMLElement).closest('.titlebar-btn,.titlebar-traffic')) return;
    callToggleMax();
  };

  const title = `Marina — Window ${state.myWindowNumber || '?'}`;

  if (windowStyle === 'macos') {
    return (
      <div
        className="app-titlebar app-titlebar-macos"
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
            <X size={8} strokeWidth={2.5} />
          </button>
          <button
            type="button"
            className="titlebar-traffic-btn min"
            onClick={callMin}
            title="最小化"
            aria-label="最小化窗口"
          >
            <Minus size={8} strokeWidth={2.5} />
          </button>
          <button
            type="button"
            className="titlebar-traffic-btn max"
            onClick={callToggleMax}
            title={maximized ? '还原' : '最大化'}
            aria-label={maximized ? '还原窗口' : '最大化窗口'}
          >
            {maximized ? <RestoreIcon size={8} strokeWidth={2.5} /> : <Square size={8} strokeWidth={2.5} />}
          </button>
        </div>
        <div className="titlebar-spacer titlebar-drag" />
        <div className="titlebar-title titlebar-drag">{title}</div>
        <div className="titlebar-spacer titlebar-drag" />
        <span className="titlebar-version titlebar-drag">v{buildVersion}</span>
      </div>
    );
  }

  // Windows 风格(默认):标题在左,控制按钮在右
  return (
    <div
      className="app-titlebar app-titlebar-windows"
      onDoubleClick={handleDragRegionDblClick}
    >
      <div className="titlebar-title titlebar-drag">
        <span className="titlebar-app-name">Marina</span>
        <span className="titlebar-window-badge">Window {state.myWindowNumber || '?'}</span>
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
