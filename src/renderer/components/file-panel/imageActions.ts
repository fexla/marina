/**
 * @file src/renderer/components/file-panel/imageActions.ts
 * @purpose 图片交互动作 + 右键菜单统一生成器(v0.3.3 文档图片可交互)。
 *
 * @关键设计:
 * - 三个看图 surface(markdown 正文内联图 MdImage / 图片文件 ImageViewer /
 *   gallery 代码块 GalleryViewer)的"对这张图能做什么"收敛在这里:菜单形态
 *   一致,动作实现按 surface 注入 —— 与 fileListRowContextMenu.ts 的能力驱动
 *   模式同构(能力提供了才生成对应菜单项)。
 * - md 相对引用图(srcBase + src,ADR-036:文件 mdPath / 命令 commandKey)的
 *   open/reveal 共用 GALLERY_* 通道:main 端同一 resolver(成员校验或运行时
 *   cwd 基准 → 相对解析 → MIME/大小上限),绝对路径不回 renderer。ImageViewer
 *   自己持绝对路径(OpenedFile.path),走 SYSTEM_* 通道。
 * - 复制图片本体走 SYSTEM_CLIPBOARD_WRITE_IMAGE(local-control):dataUrl 由
 *   调用方从已加载的 <img> 传入,复制的就是看到的那一帧;远程 http 直链的
 *   src 不是位图数据,调用方不提供 copyImageDataUrl 能力即可(不生成该项)。
 *
 * @对应文档: 软件定义书 ADR-026(gallery 图片解析安全面);protocol.ts
 *   cmd:gallery:reveal-image / cmd:system:clipboard-write-image 注释。
 *
 * @不要在这里做的事:
 * - 不解析 md src 路径(那是 main 端 file-panel-service 的职责)。
 * - 不持有状态(纯函数 builder + fire-and-forget 动作,依赖经参数注入)。
 * - 不决定菜单何时弹出(由各 surface 的 onContextMenu 触发)。
 */
import { COMMAND_CHANNELS } from '@shared/protocol';
import { mdSrcBasePayload, type MdSrcBase } from './md-src-base';
import type { ContextMenuItem } from '../ContextMenu';
import type { ToastApi } from '../Toast';

/** i18n 双语(zh, en) → 当前语言文本;与 FileMenuDeps.tx 同签名。 */
export type ImageActionTx = (zh: string, en: string) => string;

/** markdown 相对引用图:main 端 resolve 后用系统图片查看器打开。
 * 失败(文件缺失/超限/非图片/owner 校验)toast 提示,成功静默 —— 与
 * GalleryViewer 既有的 openCurrent 行为一致(是否真的弹出由 OS 决定)。 */
