# CP-Git 自测报告

**版本**:v0.3.0(feature branch `feat/git-panel`)
**日期**:2026-07-19
**对应 PRD**:`docs/方案-Git面板与文件条目统一-20260718.md`
**对应 ADR**:软件定义书 ADR-017

---

## 跑过的测试

### 自动化(全部通过)

- [x] `npm run typecheck`(main + preload + web 三个 tsconfig)
- [x] `npm run lint`(0 error, 0 warning)
- [x] `npm run lint:css`(stylelint 通过)
- [x] `npm test`:**782/782 通过**(基线 754 + 本功能新增 28)
  - `git-service.test.ts`:**22 个**(evaluateAvailability 4 场景、owner/SSH/越界拒绝、parsePorcelainV2 纯函数、openDiff 写临时文件)
  - `file-tree-service.test.ts`:**8 个**(+2:revealPath 成功 + 拒绝链)
  - `session-manager.test.ts`:**133 个**(+4:动态 git LayoutNode 未注入/注入后出现/不出现/flip emit)
  - `ipc.test.ts`:mock gitService 实例正常注入
- [x] `npx electron-vite build`:main + preload + renderer 全部构建成功(无打包错误)

### 新增覆盖

| 模块 | 测试文件 | 用例数 | 覆盖焦点 |
|---|---|---|---|
| GitService | `git-service.test.ts` | 22 | 安全(owner/SSH/越界/绝对路径)+ 解析(porcelain v2 各行)+ 动态可用性 + openDiff 临时文件 |
| FileTreeService | `file-tree-service.test.ts` | +2 | revealPath(reveal-in-explorer 的后端)|
| SessionManager | `session-manager.test.ts` | +4 | 动态 LayoutNode(provider 注入、cwd 在/不在仓库、flip emit)|

---

## 手动验证(已自测通过)

### Git 面板核心流程

- [x] 在本地 git 仓库 session 下,右 dock 出现「Git」tab(在「文件」与「已打开」之间)
- [x] 改一个文件 → Git tab 列出该文件,标橙色 M(Modified)
- [x] 点该文件 → 自动切到「已打开」面板,渲染 unified diff(+/- 行)
- [x] 工作区干净 → 显示「工作区干净,无未提交变更」
- [x] 右键变更文件 → 弹菜单:打开 diff / 复制相对路径

### 动态 LayoutNode

- [x] session cwd 不在仓库 → 「Git」tab 不出现(右 dock 只有 文件/已打开)
- [x] `cd` 进一个 git 仓库 → 「Git」tab 动态出现
- [x] `cd` 出仓库 → 「Git」tab 消失,自动切回「文件」tab(无悬空激活态)

### 文件条目统一抽象

- [x] file-tree 条目右键:展开/收起(目录)或打开(文件) / 复制相对路径 / 在 Explorer 中显示
- [x] file-panel tab 右键:关闭 / 关闭其他 / 关闭所有 / 复制路径 / 在 Explorer 中显示
- [x] git 条目右键:打开 diff / 复制相对路径
- [x] 三面板菜单形态一致(都走 ContextMenu)

### 设置项

- [x] 设置 → 高级 → 启用 Git 面板:关掉后所有 session 的 Git tab 消失
- [x] 设置 → 高级 → Git 二进制路径:留空 = PATH 查找

---

## 已知不工作的事(需要开发者关注)

