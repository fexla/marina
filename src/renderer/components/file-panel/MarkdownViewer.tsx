/**
 * @file src/renderer/components/file-panel/MarkdownViewer.tsx
 * @purpose 用 react-markdown + remark-gfm 渲染 Markdown(GFM:表格 / 删除线 /
 *   任务列表 / 自动链接)。
 *
 *   Electron 安全(两个 react-markdown 默认行为会坏掉 Marina,必须覆盖组件):
 *   - <a href>:默认点击让 webContents 导航到 href → Marina SPA 被外部页面替换、
 *     整个前端崩。覆盖 a 组件:点击 preventDefault,改调 cmd:system:open-external
 *     在系统浏览器打开(main 拒绝 file:// 与非 http(s));页内锚点 #xxx 走默认滚动。
 *   - <img src="./x.png">:相对路径会解析到 renderer 的 base URL(不是 md 文件
 *     所在目录),且 prod CSP `img-src 'self' data:` 挡掉绝对 file:// 路径 → 图加载
 *     不到。覆盖 img 组件:本地引用调 cmd:file-panel:read-image,让 main 相对 md
 *     目录解析并读成 dataUrl(CSP 允许 data:);http(s)/data:/blob: 直接交给 <img>。
 *
 *   XSS:react-markdown 默认不渲染原始 HTML(不开 rehype-raw),md 里 <script> 等
 *   被当文本,安全。
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type ImgHTMLAttributes,
  type RefObject,
} from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { OpenedFile } from '@shared/types';
import type { PanelSearchProps } from '../layout/panel-registry';
import { useDomTextHighlight } from '../../hooks/useDomTextHighlight';
import { useAutoscroll } from '../../hooks/useAutoscroll';
import { useFileViewerScroll } from '../../hooks/useFileViewerScroll';
import { COMMAND_CHANNELS, type ReadImagePayload, type ReadImageResponse, type OpenPathFromMarkdownPayload } from '@shared/protocol';
import { isRemoteUrl } from '@shared/url-scheme';
import { useFileContent } from './useFileContent';
import { useTranslation } from '../LanguageProvider';
import { useToast } from '../Toast';
import { MarkdownCodeBlock, extractCodeBlockInfo } from './MarkdownCodeBlock';
import { GalleryViewer } from './GalleryViewer';
import { markdownSurfaceClass } from './markdown-surface';
import { useAppState } from '../../store';

interface ViewerProps {
  sessionId: string;
  file: OpenedFile;
  /** v0.3.1:dock 级搜索状态(C4 markdown 查找)。 */
  search: PanelSearchProps;
  /** Markdown 文档真正的纵向滚动容器(.file-panel-body)。 */
  scrollRef: RefObject<HTMLElement | null>;
}

