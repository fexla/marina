/**
 * @file remote-visibility.ts
 * @purpose 两种远程模式(SSH 远程 §14.1-14.8 / Marina 远程后端 §14.9)的
 *   UI 可见性统一判定 —— `hasAnyRemote`。
 *
 * @关键设计:
 * - 单一触发条件,所有"远程相关 UI"(sidebar segmented、设置页「远程」分类)
 *   共用,任何一处不许再写自己的条件(2026-08-03 v1.14 起,详见
 *   docs/方案-远程UI统一-20260803.md §III.4)。
 * - 四个输入对应四类"用户已涉足远程"的信号:
 *   1. hasSshProfiles   — 配过 SSH 服务器(ssh-profiles.json 非空)
 *   2. hasDaemonProfiles— 配过 Marina 电脑(remote-daemon-profiles.json 非空)
 *   3. enableRemote     — 显式勾选"始终显示远程入口"(settings.advanced.enableRemote)
 *   4. daemonRunning    — 本机"允许远程连接"服务在跑(必须有地方关掉它)
 * - 本地用户视野不变式(§14.2):四项全 false 时 UI 与 beta.9 100% 一致。
 *
 * @对应文档章节:软件定义书.md §14.2、§14.8、§14.9(远程后端)
 *
 * @不要在这里做的事:
 * - 不要加第五个信号(如"曾经配过")——保持四条件可穷举、可测
 * - 不要读 renderer 状态(本文件是纯函数,输入由调用方组装)
 */
export interface RemoteVisibilityInput {
  /** ssh-profiles.json 非空 */
  hasSshProfiles: boolean;
  /** remote-daemon-profiles.json 非空 */
  hasDaemonProfiles: boolean;
  /** settings.advanced.enableRemote === true(显式保留远程入口) */
  enableRemote: boolean;
  /** 本机"允许远程连接"服务运行中(remoteDaemonStatus.running) */
  daemonRunning: boolean;
}

/**
 * 远程相关 UI 是否可见。
 *
 * @param input 四路信号(见 RemoteVisibilityInput)
 * @returns true = 应显示远程入口(segmented / 设置「远程」分类)
 *
 * 注意:daemonRunning 是"服务端角色"信号 —— 服务在跑时必须能看到
 * 「允许远程连接」区块(用户需要入口关掉它),所以它也能撑起远程 UI。
 */
export function hasAnyRemote(input: RemoteVisibilityInput): boolean {
  return (
    input.hasSshProfiles || input.hasDaemonProfiles || input.enableRemote || input.daemonRunning
  );
}
