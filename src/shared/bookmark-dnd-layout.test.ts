/**
 * @file src/shared/bookmark-dnd-layout.test.ts
 * @purpose 锁住收藏路径同组排序、跨组移动和空组落点语义。
 */
import { describe, expect, it } from 'vitest';
import {
  BOOKMARK_UNGROUPED_CONTAINER,
  moveBookmarkInLayout,
  type BookmarkOrderLayout,
} from './bookmark-dnd-layout';

const BASE: BookmarkOrderLayout = {
  ungrouped: ['a', 'b', 'c'],
  groups: [
    { id: 'g1', childOrder: [] },
    { id: 'g2', childOrder: ['d', 'e'] },
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
        { id: 'g1', childOrder: ['a'] },
        { id: 'g2', childOrder: ['d', 'e'] },
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
        { id: 'g1', childOrder: [] },
        { id: 'g2', childOrder: ['d', 'b', 'e'] },
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
        { id: 'g1', childOrder: [] },
        { id: 'g2', childOrder: ['e'] },
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
