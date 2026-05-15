# 已知问题与平台限制

> **历史档案**:本文件创建于 alpha 阶段,产品当时叫 EasyTerm,自 v1.5 起更名为 Marina(见软件定义书 ADR-012)。下文 "EasyTerm" 字样保留作为时间点快照。


记录应用层无法根治、属于平台/上游依赖的问题。每条带"现象 / 根因 / 我们做了什么 / 用户解法 / 平台覆盖 / 状态"。

---

## KI-001 · Windows 平台 resize TUI 应用时丢/重数据

**首次发现**:CP-2 用户测试 (2026-05-10)
**严重度**:中 (不影响数据正确性,只影响视觉显示;下次 child 重画即恢复)

### 现象

在 Windows 上拖拽窗口边缘改变终端尺寸时:
- 行模式 shell (PowerShell / cmd / bash readline 状态):基本正常,可能有轻微闪烁
- 全屏 TUI 应用 (Claude Code、vim、less、btop、nano 等使用 alternate screen buffer 的程序):**屏幕内容会重复出现多份残缺重画 / 部分内容看似丢失**,直到 child 进程下次完整重画才恢复

具体可能看到的样子:
- Claude Code 的输入框和历史消息出现 N 份叠在一起
- 屏幕中间一段被裁掉
- ANSI 转义序列被打断渲染成乱码字符

### 根因

Windows 的本地 PTY 实现 (ConPTY) 在 `ResizePseudoConsole(cols, rows)` 调用时会做两件事:

1. **ConPTY 自身**:把 conhost 当前 screen buffer 按新尺寸重新排版,并把整屏字节内容**通过 PTY pipe 再发一遍**给我们 (xterm)。
2. **child 进程**:收到 SIGWINCH (Win32 上的等价信号),自己也响应一次,全屏 TUI 应用会重画整个屏幕 (数 KB 的 ANSI 序列)。

两路重画的字节流**在 PTY pipe 里交错**,加上 ConPTY 在重排过程中已知存在丢/重发字节的 bug,最终的字节流不再是一份完整屏幕,而是若干份残缺画面拼接。

xterm 按收到的字节流如实渲染——它本身没有"哪些是合法重画哪些是 ConPTY 残留"的判断能力,所以视觉上就出现重复 / 丢失。

行模式 shell 不响应 SIGWINCH 重画整屏,所以一般情况看不太出问题。

### 上游 issue (4-5 年未修)

