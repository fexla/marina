/**
 * @file BackendDirectoryPicker.tsx
 * @purpose 远程后端窗口的点击式文件夹选择器；分层浏览当前 backend 文件系统，
 *   替代 daemon 无法显示的 Electron native dialog。
 *
 * @关键设计:
 * - 路径只读：用户只能点 Home / 根 / 上一级 / 子目录，遵守“不让用户输入路径”
 * - DIRECTORY_PICKER_LIST 是 backend-data；远程窗口自动经 WS 浏览 daemon 机器
 * - 一次只拉一层目录；请求序号防止慢响应覆盖用户后续导航
 * - 复用全局 overlay 栈、焦点 trap 和焦点归还，不抢终端输入
 *
 * @对应文档章节:软件定义书.md 第 2 章原则 2、第 5.1.1、6.2.4、7.1 节
 *
 * @不要在这里做的事:
 * - 不要加路径文本框或“粘贴路径”入口
 * - 不要递归预拉整棵目录树
 * - 不要把目录列举改成 local-control（会浏览错电脑）
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronUp, Folder, HardDrive, Home, RefreshCw } from 'lucide-react';
import {
  COMMAND_CHANNELS,
  type ListDirectoryPickerResponse,
} from '@shared/protocol';
import { useOverlayRegistration } from '../ui-overlay-stack';

interface BackendDirectoryPickerProps {
  title: string;
  confirmLabel: string;
  initialPath?: string;
  onCancel: () => void;
  onSelect: (path: string) => void;
}

/**
 * 浏览并选择当前 backend 上的目录。
 *
 * `initialPath` 仅作首次定位；无效/无权限时错误留在 modal 内，用户仍可点 Home
 * 回到 backend 用户主目录。确认按钮选择“当前正在浏览的目录”。
 */
export function BackendDirectoryPicker({
  title,
  confirmLabel,
  initialPath,
  onCancel,
  onSelect,
}: BackendDirectoryPickerProps): JSX.Element {
  const [listing, setListing] = useState<ListDirectoryPickerResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previousActiveElementRef = useRef<Element | null>(null);
  const requestSequenceRef = useRef(0);
  const { isTop } = useOverlayRegistration(true);

  const loadDirectory = useCallback(async (path?: string): Promise<void> => {
    const sequence = ++requestSequenceRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await window.api.invoke(COMMAND_CHANNELS.DIRECTORY_PICKER_LIST, path ? { path } : {});
      if (sequence !== requestSequenceRef.current) return;
      setListing(result);
    } catch (caught: unknown) {
      if (sequence !== requestSequenceRef.current) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (sequence === requestSequenceRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDirectory(initialPath);
  }, [initialPath, loadDirectory]);

  // 打开时聚焦第一个操作按钮；关闭时仅在焦点落回 body 时归还到原加号。
  useEffect(() => {
    previousActiveElementRef.current = document.activeElement;
    requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
    });
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || event.keyCode === 229 || !isTop()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
  }, [isTop, onCancel]);

  return (
    <div className="app-modal-backdrop" role="presentation">
      <div
        ref={panelRef}
        className="app-modal-panel backend-directory-picker"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="backend-directory-picker"
      >
        <div className="app-modal-title">{title}</div>
        <div
          className="backend-directory-picker-location"
          title={listing?.currentPath ?? initialPath ?? ''}
        >
          {listing?.currentPath ?? initialPath ?? '正在读取远程电脑主目录…'}
        </div>

        <div className="backend-directory-picker-toolbar" aria-label="目录导航">
          <button
            type="button"
            className="app-modal-button"
            title="主目录"
            aria-label="主目录"
            disabled={loading}
            onClick={() => void loadDirectory(listing?.homePath)}
          >
            <Home size={14} /> 主目录
          </button>
          <button
            type="button"
            className="app-modal-button"
            title="文件系统根目录"
            aria-label="文件系统根目录"
            disabled={loading || !listing}
            onClick={() => void loadDirectory(listing?.rootPath)}
          >
            <HardDrive size={14} /> 根目录
          </button>
          <button
            type="button"
            className="app-modal-button"
            title="上一级"
            aria-label="上一级"
            disabled={loading || !listing?.parentPath}
            onClick={() => void loadDirectory(listing?.parentPath ?? undefined)}
          >
            <ChevronUp size={14} /> 上一级
          </button>
          <button
            type="button"
            className="app-modal-button backend-directory-picker-refresh"
            title="刷新"
            aria-label="刷新"
            disabled={loading}
            onClick={() => void loadDirectory(listing?.currentPath ?? initialPath)}
          >
            <RefreshCw size={14} />
          </button>
        </div>

        <div className="backend-directory-picker-list" aria-live="polite">
          {loading && !listing && <div className="backend-directory-picker-state">正在读取…</div>}
          {error && (
            <div className="backend-directory-picker-state error" role="alert">
              <span>{error}</span>
              <button
                type="button"
                className="app-modal-button"
                onClick={() => void loadDirectory(undefined)}
              >
                回到主目录
              </button>
            </div>
          )}
          {!error && listing && listing.directories.length === 0 && (
            <div className="backend-directory-picker-state">这里没有子文件夹</div>
          )}
          {!error &&
            listing?.directories.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className="backend-directory-picker-row"
                title={entry.path}
                onClick={() => void loadDirectory(entry.path)}
              >
                <Folder size={15} aria-hidden="true" />
                <span>{entry.name}</span>
              </button>
            ))}
        </div>

        <div className="app-modal-actions">
          <button type="button" className="app-modal-button" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="app-modal-button app-modal-button-primary"
            disabled={loading || !listing || !!error}
            onClick={() => listing && onSelect(listing.currentPath)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
