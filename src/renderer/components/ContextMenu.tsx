/**
 * @file src/renderer/components/ContextMenu.tsx
 * @purpose 全局上下文菜单 Provider — M1-C 抽离 (CP-3 时只在 Sidebar 内嵌)。
 *
 *   现在 Sidebar / MainPane / Tab / SessionItem 等任何深层组件都可以
 *   useContextMenuApi() 调 open(state) 弹菜单。Esc / 外部 click / 滚轮关闭。
 *
 *   菜单项支持 disabled / danger / divider 三个视觉变体。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export interface ContextMenuItem {
  /** 显示文本 */
  label: string;
  /** 悬停 tooltip */
  hint?: string;
  /** ✓ 标记(单选组场景) */
  checked?: boolean;
  /** 灰显 + 不响应点击 */
  disabled?: boolean;
  /** 视觉为危险(红色) — 用于"删除"等 */
  danger?: boolean;
  /** 分隔符;若为 true,其他字段忽略 */
  divider?: boolean;
  /** 点击触发,菜单自动关闭 */
  onSelect?: () => void | Promise<void>;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
  title?: string;
}

export interface ContextMenuApi {
  open(state: ContextMenuState): void;
  close(): void;
}

const Ctx = createContext<ContextMenuApi | null>(null);

export function useContextMenuApi(): ContextMenuApi {
  const v = useContext(Ctx);
  if (!v) {
    throw new Error('[ContextMenu] useContextMenuApi must be inside ContextMenuProvider');
  }
  return v;
}

export function ContextMenuProvider({ children }: { children: ReactNode }): JSX.Element {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const close = useCallback(() => setMenu(null), []);
  const api = useMemo<ContextMenuApi>(
    () => ({ open: setMenu, close }),
    [close],
  );

  // 全局关闭触发器
  useEffect(() => {
    if (!menu) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    const onMouseDown = (): void => close();
    const onWheel = (): void => close();
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('wheel', onWheel, { passive: true });
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('wheel', onWheel);
    };
  }, [menu, close]);

  return (
    <Ctx.Provider value={api}>
      {children}
      {menu && (
        <div
          className="ctx-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
          role="menu"
        >
          {menu.title && <div className="ctx-menu-title">{menu.title}</div>}
          {menu.items.map((it, idx) => {
            if (it.divider) {
              return <div key={idx} className="ctx-menu-divider" role="separator" />;
            }
            return (
              <button
                key={idx}
                type="button"
                className={
                  'ctx-menu-item' +
                  (it.checked ? ' checked' : '') +
                  (it.danger ? ' danger' : '')
                }
                disabled={!!it.disabled}
                title={it.hint}
                onClick={() => {
                  if (it.disabled) return;
                  void it.onSelect?.();
                  close();
                }}
              >
                <span className="ctx-menu-check">{it.checked ? '✓' : ' '}</span>
                <span className="ctx-menu-label">{it.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </Ctx.Provider>
  );
}
