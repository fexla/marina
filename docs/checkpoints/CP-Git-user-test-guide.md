# CP-Git 用户测试指南

**版本**:v0.3.0(feature branch `feat/git-panel`)
**预计测试时间**:15-20 分钟
**对应 PRD**:`docs/方案-Git面板与文件条目统一-20260718.md`

---

## 准备

1. 切到 `feat/git-panel` 分支:`git checkout feat/git-panel`
2. `npm install`(若依赖有变;本分支无新依赖)
3. `npm run dev` 启动应用
4. 准备一个本地 git 仓库(或用 Marina 自己的仓库 `D:\data\projects\agent\marina`)

---

## 测试 1:Git 面板基础(预计 3 分钟)

**前提**:在 Marina 里打开一个**本地 git 仓库**的 session(例如 cwd = `D:\data\projects\agent\marina`)。

1. 看右侧 dock 的 tab 条
2. **预期**:出现三个 tab:**`[文件] [Git] [已打开]`**(Git 在中间)
3. 点「Git」tab
4. **预期**:列出当前仓库的工作区变更,按状态分组(冲突置顶 > 已修改(橙) > 已新增(绿) > 已删除(红) > 已重命名(蓝) > 未跟踪(灰,默认折叠))
5. 改一个文件(比如在仓库里 `echo test >> README.md`),回 Git tab
6. **预期**:README.md 出现在「已修改」组,标橙色 `M`

**失败现象**:Git tab 不出现 / 列表为空 / 状态色错
**失败时**:看 `~/AppData/Roaming/Marina/logs/main.log`,搜 `GitService`,贴最后 20 行给 agent

---

## 测试 2:看 diff(预计 2 分钟)

1. 在 Git tab 点一个变更文件(比如改过的 README.md)
2. **预期**:自动切到「已打开」tab,渲染出 unified diff
   - `---` / `+++` 头
   - `-` 开头的行(删除)
   - `+` 开头的行(新增)
   - `@@` hunk header
3. 点「Git」tab 切回,再点另一个文件
4. **预期**:「已打开」tab 累积多个 diff 文件,可切换

**失败现象**:点文件无反应 / diff 不显示 / 切不过去
**失败时**:看 main.log 搜 `openDiff` / `runGit`

---

## 测试 3:动态 LayoutNode(预计 3 分钟)★ 关键

1. 打开一个**非 git 仓库**的 session(比如 cwd = `C:\Users\<你>\Downloads`,假设不是仓库)
2. **预期**:右 dock 只有 **`[文件] [已打开]`** 两个 tab,**没有 Git tab**
3. 在该 session 的终端里 `cd` 进一个 git 仓库(比如 `cd D:\data\projects\agent\marina`)
4. **预期**:**「Git」tab 自动出现**(无需重开 session)
5. 再 `cd` 回非仓库目录
6. **预期**:**「Git」tab 消失**,当前激活的 tab 自动切回「文件」(不悬空)

**失败现象**:cd 后 tab 不出现/消失 / 消失后激活态悬空
**失败时**:看 main.log 搜 `git availability` / `applyGitAvailability`

---

## 测试 4:右键菜单统一(预计 3 分钟)

### 4a. file-tree 右键
1. 在「文件」tab 右键任意文件
2. **预期**:弹菜单 → `展开/收起`(目录)或 `打开`(文件) / `复制相对路径` / `在 Explorer 中显示`

### 4b. git 右键
1. 在「Git」tab 右键一个变更文件
2. **预期**:弹菜单 → `打开 diff` / `复制相对路径`

### 4c. file-panel 右键
1. 先在 Git tab 点几个文件,让「已打开」有内容
2. 在「已打开」tab 右键一个 diff 文件 tab
3. **预期**:弹菜单 → `关闭` / `关闭其他` / `关闭所有` / `复制路径` / `在 Explorer 中显示`
4. 点「关闭其他」
5. **预期**:除当前 tab 外其他都关闭

**失败现象**:菜单不弹 / 项缺失 / 点击无反应
**失败时**:开 DevTools(`Ctrl+Shift+I`)看 console 报错

---

## 测试 5:设置项(预计 2 分钟)

1. 设置 → 高级
2. **预期**:看到「启用 Git 面板」开关(默认开) + 「Git 二进制路径」输入框(默认空)
3. 关掉「启用 Git 面板」
4. **预期**:所有 session 的 Git tab 立即消失(无需重启)
5. 重新打开
6. **预期**:Git tab 重新出现

**失败现象**:开关无效 / 重启才生效
**失败时**:看 main.log 搜 `recomputeGitAvailability`

---

## 测试 6:边界场景(预计 3 分钟)

### 6a. 工作区干净
1. 在 git 仓库 session 里 `git stash`(或 commit 所有改动),让工作区干净
2. 点「Git」tab
3. **预期**:显示「工作区干净,无未提交变更」

### 6b. SSH session(若有 SSH profile)
1. 连一个 SSH session,cwd 是远程 git 仓库
2. **预期**:**「Git」tab 不出现**(SSH 不支持,不引入远端 git)
3. 不应有错误提示 / 不应崩溃

### 6c. 大量变更
1. 在仓库里 `for i in $(seq 1 600); do touch bulk_$i.txt; done`(造 600 个未跟踪文件)
2. 点「Git」tab,展开「未跟踪」组
3. **预期**:列表截断,显示「变更过多,仅显示前 500 项」
4. 清理:`rm bulk_*.txt`

---

## 全部通过后

回复 agent:**「CP-Git 通过,可以合并」**

如果有问题,按 `docs/cp{N}勘误.md` 惯例整理成 `docs/cpGit勘误.md`,agent 进勘误回合修复。

---

## 验收用例对照(PRD §11)

| # | 场景 | 对应测试 |
|---|---|---|
| 1 | 本地 git 仓库,有改动 | 测试 1 |
| 2 | 看 diff | 测试 2 |
| 3 | 仓库干净 | 测试 6a |
| 4 | 非 git 仓库 | 测试 3 |
| 5 | SSH session | 测试 6b |
| 6 | repoRoot 在 cwd 祖先 | (未单独测,理论 git -C 处理) |
| 7-9 | 右键菜单三场景 | 测试 4 |
| 10 | enableGitPanel=false | 测试 5 |
| 11 | git 二进制缺失 | (设置页可指定路径,未造缺失场景) |
| 12 | 跨窗口 owner | (未单独测,走 NotOwner 拒绝) |
| 13 | diff 自动刷新 | ⚠️ 已知不做(watcher 未启用,见自测报告) |
| 14 | 大量变更 | 测试 6c |
| 15 | cd 进出仓库 | 测试 3 ★ |
