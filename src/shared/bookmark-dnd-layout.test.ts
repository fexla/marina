/**
 * @file src/shared/bookmark-dnd-layout.test.ts
 * @purpose 锁住收藏 path/group 的真实 container/index placement 语义、循环守卫与不可变性。
 */
import { describe, expect, it } from 'vitest';
import {
  BOOKMARK_ROOT_GROUP_CONTAINER,
  BOOKMARK_UNGROUPED_CONTAINER,
  bookmarkGroupIdsForContainer,
  bookmarkSubgroupContainerId,
  visibleBookmarkSlotToFullIndex,
  isDescendantGroupInLayout,
  moveBookmarkGroupToPlacement,
  moveBookmarkInLayout,
  moveBookmarkToPlacement,
  parentGroupId,
  type BookmarkOrderLayout,
} from './bookmark-dnd-layout';

const BASE: BookmarkOrderLayout = {
  ungrouped: ['a', 'b', 'c'],
  groups: [
    { id: 'g1', childOrder: [], subgroupOrder: ['g1-1'] },
    { id: 'g1-1', childOrder: ['x'], subgroupOrder: [] },
    { id: 'g2', childOrder: ['d', 'e'], subgroupOrder: [] },
  ],
};

describe('moveBookmarkToPlacement', () => {
  it('同容器按移除 active 后的真实 index 插入', () => {
    expect(
      moveBookmarkToPlacement(BASE, 'a', {
        targetContainerId: BOOKMARK_UNGROUPED_CONTAINER,
        targetIndex: 1,
      })?.ungrouped,
    ).toEqual(['b', 'a', 'c']);
    expect(
      moveBookmarkToPlacement(BASE, 'c', {
        targetContainerId: BOOKMARK_UNGROUPED_CONTAINER,
        targetIndex: 0,
      })?.ungrouped,
    ).toEqual(['c', 'a', 'b']);
  });

  it('跨容器按目标插槽移动，并保留其他组', () => {
    expect(moveBookmarkToPlacement(BASE, 'b', { targetContainerId: 'g2', targetIndex: 1 })).toEqual(
      {
        ungrouped: ['a', 'c'],
        groups: [
          { id: 'g1', childOrder: [], subgroupOrder: ['g1-1'] },
          { id: 'g1-1', childOrder: ['x'], subgroupOrder: [] },
          { id: 'g2', childOrder: ['d', 'b', 'e'], subgroupOrder: [] },
        ],
      },
    );
  });

  it('空组/未分组容器可直接追加，越界 index 安全 clamp', () => {
    expect(
      moveBookmarkToPlacement(BASE, 'a', { targetContainerId: 'g1', targetIndex: 99 }),
    )?.toEqual({
      ungrouped: ['b', 'c'],
      groups: [
        { id: 'g1', childOrder: ['a'], subgroupOrder: ['g1-1'] },
        { id: 'g1-1', childOrder: ['x'], subgroupOrder: [] },
        { id: 'g2', childOrder: ['d', 'e'], subgroupOrder: [] },
      ],
    });
    expect(
      moveBookmarkToPlacement(BASE, 'd', {
        targetContainerId: BOOKMARK_UNGROUPED_CONTAINER,
        targetIndex: 99,
      })?.ungrouped,
    ).toEqual(['a', 'b', 'c', 'd']);
  });

  it('原位置、未知 id/container 和非数字 index 不更新', () => {
    expect(
      moveBookmarkToPlacement(BASE, 'a', {
        targetContainerId: BOOKMARK_UNGROUPED_CONTAINER,
        targetIndex: 0,
      }),
    ).toBeNull();
    expect(
      moveBookmarkToPlacement(BASE, 'missing', {
        targetContainerId: BOOKMARK_UNGROUPED_CONTAINER,
        targetIndex: 0,
      }),
    ).toBeNull();
    expect(
      moveBookmarkToPlacement(BASE, 'a', { targetContainerId: 'missing', targetIndex: 0 }),
    ).toBeNull();
    expect(
      moveBookmarkToPlacement(BASE, 'a', {
        targetContainerId: BOOKMARK_UNGROUPED_CONTAINER,
        targetIndex: Number.NaN,
      }),
    ).toBeNull();
  });

  it('把当前 segment 可见插槽映射到混合全量列表，预览与释放顺序一致', () => {
    const full = ['local-a', 'ssh-hidden', 'local-b', 'ssh-tail'];
    expect(visibleBookmarkSlotToFullIndex(full, ['local-a', 'local-b'], 'local-a', 1)).toBe(2);
    expect(
      moveBookmarkToPlacement({ ungrouped: full, groups: [] }, 'local-a', {
        targetContainerId: BOOKMARK_UNGROUPED_CONTAINER,
        targetIndex: 2,
      })?.ungrouped,
    ).toEqual(['ssh-hidden', 'local-b', 'local-a', 'ssh-tail']);
  });

  it('可见容器为空时追加到隐藏全量项之后，非法可见锚点返回 null', () => {
    expect(visibleBookmarkSlotToFullIndex(['ssh-a'], [], 'local-active', 0)).toBe(1);
    expect(visibleBookmarkSlotToFullIndex(['ssh-a'], ['missing'], undefined, 0)).toBeNull();
  });

  it('兼容命中项调用，但正式 placement 语义不依赖 over/像素', () => {
    expect(
      moveBookmarkInLayout(BASE, {
        activeId: 'a',
        overId: 'b',
        overContainerId: BOOKMARK_UNGROUPED_CONTAINER,
      })?.ungrouped,
    ).toEqual(['b', 'a', 'c']);
  });

  it('不修改输入布局', () => {
    const snapshot = structuredClone(BASE);
    moveBookmarkToPlacement(BASE, 'a', { targetContainerId: 'g1', targetIndex: 0 });
    expect(BASE).toEqual(snapshot);
  });
});

