# ADR-021 需求感知后台任务调度自测报告

**日期**：2026-07-22  
**目标版本**：0.3.2；当前 `package.json` / `package-lock.json` 保持 `0.3.1`，变更记入 `[Unreleased]`。  
**设计**：`docs/方案-需求感知后台任务调度-20260722.md`

## 实现范围

- 新增 main `BackgroundWorkScheduler`：recursive timeout、HOT/WARM/NONE、多 consumer 最高等级、全局并发 1、pre-registration demand、物理有界 FIFO Set、record identity/generation 防 ABA。
- Git status 迁移：
  - HOT：当前 owner、Git 面板可见、窗口聚焦，立即刷新，完成后 3 秒；
  - WARM：当前 Session 的其他面板、dock 折叠或窗口失焦，60 秒；
  - NONE：切换 Session、非 owner、unmount、窗口关闭/断线、退出/离仓/禁用，停止。
- `prefetchStatus` 只同步 availability 和注册 COLD task，不在无 UI demand 时 spawn。
- GitPanel mount、HOT immediate、同 cwd 配置变化共享 in-flight；旧进程成功或失败后都先结束，再按新 revision 串行重拉。
- `cmd:git:set-polling-demand` 使用可信 envelope consumerId，保持 backend-data，兼容远程 daemon。
- 本地窗口关闭、远程 WS 断线/stop/restart、owner change 和 Session 生命周期统一清理 demand。
- App 根层常驻 Git cache bridge：GitPanel 卸载时仍接收 WARM 更新；Session 销毁清 cache。

## 自动化验证

- [x] `npm run typecheck`
- [x] `npm run lint`
- [x] `npm run lint:css`
- [x] `npm test -- --run`：**60 files / 943 tests 全部通过**
- [x] `npx electron-vite build`
- [x] 涉及文件 Prettier 检查
- [x] `git diff --check`

### 新增/强化覆盖

- Scheduler：HOT 立即+3秒、WARM 60秒、NONE 停止、任务不重叠、全局并发 1、多 consumer、提前 demand、拒绝隔离、shutdown。
- Queue：阻塞期间 500 次 HOT↔WARM 后物理 Set 仍只有一项；queued 降级与同 key 重注册旧 completion 均失效。
- Git：owner 校验、提前 HOT+注册竞态、非仓库 placeholder 清理、owner 清理、disable/exit/cd-out epoch、COLD 无 spawn。
- Coalescing：mount + HOT 同 cwd 只 spawn 一次；配置 revision 变化时旧 status 成功/失败都串行重拉，不并发。
- IPC：demand 只取 envelope.windowId；owner change/window close lifecycle wiring。
- Transport：正常断线及 `WsServer.stop()` 强制断线都触发 disconnected cleanup。
- Protocol：Git demand 明确保持 backend-data。

## 隔离 Electron runtime smoke

使用临时 `--user-data-dir` 和真实 production build；创建 cwd 为本项目 Git 仓库的 Session，不触碰真实 Marina 用户数据：

1. 聚焦窗口并切换到 Git 面板；
2. 立即刷新性能报告；
3. 切换到“文件”面板；
4. 再次刷新报告；
5. 关闭全部窗口并正常 `app.quit()`；
6. 读取临时报告后删除自建临时目录。

结果：

- [x] Git tab 存在；
- [x] Git 可见时 `background.hotTasks = 1`；
- [x] 切到“文件”后 `background.warmTasks = 1`、`background.hotTasks = 0`；
- [x] 正常退出 code 0；
- [x] 最终报告 `finalized:true`、`background.tasks = 0`；
- [x] 报告不包含临时 userData 绝对路径。

## 开发者手动验收

1. 在 Git 仓库 Session 打开 Git 面板，观察性能报告：应为 HOT；外部修改文件应在约 3 秒内更新。
2. 切到“文件”或“已打开”，报告应为 WARM；Git task 不再每 3 秒运行。
3. 切换到另一个 Session 或关闭全部窗口，旧 Session task 应为 NONE/停止。
4. 切回 Git 面板：缓存先显示，随后立即刷新，不等待 60 秒。
5. 打开两个窗口：仅当前聚焦且可见 Git 面板为 HOT；昂贵后台 task 同时最多运行一个。
6. 若使用远程 backend，断开客户端后 daemon 应立即撤 demand；重连/重新进入 Git 后恢复。

## 已知边界

- 已经启动的 `git.exe` 不强杀，继续受既有 5 秒 timeout；降级只阻止后续调度。
- 用户交互 `get-status` 不排进后台 FIFO，但与同 Session 自动 status 合并；不同 Session 的显式用户请求可并发。
- 本期不做同 repo 多 Session 合并；后续根据性能报告再决定。
