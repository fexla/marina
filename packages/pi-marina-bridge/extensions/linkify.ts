/**
 * @file packages/pi-marina-bridge/extensions/linkify.ts
 * @purpose pi registerMarkdownTransformer 的实现体:在 markdown **源文本**
 *   进入 pi 自己的 marked 渲染之前,把裸文件路径 / 裸 URL 变成 markdown 链接,
 *   并把超长 URL 的显示文本缩短。pi 渲染链接时(PI_HYPERLINKS=1)输出 OSC 8,
 *   Marina 的 xterm 原生渲染为可点击 —— 检测发生在源文本层,天然没有终端
 *   软折行把路径劈断的问题(方案-终端可交互链接-20260912)。
 *
 * @关键设计:
 * - **display-only 的纯函数**:pi 对流式每个 chunk、最终消息、恢复的会话都会
 *   以**原始 markdown** 重跑本 transformer(不是上次输出),所以函数必须
 *   同步、无状态、幂等(输入相同时输出相同;对已变换文本再变换 = 恒等,
 *   有测试守护)。绝不做 IO(fs stat 等)—— pi 要求 transformer 廉价。
 * - **三类不透明段,原样透传**:fenced code block(``` / ~~~)、inline code
 *   span(反引号)、已有的 `[label](href)` 链接与 `![img](src)` 图片。
 *   这与 Marina markdown 面板的语义一致:代码内不链接化;已有链接只做
 *   「label 本身是超长 URL」的缩短,href 一律不动(pi 已把它们渲染为 OSC 8)。
 * - **裸路径 → marina:show 动作链接**:STRICT 检测(vendored,与 Marina 终端
 *   buffer 检测同规则),相对路径按 pi 进程 cwd 解析为绝对、`~` 展开 home,
 *   生成 `[原文](marina:show "<绝对路径>" [--line N])` 的 percent-encoding 形态。
 *   绝对化让链接自包含 —— 不依赖 Marina 侧的 cwd 状态,`--line` 承接
 *   `path:123` 的行号语义。
 * - **percent-encode 严格版**:marina: URI 会先做 markdown href 再进 OSC 8,
 *   除了标准 encodeURIComponent 还要补编码 `!'()*`(它们不被 encode,但
 *   `(` `)` 会劈断 markdown 链接语法);Marina 侧 marina-link.ts percent-decode
 *   恰好一次,再 shell 风格分词(反斜杠是字面字符,Windows 路径安全)。
 * - **裸 URL → `[label](url)`**:短 URL label 原样(保证可点、样式统一);
 *   超过阈值(> max(28, availableWidth/2),会引发难看的终端折行)时 label
 *   缩短为「域名+尾段」,href 保留完整 URL —— hover tooltip 由 Marina 展示
 *   完整原文,知情不丢。
 *
 * @不在这里做的事:
 * - 不解析/不路由 marina: 动作(那是 Marina 侧 marina-link.ts 的职责);
 * - 不 fs.stat 验证路径存在(不能做 IO;点击后 Marina resolveAndStat 兜底,
 *   失败 toast);
 * - 不处理 `pi -p` 打印模式(不走 transformer;Marina 终端级 []() provider
 *   与文件路径检测兜底)。
 */
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { detectFileLinks } from './vendor/terminal-path-detector';

/** transformer 依赖的上下文切片(pi MarkdownTransformContext 中我们用到的字段
 *  + 测试注入项;运行时由 index.ts 从 pi ctx 透传)。 */
export interface LinkifyContext {
  /** pi 渲染区内容宽度(列);URL 缩短阈值随它缩放。 */
  availableWidth: number;
  /** 相对路径解析基准。生产 = process.cwd()(pi 进程 cwd,随 pi 内部 cd 走);测试注入。 */
  cwd?: string;
  /** `~` 展开目标。生产 = os.homedir();测试注入。 */
  homeDir?: string;
}

/* ── 已有链接/图片(不透明段)────────────────────────────────────── */

