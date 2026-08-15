/**
 * @file markdown-rail-pixel-snap.ts
 * @purpose 把 Markdown 目录点阵轨的几何(点尺寸/每层 x 偏移/行距/胶囊)吸附到
 *   整数物理像素网格,消除设备像素比(dpr)非整数时抗锯齿带来的"点粗细不均"。
 *
 * @关键设计(mipmap 思路的 DOM 变体):
 * - 问题:CSS 3px 圆点在 dpr=1.4375(用户 uiZoom 1.15 × 系统 125%)下是 4.31 物理像素,
 *   且 4px 网格偏移(5.75 物理px)与 18px 行距(25.875 物理px)都带亚像素相位——
 *   每个点落在不同的相位上,浏览器逐点抗锯齿的结果各不相同,视觉上"大小不一"。
 * - 方案:按实际 devicePixelRatio 把所有相关尺寸取整到物理像素,再除回 CSS 像素,
 *   写成 rail 上的 custom properties。几何对齐后每个点的栅格化完全一致,
 *   效果等价于预渲染 sprite(mipmap 的采样稳定性),且不受 CSP img-src 限制。
 * - dpr 变化(窗口跨屏/用户改 uiZoom)通过 resolution 媒体查询监听重算。
 * - computeRailPixelSnapGeometry 是纯函数,单测锁定 dpr=1 时与旧静态值逐一相等。
 *
 * @对应功能:Markdown 目录静止轨圆点的跨缩放一致渲染。
 *
 * @不要在这里做的事:
 * - 不要读窗口尺寸(与布局无关,只与 dpr 有关);
 * - 不要写死层级几何——base/step 从 rail 的 computed style 读取,
 *   保持 CSS 侧(按 max-level 配置)仍是唯一几何来源。
 */

/** 点阵几何的 CSS 设计值。改这些必须同步改 global.css 的 var() fallback。 */
export const RAIL_ROW_CSS = 18;
export const RAIL_DOT_CSS = 3;
export const RAIL_PILL_CSS = 10;

/** 六个层级(索引 0-5)的吸附后几何,全部为 CSS 像素。 */
export interface RailPixelSnapGeometry {
  row: number;
  dotSize: number;
  dotTop: number;
  pillHeight: number;
  pillTop: number;
  /** 分组空隙 G(物理像素 = row_phys/2 四舍五入):深层内容结束回到浅层前的半行。 */
  groupGap: number;
  dotX: number[];
}

/**
 * 纯函数:给定 dpr 与 CSS 侧的 marker base/step,输出全部吸附后的 CSS 像素值。
 * 规则:先 round 到物理像素再除回 CSS 像素;x 偏移用 base+k×step 的物理像素
 * 等差(间距也取整),保证各层点距在物理像素下均匀。
 */
export function computeRailPixelSnapGeometry(
  dpr: number,
  baseCss: number,
  stepCss: number,
): RailPixelSnapGeometry {
  const safeDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const px = (phys: number): number => phys / safeDpr;
  const rowPhys = Math.max(1, Math.round(RAIL_ROW_CSS * safeDpr));
  const dotPhys = Math.max(2, Math.round(RAIL_DOT_CSS * safeDpr));
  const pillPhys = Math.max(dotPhys + 2, Math.round(RAIL_PILL_CSS * safeDpr));
  const basePhys = Math.max(0, Math.round(baseCss * safeDpr));
  const stepPhys = Math.max(1, Math.round(stepCss * safeDpr));
  return {
    row: px(rowPhys),
    dotSize: px(dotPhys),
    dotTop: px(Math.round((rowPhys - dotPhys) / 2)),
    pillHeight: px(pillPhys),
    pillTop: px(Math.round((rowPhys - pillPhys) / 2)),
    groupGap: px(Math.round(rowPhys / 2)),
    dotX: [0, 1, 2, 3, 4, 5].map((k) => px(basePhys + k * stepPhys)),
  };
}

/**
 * 读取 rail 的 marker base/step(由 CSS 按 max-level 配置),计算吸附几何并写到
 * rail.style。dpr 变化时重算。返回 cleanup:移除写入的属性与监听器,
 * 让 rail 回落到 CSS 静态 fallback。
 */
export function applyMarkdownRailPixelSnap(rail: HTMLElement): () => void {
  const propNames = [
    '--md-rail-row',
    '--md-rail-dot-size',
    '--md-rail-dot-top',
    '--md-rail-pill-top',
    '--md-rail-pill-h',
    '--md-rail-group-gap',
    ...[0, 1, 2, 3, 4, 5].map((k) => `--md-rail-dot-x-${k}`),
  ];
  let media: MediaQueryList | null = null;
  const onMediaChange = (): void => apply();

  const apply = (): void => {
    media?.removeEventListener('change', onMediaChange);
    const style = getComputedStyle(rail);
    const base = Number.parseFloat(style.getPropertyValue('--markdown-heading-rail-marker-base'));
    const step = Number.parseFloat(style.getPropertyValue('--markdown-heading-rail-marker-step'));
    const geometry = computeRailPixelSnapGeometry(
      window.devicePixelRatio,
      Number.isFinite(base) ? base : 4,
      Number.isFinite(step) ? step : 4,
    );
    rail.style.setProperty('--md-rail-row', `${geometry.row}px`);
    rail.style.setProperty('--md-rail-dot-size', `${geometry.dotSize}px`);
    rail.style.setProperty('--md-rail-dot-top', `${geometry.dotTop}px`);
    rail.style.setProperty('--md-rail-pill-top', `${geometry.pillTop}px`);
    rail.style.setProperty('--md-rail-pill-h', `${geometry.pillHeight}px`);
    rail.style.setProperty('--md-rail-group-gap', `${geometry.groupGap}px`);
    geometry.dotX.forEach((x, k) => {
      rail.style.setProperty(`--md-rail-dot-x-${k}`, `${x}px`);
    });
    // resolution 变化 = dpr 变化(跨屏拖动/用户改 uiZoom)。用当前 dpr 精确匹配,
    // 变了就重算并换监听目标。
    media = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    media.addEventListener('change', onMediaChange);
  };

  apply();
  return () => {
    media?.removeEventListener('change', onMediaChange);
    for (const name of propNames) rail.style.removeProperty(name);
  };
}
