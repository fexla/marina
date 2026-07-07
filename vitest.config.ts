/**
 * @file vitest.config.ts
 * @purpose Vitest 测试配置。后端 (src/main, src/shared) 走 Node 环境,
 *   不需要 jsdom。覆盖率门槛在 CI 中强化。
 *
 * @关键设计:
 * - 默认 environment: 'node' — main process 测试不需要 DOM
 * - include 默认限定 src/main / src/shared / src/preload;仅额外纳入 renderer store
 *   纯 reducer 测试,用于覆盖远程 owner 身份这类非 UI 状态机逻辑。
 * - alias 与 electron.vite.config.ts 保持一致,测试代码用同样的 import 风格
 *
 * @对应文档章节: AGENTS.md 第 5 章 (自动化测试要求)、软件定义书.md 5.2 节
 *
 * @覆盖率目标 (AGENTS.md 5.5):
 * - CP-2: 核心数据模块 > 70%
 * - CP-3: 状态机模块 > 80%
 * - CP-4: 整个 src/main/ > 75%
 */
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@main': resolve('src/main'),
    },
  },
  test: {
    environment: 'node',
    globals: false,
    include: [
      'src/main/**/*.{test,spec}.ts',
      'src/shared/**/*.{test,spec}.ts',
      'src/preload/**/*.{test,spec}.ts',
      'src/renderer/store.test.ts',
    ],
    exclude: ['node_modules', 'out', 'dist', 'release'],
    coverage: {
      provider: 'v8',
      include: ['src/main/**/*.ts', 'src/shared/**/*.ts'],
      exclude: [
        'src/main/**/*.test.ts',
        'src/main/**/*.spec.ts',
        'src/shared/**/*.test.ts',
        // 平台占位 (V1 不实测)
        'src/main/platform/macos.ts',
        'src/main/platform/linux.ts',
        // V1 阶段全是 throw "not implemented" 占位 (CP-3/4 实现后再测)
        'src/main/platform/windows.ts',
        // Wiring / 集成代码,按 AGENTS.md 5.4 不要求单测:
        // index.ts (Electron 入口装配) / ipc.ts (handler 仅做转发) /
        // tray.ts (Electron Tray API 强绑定)。CP-4 整体 src/main/ 75%
        // 目标会通过端到端测试覆盖。
        'src/main/index.ts',
        'src/main/ipc.ts',
        'src/main/tray.ts',
      ],
      reporter: ['text', 'html', 'json'],
    },
  },
});