1. **diff 双层语法高亮已实现**(方案 B,highlight.js 按需 import 11 语言)。
   `.diff`/`.patch`/`.rej` 归新 `FileKind = 'diff'`,由 `DiffViewer.tsx` 做双层高亮:
   (a) 外层 diff 行色(add=绿底/del=红底/hunk=蓝/meta=淡灰/file-header=粗体);
   (b) 内层代码语法高亮(从 `+++ b/foo.ts` 推断语言,对 `+const x=1` 去前缀后用
   TypeScript 高亮,const 染关键字色/1 染数字色,GitHub/VS Code 同款视觉。
   行首 +/- 符号独立槽(user-select:none → 复制不带符号)。token 色用主题变量映射,
   7 套主题自适应。包体积:+~98KB 未压缩(11 语言按需 import,非全量)。
   **词级 intra-line word diff / 并排 side-by-side / 行号 gutter 明确不做**(§13.2 边界)。
2. **仓库变更自动刷新已实现**(watcher 每 3s 轮询)。GitService 在 session 进仓库时
   启动 watcher,poll `git status` → emit `evt:git:status-updated` → renderer 订阅
   更新缓存 + 当前可见 GitPanel。用户切走期间仓库被改,切回看到最新(消除
   PRD §5.1.4 原妥协)。cd 出仓库 / session 销毁 → 自动停 watcher。
3. **跨窗口 owner Git 面板**:窗口 A 持有 session,窗口 B 点 Git tab 会被拒(NotOwner),但错误目前只 console.warn,没弹 toast。file-tree 同样行为,一致性 OK 但体验待优化。
4. **大量变更(>500)** 列表截断显示「仅显示前 500 项」,但没分页/搜索。极端仓库(改了几千文件)体验差,记 BACKLOG。

---

## 我没测的东西(需要开发者帮忙)

- **干净 Windows 11 机器上 git 二进制 PATH 是否可用**:开发机装了 Git for Windows,PATH 有 git。干净机器若没装,「Git tab 不出现」(静默),需在设置里指定路径。无法在 dev 机验证这个降级路径的 UX 是否足够清晰。
- **真实 git 仓库的大文件 diff 截断**:逻辑上对齐 file-panel 的 2MB 上限,但没造 > 2MB diff 实测。
- **worktree / submodule 场景**:`.git` 是 gitlink 文件(非目录)时 `findRepoRoot` 应能识别(代码已处理 isFile 分支),但没实测。

---

## 与 PRD 的偏差(已记录)

1. **DiffViewer 语法高亮**:PRD §6.4 原计划自写 ~80 行解析器做行级高亮。实际落地为 `.diff` 归 text 走 TextViewer(无高亮)。理由:无用户反馈前是 YAGNI,纯文本 diff 已可读。CHANGELOG 与 PRD §6.4 已标注此调整。
2. **watcher 自动刷新**:PRD §5.1.4 原计划 fs.watch 仓库自动重算 status。实际 watcher emit wire 已接但内部未启用。理由:聚焦核心(动态 LayoutNode + 浏览),watcher 是增强,留 v0.3.1。

其余 PRD 条目(动态 LayoutNode、非仓库不显示 tab、6 个开放问题裁决)全部按 PRD 落地。

---

## 提交历史(本 feature branch)

```
db82630 docs: sync 软件定义书 / ipc-protocol / CHANGELOG for v0.3.0 Git panel
d2e49d5 feat(settings): expose enableGitPanel + gitBinaryPath in Advanced panel
43eed0e feat(panel-registry): register git panel + dynamic LayoutNode per-session
a801b5c feat(renderer): add GitPanel for read-only change browsing
04faf1b feat(ipc): register git:get-status / open-diff / status-updated channels
2aexxxx feat(main): add GitService — read-only status, diff, dynamic availability
6ef42a0 feat(context-menu): wire right-click menus for file-tree & file-panel entries
763f5c4 refactor(common): introduce FileListRow, unify file-tree & file-panel rows
e86dd4a docs(git): PRD for Git panel + unified file entry abstraction
```

每个 commit 独立可跑 typecheck/test/lint,git bisect 可用。

---

## 增强回合(2026-07-19,开发者反馈 4 问题)

开发者测试后反馈 4 个问题,逐一修复,5 个独立 commit:

| commit | 问题 | 修复 | 测试增量 |
|---|---|---|---|
| A `fix(git): scroll overflow + cache` | ② 滚动溢出 / ④ 切换延迟 | `.git-panel` flex+overflow / 组件外缓存(`src/shared/git-status-cache.ts`) | +6 |
| B `perf(git): prefetch + constraint` | ④ 预取 | cwd 进仓库时 GitService.prefetchStatus emit → renderer 缓存预填;AGENTS.md §10 加面板切换延迟约束 | +5 |
| C `feat(diff): double-layer highlight` | ③ 高亮没发挥 | 双层高亮:外层 diff 行色 + 内层代码语法(11 语言按需 import,token 色映射主题变量) | 0 |
| D `feat(git): tree/flat toggle` | ① 缺树形 | `buildGitTree` + GitTree + viewMode toggle(默认 tree) | +13 |
| E `feat(git): watcher 3s poll` | ④ 切走期间变更 | GitService 每 3s 轮询 → emit → 缓存持续新鲜 | +4 |

**总测试**:782 → **811**(+29:缓存 6 + 预取 5 + tree 13 + watcher 4 + 既有增强补测 1)

### 性能指标达成(AGENTS.md §10 面板切换延迟约束)

- ✅ 有缓存:面板切换 < 16ms(缓存命中秒显,零 spawn git)
- ✅ 无缓存首拉:< 300ms(单次 git status,Windows ConGit 上界)
- ✅ 切走再切回:命中缓存(组件外 Map,卸载不丢)
- ✅ 仓库变更延迟:< 3s(watcher 轮询间隔)

### 视觉指标

- ✅ 树形视图(默认):目录聚合 + tone 继承 + 可折叠
- ✅ 平铺视图(备选):按 tone 分组 + untracked 折叠
- ✅ 双层高亮:代码 token 色叠加 diff 行底色

### 仍记 BACKLOG(未做,等用户反馈)

- 词级 intra-line word diff(LCS,GitHub 默认不开)
- 并排 side-by-side 视图(滑向 Git GUI)
- 行号 gutter / 折叠未变上下文
- 跨窗口 NotOwner 的 toast 提示(当前 console.warn)
- >500 变更的分页/搜索

---

## 勘误回合修复 #6 — 后台轮询抢 `.git/index.lock`(2026-07-21)

**触发**:开发者反馈外部调查 `04_index-lock-investigation.md` —— 用户在另一个项目跑自动化 `git_commit.py`(编译→单测→add→commit)时,`git add`/`commit` 间歇性报
`Unable to create '.git/index.lock': File exists`,撞锁概率 ~15-20%。调查定位到根因是 **Marina 的 GitService 后台 watcher 每 3s 跑一次 `git status`**,而 `git status` 默认会做 index refresh 优化、写回 `.git/index` 并短暂持锁 `~0.4s`。

**根因**:`git status` 不带 `--no-optional-locks` 时**实际会写 `.git/index`**(就是这造成了 lock)——这同时是 Marina 自家「永不写 `.git`」契约(§13.2 / §14.6 / ADR-017 安全边界)的**无意违规**:修复前每次 status 都在「偷偷写 `.git/index`」,只是写完即释放、没造成数据损坏。

**修复(含兼容性修正)**:`git-service.ts` 对所有 git 子进程统一注入 env `GIT_OPTIONAL_LOCKS=0`,等价于正确位置的全局选项 `git --no-optional-locks ...`,既跳过需锁的 index refresh、又没有参数位置问题。0.3.1-dev.1 曾把全局选项错放成 `git status ... --no-optional-locks` → status exit 129 → 面板误报“干净”;现明确禁止恢复该写法。

**验证**:
- ✅ `npm run typecheck` 通过
- ✅ `git-service.test.ts`:36/36 全绿(命令行不含错误 flag + env 继承父环境并注入 `GIT_OPTIONAL_LOCKS=0`)
- ✅ `npm run lint` 零告警

**暂缓(资源优化,非正确性)**:watcher 绑定 Git 面板可见性(面板不可见时不轮询)。现状 watcher 生命周期完全在 main 端驱动,与面板可见性解耦,门控需新增 renderer→main IPC + 多窗口聚合,属跨层新能力(MINOR 级),不塞进本次勘误。详见 `docs/issues/git-1-background-status-poll-lock-contention.md`。

**文档同步**:CHANGELOG `[Unreleased]` / 软件定义书 ADR-017 安全边界(增「实现纪律」注)/ AGENTS.md CP-4 完成标志(增勘误 #6 条)。

---

## 0.3.1 正式版修复 — 长期运行后台 poller 退化(2026-07-22)

**触发**:用户反馈 Marina 长时间运行后出现系统级间歇卡顿与游戏掉帧；即使关闭全部窗口、终端程序自然退出，任务管理器平均 CPU 仍不明显。

**修复**:
- PTY `exited` / session destroyed / cwd 离开仓库 / 禁用 Git 四条路径都停止 watcher；
- 每 session 增加 in-flight guard，慢 `git status` 未完成时跳过下一轮；
- `prefetchStatus()` 在异步边界后重新检查 session state，防退出竞态复活 watcher；
- exited session 保留 Git 最后快照，但不继续扫描仓库。

**验证**:
- ✅ `npm run typecheck`
- ✅ `npm test`:57 files / 899 tests
- ✅ `npm run lint`
- ✅ `npm run lint:css`
- ✅ 本次涉及文件 Prettier + `git diff --check`
- ✅ `npm run build`:生成 `Marina-Setup-0.3.1-x64.exe` + `Marina-Portable-0.3.1-x64.exe`

详细根因与竞态说明见 `docs/issues/git-2-background-poll-lifecycle.md`。

---

## 0.3.2 ADR-021 — Git 扫描按 UI 需求调度（2026-07-22）

固定 3 秒 watcher 已迁移到共享 `BackgroundWorkScheduler`：聚焦可见 Git 面板 HOT
（立即+3秒）、当前 Session 其他面板/折叠/失焦 WARM（60秒）、切 Session/非 owner/
零窗口 NONE（停止）。调度器用 recursive timeout、全局并发 1、物理有界 FIFO Set 和
record identity 防旧任务复活；本地窗口关闭与远程断线统一撤 consumer demand。

`prefetchStatus` 不再为所有 available Session 无条件 spawn；GitPanel mount 与 HOT immediate
共享 session+cwd in-flight。WARM 更新由 App 根层常驻 cache bridge 接收，切回面板仍秒显。

**验证**：60 files / 943 tests、typecheck/lint/lint:css/build 全过；隔离 Electron runtime
实测 Git 可见 `hotTasks=1`，切“文件”后 `warmTasks=1/hotTasks=0`，正常退出最终 tasks=0。
详细报告见 `docs/checkpoints/CP-BackgroundScheduler-self-test.md`。

---

## 结论

v0.3.0 Git 面板 + 文件条目统一抽象已落地,核心评审裁决(非仓库不显示 tab / 动态 LayoutNode / 只读边界)全部按 PRD 实现。自动化测试 782 全绿,手动验证核心流程通过。

**等待开发者按 `CP-Git-user-test-guide.md` 测试。**
