/**
 * @file src/renderer/components/TerminalToolbar.tsx
 * @purpose BETA-028 终端工具栏:Tab bar 右端的快捷动作。
 *
 *   按钮(从左到右):
 *   - 复制全部 scrollback(ClipboardCopy)
 *   - 清屏(Eraser)— 同时清 main 端 ring buffer + xterm 显示
 *   - 搜索(Search)— 触发现有 search overlay,等同 Ctrl+F
 *   - 简易页面切换(Minimize2/Maximize2)— BETA-027
 *
 *   清屏 / 搜索需要触达 TerminalView 实例,采用 CustomEvent 解耦:
 *     工具栏 dispatchEvent('marina:terminal-clear' / 'marina:terminal-open-search')
 *     TerminalView 用 useEffect 监听 → 调 term.clear() / 打开 search bar。
 *
 *   全部钩在当前 displayableSession;无 session 时按钮禁用(除简易模式开关)。
 *
 * @对应文档章节: 软件定义书 6.x 增强;工单库 BETA-027 / BETA-028
 */
import { ClipboardCopy, Eraser, Maximize2, Minimize2, Search } from 'lucide-react';
import { COMMAND_CHANNELS } from '@shared/protocol';
import { useAppDispatch, useAppState, getDisplayableSession } from '../store';
import { useToast } from './Toast';
import { useTranslation } from './LanguageProvider';
import { writeClipboardText } from '../clipboard';

interface TerminalToolbarProps {
  /**
   * 'inline' = 嵌入在 tab-bar 右端;'floating' = 简易模式下浮在窗口右上角。
   * 影响外层 class 与定位策略。
   */
  variant: 'inline' | 'floating';
}

export function TerminalToolbar({ variant }: TerminalToolbarProps): JSX.Element {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const toast = useToast();
  const { t } = useTranslation();
  const session = getDisplayableSession(state);
  const sessionId = session?.id;
  const simpleMode = state.simpleMode;

  const handleCopyAll = async (): Promise<void> => {
    if (!sessionId) return;
    try {
      const res = await window.api.invoke<{ sessionId: string }, { text: string }>(
        COMMAND_CHANNELS.SESSION_EXPORT_SCROLLBACK,
        { sessionId },
      );
      const text = res.text ?? '';
      if (!text) {
        toast.push({ kind: 'info', message: t('terminal.toolbar.emptyScrollback') });
        return;
      }
      const ok = await writeClipboardText(text);
      if (!ok) throw new Error('写入剪贴板失败');
      const lineCount = text.split('\n').length;
      toast.push({ kind: 'success', message: t('terminal.toolbar.copied', { lines: lineCount }) });
    } catch (err) {
      toast.push({
        kind: 'error',
        message: `复制失败:${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const handleClear = async (): Promise<void> => {
    if (!sessionId) return;
    try {
      await window.api.invoke<{ sessionId: string }, void>(
        COMMAND_CHANNELS.SESSION_CLEAR_SCROLLBACK,
        { sessionId },
      );
      // 通知本窗口的 TerminalView 调 term.clear()
      window.dispatchEvent(
        new CustomEvent('marina:terminal-clear', { detail: { sessionId } }),
      );
    } catch (err) {
      toast.push({
        kind: 'error',
        message: `清屏失败:${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const handleSearch = (): void => {
    if (!sessionId) return;
    window.dispatchEvent(
      new CustomEvent('marina:terminal-open-search', { detail: { sessionId } }),
    );
  };

  const handleToggleSimple = (): void => {
    dispatch({ type: 'view/toggle-simple-mode' });
  };

  const disabled = !sessionId;

  return (
    <div className={`terminal-toolbar terminal-toolbar-${variant}`}>
      <button
        type="button"
        className="terminal-toolbar-btn"
        onClick={() => void handleCopyAll()}
        disabled={disabled}
        title={t('terminal.toolbar.copyAll')}
        aria-label={t('terminal.toolbar.copyAll')}
      >
        <ClipboardCopy size={14} />
      </button>
      <button
        type="button"
        className="terminal-toolbar-btn"
        onClick={() => void handleClear()}
        disabled={disabled}
        title={t('terminal.toolbar.clear')}
        aria-label={t('terminal.toolbar.clear')}
      >
        <Eraser size={14} />
      </button>
      <button
        type="button"
        className="terminal-toolbar-btn"
        onClick={handleSearch}
        disabled={disabled}
        title={t('terminal.toolbar.search')}
        aria-label={t('common.search')}
      >
        <Search size={14} />
      </button>
      <button
        type="button"
        className="terminal-toolbar-btn"
        onClick={handleToggleSimple}
        title={simpleMode ? t('terminal.toolbar.fromSimple') : t('terminal.toolbar.toSimple')}
        aria-label={simpleMode ? t('terminal.toolbar.fromSimple') : t('terminal.toolbar.toSimple')}
      >
        {simpleMode ? <Maximize2 size={14} /> : <Minimize2 size={14} />}
      </button>
    </div>
  );
}
