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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export interface ContextMenuItem {
  /** 显示文本 */
  label: string;
  /** 悬停 tooltip */
  hint?: string;
  /** ✓ 标记(单选组场景);与 icon 互斥,icon 优先 */
  checked?: boolean;
  /**
   * 自定义前置图标(替代 ✓ 槽位)。用于终端"复制/粘贴/清屏/搜索"等
   * 行为型菜单。提供后 checked 字段被忽略。
   */
  icon?: ReactNode;
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
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  // FOC-5:打开菜单前记录当前焦点 element,关闭时归还。
  //
  // 没有这个保护:用户右键终端 → 弹菜单 → 选/不选关闭 → 菜单 button
  // 接管了 :focus → 菜单 unmount 后焦点漂到 body → 用户敲键无反应。
  // 用户反馈"复制后打不进字 / 右键关菜单后打不进字"的根因。
  //
  // 设计:rAF 内做归还,且只在 activeElement 已落回 body / 已 unmount
  // 时归还 — 避免覆盖菜单项 onSelect 内主动改的焦点(如 Sidebar
  // beginRename 把焦点送给重命名输入框)。
  const previousActiveElementRef = useRef<Element | null>(null);

  const close = useCallback(() => {
    setMenu(null);
    const prev = previousActiveElementRef.current;
    previousActiveElementRef.current = null;
    if (!prev) return;
    requestAnimationFrame(() => {
      const cur = document.activeElement;
      // 当前焦点已被 onSelect 内的 action 接管(如重命名 input)→ 不打扰
      if (cur && cur !== document.body && cur !== document.documentElement) {
        return;
      }
      // prev 可能在菜单关闭过程中被 unmount (如 xterm 重挂),验证仍在 DOM
      if (prev instanceof HTMLElement && document.body.contains(prev)) {
        prev.focus();
      } else {
        // prev 已不在 DOM,fallback 到 xterm helper-textarea(若仍存在)
        const ta = document.querySelector<HTMLTextAreaElement>(
          '.xterm-helper-textarea',
        );
        ta?.focus();
      }
    });
  }, []);

  const api = useMemo<ContextMenuApi>(
    () => ({
      open: (s) => {
        // 仅在首次打开时捕获(连开菜单 / 嵌套场景不要把上一个菜单的
        // ctx-menu-item 错存为 previous)
        if (!previousActiveElementRef.current) {
          previousActiveElementRef.current = document.activeElement;
        }
        setPos(null);
        setMenu(s);
      },
      close,
    }),
    [close],
  );

  // 全局关闭触发器
  useEffect(() => {
    if (!menu) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    const onMouseDown = (): void => close();
    // OVR-2:滚轮关闭仅对菜单外触发。原实现"任意 wheel → close",触摸板
    // 轻微 jitter 即关菜单,且长菜单(默认模板列表 8+ 项)内部无法滚动
    // 查看 — 一滚就关。改成菜单内 wheel 透传给浏览器(配合 CSS overflow-y),
    // 菜单外 wheel 仍按原行为关闭。
    const onWheel = (e: WheelEvent): void => {
      const target = e.target as Node | null;
      if (target && menuRef.current?.contains(target)) return;
      close();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('wheel', onWheel, { passive: true });
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('wheel', onWheel);
    };
  }, [menu, close]);

  // 视口边缘越界修正:测量实际尺寸后,优先翻转到点击点反向,再做夹紧兜底
  useLayoutEffect(() => {
    if (!menu) return;
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 4;
    let nx = menu.x;
    let ny = menu.y;
    if (nx + rect.width > vw - margin) {
      const flipped = menu.x - rect.width;
      nx = flipped >= margin ? flipped : Math.max(margin, vw - rect.width - margin);
    }
    if (ny + rect.height > vh - margin) {
      const flipped = menu.y - rect.height;
      ny = flipped >= margin ? flipped : Math.max(margin, vh - rect.height - margin);
    }
    setPos({ x: nx, y: ny });
  }, [menu]);

  return (
    <Ctx.Provider value={api}>
      {children}
      {menu && (
        <div
          ref={menuRef}
          className="ctx-menu"
          style={{
            left: pos ? pos.x : menu.x,
            top: pos ? pos.y : menu.y,
            visibility: pos ? 'visible' : 'hidden',
          }}
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
                <span className="ctx-menu-check">
                  {it.icon ?? (it.checked ? '✓' : ' ')}
                </span>
                <span className="ctx-menu-label">{it.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </Ctx.Provider>
  );
}
