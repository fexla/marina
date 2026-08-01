/**
 * @file src/renderer/components/file-panel/GalleryViewer.tsx
 * @purpose 渲染 ` ```gallery ` 代码块为图片幻灯片(一次一张 + 缩略图条 + 切换)。
 *
 * @关键设计(ADR-026):
 * - 主图自适应流式:按图片比例渲染,max-height 480px(超出按比例缩小),背景深色。
 * - 缩略图条 56px 单行横滚:当前项 foam 边框高亮,不限制数量。
 * - 网络图失败态:主图区占位 + 重试按钮 + 指示器 ⚠N 计数。超时由 main 端管(10s)。
 * - 懒加载 ±1:只对 current ± 1 发 IPC resolve;窗口外显示骨架,切近再拉。
 * - 点击主图 → GALLERY_OPEN_IMAGE(main resolve 路径后 shell.openPath 系统查看器)。
 * - 键盘 ←/→:仅 gallery 容器 focus/hover 时拦截(避免与终端、Ctrl+F 冲突)。
 *
 * @数据流:
 * parseGalleryCode(code) → items[]。每个 item 独立 resolve:本地图/网络图都走
 * GALLERY_RESOLVE_IMAGE(main 统一处理:本地图复用 read-image 安全面;网络图下载缓存)。
 * resolved Map<index, {dataUrl} | {error}> 缓存,失败可重试(清缓存重发)。
 *
 * @对应文档:docs/方案-图片表gallery-参数-20260802.md(ADR-026)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  COMMAND_CHANNELS,
  type GalleryResolveImagePayload,
  type GalleryResolveImageResponse,
} from '@shared/protocol';
import { parseGalleryCode } from '@shared/gallery-parser';
import { useTranslation } from '../../i18n';

/** 单张图的解析状态(懒加载 ±1 窗口内才 resolve)。 */
type ResolvedImage = { dataUrl: string } | { error: string } | null;
/** resolved 缓存:index → 解析结果(null=未加载,'loading' 阶段不出现在 map,用 set)。 */

interface GalleryViewerProps {
  sessionId: string;
  documentPath: string;
  /** 代码块原文(每行一个图片引用)。 */
  code: string;
  /** md 文件 mtimeMs:变化时重 resolve(防读到旧 dataUrl,与 MdImage 一致)。 */
  mtimeMs: number;
}

/** 主图区高度上限(px)。超出按比例缩小。 */
const MAIN_MAX_HEIGHT = 480;

