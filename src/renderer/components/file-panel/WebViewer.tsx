/**
 * @file src/renderer/components/file-panel/WebViewer.tsx
 * @purpose 以 sandbox iframe 渲染本地 HTML 文件(ADR-034,FileKind 'web')。
 *   archify 类 skill 的自包含交互产物(内联 SVG/JS、深浅主题、导出按钮)在
 *   面板内直接可看,不再外开浏览器。
 *
 * @关键设计:
 * - 预览内容不经 IPC:src 由 encodePathToWebFileUrl(file.path) 构造,内容由
 *   main 端 marina-file:// 特权协议流式服务(白名单/逐响应 CSP 见 ADR-034)。
 * - 热刷新零新代码:复用 fs.watch → evt:file-panel:updated 链。mtimeMs/size
 *   变化 → iframeSrc 的 ?v= 查询串变化 → key 变化强制重挂 → 整页重载。
 * - sandbox="allow-scripts allow-downloads":无 allow-same-origin(opaque
 *   origin,摸不到父页面 DOM/localStorage)、无 allow-popups/top-navigation/
 *   forms。allow-downloads 保住 archify 导出按钮(下载经 main 的
 *   will-download 存系统下载目录,evt:web:download-complete 弹 toast)。
 * - 源码查看模式:切到 TextViewer 复用(cmd:file-panel:read 对 web 文件返回
 *   kind:'text' 源码文本,见 file-panel-service.readFile)。
 *
 * @已接受降级(ADR-034 裁决,勿在此"修复"):
 * - Ctrl+F 面板内搜索不覆盖 iframe 内容(opaque origin 读不到子文档 DOM,
 *   与 ImageViewer 同款"不消费 search"降级);
 * - 滚动位置不持久化(iframe 内部滚动,父页面无感知),切面板回来从顶部开始;
 * - 深浅主题跟随 OS prefers-color-scheme,不跟 Marina 应用主题;
 * - 非同目录相对资源被协议层白名单拒绝(自包含契约)。
 *
 * @对应文档: ADR-034(软件定义书);docs/方案-已打开面板-HTML预览.md
 */
import { useMemo, useState } from 'react';
import { COMMAND_CHANNELS } from '@shared/protocol';
import { encodePathToWebFileUrl, MAX_WEB_SERVE_BYTES } from '@shared/web-file-url';
import type { OpenedFile } from '@shared/types';
import type { PanelSearchProps } from '../layout/panel-registry';
import { useTranslation } from '../LanguageProvider';
import { useToast } from '../Toast';
import { TextViewer } from './TextViewer';

interface WebViewerProps {
  sessionId: string;
  file: OpenedFile;
  /** dock 级搜索状态(C3)。web 预览不参与 iframe 内搜索(见头注降级清单);
   * 源码模式下透传给 TextViewer,搜索能力与文本查看器完全一致。 */
  search: PanelSearchProps;
}

/** 查看模式:预览(iframe 渲染)⇄ 源码(TextViewer)。 */
type WebViewMode = 'preview' | 'source';