/** 在行首 i 处匹配 `[label](href)` / `![label](href)`。
 *  label 允许转义与括号;href 三种形态(交替,按优先级):
 *  1. 标准(无空格,允许一层嵌套括号,marked 同规则);
 *  2. **宽容 marina**:`marina:` 开头允许裸空格(lazy,尾部 title 留给可选段)
 *     —— 模型常写 `[运行](marina:run gh issue list)` 自然形态,marked 不认
 *     (CommonMark 目标不能有裸空格),renderExistingLink 会把它归一化成 %20
 *     形态再交给 marked,渲染出正常 OSC 8 链接(勘误③ 20260913)。
 *     scheme 锚定误报面≈零;`marina run`(无冒号)任何形态都不认。
 *  3. 尖括号包裹 `<...>`(CommonMark 标准的目标含空格写法)—— marked 原生
 *     认,原样透传不归一化。
 *  引用式 `[l][r]` 与图片引用式不匹配(按普通文本走,罕见于对话输出)。 */
const LINK_AT_RE =
  /^(!?)\[((?:[^\\\[\]]|\\.)*)\]\(\s*(?:(marina:[^()]*?)|((?:[^()\s]|\([^\s()]*\))+)|<([^<>\n]*)>)\s*(?:"[^"]*")?\)/;

interface MatchedLink {
  /** 是否图片(`!` 前缀)。图片一律原样透传。 */
  image: boolean;
  label: string;
  href: string;
  /** 整段原文(含转义,如 label 里的 `\[`)。不改动时必须原文回放,
   *  不能对已转义 label 再转义(会双重转义)。 */
  raw: string;
  /** 结束位置(不含)。 */
  end: number;
}

function matchLinkAt(line: string, at: number): MatchedLink | null {
  const m = LINK_AT_RE.exec(line.slice(at));
  if (!m) return null;
  // href 三选一:宽容 marina > 标准串 > 尖括号内侧(交替顺序即优先级)。
  const href = m[3] ?? m[4] ?? m[5] ?? '';
  if (href.length === 0) return null;
  return { image: m[1] === '!', label: m[2]!, href, raw: m[0], end: at + m[0].length };
}

/* ── markdown 文本安全(反斜杠 / 方括号转义)─────────────────────── */

/** markdown label 里反斜杠与方括号都要转义,否则 marked 会吃掉 `\.`、把
 *  `[` 当链接语法 —— Windows 路径 label(D:\x\a.md)尤其容易踩。 */
function escapeMdLabel(label: string): string {
  return label.replace(/\\/g, '\\\\').replace(/([\[\]])/g, '\\$1');
}

/* ── URL 工具 ──────────────────────────────────────────────────── */

/** URL label 缩短阈值:列宽一半起、至少 28 —— 再长的裸 URL 在终端里会引发
 *  视觉折行,失去"一行可扫"的可读性。 */
function urlShortenThreshold(ctx: LinkifyContext): number {
  return Math.max(28, Math.floor((ctx.availableWidth > 0 ? ctx.availableWidth : 80) / 2));
}

/** 长域名+尾段折叠。尾段保留 #anchor / 文件名等信息密度最高的部分。 */
function shortenUrlLabel(url: string): string {
  try {
    const u = new URL(url);
    const rest = (u.pathname === '/' ? '' : u.pathname) + u.search + u.hash;
    if (rest.length <= 10) return u.host + rest;
    return u.host + '…' + (rest.length <= 18 ? rest : rest.slice(-16));
  } catch {
    // 非 URL 形态(理论上不进这里,防御)
    return url.length <= 24 ? url : url.slice(0, 12) + '…' + url.slice(-8);
  }
}

/** URL 粗匹配后的尾部修剪:剥句读/强调标记;`)` 只在括号不平衡时剥
 *  (保住 https://en.wikipedia.org/wiki/Foo_(bar) 这类合法带括号 URL)。 */
function trimUrlTail(raw: string): string {
  let s = raw;
  while (s.length > 0) {
    const last = s[s.length - 1]!;
    if (last === ')') {
      const open = (s.match(/\(/g) ?? []).length;
      const close = (s.match(/\)/g) ?? []).length;
      if (close > open) {
        s = s.slice(0, -1);
        continue;
      }
    }
    if (last !== ')' && '.,;:!?\]}\'">*_~'.includes(last)) {
      s = s.slice(0, -1);
      continue;
    }
    break;
  }
  return s;
}

/** encodeURIComponent 不编码 `!'()*`;`()` 会劈断 markdown href,这里补齐。
 *  结果只含未保留字符与 %XX —— 对 markdown href、OSC 8 URI、Marina 单次
 *  percent-decode 三处都安全。 */
export function encodeMarinaUriPayload(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'),
  );
}