- [microsoft/terminal#3088](https://github.com/microsoft/terminal/issues/3088)
- [microsoft/terminal#10301](https://github.com/microsoft/terminal/issues/10301)
- [microsoft/terminal#1860](https://github.com/microsoft/terminal/issues/1860)

WT (Windows Terminal)、VS Code Terminal、Alacritty (Windows 版)、所有用 ConPTY 的本地终端**全部都有这个问题**,微软自家也没修。

### 我们做了什么

`src/renderer/components/TerminalView.tsx` 的 `ResizeObserver`:从 RAF 节流改为 **trailing debounce 150ms**。

效果:整个拖拽过程 (无论拖多久) 只发起 1 次 `pty.resize` → 1 次 ConPTY ResizePseudoConsole → child 只收到 1 次 SIGWINCH → 只重画 1 次,不会"多份残缺重叠"。

trade-off:拖拽期间 xterm 网格不跟随容器实时变化 (松手 150ms 后才一次性 fit),换数据流稳定性。

### 用户解法

如果偶尔仍然观察到屏幕乱:

1. **拖拽窗口尽量一次到位**,避免来回拉
2. **按 Ctrl+L** (claude / bash / 大多数 TUI) 触发一次完整清屏重画
3. 真乱到没法用 → 退出 TUI 重进 (会触发 alternate buffer 切回主 buffer 然后再切到 alt,xterm 与 child 状态对齐)

### 平台覆盖

| 平台 | PTY 实现 | 受影响 |
|---|---|---|
| Windows (本应用 alpha/beta 阶段唯一发布平台) | ConPTY | ✅ |
| macOS | POSIX PTY (forkpty/openpty) | ❌ |
| Linux (v1.6 起支持,见 BETA-003) | POSIX PTY (forkpty/openpty) | ❌ |
| WSL 内的 Linux 程序 | WSL 内部 POSIX PTY | ❌ (即使在 Windows 主机上) |

POSIX PTY 在 resize 时只给 child 发 SIGWINCH,**自己不重画 buffer**——child 重画一次就完事,没有双重重画交错。所以本应用 v1.6 起的 Linux 支持(BETA-003,POSIX PTY)以及未来的 macOS 支持都不会出现此 bug;仅 Windows 受影响。

### 状态

- **不再追加修复** — 应用层已做到 trailing debounce,继续加码 (更长 debounce / 静默丢字节 / 强制清屏) 都是把一个症状换成另一个症状,没有本质改善
- **可能的进一步缓解** (按需启用,目前未做):
  - debounce 时长加到 300ms (体感停顿更明显但稳定窗口翻倍)
  - 在 main 端拖拽期间暂停推 `evt:session:output` 给 renderer,等 resize 稳定后 flush (TUI 拖拽期间屏幕冻结,松手才动)
- **彻底解决依赖** — 微软修 ConPTY,或本应用 V2 改走 SSH/conpty-bypass 替代实现 (远期)

---

## KI-002 · 没有自动更新机制(已规划,未实施)

**首次记录**:v0.1.0-alpha.1 release 之后 (2026-05-12)
**严重度**:低 (alpha 阶段可接受,正式版前必补)

### 现象

用户拿到 v0.1.0-alpha.1 后,下个版本发出来时:
- 应用内**不会有任何提示**
- 用户得自己去 https://github.com/Liyue-Cheng/marina/releases 翻新版本
- 下载新 Setup 覆盖安装(数据在 `%APPDATA%\Marina` 不受影响)

### 实施计划(暂不开工)

**技术上完全可做**,且我们已经准备好了一半的零件:

- `electron-builder` 打包已经生成 `latest.yml` + `.blockmap` — 正是 `electron-updater` 直接吃的格式
- GitHub release 已经是 `electron-updater` 认的 publish target (本仓库 v0.1.0-alpha.1 已发)
- electron-builder.yml 只需加 `publish: github` 块

MVP 工作量约 **3-5 小时**:

1. 加依赖 `electron-updater` (需明示 OK 才引入,AGENTS.md 1.2 边界)
2. main 进程钩 `autoUpdater.checkForUpdatesAndNotify()` 启动期 + 周期触发
3. `evt:update:*` IPC 推送 "可下载 / 下载中 / 已就绪重启" 三态
4. 给 toast / 设置页一个 "重启安装" 入口
5. 配 `electron-builder.yml`:`publish: { provider: github, owner: Liyue-Cheng, repo: marina }`

### 阻塞 / 注意事项

1. **代码签名 (主要痛点)** — 不签 → Windows SmartScreen 在下载 + 首次运行都弹 "Windows 已保护你的电脑",自动更新拉的新 exe 也会触发同样拦截。
   - OV 证书 ~$100-200/yr,EV ~$400+/yr,都得过 KYC
   - alpha 内部测试期可以跳过签名,公测前必须解决

2. **Prerelease 行为** — `electron-updater` 默认**不看 prerelease**。v0.1.0-alpha.1 已标 prerelease,后续 alpha 也会;要让 alpha 用户能收到下一个 alpha,必须显式 `allowPrerelease: true`(可做成 settings 开关:"接收预发布版本")。

3. **首版无更新通道** — v0.1.0-alpha.1 本身不带 `electron-updater`,所以它**不会**自动检查新版。最早能"被自动更新"的版本是装上更新逻辑后发的那一版。alpha.1 的用户得手动升一次。

### 推荐分阶段

- **阶段一 · alpha 期**:加 electron-updater + 跳过签名 + `allowPrerelease: true`,验证"我能收到新版下载并重启"链路通
- **阶段二 · 公测前**:买签名证书 + 配 electron-builder 签名 + CI 自动化(可选)

### 状态

- **暂不开工** — 用户 2026-05-12 决定先观察 alpha.1 表现,再决定是否优先级提前
- 现状靠 GitHub release 通知 / 手动重装,alpha 阶段够用

---

## KI-003 · Win11 新右键菜单未集成(必做,排 v0.2 公测前)

**首次记录**:2026-05-12,alpha.3 发布前勘误 #15
**严重度**:中(Marina 主打 path-centric 入口,新菜单缺位是核心体验缺口)

### 现象

Windows 11 默认右键菜单(那个圆角紧凑、用户首先看到的)看不到 "在 Marina 终端中打开"。要看到必须点 "显示更多选项" 展开经典菜单,或 `Shift+F10`。

### 根因

Win11 新菜单要求 `IExplorerCommand` COM + Sparse Package / MSIX。我们当前的 `HKCU\...\Directory\shell` 注册表方案只命中经典菜单。

VS Code / Notepad++ / Git for Windows / 7-Zip(< v24)同处境,业界标准是"暂未支持"。但 Marina 主打 Explorer 集成,这个缺位最伤。

### 决议

**必做,但不是现在做** — 用户 2026-05-12 决定:

- 实施方案:Sparse Package + Rust 写 IExplorerCommand DLL
- 工作量:~1.5-2 周专注开发
- 硬依赖:代码签名证书(与 KI-002 自动更新共用)
- 时间窗口:**v0.2 公测前**,与签名证书采购合并办理

详情、技术拆解、验收标准、风险、参考资料在 `docs/issues/win11-new-context-menu.md`。

### 状态

- **alpha 阶段不动** — 经典菜单功能完整,用户多点一次可达
- **公测前必做** — 与代码签名证书采购、KI-002 自动更新 一起作为"对外发布前必修补"清单

---

## KI-004 · Windows ConPTY 强约束:主进程崩溃则所有 PTY 必死

**首次记录**:beta 反馈勘误回合 BETA-002(2026-05-15)
**严重度**:中(主进程 crash 罕见,但发生时无降级路径)

### 现象

如果 Marina 主进程异常退出(uncaughtException 未捕获、被 OS Kill、Out-Of-Memory 等),所有正在运行的 PTY session 同时被 Windows job object 杀掉,scrollback / 当前命令进度 / 未保存的工作全部丢失。

### 根因

Windows ConPTY 的 PTY 进程是 Marina 主进程的直接子进程。Windows 默认把 Marina 注册为 job object 的 root,父死则子必死(SetInformationJobObject + JobObjectExtendedLimitInformation)。这是 ConPTY 体系的强约束,不是 Marina 的 bug。

要在主进程崩溃后保住 PTY,只有两条路:
1. 把 PTY 抽出独立 sidecar 进程(重写主进程,工程量~1-2 周)
2. 接入 Windows job object 重新配置 + 进程提升(脆弱、与 Electron 自身生命周期冲突)

均不在 V1 范围。

### 我们做了什么

BETA-002 把 IPC handler / persistence / session-manager 等关键路径的 try-catch 缺口补上,降低主进程崩溃概率;`process.on('uncaughtException')` / `unhandledRejection` 全局兜底只记日志不退出。

但"main 死则 PTY 必死"这一条**仍是已知限制**,不做 watchdog、不做 PTY sidecar。

### 用户解法

- 定期 export 设置 + 收藏(设置 → 数据 → 导出)
- 长任务尽量挂在 tmux / screen / nohup 这类**用户态进程隔离**的会话里(它们的 PTY 父是 shell 自己,不依赖 Marina 主进程存活)

### 平台覆盖

- Windows:本节描述的强约束
- macOS / Linux:Linux job control 默认不杀子进程,理论上有更多回旋空间。但 V1 不做实现,留给后续社区贡献者

### 状态

接受作为 V1 已知限制,在 README beta 试用说明中明确告知用户。