export function MarkdownViewer({ sessionId, file, search, scrollRef }: ViewerProps): JSX.Element {
  const { tx } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  // markdown 渲染风格(用户在设置页选):auto=marina 主题样式;github-*=GitHub 官方
  const mdStyle = useAppState().settings.filePanel?.markdownStyle ?? 'auto';
  const content = useFileContent(sessionId, file.path, file.mtimeMs);

  // 自定义 a/img/pre 组件。img 需要 md 文件路径解析相对图片引用、pre 需要
  // sessionId 执行代码块 → 用 useMemo 钉住 components 对象(仅 file.path / sessionId
  // 变时才换新引用),否则每次渲染都让 react-markdown 重挂全部图片/链接/代码块,
  // 抖动 + 重复 IPC + 代码块状态丢失。
  const components = useMemo<Components>(
    () => ({
      a: (props) => (
        <MdLink
          {...props}
          sessionId={sessionId}
          mdPath={file.path}
        />
      ),
      img: (props: ImgHTMLAttributes<HTMLImageElement>) => (
        <MdImage
          src={props.src}
          alt={props.alt}
          sessionId={sessionId}
          mdPath={file.path}
          mtimeMs={file.mtimeMs}
        />
      ),
      // v0.3.3:fenced code block 包裹成可交互的 MarkdownCodeBlock(语言标签 /
      // 复制 / 一键运行 / 输出区)。识别 pre 的唯一 code 子节点;非该结构
      // (异常嵌套)回退默认 <pre> 保持容错。详见 MarkdownCodeBlock 头注。
      pre: (props) => {
        const info = extractCodeBlockInfo(props.children);
        if (info) {
          const start = props.node?.position?.start;
          // source offset + code 摘要共同构成 cache identity:切 terminal/remount 后
          // 同一块恢复输出;代码或源位置变化则不错误挂回旧运行结果。
          const sourcePosition = start?.offset ?? `${start?.line ?? 0}:${start?.column ?? 0}`;
          // v0.3.3 Feature A(ADR-026):```gallery 代码块 → GalleryViewer 幻灯片。
          // 与可运行代码块并列分发;gallery 不是可运行语言,不走 MarkdownCodeBlock。
          if (info.className && /language-gallery/.test(info.className)) {
            return (
              <GalleryViewer
                sessionId={sessionId}
                documentPath={file.path}
                code={info.code}
                mtimeMs={file.mtimeMs}
              />
            );
          }
          return (
            <MarkdownCodeBlock
              sessionId={sessionId}
              documentPath={file.path}
              sourcePosition={sourcePosition}
              className={info.className}
              code={info.code}
            />
          );
        }
        return <pre>{props.children}</pre>;
      },
    }),
    [file.path, sessionId, file.mtimeMs],
  );

  // 预处理图片 src:CommonMark 严格模式下裸 URL 遇空格会截断 → "Pasted image 2026.png"
  // 这类带空格本地图的 src 被切短、读不到。把图片引用里的空格转 %20、反斜杠转
  // 正斜杠(网络/data:/已 <> 包裹的不动),让 src 完整传给 img 组件;main 端
  // readImageAsset 会 decodeURIComponent 还原真实路径。GitHub/Typora 宽容,这里
  // 补齐到同等体验。useMemo 钉住,仅文本变化(mtime 刷新)时重算。
  const normalizedText = useMemo(
    () => (content?.kind === 'markdown' ? normalizeMdImageSources(content.text) : ''),
    [content],
  );

  // v0.3.1 C4:markdown 文件内查找(DOM 文本节点 + CSS Custom Highlight)。
  // contentVersion = normalizedText(内容变化时重算匹配)。useEffect 依赖它。
  // v0.3.2:统一改用 useDomTextHighlight(text/diff/markdown 三 viewer 共一套
  // CSS Custom Highlight overlay,highlight name 统一 marina-viewer-search)。
  useDomTextHighlight({
    sessionId,
    containerRef,
    query: search.query,
    caseSensitive: search.caseSensitive,
    active: search.visible,
    contentVersion: normalizedText,
  });

  useFileViewerScroll({
    sessionId,
    path: file.path,
    kind: file.kind,
    scrollRef,
    layoutRef: containerRef,
    ready: content?.kind === 'markdown',
    restoreVersion: file.mtimeMs,
    searchActive: search.visible && search.query.length > 0,
  });

  // Markdown 根本身不滚动；文档级中键自动滚动作用于外层 file-panel-body。
  useAutoscroll(scrollRef);

  if (!content) {
    return <div className="file-viewer-loading">{tx('加载中…', 'Loading…')}</div>;
  }
  if (content.kind !== 'markdown') {
    return (
      <div className="file-viewer-error">
        {content.kind === 'unknown'
          ? content.message
          : tx('内容类型不匹配', 'content kind mismatch')}
      </div>
    );
  }
  return (
    <div className={markdownSurfaceClass(mdStyle)} ref={containerRef}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {normalizedText}
      </ReactMarkdown>
      {content.truncated && (
        <div className="file-truncated-mark">
          {tx('…(文件过大,仅显示前 2MB)', '…(file large, first 2MB only)')}
        </div>
      )}
    </div>
  );
}

