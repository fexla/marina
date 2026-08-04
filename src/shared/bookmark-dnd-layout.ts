/**
 * @file src/shared/bookmark-dnd-layout.ts
 * @purpose 把侧栏收藏 path/group 的真实容器插槽落点转换成 PathManager 需要的全量布局。
 *
 * @关键设计:
 * - 拖拽接口只有 `{targetContainerId,targetIndex}`；不接受像素、起始深度或祖先投影
 * - targetIndex 基于“先移除 active 后”的目标列表，renderer 预览与最终提交共用同一语义
 * - group 容器使用稳定编码：root 与每个 group.subgroups 都是独立容器
 * - path 容器使用未分组常量或 groupId；group/path 类型由调用者隔离
 * - 循环守卫：group 不能进入自身或自身后代
 * - 输入/输出不依赖 React/dnd-kit，renderer/main 测试共用这个 seam
 *
 * @对应文档章节:docs/plans/sidebar-interaction-redesign-rationale-20260804.md 第 3-6 节
 *
 * @不要在这里做的事:
 * - 不根据 pointer delta 猜层级
 * - 不持久化顺序（由 PathManager.reorderBookmarks 负责）
 * - 不决定哪些 DOM 是落点（由 Sidebar 负责注册真实 slot）
 */

/** 未分组收藏 path 的稳定容器 id。 */
export const BOOKMARK_UNGROUPED_CONTAINER = '__marina_ungrouped__';

/** 根级 group 列表的稳定容器 id。 */
export const BOOKMARK_ROOT_GROUP_CONTAINER = '__marina_root_groups__';

const BOOKMARK_SUBGROUP_CONTAINER_PREFIX = '__marina_subgroups__:';

/** 把 groupId 编码为该组直接子组列表的容器 id。 */
export function bookmarkSubgroupContainerId(groupId: string): string {
  return BOOKMARK_SUBGROUP_CONTAINER_PREFIX + encodeURIComponent(groupId);
}

export interface BookmarkPlacement {
  /** path:未分组容器或 groupId；group:root/subgroup 编码容器。 */
  targetContainerId: string;
  /** 基于移除 active 后目标列表的插入位置，范围会安全 clamp 到 0..length。 */
  targetIndex: number;
}

export interface BookmarkGroupOrder {
  id: string;
  /** 直接属于该组的 pathId（有序）。 */
  childOrder: string[];
  /** 直接子组 id（有序）。 */
  subgroupOrder: string[];
}

export interface BookmarkOrderLayout {
  ungrouped: string[];
  /**
   * 全部组（扁平表）。roots = 未被任何 subgroupOrder 引用的 id。
   * roots 相对顺序由它们在数组中的先后表达；子组顺序由父组 subgroupOrder 表达。
   */
  groups: BookmarkGroupOrder[];
}

/** 兼容路径右键旧调用的“命中项”输入；新 DnD 应直接调用 moveBookmarkToPlacement。 */
export interface BookmarkDropTarget {
  activeId: string;
  overId: string;
  overContainerId: string;
}

/**
 * 把 path 移到一个真实 path 容器插槽。
 *
 * `targetIndex` 永远在移除 active 后的目标列表中解释，因此 renderer 只要把当前
 * placeholder 的 container/index 原样提交，释放结果就和预览一致。
 */
export function moveBookmarkToPlacement(
  layout: BookmarkOrderLayout,
  activeId: string,
  placement: BookmarkPlacement,
): BookmarkOrderLayout | null {
  const sourceContainerId = findPathContainer(layout, activeId);
  if (!sourceContainerId || !isKnownPathContainer(layout, placement.targetContainerId)) {
    return null;
  }

  const sourceItems = pathItemsFor(layout, sourceContainerId);
  if (!sourceItems.includes(activeId)) return null;
  const targetWithoutActive = pathItemsFor(layout, placement.targetContainerId).filter(
    (id) => id !== activeId,
  );
  const destinationIndex = normalizeIndex(placement.targetIndex, targetWithoutActive.length);
  if (destinationIndex === null) return null;

  const nextTarget = targetWithoutActive.slice();
  nextTarget.splice(destinationIndex, 0, activeId);
  if (sourceContainerId === placement.targetContainerId) {
    if (sameOrder(sourceItems, nextTarget)) return null;
    return replacePathContainer(layout, sourceContainerId, nextTarget);
  }

  const nextSource = sourceItems.filter((id) => id !== activeId);
  return replacePathContainer(
    replacePathContainer(layout, sourceContainerId, nextSource),
    placement.targetContainerId,
    nextTarget,
  );
}

/**
 * 兼容路径右键“移动到组”和既有调用。命中 path 表示插到该 path 前/arrayMove 到
 * 该 index；命中容器本身表示追加。正式拖拽不再经过这个转换层。
 */
