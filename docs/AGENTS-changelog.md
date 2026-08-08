# AGENTS.md 版本变更说明(历史归档)

> 本文是 `AGENTS.md` 顶部 v1.1~v1.11 变更说明的归档。
> AGENTS.md 当前版本:1.11。最新版本以仓库内 `AGENTS.md` 顶部「文档版本」为准。

> **v1.11 变更**:新增 5.3「agent 必须自己跑能跑的验证」—— 固化"完成改动后 agent 必须自跑 `npm test`/`typecheck`/`lint` + `smoke`/`smoke:interactive`,不要把能自测的丢给开发者手测;只有 UI 视觉/交互体感/真外部依赖才让人测"的纪律。附 Electron 二进制不能用 `--ignore-scripts` 装的陷阱(postinstall 被跳过 → dev/smoke 报 `Electron uninstall`)。

## 历史变更说明(原 AGENTS.md 顶部)

# AGENTS.md — Marina 项目 AI Agent 工作说明书

> 这份文件是给为 Marina 贡献代码的 AI agent(Claude Code / Cursor / Codex / 其他)看的。
> 你正在 YOLO 模式下工作,大部分时间不需要打扰开发者。但有少数情况你必须立刻停下来。
> 仔细读完整份文件再开始工作。

文档版本:1.10 · 最后更新:2026-07-29

> **v1.10 变更**:新增附录 J「终端视图生命周期规范」—— 对齐 ADR-022，普通 Session 切换必须保留真实 xterm/viewport；固定 TerminalDeck 有界缓存、active/parked 权限边界、单 view lease 输出路由、断流 replay 与本地/远程清理纪律。
>
> **v1.9 变更**:新增附录 I「昂贵周期后台任务规范」—— 对齐 ADR-021，固定 HOT/WARM/NONE demand、recursive timeout、全局并发预算、renderer 绝对状态上报及本地/远程 consumer 生命周期清理；禁止昂贵后台工作自行新增固定 `setInterval`。
>
> **v1.8 变更**:新增附录 H「性能指标命名 / 隐私 / 开销规范」—— 对齐 ADR-020 与 0.3.2 飞行记录器，固定自动报告只记录数值和固定低基数标签、禁止路径/命令/PTY/IPC payload/stack，operation name 上限与深度 profile 显式确认规则。
>
> **v1.7 变更**:新增附录 G「新面板 UI 状态 / 缩进 / icon 规范」—— 固化 ADR-019 的三条共享基础设施(面板 UI 状态三层模型 panel-ui-cache/panel-preferences + 树形缩进单一真相源 --tree-indent-unit/FileListRow depth + 文件 icon 单一数据源 file-icon.ts),给新面板可循规范。
>
> **v1.6 变更**:新增附录 F「开发构建版本号规则」—— 定义 `0.3.1-dev.N` 格式(SemVer 预发布后缀,`0.3.0 < 0.3.1-dev.N < 0.3.1`,装包是升级不降级),用于"需要产出可测试 portable 但改动量未到正式 bump"的中间态。dev 版本号 = 按附录 E 预判的正式 bump 目标 + `-dev.N`;CHANGELOG 与 version 严格同步(附录 E 纪律 3 零豁免)。附录 D 验收清单加「dev 构建文件名 + CHANGELOG 同步」校验项。
>
> **v1.5 变更**:新增附录 E「版本号规则」—— 定义 MINOR/PATCH 的 bump 标准 + 四条硬纪律(不为小更新单独发版、一次批量只 bump 一次、构建前同步 package.json ↔ CHANGELOG、一个版本一个条目)。纠偏此前 0.3.0/0.3.1/0.3.2 连 bump 的失误。附录 D 验收清单加「version 同步」第 1 项。
>
> **v1.4 变更**:新增附录 D「构建与打包速查」—— 固化 portable/nsis 构建命令、产物路径、icon 依赖、验收清单、失败排查顺序。避免每次重新 grep `electron-builder.yml` 与 `package.json` scripts。
>
> **v1.3 变更**:与软件定义书 v1.6 / ADR-013 对齐 — 附录 C "关闭弹确认"硬规则增加 Linux 例外脚注:仅当 `lifecycleModel === 'no-persistence'` + 最后一个窗口 + 仍有非 exited session 时,允许弹 `<LastSessionConfirm />`。1.2 节边界 3 例子同步加例外注脚。
> **v1.2 变更**:产品改名 EasyTerm → **Marina**(对齐软件定义书 v1.5,ADR-012)。所有"产品现状"维度的 EasyTerm 字样替换为 Marina;commit message 示例等"历史/惯例"维度的 EasyTerm 保留作为风格参考。`%APPDATA%\EasyTerm\` 全部改为 `%APPDATA%\Marina\`(Electron 由 `productName` 自动派生)。
> **v1.1 变更**:与软件定义书 v1.3 / CP-4 勘误回合对齐 — CP-4 完成标志改 7 套主题;附录 D 新增"勘误回合工作纪律";4.5 章明确"勘误回合修复"也是检查点工作流的一部分。

---
