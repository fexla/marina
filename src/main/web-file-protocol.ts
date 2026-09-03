/**
 * @file src/main/web-file-protocol.ts
 * @purpose marina-file:// 特权协议(ADR-034)的核心逻辑:为「已打开」面板的
 *   WebViewer 以流式 + 逐响应 CSP 的方式服务本地 HTML 及其同目录子资源。
 *
 * @关键设计:
 * - 本模块**不 import electron** —— protocol.handle / registerSchemesAsPrivileged
 *   的接线在 index.ts。这里只提供可单测的纯逻辑 + 一个接受 WHATWG Request 的
 *   处理器(Node 20 全局有 Request/Response,vitest 直接可测,与网关层同思路)。
 * - 自定义 scheme 文档**不继承** app 页面 CSP(PoC 实证,ADR-034)—— 内联脚本
 *   因此可执行,而 app 自身 CSP 一字不松(仅新增 frame-src 窄项,index.ts)。
 * - URL 形态:marina-file://local/<encoded-abs-path>。固定 host 'local' 是必须的:
 *   standard scheme 下 `scheme:///path` 会被 Chromium 把 path 首段折叠成 host
 *   (PoC 实证踩坑),固定 host 后相对路径引用(css/js/图)依旧正确解析。
 * - 路径白名单三条件(逐请求实时判定,不缓存"是否允许"结论):当前任一面板已
 *   打开文件的本体 / 已打开文件所在目录 / 受管 workspace 目录。全部做 realpath
 *   包含检查,防符号链接逃逸。
 * - 自包含档 CSP:html 响应禁一切 http(s) —— 产物可跑自己的脚本、引用本地兄弟
 *   资源,但连不出网(无出网通道 = 无数据外泄面)。svg 额外 script-src 'none'
 *   作纵深(防 <iframe src=x.svg> 执行其中脚本;<img> 引用本就不执行)。
 *
 * @对应文档: ADR-034(软件定义书);docs/方案-已打开面板-HTML预览.md(设计底稿)
 *
 * @不要在这里做的事:
 * - 不要改写/过滤文件内容(保真度契约:字节原样服务,archify 产物的交互依赖它)
 * - 不要放宽白名单(白名单是安全边界,不是建议;要扩走 ADR)
 * - 不要在这里处理下载(下载走 session will-download,index.ts 接线并广播事件)
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { realpath } from 'node:fs/promises';
import { Readable } from 'node:stream';
// URL 编解码纯函数与常量在 shared(main 协议层与 renderer WebViewer 共用,
// 保证两侧永远编出/认得同一种 URL)
import {
  MAX_WEB_SERVE_BYTES,
  WEB_FILE_SCHEME,
  decodeWebFileUrl,
} from '@shared/web-file-url';

/**
 * registerSchemesAsPrivileged 的配置(index.ts 在 app ready 前调用)。
 *
 * - standard:true 是相对路径解析的前提(兄弟 css/js 引用靠它);
 * - secure:true → 安全上下文(canvas/crypto 等现代 API 可用);
 * - stream:true → 大文件流式服务,不整读进内存;
 * - supportFetchAPI + corsEnabled → 产物内 fetch() 相对路径资源可用
 *   (sandbox iframe 是 opaque origin,所有请求都是跨源,靠响应的 ACAO:* 放行);
 * - **不设 bypassCSP** —— 协议层逐响应下发的 CSP 必须真实生效。
 */
export const WEB_FILE_SCHEME_PRIVILEGES = {
  scheme: WEB_FILE_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
    corsEnabled: true,
  },
} as const;

/** html 响应下发的自包含档 CSP(ADR-034 裁决 Q2:禁一切 http(s) 出网)。
 * 关键点:
 * - script-src 带 'unsafe-inline':内联脚本是本功能的存在理由(archify 交互);
 * - 所有资源指令只允许 marina-file:/data:/blob::外链 CDN 一概断;
 * - object-src 'none' + base-uri 'none' + form-action 'none':堵 <object>/<embed>
 *   执行路径、<base> 劫持、表单外发。 */
const HTML_CSP =
  "default-src 'none'; " +
  "script-src marina-file: data: blob: 'unsafe-inline'; " +
  "style-src marina-file: data: blob: 'unsafe-inline'; " +
  "img-src marina-file: data: blob:; " +
  "font-src marina-file: data:; " +
  "media-src marina-file: data: blob:; " +
  "connect-src marina-file: data: blob:; " +
  "frame-src marina-file: data: blob:; " +
  "object-src 'none'; form-action 'none'; base-uri 'none'";

