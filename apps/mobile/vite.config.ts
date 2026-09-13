/**
 * @file apps/mobile/vite.config.ts
 * @purpose Android WebView 壳的 web 构建配置(ADR-042)。
 *
 * @关键设计:
 * - 复用根仓库的 renderer 源码:本配置的 root 是 apps/mobile/src,但模块经
 *   alias @renderer / @shared 指向 ../../src/renderer 与 ../../src/shared,
 *   与 electron.vite.config.ts 的 alias 保持同名 —— renderer 源码里的
 *   `@shared/xxx` import 在两个构建里都解析到同一份文件。
 * - 运行时依赖(react / @xterm/* / lucide-react / github-markdown-css)不在本
 *   package.json 声明:npm 沿目录树向上解析,命中仓库根 node_modules —— 两端
 *   构建永远用同一版本,不会漂移。本包只额外装 Capacitor 三件套。
 * - __MARINA_BUILD_*__ define 与 electron-vite 同名,renderer 关于页直接可用。
 *
 * @不要在这里做的事:
 * - 不要加 electron 相关插件/define(renderer 源码本身零 electron 依赖,
 *   保持这个不变式是 Android 端存在的前提)
 * - 不要改 outDir(Capacitor capacitor.config.ts 的 webDir 指向 dist)
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

function gitCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: repoRoot }).toString().trim();
  } catch {
    return 'unknown';
  }
}

export default defineConfig({
  root: resolve(here, 'src'),
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(repoRoot, 'src/shared'),
      '@renderer': resolve(repoRoot, 'src/renderer'),
    },
  },
  define: {
    __MARINA_BUILD_COMMIT__: JSON.stringify(gitCommit()),
    __MARINA_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  build: {
    outDir: resolve(here, 'dist'),
    emptyOutDir: true,
    // 终端字节流场景 chunk 拆太细反而多请求,中等粒度即可
    chunkSizeWarningLimit: 1500,
  },
});