interface MdLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  sessionId: string;
  /** 当前渲染的 md 文件规范化绝对路径(main 端成员校验 + 相对解析基准)。 */
  mdPath: string;
}

/**
 * v0.3.3 Feature B(决策 #4):markdown 里的链接按 scheme 分流——
 * - **外链**:`http://` / `https://` / `mailto:` 开头 → cmd:system:open-external
 *   (系统浏览器;main 对非 http(s) 一律拒,所以必须 preventDefault)。
 * - **页内锚点** `#xxx` → 不拦截,默认滚动(react-markdown 渲染的 id)。
 * - **本地文件**(其余一切)→ cmd:file-panel:open-path 相对 md 所在目录解析,
 *   进面板**只读查看**(复用 FilePanelService 状态机:加 tab + 切 active + watcher)。
 *   不存在 / 不是文件 / md 不在面板 → main 抛 FilePanelError,这里 toast 提示。
 *
 * 心智约定(写进 show-in-marina SKILL):本地文件直接写路径→面板打开;网页写完整
 * `https://` URL→浏览器。这是「定一个格式识别外链」——格式即完整 scheme URL。
 *
 * target/rel 设 _blank + noopener 是 HTML 语义兜底(preventDefault 后不会真导航)。
 */
function MdLink({ href, children, sessionId, mdPath }: MdLinkProps): JSX.Element {
  const { tx } = useTranslation();
  const toast = useToast();
  const handle = (e: React.MouseEvent<HTMLAnchorElement>): void => {
    if (!href) return;
    if (href.startsWith('#')) {
      // react-markdown 默认不会给 heading 加 id，旧实现直接放行浏览器默认行为，
      // 实际无目标可跳。按文档内 heading 文本生成 GitHub 风格 slug 后主动定位。
      e.preventDefault();
      scrollToMarkdownAnchor(e.currentTarget, href);
      return;
    }
    e.preventDefault();
    // 决策 #4:外链 = 完整 http(s)/mailto scheme。其余一律当本地文件。
    if (isExternalLink(href)) {
      window.api
        .invoke(COMMAND_CHANNELS.SYSTEM_OPEN_EXTERNAL, { url: href })
        .catch((err: unknown) => console.warn('[md] openExternal failed', err));
      return;
    }
    // 本地文件链接 → 相对 md 目录解析进面板只读查看。main 端做成员校验 + resolve +
    // stat,失败(不存在/不是文件/md 不在面板)抛 FilePanelError → 这里 toast。
    window.api
      .invoke<OpenPathFromMarkdownPayload, unknown>(COMMAND_CHANNELS.FILE_PANEL_OPEN_PATH, {
        sessionId,
        mdPath,
        src: href,
      })
      .catch((err: unknown) => {
        console.warn('[md] openPath failed', err);
        const reason = err instanceof Error ? err.message : String(err);
        toast.push({
          kind: 'error',
          message: `${tx('打开文件失败:', 'Open file failed: ')}${reason}`,
        });
      });
  };
  return (
    <a href={href} onClick={handle} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/**
 * v0.3.3 Feature B(决策 #4):链接是否为「外链」(走系统浏览器)。
 * 只有完整 `http://` / `https://` / `mailto:` scheme 才算外链;其余(相对路径、
 * 绝对路径、`file://`、`data:`、`tel:` 等)一律当本地文件 → 进面板只读查看。
 * 注意:不用 url-scheme 的 isRemoteUrl(它含 data/blob/tel,对**链接**场景过宽——
 * 那些当本地文件解析失败 toast 比「悄悄当外链打浏览器」体验更明确)。
 */
function isExternalLink(href: string): boolean {
  return /^(?:https?:|mailto:)/i.test(href);
}

/**
 * 在当前 Markdown 容器内定位 `#slug` 对应 heading。
 *
 * 不引入 remark-slug：该依赖只为一个行为增加构建面，且项目技术栈边界要求新包
 * 先审批。这里的 slug 规则覆盖 Marina 文档常用中英文标题：Unicode 字母/数字保留，
 * 标点删除，连续空白/连字符折成 `-`。重复标题定位第一个，与浏览器重复 id 行为一致。
 */
function scrollToMarkdownAnchor(anchor: HTMLAnchorElement, href: string): void {
  let wanted = href.slice(1);
  try {
    wanted = decodeURIComponent(wanted);
  } catch {
    // 畸形 percent-encoding 保留原串；找不到目标时安全 no-op。
  }
  const root = anchor.closest('.markdown-body');
  if (!root) return;
  const target = Array.from(root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')).find(
    (heading) => markdownHeadingSlug(heading.textContent ?? '') === wanted,
  );
  target?.scrollIntoView({ block: 'start' });
}

/** GitHub 风格 heading slug 的最小实现；保持中文等 Unicode 字母。 */
function markdownHeadingSlug(text: string): string {
  return text
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/[\s-]+/g, '-')
    .replace(/^-|-$/g, '');
}

interface ImgProps {
  src: string | undefined;
  alt: string | undefined;
}

/**
 * 预处理 markdown 图片引用的 src,补齐 CommonMark 严格模式不容忍的写法:
 * - 空格 → %20(micromark 裸 URL 遇空格截断;GitHub/Typora 自动转,这里对齐)
 * - 反斜杠 → 正斜杠(Windows 风格 C:\foo → C:/foo,Node resolve 都认)
 * 只处理 inline 图片 ![](...);reference 式 ![][ref] 的 URL 在别处定义,不动。
 * 网络(http/data/blob/mailto)与已 <> 包裹的 src 本就不截断,跳过。
 * main 端 readImageAsset 会 decodeURIComponent 把 %20 还原成真实路径再 resolve。
 */
function normalizeMdImageSources(md: string): string {
  return md.replace(/(!\[[^\]]*\]\()([^)]*?)(\))/g, (whole, head, src, tail) => {
    if (src.startsWith('<') && src.endsWith('>')) return whole;
    if (isRemoteUrl(src)) return whole;
    const fixed = src.replace(/\\/g, '/').replace(/ /g, '%20');
    return `${head}${fixed}${tail}`;
  });
}

