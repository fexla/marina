/**
 * @file src/shared/bookmark-dnd-layout.ts
 * @purpose 把收藏路径/分组的一次 dnd-kit 落点转换成 PathManager 需要的完整分层顺序。
 *
 * @关键设计:
 * - 输入/输出都只含 pathId / groupId，不依赖 React 或 dnd-kit，便于锁住排序语义
 * - 分组是树（v0.3.3 用户裁决：子组可嵌套递归）；布局用「全量组扁平表」表达树：
 *   `groups` 含所有组（含子组），`subgroupOrder` 指向子组 id，roots = 未被任何
 *   组的 subgroupOrder 引用的组。扁平表让"找容器 / 找父组 / 换 childOrder"都是
 *   O(n) 数组操作，避免递归查找；后端 reorderBookmarks 再按引用重建森林。
 * - 源容器从当前布局查找，不相信拖拽事件里的缓存索引，避免树更新后用旧 index
 * - 同容器使用 dnd-kit arrayMove 语义：向下拖到目标项时放在目标项之后
 * - 跨容器落在 path 上时插到该 path 前；落在容器本身时追加到容器末尾
 * - 分组树的新拖动模型把「命中的组行」「行前/行后」「横向目标深度」先投影为
 *   精确 placement（目标父组 + 子列表 index），再执行移动。纵向决定顺序、横向
 *   决定层级，因此三层以上也能明确提升一级或直接提升到根级。
 * - 旧 sibling / nest API 继续保留给既有调用与回归测试；Sidebar 使用 projection API。
 * - 循环守卫：目标父级不得是自身或自身后代（防环）
 * - 返回新数组，不修改 renderer 从 store 派生出的 useMemo 数据
 *
 * @对应文档章节: docs/方案-侧栏收藏分组-20260801.md（Feature E.2）、
 *   docs/plans/sidebar-user-task-redesign-grilling-20260804.md（问题 4 裁决）
 *
 * @不要在这里做的事:
 * - 不持久化顺序（由 PathManager.reorderBookmarks 负责）
 * - 不决定碰撞目标（由 Sidebar 的 dnd-kit DndContext 负责）
 */

/** 未分组收藏在 renderer DndContext 内的稳定容器 id。 */
export const BOOKMARK_UNGROUPED_CONTAINER = '__marina_ungrouped__';

/** 分组拖动旧动作：同级排序 vs 成为目标子组。 */
export type BookmarkGroupDropAction = 'sibling' | 'nest';

/** 指针位于命中组行中心线之前或之后。 */
export type BookmarkGroupDropPosition = 'before' | 'after';

/**
 * Sidebar 的树拖动输入。requestedDepth=0 表示根级；1 表示根组的直接子组。
 * 深度会按命中行可表达的范围自动 clamp，不把像素坐标带进 shared。
 */
export interface BookmarkGroupDropRequest {
  activeGroupId: string;
  overGroupId: string;
  requestedDepth: number;
  position: BookmarkGroupDropPosition;
}

/** 落点线相对 indicatorGroupId 的位置。 */
export type BookmarkGroupDropIndicatorPlacement =
  | 'before'
  | 'after'
  | 'inside-start'
  | 'inside-end';

/**
 * 已解析、可直接执行的树落点。destinationIndex 基于移除 active 后的目标同级列表。
 */
export interface BookmarkGroupDropProjection {
  depth: number;
  parentGroupId: string | null;
  destinationIndex: number;
  indicatorGroupId: string;
  indicatorPlacement: BookmarkGroupDropIndicatorPlacement;
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
   * 全部组（扁平表）。roots = 未被任何组 subgroupOrder 引用的 id。
   * 顺序契约：roots 相对顺序 = 它们在数组中的先后；子组顺序 = 父组 subgroupOrder。
   */
  groups: BookmarkGroupOrder[];
}

