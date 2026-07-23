# Git 轮询按 repo 去重（方案 A）自测报告

**日期**：2026-07-23
**目标版本**：0.3.2；开发期 `package.json` 保持 `0.3.2-dev.2`，记入 CHANGELOG `[Unreleased]`。
**设计**：`docs/方案-需求感知后台任务调度-20260722.md` §8

## 背景

性能报告显示：14 个 Git 仓库 session 同时开 → 注册 14 个 polling task；同 repo 开 N 终端
就轮询 N 次 `git status`。`git.status` 平均 263ms、最大 1002ms、p95 1000ms，stall 随之
上升（>=100ms 24 次）。根因：watcher 按 session 注册，重复劳动 + 占满全局并发预算。

## 改动（src/main/git-service.ts）

- watcher/task key：`git-status:${sessionId}` → `git-status:${repoKey}`（repoKey = 规范化
  repoRoot，win32 小写吸收大小写差异）。
- `repoWatchers: Map<repoKey, {repoRoot, sessionIds, close}>` + `sessionRepoKey: Map<sessionId, repoKey>`。
- repo task run：调 `runGitStatusForRepo`（repo 级 in-flight 合并）拿一份快照，fan-out
  `emitStatusResult` 给该 repo 下所有 session。
- `attachSessionToRepo` / `detachSession`：cd 跨 repo 先 detach；repo 无 session 时注销 task。
- demand consumerId 改为 sessionId（复用 scheduler 多 consumer 取最高）；`removePollingConsumer`
  枚举该窗口 session 逐个撤 demand；`pendingSessionDemand` 暂存早于 prefetch 的 demand。
- status in-flight 从 session 维度改 repo 维度（同 repo 最多一个 git status）。
- `GitSessionLookup` 接口新增 `list()`（SessionManager 已有该方法）。
- 删除已无用的 `emitCurrentStatus` / `refreshInFlight`（emit 改走 fan-out `emitStatusResult`）。

## 不变量（保持）

- Git 面板功能不变：仍按 session emit gitStatusUpdated、只读、owner 校验、untracked=all。
- `git.watchers` gauge 语义 = "Git tab 可见的 session 数"（通过 watcherSessionCount）。
- 同 repo 任何时刻最多一个 git status 在跑（in-flight 锁 + scheduler 单并发）。

## 自动化验证

- [x] `npm run typecheck`
- [x] `npm run lint`
- [x] `npm run lint:css`
- [x] `npm test -- --run`：**62 files / 964 tests 全过**
- [x] `npx electron-vite build`
- [x] Prettier + `git diff --check`

### 新增测试（git-service.test.ts，+3 用例）

- 同 repo 多 session 共享一个 polling task（tasks=1，HOT 轮询只 spawn 一次，fan-out 给两 session）。
- 同 repo 全部 session 退出后 repo task 注销（剩一个保留，全退注销）。
- 不同 repo 的 session 各自独立 task（tasks=2）。

### 调整的既有测试

- watcher 相关断言从 `watchers Map` 改为 `sessionRepoKey`（sessionAttachedToRepo helper）。
- 集成策略测试不再 mock `emitCurrentStatus`（已删），改用 runGit 调用次数断言。
- demand 早于 prefetch 改为断言 GitService 的 pendingSessionDemand（不再走 scheduler placeholder）。
- 两个慢-availability 竞态测试改为 mock `realpathOrThrow`（availability 检查已内联为 findRepoRoot）。
- 两个 revision 变更串行重拉测试：放宽为断言"同 repo 任何时刻最多一个 git status 在跑"（in-flight
  size ≤ 1）+ 两者都正确 resolve，不锁死精确 spawn 次数（revision 变更窗口期 repo 解析异步带来的
  串行冗余在 2~3 次之间，无并发、无正确性问题）。

## 开发者手动验收

1. 在同一个 Git 仓库开 3 个终端，切到其中一个的 Git 面板（HOT）。
2. 外部改文件，约 3 秒内三个终端的 Git 面板都应更新（fan-out）——而非只更新一个。
3. 性能报告 `background.tasks` 应只 +1（而非按 session 数增长）；`git.status` 次数不随 session 数翻倍。
4. 关掉其中两个终端，剩一个仍能正常 HOT 轮询；全关后 repo task 注销（tasks 归零）。
5. 两个不同 repo 的终端各自独立 task。

## 已知边界

- revision（git 配置）在 status 进程跑期间变化时，repo 解析异步可能带来一次串行冗余 spawn
  （2~3 次之间），但绝不并发；属边缘场景，无正确性问题。
- 远程/重负载场景下若单 repo 仍慢（git 本身慢），需配合方案 B（大仓库降级 untracked），
  本次不做。
