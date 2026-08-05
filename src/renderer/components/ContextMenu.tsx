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
import { createPortal } from 'react-dom';
import { useOverlayRegistration } from '../ui-overlay-stack';

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
  /** 不在当前上下文渲染(hover 展开的子菜单里做条件过滤用) */
  hidden?: boolean;
  /**
   * 子菜单(悬停展开)。有 submenu 时点击父项不触发 onSelect。
   * 用于"移动到分组 / 默认模板 / 复制信息"等二级任务。
   */
  submenu?: ContextMenuItem[];
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
  // 子菜单当前展开的父项 index(null = 无)。切换父项 hover 时替换。
  const [submenuIndex, setSubmenuIndex] = useState<number | null>(null);
  // 顶层菜单项的 wrap DOM(ref)。子菜单 portal 到 document.body 后无法用
  // parentElement 找定位基准,由这里显式持有并传给 SubmenuMenu。
  const wrapRefs = useRef<Array<HTMLDivElement | null>>([]);
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
    setSubmenuIndex(null);
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

  // KBD-1:接入 UiOverlayStack — 菜单 mount 时 push,unmount 时 pop。
  // Esc 仅在我是栈顶时响应,Modal 弹在菜单之上时让 Modal 先吃 Esc。
  const { isTop } = useOverlayRegistration(!!menu);

  // 全局关闭触发器
  useEffect(() => {
    if (!menu) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      // IME 守卫:中文 IME 选词的 Esc 不应误关菜单
      if (e.isComposing || e.keyCode === 229) return;
      if (!isTop()) return; // 我不是栈顶,让上层 overlay 吃 Esc
      if (e.key === 'Escape') close();
    };
    // 菜单及所有子菜单内部的 mousedown / wheel 不关闭菜单。子菜单通过
    // createPortal 渲染在 document.body 下(见 SubmenuMenu),不在 menuRef
    // 的 DOM 子树内,所以用 class 判定(覆盖任意层级的子菜单)而不是 contains。
    const isInsideMenu = (target: EventTarget | null): boolean =>
      target instanceof Element && !!target.closest('.ctx-menu, .ctx-submenu');
    const onMouseDown = (e: MouseEvent): void => {
      if (isInsideMenu(e.target)) return;
      close();
    };
    // OVR-2:滚轮关闭仅对菜单外触发。原实现"任意 wheel → close",触摸板
    // 轻微 jitter 即关菜单,且长菜单(默认模板列表 8+ 项)内部无法滚动
    // 查看 — 一滚就关。改成菜单内 wheel 透传给浏览器(配合 CSS overflow-y),
    // 菜单外 wheel 仍按原行为关闭。
    const onWheel = (e: WheelEvent): void => {
      if (isInsideMenu(e.target)) return;
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
  }, [menu, close, isTop]);

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
            if (it.hidden) return null;
            if (it.divider) {
              return <div key={idx} className="ctx-menu-divider" role="separator" />;
            }
            const hasSubmenu = !!it.submenu && it.submenu.length > 0;
            return (
              <div
                key={idx}
                ref={(el) => {
                  // ref 回调在 commit 的 mutation 阶段执行,早于子组件
                  // SubmenuMenu 的 useLayoutEffect,因此 anchorEl 必可用。
                  wrapRefs.current[idx] = el;
                }}
                className={`ctx-menu-item-wrap${submenuIndex === idx ? ' submenu-open' : ''}`}
                onMouseEnter={() => setSubmenuIndex(hasSubmenu ? idx : null)}
              >
                <button
                  type="button"
                  className={
                    'ctx-menu-item' +
                    (it.checked ? ' checked' : '') +
                    (it.danger ? ' danger' : '') +
                    (hasSubmenu ? ' has-submenu' : '')
                  }
                  disabled={!!it.disabled}
                  title={it.hint}
                  onClick={() => {
                    if (it.disabled || hasSubmenu) return;
                    void it.onSelect?.();
                    close();
                  }}
                >
                  <span className="ctx-menu-check">
                    {it.icon ?? (it.checked ? '✓' : ' ')}
                  </span>
                  <span className="ctx-menu-label">{it.label}</span>
                  {hasSubmenu && <span className="ctx-menu-submenu-arrow">▸</span>}
                </button>
                {hasSubmenu && submenuIndex === idx && (
                  <SubmenuMenu
                    items={it.submenu!}
                    onSelect={close}
                    anchorEl={wrapRefs.current[idx] ?? null}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </Ctx.Provider>
  );
}

/**
 * 子菜单：悬停展开的悬浮层。
 *
 * @为什么 portal + fixed 坐标,而不是 absolute 挂在父项 wrap 上:
 * .ctx-menu 是 overflow-y: auto 的滚动容器(OVR-2 长菜单内部滚动)。滚动
 * 容器会裁剪内部 absolute 的后代 —— 子菜单展开超出父菜单可视区时,表现为
 * 父菜单冒出横/竖滚动条、子菜单被夹在容器里(用户反馈:「复制信息」悬停
 * 出现滚动条而非悬浮 UI)。portal 到 document.body + fixed 坐标后,子菜单
 * 成为真正的悬浮层,父菜单的滚动区域不再受它影响。
 *
 * 坐标:贴父项 wrap 右侧展开;视口右侧不足时翻转到左侧(语义同旧 .flip
 * class);上/下越界夹紧。与顶层菜单的越界修正(menuRef)同一套思路。
 *
 * 关闭(Esc / 外部点击 / 滚轮)仍由父菜单统一处理 —— Provider 的关闭
 * 判定用 closest('.ctx-menu, .ctx-submenu') 覆盖 portal 出去的子树。
 */
function SubmenuMenu({
  items,
  onSelect,
  anchorEl,
}: {
  items: ContextMenuItem[];
  onSelect: () => void;
  /** 父项 wrap(定位基准)。portal 后 DOM 父级是 body,不能用 parentElement。 */
  anchorEl: HTMLDivElement | null;
}): JSX.Element {
  const submenuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [subIndex, setSubIndex] = useState<number | null>(null);
  // 本层子菜单项的 wrap DOM,供嵌套子菜单(递归 SubmenuMenu)做定位基准。
  const subWrapRefs = useRef<Array<HTMLDivElement | null>>([]);

  // 挂载时测量一次:先以 visibility:hidden 渲染(不闪),量完再显示。
  // anchorEl 变化(菜单项重排)时重新测量。
  const measure = useCallback(() => {
    const el = submenuRef.current;
    if (!el || !anchorEl) return;
    const pr = anchorEl.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 4;
    // 默认在父项右侧展开;视口右侧不足 → 翻转到左侧。
    let x = pr.right + margin;
    if (x + w > vw - margin) x = pr.left - w - margin;
    if (x < margin) x = margin; // 极端窄屏兜底
    // 顶部与父项对齐(略高 5px,保持旧视觉);底部越界向上夹紧。
    let y = pr.top - 5;
    if (y + h > vh - margin) y = Math.max(margin, vh - h - margin);
    setPos({ x, y });
  }, [anchorEl]);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  // 父菜单是 overflow 滚动容器(OVR-2)。原 absolute 实现里子菜单跟随 wrap
  // 一起滚动;fixed 不跟随,父菜单滚动后子菜单会与父项错位,所以监听滚动
  // 容器的 scroll 重测坐标(子菜单展开时滚动父菜单的场景)。
  useEffect(() => {
    const scroller = anchorEl?.closest('.ctx-menu');
    if (!scroller) return undefined;
    scroller.addEventListener('scroll', measure, { passive: true });
    return () => scroller.removeEventListener('scroll', measure);
  }, [anchorEl, measure]);

  return createPortal(
    <div
      ref={submenuRef}
      className="ctx-submenu"
      style={{
        left: pos?.x ?? 0,
        top: pos?.y ?? 0,
        visibility: pos ? 'visible' : 'hidden',
      }}
      role="menu"
    >
      {items.map((it, idx) => {
        if (it.hidden) return null;
        if (it.divider) {
          return <div key={idx} className="ctx-menu-divider" role="separator" />;
        }
        const hasSubmenu = !!it.submenu && it.submenu.length > 0;
        return (
          <div
            key={idx}
            ref={(el) => {
              subWrapRefs.current[idx] = el;
            }}
            className="ctx-menu-item-wrap"
            onMouseEnter={() => setSubIndex(hasSubmenu ? idx : null)}
          >
            <button
              type="button"
              className={
                'ctx-menu-item' +
                (it.checked ? ' checked' : '') +
                (it.danger ? ' danger' : '') +
                (hasSubmenu ? ' has-submenu' : '')
              }
              disabled={!!it.disabled}
              title={it.hint}
              onClick={() => {
                if (it.disabled || hasSubmenu) return;
                void it.onSelect?.();
                onSelect();
              }}
            >
              <span className="ctx-menu-check">
                {it.icon ?? (it.checked ? '✓' : ' ')}
              </span>
              <span className="ctx-menu-label">{it.label}</span>
              {hasSubmenu && <span className="ctx-menu-submenu-arrow">▸</span>}
            </button>
            {hasSubmenu && subIndex === idx && (
              <SubmenuMenu
                items={it.submenu!}
                onSelect={onSelect}
                anchorEl={subWrapRefs.current[idx] ?? null}
              />
            )}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