export interface BookmarkDropTarget {
  /** 被拖动的 pathId。 */
  activeId: string;
  /** dnd-kit 命中的 pathId；空容器则等于容器 id。 */
  overId: string;
  /** 命中项所属容器；命中空容器时就是该容器本身。 */
  overContainerId: string;
}

/**
 * 根据一次路径拖放生成完整的新收藏布局。
 *
 * @returns 新布局；落点无效或没有实际顺序变化时返回 null。
 */
export function moveBookmarkInLayout(
  layout: BookmarkOrderLayout,
  target: BookmarkDropTarget,
): BookmarkOrderLayout | null {
  const sourceContainerId = findContainer(layout, target.activeId);
  if (!sourceContainerId || !isKnownContainer(layout, target.overContainerId)) return null;

  const sourceItems = itemsFor(layout, sourceContainerId);
  const sourceIndex = sourceItems.indexOf(target.activeId);
  if (sourceIndex < 0) return null;

  if (sourceContainerId === target.overContainerId) {
    const nextItems = sourceItems.slice();
    const moved = nextItems.splice(sourceIndex, 1)[0]!;
    const originalTargetIndex = sourceItems.indexOf(target.overId);

    // 命中容器本身（例如折叠组头）表示移到该容器末尾。命中 path 时使用
    // 原数组里的目标 index；向下拖时删除源项会让 index 左移，仍在原 index
    // 插入才等价于 dnd-kit 的 arrayMove(oldIndex, newIndex)。
    const insertionIndex = originalTargetIndex < 0 ? nextItems.length : originalTargetIndex;
    nextItems.splice(insertionIndex, 0, moved);
    if (sameOrder(sourceItems, nextItems)) return null;
    return replaceContainer(layout, sourceContainerId, nextItems);
  }

  const targetItems = itemsFor(layout, target.overContainerId);
  const nextSource = sourceItems.slice();
  const moved = nextSource.splice(sourceIndex, 1)[0]!;
  const nextTarget = targetItems.slice();
  const targetIndex = targetItems.indexOf(target.overId);
  nextTarget.splice(targetIndex < 0 ? nextTarget.length : targetIndex, 0, moved);

  return replaceContainer(
    replaceContainer(layout, sourceContainerId, nextSource),
    target.overContainerId,
    nextTarget,
  );
}

/**
 * 把「命中组行 + 行前/行后 + 目标深度」投影成精确树落点。
 *
 * 设命中路径为 A(depth 0) → B(depth 1)：
 * - requestedDepth=0：以 A 为锚，移动到根级；
 * - requestedDepth=1：以 B 为锚，移动到 A 内与 B 同级；
 * - requestedDepth=2：移动到 B 内，before/after 分别表示子组列表首/尾。
 *
 * 这样拖动 B 的子组 C 时，横向左移一级/两级就能分别得到「与 B 同级」和
 * 「与 A 同级」，不再依赖目标行上下半区猜 sibling/nest。
 *
 * @returns 投影；未知组、拖到自身/后代、损坏的祖先链返回 null。
 */
export function projectBookmarkGroupDrop(
  layout: BookmarkOrderLayout,
  request: BookmarkGroupDropRequest,
): BookmarkGroupDropProjection | null {
  const { activeGroupId, overGroupId, position } = request;
  if (
    !Number.isFinite(request.requestedDepth) ||
    !findGroupOrder(layout, activeGroupId) ||
    !findGroupOrder(layout, overGroupId) ||
    activeGroupId === overGroupId ||
    isDescendantGroupInLayout(layout, activeGroupId, overGroupId)
  ) {
    return null;
  }

  const overPath = groupPathFromRoot(layout, overGroupId);
  if (!overPath) return null;
  const overDepth = overPath.length - 1;
  const depth = Math.max(0, Math.min(Math.round(request.requestedDepth), overDepth + 1));

  // 比命中行深一级 = 放进命中组。上半行对应子组列表首，下半行对应末尾。
  if (depth === overDepth + 1) {
    const siblings = directGroupIds(layout, overGroupId).filter((id) => id !== activeGroupId);
    return {
      depth,
      parentGroupId: overGroupId,
      destinationIndex: position === 'before' ? 0 : siblings.length,
      indicatorGroupId: overGroupId,
      indicatorPlacement: position === 'before' ? 'inside-start' : 'inside-end',
    };
  }

  // 同深度或向左提升：以命中组在目标深度上的祖先为锚。
  const anchorGroupId = overPath[depth]!;
  const parentId = depth === 0 ? null : overPath[depth - 1]!;
  const siblings = directGroupIds(layout, parentId).filter((id) => id !== activeGroupId);
  const anchorIndex = siblings.indexOf(anchorGroupId);
  if (anchorIndex < 0) return null;
  return {
    depth,
    parentGroupId: parentId,
    destinationIndex: anchorIndex + (position === 'after' ? 1 : 0),
    indicatorGroupId: anchorGroupId,
    indicatorPlacement: position,
  };
}

