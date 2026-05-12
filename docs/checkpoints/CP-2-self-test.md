# CP-2 自测报告

> **历史档案**:本文件创建于 alpha 阶段,产品当时叫 EasyTerm,自 v1.5 起更名为 Marina(见软件定义书 ADR-012)。下文 "EasyTerm" 字样保留作为时间点快照。


**完成日期**：2026-05-10
**对应分支**：`checkpoint-2`
**最新 commit**：见 `git log --oneline checkpoint-2`

---

## 已通过的自动化测试

```
$ npm test
✓ src/main/window-manager.test.ts   (19 tests)
✓ src/main/path-manager.test.ts     (36 tests)
✓ src/main/persistence.test.ts      (18 tests)
✓ src/main/settings-manager.test.ts (31 tests)
✓ src/main/session-manager.test.ts  (21 tests)
✓ src/main/pty-utils.test.ts        (11 tests)
✓ src/main/platform/index.test.ts   ( 7 tests)
✓ src/shared/protocol.test.ts       ( 6 tests)

Test Files  8 passed
     Tests  149 passed
```

```
$ npm run test:coverage   (核心数据模块覆盖率)
path-manager.ts     97.56%
persistence.ts      96.77%
session-manager.ts  96.19%
settings-manager.ts 93.83%
window-manager.ts   90.49%
pty-utils.ts       100.00%
platform/index.ts  100.00%
shared/protocol.ts 100.00%
─────────────────────────
All (核心模块)      96.45%   ← AGENTS.md 5.5 CP-2 目标 70%
```

排除的文件（按 AGENTS.md 5.4，wiring/集成代码不要求单测）：
- `index.ts` — Electron 入口装配
- `ipc.ts` — handler 仅做转发
- `tray.ts` — Electron Tray API 强绑定
- `platform/{macos,linux,windows}.ts` — V1 占位 / 跨平台未实测

```
$ npm run typecheck   通过 (3 个 tsconfig 严格模式)
```

---

## CP-2 完成标志逐条对照（AGENTS.md 4.2）

| 标志 | 实现 | 验证方式 |
|---|---|---|
| 侧栏显示"收藏 / 临时 / 最近"三栏（均为空时也显示） | ✅ | `Sidebar.tsx` 三个 `<Category>`，空时显示"空"占位 |
| 能通过 + 按钮选文件夹加入收藏 | ✅ | 收藏栏 + 按钮 → `cmd:bookmark:pick-folder` → 原生对话框 → `cmd:bookmark:add` |
| 关闭再开应用，收藏还在 | ✅ | `JsonStore` 原子写 `bookmarks.json`，重启 `PathManager.initialize` 加载 |
| 能通过 Explorer 拖文件夹到侧栏加入收藏 | ✅ | `sidebar-bookmarks-dropzone` 监听 `dragover/drop`，从 `dataTransfer.files` 取 `path` 属性后 `cmd:bookmark:add` |
| 在某收藏路径双击 → 该路径下出现一个 session | ✅ | `PathItem` 的 `handleDoubleClick` → `cmd:session:create` |
| 关闭那个 session → 路径仍在收藏里 | ✅ | `PathManager.detachSession` 检测到 path 在收藏分类，不流转 |
| 在某非收藏路径新建终端 → 路径自动出现在"临时" | ✅ | `PathManager.attachSession` 触发状态机，path 不在 bookmark 集合则归类为 temporary |
| 关闭该路径所有终端 → 临时移到"最近" | ✅ | `PathManager.detachSession` 最后一个 session 走的时候 `touchRecent` |
| 开第二个窗口（从托盘菜单）→ 第二个窗口看到相同的侧栏数据 | ✅ | IPC 层 `evt:path:tree-updated` broadcast 给所有窗口；新窗口启动时 `cmd:app:get-snapshot` 拿全量 |
| 在窗口 A 改设置（主题）→ 窗口 B 立即同步 | ✅* | `evt:settings:changed` broadcast；header 主题切换按钮 cycle 5 个 ID。*仅同步 setting 数据，颜色应用在 CP-4* |
| 关闭窗口 A → 持有的所有 session 在窗口 B 变"无 owner"，可接管 | ✅ | `WindowManager.onWindowClosed` → `SessionManager.handleWindowClosed` 把 owner 设 null（不杀 PTY） + broadcast `evt:session:owner-changed`；侧栏点击灰显 → `cmd:session:claim` |
| 后端核心模块测试覆盖率 > 70% | ✅ | 实测 96.45% |