export function moveBookmarkInLayout(
  layout: BookmarkOrderLayout,
  target: BookmarkDropTarget,
): BookmarkOrderLayout | null {
  const sourceContainerId = findPathContainer(layout, target.activeId);
  if (!sourceContainerId || !isKnownPathContainer(layout, target.overContainerId)) return null;
  const targetItems = pathItemsFor(layout, target.overContainerId);
  const overIndex = targetItems.indexOf(target.overId);
  const targetIndex =
    overIndex < 0 ? targetItems.filter((id) => id !== target.activeId).length : overIndex;
  return moveBookmarkToPlacement(layout, target.activeId, {
    targetContainerId: target.overContainerId,
    targetIndex,
  });
}

/**
 * 把 group 移到一个真实 group 容器插槽。
 *
 * root 没有单独的 rootOrder；其顺序通过 groups 扁平表中“未被引用节点”的相对
 * 位置表达。非 root 则直接覆盖目标父级 subgroupOrder。整个过程保留 path 顺序和
 * group 节点本体，不修改输入布局。
 */
export function moveBookmarkGroupToPlacement(
  layout: BookmarkOrderLayout,
  activeGroupId: string,
  placement: BookmarkPlacement,
): BookmarkOrderLayout | null {
  if (!findGroupOrder(layout, activeGroupId)) return null;
  const targetParentId = parentIdForGroupContainer(layout, placement.targetContainerId);
  if (targetParentId === undefined) return null;
  if (
    targetParentId === activeGroupId ||
    (targetParentId !== null && isDescendantGroupInLayout(layout, activeGroupId, targetParentId))
  ) {
    return null;
  }

  const sourceParentId = parentGroupId(layout, activeGroupId);
  const sourceSiblings = directGroupIds(layout, sourceParentId);
  const targetWithoutActive = directGroupIds(layout, targetParentId).filter(
    (id) => id !== activeGroupId,
  );
  const destinationIndex = normalizeIndex(placement.targetIndex, targetWithoutActive.length);
  if (destinationIndex === null) return null;
  const nextTargetSiblings = targetWithoutActive.slice();
  nextTargetSiblings.splice(destinationIndex, 0, activeGroupId);

  if (sourceParentId === targetParentId && sameOrder(sourceSiblings, nextTargetSiblings)) {
    return null;
  }

  const nextLayout: BookmarkOrderLayout = {
    ungrouped: layout.ungrouped.slice(),
    groups: layout.groups.map(cloneGroup),
  };
  // 一个合法树中 active 只会被一个父级引用；全表过滤能在损坏/短暂不同步时避免
  // 遗留双父引用，再由 main 的全量校验作最终防线。
  for (const group of nextLayout.groups) {
    group.subgroupOrder = group.subgroupOrder.filter((id) => id !== activeGroupId);
  }

  if (targetParentId !== null) {
    const targetParent = findGroupOrder(nextLayout, targetParentId);
    if (!targetParent) return null;
    targetParent.subgroupOrder = nextTargetSiblings;
    return nextLayout;
  }

  // root 顺序由扁平表中 root 节点所占槽位表达。active 原来即使是子组，其节点也
  // 常驻扁平表，所以把新 root 集合依次写回这些槽位即可，不扰动其他非 root 节点。
  const rootSet = new Set(nextTargetSiblings);
  const byId = new Map(nextLayout.groups.map((group) => [group.id, group]));
  const rootSlots = nextLayout.groups
    .map((group, index) => (rootSet.has(group.id) ? index : -1))
    .filter((index) => index >= 0);
  if (rootSlots.length !== nextTargetSiblings.length) return null;
  rootSlots.forEach((slot, index) => {
    nextLayout.groups[slot] = byId.get(nextTargetSiblings[index]!)!;
  });
  return nextLayout;
}

/** 返回 path 容器的全量有序 id；未知容器返回 null。 */
export function bookmarkPathIdsForContainer(
  layout: BookmarkOrderLayout,
  containerId: string,
): string[] | null {
  return isKnownPathContainer(layout, containerId)
    ? pathItemsFor(layout, containerId).slice()
    : null;
}

/**
 * 把当前 segment 的可见插槽转换为全量容器 index。
 *
 * renderer 只画 local 或 SSH 条目，但 BOOKMARK_REORDER 必须覆盖混合全量列表。插槽
 * 位于某个可见项前时以该 id 为锚；可见末尾位于最后一个可见项之后、任何隐藏尾项
 * 之前。这样隐藏项不丢失，且释放后的可见顺序与 placeholder 一致。
 */