/**
 * 执行 projectBookmarkGroupDrop 产生的精确落点。
 *
 * placement 的 index 已在「移除 active 后」的列表空间中计算；这里再次 clamp 并
 * 校验目标父级，避免 renderer 状态与 main 广播之间短暂不同步时写出环或越界。
 * 根组没有显式 rootOrder，因此只替换 groups 扁平表中的 root 槽位；非 root 节点
 * 的相对位置保持不变。
 *
 * @returns 新布局；无变化、未知目标、目标为自身/后代时返回 null。
 */
export function moveBookmarkGroupToProjection(
  layout: BookmarkOrderLayout,
  activeGroupId: string,
  projection: BookmarkGroupDropProjection,
): BookmarkOrderLayout | null {
  if (!findGroupOrder(layout, activeGroupId)) return null;
  const targetParentId = projection.parentGroupId;
  if (
    targetParentId !== null &&
    (!findGroupOrder(layout, targetParentId) ||
      targetParentId === activeGroupId ||
      isDescendantGroupInLayout(layout, activeGroupId, targetParentId))
  ) {
    return null;
  }

  const sourceParentId = parentGroupId(layout, activeGroupId);
  const sourceSiblings = directGroupIds(layout, sourceParentId);
  const targetWithoutActive = directGroupIds(layout, targetParentId).filter(
    (id) => id !== activeGroupId,
  );
  const destinationIndex = Math.max(
    0,
    Math.min(Math.round(projection.destinationIndex), targetWithoutActive.length),
  );
  const nextTargetSiblings = targetWithoutActive.slice();
  nextTargetSiblings.splice(destinationIndex, 0, activeGroupId);

  // 同父时先比语义列表，避免仅为 root 扁平表规范化而产生伪更新。
  if (sourceParentId === targetParentId && sameOrder(sourceSiblings, nextTargetSiblings)) {
    return null;
  }

  const nextLayout: BookmarkOrderLayout = {
    ungrouped: layout.ungrouped.slice(),
    groups: layout.groups.map(cloneGroup),
  };
  if (sourceParentId !== null) {
    const source = findGroupOrder(nextLayout, sourceParentId);
    if (!source) return null;
    source.subgroupOrder = source.subgroupOrder.filter((id) => id !== activeGroupId);
  }

  if (targetParentId !== null) {
    const target = findGroupOrder(nextLayout, targetParentId);
    if (!target) return null;
    // source===target 时上面的移除已发生；统一以投影后的完整列表覆盖。
    target.subgroupOrder = nextTargetSiblings;
    return nextLayout;
  }

  // root 顺序由扁平 groups 中「未被引用节点」的相对顺序表达。只替换新 root
  // 集合所在的槽位，避免扰动非 root 节点在扁平表中的位置。
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

/**
 * 调整收藏分组位置（树语义）。动作由碰撞检测裁决：
 *
 * - 'sibling'：同级排序。与锚点组同父 → arrayMove(oldIndex, newIndex) 语义
 *   （向下拖落在锚点之后，向上拖落在锚点之前）；跨父 → 移入锚点父级的
 *   锚点索引处（即"拖进目标列表的该位置"）。
 * - 'nest'：成为目标组的子组，追加到其 subgroupOrder 末尾。目标为自身或
 *   自身后代时返回 null（循环守卫）。
 *
 * 未分组路径与每组 childOrder 原样保留。未知 id / 无效动作返回 null。
 */
export function moveBookmarkGroupInLayout(
  layout: BookmarkOrderLayout,
  activeGroupId: string,
  overGroupId: string,
  action: BookmarkGroupDropAction = 'sibling',
): BookmarkOrderLayout | null {
  if (activeGroupId === overGroupId) return null;
  if (!findGroupOrder(layout, activeGroupId) || !findGroupOrder(layout, overGroupId)) {
    return null;
  }

  const groups = layout.groups.map(cloneGroup);
  const nextLayout: BookmarkOrderLayout = { ungrouped: layout.ungrouped.slice(), groups };

  if (action === 'nest') {
    // 循环守卫：目标不得是自身后代。
    if (isDescendantGroupInLayout(nextLayout, activeGroupId, overGroupId)) return null;
    const activeParent = parentGroupId(nextLayout, activeGroupId);
    // 拖回自己的父组 = 原地重排，无意义 → 无变化。
    if (activeParent === overGroupId) return null;
    // 从旧父级摘除（只动子组 id 列表；扁平表里节点常驻，摘除后自动成为 root）。
    if (activeParent !== null) removeFromSiblings(nextLayout, activeGroupId, activeParent);
    const target = findGroupOrder(nextLayout, overGroupId)!;
    target.subgroupOrder.push(activeGroupId);
    return nextLayout;
  }

  // sibling：与锚点同父 → arrayMove 语义；跨父 → 插到锚点父级的锚点索引。
  const activeParent = parentGroupId(nextLayout, activeGroupId);
  const overParent = parentGroupId(nextLayout, overGroupId);

  if (activeParent === overParent) {
    // 同父：根级 = 扁平表本身（所有组都在其中，roots 顺序=未引用项的相对顺序）；
    // 组级 = 该组 subgroupOrder。arrayMove(oldIndex, newIndex)：先删后插，
    // 新 index 用删除前的原始目标索引（向下拖落在锚点后，向上拖落在锚点前）。
    // 两种列表运行期同形但 TS union 无法合并索引 API，拆两个窄化分支。
    if (activeParent === null) {
      const sourceIndex = nextLayout.groups.findIndex((g) => g.id === activeGroupId);
      const targetIndex = nextLayout.groups.findIndex((g) => g.id === overGroupId);
      if (sourceIndex < 0 || targetIndex < 0) return null;
      if (!arrayMoveInPlace(nextLayout.groups, sourceIndex, targetIndex)) return null;
    } else {
      const subList = findGroupOrder(nextLayout, activeParent)!.subgroupOrder;
      const sourceIndex = subList.indexOf(activeGroupId);
      const targetIndex = subList.indexOf(overGroupId);
      if (sourceIndex < 0 || targetIndex < 0) return null;
      if (!arrayMoveInPlace(subList, sourceIndex, targetIndex)) return null;
    }
    return nextLayout;
  }

  // 跨父：从旧父摘除，插入目标父的锚点索引（插在锚点前）。
  if (activeParent !== null) removeFromSiblings(nextLayout, activeGroupId, activeParent);
  if (overParent === null) {
    // 成为根：把节点在扁平表内移动到锚点索引（此前若为子组，节点仍在扁平表，
    // 先移除再插入，保持锚点索引语义）。
    const targetIndex = nextLayout.groups.findIndex((g) => g.id === overGroupId);
    if (targetIndex < 0) return null;
    const nodeIdx = nextLayout.groups.findIndex((g) => g.id === activeGroupId);
    if (nodeIdx < 0) return null;
    const node = nextLayout.groups.splice(nodeIdx, 1)[0]!;
    nextLayout.groups.splice(targetIndex, 0, node);
  } else {
    // 成为目标组的子组：只往 id 列表插 id，节点常驻扁平表。
    const parent = findGroupOrder(nextLayout, overParent)!;
    const targetIndex = parent.subgroupOrder.indexOf(overGroupId);
    if (targetIndex < 0) return null;
    parent.subgroupOrder.splice(targetIndex, 0, activeGroupId);
  }
  return nextLayout;
}

/**
 * 查询某组是否在指定祖先的子树内（用于循环守卫）。
 */
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

/** 返回某组在布局中的直接父组 id；根组返回 null。 */
export function parentGroupId(layout: BookmarkOrderLayout, groupId: string): string | null {
  for (const group of layout.groups) {
    if (group.subgroupOrder.includes(groupId)) return group.id;
  }
  return null;
}

/** 返回指定父级的直接子组；parentId=null 表示根组。 */
function directGroupIds(layout: BookmarkOrderLayout, parentId: string | null): string[] {
  if (parentId !== null) {
    return findGroupOrder(layout, parentId)?.subgroupOrder.slice() ?? [];
  }
  return layout.groups
    .filter((group) => parentGroupId(layout, group.id) === null)
    .map((group) => group.id);
}

/**
 * 返回根到目标的 id 路径。seen 防止损坏持久层形成的祖先环让 projection 死循环。
 */
function groupPathFromRoot(layout: BookmarkOrderLayout, groupId: string): string[] | null {
  if (!findGroupOrder(layout, groupId)) return null;
  const reversed: string[] = [];
  const seen = new Set<string>();
  let current: string | null = groupId;
  while (current !== null) {
    if (seen.has(current)) return null;
    seen.add(current);
    reversed.push(current);
    current = parentGroupId(layout, current);
  }
  return reversed.reverse();
}

/** 在扁平表中查找某组；不存在返回 undefined。 */
export function findGroupOrder(
  layout: BookmarkOrderLayout,
  groupId: string,
): BookmarkGroupOrder | undefined {
  return layout.groups.find((group) => group.id === groupId);
}

function removeFromSiblings(
  layout: BookmarkOrderLayout,
  groupId: string,
  parentId: string | null,
): void {
  // 根组不摘除扁平表节点：节点常驻 groups 数组，成为子组只是被引用。
  if (parentId === null) return;
  const parent = findGroupOrder(layout, parentId);
  if (!parent) return;
  const idx = parent.subgroupOrder.indexOf(groupId);
  if (idx >= 0) parent.subgroupOrder.splice(idx, 1);
}

function findContainer(layout: BookmarkOrderLayout, pathId: string): string | null {
  if (layout.ungrouped.includes(pathId)) return BOOKMARK_UNGROUPED_CONTAINER;
  return layout.groups.find((group) => group.childOrder.includes(pathId))?.id ?? null;
}

function isKnownContainer(layout: BookmarkOrderLayout, containerId: string): boolean {
  return (
    containerId === BOOKMARK_UNGROUPED_CONTAINER ||
    layout.groups.some((group) => group.id === containerId)
  );
}

function itemsFor(layout: BookmarkOrderLayout, containerId: string): string[] {
  if (containerId === BOOKMARK_UNGROUPED_CONTAINER) return layout.ungrouped;
  return layout.groups.find((group) => group.id === containerId)?.childOrder ?? [];
}

function replaceContainer(
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

function sameOrder<T>(left: T[], right: T[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * dnd-kit arrayMove 的原地版：从 `from` 移除并在 `to`（原始索引空间）插入。
 * @returns 是否真的发生了顺序变化。
 */
function arrayMoveInPlace<T>(list: T[], from: number, to: number): boolean {
  const original = list.slice();
  const moved = list.splice(from, 1)[0]!;
  list.splice(to, 0, moved);
  return !sameOrder(original, list);
}