/** 裸 URL 正则:宽松 `\S+` 起步,尾部由 trimUrlTail 收口。 */
const BARE_URL_RE = /https?:\/\/\S+/g;

/* ── 路径 → marina:show ────────────────────────────────────────── */

/** 把检测到的路径候选(剥 @ 优先)绝对化。不做 fs 校验(见文件头)。 */
function resolveForShow(p: string, ctx: LinkifyContext): string {
  if (p === '~' || p.startsWith('~/')) return resolve(ctx.homeDir ?? homedir(), p.slice(2));
  if (isAbsolute(p)) return p;
  return resolve(ctx.cwd ?? process.cwd(), p);
}

/** STRICT 正则把 `D:/x/y.ts` 从 `/` 起匹配(冒号不在字符集、lookbehind 对 `:` 放行),
 *  盘符被截在匹配外 —— 这里按前文补回 `D:`,否则 win32 isAbsolute('/x') 会把
 *  路径落到当前盘根而非 D 盘。前文不是盘符形态则原样返回。 */
function withDrivePrefix(p: string, textBefore: string): string {
  if (!p.startsWith('/')) return p;
  const m = /([A-Za-z]):$/.exec(textBefore);
  return m ? m[1] + ':' + p : p;
}

/** 组 `marina:show "<abs>" [--line N]` 的 URI(payload 整体严格 percent-encode)。 */
export function buildMarinaShowUri(absPath: string, line?: number): string {
  let payload = `show "${absPath}"`;
  if (line !== undefined && Number.isFinite(line) && line > 0) payload += ` --line ${line}`;
  return 'marina:' + encodeMarinaUriPayload(payload);
}

/* ── 普通文本段变换 ────────────────────────────────────────────── */

/** 单段普通文本(无 code / 无链接语法)内的裸 URL + 裸路径 → markdown 链接。
 *  URL 优先(path 检测自带 URL 排除,这里再做重叠丢弃双保险)。 */
function linkifyPlainSegment(text: string, ctx: LinkifyContext): string {
  interface Replacement {
    start: number;
    end: number;
    out: string;
  }
  const replacements: Replacement[] = [];

  // 裸 URL
  BARE_URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BARE_URL_RE.exec(text)) !== null) {
    const url = trimUrlTail(m[0]);
    if (url.length <= 'https://'.length + 1) continue; // 没有主机部分
    // `<https://x>` autolink 形态不包(包了会破坏 <> 语法)
    const before = text[m.index - 1];
    if (before === '<') continue;
    const label = url.length > urlShortenThreshold(ctx) ? shortenUrlLabel(url) : url;
    replacements.push({
      start: m.index,
      end: m.index + url.length,
      out: `[${escapeMdLabel(label)}](${url})`,
    });
  }

  // 裸文件路径(STRICT,vendored);正则会截掉 `D:/x` 的盘符,按前文补回
  for (const det of detectFileLinks(text)) {
    const target = withDrivePrefix(det.pathCandidates[0]!, text.slice(0, det.start));
    const abs = resolveForShow(target, ctx);
    const href = buildMarinaShowUri(abs, det.line);
    replacements.push({
      start: det.start,
      end: det.end,
      out: `[${escapeMdLabel(det.raw)}](${href})`,
    });
  }

  if (replacements.length === 0) return text;
  // 按 start 排序 + 丢弃与已选区间重叠的(先到先得,URL 在前 = URL 优先)
  replacements.sort((a, b) => a.start - b.start || b.end - a.end);
  let out = '';
  let cursor = 0;
  for (const r of replacements) {
    if (r.start < cursor) continue; // 重叠
    out += text.slice(cursor, r.start) + r.out;
    cursor = r.end;
  }
  return out + text.slice(cursor);
}

/* ── 单行扫描 ──────────────────────────────────────────────────── */