/**
 * 图片:本地引用(相对/绝对路径,非 http)走 IPC 让 main 读成 dataUrl,绕开 CSP 对
 * file:// 的禁 + 相对路径 base 解析错误。http(s)/data:/blob: 直接交给 <img>(网络图
 * 受 prod CSP 策略,本地截图是主场景)。loading 期 / 失败显示占位。
 */
function MdImage({
  src,
  alt,
  sessionId,
  mdPath,
  mtimeMs,
}: ImgProps & { sessionId: string; mdPath: string; mtimeMs: number }): JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!src) {
      setUrl(null);
      setErr(null);
      return;
    }
    // 网络 / data: / blob: 直接交给 <img>(能否加载由 CSP 决定)
    if (isRemoteUrl(src)) {
      setUrl(src);
      setErr(null);
      return;
    }
    // 本地路径 → main 相对 md 文件目录解析 + 读成 dataUrl。sessionId 作成员校验,
    // mtimeMs 作 cache-bust(md 改了即使某张图 src 没变也重拉,防读到旧 dataUrl)。
    setUrl(null);
    setErr(null);
    let cancelled = false;
    window.api
      .invoke<ReadImagePayload, ReadImageResponse>(COMMAND_CHANNELS.FILE_PANEL_READ_IMAGE, {
        sessionId,
        mdPath,
        src,
      })
      .then((res) => {
        if (cancelled) return;
        if ('dataUrl' in res) setUrl(res.dataUrl);
        else setErr(res.error);
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [src, sessionId, mdPath, mtimeMs]);

  if (err) {
    return (
      <span className="md-img-error" title={err}>
        🖼 {alt || src}
      </span>
    );
  }
  if (!url) {
    return <span className="md-img-loading">…</span>;
  }
  return <img src={url} alt={alt ?? ''} loading="lazy" />;
}
