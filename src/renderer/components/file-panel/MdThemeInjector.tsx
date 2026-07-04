/**
 * @file src/renderer/components/file-panel/MdThemeInjector.tsx
 * @purpose 把用户选中的自定义 markdown 主题(自定义 .css)注入成一个 <style>。
 *
 * @为什么这样加载 CSS:
 * CSP(prod)是 `style-src 'self' 'unsafe-inline'`,允许 renderer 注入内联 <style>,
 * 但禁 file:// link 和未注册的自定义协议。所以 main 端读 CSS 文本 → IPC → 这里
 * 写进 document.head 的一个固定 <style id=md-custom-theme>。零协议改动、CSP 不动。
 *
 * @作用域:
 * 用户 CSS 约定写 `.markdown-body` 选择器(与 github-markdown-css / react-markdown
 * 容器一致)。MarkdownViewer 选 custom 主题时容器挂 markdown-body md-custom,本注入器
 * 不加前缀(保持简单,信任用户),由 README 说明写法。
 *
 * @何时重拉:
 * 依赖 [markdownStyle] —— 切主题 / 切走再切回都会重拉。自定义主题的 CSS 文件被
 * 改内容不会触发 list 更新(id/name/fileName 没变),故首版"切走再切回"才看到改色;
 * 未来可加 evt:md-theme:css-changed 做热生效。
 *
 * 不渲染 UI(返回 null),纯副作用组件,挂在 App 顶层全局生效。
 */
import { useEffect } from 'react';
import { COMMAND_CHANNELS, type GetMdThemeCssResponse } from '@shared/protocol';
import { useAppState } from '../../store';

const STYLE_ID = 'md-custom-theme';

export function MdThemeInjector(): null {
  const markdownStyle = useAppState().settings.filePanel?.markdownStyle ?? 'auto';
  const isCustom = markdownStyle.startsWith('custom:');

  useEffect(() => {
    const styleEl = ensureStyleEl();
    if (!isCustom) {
      // 内置主题(auto/github-*):清掉上次注入的自定义 CSS,避免串色。
      styleEl.textContent = '';
      return;
    }
    let cancelled = false;
    void window.api
      .invoke<{ id: string }, GetMdThemeCssResponse>(COMMAND_CHANNELS.MD_THEME_GET_CSS, {
        id: markdownStyle,
      })
      .then(({ css }) => {
        if (cancelled) return;
        // css='' = 主题文件刚被删(main 端反查不到),清空 → 容器只剩 .markdown-body
        // 默认样式,不会崩;用户在设置里会看到该选项已消失,自然 fallback。
        styleEl.textContent = css;
      })
      .catch((err: unknown) => {
        console.warn('[md-theme] get-css failed', err);
        if (!cancelled) styleEl.textContent = '';
      });
    return () => {
      cancelled = true;
    };
  }, [markdownStyle, isCustom]);

  return null;
}

/** 懒创建固定 id 的 <style>,后续复用同一个 element 改 textContent。 */
function ensureStyleEl(): HTMLStyleElement {
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  return el;
}
