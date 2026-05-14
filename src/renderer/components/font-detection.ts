/**
 * @file src/renderer/components/font-detection.ts
 * @purpose 列出"系统已安装的字体"+"推荐字体",供设置页字体下拉框使用。
 *
 * @CP-4 勘误 #3:
 *   原版只有写死白名单 + Canvas measureText 探测,用户报告"应该展示所有
 *   已安装字体,并保留推荐字体置顶"。改用 Chrome 的 Local Font Access API
 *   (window.queryLocalFonts) 真实枚举系统字体;主进程已自动放行
 *   'local-fonts' 权限 (src/main/index.ts)。
 *
 * @检测策略:
 *   1. 优先 window.queryLocalFonts():拿到完整 family 列表 (去重)
 *   2. 失败 / 不可用 → 回退到老白名单 + Canvas probe (零依赖兜底)
 *
 *   两套策略都返回 { family, installed, recommended } 列表。recommended=true
 *   的项 UI 会置顶显示 (用户决策对齐)。
 *
 * @注意:queryLocalFonts 是异步,settings UI 用 useEffect + setState 装载;
 *   首次加载完成前下拉框只显示推荐字体 (UX 上看起来是"推荐先 + 加载中")。
 */

const PROBE_TEXT = 'mmmmmmmmmlli';
const SENTINELS = ['monospace', 'serif', 'sans-serif'];

interface ProbeContext {
  ctx: CanvasRenderingContext2D;
  baseline: Map<string, number>;
}

let cachedCtx: ProbeContext | null = null;

function getProbeContext(): ProbeContext {
  if (cachedCtx) return cachedCtx;
  const canvas = document.createElement('canvas');
  canvas.width = 200;
  canvas.height = 20;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('[font-detection] 浏览器不支持 2D Canvas — 异常环境');
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const baseline = new Map<string, number>();
  for (const sentinel of SENTINELS) {
    ctx.font = `40px ${sentinel}`;
    baseline.set(sentinel, ctx.measureText(PROBE_TEXT).width);
  }
  cachedCtx = { ctx, baseline };
  return cachedCtx;
}

/**
 * Canvas probe — 用于回退路径与命中检测。
 */
export function isFontAvailable(family: string): boolean {
  if (!family) return false;
  if (SENTINELS.includes(family.toLowerCase())) return true;
  let probe: ProbeContext;
  try {
    probe = getProbeContext();
  } catch {
    return false;
  }
  for (const sentinel of SENTINELS) {
    probe.ctx.font = `40px "${family}", ${sentinel}`;
    const width = probe.ctx.measureText(PROBE_TEXT).width;
    if (Math.abs(width - probe.baseline.get(sentinel)!) > 0.5) {
      return true;
    }
  }
  return false;
}

/**
 * 终端推荐等宽字体 (按用户偏好顺序)。无论系统是否真装,都置顶展示;
 * 实际安装由 Canvas probe 标 installed=true。
 */
export const RECOMMENDED_TERMINAL_FONTS: string[] = [
  'Cascadia Mono',
  'Cascadia Code',
  'JetBrains Mono',
  'Consolas',
  'Source Code Pro',
  'Fira Code',
  'Hack',
  'IBM Plex Mono',
  'Roboto Mono',
  'LXGW WenKai Mono',
  'Sarasa Mono SC',
];

/**
 * UI 推荐字体。
 */
export const RECOMMENDED_UI_FONTS: string[] = [
  'LXGW WenKai',
  'Microsoft YaHei UI',
  'Microsoft YaHei',
  'Segoe UI',
  'PingFang SC',
  'Source Han Sans CN',
  'Noto Sans CJK SC',
  'Helvetica Neue',
  'system-ui',
];

/**
 * 探测结果项。
 */
export interface FontEntry {
  family: string;
  installed: boolean;
  recommended: boolean;
}

/**
 * 老接口:沿用 V1 ShellPanel/UI 的"白名单 probe" 行为 — 即把
 * recommended 列表全部展示,标 installed (Canvas probe);未安装也展示。
 * 仍保留是为向后兼容 (其它地方用到 probeFonts() 时无需改动)。
 */