---

## 主要架构变化（vs CP-1）

1. **PtyController 删除**，由 **SessionManager** 完整接管：
   - sessionId UUID，与 windowId 解耦
   - `ownerWindowId` 字段独立，可为 `null`
   - 窗口关闭 → owner 变 null（不杀 PTY），关键的"跨窗口接管"基础
   - 可注入 `spawnFn` 完全绕开 node-pty 写测试

2. **PathManager** 新增（96 行 + 36 测试）：
   - 完整 8.2 状态机
   - 三分类无重叠（优先级：收藏 > 临时 > 最近）
   - normalize path 作为稳定 id
   - recent 容量上限 30 自动淘汰

3. **PersistenceManager (JsonStore)** 新增（18 测试）：
   - 原子写：临时文件 → fsync → rename
   - 主文件 → .bak → 默认值 三层 fallback
   - debounce 500ms
   - 串行化 + flush 期间 set 不丢更新

4. **SettingsManager** 新增（31 测试）：
   - DEFAULT_SETTINGS 完整默认 + deep-merge 自动补缺字段
   - 校验 + emit `settingsChanged` 含 `changedKeys` dotted path

5. **IPC 层** 完整重写（`src/main/ipc.ts`，553 行）：
   - 注册全部 cmd:* handler
   - 桥接 manager 事件 → broadcast/sendTo
   - cmd:app:get-snapshot 一次性给 renderer 全量状态
   - bookmark:add 校验是目录非文件

6. **Renderer** 完整重构：
   - `store.tsx`：Context + reducer + IPC sync hook
   - `Sidebar.tsx`：三栏 + 折叠 + drag-drop + + 按钮
   - `MainPane.tsx`：TabBar + EmptyState + 多 session
   - `TerminalView.tsx`：去掉自创建 session，由父组件传 session prop

---

## 已知 CP-2 范围内不实现的（留给后续 CP）

按设计：

- **Session 墓地** (5 分钟保留) → CP-3
- **Scrollback ring buffer** → CP-3（影响："切换 session 后切回看不到历史"，"接管无主 session 也看不到历史"）
- **OSC 1337 cwd 跟踪** → CP-3
- **16ms 字节流聚合** → CP-3
- **完整启动模板** (Claude Code / Codex / OpenCode 等) → CP-3，CP-2 仅 'shell'
- **完整设置 UI** + 主题颜色实际切换 → CP-4
- **打包成 .exe / msi** → CP-4
- **应用打包 / 完全退出确认 / Explorer 集成等** → CP-4
- **完全退出前的 session 在跑确认对话框** → CP-3（需要 SessionManager 知道有 session）

---

## 我没自己端到端跑过的事（需要开发者测）

CP-2 增量功能需要人手 GUI 验证。`CP-2-user-test-guide.md` 列了 10 项具体测试。

**要紧的开发者注意点**：
- 第一次运行 CP-2 前，先把 CP-1 跑过的窗口完全退出（托盘 → 完全退出 EasyTerm），避免 PtyController 与 SessionManager 的旧 bookmark 数据竞争
- CP-2 数据持久化在 `%APPDATA%\EasyTerm\` 下：`bookmarks.json` / `recent.json` / `settings.json`，可以打开看
- 删 `%APPDATA%\EasyTerm\` 整个目录可重置一切（CP-2 简化做法）

---

## 给开发者的话

CP-2 是数据层的"重头戏"——后端架构基本到位。CP-3 起会是体验打磨：墓地、cwd 跟踪、模板、scrollback。

如果你测试时发现：
- 某条 IPC 命令报 SessionNotFound / PathNotFound 等：先看主进程日志，错误 message 带详细诊断
- 拖文件夹到侧栏没反应：可能你的 Electron 没暴露 `file.path`，DevTools Console 试 `console.log(event.dataTransfer.files[0].path)`，没值就告诉我（可能要 `webPreferences.webSecurity` 或其他）
- bookmark 添加失败"PathNotDirectory"：你拖的是文件不是目录

下个检查点 CP-3 我**不会自动开始**，等你确认 "CP-2 通过"。