/** 行内扫描:code span / 已有链接不透明透传,其余段走 linkifyPlainSegment。 */
function linkifyLine(line: string, ctx: LinkifyContext): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;

    // inline code span:等长反引号闭合;未闭合(流式半截)原样到行尾
    if (ch === '`') {
      let run = 0;
      while (line[i + run] === '`') run += 1;
      let close = -1;
      for (let j = i + run; j + run <= line.length; j += 1) {
        if (line[j] === '`') {
          let r2 = 0;
          while (line[j + r2] === '`') r2 += 1;
          if (r2 === run) {
            close = j;
            break;
          }
          j += r2 - 1;
        }
      }
      if (close === -1) {
        out += line.slice(i);
        break;
      }
      out += line.slice(i, close + run);
      i = close + run;
      continue;
    }

    // 已有链接 / 图片(含 `![`):不透明段
    if (ch === '[' || (ch === '!' && line[i + 1] === '[')) {
      const link = matchLinkAt(line, i);
      if (link) {
        out += renderExistingLink(link, ctx);
        i = link.end;
        continue;
      }
    }

    // 普通文本段:累积到下一个 '`' / '[' / '!['
    let j = i;
    while (j < line.length) {
      const c = line[j]!;
      if (c === '`' || c === '[') break;
      if (c === '!' && line[j + 1] === '[') break;
      j += 1;
    }
    if (j > i) {
      out += linkifyPlainSegment(line.slice(i, j), ctx);
      i = j;
    } else {
      // j === i:当前字符是上面分支没吃掉的 '[' 或 '!' —— 原样输出单字符前进
      // (半个链接语法,等流式补全后下轮 transformer 再处理)
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** 已有链接的回放规则(优先级从上到下):
 *  1. 图片 → 整段原文(label 可能自带转义,不能再转义)。
 *  2. 宽容 marina(目标以 marina: 开头且含裸空格)→ **归一化**:payload 严格
 *     percent-encode 后重发,让 pi 的 marked 认成合法链接、渲染出 OSC 8。
 *     marked 不认裸空格目标,原样透传会变成字面量文本(勘误③ 20260913)。
 *     label 保留原捕获(自带转义,不二次转义)。归一化结果无裸空格 → 幂等。
 *  3. label 是超长 URL → 仅缩短 label(href 不动)。
 *  4. 其余 → 整段原文回放。 */
function renderExistingLink(link: MatchedLink, ctx: LinkifyContext): string {
  if (link.image) return link.raw;
  const isMarinaHref = link.href.toLowerCase().startsWith('marina:');
  if (isMarinaHref && /[ \t]/.test(link.href)) {
    const payload = link.href.slice('marina:'.length).trim();
    return `[${link.label}](marina:${encodeMarinaUriPayload(payload)})`;
  }
  if (/^https?:\/\//.test(link.label) && link.label.length > urlShortenThreshold(ctx)) {
    return `[${escapeMdLabel(shortenUrlLabel(link.label))}](${link.href})`;
  }
  return link.raw;
}

/* ── 入口 ──────────────────────────────────────────────────────── */

/** fenced code 起始行(允许 ≤3 空格缩进,``` 或 ~~~ 3 个以上)。 */
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * markdown transformer 主体。逐行处理:fence 状态机跨行,行内做链接化。
 *
 * @param markdown pi 传入的原始 markdown(user / assistant / thinking block 全文)
 * @param ctx 见 LinkifyContext
 * @returns 变换后的 markdown(同输入为纯函数;流式重跑安全)
 */
export function linkifyMarkdown(markdown: string, ctx: LinkifyContext): string {
  if (!markdown) return markdown;
  const lines = markdown.split('\n');
  const out: string[] = [];
  let fence = ''; // 开栏围栏串(如 '```');空 = 不在代码块内
  for (const line of lines) {
    if (fence) {
      out.push(line);
      const m = FENCE_RE.exec(line);
      // 关栏:同字符且长度 ≥ 开栏(CommonMark 规则近似)
      if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length) fence = '';
      continue;
    }
    const m = FENCE_RE.exec(line);
    if (m) {
      fence = m[1]!;
      out.push(line);
      continue;
    }
    out.push(linkifyLine(line, ctx));
  }
  return out.join('\n');
}
