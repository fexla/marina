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

1. **diff 语法高亮未做**。本期 `.diff` 归 text 走 TextViewer 纯文本渲染(+/- 前缀有视觉区分但无高亮)。DiffViewer 增强组件记到 BACKLOG,待用户反馈后做(v0.3.1)。
2. **仓库变更不自动刷新 Git 面板内容**。watcher 的 emit wire 已接好(`evt:git:status-updated`),但 GitService 内部的 fs.watch 暂未启用。当前:用户切回 Git tab 不会自动重拉(需关 tab 重开或切 session)。这是 PRD §5.1.4 的最小可行权衡,watcher 启用后零改动消除该限制。
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

## 结论

v0.3.0 Git 面板 + 文件条目统一抽象已落地,核心评审裁决(非仓库不显示 tab / 动态 LayoutNode / 只读边界)全部按 PRD 实现。自动化测试 782 全绿,手动验证核心流程通过。

**等待开发者按 `CP-Git-user-test-guide.md` 测试。**
