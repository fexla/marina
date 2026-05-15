/**
 * @file src/main/platform/linux.ts
 * @purpose Linux 平台适配器占位。
 *
 * 本文件存在的目的:
 * 1. 提示未来贡献者 — 实现这里的所有方法即可在 Linux 跑通 Marina
 * 2. 让 src/main/platform/index.ts 的 import 路径稳定
 *
 * @关键参考点 (给贡献者):
 * - detectShells: 读 /etc/shells,过滤掉 nologin / false 这类伪 shell
 * - getProcessCwd: readlink /proc/<pid>/cwd (需要权限,正常用户对自己进程没问题)
 * - registerFileManagerIntegration: 各 DE 各做 (Nautilus / Dolphin / Thunar / ...),
 *   建议先支持 Nautilus 因为占用率最高
 * - setAutoStart: ~/.config/autostart/marina.desktop (XDG 标准)
 *
 * @对应文档章节: 软件定义书.md 12.2;CONTRIBUTING.md (待添加)
 *
 * @AGENTS.md 8.2: 不要"顺手"实现 Linux,V1 只 Windows。
 */
import type { PlatformAdapter, ShellInfo } from './index';

const NOT_IMPLEMENTED =
  '[LinuxAdapter] Linux support not implemented yet. ' +
  'Contributions welcome — see CONTRIBUTING.md.';

export class LinuxAdapter implements PlatformAdapter {
  async detectShells(): Promise<ShellInfo[]> {
    throw new Error(NOT_IMPLEMENTED);
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
    // Linux 一般不需要从注册表读 — 子进程会继承调用者(login shell)完整 env。
    // 直接返回 process.env.PATH 即可,BETA-001 的 Windows-only 痛点不存在。
    return process.env.PATH ?? '';
  }
}
