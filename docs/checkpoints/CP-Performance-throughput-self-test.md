# 0.3.2-dev.1 + PTY 吞吐/背压增强 自测报告

**日期**：2026-07-23
**目标版本**：0.3.2；开发期间 `package.json` 保持 `0.3.2-dev.1`，本批增强记入 CHANGELOG `[Unreleased]`。
**设计**：`docs/方案-性能诊断-20260722.md`（2026-07-23 增补 PTY 吞吐/背压与分析工具段）

## 背景

开发者实测 0.3.2-dev.1 portable 65 分钟（4 session，255 MiB PTY 输出）后反馈：本次负载太轻不足以说明远程场景，且"网络多的情况"（PTY 高吞吐）希望把**记录工具**和**分析工具**完善——对远程 SSH（远程编译、tail 日志、cat 大文件）这个量级偏大，现有报告只有总量，刻画不了吞吐压力和背压。

## 本次增强范围

### 1. PTY 吞吐速率（记录，零热路径开销）

- 每 10s 采样窗口从 `pty.outputBytes`/`pty.outputChunks` counter delta 推导 bytes/s、chunks/s。PTY 逐字节热路径只做 O(1) `increment`，速率计算全在采样点。
- summary 新增：`peakPtyBytesPerSecond`、`peakPtyChunksPerSecond`、`ptyBurstWindows`（单窗口速率 ≥ 固定阈值 1 MiB/s 的次数）。
- 每采样写入 `pty.recentBytesPerSecond` gauge，供 stall 关联。

### 2. 背压信号（记录）

- `sessionOutput` IPC 发送（renderer 终端字节流通道）记为 operation `pty.sessionOutputDispatch`：begin/finish 在 8ms 聚合点（非逐字节），低开销。
  - **作用一**：测 IPC 发送耗时——renderer（xterm 解析/GC）跟不上时该同步调用变慢，duration 上升即背压。
  - **作用二**：stall 的 `activeOperations` 会显示它——此前 stall 全标"活跃操作:无"，现在若 stall 时正在 dispatch 即可关联。
- 8ms 合并窗口吸收字节峰值 gauge `pty.peakPendingEmitBytes`（远端 8ms 内一次刷出大量字节 = 单次 IPC payload 重）。

### 3. stall ↔ 流量相关性（记录）

- stall 记录新增 `ptyBytesPerSecond`（近窗口速率）。Markdown stall 表新增"近 PTY 速率"列。
- 现在能区分：stall 是否伴随流量突发/活跃操作（背压引起）vs 无关系统抖动。

### 4. 报告 Markdown（呈现）

- 新增"## PTY 数据吞吐与背压"段：总输出、全程平均速率、单窗口峰值（+突发次数）、8ms 吸收峰值、sessionOutput dispatch 统计。
- summary 健康摘要新增 PTY 吞吐峰值行。

### 5. 独立分析工具 `scripts/analyze-performance-report.mjs`

- 传报告 JSON 路径（或省略自动找最新）输出六维诊断：吞吐健康 / 背压事件 / stall↔流量相关性 / 瓶颈定位 / 内存健康 / 隐私自检。
- 纯 Node 内置模块，零新依赖；对旧版报告（无新字段）优雅降级显示 0/n-a。

## 自动化验证

- [x] `npm run typecheck`
- [x] `npm run lint`
- [x] `npm run lint:css`
- [x] `npm test -- --run`：**60 files / 948 tests 全部通过**
- [x] `npx electron-vite build`
- [x] 涉及文件 Prettier
- [x] `git diff --check`

### 新增测试

- `performance-diagnostics.test.ts`：counter delta 推导速率、突发窗口计数与 peak、stall 携带近窗口速率、Markdown 含吞吐/背压段（共 +4 用例）。
- `performance-metrics.test.ts`：`getGauge` 读取语义（+1 用例）。

### 分析工具 smoke

对开发者实测 65 分钟报告运行 `node scripts/analyze-performance-report.mjs <report.json>`：六维诊断输出正常，瓶颈定位 `background.taskRun`（git.status 48 次，全部走调度器）、隐私自检通过（旧报告无新字段，吞吐段显示 0/n-a 不崩溃）。

## 设计正确性要点

- **schema 向后兼容**：schemaVersion 保持 1；新增字段（`ptyBytesPerSecond`、`peakPtyBytesPerSecond`、`ptyBurstWindows`、stall.ptyBytesPerSecond）均新增可选字段，旧 reader 忽略。分析工具对缺字段优雅降级。
- **低开销**：PTY 逐字节只 `increment`（既有）；速率在采样点算；dispatch duration 在聚合点；pendingEmit gauge 是单次 `>` 比较。无逐字节 timer。
- **隐私**：吞吐/背压指标全是纯数值 + 固定阈值/名称，不含 sessionId/路径/命令/终端内容。`pty.sessionOutputDispatch` 只记 count/duration/error，不记 payload。

## 开发者手动验收

1. 跑新 dev 构建（下批 `0.3.2-dev.2`）后，做一次远程重负载（如在 SSH session 里 `cat` 大文件 / 跑一次编译），运行 `scripts/analyze-performance-report.mjs`（不传参自动找最新报告）：
   - 第 1 段应显示非零总输出与峰值速率；若峰值 ≥ 1 MiB/s 应有突发窗口计数。
   - 第 2 段（背压信号）显示 sessionOutput 发送次数与耗时分布；若有慢发送会提示。
   - 第 3 段（stall↔流量）若 stall 伴随高流量会标记相关性。
2. 设置页"立即刷新报告"后，`performance-reports/` 的 `.md` 应有"## PTY 数据吞吐与背压"段。

## 已知边界

- 远程真实背压需远程 session 才能触发；本地轻负载下吞吐/背压段多为 0，属正常。
- `pty.peakPendingEmitBytes` 反映 8ms 合并窗口单次吸收量，不是 scrollback 保留量（scrollback 是固定 2MB 环形，不随流量增长）。
