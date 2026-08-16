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
  useCallback,
  useEffect,
  useLayoutEffect,
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
import { COMMAND_CHANNELS, type FilePanelHeadingNavigationPayload } from '@shared/protocol';
import {
  createMarkdownHeadingIdFactory,
  resolveMarkdownHeadingTarget,
} from '@shared/markdown-heading';
import { isRemoteUrl } from '@shared/url-scheme';
import { getPanelUiState, setPanelUiState } from '@shared/panel-ui-cache';
import { readPanelPreference, writePanelPreference } from '@shared/panel-preferences';
import { useDomTextHighlight } from '../../hooks/useDomTextHighlight';
import { FILE_VIEWER_PROGRAMMATIC_NAVIGATION_EVENT } from '../../hooks/useFileViewerScroll';
import { useAppState } from '../../store';
import { Icon } from '../icons';
import { useTranslation } from '../LanguageProvider';
import type { PanelSearchProps } from '../layout/panel-registry';
import { useToast } from '../Toast';
import { GalleryViewer } from './GalleryViewer';
import { MarkdownCodeBlock, extractCodeBlockInfo } from './MarkdownCodeBlock';
import { remarkMarinaHeadingSections } from './markdown-heading-sections';
import { applyMarkdownRailPixelSnap } from './markdown-rail-pixel-snap';
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
  /** show --heading 产生的一次性 owner 定向请求；命令面板永远不传。 */
  headingNavigation?: FilePanelHeadingNavigationPayload;
  /** 请求无论命中与否都必须消费；found 同步交给父级滚动恢复仲裁。 */
  onHeadingNavigationHandled?: (requestId: string, found: boolean) => void;
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
  headingNavigation,
  onHeadingNavigationHandled,
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
  const appState = useAppState();
  const mdStyle = appState.settings.filePanel?.markdownStyle ?? 'auto';
  // 远程 sudo 只对 SSH session 的代码块有意义(本地 session 无 sudo 语义)。
  // 读一次 pathId 传给 MarkdownCodeBlock,避免每个代码块独立订阅 store。
  const sessionPathId = appState.sessions.get(sessionId)?.pathId ?? '';
  const allowSudo = sessionPathId.startsWith('ssh:');
  const { tx } = useTranslation();
  const toast = useToast();
  const handledNavigationRequestRef = useRef<string | null>(null);
  const handledNavigationCallbackRef = useRef(onHeadingNavigationHandled);
  handledNavigationCallbackRef.current = onHeadingNavigationHandled;
  const headingUiCacheKey = `markdown-headings:${documentIdentity}`;
  const [collapsedHeadingIds, setCollapsedHeadingIds] = useState<Set<string>>(
    () => new Set(getPanelUiState<string[]>(sessionId, headingUiCacheKey) ?? []),
  );
  const collapsedHeadingIdsRef = useRef(collapsedHeadingIds);
  collapsedHeadingIdsRef.current = collapsedHeadingIds;
  // 目录整体显示/隐藏（L2 偏好，跨文档）。可见态：缩略轨 + hover 浮动展开；
  // 隐藏态：只留右上角小按钮。旧键 markdownOutlineExpanded（缩略/自动展开两档）
  // 已废弃，新键默认 true。
  const [outlineVisible, setOutlineVisible] = useState(() =>
    readPanelPreference<boolean>('file-panel', 'markdownOutlineVisible', true),
  );

  /**
   * 同步提交 L1，而不是把 cache 写藏进 React state updater。否则用户点击 summary 后
   * 立即切面板时，组件可能先 unmount、updater 尚未执行，折叠工作态就会丢失。
   */
  const commitCollapsedHeadingIds = useCallback(
    (next: Set<string>): void => {
      collapsedHeadingIdsRef.current = next;
      setPanelUiState(sessionId, headingUiCacheKey, [...next]);
      setCollapsedHeadingIds(next);
    },
    [headingUiCacheKey, sessionId],
  );

  /** 折叠态唯一同步入口:details 的 toggle 事件(点击/键盘/程序改 open 都会
   * 触发)。同步提交 L1 而不是藏进 state updater,避免组件在 updater 执行前
   * 就 unmount 导致折叠工作态丢失。 */
  const setHeadingCollapsed = useCallback(
    (headingId: string, collapsed: boolean): void => {
      const previous = collapsedHeadingIdsRef.current;
      if (previous.has(headingId) === collapsed) return;
      const next = new Set(previous);
      if (collapsed) next.add(headingId);
      else next.delete(headingId);
      commitCollapsedHeadingIds(next);
    },
    [commitCollapsedHeadingIds],
  );

  /** 一键展开全部章节。深层嵌套折叠后的逃生门:轨道面板尾部按钮。 */
  const expandAllHeadings = useCallback((): void => {
    if (collapsedHeadingIdsRef.current.size === 0) return;
    commitCollapsedHeadingIds(new Set());
  }, [commitCollapsedHeadingIds]);

  /** 目录按钮是跨文档的显示偏好，写 L2；收起 = 隐藏整个目录，只留按钮本身。 */
  const toggleOutlineVisible = useCallback((): void => {
    setOutlineVisible((previous) => {
      const next = !previous;
      writePanelPreference('file-panel', 'markdownOutlineVisible', next);
      return next;
    });
  }, []);

  /**
   * 目标 heading 可能藏在自己或父级 details 内。先同步打开真实 DOM，再同步 L1，
   * 这样本次 scrollIntoView 已有正确布局，不等下一帧，也不会被 React 重新合上。
   */
  const expandHeadingSections = useCallback(
    (heading: HTMLElement): void => {
      const sections: HTMLDetailsElement[] = [];
      let section = heading.closest<HTMLDetailsElement>('details.markdown-heading-section');
      while (section) {
        sections.push(section);
        section =
          section.parentElement?.closest<HTMLDetailsElement>('details.markdown-heading-section') ??
          null;
      }
      const ids = sections
        .map((item) => item.dataset.markdownHeadingId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      if (ids.length === 0) return;
      for (const item of sections) item.open = true;
      const previous = collapsedHeadingIdsRef.current;
      if (!ids.some((id) => previous.has(id))) return;
      const next = new Set(previous);
      for (const id of ids) next.delete(id);
      commitCollapsedHeadingIds(next);
    },
    [commitCollapsedHeadingIds],
  );

  /**
   * 内页 #anchor 与外部可见标题最终都走同一个 DOM seam，确保 id、滚动恢复仲裁和
   * 折叠祖先展开逻辑不会分叉成两套。
   */
  const navigateToHeading = useCallback(
    (target: string, mode: 'id' | 'text'): boolean => {
      const root = containerRef.current;
      if (!root) return false;
      const headings = ensureMarkdownHeadingIds(root);
      const id =
        mode === 'id'
          ? target
          : resolveMarkdownHeadingTarget(
              headings.map((heading) => ({ id: heading.id, text: markdownHeadingText(heading) })),
              target,
            );
      if (!id) return false;
      const heading = headings.find((candidate) => candidate.id === id);
      if (!heading) return false;
      expandHeadingSections(heading);
      const scrollOwner = root.closest('.file-panel-body');
      scrollOwner?.dispatchEvent(new Event(FILE_VIEWER_PROGRAMMATIC_NAVIGATION_EVENT));
      heading.scrollIntoView({ block: 'start' });
      return true;
    },
    [containerRef, expandHeadingSections],
  );

  // 自定义 a/img/pre 组件。fileContext 的存在明确控制路径相关能力；
  // documentIdentity 则只给代码块缓存，二者不能混用。
  const components = useMemo<Components>(
    () => ({
      a: ({ node, ...props }) => {
        // react-markdown 的 AST node 不是 DOM attribute；必须在 spread 前剥离。
        void node;
        return (
          <MdLink
            {...props}
            sessionId={sessionId}
            mdPath={filePath}
            onNavigateAnchor={(id) => navigateToHeading(id, 'id')}
          />
        );
      },
      details: ({ node, ...props }) => {
        const headingId = readNodeStringProperty(node, 'data-markdown-heading-id');
        if (!headingId) return <details {...props} />;
        // open 从 ref 读取而不是解构 state:components 的身份必须跨折叠稳定。
        // react-markdown(v10)没有任何 memo,每次渲染都用 components 闭包作元素
        // type 重建元素树;闭包身份一变,React 就把整棵 markdown 子树(含目录轨
        // nav、代码块、图片)当换类型卸载重建 —— 轨道 scrollTop 清零重滚、CSS
        // 过渡复位,肉眼就是"左上角面板闪一下跳一下"。ref 读法让折叠只走原生
        // details toggle(同一 DOM 节点),React 重渲染时 prop 值与 DOM 实际态
        // 始终一致(点击折叠:原生先翻,渲染补同值;程序展开:expandHeadingSections
        // 先开 DOM 再提交 state,渲染补同值;重挂载:首渲染读到最新折叠集)。
        return (
          <details
            {...props}
            open={!collapsedHeadingIdsRef.current.has(headingId)}
            onToggle={(event) => {
              // 嵌套 H2 的 toggle 不应被 H1 handler 二次处理。
              if (event.target !== event.currentTarget) return;
              // toggle 是折叠态的唯一同步真值来源(见 summary onClick 注释):
              // 点击/键盘/程序赋值 open 都会到这里;而 React 只在 prop 值变化
              // 时才写 DOM,这里提交后重渲染写回的是同值,不会与原生行为打架。
              const nowCollapsed = !event.currentTarget.open;
              setHeadingCollapsed(headingId, nowCollapsed);
              // 折叠可能把视口里的内容整段收走:文档高度骤减后浏览器会把
              // scrollTop 钳到新的 maxScroll,视口跳到无关位置,而用户刚点的
              // 标题行却被留在视口外。折叠后若 summary 不在滚动容器视口内,
              // 把它补滚到视口顶——用户的注意力焦点就是他刚折叠的标题。
              // 展开(`nowCollapsed=false`)不需要:标题上方内容未变,summary
              // 的文档位置不变,不会因此移出视口。两帧 rAF 等折叠后的布局
              // 与滚动钳制都落地再测几何。
              if (nowCollapsed) {
                const section = event.currentTarget;
                requestAnimationFrame(() => {
                  requestAnimationFrame(() => {
                    if (!section.isConnected || section.open) return;
                    const summary = section.querySelector('summary');
                    const scrollOwner = section.closest<HTMLElement>('.file-panel-body');
                    if (!summary || !scrollOwner) return;
                    const summaryRect = summary.getBoundingClientRect();
                    const ownerRect = scrollOwner.getBoundingClientRect();
                    if (summaryRect.bottom < ownerRect.top || summaryRect.top > ownerRect.bottom) {
                      scrollOwner.dispatchEvent(
                        new Event(FILE_VIEWER_PROGRAMMATIC_NAVIGATION_EVENT),
                      );
                      summary.scrollIntoView({ block: 'start' });
                    }
                  });
                });
              }
            }}
          />
        );
      },
      summary: ({ node, children, ...props }) => {
        const headingId = readNodeStringProperty(node, 'data-markdown-heading-id');
        return (
          <summary
            {...props}
            onClick={(event) => {
              props.onClick?.(event);
              if (event.defaultPrevented || !headingId) return;
              // summary 的 click 除了选拦截之外什么都不做,尤其不能在这里预提交
              // 折叠状态:React 18 离散事件同步 flush,会在原生默认动作(切
              // details)执行前就把受控 open 写到 DOM,随后原生 toggle 再翻一
              // 次,两者互相抵消 → 点击毫无反应(旧实现靠组件重挂载掩盖了这
              // 个竞态)。折叠真值唯一来源是 details 的 toggle 事件:点击/键盘/
              // 程序改 open 都会触发它,且在用户能做下一个操作之前必达。
              //
              // 拖选/Shift 扩选/三击选段标题文字 = 复制意图,不是折叠意图:此时
              // click 的默认动作(切 details)必须吞掉,否则选完标题章节就合
              // 上了。原生 click 每次都 toggle:双击(第二击 detail=2)靠两次
              // 互相抵消回到原状;但三击的第三击(detail=3)会净折叠一次。
              //
              // 单击(detail=1):拖选/Shift 选区完整落在 summary 内才拦——跨进
              // 正文的拖选 click 落在共同祖先 details 上,根本不会进这个
              // handler,这里只需覆盖起点终点都在标题内的选区。
              //
              // 三击+(detail>=3):Chromium 的段落选择单位是整个 details 块,
              // 选区会跨进(甚至 display:none 的)折叠内容——不能拿"选区完整
              // 在 summary 内"当条件,改为看这次点击落点本身。三击后把选区
              // 收缩到标题元素内容:复制到的就是看到的标题,不带隐藏正文。
              if (event.detail === 1) {
                const selection = window.getSelection();
                const anchorNode = selection?.anchorNode ?? null;
                const focusNode = selection?.focusNode ?? null;
                if (
                  selection &&
                  !selection.isCollapsed &&
                  anchorNode !== null &&
                  focusNode !== null &&
                  event.currentTarget.contains(anchorNode) &&
                  event.currentTarget.contains(focusNode)
                ) {
                  event.preventDefault();
                }
              } else if (event.detail >= 3) {
                if (event.currentTarget.contains(event.target as Node | null)) {
                  event.preventDefault();
                  const heading = event.currentTarget.querySelector('h1,h2,h3,h4,h5,h6');
                  if (heading) {
                    const range = document.createRange();
                    range.selectNodeContents(heading);
                    const selection = window.getSelection();
                    selection?.removeAllRanges();
                    selection?.addRange(range);
                  }
                }
              }
            }}
          >
            <span className="markdown-heading-summary-chevron" aria-hidden="true">
              <Icon name="chevronRight" size={13} />
            </span>
            {children}
          </summary>
        );
      },
      nav: ({ node, children, ...props }) => {
        const isHeadingRail = readNodeStringProperty(node, 'data-marina-heading-rail') === 'true';
        if (!isHeadingRail) return <nav {...props}>{children}</nav>;
        // -expanded 在可见态恒挂：它是 hover/focus 浮动展开的 CSS 开关（不再有
        // "手动缩略模式"）。-hidden 收起整个目录，只保留小按钮。
        const railClass = `${props.className ?? ''}${
          outlineVisible ? ' markdown-heading-rail-expanded' : ' markdown-heading-rail-hidden'
        }`.trim();
        return (
          <nav {...props} className={railClass}>
            <button
              type="button"
              className="markdown-heading-rail-toggle"
              aria-expanded={outlineVisible}
              aria-label={
                outlineVisible
                  ? tx('收起 Markdown 目录', 'Collapse Markdown outline')
                  : tx('展开 Markdown 目录', 'Expand Markdown outline')
              }
              title={
                outlineVisible
                  ? tx('收起 Markdown 目录', 'Collapse Markdown outline')
                  : tx('展开 Markdown 目录', 'Expand Markdown outline')
              }
              onClick={toggleOutlineVisible}
            >
              <Icon name="chevronRight" size={13} />
            </button>
            <div className="markdown-heading-rail-items">
              {children}
              {/* 全部展开:深层折叠后的逃生门。只在存在折叠时渲染;折叠态经 ref
               * 读取(见 details 组件的稳定性注释),每次重渲染都会重读最新值。
                 静止窄轨里由 CSS 隐藏,仅 hover 展开面板时可见。 */}
              {collapsedHeadingIdsRef.current.size > 0 && (
                <button
                  type="button"
                  className="markdown-heading-rail-expand-all"
                  title={tx('展开全部折叠的章节', 'Expand all collapsed sections')}
                  onClick={expandAllHeadings}
                >
                  {tx('全部展开', 'Expand all')}
                </button>
              )}
            </div>
          </nav>
        );
      },
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
              allowSudo={allowSudo}
            />
          );
        }
        return <pre>{props.children}</pre>;
      },
    }),
    // 依赖里刻意没有 collapsedHeadingIds:details/summary 改读 ref,折叠不换
    // 组件身份、不 remount markdown 树(见 details 组件内注释)。折叠后的目录
    // 重算由 rail effect 的 toggle 捕获监听 + ResizeObserver 驱动,无需重建。
    // expandAllHeadings 是稳定的 useCallback([commitCollapsedHeadingIds]),
    // 而后者只随 sessionId/文档身份变化——不会破坏组件身份稳定。
    [
      allowSudo,
      documentIdentity,
      expandAllHeadings,
      fileMtimeMs,
      filePath,
      navigateToHeading,
      outlineVisible,
      sessionId,
      setHeadingCollapsed,
      toggleOutlineVisible,
      tx,
    ],
  );

  const remarkPlugins = useMemo(
    () => (filePath === undefined ? [remarkGfm] : [remarkGfm, remarkMarinaHeadingSections]),
    [filePath],
  );

  // CommonMark 严格模式会截断带空格的裸本地图片 URL。统一预处理保证文件来源
  // 与命令来源经过同一 parser；无 fileContext 时本地图片随后会安全显示占位。
  const normalizedText = useMemo(() => normalizeMdImageSources(markdown), [markdown]);

  // 每次正文变化后给 h1-h6 分配稳定且去重的真实 DOM id；命令面板也因此获得
  // 正确的内页 anchor，但目录/折叠能力仍由 fileContext gate，后续不会泄漏过去。
  useLayoutEffect(() => {
    if (containerRef.current) ensureMarkdownHeadingIds(containerRef.current);
  }, [containerRef, normalizedText]);

  /**
   * 点阵像素吸附:按实际 devicePixelRatio 把点/行距/胶囊几何取整到物理像素,
   * 写入 rail 的 custom properties(见 markdown-rail-pixel-snap.ts)。
   * 必须是 layout effect:首次绘制前就要生效,否则先闪一帧未对齐的旧几何。
   */
  useLayoutEffect(() => {
    const rail = containerRef.current?.querySelector<HTMLElement>('.markdown-heading-rail');
    if (!rail) return undefined;
    return applyMarkdownRailPixelSnap(rail);
  }, [containerRef, filePath, normalizedText]);

  /**
   * 文件目录的窄轨是当前位置指示器，不是第二套持久状态。滚动时直接标记对应 anchor，
   * 避免每跨过一个标题都让整棵 ReactMarkdown 重渲染；details 折叠和内容尺寸变化会
   * 重新计算可见标题。目录自身需要滚动时，只调整它自己的 scrollTop，绝不调用
   * scrollIntoView 与正文滚动争抢。
   */
  useLayoutEffect(() => {
    if (filePath === undefined) return undefined;
    const root = containerRef.current;
    const scrollOwner = root?.closest<HTMLElement>('.file-panel-body');
    const rail = root?.querySelector<HTMLElement>('.markdown-heading-rail');
    if (!root || !scrollOwner || !rail) return undefined;

    const links = Array.from(
      rail.querySelectorAll<HTMLAnchorElement>('.markdown-heading-rail-link'),
    );
    const entries = links
      .map((link) => {
        const id = link.dataset.markdownHeadingId;
        const heading = id ? root.querySelector<HTMLElement>(`#${CSS.escape(id)}`) : null;
        return id && heading ? { id, heading, link } : null;
      })
      .filter(
        (entry): entry is { id: string; heading: HTMLElement; link: HTMLAnchorElement } =>
          entry !== null,
      );
    if (entries.length === 0) return undefined;

    /* 聚焦裁剪(2026-08 用户需求):目录是“你在哪”的指示器,不是全文索引。
     * 规则(由用户三例归纳):一个标题可见 ⟺ 它在当前标题的祖先链上(含当前),
     * 或其父在链上(链上节点的直接子级全亮,含当前标题自己的子级),或它是顶层
     * 标题(父为根,永逖可见)。远处章节的深层条目对“定位自己”是噪音,收起。
     * 点阵轨与展开面板是同一批 DOM 条目的两种形态,裁剪同时作用于两者。 */
    const entryLevels = entries.map(
      (entry) => Number(entry.link.dataset.markdownHeadingLevel) || 1,
    );
    // parentIndex[i] = 文档序中 i 之前最近的、层级更浅的标题下标(无则为 -1,即顶层)。
    // 单调栈一次构建;entries 在本 effect 生命周期内不变,无需每次滚动重算。
    const parentIndex: number[] = [];
    const levelStack: number[] = [];
    for (let i = 0; i < entryLevels.length; i++) {
      const level = entryLevels[i] ?? 1;
      while (levelStack.length > 0) {
        const top = levelStack[levelStack.length - 1];
        if (top === undefined || (entryLevels[top] ?? 1) < level) break;
        levelStack.pop();
      }
      const parent = levelStack[levelStack.length - 1];
      parentIndex[i] = parent === undefined ? -1 : parent;
      levelStack.push(i);
    }
    const applyFocusPrune = (currentIndex: number): void => {
      const chain = new Set<number>();
      for (let i = currentIndex; i >= 0; ) {
        chain.add(i);
        const parent = parentIndex[i];
        i = parent === undefined || parent < 0 ? -1 : parent;
      }
      entries.forEach((entry, i) => {
        const parent = parentIndex[i] ?? -1;
        const inChain = chain.has(i);
        const childOfChain = parent >= 0 && chain.has(parent);
        // 顶层(parent === -1)永逖可见:当前在“2”下时,“1”仍需在场,
        // 否则跨章导航入口就没了。
        const pruned = !(inChain || childOfChain || parent === -1);
        // 写前先比:滚动每帧都过这里,同值重复写 dataset 会触发无谓的样式失效。
        if (pruned !== (entry.link.dataset.markdownHeadingPruned === 'true')) {
          if (pruned) entry.link.dataset.markdownHeadingPruned = 'true';
          else delete entry.link.dataset.markdownHeadingPruned;
        }
      });
      /* 分组节奏:深一层内容刚结束、回到浅层(或同级但前面出现过更深可见行)
       * 的条目前空半行。只看可见序列——隐藏结构不产生节奏,规则单一且稳定:
       * 父→首子紧贴(归属),叶子兄弟连续(同级列表),子树收尾空半行(范围关闭)。 */
      let prevVisibleLevel: number | null = null;
      entries.forEach((entry, i) => {
        const level = entryLevels[i] ?? 1;
        const pruned = entry.link.dataset.markdownHeadingPruned === 'true';
        if (pruned) {
          if (entry.link.dataset.markdownHeadingGroupStart !== undefined) {
            delete entry.link.dataset.markdownHeadingGroupStart;
          }
          return;
        }
        const groupStart = prevVisibleLevel !== null && prevVisibleLevel > level;
        if (groupStart !== (entry.link.dataset.markdownHeadingGroupStart === 'true')) {
          if (groupStart) entry.link.dataset.markdownHeadingGroupStart = 'true';
          else delete entry.link.dataset.markdownHeadingGroupStart;
        }
        prevVisibleLevel = level;
      });
    };

    let frame: number | null = null;

    const markCurrent = (currentId: string): void => {
      let currentLink: HTMLAnchorElement | null = null;
      for (const link of links) {
        const current = link.dataset.markdownHeadingId === currentId;
        if (current) {
          link.dataset.markdownHeadingCurrent = 'true';
          link.setAttribute('aria-current', 'location');
          currentLink = link;
        } else {
          delete link.dataset.markdownHeadingCurrent;
          link.removeAttribute('aria-current');
        }
      }

      const items = currentLink?.closest<HTMLElement>('.markdown-heading-rail-items');
      if (!currentLink || !items || items.scrollHeight <= items.clientHeight) return;
      const itemRect = currentLink.getBoundingClientRect();
      const itemsRect = items.getBoundingClientRect();
      if (itemRect.top < itemsRect.top) items.scrollTop -= itemsRect.top - itemRect.top;
      else if (itemRect.bottom > itemsRect.bottom) {
        items.scrollTop += itemRect.bottom - itemsRect.bottom;
      }
    };

    /**
     * 静止轨与展开面板共用同一 CSS max-height(高度恒等,收起不跳变)。
     * 目录条目超过这个高度时打上 data-markdown-heading-overflow,
     * CSS 才让轨道自身 overflow-y: auto(当前位置标记才能滚进视野);
     * 未溢出时保持 overflow: visible——手动模式的标题 tooltip(::after)
     * 要画到轨道外,一旦设了 overflow 就会被裁掉。
     */
    const syncOverflowFlag = (): void => {
      const items = rail.querySelector<HTMLElement>('.markdown-heading-rail-items');
      if (!items) return;
      if (items.scrollHeight > items.clientHeight + 1) {
        rail.dataset.markdownHeadingOverflow = 'true';
      } else {
        delete rail.dataset.markdownHeadingOverflow;
      }
    };

    const update = (): void => {
      frame = null;
      const visible = entries.filter((entry) => entry.heading.getClientRects().length > 0);
      if (visible.length === 0) return;
      const ownerRect = scrollOwner.getBoundingClientRect();
      const activationLine = ownerRect.top + Math.min(32, scrollOwner.clientHeight * 0.12);
      let current = visible[0];
      if (!current) return;
      for (const entry of visible) {
        if (entry.heading.getBoundingClientRect().top > activationLine) break;
        current = entry;
      }
      markCurrent(current.id);
      const currentIndex = entries.findIndex((entry) => entry.id === current.id);
      if (currentIndex >= 0) applyFocusPrune(currentIndex);
      syncOverflowFlag();
    };

    const scheduleUpdate = (): void => {
      if (frame !== null) return;
      frame = requestAnimationFrame(update);
    };

    update();
    scrollOwner.addEventListener('scroll', scheduleUpdate, { passive: true });
    rail.addEventListener('pointerenter', scheduleUpdate);
    rail.addEventListener('focusin', scheduleUpdate);
    root.addEventListener('toggle', scheduleUpdate, true);
    const resizeObserver = new ResizeObserver(scheduleUpdate);
    resizeObserver.observe(root);

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      scrollOwner.removeEventListener('scroll', scheduleUpdate);
      rail.removeEventListener('pointerenter', scheduleUpdate);
      rail.removeEventListener('focusin', scheduleUpdate);
      root.removeEventListener('toggle', scheduleUpdate, true);
      for (const link of links) {
        delete link.dataset.markdownHeadingCurrent;
        delete link.dataset.markdownHeadingPruned;
        delete link.dataset.markdownHeadingGroupStart;
        link.removeAttribute('aria-current');
      }
      delete rail.dataset.markdownHeadingOverflow;
    };
    // 依赖里没有 collapsedHeadingIds:折叠不再 remount 链接/标题 DOM,entries
    // 在整个挂载周期内持续有效;折叠引起的可见性变化由 root 上的 toggle 捕获
    // 监听和 ResizeObserver 重算,不必拆掉重建(重建会清空轨道 scrollTop)。
  }, [containerRef, filePath, normalizedText, outlineVisible]);

  // 外部标题请求只处理一次。使用 layout effect 保证文件激活后首帧就落到目标，且
  // 在 scrollIntoView 前显式取消 useFileViewerScroll 仍等待布局的旧位置恢复。
  useLayoutEffect(() => {
    if (!headingNavigation || handledNavigationRequestRef.current === headingNavigation.requestId) {
      return;
    }
    handledNavigationRequestRef.current = headingNavigation.requestId;
    const found = navigateToHeading(headingNavigation.heading, 'text');
    if (!found) {
      toast.push({
        kind: 'error',
        message: `${tx('未找到 Markdown 标题:', 'Markdown heading not found: ')}${headingNavigation.heading}`,
      });
    }
    handledNavigationCallbackRef.current?.(headingNavigation.requestId, found);
  }, [headingNavigation, navigateToHeading, toast, tx, normalizedText]);

  // Markdown 文件内查找：DOM 文本节点 + CSS Custom Highlight，不改 react-markdown DOM。
  useDomTextHighlight({
    sessionId,
    containerRef,
    query: search.query,
    caseSensitive: search.caseSensitive,
    active: search.visible,
    contentVersion: normalizedText,
    suppressAutoScroll: headingNavigation !== undefined,
  });

  return (
    <div className={markdownSurfaceClass(mdStyle)} ref={containerRef}>
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
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
  /** 已解码 anchor id 交给文档统一导航 seam。 */
  onNavigateAnchor: (id: string) => boolean;
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
function MdLink({
  href,
  children,
  sessionId,
  mdPath,
  onNavigateAnchor,
  ...anchorProps
}: MdLinkProps): JSX.Element {
  const { tx } = useTranslation();
  const toast = useToast();
  const handle = (event: React.MouseEvent<HTMLAnchorElement>): void => {
    if (!href) return;
    if (href.startsWith('#')) {
      event.preventDefault();
      let id = href.slice(1);
      try {
        id = decodeURIComponent(id);
      } catch {
        // 畸形 percent-encoding 保留原串；找不到目标时安全 no-op。
      }
      onNavigateAnchor(id);
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
    <a
      {...anchorProps}
      href={href}
      onClick={handle}
      target={isExternalLink(href ?? '') ? '_blank' : undefined}
      rel={isExternalLink(href ?? '') ? 'noopener noreferrer' : undefined}
    >
      {children}
    </a>
  );
}

/** 只有完整 http(s)/mailto scheme 才算外链；其余值保留给本地文件能力处理。 */
function isExternalLink(href: string): boolean {
  return /^(?:https?:|mailto:)/i.test(href);
}

/** 从 react-markdown HAST node 安全读取 data-*；不同 pipeline 版本可能保留两种 key。 */
function readNodeStringProperty(
  node: { properties?: Record<string, unknown> } | undefined,
  key: string,
): string | null {
  const properties = node?.properties;
  if (!properties) return null;
  const camelKey = key.replace(/-([a-z])/g, (_whole, letter: string) => letter.toUpperCase());
  const value = properties[key] ?? properties[camelKey];
  return typeof value === 'string' ? value : value === true ? 'true' : null;
}

/** AST 插件写入的 identity 文字是文件 Markdown 的真值；命令来源才回退 DOM 文本。 */
function markdownHeadingText(heading: HTMLElement): string {
  return heading.dataset.markdownHeadingText ?? heading.textContent ?? '';
}

/**
 * 给没有 AST identity 的标题补 id。已有 id 绝不覆盖，但仍推进同一 slugger，确保
 * 混合来源下后续 fallback 的重复后缀与文档顺序一致。
 */
function ensureMarkdownHeadingIds(root: HTMLElement): HTMLElement[] {
  const nextId = createMarkdownHeadingIdFactory();
  return Array.from(root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')).map((heading) => {
    const generatedId = nextId(markdownHeadingText(heading));
    if (!heading.id) heading.id = generatedId;
    return heading;
  });
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
