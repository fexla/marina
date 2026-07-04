/**
 * @file src/shared/url-scheme.ts
 * @purpose 判断 URL 是否为"远程/内联"协议(http/https/data/blob/mailto/tel),
 *   即不应按本地文件路径解析、不该走 main 的 fs 读取的那些。
 *
 *   renderer 的 markdown 图片预处理(normalizeMdImageSources)+ 图片组件(MdImage)
 *   和 main 的 readImageAsset 都要判这个,原先三处各写一份正则且容易漂移
 *   (code-review 指出),集中到一个 helper。
 */

const REMOTE_SCHEME_RE = /^(https?:|data:|blob:|mailto:|tel:)/i;

/**
 * true = http(s)/data/blob/mailto/tel,应直接交给 <img> 加载(能否加载由 CSP 决定),
 * 不走本地 fs 读取。false = 相对/绝对本地路径,需 main 端读成 dataUrl。
 */
export function isRemoteUrl(url: string): boolean {
  return REMOTE_SCHEME_RE.test(url);
}
