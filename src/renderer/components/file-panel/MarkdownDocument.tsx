/**
 * @file src/renderer/components/file-panel/MarkdownDocument.tsx
 * @purpose “已打开”文件与命令面板共用的 Markdown 正文渲染模块。
 *
 * @关键设计:
 * - 外部 interface 只接收内存 Markdown、稳定文档身份和可选文件上下文；读取文件、
 *   命令状态机、tab 等来源差异留给各自 adapter，正文能力只实现一次。
 * - fileContext 是路径能力而非伪造字段：只有“已打开”文件传入，因此本地链接、
 *   本地图片和 gallery 才能经过 main 的成员校验与相对路径解析。命令 stdout 没有
 *   文档路径，绝不拿 command key 冒充文件路径绕过该安全 seam。
 * - documentIdentity 只用于代码块运行缓存。文件用规范化路径，命令用稳定 key；
 *   两种来源切面板卸载后都能恢复同一代码块的运行状态。
 * - Markdown 主题、GFM、外链、代码块和 DOM 查找都在本模块内，避免两个面板继续
 *   漂移出两套行为。
 *
 * @对应文档: docs/方案-命令面板-20260802.md D5；软件定义书 ADR-018、ADR-028。
 *
 * @不要在这里做的事:
 * - 不读取文件或管理 CommandEntry；那是 MarkdownViewer / CommandPanel adapter 的职责。
 * - 不启用 rehype-raw；命令输出和文件内容都视为不可信，原始 HTML 必须保持禁用。
 * - 不为无 fileContext 的内容猜 cwd / MARINA_WORKSPACE 路径。
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type ImgHTMLAttributes,
  type ReactNode,
  type RefObject,
} from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  COMMAND_CHANNELS,
} from '@shared/protocol';
import { isRemoteUrl } from '@shared/url-scheme';
import { useDomTextHighlight } from '../../hooks/useDomTextHighlight';
import { useAppState } from '../../store';
import { useTranslation } from '../LanguageProvider';
import type { PanelSearchProps } from '../layout/panel-registry';
import { useToast } from '../Toast';
import { GalleryViewer } from './GalleryViewer';
import { MarkdownCodeBlock, extractCodeBlockInfo } from './MarkdownCodeBlock';
import { markdownSurfaceClass } from './markdown-surface';

/** 只有真实“已打开”Markdown 文件才具备的路径相关能力。 */
export interface MarkdownFileContext {
  /** main 已规范化并纳入 FilePanelService 成员集合的绝对路径。 */
  path: string;
  /** 文件变更版本；本地图片读取用它触发 cache-bust。 */
  mtimeMs: number;
}

export interface MarkdownDocumentProps {
  /** 绑定的终端 session；代码块执行和文件 IPC 都以 owner session 校验。 */
  sessionId: string;
  /** 已由来源 adapter 取得的完整 Markdown 文本。 */
  markdown: string;
  /** 稳定逻辑身份，只用于代码块组件外缓存，不要求是文件路径。 */
  documentIdentity: string;
  /** 有真实文件路径时开启本地链接、图片与 gallery；命令输出必须省略。 */
  fileContext?: MarkdownFileContext;
  /** dock 级文件内搜索状态。 */
  search: PanelSearchProps;
  /** 文件 adapter 传入根 ref，供其在同一 DOM 上恢复外层滚动位置。 */
  rootRef?: RefObject<HTMLDivElement>;
  /** 需要留在同一主题内容面内的来源提示（例如文件截断标记）。 */
  trailingContent?: ReactNode;
}

/**
 * 渲染一个已经在内存中的 Markdown 文档。
 *
 * 这是“已打开”与“命令”两个 adapter 共同跨越的 seam：调用方只提供来源数据和
 * 能力上下文，不再各自配置 react-markdown。文件加载错误/截断提示、命令 running /
 * empty 状态仍由 adapter 包裹，避免把两套生命周期塞进本模块的 interface。
 */