describe('moveBookmarkGroupToPlacement', () => {
  const TREE: BookmarkOrderLayout = {
    ungrouped: [],
    groups: [
      { id: 'A', childOrder: [], subgroupOrder: ['B'] },
      { id: 'B', childOrder: [], subgroupOrder: ['C', 'D'] },
      { id: 'C', childOrder: ['path-c'], subgroupOrder: [] },
      { id: 'D', childOrder: [], subgroupOrder: [] },
      { id: 'X', childOrder: [], subgroupOrder: [] },
    ],
  };

  it('C 直接进入 A.subgroups 的 B 后插槽', () => {
    const next = moveBookmarkGroupToPlacement(TREE, 'C', {
      targetContainerId: bookmarkSubgroupContainerId('A'),
      targetIndex: 1,
    })!;
    expect(next.groups.find((group) => group.id === 'A')!.subgroupOrder).toEqual(['B', 'C']);
    expect(next.groups.find((group) => group.id === 'B')!.subgroupOrder).toEqual(['D']);
    expect(next.groups.find((group) => group.id === 'C')!.childOrder).toEqual(['path-c']);
  });

  it('C 直接进入 root.groups 的 A 后插槽', () => {
    const next = moveBookmarkGroupToPlacement(TREE, 'C', {
      targetContainerId: BOOKMARK_ROOT_GROUP_CONTAINER,
      targetIndex: 1,
    })!;
    expect(
      next.groups.filter((group) => parentGroupId(next, group.id) === null).map((g) => g.id),
    ).toEqual(['A', 'C', 'X']);
    expect(next.groups.find((group) => group.id === 'B')!.subgroupOrder).toEqual(['D']);
  });

  it('根组可进入任意合法子组容器的精确 index', () => {
    const next = moveBookmarkGroupToPlacement(TREE, 'X', {
      targetContainerId: bookmarkSubgroupContainerId('B'),
      targetIndex: 1,
    })!;
    expect(next.groups.find((group) => group.id === 'B')!.subgroupOrder).toEqual(['C', 'X', 'D']);
    expect(parentGroupId(next, 'X')).toBe('B');
  });

  it('同父排序使用移除 active 后的目标 index', () => {
    const next = moveBookmarkGroupToPlacement(TREE, 'C', {
      targetContainerId: bookmarkSubgroupContainerId('B'),
      targetIndex: 1,
    })!;
    expect(next.groups.find((group) => group.id === 'B')!.subgroupOrder).toEqual(['D', 'C']);
  });

  it('原位置不更新，目标 index 越界 clamp', () => {
    expect(
      moveBookmarkGroupToPlacement(TREE, 'C', {
        targetContainerId: bookmarkSubgroupContainerId('B'),
        targetIndex: 0,
      }),
    ).toBeNull();
    expect(
      moveBookmarkGroupToPlacement(TREE, 'C', {
        targetContainerId: bookmarkSubgroupContainerId('B'),
        targetIndex: 99,
      })?.groups.find((group) => group.id === 'B')?.subgroupOrder,
    ).toEqual(['D', 'C']);
  });

  it('拒绝自身/后代/未知容器，防止形成环', () => {
    expect(
      moveBookmarkGroupToPlacement(TREE, 'A', {
        targetContainerId: bookmarkSubgroupContainerId('A'),
        targetIndex: 0,
      }),
    ).toBeNull();
    expect(
      moveBookmarkGroupToPlacement(TREE, 'A', {
        targetContainerId: bookmarkSubgroupContainerId('C'),
        targetIndex: 0,
      }),
    ).toBeNull();
    expect(
      moveBookmarkGroupToPlacement(TREE, 'C', {
        targetContainerId: bookmarkSubgroupContainerId('missing'),
        targetIndex: 0,
      }),
    ).toBeNull();
  });

  it('容器查询返回直接子组，编码支持任意 groupId', () => {
    const oddId = 'a/b c:中';
    const layout: BookmarkOrderLayout = {
      ungrouped: [],
      groups: [
        { id: oddId, childOrder: [], subgroupOrder: ['child'] },
        { id: 'child', childOrder: [], subgroupOrder: [] },
      ],
    };
    expect(bookmarkGroupIdsForContainer(layout, BOOKMARK_ROOT_GROUP_CONTAINER)).toEqual([oddId]);
    expect(bookmarkGroupIdsForContainer(layout, bookmarkSubgroupContainerId(oddId))).toEqual([
      'child',
    ]);
  });

  it('不修改输入布局', () => {
    const snapshot = structuredClone(TREE);
    moveBookmarkGroupToPlacement(TREE, 'C', {
      targetContainerId: BOOKMARK_ROOT_GROUP_CONTAINER,
      targetIndex: 1,
    });
    expect(TREE).toEqual(snapshot);
  });
});

describe('tree guards', () => {
  it('识别直接与间接后代，自身不算后代', () => {
    expect(isDescendantGroupInLayout(BASE, 'g1', 'g1-1')).toBe(true);
    expect(isDescendantGroupInLayout(BASE, 'g1-1', 'g1')).toBe(false);
    expect(isDescendantGroupInLayout(BASE, 'g1', 'g1')).toBe(false);
    expect(isDescendantGroupInLayout(BASE, 'missing', 'g1-1')).toBe(false);
  });

  it('parentGroupId 对根组返回 null', () => {
    expect(parentGroupId(BASE, 'g1')).toBeNull();
    expect(parentGroupId(BASE, 'g1-1')).toBe('g1');
  });
});
