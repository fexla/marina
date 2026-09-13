import type { CapacitorConfig } from '@capacitor/cli';

/**
 * @file apps/mobile/capacitor.config.ts
 * @purpose Capacitor Android 壳配置(ADR-042)。
 *
 * @关键设计:
 * - webDir 指向 vite build 产物 dist/(`npm run build:web`)。
 * - server.allowNavigation 清单为空时 Capacitor 只允许导航到 app 内资产;
 *   Marina 不嵌任何外部网页(§14.6 面板不是浏览器),保持默认拒绝。
 * - androidScheme 默认 https(WebView 内以 https://localhost servir 本地资产),
 *   与 ws:// 的 daemon 连接无 CSP 冲突(WebView 无 Electron 的 CSP 注入)。
 */
const config: CapacitorConfig = {
  appId: 'so.marina.app',
  appName: 'Marina',
  webDir: 'dist',
};

export default config;