export function MarkdownDocument({
  sessionId,
  markdown,
  documentIdentity,
  fileContext,
  search,
  rootRef,
  trailingContent,
}: MarkdownDocumentProps): JSX.Element {
  const internalRootRef = useRef<HTMLDivElement>(null);
  const containerRef = rootRef ?? internalRootRef;
  // 拆成 primitive 后再作为 renderer map 依赖：文件 adapter 为了表达能力会传
  // inline object，若直接依赖 fileContext 引用，每次父组件 render 都会重挂图片/
  // 代码块并重复图片 IPC。只有真实路径或 mtime 变化才应重建 components。
  const filePath = fileContext?.path;
  const fileMtimeMs = fileContext?.mtimeMs ?? null;
  // markdown 渲染风格(用户在设置页选):auto=Marina 主题样式;github-*=GitHub 官方。
  const mdStyle = useAppState().settings.filePanel?.markdownStyle ?? 'auto';

  // 自定义 a/img/pre 组件。fileContext 的存在明确控制路径相关能力；
  // documentIdentity 则只给代码块缓存，二者不能混用。
  const components = useMemo<Components>(
    () => ({
      a: (props) => <MdLink {...props} sessionId={sessionId} mdPath={filePath} />,
      img: (props: ImgHTMLAttributes<HTMLImageElement>) => (
        <MdImage
          src={props.src}
          alt={props.alt}
          sessionId={sessionId}
          mdPath={filePath}
          mtimeMs={fileMtimeMs}
        />
      ),
      // fenced code block 共用交互外壳(语言标签 / 复制 / 一键运行 / 输出区)。
      // gallery 额外依赖真实文档目录；命令输出没有 fileContext 时降级为普通的
      // MarkdownCodeBlock（仍可复制，但 gallery 不是可运行语言）。
      pre: (props) => {
        const info = extractCodeBlockInfo(props.children);
        if (info) {
          const start = props.node?.position?.start;
          // source offset + code 摘要共同构成 cache identity：切 panel/remount 后
          // 同一块恢复输出；代码或源位置变化则不错误挂回旧运行结果。
          const sourcePosition = start?.offset ?? `${start?.line ?? 0}:${start?.column ?? 0}`;
          if (
            filePath !== undefined &&
            fileMtimeMs !== null &&
            info.className &&
            /language-gallery/.test(info.className)
          ) {
            return (
              <GalleryViewer
                sessionId={sessionId}
                documentPath={filePath}
                code={info.code}
                mtimeMs={fileMtimeMs}
              />
            );
          }
          return (
            <MarkdownCodeBlock
              sessionId={sessionId}
              documentIdentity={documentIdentity}
              sourcePosition={sourcePosition}
              className={info.className}
              code={info.code}
            />
          );
        }
        return <pre>{props.children}</pre>;
      },
    }),
    [documentIdentity, fileMtimeMs, filePath, sessionId],
  );

  // CommonMark 严格模式会截断带空格的裸本地图片 URL。统一预处理保证文件来源
  // 与命令来源经过同一 parser；无 fileContext 时本地图片随后会安全显示占位。
  const normalizedText = useMemo(() => normalizeMdImageSources(markdown), [markdown]);

  // Markdown 文件内查找：DOM 文本节点 + CSS Custom Highlight，不改 react-markdown DOM。
  useDomTextHighlight({
    sessionId,
    containerRef,
    query: search.query,
    caseSensitive: search.caseSensitive,
    active: search.visible,
    contentVersion: normalizedText,
  });

  return (
    <div className={markdownSurfaceClass(mdStyle)} ref={containerRef}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {normalizedText}
      </ReactMarkdown>
      {trailingContent}
    </div>
  );
}

interface MdLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  sessionId: string;
  /** 真实 Markdown 文件路径；缺省表示来源没有本地路径能力。 */
  mdPath: string | undefined;
}

/**
 * Markdown 链接按能力分流：
 * - http(s)/mailto 外链 → 系统浏览器；
 * - #anchor → 当前 Markdown 根内定位；
 * - 其余本地路径 → 仅在有真实 mdPath 时交给 FilePanelService 解析并打开。
 *
 * 命令输出没有文档路径，本地链接会被阻止而不是猜 cwd。这样既保持 Electron SPA
 * 不导航，也不把 command key 伪装成受 main 信任的文件成员。
 */
function MdLink({ href, children, sessionId, mdPath }: MdLinkProps): JSX.Element {
  const { tx } = useTranslation();
  const toast = useToast();
  const handle = (event: React.MouseEvent<HTMLAnchorElement>): void => {
    if (!href) return;
    if (href.startsWith('#')) {
      event.preventDefault();
      scrollToMarkdownAnchor(event.currentTarget, href);
      return;
    }
    event.preventDefault();
    if (isExternalLink(href)) {
      window.api
        .invoke(COMMAND_CHANNELS.SYSTEM_OPEN_EXTERNAL, { url: href })
        .catch((err: unknown) => console.warn('[md] openExternal failed', err));
      return;
    }
    if (!mdPath) {
      // 无真实文档目录就没有正确、安全的相对解析基准。命令面板旧行为同样不打开
      // 本地链接；这里显式停在能力 seam，而不是让 webContents 默认导航。
      return;
    }
    window.api
      .invoke(COMMAND_CHANNELS.FILE_PANEL_OPEN_PATH, {
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

/** 只有完整 http(s)/mailto scheme 才算外链；其余值保留给本地文件能力处理。 */
function isExternalLink(href: string): boolean {
  return /^(?:https?:|mailto:)/i.test(href);
}

/** 在当前 Markdown 容器内定位 `#slug` 对应 heading。 */
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
 * 预处理 Markdown 图片引用的 src，补齐 CommonMark 严格模式不容忍的写法：
 * 空格转 %20、Windows 反斜杠转正斜杠。网络/data/blob 与 `<...>` URL 不动。
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
 * 图片：远程/data/blob URL 直接交给 img；本地引用只有 fileContext 才能经 main
 * 相对真实 Markdown 文件解析并读成 data URL。无路径能力时显示占位，不尝试
 * renderer base URL 或 file://，避免错误目录与 CSP 行为漂移。
 */
function MdImage({
  src,
  alt,
  sessionId,
  mdPath,
  mtimeMs,
}: ImgProps & {
  sessionId: string;
  mdPath: string | undefined;
  mtimeMs: number | null;
}): JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!src) {
      setUrl(null);
      setErr(null);
      return;
    }
    if (isRemoteUrl(src)) {
      setUrl(src);
      setErr(null);
      return;
    }
    if (!mdPath) {
      setUrl(null);
      setErr('Local image unavailable: this Markdown source has no file path.');
      return;
    }

    setUrl(null);
    setErr(null);
    let cancelled = false;
    window.api
      .invoke(COMMAND_CHANNELS.FILE_PANEL_READ_IMAGE, {
        sessionId,
        mdPath,
        src,
      })
      .then((res) => {
        if (cancelled) return;
        if ('dataUrl' in res) setUrl(res.dataUrl);
        else setErr(res.error);
      })
      .catch((error: unknown) => {
        if (!cancelled) setErr(error instanceof Error ? error.message : String(error));
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