/** svg 响应的纵深 CSP:svg 可内嵌脚本,若被 <iframe src=x.svg> 当文档加载会
 * 执行;<img> 引用本就不执行。这里统一禁掉脚本(archify 类产物不依赖 svg 文档
 * 脚本)。其余类型不附 CSP(浏览器按 MIME 处理,无脚本执行面)。 */
const SVG_CSP = "script-src 'none'";

/** 扩展名 → MIME。漏网的给 application/octet-stream —— 浏览器不会把 octet-stream
 * 当 html 执行,是安全的缺省。html 带 charset 保证非 ASCII 产物正确解码。 */
const MIME_BY_EXT: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
};

/** 取扩展名(小写、无点)对应的 MIME;未知返回 octet-stream。 */
export function mimeForPath(fsPath: string): string {
  const ext = extname(fsPath).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** 按 MIME 决定附带的 CSP(见 HTML_CSP / SVG_CSP 注释)。 */
export function cspForMime(mime: string): string | null {
  if (mime.startsWith('text/html')) return HTML_CSP;
  if (mime === 'image/svg+xml') return SVG_CSP;
  return null;
}

/** Windows 下路径比较需大小写不敏感 + 忽略尾部分隔符(session-workspace-manager
 * 同款 normalize 语义)。realpath 后两边都是系统真实大小写,但仍统一小写比较。 */
function normalizeForCompare(p: string): string {
  return p.replace(/[\\/]+$/, '').toLowerCase();
}

/** child 是否等于 root 或位于 root 之下(大小写不敏感;normalize 已去尾分隔符)。 */
function isUnderOrEqual(child: string, root: string): boolean {
  const c = normalizeForCompare(child);
  const r = normalizeForCompare(root);
  return c === r || c.startsWith(r + '\\') || c.startsWith(r + '/');
}

/** 白名单判定结果。 */
export type WebFileServeDecision =
  | { action: 'serve'; fsPath: string; mime: string; csp: string | null }
  | { action: 'deny'; status: 403 | 404 | 413; reason: string };

/** 协议处理器的依赖:白名单两大数据源,由 index.ts 闭包注入(避免本模块反向
 * 依赖 FilePanelService / SessionWorkspaceManager —— 保持可测 + 无循环依赖)。 */
export interface WebFileProtocolDeps {
  /** 所有 session 面板当前打开的文件绝对路径(主文档永远可服务)。 */
  getOpenFilePaths(): string[];
  /** 所有存活受管 workspace 目录(archify 产物常落在 workspace 里)。 */
  getWorkspaceRoots(): string[];
}

/**
 * marina-file:// 请求处理器。resolve() 做全部决策(白名单/realpath/上限/MIME),
 * handle() 只是把决策变成 Response —— 保持 Electron 接线层最薄。
 *
 * realpath 缓存策略:根集合(打开文件 + workspace 目录)按"输入集合指纹"缓存
 * realpath 结果 —— 面板一变指纹就变,缓存自动失效;单个目标路径的 realpath 同
 * 样带指纹缓存。指纹未变时同一路径不重复走磁盘(子资源突发请求共享缓存)。
 */
export class WebFileProtocol {
  private readonly deps: WebFileProtocolDeps;
  /** 当前缓存对应的输入集合指纹(打开文件 + workspace 目录拼接)。 */
  private epochFingerprint = '__never__';
  /** 指纹 → 目标路径的 realpath 缓存(子资源突发请求共享)。 */
  private readonly realpathCache = new Map<string, string>();
  /** 本指纹下白名单根是否已计算(与 cachedRealRoots 分开存:空集合也是合法结果)。 */
  private rootsComputed = false;
  /** realpath 后的白名单根(打开文件本体 + 其所在目录 + workspace 根)。 */
  private cachedRealRoots: string[] = [];

  constructor(deps: WebFileProtocolDeps) {
    this.deps = deps;
  }

  /** 决策一个已解码的绝对路径是否可服务。所有安全边界都在这里。 */
  async resolve(fsPath: string): Promise<WebFileServeDecision> {
    let realPath: string;
    try {
      realPath = await this.realpathCached(fsPath);
    } catch {
      return { action: 'deny', status: 404, reason: `文件不存在或无法解析:${fsPath}` };
    }

    const roots = await this.allowedRealRoots();
    const allowed = roots.some((root) => isUnderOrEqual(realPath, root));
    if (!allowed) {
      return { action: 'deny', status: 403, reason: '路径不在 marina-file 白名单内' };
    }

    let st;
    try {
      st = await stat(realPath);
    } catch {
      return { action: 'deny', status: 404, reason: `无法 stat:${fsPath}` };
    }
    if (!st.isFile()) {
      return { action: 'deny', status: 403, reason: '不是普通文件(目录不可服务)' };
    }
    if (st.size > MAX_WEB_SERVE_BYTES) {
      return {
        action: 'deny',
        status: 413,
        reason: `文件过大(${st.size} 字节,上限 ${MAX_WEB_SERVE_BYTES})`,
      };
    }

    const mime = mimeForPath(realPath);
    return { action: 'serve', fsPath: realPath, mime, csp: cspForMime(mime) };
  }

  /** protocol.handle 的回调体(WHATWG Request → Response)。 */
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const fsPath = decodeWebFileUrl(url.toString());
    if (!fsPath) {
      return denyResponse(403, 'URL 形态非法');
    }
    const decision = await this.resolve(fsPath);
    if (decision.action === 'deny') {
      return denyResponse(decision.status, decision.reason);
    }
    const headers = new Headers({
      'Content-Type': decision.mime,
      // opaque origin(sandbox iframe)下 fetch 相对资源是跨源请求,需显式放行
      'Access-Control-Allow-Origin': '*',
      // 热刷新靠 URL 查询串(?v=mtimeMs-size)缓存击穿;同 URL 强制走磁盘
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (decision.csp) headers.set('Content-Security-Policy', decision.csp);
    // Readable.toWeb 给出 node:stream/web 的 ReadableStream;Electron 的
    // protocol.handle 接受 WHATWG Response,类型层面用 DOM ReadableStream
    // 声明,这里做一次类型桥接(运行时是同一个标准接口)。
    const body = Readable.toWeb(
      createReadStream(decision.fsPath),
    ) as unknown as ReadableStream<Uint8Array>;
    return new Response(body, { status: 200, headers });
  }

  /** 目标路径的 realpath,带指纹缓存。 */
  private async realpathCached(fsPath: string): Promise<string> {
    this.refreshEpoch();
    const hit = this.realpathCache.get(fsPath);
    if (hit) return hit;
    const real = await realpath(fsPath);
    this.realpathCache.set(fsPath, real);
    return real;
  }

  /** 白名单根的 realpath 集合:打开文件本体 + 各自所在目录 + workspace 根。 */
  private async allowedRealRoots(): Promise<string[]> {
    this.refreshEpoch();
    if (this.rootsComputed) return this.cachedRealRoots;

    const openPaths = this.deps.getOpenFilePaths();
    const roots: string[] = [];
    for (const src of [...openPaths, ...this.deps.getWorkspaceRoots()]) {
      try {
        roots.push(await realpath(src));
      } catch {
        // 已消失的文件(面板与磁盘的竞态)直接跳过 —— 它不再可服务。
      }
    }
    // 打开文件额外放行其所在目录(iframe 的兄弟子资源)。workspace 根自身已是
    // 目录,不给它加父目录 —— 那会无谓放大白名单。
    for (const realOpen of roots.slice(0, openPaths.length)) {
      roots.push(dirname(realOpen));
    }
    this.cachedRealRoots = roots;
    this.rootsComputed = true;
    return roots;
  }

  /** 输入集合一变(面板增删 / workspace 变更),所有缓存整体作废重建。 */
  private refreshEpoch(): void {
    const fp = [...this.deps.getOpenFilePaths(), ...this.deps.getWorkspaceRoots()].join('|');
    if (fp !== this.epochFingerprint) {
      this.epochFingerprint = fp;
      this.realpathCache.clear();
      this.cachedRealRoots = [];
      this.rootsComputed = false;
    }
  }
}

/** deny 响应:纯文本说明,同样带 ACAO(iframe 内 fetch 也能读到错误)与 nosniff。 */
function denyResponse(status: number, reason: string): Response {
  return new Response(reason, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
