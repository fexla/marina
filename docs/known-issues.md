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
| Windows (本应用 V1 唯一支持平台) | ConPTY | ✅ |
| macOS | POSIX PTY (forkpty/openpty) | ❌ |
| Linux | POSIX PTY (forkpty/openpty) | ❌ |
| WSL 内的 Linux 程序 | WSL 内部 POSIX PTY | ❌ (即使在 Windows 主机上) |

POSIX PTY 在 resize 时只给 child 发 SIGWINCH,**自己不重画 buffer**——child 重画一次就完事,没有双重重画交错。所以本应用未来支持 macOS/Linux 时此 bug 自动消失。

### 状态

- **不再追加修复** — 应用层已做到 trailing debounce,继续加码 (更长 debounce / 静默丢字节 / 强制清屏) 都是把一个症状换成另一个症状,没有本质改善
- **可能的进一步缓解** (按需启用,目前未做):
  - debounce 时长加到 300ms (体感停顿更明显但稳定窗口翻倍)
  - 在 main 端拖拽期间暂停推 `evt:session:output` 给 renderer,等 resize 稳定后 flush (TUI 拖拽期间屏幕冻结,松手才动)
- **彻底解决依赖** — 微软修 ConPTY,或本应用 V2 改走 SSH/conpty-bypass 替代实现 (远期)
