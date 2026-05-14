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

export {};
