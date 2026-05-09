/**
 * @file electron.vite.config.ts
 * @purpose electron-vite 主配置:为 main / preload / renderer 三个进程分别配
 *   置 Vite 构建。dev 时 Vite 提供 HMR,build 时输出到 out/。
 *
 * @关键设计:
 * - 三个 entry: src/main/index.ts, src/preload/index.ts, src/renderer/index.html
 * - 共享类型从 src/shared/ 引入,通过 @shared/* alias 暴露给三方
 * - main / preload 走 Node 环境(externalize node-pty 等原生模块)
 * - renderer 走浏览器环境(React + xterm.js)
 *
 * @对应文档章节: 软件定义书.md 第 9 章 (技术架构)、AGENTS.md 第 11 章 (工作流)
 *
 * @构建产物:
 * - out/main/index.js — Electron 主进程 entry,被 package.json "main" 字段引用
 * - out/preload/index.js — 预加载脚本
 * - out/renderer/ — 静态资源 + 入口 index.html
 */
import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main'),
      },
    },
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
      },
    },
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer'),
      },
    },
    build: {
      outDir: '../../out/renderer',
      emptyOutDir: true,
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') },
      },
    },
    server: {
      // 锁 IPv4,避免 Vite 默认 localhost 先解析到 IPv6 ::1 时
      // 撞 Windows IPv6 保留端口的 EACCES。
      host: '127.0.0.1',
      // 端口选择: Windows + Hyper-V/WinNAT 会保留大段动态端口范围
      // (开发者自查命令: `netsh interface ipv4 show excludedportrange protocol=tcp`)。
      // Vite 默认的 5173 在很多 Windows 11 机器上落在 5141-5340 保留段内,会抛 EACCES。
      // 5800 在常见保留段之外 (5341-5984 是非保留区间),也不和 VNC/WinRM 等常见服务冲突。
      // 若开发者机器仍命中保留段,可通过环境变量 EASYTERM_DEV_PORT 覆盖。
      port: Number(process.env.EASYTERM_DEV_PORT) || 5800,
      // EACCES 时 Vite 不会自动回退到下一个端口 (它只对 EADDRINUSE 这么做),
      // 所以 strictPort 没意义,关掉避免误导。真要换端口直接改上一行或 export EASYTERM_DEV_PORT。
      strictPort: false,
    },
  },
});
