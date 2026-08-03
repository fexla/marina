/**
 * @file src/shared/bookmark-dnd-layout.ts
 * @purpose 把收藏路径的一次 dnd-kit 落点转换成 PathManager 需要的完整分层顺序。
 *
 * @关键设计:
 * - 输入/输出都只含 pathId 与 groupId，不依赖 React 或 dnd-kit，便于锁住排序语义
 * - 源容器从当前布局查找，不相信拖拽事件里的缓存索引，避免树更新后用旧 index
 * - 同容器使用 dnd-kit arrayMove 语义：向下拖到目标项时放在目标项之后
 * - 跨容器落在 path 上时插到该 path 前；落在容器本身时追加到容器末尾
 * - 返回新数组，不修改 renderer 从 store 派生出的 useMemo 数据
 *
 * @对应文档章节: docs/方案-侧栏收藏分组-20260801.md（Feature E.2）
 *
 * @不要在这里做的事:
 * - 不持久化顺序（由 PathManager.reorderBookmarks 负责）
 * - 不决定碰撞目标（由 Sidebar 的 dnd-kit DndContext 负责）
 */

/** 未分组收藏在 renderer DndContext 内的稳定容器 id。 */
export const BOOKMARK_UNGROUPED_CONTAINER = '__marina_ungrouped__';

export interface BookmarkGroupOrder {
  id: string;
  childOrder: string[];
}

export interface BookmarkOrderLayout {
  ungrouped: string[];
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
 * 根据一次拖放生成完整的新收藏布局。
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
    const [moved] = nextItems.splice(sourceIndex, 1);
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
  const [moved] = nextSource.splice(sourceIndex, 1);
  const nextTarget = targetItems.slice();
  const targetIndex = targetItems.indexOf(target.overId);
  nextTarget.splice(targetIndex < 0 ? nextTarget.length : targetIndex, 0, moved);

  return replaceContainer(
    replaceContainer(layout, sourceContainerId, nextSource),
    target.overContainerId,
    nextTarget,
  );
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
  return { ...group, childOrder: group.childOrder.slice() };
}

function sameOrder(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
