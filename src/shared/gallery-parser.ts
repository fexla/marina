/**
 * @file src/shared/gallery-parser.ts
 * @purpose 解析 `gallery` 代码块的纯文本为图片条目列表。
 *
 * @语法(ADR-026):块体每行一个图片引用,两种来源——
 *   - 本地路径(相对 md 目录 / 绝对路径),如 `./img.png`、`screenshots/01.png`
 *   - 网络 URL(http(s)),如 `https://example.com/a.jpg`
 * 空行与 `#` 开头的行视为注释/分隔,忽略。首尾空白 trim。
 *
 * @设计:
 * - 纯函数、无副作用,便于单测(renderer / main 都可用)。
 * - 不做路径解析(本地图相对 md 目录的 resolve 在 main 端做,renderer 不持有 fs)。
 * - 不区分本地/网络的扩展名猜测——以协议前缀判定(http(s):// = 网络,其余本地)。
 *   data:/blob: 在 gallery 语境无意义(那是运行时生成的),按本地路径走会被 main 拒。
 *
 * @对应文档:docs/方案-图片表gallery-参数-20260802.md(ADR-026)
 */

/** gallery 代码块解析出的单个图片条目。 */
export interface GalleryItem {
  /** 原始引用(原样保留,本地图相对 md 目录;网络图是完整 URL)。 */
  src: string;
  /** http(s):// 开头 → 'network';否则 'local'。data:/blob: 归 local(交给 main 拒)。 */
  kind: 'local' | 'network';
}

const NETWORK_URL_RE = /^https?:\/\//i;

/**
 * 解析 gallery 代码块原文为条目列表。
 *
 * @param code 代码块原文(每行一个图片引用,可能含空行/注释)。
 * @returns 条目数组(保持源顺序;空行/注释/纯空白行已剔除)。空块返回 []。
 *
 * @常见问题排查:
 * - 返回空数组 → 检查 code 是否只有空行/注释,或每行被引号/反引号包裹(语法错)。
 * - kind 误判 → 网络 URL 必须以 http:// 或 https:// 开头(无协议的 //a.jpg 视为本地)。
 */
export function parseGalleryCode(code: string): GalleryItem[] {
  const items: GalleryItem[] = [];
  const lines = code.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    // 空行 / `#` 注释行忽略(支持 `# 分组说明` 这类用户注释)
    if (!line || line.startsWith('#')) continue;
    const kind: GalleryItem['kind'] = NETWORK_URL_RE.test(line) ? 'network' : 'local';
    items.push({ src: line, kind });
  }
  return items;
}
