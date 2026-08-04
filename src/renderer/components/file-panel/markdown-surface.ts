/**
 * @file src/renderer/components/file-panel/markdown-surface.ts
 * @purpose 统一把 Markdown 设置值映射成最终内容面 class。
 *
 * MarkdownViewer 用它渲染正文，FilePanel 用同一 class 在异步读取前探测背景色。
 * 两处必须同源，否则切文件 loading 首帧会预铺错误颜色并产生闪烁。
 */

/** 返回 Markdown 内容面的最终 class（内置、GitHub 或用户自定义主题）。 */
export function markdownSurfaceClass(markdownStyle: string): string {
  if (markdownStyle.startsWith('custom:')) return 'markdown-body md-custom';
  if (markdownStyle === 'github-light' || markdownStyle === 'github-dark') {
    return `markdown-body md-github-${markdownStyle === 'github-dark' ? 'dark' : 'light'}`;
  }
  return 'file-markdown-viewer';
}
