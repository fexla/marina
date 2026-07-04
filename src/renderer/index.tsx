/**
 * @file src/renderer/index.tsx
 * @purpose Renderer 进程 entry。挂载 React 根组件到 #root。
 *
 * @关键设计:
 * - 故意不用 React.StrictMode (CP-1 起不挂):
 *   StrictMode 在 dev 模式会双挂载组件来"压力测试 effect cleanup",
 *   而 xterm.js + node-pty 这种持有 native 资源的库在双挂载下会:
 *     (1) 触发 xterm 内部 Viewport.syncScrollArea 访问已释放的
 *         _renderService.dimensions, 抛 "Cannot read 'dimensions'"
 *     (2) PTY 反复 kill/spawn,期间 send-input 可能命中 SessionNotFound
 *   这是 xterm 与 StrictMode 的已知不兼容 (Wave/Hyper 等同样关掉)。
 *   生产环境 (build) 下 StrictMode 本就不生效,关掉只影响 dev 的"压测"。
 *   AGENTS.md 13.2 没把 StrictMode 列为产品哲学红线,可关。
 *
 * - 通过 window.api (preload 暴露) 与 main 通信,renderer 内部不能直接
 *   require electron。
 *
 * @对应文档章节: 软件定义书.md 9.2.2
 */
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/global.css';
// GitHub 风格 markdown 样式(用户在设置选 github-light/dark 时启用)。
// 全局加载但默认 auto 不消耗其视觉;切风格零延迟。明暗由 MarkdownViewer 的
// color-scheme 控制,不跟随系统。
import 'github-markdown-css/github-markdown.css';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error(
    '[renderer] #root element missing in index.html — ' +
      'Vite did not load the HTML correctly or the template was modified.',
  );
}

createRoot(rootEl).render(<App />);
