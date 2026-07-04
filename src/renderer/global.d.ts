/**
 * @file src/renderer/global.d.ts
 * @purpose Renderer 端的全局类型补丁,声明 window.api (由 preload 注入)。
 *
 * @对应文档章节: docs/ipc-protocol.md 第 2 章
 */
import type { Api } from '../preload';

declare global {
  interface Window {
    api: Api;
  }

  /**
   * vite define 在 build 时注入 (electron.vite.config.ts)。
   * 关于页读取这两个值显示构建信息。
   */
  // eslint-disable-next-line @typescript-eslint/naming-convention, no-underscore-dangle
  const __MARINA_BUILD_COMMIT__: string;
  // eslint-disable-next-line @typescript-eslint/naming-convention, no-underscore-dangle
  const __MARINA_BUILD_TIME__: string;
}

/**
 * KBD-1 / SCROLL-1:React 18 的 HTMLAttributes 没有 `inert` — React 19 才
 * 把它做成 boolean prop。Electron 31(Chromium 126)原生支持 HTML 的
 * inert 属性,在 JSX 上以空字符串 / undefined 控制启停:
 *
 *   <div inert={shouldBlock ? '' : undefined} />
 *
 * 此处 module augmentation 让 TS 接受这个写法。
 */
declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface HTMLAttributes<T> {
    inert?: '' | undefined;
  }
}

export {};
