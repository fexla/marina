/**
 * @file src/shared/web-file-url.ts
 * @purpose marina-file:// URL 的编码/解码纯函数与常量(ADR-034)。
 *   main(web-file-protocol.ts 协议层)与 renderer(WebViewer 构造 iframe src)
 *   共用,保证两侧永远编出/认得同一种 URL。
 *
 * @关键设计:
 * - 纯字符串函数,无 fs / electron 依赖 —— 放 shared 供两端导入。
 * - URL 形态:marina-file://local/<encoded-abs-path>。固定 host 'local' 是必须的:
 *   standard scheme 下 `scheme:///path` 会被 Chromium 把 path 首段折叠成 host
 *   (PoC 实证,ADR-034);固定 host 后相对路径引用(css/js/图)依旧正确解析。
 *
 * @对应文档: ADR-034(软件定义书);src/main/web-file-protocol.ts(白名单/CSP)
 */

/** 协议 scheme 名。 */
export const WEB_FILE_SCHEME = 'marina-file';

/** URL 里固定写死的 host(见文件头注释:不能省略)。 */
export const WEB_FILE_HOST = 'local';

/**
 * 单文件服务上限(32MB),main 端协议层拒绝服务、renderer 端 WebViewer 显示
 * "文件过大"占位 —— 两端共用此常量保证口径一致。与 text(2MB)/image(10MB)
 * 上限同族;html 产物含内联 SVG 可能较大,给宽裕值。
 */
export const MAX_WEB_SERVE_BYTES = 32 * 1024 * 1024;

/**
 * 绝对路径 → marina-file:// URL。逐段 encodeURIComponent(盘符冒号、中文、
 * 空格全部安全转义),renderer 用它构造 iframe src。
 *
 * @example encodePathToWebFileUrl('D:\\x\\arch.html')
 *          // 'marina-file://local/D%3A/x/arch.html'
 */
export function encodePathToWebFileUrl(fsPath: string): string {
  const encoded = fsPath
    .split(/[\\/]+/)
    .filter((seg) => seg.length > 0)
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return `${WEB_FILE_SCHEME}://${WEB_FILE_HOST}/${encoded}`;
}

/**
 * marina-file:// URL → 绝对路径(encodePathToWebFileUrl 的逆运算)。
 *
 * 安全规则:
 * - 逐段 decodeURIComponent 后重组 —— 单次解码,文件名里的字面 '%2F' 不会被
 *   解成路径分隔符(编码时它已是 %252F,解码一次还原为 %2F 字符);
 * - 重组后逐段检查:出现 '..' 段或反斜杠/正斜杠/NUL 直接拒绝(穿越防护;
 *   斜杠式点段穿越在 WHATWG URL 解析层已被归一化,这里兜反斜杠等剩余形态);
 * - 不校验白名单(那是 main 端 WebFileProtocol.resolve 的职责,还要过 realpath)。
 *
 * @returns 合法路径字符串;URL 形态非法/带穿越时返回 null。
 */
export function decodeWebFileUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${WEB_FILE_SCHEME}:` || parsed.hostname !== WEB_FILE_HOST) {
    return null;
  }
  // search(?v=缓存击穿参数)不参与路径解析 —— WebViewer 用 mtimeMs-size 做查询串。
  const segments = parsed.pathname.split('/').filter((seg) => seg.length > 0);
  if (segments.length === 0) return null;
  const decoded: string[] = [];
  for (const seg of segments) {
    let part: string;
    try {
      part = decodeURIComponent(seg);
    } catch {
      return null; // 非法百分号序列(如 %ZZ)
    }
    if (part === '..' || part.includes('/') || part.includes('\\') || part.includes('\0')) {
      return null;
    }
    decoded.push(part);
  }
  return decoded.join('\\');
}