export function GalleryViewer({
  sessionId,
  documentPath,
  code,
  mtimeMs,
}: GalleryViewerProps): JSX.Element {
  const { tx } = useTranslation();
  const items = useMemo(() => parseGalleryCode(code), [code]);
  const [current, setCurrent] = useState(0);
  // resolved:index → {dataUrl} | {error}。null/不在 map = 未加载(骨架)。
  const [resolved, setResolved] = useState<Map<number, ResolvedImage>>(new Map());
  // 正在加载的 index 集合(用于显示骨架 loading,与 resolved 区分)
  const [loading, setLoading] = useState<Set<number>>(new Set());
  // mtimeMs 变化时清缓存(防读到旧 dataUrl)。用 ref 存上次 mtimeMs 比较。
  const lastMtimeRef = useRef(mtimeMs);
  const containerRef = useRef<HTMLDivElement>(null);
  // 取消标志:组件卸载/切走时不让异步 setState
  const cancelledRef = useRef(false);

  // clamp current 到 items 范围(items 变化时,如 md 改了图列表)
  const safeCurrent = items.length === 0 ? 0 : Math.min(current, items.length - 1);

  /** 对单个 item 发 IPC resolve。幂等:已在 resolved/loading 里的不重发(除非 force)。 */
  const resolveItem = useCallback(
    (index: number, force = false) => {
      if (items.length === 0) return;
      if (index < 0 || index >= items.length) return;
      if (!force) {
        if (resolved.has(index) || loading.has(index)) return;
      }
      const item = items[index];
      if (!item) return;
      setLoading((prev) => {
        const next = new Set(prev);
        next.add(index);
        return next;
      });
      if (force) {
        // 重试:清旧结果
        setResolved((prev) => {
          if (!prev.has(index)) return prev;
          const next = new Map(prev);
          next.delete(index);
          return next;
        });
      }
      const payload: GalleryResolveImagePayload = {
        sessionId,
        mdPath: documentPath,
        src: item.src,
      };
      window.api
        .invoke<GalleryResolveImagePayload, GalleryResolveImageResponse>(
          COMMAND_CHANNELS.GALLERY_RESOLVE_IMAGE,
          payload,
        )
        .then((res) => {
          if (cancelledRef.current) return;
          setResolved((prev) => {
            const next = new Map(prev);
            next.set(index, 'dataUrl' in res ? { dataUrl: res.dataUrl } : { error: res.error });
            return next;
          });
        })
        .catch((e: unknown) => {
          if (cancelledRef.current) return;
          setResolved((prev) => {
            const next = new Map(prev);
            next.set(index, { error: e instanceof Error ? e.message : String(e) });
            return next;
          });
        })
        .finally(() => {
          if (cancelledRef.current) return;
          setLoading((prev) => {
            if (!prev.has(index)) return prev;
            const next = new Set(prev);
            next.delete(index);
            return next;
          });
        });
    },
    [items, resolved, loading, sessionId, documentPath],
  );

  // 懒加载 ±1:current 变化时 resolve current ± 1。已 resolve 的不重发(resolveItem 幂等)。
  useEffect(() => {
    cancelledRef.current = false;
    // mtimeMs 变化:整体清缓存(防读到旧 dataUrl),然后重新 resolve 窗口。
    if (lastMtimeRef.current !== mtimeMs) {
      lastMtimeRef.current = mtimeMs;
      setResolved(new Map());
      setLoading(new Set());
      // 清完缓存后下一帧再 resolve(让 state 更新生效)
      requestAnimationFrame(() => {
        if (cancelledRef.current) return;
        const lo = Math.max(0, safeCurrent - 1);
        const hi = Math.min(items.length - 1, safeCurrent + 1);
        for (let i = lo; i <= hi; i++) resolveItem(i);
      });
      return;
    }
    const lo = Math.max(0, safeCurrent - 1);
    const hi = Math.min(items.length - 1, safeCurrent + 1);
    for (let i = lo; i <= hi; i++) resolveItem(i);
    return () => {
      cancelledRef.current = true;
    };
    // resolveItem 是 useCallback,依赖 resolved/loading 会频繁重建 → 只在 current/items/mtimeMs 变化时跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safeCurrent, items, mtimeMs]);

  // 键盘 ←/→:仅容器 hover/focus 时拦截(避免与终端、Ctrl+F 冲突)
  const hoveredRef = useRef(false);
  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!hoveredRef.current) return;
      // 当前焦点在 input/textarea/contenteditable 时不拦截
      const ae = document.activeElement;
      if (
        ae &&
        (ae.tagName === 'INPUT' ||
          ae.tagName === 'TEXTAREA' ||
          (ae as HTMLElement).isContentEditable)
      )
        return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setCurrent((c) => Math.max(0, c - 1));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setCurrent((c) => Math.min(items.length - 1, c + 1));
      }
    },
    [items.length],
  );
  useEffect(() => {
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onKeyDown]);

  const failCount = useMemo(() => {
    let n = 0;
    for (const v of resolved.values()) if (v && 'error' in v) n++;
    return n;
  }, [resolved]);

  // 空块
  if (items.length === 0) {
    return (
      <div className="gallery-viewer gallery-empty">
        {tx('（空 gallery：每行一个图片链接）', '(empty gallery: one image link per line)')}
      </div>
    );
  }

  const go = (delta: number) =>
    setCurrent((c) => Math.max(0, Math.min(items.length - 1, c + delta)));

  const openCurrent = () => {
    const item = items[safeCurrent];
    if (!item) return;
    // fire-and-forget:系统查看器是否打开由 OS 决定,无需等结果
    void window.api.invoke(COMMAND_CHANNELS.GALLERY_OPEN_IMAGE, {
      sessionId,
      mdPath: documentPath,
      src: item.src,
    });
  };

  const currentItem = items[safeCurrent];
  const currentResolved = resolved.get(safeCurrent);
  const currentLoading = loading.has(safeCurrent);

  return (
    <div
      className="gallery-viewer"
      ref={containerRef}
      onMouseEnter={() => (hoveredRef.current = true)}
      onMouseLeave={() => (hoveredRef.current = false)}
      tabIndex={0}
    >
      <div className="gallery-stage" onClick={openCurrent} title={tx('点击用系统图片查看器打开', 'Click to open in system image viewer')}>
        <button
          className="gallery-nav gallery-prev"
          onClick={(e) => {
            e.stopPropagation();
            go(-1);
          }}
          disabled={safeCurrent === 0}
          aria-label={tx('上一张', 'Previous')}
        >
          ‹
        </button>
        {/* 主图渲染区 */}
        {currentResolved && 'dataUrl' in currentResolved ? (
          <img
            className="gallery-main-img"
            src={currentResolved.dataUrl}
            alt={currentItem.src}
            style={{ maxHeight: MAIN_MAX_HEIGHT }}
          />
        ) : currentResolved && 'error' in currentResolved ? (
          <div className="gallery-err">
            <span>⚠ {tx('加载失败', 'load failed')}</span>
            <button
              className="gallery-retry"
              onClick={(e) => {
                e.stopPropagation();
                resolveItem(safeCurrent, true);
              }}
            >
              {tx('重试', 'Retry')}
            </button>
          </div>
        ) : (
          <div className="gallery-skeleton">
            {currentLoading
              ? `${tx('加载中', 'loading')}…${
                  currentItem.kind === 'network' ? ` (${tx('网络图', 'network')})` : ''
                }`
              : '…'}
          </div>
        )}
        <button
          className="gallery-nav gallery-next"
          onClick={(e) => {
            e.stopPropagation();
            go(1);
          }}
          disabled={safeCurrent === items.length - 1}
          aria-label={tx('下一张', 'Next')}
        >
          ›
        </button>
        <div className="gallery-indicator">
          {safeCurrent + 1} / {items.length}
          {failCount > 0 ? ` · ⚠${failCount}` : ''}
        </div>
      </div>
      {/* 缩略图条:56px 单行横滚,当前高亮 */}
      <div className="gallery-thumbs">
        {items.map((item, i) => {
          const r = resolved.get(i);
          const isActive = i === safeCurrent;
          return (
            <button
              key={`${i}-${item.src}`}
              className={`gallery-thumb${isActive ? ' active' : ''}${
                r && 'error' in r ? ' err' : ''
              }`}
              onClick={() => setCurrent(i)}
              title={item.src}
              aria-label={`${tx('图', 'Image')} ${i + 1}`}
            >
              {r && 'dataUrl' in r ? (
                <img src={r.dataUrl} alt={item.src} />
              ) : r && 'error' in r ? (
                '⚠'
              ) : (
                <span className="gallery-thumb-idx">{i + 1}</span>
              )}
              {item.kind === 'network' ? <span className="gallery-thumb-net" title={tx('网络图', 'network')}>⇅</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