export function WebViewer({ sessionId, file, search }: WebViewerProps): JSX.Element {
  const { tx } = useTranslation();
  const toast = useToast();
  const [mode, setMode] = useState<WebViewMode>('preview');
  // 手动"重新加载"计数器:并入 iframeSrc 的 key → src 变化强制重挂。
  const [reloadKey, setReloadKey] = useState(0);

  const iframeSrc = useMemo(() => {
    // ?v=mtimeMs-size:文件被覆盖写(fs.watch 防抖后刷新 OpenedFile)时查询串
    // 变化 → 重挂重载,即热刷新。Cache-Control:no-cache 下同 URL 也会回源。
    // &r=reloadKey:手动重载。两者都只做缓存击穿,不参与路径解析。
    const version = `${file.mtimeMs}-${file.size}`;
    return `${encodePathToWebFileUrl(file.path)}?v=${version}&r=${reloadKey}`;
  }, [file.path, file.mtimeMs, file.size, reloadKey]);

  const oversize = file.size > MAX_WEB_SERVE_BYTES;

  const openExternal = (): void => {
    window.api.invoke(COMMAND_CHANNELS.SYSTEM_OPEN_PATH, { path: file.path }).catch(
      (err: unknown) => {
        toast.push({
          kind: 'error',
          message: `${tx('打开失败', 'Open failed')}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      },
    );
  };

  // 源码模式:完全复用 TextViewer(它自己经 useFileContent 拉源码文本,web 文件
  // 的 read 响应固定是 kind:'text')。滚动/搜索/行号能力与文本查看器一致。
  if (mode === 'source') {
    return (
      <div className="file-web-viewer file-web-viewer-source">
        <WebViewerToolbar
          mode={mode}
          onToggleMode={() => setMode('preview')}
          onReload={undefined}
          onOpenExternal={openExternal}
          tx={tx}
        />
        <TextViewer sessionId={sessionId} file={file} search={search} />
      </div>
    );
  }

  return (
    <div className="file-web-viewer">
      <WebViewerToolbar
        mode={mode}
        onToggleMode={() => setMode('source')}
        onReload={() => setReloadKey((k) => k + 1)}
        onOpenExternal={openExternal}
        tx={tx}
      />
      {oversize ? (
        // 大小上限与 main 端协议层同源(MAX_WEB_SERVE_BYTES 单一真源);协议层
        // 也会拒(413),这里提前给可操作的占位而不是让 iframe 吃 413 白屏。
        <div className="file-web-viewer-oversize">
          <p>
            {tx(
              `文件过大(${formatSize(file.size)}),超过预览上限 ${formatSize(MAX_WEB_SERVE_BYTES)}`,
              `File too large (${formatSize(file.size)}), preview limit is ${formatSize(MAX_WEB_SERVE_BYTES)}`,
            )}
          </p>
          <button type="button" className="file-web-viewer-action" onClick={openExternal}>
            {tx('用浏览器打开', 'Open in browser')}
          </button>
        </div>
      ) : (
        // key=iframeSrc:src 变化(热刷新/手动重载)时整帧重挂,不走 iframe
        // 导航历史,保证 ?v= 每次都是干净加载。
        <iframe
          key={iframeSrc}
          src={iframeSrc}
          className="file-web-viewer-frame"
          title={file.name}
          sandbox="allow-scripts allow-downloads"
        />
      )}
    </div>
  );
}

/** 顶部窄工具条：源码⇄预览 / 重新加载 / 外部打开。切换钮恒定位首位
 * (预览与源码两种模式下标一致,UI 预期稳定);reload 仅预览模式提供。 */
function WebViewerToolbar({
  mode,
  onToggleMode,
  onReload,
  onOpenExternal,
  tx,
}: {
  mode: WebViewMode;
  onToggleMode: () => void;
  onReload: (() => void) | undefined;
  onOpenExternal: () => void;
  tx: (zh: string, en: string) => string;
}): JSX.Element {
  return (
    <div className="file-web-viewer-toolbar">
      <button
        type="button"
        className="file-web-viewer-tool"
        onClick={onToggleMode}
        title={tx('在预览与源码之间切换', 'Toggle between preview and source')}
      >
        {mode === 'preview'
          ? tx('查看源码', 'View source')
          : tx('返回预览', 'Back to preview')}
      </button>
      {onReload ? (
        <button
          type="button"
          className="file-web-viewer-tool"
          onClick={onReload}
          title={tx('重新加载', 'Reload')}
        >
          {tx('重新加载', 'Reload')}
        </button>
      ) : null}
      <button
        type="button"
        className="file-web-viewer-tool"
        onClick={onOpenExternal}
        title={tx('用系统默认浏览器打开', 'Open in default browser')}
      >
        {tx('浏览器打开', 'Open in browser')}
      </button>
    </div>
  );
}

/** 简洁字节量显示(工具条文案用,不做完整 i18n 数字格式)。 */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}
