# EasyTerm

> 你的终端会话不应该因为关掉窗口就死掉。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows-blue)](https://github.com/yourusername/easyterm/releases)
[![状态](https://img.shields.io/badge/状态-Alpha-orange)](#路线图)
[![English](https://img.shields.io/badge/English-README.md-blue)](README.md)

一个**以路径为中心、对 AI agent 友好**的 Windows 终端管理器。为同时运行多个长时间任务(包括 Claude Code、Codex、OpenCode 等 AI 编码助手)、需要在多个工作目录之间频繁切换、又不愿意因为关错窗口前功尽弃的开发者打造。

---

## 痛点

如果你曾经:

- 🤖 同时跑了 5 个 AI agent 在 5 个项目里干活,**忘记了哪一个还在等你确认**
- 💀 不小心关错了窗口,**杀掉了一个跑了 2 小时的构建 / 一个长时间 pytest / 一个干到一半的 agent**
- 🌀 第三次手敲 `cd D:\projects\company\some\deeply\nested\path` 还打错了
- 📑 试图用 Windows Terminal 的 profile 来组织工作流,最后放弃了

...EasyTerm 是为你做的。

## 解决方案

EasyTerm 重新思考了"终端会话应该怎么管理"这个问题:

- **🔒 会话独立于 UI 存活** —— 关掉所有窗口,session 仍在守护进程里跑;打开任意窗口又能看到它们
- **📍 路径是一等公民** —— 收藏工作目录,session 按"在哪干活"组织,而不是按"用了哪个 profile 启动"
- **🖱️ 鼠标优先** —— 不需要记快捷键,不需要敲 `cd`,所有操作就是在侧栏点路径
- **🪟 所有窗口完全平等** —— 没有"主窗口"概念。开任意多个,关任意一个,应用照常运行

## 截图

> 第一个稳定版会附正式截图。下面是布局示意。

```
┌────────────────────────────────────────────────────────────────────┐
│ EasyTerm — Window 1                                  [_] [□] [×]  │
├──────────────────────┬─────────────────────────────────────────────┤
│ [收藏] [临时] [最近] │  ┌─[claude] [shell] [pytest] [codex灰]┐    │
│                      │  └────────────────────────────────────┘   │
│ ▼ 📌 ~/projects/auth │   ┌──────────────────────────────────────┐  │
│   ├─ 🟢 claude code  │   │ $ claude                             │  │
│   ├─ 🟡 shell        │   │ ✻ Welcome to Claude Code             │  │
│   └─ ⚫ pytest       │   │                                      │  │
│ ▼ 📌 ~/projects/web  │   │ How can I help you today?            │  │
│   └─ 🟢 codex        │   │ █                                    │  │
│ ▶ 📌 ~/scripts       │   │                                      │  │
│                      │   │                                      │  │
│ ───── 临时 ─────     │   │                                      │  │
│ ▼ 🕐 ~/Downloads     │   │                                      │  │
│   └─ ⚫ shell        │   │                                      │  │
│                      │   │                                      │  │
│ ───── 最近 ─────     │   │                                      │  │
│ • ~/test123          │   │                                      │  │
│ • D:\old\project     │   └──────────────────────────────────────┘  │
│                      │                                             │
│ [⚙] 设置             │                                             │
└──────────────────────┴─────────────────────────────────────────────┘
```

## 为什么不直接用 [X]?

| 特性 | Windows Terminal | Tabby | Wave | Warp | **EasyTerm** |
|------|:---:|:---:|:---:|:---:|:---:|
| 关窗后 session 不死 | ❌ | ❌ | ✅ | ❌ | ✅ |
| 以路径组织,不是以 profile | ❌ | ❌ | ❌ | ❌ | ✅ |
| 自动 cwd 跟踪(`cd` 后 UI 跟随) | ❌ | ❌ | ✅ | ✅ | ✅ |
| 多窗口共享 session 池 | ❌ | ❌ | ❌ | ❌ | ✅ |
| 关窗口不杀 session | ❌ | ❌ | ✅ | ❌ | ✅ |
| 专为 AI agent 工作流设计 | ❌ | ❌ | ❌ | ❌ | ✅ |
| 原生 Windows 优先 | ✅ | ✅ | ❌ | ❌ | ✅ |
| 鼠标优先(不强制学快捷键) | ❌ | ❌ | ❌ | ❌ | ✅ |

## AI Agent 用户专用说明

EasyTerm 诞生于一个具体的痛苦:同时跑多个 Claude Code / Codex / OpenCode session,然后**忘记了哪个在闲着、哪个在等输入、哪个被我关错窗口杀掉了**。

如果你的工作流长这样:

- 一个 agent 在 `~/projects/frontend` 改 dashboard
- 另一个 agent 在 `~/projects/backend` 重构 auth 模块
- 第三个 agent 在 `~/scripts` 跑长时间数据迁移
- 第四个在 `D:\client-work\report-tool` 调一个 flaky test
- ……然后你已经分不清哪个是哪个了

EasyTerm 给你的是:

- **常驻侧栏**,所有 agent 按所在项目路径分组
- **状态指示**,一眼就能看出哪些在工作、哪些在闲着
- **自动路径跟踪** —— agent 用 `cd` 切到别处,UI 跟着走
- **内置启动模板**:`claude`、`codex`、`opencode`,也支持自定义命令模板
- **会话不死** —— 关错窗口?session 在守护进程里照常跑。重新打开任意窗口,接着干。

## 快速开始

> ⚠️ EasyTerm 目前是 **Alpha** 阶段,会有粗糙的地方。计划见 [路线图](#路线图)。

### 安装

1. 从 [Releases](https://github.com/yourusername/easyterm/releases) 下载最新安装包
2. 运行 `EasyTerm-Setup-x.y.z.exe`
3. 从开始菜单或桌面快捷方式启动

### 第一次运行

- 一个窗口打开,侧栏是空的
- 点击"收藏"分类旁的 **+**,选择一个文件夹加入
- 也可以从 Windows 资源管理器直接把文件夹拖到侧栏
- 双击收藏的路径,在该路径打开终端
- 标签栏的 `+` 按钮启动 Claude Code / Codex / shell 等 session

### 体验"关键差异"

要感受 EasyTerm 和其他终端的不同:

1. 在 2-3 个不同路径下分别开 session
2. 关闭整个窗口(点 ×)
3. 看一下系统托盘 —— EasyTerm 还在跑
4. 单击托盘图标 —— 一个新窗口打开,所有 session 都还在

就这么简单。这就是产品。

## 核心功能

### V1(当前版本)

- ✅ **路径管理**:收藏、重命名、调序;自动维护"临时"和"最近"分类
- ✅ **会话生命周期**:创建、关闭、墓地恢复(5 分钟保留期内可复活)
- ✅ **启动模板**:内置 4 种(Shell / Claude Code / Codex / OpenCode)+ 自定义
- ✅ **多窗口**:任意多个完全平等的窗口;关窗即托盘;跨窗口可见 session
- ✅ **CWD 跟踪**:OSC 1337 hook 支持 PowerShell 和 cmd.exe
- ✅ **5 套主题**:Rose Pine(默认)、Rose Pine Dawn、Rose Pine Moon、Cutie、Business
- ✅ **设置即改即生效**,无保存按钮;支持配置导入导出
- ✅ **系统托盘常驻**:每个 session 快捷访问;退出有诚实的二次确认

### V1.1(规划中)

- 通过 OSC 1337 命令完成事件支持"等待输入"/ "出错"等状态指示
- session 状态变化时的系统通知
- 完整的终端右键菜单

### V1.2(规划中)

- 资源管理器右键集成("在 EasyTerm 中打开")
- 标签页拖拽改顺序
- 标签页拖出窗口 = 拆分到新窗口

### V2.0(社区贡献为主)

- macOS 支持
- Linux 支持
- WSL session 集成

## 架构概要

EasyTerm 基于 **Electron + TypeScript + React + node-pty + xterm.js** 构建。

- **主进程** = 守护进程:持有所有 PTY、所有数据、系统托盘
- 每个**窗口是独立的 Renderer 进程**,各自的 React UI
- 窗口是纯观察者 —— 关闭它们绝不影响任何 session
- 通信用 Electron IPC,有严格的类型化协议

详细文档:

- [软件定义书](docs/软件定义书.md) —— EasyTerm 是什么、为什么这么做
- [IPC 协议](docs/ipc-protocol.md) —— 主进程和渲染进程之间的契约
- [AGENTS.md](AGENTS.md) —— 给参与构建的 AI agent 看的规约

## 从源码构建

```bash
# 前置:Node.js 20+,Windows 10/11
git clone https://github.com/yourusername/easyterm.git
cd easyterm
npm install
npm run dev      # 开发模式,带热重载
npm run build    # 构建安装包,产物在 dist/
npm test         # 跑后端测试套件
```

## 招募贡献者

EasyTerm 由一个人在业余时间维护,目前只专注 Windows。**架构有意做成跨平台 ready** —— 见 [`src/main/platform/`](src/main/platform/) —— 但我不会自己实现也不会测试其他平台。非常欢迎贡献:

### 高优先级

- [ ] **macOS 平台支持** —— 实现 `src/main/platform/macos.ts`
- [ ] **Linux 平台支持** —— 实现 `src/main/platform/linux.ts`
- [ ] **WSL session 集成**

### 中优先级

- [ ] Fish / Nushell shell hook
- [ ] 标签页拖拽
- [ ] 更多主题(我做的 5 套对我够了,但欢迎扩展)
- [ ] i18n 国际化(目前只有中英)

### 低优先级

- [ ] 启动时恢复"重要" session(用户标记)
- [ ] 性能基准测试

如果以上任何一项打动你,先看 [CONTRIBUTING.md](CONTRIBUTING.md),里面讲了平台抽象层的设计哲学,以及怎么在不动核心代码的前提下加新平台。

## 设计哲学

如果你想理解 EasyTerm 为什么做出这些选择,四条核心原则是:

1. **Path 是稳定的,Session 是廉价的,UI 是临时的** —— 工作以 path 流动,session 来去如风,窗口是用完即弃的观察者
2. **不让用户输入路径,只让用户点击路径** —— `cd` 命令是 1971 年的设计,不应该是必须的
3. **用户决策最少化** —— 自动分类、自动跟踪、自动 resize;用户只挑路径和模板,其他全自动
4. **窗口与应用解耦** —— 关闭窗口零成本;应用住在托盘里,直到你明确退出它

完整推理见 [软件定义书](docs/软件定义书.md) 第 2 章。

## EasyTerm **不是**什么

替你节省时间:

- ❌ **不是终端模拟器替代品** —— 我们和别人一样用 xterm.js
- ❌ **不是 tmux 的竞争对手** —— tmux 是 TUI,EasyTerm 是 GUI,服务不同人群
- ❌ **不是项目管理工具** —— 没有 kanban,没有团队功能,没有 workspace 概念
- ❌ **不是 SSH 客户端** —— 只管本地 session
- ❌ **不是文件编辑器** —— 在 session 里 `code .` 即可
- ❌ **不是给追求"满屏快捷键"的硬核用户** —— 如果你喜欢在终端管理器里用 vim 键位,会觉得 EasyTerm 的鼠标优先很烦人。这是 feature,不是 bug。

## 路线图

| 阶段 | 内容 | 时间 |
|------|------|------|
| Phase 1 | V1:个人内部工具,仅 Windows | 进行中 |
| Phase 2 | 开源发布、文档完善 | V1 稳定后 |
| Phase 3 | V1.x:状态指示、通知、Explorer 集成 | 发布后迭代 |
| Phase 4 | V2.0:跨平台,主要靠社区贡献 | TBD |

这是一个业余时间的个人项目。背后没有公司、没有 SLA、没有承诺的时间表。如果它解决了你的问题,很好;如果没有,fork 它。

## License

MIT —— 见 [LICENSE](LICENSE).

## 致谢

EasyTerm 站在以下巨人的肩膀上:

- [Electron](https://www.electronjs.org/) —— 应用框架
- [xterm.js](https://xtermjs.org/) —— 终端渲染
- [node-pty](https://github.com/microsoft/node-pty) —— PTY 绑定(微软出品)
- [React](https://react.dev/) —— UI 框架
- [Rose Pine](https://rosepinetheme.com/) —— 色板灵感
- [霞鹜文楷 (LXGW WenKai)](https://github.com/lxgw/LxgwWenKai) —— UI 字体

灵感来源:

- [Wave Terminal](https://www.waveterm.dev/) —— 证明了"session 持久化"在精致 GUI 里也能做到
- [tmux](https://github.com/tmux/tmux) —— 证明了 session 应该比它的 UI 活得长
- [iTerm2](https://iterm2.com/) —— OSC 1337 的发明者,cwd 跟踪的无名英雄

---

> 做这个东西是因为 Windows Terminal 四年都没把 close-to-tray 做出来。