export function probeFonts(whitelist: string[]): FontEntry[] {
  return whitelist.map((family) => ({
    family,
    installed: isFontAvailable(family),
    recommended: true,
  }));
}

// queryLocalFonts 的最小类型 (TS lib.dom 截至 2026-05 还没收录该 API,
// 自己声明,避免 typecheck 报红。)
interface LocalFontDataLike {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
}
interface QueryLocalFontsFn {
  (options?: { postscriptNames?: string[] }): Promise<LocalFontDataLike[]>;
}

/**
 * 真枚举系统字体。返回值已按 family 去重并排序:
 * - 推荐字体置顶 (RECOMMENDED_*),即使系统未装也保留 (installed=false)
 * - 其余为系统真实安装的全部 family,installed=true,字母升序
 *
 * @param recommendedList 推荐字体列表 (RECOMMENDED_TERMINAL_FONTS 或 _UI_*)
 * @param filterMonospace 仅保留等宽字体 (用 Canvas probe 检测字宽差异);
 *   终端字体下拉用 true,UI 字体用 false
 *
 * @注意:Local Font Access API 仅 Chromium 103+ 支持 + 需要 'local-fonts'
 *   权限。Electron 主进程 setPermissionRequestHandler 已放行。
 *   非 Electron / 旧 Chromium → 回退到 probeFonts(recommendedList)。
 */
export async function listAllFonts(
  recommendedList: string[],
  filterMonospace: boolean,
): Promise<FontEntry[]> {
  const recommendedSet = new Set(recommendedList);

  // queryLocalFonts 探测
  const queryFn = (window as unknown as { queryLocalFonts?: QueryLocalFontsFn })
    .queryLocalFonts;
  if (typeof queryFn !== 'function') {
    return probeFonts(recommendedList);
  }

  let localFonts: LocalFontDataLike[];
  try {
    localFonts = await queryFn();
  } catch (err) {
    console.warn('[font-detection] queryLocalFonts failed, fallback to probe', err);
    return probeFonts(recommendedList);
  }

  // 去重 family;同 family 多个变体 (Bold/Italic) 只保留一项
  const familySet = new Set<string>();
  for (const f of localFonts) {
    if (f.family) familySet.add(f.family);
  }

  // 等宽过滤:对每个 family 用 Canvas probe 比较 'i' 和 'm' 的字宽,
  // 等宽字体两者宽度相等,变宽字体 'm' 远大于 'i'。
  const filterFn = filterMonospace
    ? (family: string): boolean => isMonospaceFamily(family)
    : (): boolean => true;

  const installed: FontEntry[] = [];
  const familiesSorted = [...familySet].sort((a, b) =>
    a.localeCompare(b, 'en', { sensitivity: 'base' }),
  );
  for (const family of familiesSorted) {
    if (!filterFn(family)) continue;
    installed.push({
      family,
      installed: true,
      recommended: recommendedSet.has(family),
    });
  }

  // 按推荐顺序构造首段 (置顶);未装的也保留显示 (installed=false)
  const head: FontEntry[] = [];
  const installedFamilies = new Set(installed.map((e) => e.family));
  for (const r of recommendedList) {
    head.push({
      family: r,
      installed: installedFamilies.has(r),
      recommended: true,
    });
  }
  // 系统装着但不在推荐里的,排到下面
  const tail = installed.filter((e) => !recommendedSet.has(e.family));
  return [...head, ...tail];
}

/**
 * 用 Canvas 测两个字符 'i' (窄) 与 'M' (宽) 的渲染宽度,差距 < 1px 视为等宽。
 * 误判率不为零 (条件等宽字体可能误判为变宽,反之亦然),但作为下拉默认筛选
 * 已足够实用 — 用户切到"自定义"输入框可绕过。
 */
function isMonospaceFamily(family: string): boolean {
  let probe: ProbeContext;
  try {
    probe = getProbeContext();
  } catch {
    return false;
  }
  probe.ctx.font = `40px "${family}", monospace`;
  const widthI = probe.ctx.measureText('iiiiiiiiii').width;
  const widthM = probe.ctx.measureText('MMMMMMMMMM').width;
  return Math.abs(widthI - widthM) < 4;
}
