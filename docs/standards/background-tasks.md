# 昂贵周期后台任务规范

> 从 `AGENTS.md` 附录 I 迁出。对应 **ADR-021**(需求感知后台调度 BackgroundWorkScheduler)。
> 方案论述见 `docs/方案-需求感知后台任务调度-20260722.md`。
> **何时读**:新增/改任何会周期 spawn 子进程、扫仓库、做磁盘网络 I/O 的后台任务时。

## 规范正文


### I.1 哪些任务必须走 BackgroundWorkScheduler

会周期 spawn 子进程、扫描仓库/文件树、做明显磁盘或网络 I/O 的后台任务必须先评估
`BackgroundWorkScheduler`，不得在业务模块自行新增固定 `setInterval`。

不属于本规范：event-loop stall detector、Session idle timeout、持久化/fs.watch debounce
等语义 timer；它们不应因面板隐藏而改变语义。

### I.2 Demand 三层模型

| 等级 | 含义 | Git 基准策略 |
|---|---|---|
| HOT | 用户正在聚焦查看结果 | 立即运行；完成后 3 秒 |
| WARM | 当前工作态仍相关，但结果不可见/窗口失焦 | 完成后 60 秒 |
| NONE | 无消费者、切走 Session、owner 释放、零窗口 | 不运行、不保温 |

- 多 consumer 取最高等级；窗口关闭/远程断线必须 `removeConsumer`。
- renderer 只报告绝对 UI 状态；task key 和 consumerId 只能由 main/envelope 生成。
- demand 可以早于 task 注册；scheduler 必须保留有界 placeholder，不能丢首次 HOT。

### I.3 调度纪律

- 只能 recursive `setTimeout`：本次完成后再算下一次，禁止周期工作用 `setInterval`。
- 昂贵后台任务共享全局并发预算，默认 1；同 task 永不重叠。
- WARM/NONE 降级必须使已 queued 工作失效；unregister→同 key register 后旧 completion
  不能给新 generation 续排。
- WARM/COLD → HOT 必须立即刷新；HOT → WARM 必须取消旧短周期 timer。
- task/session/client/timer/queue 都必须有上限和显式清理路径，所有 timer `unref()`。
- 自动性能指标只能记录固定 aggregate，不得记录 task key/sessionId/clientId/path。

### I.4 Git 面板信号真值

`LayoutHost.PanelStack` 是当前 Session/面板真值源：Git tab 可见 + document visible +
窗口 focus + 当前 owner → HOT；仍显示该 Session 但其他面板/折叠/失焦 → WARM；
非 owner/unmount → NONE。命令 `cmd:git:set-polling-demand` 属于 backend-data，远程窗口
必须把 demand 发到 daemon。main 仍做 owner 校验，不能只信 renderer。

### I.5 Git 轮询按 repo 去重（方案 A，2026-07-23）

- Git polling task 按 **repo** 注册（`git-status:${repoKey}`），不按 session：同一 repo
  开 N 个终端只注册 1 个 task，run 时跑一次 git status 再 fan-out emit 给所有 session。
- 每个 session 作为 repo task 的一个 scheduler consumer（`consumerId=sessionId`），
  demand 由 scheduler 取最高（复用 I.2 多 consumer 模型）。
- status 拉取的 in-flight 合并也按 repo 维度：同 repo 任何时刻最多一个 git status。
- `removePollingConsumer(windowId)` 枚举该窗口持有的 session 逐个撤 demand（demand
  consumerId 是 sessionId，不是 windowId）；detach 后 repo 无 session 时注销 task。

### I.6 文件树轮询按 session（v0.3.4 修复：目录列表缓存无失效源）

- File tree polling task 按 **session** 注册（`file-tree:${sessionId}`），consumer 是
  窗口（`consumerId=windowId`）：展开目录集合是每个窗口文件面板的私有态。
- **只有 HOT/NONE 两档，没有 WARM**：需求是"只有处于前台的终端的文件面板需要
  刷新" —— LayoutHost 的 `useFileTreePollingDemand` 在面板可见 + 窗口聚焦时报
  HOT（3s），其余一律 NONE（Git 面板的 WARM 保温档不适用于文件树）。
- 轮询目标 = 各 consumer 上报的展开目录并集（`cmd:file-tree:set-watched-dirs`，
  面板展开集合变化时上报、卸载时发空数组）；每次 poll 走 FileTreeService.
  listDirectory（以 consumer 窗口为 requester，owner 校验逐请求重验）。
- 与 lastSnapshots 基线做 JSON diff，内容没变不广播 `evt:file-tree:changed`；
  首次 poll（基线缺失）视为变化，用于面板挂载时填缓存。
- exited session 拒绝新 demand 且任务被清（ADR-008 快照保留但不后台扫描）；
  owner 切换 / 窗口关闭 / 远程断线分别走 `onSessionOwnerChanged` /
  `removePollingConsumer`，与 Git 同构。

---
