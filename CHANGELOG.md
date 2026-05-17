# Marina Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/),版本号遵循 [SemVer](https://semver.org/)。

## [0.1.0-beta.5] — 2026-05-17

beta.4 之后的开源准备 + Linux 首发回合。三件大事:**Linux 包正式可下载(Tier 2,
可用但不可靠)**、**CURSOR-1 / BETA-019 cursor 闪烁通过 scrollback 架构重构根治**、
**仓库开源 + 演示资料统稿**。

### 新增

- **Linux 支持**(BETA-003):LinuxAdapter 真实现替换全部 NOT_IMPLEMENTED
  桩;detectShells 走 /etc/shells 过滤;buildShellLaunchParams 对 bash / zsh /
  fish 三 shell 各自走 --rcfile / ZDOTDIR / XDG_CONFIG_HOME 分支;getProcessCwd
  走 /proc/<pid>/cwd;setAutoStart 写 ~/.config/autostart/marina.desktop;
  registerFileManagerIntegration 走 gsettings + update-alternatives /
  alternatives 双分支(Debian / RHEL 系)。`PlatformAdapter.lifecycleModel` 字段
  新增,三平台分别 `tray-resident` / `dock-resident` / `no-persistence`。
  LastSessionConfirm modal 在 Linux 最后窗口 + 仍有 alive session 时弹二次确认。
  详见 ADR-013 与 `docs/方案-BETA-003-Linux支持-20260517.md`。
- **Linux 安装包三种**:`.deb`(Debian/Ubuntu)、`.rpm`(Fedora/RHEL/CentOS)、
  `.AppImage`(通用)。Docker 在容器内构建,Tier 1 测试目标 Ubuntu 22.04 GNOME。
- **dev / portable / installed 三套实例共存**:数据目录、单实例锁、任务栏图标
  全自动按 instance kind 分离,可同时跑三套不冲突。(a8739b7)
- **AI 助手 v2.2**:按键时间线元数据 + LLM 日志独立通道,scrollback 复核请求与
  普通日志分流。(BETA-006 v2.2)
- **在新窗口中打开 Tab**:Tab 右键 / 标签拽出可直接送到新窗口。共享右键菜单
  构造器统一三处 menu。删 TerminalToolbar。
- **CURSOR-1 / BETA-019 根治**(scrollback 架构重构):
  - main 端 SessionManager 用 `@xterm/headless` 维护权威 ANSI buffer
  - GetScrollbackResponse 改 ANSI 重建流(原裸字节)
  - 删 renderer 端 BETA-019 workaround 与 main 端裸字节存储
  - 配套 `docs/issues/cursor-1-alt-buffer-blink-policy-broke-codex.md` 与
    `docs/issues/xterm-serialize-mode-polyfill.md` 全程留档

### 改动

- **Linux 上跳过 WebGL renderer**(BETA-003 perf):某些发行版 / 显卡组合下
  WebGL 触发秒级滚动卡顿,DOM renderer 在 Linux 上更稳。Windows 行为不变。
  (1dbc8bc)
- **Linux 上 transparent: false + 方角窗口**(BETA-003c):BETA-003b 为修圆角
  开启 `transparent: true`,Wayland 下污染 viewport 计算导致 `$COLUMNS` 卡死;
  撤回 transparent,接受方角(与 gnome-terminal / wezterm 等所有主流 Linux 终端
  一致)。(7d4ebef)
- **i18n 切换语言实时生效**:原 `useEffect setLocale` 延迟一帧,改同步派发。
  (1fea493)
- **取消"系统"独立分组**:桌面 / 主目录改为默认收藏种子,首装更直观。
  (7870d02)
- **浅色主题 token 三层架构**(BETA-038 后续):Token / Semantic / Component
  三层重构,顺手修浅色主题 xterm dim 字对比度。
- **拖文件光标闪烁修复**(DROP-1):重构决策点 + 补 dragenter,F7-F11 五轮
  sidebar dropzone 体验打磨。
- **UI 精简**:无边框 + 工具栏瘦身。**Cutie 主题重设计为樱花奶昔风**(粉色
  少女向,撤 80s 复古糖果一版)。

### 修复

- **dev 端口探测器避开 Hyper-V/WinNAT 保留段**:旧探测在 Windows 上偶发
  EACCES,改避开保留段。(7ecfa4d)
- **BETA-019 cursor 闪烁**:CURSOR-1 重构前先 ship workaround,重构落地后删除。
- **beta 勘误第二轮 F1-F6**:系统路径 / 警告槽位 / 主题作用域 / 标题圆角 /
  斜体切断 / AI Base URL 一次性收口。(53eba4b)

### 文档

