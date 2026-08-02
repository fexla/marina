# 性能指标命名 / 隐私 / 开销规范

> 从 `AGENTS.md` 附录 H 迁出。对应 **ADR-020**(性能诊断子系统)。
> 方案论述见 `docs/方案-性能诊断-20260722.md`。
> **何时读**:动 performanceMetrics / 自动报告 / profile 时。隐私红线必须先看。

## 规范正文


### H.1 自动指标只能是固定低基数名称

- 统一用 `performanceMetrics`(`src/main/performance-metrics.ts`)。
- operation/counter/gauge 名只能由源码固定写死,如 `git.status`、`ipc.cmd:session:create`。
- **禁止**把 sessionId/windowId/路径/文件名/命令/URL 拼进 metric name。
- operation/counter/gauge name 各自硬上限 200（溢出并入固定 bucket）；新增模块应复用领域前缀，不得绕过 registry 自建 Map。

### H.2 自动报告隐私红线

自动 JSON/Markdown **禁止**记录:
- 文件/仓库/用户目录路径；
- shell 命令、环境变量、PTY 输入输出、scrollback；
- IPC payload/response；
- stack trace、函数源码 URL、窗口标题；
- sessionId/windowId 等可关联用户行为的标识。

只允许固定标签、进程类型和数值聚合。若新指标无法满足，先停下来评估，不得“先收集以后再脱敏”。

### H.3 深度 profile 必须显式确认

- `.cpuprofile` / trace 可能含函数名和本地源码路径，只能用户主动触发。
- UI 必须先提示隐私与采样开销；服务端必须限制时长/并发，每 run 最多保留 5 份。
- 禁止因检测到 stall 自动 profile，禁止把 profile 内容混入自动报告。

### H.4 开销纪律

- 不对逐字节/逐字符热函数做 duration timer；PTY 逐字节热路径只允许 O(1) counter（`pty.outputBytes`/`pty.outputChunks`）。**吞吐速率只在采样点从 counter delta 推导，零热路径开销**；sessionOutput dispatch 的 duration 只在 8ms 聚合点记录，非逐字节。
- timeline/ring/sample/report/run 数必须有硬上限。
- report 平时 5 分钟聚合写盘并做 in-flight 防重；>=1 秒严重 stall 可按 60 秒限频额外刷新，不能每事件写盘。
- main event-loop stall 只能按本义展示，不能称作 renderer FPS 或 Windows DPC 卡顿。
- throughput/backpressure 指标（bytes/s、突发窗口、dispatch 耗时、pendingEmit 峰值）只用纯数值 + 固定阈值，不含路径/sessionId/终端内容。

---
