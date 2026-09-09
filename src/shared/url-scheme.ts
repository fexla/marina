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

/**
 * Windows 盘符绝对路径(C:\\x / C:/x)。react-markdown 的 defaultUrlTransform
 * 会把盘符误判为未知 URL 协议 —— "C:" 是第一个出现在任何 / ? # 之前的冒号前缀,
 * 且不在 ^(https?|ircs?|mailto|xmpp)$ 白名单里,于是整条 href 被剥成空串,
 * 面板里 [图](D:\\a\\b.png) 渲染成 <a href=""> 点击无反应(2026-08-23 用户报告)。
 * 渲染层需要先识别它并原样放行,见 file-panel/markdown-url-transform.ts。
 *
 * 注意 Markdown 解析层(micromark)会把链接目标里的反斜杠百分号编码:渲染层
 * 收到的实际是 "C:%5CUsers%5C..." 而非 "C:\\Users\\...",所以编码形态必须认;
 * 原始反斜杠形态一并覆盖,防调用方拿到未编码字符串。
 */
const WINDOWS_DRIVE_PATH_RE = /^[A-Za-z]:[\\/]/;
const WINDOWS_DRIVE_PATH_ENCODED_RE = /^[A-Za-z]:%5c/i;

/**
 * true = Windows 盘符绝对路径(C:\\x、C:/x,含 %5C 编码形态),
 * 应绕过 URL 协议消毒,交给本地文件链路(main 端 resolve 对绝对路径天然正确)。
 */
export function isWindowsDrivePath(url: string): boolean {
  return WINDOWS_DRIVE_PATH_RE.test(url) || WINDOWS_DRIVE_PATH_ENCODED_RE.test(url);
}

/**
 * v0.3.3 ADR-035:true = marina: 动作链接([x](marina:show a.md))。
 * 上游 defaultUrlTransform 会把 marina 当未知协议剥空整条 href,所以渲染层
 * (markdown-url-transform)要原样放行;点击分流与命令解析见
 * src/shared/marina-link.ts 与 main 端 marina-link-dispatch.ts。
 *
 * scheme 按规范大小写不敏感(MARINA:show x 同样有效)。
 * 注意 marinax: 这类更长前缀不会误命中(要求第 7 个字符是 ':')。
 */
const MARINA_ACTION_HREF_RE = /^marina:/i;

/** true = marina: 动作链接(文档内触发 CLI 语义的按钮式链接)。 */
export function isMarinaActionHref(url: string): boolean {
  return MARINA_ACTION_HREF_RE.test(url);
}
