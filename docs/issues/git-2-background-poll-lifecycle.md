# Git-2：后台 status poller 与 Session 生命周期脱钩

**状态**：已修复（0.3.1，2026-07-22）  
**影响版本**：0.3.0、0.3.1-dev.1、0.3.1-dev.2  
**修复文件**：`src/main/git-service.ts`、`src/main/session-manager.ts`、`src/main/ipc.ts`

## 问题表现

Marina 长时间运行后，即使关闭全部窗口、终端程序已经自然退出，Windows 仍可能出现游戏掉帧和其他程序间歇卡顿。任务管理器中的 Marina 平均 CPU 不一定明显。

## 根因

Git 面板在 session cwd 位于仓库内时，会为每个 session 启动 3 秒一次的 `git status --porcelain=v2 -z --untracked-files=all` 轮询。

旧实现只在 `sessionDestroyed` 时停止 watcher，但 ADR-008 规定 PTY 自然退出只进入 `exited`，session 标签与 scrollback 无时限保留。因此：

1. 在 shell 内执行 `exit` 后 watcher 继续运行；
2. 关闭 BrowserWindow 只释放 owner，main 进程中的 watcher 不受影响；
3. 历史 exited session 越多，后台 `git.exe` 创建与仓库扫描越多；
4. interval 为 3 秒、git timeout 为 5 秒，慢仓库会重叠执行；
5. prefetch 含异步边界，退出事件可能先停掉“尚未创建”的 watcher，旧 Promise 完成后又把 watcher 复活。

短促的进程创建、磁盘扫描与 Defender 活动会恶化 frametime，但容易被任务管理器的平均 CPU 隐藏。

## 修复

- `sessionExited`：立即调用 `GitService.onSessionExited()` 停止 watcher；
- `sessionDestroyed`：继续保持幂等清理；
- cwd/Git availability true → false：仍调用 status 同步器，推 unavailable 并停止 watcher；
- `enableGitPanel` true → false：`setRuntimeConfig()` 同步停止全部 watcher；
- 每个 session 增加 poll in-flight guard，上轮未完成时跳过下一轮；
- `prefetchStatus()` 在异步操作完成后重新读取 session state；session 已 exited/destroyed 时禁止 `startWatcher()`；
- `startWatcher()` 自身再次校验 session 存在且非 exited，形成最后一道防线。

## 回归测试

`src/main/git-service.test.ts` 覆盖：

1. PTY exited 清 watcher；
2. session destroyed 清 watcher；
3. 禁用 Git 清全部 watcher；
4. cwd 离开仓库停止 watcher；
5. 慢 poll 不重叠；
6. 慢 prefetch 与 PTY exit 竞态不会复活 watcher。

`src/main/session-manager.test.ts` 覆盖 Git availability 每次 flip 都触发同步回调。

## 验证结果

```text
npm run typecheck       passed
npm test                57 files / 899 tests passed
npm run lint            passed
npm run lint:css        passed
prettier（本次涉及文件）passed
git diff --check        passed
```

## 后续

0.3.2 的性能诊断工具应增加：Git watcher 数、in-flight poll 数、每次 status 耗时、事件循环 stall 与 Electron 子进程指标。是否进一步做“同仓库多 session 共用一个 poller”与随机抖动，应以报告数据决定，而不是在 0.3.1 发布前扩大修复范围。
