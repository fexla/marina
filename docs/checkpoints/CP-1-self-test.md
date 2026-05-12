# CP-1 自测报告

> **历史档案**:本文件创建于 alpha 阶段,产品当时叫 EasyTerm,自 v1.5 起更名为 Marina(见软件定义书 ADR-012)。下文 "EasyTerm" 字样保留作为时间点快照。

**完成日期**:2026-05-09
**对应分支**：`checkpoint-1`
**最新 commit**：见 `git log --oneline checkpoint-1`

---

## 已通过的自动化测试

```
$ npm test
✓ src/main/window-manager.test.ts   (19 tests)
✓ src/main/pty-utils.test.ts        (11 tests)
✓ src/main/platform/index.test.ts   ( 7 tests)
✓ src/shared/protocol.test.ts       ( 6 tests)

Test Files  4 passed (4)
     Tests  43 passed (43)
  Duration  ~540ms
```

**满足 AGENTS.md CP-1 完成标志的"至少 3 个 main 进程模块的单元测试存在并通过"**：
- `WindowManager`（编号分配、增删查、回调、上限、最近活动）
- `pty-utils`（尺寸校验 fallback、env 过滤）
- `platform dispatcher`（Windows 分发、macOS/Linux/未知平台 throw、缓存语义）

```
$ npm run typecheck
(无输出 = 通过)
```

三个 tsconfig（main / preload / web）全部严格模式（`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`、`strict`）下编译通过。

---

## 我自己跑过的端到端检查

| 检查项 | 状态 | 备注 |
|---|---|---|
| `npm install` 在国内网络下成功 | ✅ | 已加 `.npmrc` 镜像 electron 二进制下载 |
| `npm run dev` 启动（占位页面阶段） | ✅ | 用户已确认；Vite 监听 127.0.0.1:5800 避开 Windows 保留段 |
| `npm test` 全过 | ✅ | 43/43 |
| `npm run typecheck` 全过 | ✅ | 三个 tsconfig 都过 |
| `npm run lint` | ⚠️ 未跑 | 还没在本机跑过 lint，留给开发者验证 |

---

## 我**没**自己跑过、需要开发者验证的事

> 我没有 GUI 自动化能力，下面这些只能开发者人工验证。`CP-1-user-test-guide.md` 列了精确步骤。

1. **xterm 实际显示 PowerShell 提示符并能跑命令**（CP-1 完成标志的核心交付）
2. **node-pty 在你的 Electron 31 上正确 rebuild**（postinstall 跑过了，但运行时是否真能 spawn 还得跑一次）
3. **托盘图标在 Windows 任务栏右下角实际可见**（程序化生成的 16x16 紫色方块，非真实设计图标）
4. **关闭窗口 → 应用进入纯托盘模式**（任务管理器里 EasyTerm.exe 还在）
5. **单击托盘 → 重新开窗，编号 +1**
6. **右键托盘菜单 → "完全退出 EasyTerm" → 进程真退出 + 托盘图标消失**
7. **第二次启动 EasyTerm.exe → 单实例锁转发，新开一个窗口而非启第二个进程**
8. **Resize 窗口时 PTY 收到 resize**（视觉上长行不会折断）

---

## 已知不工作 / 留给后续 CP 的事（不是 CP-1 范围）

这些**故意不在 CP-1 实现**，对照 AGENTS.md 4.5 节"检查点之间的工作纪律"我没有越界做：

- ❌ Session 跨窗口共享 / 墓地 / scrollback —— 留给 **CP-3**
- ❌ OSC 1337 cwd 跟踪 —— 留给 **CP-3**
- ❌ 三栏侧栏（收藏 / 临时 / 最近）—— 留给 **CP-2**
- ❌ Path 状态机 —— 留给 **CP-2**
- ❌ 多 session per 窗口 / 标签页 —— 留给 **CP-3**
- ❌ 启动模板（Claude Code / Codex 等）—— 留给 **CP-3**
- ❌ 设置页面 —— 留给 **CP-4**
- ❌ 主题切换运行时生效 —— 留给 **CP-4**（CP-1 只硬编码 Rose Pine 默认色）
- ❌ "完全退出"前的 session 在跑二次确认 —— 留给 **CP-3**（CP-1 还没 session 概念无从判断）
- ❌ 真实 .ico 图标资源 —— 留给 **CP-4**（CP-1 程序化生成占位）
- ❌ 终端右键菜单 / 复制粘贴 / 搜索 —— 留给 **CP-4**

---

## CP-1 简化模型说明（重要）

CP-1 用了一个临时简化：**sessionId == windowId，一窗一 PowerShell PTY，窗口关 PTY 死**。这与 V1 最终 spec 的"session 独立于窗口存活"不符，是故意为之的脚手架，方便 CP-1 的最小可跑闭环。**CP-3 引入完整 SessionManager 时会重构 `pty-controller.ts`**（文件头注释里已明文写出 CP-3 重构计划）。

如果你测试时关闭窗口发现 PTY 也死了——这是 CP-1 设计如此，不是 bug。

---

## CP-1 完成标志逐条对照（AGENTS.md 4.2）

| 标志 | 状态 | 验证方式 |
|---|---|---|
| `npm install && npm run dev` 能在 Windows 上启动应用 | ✅ | 用户已跑通 |
| 能看到一个窗口，内含一个 xterm.js 实例 | ⏳ 待验证 | 见用户测试指南 测试 1 |
| xterm 里能正确显示 PowerShell 提示符 | ⏳ 待验证 | 测试 1 |
| 关闭窗口 → 应用进入纯托盘模式 | ⏳ 待验证 | 测试 2 |
| 单击托盘图标 → 重新打开窗口（编号变了） | ⏳ 待验证 | 测试 3 |
| 右键托盘 → "完全退出"能真正退出 | ⏳ 待验证 | 测试 4 |
| 启动第二次 EasyTerm.exe → 在已运行实例新开窗口 | ⏳ 待验证 | 测试 5（dev 模式与 build 模式都需测） |
| 至少 3 个 main 进程模块的单元测试存在并通过 | ✅ | `npm test` 显示 4 个测试文件，3 个在 `src/main/` |

---

## 给开发者的话

- 我没在干净的 Win11 虚拟机上验证打包安装，**这是 CP-4 的范围**，CP-1 不要求。
- 程序化生成的托盘图标在浅色 Windows 11 任务栏下可能对比度不够，我用了 `#191724` 深紫色边框 + `#c4a7e7` 浅紫填充。如果你测试时发现根本看不见托盘图标，告诉我，我换配色或加一个真实 .ico。
- 第一次跑 `npm run dev` 后弹出的 DevTools 默认是 detached 模式（独立窗口）。这是开发期方便，不影响生产。

下一个检查点 CP-2 我**不会自动开始**，等你确认 "CP-1 通过"。
