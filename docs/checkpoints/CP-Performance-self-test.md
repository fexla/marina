# 0.3.2 性能诊断自测报告

**日期**：2026-07-22  
**版本状态**：功能记入 `CHANGELOG.md` 的 `[Unreleased]`；`package.json` / `package-lock.json` 保持正式版 `0.3.1`。

## 本轮实现

- 每次 Electron ready 自动生成一个有界 JSON + Markdown 性能报告。
- 0 窗口托盘态继续采样 main event loop、CPU/内存、Electron 子进程和业务 gauges。
- 固定名称 IPC / Git / session / PTY operation heatmap；operation/counter/gauge 名称均有硬上限。
- 5 分钟周期原子刷新；>=1 秒严重 stall 按 60 秒限频额外落盘；正常退出在 1 秒预算内等待 `finalized:true`。
- 设置 -> 高级可刷新/打开报告，并在隐私确认后捕获 5–30 秒 V8 CPU Profile；禁止并发，每 run 最多保留 5 份。
- 自动报告不记录路径、命令、终端内容、IPC payload、stack 或源码 URL。

## 自动化验证

- [x] `npm run typecheck`
- [x] `npm run lint`
- [x] `npm run lint:css`
- [x] `npm test -- --run`：59 files / 922 tests 全部通过
- [x] `npx electron-vite build`
- [x] 涉及 TS/TSX 文件 Prettier 检查通过
- [x] `git diff --check`

新增回归覆盖：

- 并发 `start()` / `stop()` 生命周期串行化；
- 100/250/1000ms stall 分桶与 200 条 ring 上限；
- 180 条 sample 上限和序列化报告 `< 2 MB`；
- operation/counter/gauge 名称上限与 overflow；
- 报告 retention、orphan profile、crash temp 文件清理；
- 自动报告隐私字段守护；
- 显式报告写盘失败向 UI 传播；
- Inspector 构造失败后的状态/资源复位；
- CPU Profile 时长 clamp、并发拒绝及每 run 5 份上限；
- Git disable 与慢 availability 竞态不复活 watcher；
- 四条性能 IPC 的本地路由及 `shell.openPath` 错误传播。

## 隔离 Electron runtime smoke

使用临时 `--user-data-dir` 启动真实 build，不触碰 `%APPDATA%/Marina`：

1. 启动后关闭全部 BrowserWindow；
2. 保持 0 窗口托盘态 12 秒（跨过一次 10 秒采样）；
3. 通过 main Inspector 调用正常 `app.quit()`；
4. 读取临时目录中的最终 JSON 后删除整个自建临时目录。

结果：

- [x] 关闭后窗口数为 0，应用仍存活并继续采样；
- [x] 进程正常退出：exit code 0；
- [x] 报告数 1，`finalized:true`；
- [x] `sampleCount:3`，最终 `runtime.windows:0`；
- [x] 最近 main CPU 样本 0.38%（仅为本次环境快照，不作为跨机器基准）；
- [x] 无 fatal / renderer gone；
- [x] 报告不包含临时 userData 绝对路径。

## 仍需开发者手测

1. `npm run dev`，打开“设置 -> 高级 -> 性能诊断”，确认状态卡可见。
2. 点击“立即刷新报告”，再点“打开报告目录”，确认 JSON/Markdown 可读。
3. 关闭全部窗口，等待至少 15 秒；从托盘重新开窗并刷新报告，确认采样数增长。
4. 点击“捕获 15 秒 CPU Profile”，先确认隐私提示；完成后确认 Explorer 打开且 `.cpuprofile` 可被 Chrome DevTools Performance 面板加载。
5. 连续运行游戏/重负载应用一段时间，确认 Marina 未带来可感知帧时间回退，并把报告用于后续阈值校准。

## 已知边界

- main event-loop stall 不是 renderer FPS，也不是 Windows DPC/ISR 延迟。
- Electron GPU 指标只有 GPU 进程 CPU/内存，不代表 GPU engine utilization。
- 自动报告隐私安全；显式 `.cpuprofile` 可能包含函数名、模块结构和本地源码路径，只应在确认后分享。