- **试用说明 → 上手指南**(`docs/presentation/上手指南.md`):删公司痕迹,
  §2.4 加 "E · Linux: 可用但不可靠" 五条已知问题清单(RESIZE-1 / 方角 /
  WebGL / 无托盘 / 中文 IME),§5 改为开源协作渠道。(1bbcae3)
- **产品完整介绍**(`docs/presentation/产品完整介绍-20260517.md`):12 章
  完整产品说明书,适合官网 / GitHub README 长版 / BD 材料。(2f56a58)
- **分享会-完整介绍**(`docs/presentation/分享会-完整介绍-20260517.md`):
  15-25 分钟分享提纲 + 关键句 + Q&A 备弹。
- **RESIZE-1 工单**(`docs/issues/resize-1-windows-mode-disables-reflow.md`):
  Linux 上拖大窗口历史行不 reflow 根因定位(`windowsMode: true` 无平台分支
  关闭 xterm reflow),方案 A(1 行改)与方案 B(升级到 windowsPty)对比,
  **修复未实施 — beta.6 处理**。
- **IME-1 / DROP-1 工单存档**:中文 IME 标点冲刷 + sidebar 拖文件光标闪烁,
  根因待定。
- BETA-003 实施方案存档:`docs/方案-BETA-003-Linux支持-20260517.md`。

### 已知限制(beta.5 仍存在,等后续 release 修)

- **RESIZE-1**(P1, Linux):拖大窗口后旧 cols 卡死,见上方文档章。**beta.6 修**
- **方角窗口**(Linux):接受的妥协,trade-off 是 resize 能用
- **WebGL 关闭**(Linux):滚动比 Windows 略卡
- **无系统托盘**(Linux):平台限制(GNOME 移除 system tray),配套二次确认 modal
- **IME-1**(Linux + Windows):中文 IME 按标点偶发冲刷历史输入,根因调查中
- **KI-004**(全平台):ConPTY 强约束 — Marina 主进程崩则所有 PTY 必死。
  长任务请挂 tmux / screen / nohup 兜底
- **无代码签名 + 无自动更新**:beta 阶段如此,公测前会做

### 工程

- 测试 320+ 通过(含 `linux.test.ts` 新增 18 个用例:detectShells /
  buildShellLaunchParams / getProcessCwd / setAutoStart /
  registerFileManagerIntegration)
- 仓库正式开源:**https://github.com/Liyue-Cheng/marina** (MIT)
- 分支:`fix/cursor-1-state-replay` no-ff merge 到 `main`

---

## [0.1.0-beta.4] — 2026-05-16

Beta 反馈勘误回合一次性收口 32 条工单。详见 `docs/beta反馈工单库-20260515.md`。
跳过的工单:**BETA-003**(Ubuntu 支持,Linux 集成方案仍在修改)与
**BETA-019**(Claude Code 光标闪烁,唯一未知根因,等用户复现信息)。

### 新增

- **AI 助手**:设置页新分类(Brain icon),支持 Anthropic / OpenAI 两个 provider,
  含 apiKey 输入(显示/隐藏切换)、model 输入、测试连接按钮、状态复核开关。
  (BETA-031)
- **LLM 状态复核**:`active→idle` 跃迁前可让 LLM 看一眼 scrollback 复核,
  避免 Vite 等长输出工具被误判 idle。失败时回退原阈值不阻塞。需要 BETA-031
  设置开启。(BETA-006)
- **简易页面 + 终端工具栏**:Tab bar 右端新增 4 个 lucide 按钮 ——
  复制全部 scrollback / 清屏(同时清 main ring buffer)/ 搜索 /
  简易模式切换。Explorer 右键 / 命令行 `--mode=simple` 可直接进入简易模式。
  (BETA-027 / BETA-028)
- **系统路径分组**:Sidebar 新增第 4 栏"系统",含桌面 / 主目录 / 临时目录。
  整体 + 逐项开关在外观设置里。(BETA-011)
- **4 个新主题**:One Dark Pro / Dracula / Tokyo Night / Catppuccin Mocha。
  主题总数 7→11。(BETA-033)
- **同名末级智能去重**:同 category 内多个路径末段同名时自动补父目录,
  `proj1/src` 与 `proj2/src` 区分;手动命名的不参与。(BETA-014)
- **路径存在性检查**:启动期扫描所有 bookmarks / temporary / recent /
  systemPaths,不可访问的路径标 ⚠️ 不可访问 + 半透明显示。(BETA-043)
- **中英双语 i18n**:`src/shared/i18n.ts` 自写轻量框架,~80 个 key 覆盖
  Sidebar / Settings / TerminalToolbar 等关键 UI;设置页可切换"跟随系统
  / 中文 / English"。(BETA-004)
