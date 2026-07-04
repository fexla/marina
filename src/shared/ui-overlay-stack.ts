/**
 * @file src/shared/ui-overlay-stack.ts
 * @purpose Overlay 优先级栈的纯命令式核心 — Modal / ContextMenu 等覆盖层
 *   的 Esc 派发权威。React hook 包装在 `src/renderer/use-overlay-registration.ts`。
 *
 *   背景:此前 Modal.tsx 与 ContextMenu.tsx 各自挂 window 'keydown' listener
 *   拦 Esc。两个同时存在(如:右键菜单上点"删除收藏"弹 confirm Modal)时,
 *   Esc 由"注册顺序的隐式优先级"决定谁吃 — 不可预测,且取决于 React 渲染
 *   顺序。
 *
 *   现在每个 overlay 在 mount 时 push 一个 id 进栈,unmount 时 pop;keydown
 *   listener 在响应前先问 isTopOverlay(myId) — 仅栈顶才吃。多 overlay 嵌套
 *   时 Esc 永远从最上层关起,符合用户直觉。
 *
 * @模型:
 *   - 单例 stack(模块级 number[]),不走 React Context — 跨组件读写无需
 *     prop drilling,且不引入响应式订阅噪声
 *   - id 是单调递增 number,避免重名冲突;pop 用 lastIndexOf 容忍乱序 pop
 *     (如:某 overlay 在另一个 overlay 之前先 unmount)
 *
 * @不变式:
 *   1. 每次 push 必须有配对的 pop(React hook 包装的 useEffect cleanup 保证)
 *   2. isTopOverlay 读取时不能修改 stack — 仅查询
 *   3. 注册顺序无关:isTop 只看当前栈顶,不看注册时间
 *
 * @不属于本模块的范围:
 *   - 搜索栏 Esc:由 xterm `attachCustomKeyEventHandler` 路径接住
 *     (焦点在 terminal helper-textarea 上,与 Modal/ContextMenu 不冲突)
 *   - 全局 Esc 兜底关任何 overlay:不做 — 每个 overlay 自己决定 Esc 语义
 *
 * @放在 shared 而非 renderer 的理由:
 *   - 纯逻辑、无 react / DOM 依赖,适合在 src/shared 下被 vitest 覆盖
 *     (vitest 配置只测 src/main + src/shared,见 AGENTS.md §5.1)
 *   - React hook 包装 (useOverlayRegistration) 留在 renderer 端
 */

const stack: number[] = [];
let nextId = 1;

export interface OverlayRegistration {
  id: number;
  pop: () => void;
}

/** 命令式 API — push 一个 overlay 进栈,返回 pop 句柄 */
export function pushOverlay(): OverlayRegistration {
  const id = nextId++;
  stack.push(id);
  return {
    id,
    pop: () => {
      const idx = stack.lastIndexOf(id);
      if (idx >= 0) stack.splice(idx, 1);
    },
  };
}

/** 给定 id 是否当前栈顶 */
export function isTopOverlay(id: number): boolean {
  return stack.length > 0 && stack[stack.length - 1] === id;
}

/** 任意 overlay 是否存在 */
export function hasAnyOverlay(): boolean {
  return stack.length > 0;
}

/** 当前栈顶 id,无 overlay 时 null。用于诊断 / 测试 */
export function topOverlayId(): number | null {
  if (stack.length === 0) return null;
  // noUncheckedIndexedAccess 下 stack[i] 是 number | undefined;
  // 上面的长度检查已经保证非空,?? null 仅为类型兜底
  return stack[stack.length - 1] ?? null;
}

/** 仅测试用:重置栈状态 */
export function __resetOverlayStackForTesting(): void {
  stack.length = 0;
  nextId = 1;
}
