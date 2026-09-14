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
  // androidScheme 必须放在 server 对象下且显式 'http'(踩坑实录 ×2):
  // 1) Capacitor 7 默认 'https',WebView 页面以 https://localhost 提供,而
  //    daemon 连接是 ws://(ADR-015 纯 token,TLS 延后)——Chromium 混合内容
  //    策略禁止 https 页面发起 insecure WebSocket。
  // 2) androidScheme 是 CapacitorConfig.server 的字段,写在顶层会被静默忽略
  //    (类型宽松不报错),第一个「修复」因此无效。
  // 本地资产降为 http://localhost 无实际安全损失(资产打包在 APK 内,不经网络)。
  server: {
    androidScheme: 'http',
  },
};

export default config;