- **完成/失败 icon 区分**:exited session 状态点叠 ✓(exitCode=0)/ ✗
  (非零)/ 仅灰底(强杀)。(BETA-007)
- **macOS 红绿灯悬浮符号开关**:外观设置可选 hover 时是否显示 ×/−/+,
  默认关。(BETA-023)
- **Win11 右键菜单**:install/uninstall 成功后 toast 提示"请重启计算机"
  以确保 MSIX 加载生效。(BETA-044)

### 改动

- **创建终端初始状态从 active 改为 idle**:语义反转,`active` = 用户命令
  正在执行,`idle` = 等待命令(含 banner 期 + prompt 等待)。消除"新建即
  闪绿"。推翻 CP-4 勘误 #5。(BETA-008,ADR-014)
- **spawn 前从注册表合并最新 PATH**:Windows 安装新软件后,新 PTY 立刻
  能看到新的 python.exe / node.exe,无需重启 Marina。(BETA-001)
- **多行粘贴判定逻辑修复**:原 normalize 只剥一个尾换行,`"ls\n\n"` 被算
  2 行误触发 confirm,改为剥所有尾空行。(BETA-041)
- **切换终端不再"从上往下刷屏"**:scrollback 重放完立即 `scrollToBottom()`。
  (BETA-018)
- **新窗口右键打开终端时自动展开 path**:Explorer "在 Marina 终端中
  打开" 新窗口里直接看到 session,不再要手动展开。(BETA-042)
- **主题选择 UI 改纯文本列表**:删 5 色块色卡,改纯文本 + 深色/浅色 tag。
  (BETA-032)
- **Cutie 主题重设计**:从单调奶油粉换 80s 复古糖果风(iBook G3 / 马卡龙
  色系);所有 ANSI 16 色对浅底对比度 ≥ 4.5:1。配色细节欢迎用户反馈。
  (BETA-034)
- **浅色主题 ANSI bright 集对比度修复**:Rose Pine Dawn 的 brightBlack /
  brightYellow / brightCyan 全部调到 ≥ 4.5:1,解决 Claude Code 在浅色主题
  下出现"浅底白字"问题。(BETA-035)
- **浅色主题右键菜单 / Modal 边框 + 背景透明度调整**:边框换 --muted,
  modal backdrop 改 22%(原 45% 在浅底突兀)。(BETA-037)
- **数据目录显示真实路径**:设置页用 `app.getPath('userData')` 替换硬编码
  `%APPDATA%\Marina`,portable / dev / 自定义 userData 场景准确。(BETA-039)
- **Sidebar 分组标题字号 / 颜色加重**:font-size 11→12,color --subtle
  → --text。(BETA-012)
- **Sidebar 三角形换 lucide ChevronRight/Down**:文字 ▶ 视觉上不够清晰。
  (BETA-013)
- **Sidebar 顶部与右侧 Tab bar 对齐**:32px spacer。(BETA-016)
- **Sidebar 点空白处取消选中**:`e.target === e.currentTarget` 判断。
  不依赖快捷键(哲学约束)。(BETA-017)
- **Tab 卡片加顶部圆角 + padding-right**:浏览器风格圆角;斜体字右上角不
  再被切。(BETA-020 / BETA-025)
- **Window 标题栏改动**:删底部 border 分割线;`Window N` badge 去矩形
  仅留纯文字。(BETA-021 / BETA-022)
- **macOS 风格标题染色修复**:浅色主题下 `--subtle` 对背景不可见,改 `--text`。
  (BETA-024)
- **删 logo 中的金色光标方块**:视觉上与 `>_` 提示符语义重复。(BETA-026)

### 删除

- **设置页"复制 PS 命令"调试按钮**:Win11 右键菜单卡片内不再展示
  install/uninstall 命令副本。(BETA-038)

### 已知限制

- **KI-004**:Windows ConPTY 强约束 — Marina 主进程崩溃则所有 PTY 必死。
  接受为 V1 限制,用户应定期 export 设置;长任务挂 tmux / screen / nohup
  以独立于 Marina 主进程。(BETA-002)

### 工程

- 新依赖:`@anthropic-ai/sdk` + `openai`(AI 助手用,用户已确认)
- 测试:320 全过(+10 来自 `path-display.test.ts`)
- 分支:`fix/beta-feedback-20260515`,基于 `dev`(beta.3)

### 跳过

- **BETA-003 Ubuntu 支持**:Linux 集成方案仍在迭代,本轮不动
- **BETA-019 Claude Code 光标闪烁**:唯一未知根因 bug,等用户复现信息

---

## [0.1.0-beta.3] — 2026-05-15

Beta 试用阶段,详见 git log。