export function openMarkdownImageExternally(args: {
  sessionId: string;
  /** 来源路径基准(文件 mdPath / 命令 commandKey,ADR-036)。 */
  srcBase: MdSrcBase | undefined;
  src: string;
  toast: ToastApi;
  tx: ImageActionTx;
}): void {
  const { sessionId, srcBase, src, toast, tx } = args;
  window.api
    .invoke(COMMAND_CHANNELS.GALLERY_OPEN_IMAGE, { sessionId, src, ...mdSrcBasePayload(srcBase) })
    .then((res) => {
      if ('error' in res) {
        toast.push({
          kind: 'error',
          message: `${tx('打开图片失败:', 'Open image failed: ')}${res.error}`,
        });
      }
    })
    .catch((err: unknown) => {
      toast.push({
        kind: 'error',
        message: `${tx('打开图片失败:', 'Open image failed: ')}${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    });
}

/** markdown 相对引用图:main 端 resolve 后在资源管理器中定位该文件。
 * 与 open 共用同一 resolver(本地图原路径;网络图下载缓存路径)。 */
export function revealMarkdownImageInExplorer(args: {
  sessionId: string;
  /** 来源路径基准(文件 mdPath / 命令 commandKey,ADR-036)。 */
  srcBase: MdSrcBase | undefined;
  src: string;
  toast: ToastApi;
  tx: ImageActionTx;
}): void {
  const { sessionId, srcBase, src, toast, tx } = args;
  window.api
    .invoke(COMMAND_CHANNELS.GALLERY_REVEAL_IMAGE, { sessionId, src, ...mdSrcBasePayload(srcBase) })
    .then((res) => {
      if ('error' in res) {
        toast.push({
          kind: 'error',
          message: `${tx('在资源管理器中显示失败:', 'Reveal in Explorer failed: ')}${res.error}`,
        });
      }
    })
    .catch((err: unknown) => {
      toast.push({
        kind: 'error',
        message: `${tx('在资源管理器中显示失败:', 'Reveal in Explorer failed: ')}${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    });
}

/** 复制图片本体(dataUrl → main nativeImage → clipboard.writeImage)。
 * 成功绿 toast / 失败红 toast,与 useCopyToClipboard 的反馈形态一致。 */
export function copyImageDataUrl(args: {
  dataUrl: string;
  toast: ToastApi;
  tx: ImageActionTx;
}): void {
  const { dataUrl, toast, tx } = args;
  window.api
    .invoke(COMMAND_CHANNELS.SYSTEM_CLIPBOARD_WRITE_IMAGE, { dataUrl })
    .then((res) => {
      if (res.ok) {
        toast.push({ kind: 'success', message: tx('已复制图片', 'Image copied') });
      } else {
        toast.push({
          kind: 'error',
          message: `${tx('复制图片失败:', 'Copy image failed: ')}${res.error ?? ''}`,
        });
      }
    })
    .catch((err: unknown) => {
      toast.push({
        kind: 'error',
        message: `${tx('复制图片失败:', 'Copy image failed: ')}${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    });
}

/**
 * 一个图片的"能力上下文"。除 open 外全部可选 —— 提供了才生成对应菜单项
 * (能力驱动,同 buildFileEntryMenu):远程 http 直链没有位图数据就不提供
 * copyImageDataUrl;无路径能力的来源(命令面板)由调用方根本不挂菜单。
 */
export interface ImageActionMenuContext {
  /** 用系统图片查看器打开(所有 surface 必备的主操作)。 */
  open: () => void;
  /** 在 Explorer / Finder 中显示该图片文件。 */
  reveal?: (() => void) | undefined;
  /** 复制图片本体;base64 dataUrl 可得才提供(远程直链 src 不是位图数据)。
   * 显式 undefined = 不提供(exactOptionalPropertyTypes 下的能力缺省写法)。 */
  copyImageDataUrl?: string | undefined;
}

export interface ImageActionMenuDeps {
  toast: ToastApi;
  tx: ImageActionTx;
}

/**
 * 生成图片右键菜单(纯函数)。
 *
 * @param ctx 图片能力上下文
 * @param deps toast / i18n 依赖
 * @returns ContextMenuItem[] —— 顺序:用系统图片查看器打开 → 复制图片 →
 *   在 Explorer 中显示(操作在前,定位在后,与文件条目菜单的分组节奏一致)
 */
export function buildImageActionMenu(
  ctx: ImageActionMenuContext,
  deps: ImageActionMenuDeps,
): ContextMenuItem[] {
  const { toast, tx } = deps;
  const items: ContextMenuItem[] = [
    {
      label: tx('用系统图片查看器打开', 'Open in system image viewer'),
      onSelect: ctx.open,
    },
  ];
  if (ctx.copyImageDataUrl) {
    const dataUrl = ctx.copyImageDataUrl;
    items.push({
      label: tx('复制图片', 'Copy image'),
      onSelect: () => copyImageDataUrl({ dataUrl, toast, tx }),
    });
  }
  if (ctx.reveal) {
    items.push({
      label: tx('在 Explorer 中显示', 'Reveal in Explorer'),
      onSelect: ctx.reveal,
    });
  }
  return items;
}