export function visibleBookmarkSlotToFullIndex(
  fullItems: string[],
  visibleItems: string[],
  activeId: string | undefined,
  visibleTargetIndex: number,
): number | null {
  if (!Number.isFinite(visibleTargetIndex)) return null;
  const fullWithoutActive = fullItems.filter((id) => id !== activeId);
  const visibleWithoutActive = visibleItems.filter((id) => id !== activeId);
  if (visibleWithoutActive.some((id) => !fullWithoutActive.includes(id))) return null;
  const index = Math.max(0, Math.min(Math.round(visibleTargetIndex), visibleWithoutActive.length));
  if (visibleWithoutActive.length === 0) return fullWithoutActive.length;
  if (index < visibleWithoutActive.length) {
    return fullWithoutActive.indexOf(visibleWithoutActive[index]!);
  }
  const lastVisibleIndex = fullWithoutActive.indexOf(visibleWithoutActive.at(-1)!);
  return lastVisibleIndex < 0 ? null : lastVisibleIndex + 1;
}

/** 返回 group 容器中的直接 group id；未知容器返回 null。 */
export function bookmarkGroupIdsForContainer(
  layout: BookmarkOrderLayout,
  containerId: string,
): string[] | null {
  const parentId = parentIdForGroupContainer(layout, containerId);
  return parentId === undefined ? null : directGroupIds(layout, parentId);
}

/** 查询某组是否在指定祖先的子树内（用于循环守卫）。 */
export function isDescendantGroupInLayout(
  layout: BookmarkOrderLayout,
  ancestorId: string,
  candidateId: string,
): boolean {
  const root = findGroupOrder(layout, ancestorId);
  if (!root) return false;
  const stack = [...root.subgroupOrder];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === candidateId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = findGroupOrder(layout, id);
    if (node) stack.push(...node.subgroupOrder);
  }
  return false;
}

/** 返回某组直接父组 id；根组或未知组返回 null。调用前应先校验组存在。 */
export function parentGroupId(layout: BookmarkOrderLayout, groupId: string): string | null {
  for (const group of layout.groups) {
    if (group.subgroupOrder.includes(groupId)) return group.id;
  }
  return null;
}

/** 在扁平表中查找某组。 */
export function findGroupOrder(
  layout: BookmarkOrderLayout,
  groupId: string,
): BookmarkGroupOrder | undefined {
  return layout.groups.find((group) => group.id === groupId);
}

function parentIdForGroupContainer(
  layout: BookmarkOrderLayout,
  containerId: string,
): string | null | undefined {
  if (containerId === BOOKMARK_ROOT_GROUP_CONTAINER) return null;
  if (!containerId.startsWith(BOOKMARK_SUBGROUP_CONTAINER_PREFIX)) return undefined;
  try {
    const groupId = decodeURIComponent(
      containerId.slice(BOOKMARK_SUBGROUP_CONTAINER_PREFIX.length),
    );
    return findGroupOrder(layout, groupId) ? groupId : undefined;
  } catch {
    return undefined;
  }
}

function directGroupIds(layout: BookmarkOrderLayout, parentId: string | null): string[] {
  if (parentId !== null) {
    return findGroupOrder(layout, parentId)?.subgroupOrder.slice() ?? [];
  }
  return layout.groups
    .filter((group) => parentGroupId(layout, group.id) === null)
    .map((group) => group.id);
}

function findPathContainer(layout: BookmarkOrderLayout, pathId: string): string | null {
  if (layout.ungrouped.includes(pathId)) return BOOKMARK_UNGROUPED_CONTAINER;
  return layout.groups.find((group) => group.childOrder.includes(pathId))?.id ?? null;
}

function isKnownPathContainer(layout: BookmarkOrderLayout, containerId: string): boolean {
  return (
    containerId === BOOKMARK_UNGROUPED_CONTAINER ||
    layout.groups.some((group) => group.id === containerId)
  );
}

function pathItemsFor(layout: BookmarkOrderLayout, containerId: string): string[] {
  if (containerId === BOOKMARK_UNGROUPED_CONTAINER) return layout.ungrouped;
  return layout.groups.find((group) => group.id === containerId)?.childOrder ?? [];
}

function replacePathContainer(
  layout: BookmarkOrderLayout,
  containerId: string,
  childOrder: string[],
): BookmarkOrderLayout {
  if (containerId === BOOKMARK_UNGROUPED_CONTAINER) {
    return { ungrouped: childOrder, groups: layout.groups.map(cloneGroup) };
  }
  return {
    ungrouped: layout.ungrouped.slice(),
    groups: layout.groups.map((group) =>
      group.id === containerId ? { ...group, childOrder } : cloneGroup(group),
    ),
  };
}

function cloneGroup(group: BookmarkGroupOrder): BookmarkGroupOrder {
  return {
    ...group,
    childOrder: group.childOrder.slice(),
    subgroupOrder: group.subgroupOrder.slice(),
  };
}

function normalizeIndex(value: number, length: number): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(Math.round(value), length));
}

function sameOrder<T>(left: T[], right: T[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
