/**
 * @file src/main/platform/macos.ts
 * @purpose macOS 平台适配器占位。
 *
 * 本文件存在的目的:
 * 1. 提示未来贡献者 — 实现这里的所有方法即可在 macOS 跑通 Marina
 * 2. 让 src/main/platform/index.ts 的 import 路径稳定
 *
 * @关键参考点 (给贡献者):
 * - detectShells: zsh / bash / fish,读 /etc/shells 加 macOS 默认逻辑
 * - getProcessCwd: proc_pidinfo (#include <libproc.h>),需通过 ffi-napi 调用
 * - registerFileManagerIntegration: Finder Sync Extension (Swift 子项目)
 * - setAutoStart: Electron 的 app.setLoginItemSettings 已支持 macOS
 *
 * @对应文档章节: 软件定义书.md 12.2;CONTRIBUTING.md (待添加)
 *
 * @AGENTS.md 8.2: 不要"顺手"实现 macOS,V1 只 Windows。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DefaultBookmarkSeed, PlatformAdapter, ShellInfo } from './index';

const NOT_IMPLEMENTED =
  '[MacOSAdapter] macOS support not implemented yet. ' +
  'Contributions welcome — see CONTRIBUTING.md.';

export class MacOSAdapter implements PlatformAdapter {
  /** 软件定义书 12.2 (v1.6) — macOS 留在 Dock,Electron darwin 默认即此行为 */
  readonly lifecycleModel = 'dock-resident' as const;

  async detectShells(): Promise<ShellInfo[]> {
    throw new Error(NOT_IMPLEMENTED);
  }
  resolveExecutable(commandName: string): string | null {
    if (!commandName.trim()) return null;
    if (commandName.startsWith('/')) return commandName;
    return commandName;
  }
  buildShellLaunchParams(): { args: string[]; env: Record<string, string> } {
    throw new Error(NOT_IMPLEMENTED);
  }
  async registerFileManagerIntegration(): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async unregisterFileManagerIntegration(): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async getProcessCwd(): Promise<string | null> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async setAutoStart(): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async isAutoStartEnabled(): Promise<boolean> {
    throw new Error(NOT_IMPLEMENTED);
  }
  getRefreshedPath(): string {
    // macOS 子进程从 launchd / login shell 继承 env;BETA-001 的 Windows-only
    // 注册表广播痛点不存在,直接返回 process.env.PATH。
    return process.env.PATH ?? '';
  }
  normalizeSpawnEnv(env: Record<string, string>): Record<string, string> {
    // BETA-ENV-1:macOS 上 env 由 launchd / login shell 提供,
    // %SystemRoot% 这种 Win32 占位符不存在,接口纯走 no-op。
    return env;
  }
  getDefaultBookmarkSeeds(): DefaultBookmarkSeed[] {
    const home = homedir();
    return [
      { label: '桌面', path: join(home, 'Desktop') },
      { label: '主目录', path: home },
    ];
  }
  getSshControlPath(): string {
    return '~/.ssh/cm-%r@%h:%p';
  }
}
