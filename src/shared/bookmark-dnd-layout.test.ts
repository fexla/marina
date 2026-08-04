/**
 * @file src/shared/bookmark-dnd-layout.test.ts
 * @purpose 锁住收藏路径同组排序、跨组移动、空组落点，以及分组树的
 *   sibling 排序 / nest 嵌套 / 循环守卫语义。
 */
import { describe, expect, it } from 'vitest';
import {
  BOOKMARK_UNGROUPED_CONTAINER,
  isDescendantGroupInLayout,
  moveBookmarkGroupInLayout,
  moveBookmarkGroupToProjection,
  moveBookmarkInLayout,
  parentGroupId,
  projectBookmarkGroupDrop,
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

describe('moveBookmarkInLayout', () => {
  it('同容器向下拖到相邻项：目标顺序真正交换（回归：释放后原顺序不变）', () => {
    expect(
      moveBookmarkInLayout(BASE, {
        activeId: 'a',
        overId: 'b',
        overContainerId: BOOKMARK_UNGROUPED_CONTAINER,
      }),
    ).toEqual({
      ungrouped: ['b', 'a', 'c'],
      groups: BASE.groups,
    });
  });

  it('同容器向上拖按目标 index 排列', () => {
    expect(
      moveBookmarkInLayout(BASE, {
        activeId: 'c',
        overId: 'a',
        overContainerId: BOOKMARK_UNGROUPED_CONTAINER,
      })?.ungrouped,
    ).toEqual(['c', 'a', 'b']);
  });

  it('落到空组容器时把 path 追加进该组', () => {
    expect(
      moveBookmarkInLayout(BASE, {
        activeId: 'a',
        overId: 'g1',
        overContainerId: 'g1',
      }),
    ).toEqual({
      ungrouped: ['b', 'c'],
      groups: [
        { id: 'g1', childOrder: ['a'], subgroupOrder: ['g1-1'] },
        { id: 'g1-1', childOrder: ['x'], subgroupOrder: [] },
        { id: 'g2', childOrder: ['d', 'e'], subgroupOrder: [] },
      ],
    });
  });

  it('跨组落到 path 时插在目标 path 前', () => {
    expect(
      moveBookmarkInLayout(BASE, {
        activeId: 'b',
        overId: 'e',
        overContainerId: 'g2',
      }),
    ).toEqual({
      ungrouped: ['a', 'c'],
      groups: [
        { id: 'g1', childOrder: [], subgroupOrder: ['g1-1'] },
        { id: 'g1-1', childOrder: ['x'], subgroupOrder: [] },
        { id: 'g2', childOrder: ['d', 'b', 'e'], subgroupOrder: [] },
      ],
    });
  });

  it('path 可直接落入子组（嵌套容器同样可投放）', () => {
    expect(
      moveBookmarkInLayout(BASE, {
        activeId: 'a',
        overId: 'x',
        overContainerId: 'g1-1',
      }),
    ).toEqual({
      ungrouped: ['b', 'c'],
      groups: [
        { id: 'g1', childOrder: [], subgroupOrder: ['g1-1'] },
        { id: 'g1-1', childOrder: ['a', 'x'], subgroupOrder: [] },
        { id: 'g2', childOrder: ['d', 'e'], subgroupOrder: [] },
      ],
    });
  });

  it('从组拖到未分组空白处时追加到末尾', () => {
    expect(
      moveBookmarkInLayout(BASE, {
        activeId: 'd',
        overId: BOOKMARK_UNGROUPED_CONTAINER,
        overContainerId: BOOKMARK_UNGROUPED_CONTAINER,
      }),
    ).toEqual({
      ungrouped: ['a', 'b', 'c', 'd'],
      groups: [
        { id: 'g1', childOrder: [], subgroupOrder: ['g1-1'] },
        { id: 'g1-1', childOrder: ['x'], subgroupOrder: [] },
        { id: 'g2', childOrder: ['e'], subgroupOrder: [] },
      ],
    });
  });

  it('命中自己或未知容器时不产生布局更新', () => {
    expect(
      moveBookmarkInLayout(BASE, {
        activeId: 'a',
        overId: 'a',
        overContainerId: BOOKMARK_UNGROUPED_CONTAINER,
      }),
    ).toBeNull();
    expect(
      moveBookmarkInLayout(BASE, {
        activeId: 'a',
        overId: 'missing',
        overContainerId: 'missing',
      }),
    ).toBeNull();
  });

  it('完整布局含当前 segment 隐藏路径时仍保留全部 id 和相对位置', () => {
    const mixed: BookmarkOrderLayout = {
      ungrouped: ['local-a', 'ssh-hidden', 'local-b'],
      groups: [{ id: 'g1', childOrder: ['ssh-group-hidden'], subgroupOrder: [] }],
    };

    expect(
      moveBookmarkInLayout(mixed, {
        activeId: 'local-a',
        overId: 'local-b',
        overContainerId: BOOKMARK_UNGROUPED_CONTAINER,
      }),
    ).toEqual({
      ungrouped: ['ssh-hidden', 'local-b', 'local-a'],
      groups: [{ id: 'g1', childOrder: ['ssh-group-hidden'], subgroupOrder: [] }],
    });
  });

  it('不修改输入布局', () => {
    const snapshot = structuredClone(BASE);
    moveBookmarkInLayout(BASE, {
      activeId: 'a',
      overId: 'g1',
      overContainerId: 'g1',
    });
    expect(BASE).toEqual(snapshot);
  });
});

describe('projectBookmarkGroupDrop / moveBookmarkGroupToProjection', () => {
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

  it('拖 C 左移一级：精确成为 A 的子组、与 B 同级', () => {
    const projection = projectBookmarkGroupDrop(TREE, {
      activeGroupId: 'C',
      overGroupId: 'B',
      requestedDepth: 1,
      position: 'after',
    });
    expect(projection).toEqual({
      depth: 1,
      parentGroupId: 'A',
      destinationIndex: 1,
      indicatorGroupId: 'B',
      indicatorPlacement: 'after',
    });

    const next = moveBookmarkGroupToProjection(TREE, 'C', projection!)!;
    expect(next.groups.find((group) => group.id === 'A')!.subgroupOrder).toEqual(['B', 'C']);
    expect(next.groups.find((group) => group.id === 'B')!.subgroupOrder).toEqual(['D']);
    expect(next.groups.find((group) => group.id === 'C')!.childOrder).toEqual(['path-c']);
  });

  it('拖 C 左移两级：精确成为根组、与 A 同级', () => {
    const projection = projectBookmarkGroupDrop(TREE, {
      activeGroupId: 'C',
      overGroupId: 'B',
      requestedDepth: 0,
      position: 'after',
    });
    expect(projection).toEqual({
      depth: 0,
      parentGroupId: null,
      destinationIndex: 1,
      indicatorGroupId: 'A',
      indicatorPlacement: 'after',
    });

    const next = moveBookmarkGroupToProjection(TREE, 'C', projection!)!;
    expect(
      next.groups.filter((group) => parentGroupId(next, group.id) === null).map((g) => g.id),
    ).toEqual(['A', 'C', 'X']);
    expect(next.groups.find((group) => group.id === 'B')!.subgroupOrder).toEqual(['D']);
  });

  it('向右拖到命中行下一层：可精确插到子组列表首或尾', () => {
    const start = projectBookmarkGroupDrop(TREE, {
      activeGroupId: 'X',
      overGroupId: 'B',
      requestedDepth: 2,
      position: 'before',
    })!;
    const end = projectBookmarkGroupDrop(TREE, {
      activeGroupId: 'X',
      overGroupId: 'B',
      requestedDepth: 2,
      position: 'after',
    })!;
    expect(start.indicatorPlacement).toBe('inside-start');
    expect(end.indicatorPlacement).toBe('inside-end');
    expect(
      moveBookmarkGroupToProjection(TREE, 'X', start)?.groups.find((g) => g.id === 'B')
        ?.subgroupOrder,
    ).toEqual(['X', 'C', 'D']);
    expect(
      moveBookmarkGroupToProjection(TREE, 'X', end)?.groups.find((g) => g.id === 'B')
        ?.subgroupOrder,
    ).toEqual(['C', 'D', 'X']);
  });

  it('深度超出命中行能力时 clamp；自身/后代目标与环 placement 被拒绝', () => {
    expect(
      projectBookmarkGroupDrop(TREE, {
        activeGroupId: 'X',
        overGroupId: 'B',
        requestedDepth: 99,
        position: 'after',
      })?.depth,
    ).toBe(2);
    expect(
      projectBookmarkGroupDrop(TREE, {
        activeGroupId: 'A',
        overGroupId: 'C',
        requestedDepth: 2,
        position: 'after',
      }),
    ).toBeNull();
    expect(
      moveBookmarkGroupToProjection(TREE, 'A', {
        depth: 3,
        parentGroupId: 'C',
        destinationIndex: 0,
        indicatorGroupId: 'C',
        indicatorPlacement: 'inside-start',
      }),
    ).toBeNull();
  });

  it('投影回原位置不产生更新，输入布局保持不变', () => {
    const snapshot = structuredClone(TREE);
    const projection = projectBookmarkGroupDrop(TREE, {
      activeGroupId: 'C',
      overGroupId: 'D',
      requestedDepth: 2,
      position: 'before',
    })!;
    expect(moveBookmarkGroupToProjection(TREE, 'C', projection)).toBeNull();
    expect(TREE).toEqual(snapshot);
  });
});

describe('moveBookmarkGroupInLayout: sibling 排序', () => {
  it('同父向下拖使用 arrayMove 语义，并保留全部 childOrder', () => {
    const layout: BookmarkOrderLayout = {
      ungrouped: [],
      groups: [
        { id: 'g1', childOrder: [], subgroupOrder: ['g2', 'g3'] },
        { id: 'g2', childOrder: ['d', 'e'], subgroupOrder: [] },
        { id: 'g3', childOrder: [], subgroupOrder: [] },
      ],
    };
    expect(moveBookmarkGroupInLayout(layout, 'g2', 'g3', 'sibling')).toEqual({
      ungrouped: [],
      groups: [
        { id: 'g1', childOrder: [], subgroupOrder: ['g3', 'g2'] },
        { id: 'g2', childOrder: ['d', 'e'], subgroupOrder: [] },
        { id: 'g3', childOrder: [], subgroupOrder: [] },
      ],
    });
  });

  it('根级同级排序：roots 顺序交换，子组节点留在扁平表', () => {
    const next = moveBookmarkGroupInLayout(BASE, 'g1', 'g2', 'sibling')!;
    // 根顺序 = 扁平表中未被任何 subgroupOrder 引用的组。
    expect(next.groups.filter((g) => parentGroupId(next, g.id) === null).map((g) => g.id)).toEqual([
      'g2',
      'g1',
    ]);
    // 扁平表仍是全量组，g1 的子组 g1-1 原样保留。
    expect(next.groups.map((g) => g.id).sort()).toEqual(['g1', 'g1-1', 'g2']);
    expect(next.groups.find((g) => g.id === 'g1')!.subgroupOrder).toEqual(['g1-1']);
  });

  it('跨父 sibling：插到锚点父级的锚点索引', () => {
    // g1-1 是 g1 的子组；拖到根组 g2 上（sibling）→ 进入根级、落在 g2 之后。
    const layout: BookmarkOrderLayout = {
      ungrouped: [],
      groups: [
        { id: 'g1', childOrder: [], subgroupOrder: ['g1-1'] },
        { id: 'g1-1', childOrder: ['x'], subgroupOrder: [] },
        { id: 'g2', childOrder: [], subgroupOrder: [] },
      ],
    };
    const next = moveBookmarkGroupInLayout(layout, 'g1-1', 'g2', 'sibling')!;
    expect(parentGroupId(next, 'g1-1')).toBeNull();
    // 根顺序 = [g1, g2, g1-1]（g1-1 落在 g2 之后）。
    expect(next.groups.filter((g) => parentGroupId(next, g.id) === null).map((g) => g.id)).toEqual([
      'g1',
      'g2',
      'g1-1',
    ]);
    // g1 的子组列表不再含 g1-1；节点本体仍存在于扁平表。
    expect(next.groups.find((g) => g.id === 'g1')!.subgroupOrder).toEqual([]);
  });

  it('命中自己或未知组不更新', () => {
    expect(moveBookmarkGroupInLayout(BASE, 'g1', 'g1', 'sibling')).toBeNull();
    expect(moveBookmarkGroupInLayout(BASE, 'missing', 'g1', 'sibling')).toBeNull();
    expect(moveBookmarkGroupInLayout(BASE, 'g1', 'missing', 'sibling')).toBeNull();
  });
});

describe('moveBookmarkGroupInLayout: nest 嵌套', () => {
  it('根组拖入另一组成为子组（追加到末尾），自身仍留在扁平表', () => {
    const next = moveBookmarkGroupInLayout(BASE, 'g2', 'g1', 'nest')!;
    expect(parentGroupId(next, 'g2')).toBe('g1');
    expect(next.groups.find((g) => g.id === 'g1')!.subgroupOrder).toEqual(['g1-1', 'g2']);
    expect(next.groups.map((g) => g.id).sort()).toEqual(['g1', 'g1-1', 'g2']);
    expect(next.groups.find((g) => g.id === 'g2')!.childOrder).toEqual(['d', 'e']);
  });

  it('子组拖入另一组的子组（两层嵌套）', () => {
    const layout: BookmarkOrderLayout = {
      ungrouped: [],
      groups: [
        { id: 'g1', childOrder: [], subgroupOrder: ['g1-1'] },
        { id: 'g1-1', childOrder: [], subgroupOrder: [] },
        { id: 'g2', childOrder: [], subgroupOrder: ['g2-1'] },
        { id: 'g2-1', childOrder: [], subgroupOrder: [] },
      ],
    };
    const next = moveBookmarkGroupInLayout(layout, 'g2-1', 'g1-1', 'nest')!;
    expect(next.groups.find((g) => g.id === 'g1-1')!.subgroupOrder).toEqual(['g2-1']);
    expect(next.groups.find((g) => g.id === 'g2')!.subgroupOrder).toEqual([]);
  });

  it('循环守卫：不能拖入自身', () => {
    expect(moveBookmarkGroupInLayout(BASE, 'g1', 'g1', 'nest')).toBeNull();
  });

  it('循环守卫：不能拖入自身后代', () => {
    const layout: BookmarkOrderLayout = {
      ungrouped: [],
      groups: [
        { id: 'g1', childOrder: [], subgroupOrder: ['g1-1'] },
        { id: 'g1-1', childOrder: [], subgroupOrder: ['g1-1-1'] },
        { id: 'g1-1-1', childOrder: [], subgroupOrder: [] },
      ],
    };
    expect(moveBookmarkGroupInLayout(layout, 'g1', 'g1-1', 'nest')).toBeNull();
    expect(moveBookmarkGroupInLayout(layout, 'g1', 'g1-1-1', 'nest')).toBeNull();
    expect(moveBookmarkGroupInLayout(layout, 'g1-1', 'g1-1-1', 'nest')).toBeNull();
  });

  it('不修改输入布局', () => {
    const snapshot = structuredClone(BASE);
    moveBookmarkGroupInLayout(BASE, 'g2', 'g1', 'nest');
    moveBookmarkGroupInLayout(BASE, 'g1', 'g2', 'sibling');
    expect(BASE).toEqual(snapshot);
  });
});

describe('isDescendantGroupInLayout / parentGroupId', () => {
  it('识别直接与间接后代，自身不算后代', () => {
    const layout: BookmarkOrderLayout = {
      ungrouped: [],
      groups: [
        { id: 'g1', childOrder: [], subgroupOrder: ['g1-1'] },
        { id: 'g1-1', childOrder: [], subgroupOrder: ['g1-1-1'] },
        { id: 'g1-1-1', childOrder: [], subgroupOrder: [] },
        { id: 'g2', childOrder: [], subgroupOrder: [] },
      ],
    };
    expect(isDescendantGroupInLayout(layout, 'g1', 'g1-1')).toBe(true);
    expect(isDescendantGroupInLayout(layout, 'g1', 'g1-1-1')).toBe(true);
    expect(isDescendantGroupInLayout(layout, 'g1-1', 'g1')).toBe(false);
    expect(isDescendantGroupInLayout(layout, 'g1', 'g2')).toBe(false);
    expect(isDescendantGroupInLayout(layout, 'missing', 'g1-1')).toBe(false);
  });

  it('parentGroupId 对根组返回 null', () => {
    expect(parentGroupId(BASE, 'g1')).toBeNull();
    expect(parentGroupId(BASE, 'g1-1')).toBe('g1');
    expect(parentGroupId(BASE, 'missing')).toBeNull();
  });
});
