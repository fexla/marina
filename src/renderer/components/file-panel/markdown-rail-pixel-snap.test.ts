/**
 * @file markdown-rail-pixel-snap.test.ts
 * @purpose 锁定目录点阵像素吸附的数学:dpr=1 时与旧 CSS 静态值逐一相等(回归保护),
 *   任意 dpr 下输出乘回物理像素必为整数(栅格化一致性的根)。
 */
import { describe, expect, it } from 'vitest';
import { computeRailPixelSnapGeometry } from './markdown-rail-pixel-snap';

describe('computeRailPixelSnapGeometry', () => {
  it('dpr=1 + base/step=4 时与旧 CSS 静态几何一致(点顶 7.5→8:物理整数对齐的代价)', () => {
    expect(computeRailPixelSnapGeometry(1, 4, 4)).toEqual({
      row: 18,
      dotSize: 3,
      dotTop: 8,
      pillHeight: 10,
      pillTop: 4,
      groupGap: 9,
      dotX: [4, 8, 12, 16, 20, 24],
    });
  });

  it('dpr=1 + 单层级 rail(base=8)时 x[0]=8,其余随步进', () => {
    const g = computeRailPixelSnapGeometry(1, 8, 4);
    expect(g.dotX).toEqual([8, 12, 16, 20, 24, 28]);
  });

  it('dpr=1.4375(用户 uiZoom 1.15 × 125%)时所有几何×dpr 均为整数物理像素', () => {
    const dpr = 1.4375;
    const g = computeRailPixelSnapGeometry(dpr, 4, 4);
    // 参考值:行 26phys、点 4phys、胶囊 14phys、x = 6+6k phys
    expect(g.row * dpr).toBeCloseTo(26, 9);
    expect(g.dotSize * dpr).toBeCloseTo(4, 9);
    expect(g.dotTop * dpr).toBeCloseTo(11, 9);
    expect(g.pillHeight * dpr).toBeCloseTo(14, 9);
    expect(g.pillTop * dpr).toBeCloseTo(6, 9);
    expect(g.groupGap * dpr).toBeCloseTo(13, 9);
    expect(g.dotX.map((x) => Math.round(x * dpr))).toEqual([6, 12, 18, 24, 30, 36]);
  });

  it('常见缩放(1/1.1/1.25/1.5/2/3)不变量:几何×dpr 全为整数且点距均匀', () => {
    for (const dpr of [1, 1.1, 1.25, 1.5, 2, 3]) {
      const g = computeRailPixelSnapGeometry(dpr, 4, 4);
      for (const v of [
        g.row,
        g.dotSize,
        g.dotTop,
        g.pillHeight,
        g.pillTop,
        g.groupGap,
        ...g.dotX,
      ]) {
        expect(Math.abs(v * dpr - Math.round(v * dpr))).toBeLessThan(1e-9);
      }
      const gaps = g.dotX.slice(1).map((x, i) => Math.round((x - (g.dotX[i] ?? 0)) * dpr));
      expect(new Set(gaps).size).toBe(1);
    }
  });

  it('非法 dpr 回退为 1(不抛、不产生 NaN)', () => {
    expect(() => computeRailPixelSnapGeometry(Number.NaN, 4, 4)).not.toThrow();
    const g = computeRailPixelSnapGeometry(Number.NaN, 4, 4);
    expect(Number.isFinite(g.row)).toBe(true);
    expect(g.row).toBe(18);
  });
});
