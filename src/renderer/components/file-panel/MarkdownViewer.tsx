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
} from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { OpenedFile } from '@shared/types';
import type { PanelSearchProps } from '../layout/panel-registry';
import { useDomTextHighlight } from '../../hooks/useDomTextHighlight';
import { useMiddleClickPan } from '../../hooks/useMiddleClickPan';
import { COMMAND_CHANNELS, type ReadImagePayload, type ReadImageResponse } from '@shared/protocol';
import { isRemoteUrl } from '@shared/url-scheme';
import { useFileContent } from './useFileContent';
import { useTranslation } from '../LanguageProvider';
import { useAppState } from '../../store';

interface ViewerProps {
  sessionId: string;
  file: OpenedFile;
  /** v0.3.1:dock 级搜索状态(C4 markdown 查找)。 */
  search: PanelSearchProps;
}

export function MarkdownViewer({ sessionId, file, search }: ViewerProps): JSX.Element {
  const { tx } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  // markdown 渲染风格(用户在设置页选):auto=marina 主题样式;github-*=GitHub 官方
  const mdStyle = useAppState().settings.filePanel?.markdownStyle ?? 'auto';
  const content = useFileContent(sessionId, file.path, file.mtimeMs);

  // 自定义 a/img 组件。img 需要 md 文件路径解析相对图片引用 → 用 useMemo 钉住
  // components 对象(仅 file.path 变时才换新引用),否则每次渲染都让 react-markdown
  // 重挂全部图片/链接,抖动 + 重复 IPC。
  const components = useMemo<Components>(
    () => ({
      a: MdLink,
      img: (props: ImgHTMLAttributes<HTMLImageElement>) => (
        <MdImage
          src={props.src}
          alt={props.alt}
          sessionId={sessionId}
          mdPath={file.path}
          mtimeMs={file.mtimeMs}
        />
      ),
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

  // 中键拖动平移(v0.3.3):与 text/diff viewer 一致。
  useMiddleClickPan(containerRef);

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
  // 三类 markdown 风格,容器 class 决定走哪套 CSS:
  // - 'custom:*'(用户 .css 主题)→ markdown-body md-custom,CSS 由顶层
  //   MdThemeInjector 注入 <style id=md-custom-theme>(约定写 .markdown-body 选择器)
  // - github-light/dark → markdown-body + github-markdown-css,明暗由 .md-github-*
  //   class 直接设变量(不靠 @media,Chromium 对第三方 CSS 不可靠)
  // - auto → file-markdown-viewer(marina 主题变量样式)
  let wrapClass: string;
  if (mdStyle.startsWith('custom:')) {
    wrapClass = 'markdown-body md-custom';
  } else if (mdStyle === 'github-light' || mdStyle === 'github-dark') {
    wrapClass = `markdown-body md-github-${mdStyle === 'github-dark' ? 'dark' : 'light'}`;
  } else {
    wrapClass = 'file-markdown-viewer';
  }
  return (
    <div className={wrapClass} ref={containerRef}>
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

/**
 * 外链:点击 preventDefault 后调 cmd:system:open-external,让系统默认浏览器打开。
 * 否则 Electron webContents 会导航到 href,Marina 的 SPA 被替换、前端崩。
 * 页内锚点(#xxx)不拦截,走默认滚动。target/rel 设 _blank + noopener 是 HTML 语义
 * 兜底(preventDefault 后不会真触发导航 / window.open)。
 */
function MdLink({ href, children }: AnchorHTMLAttributes<HTMLAnchorElement>): JSX.Element {
  const handle = (e: React.MouseEvent<HTMLAnchorElement>): void => {
    if (!href) return;
    if (href.startsWith('#')) return; // 页内锚点 → 默认滚动
    e.preventDefault();
    window.api
      .invoke(COMMAND_CHANNELS.SYSTEM_OPEN_EXTERNAL, { url: href })
      .catch((err: unknown) => console.warn('[md] openExternal failed', err));
  };
  return (
    <a href={href} onClick={handle} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
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
