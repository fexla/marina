# git-1 · Git 面板后台轮询抢 `.git/index.lock`,干扰外部 git 写操作

**首次发现**:2026-07-21(用户反馈,见外部调查文档 `04_index-lock-investigation.md`)
**严重度**:高(会直接导致用户在终端外部跑的 `git commit` / `git add` 失败)
**状态**:**根因已修**(2026-07-21,`GIT_OPTIONAL_LOCKS=0`);一项资源优化暂缓(见下)

---

## 现象

用户在另一个项目(CharacterMarbleIdle,Unity 游戏)里用自动化脚本 `git_commit.py`
跑 `编译 → 单测 → git add → git commit` 的流水线。`git add`/`git commit` 间歇性
报 `Unable to create '.git/index.lock': File exists`,概率约 15-20%。

外部调查(原 agent)一度怀疑是「git worktree 互相干扰」,后被 `git worktree list`
证伪——p2/p3 是独立 clone,不是 worktree。

## 根因

**Marina 的 GitService 后台 watcher**(`src/main/git-service.ts`)。

- session 的 cwd 一旦进仓库(flip 到 available),`prefetchStatus` 无条件
  `startWatcher`,**与 Git 面板可见性无关**——哪怕用户根本没打开 Git 面板,也在后台跑。
- watcher 是 `setInterval(3000)`:每 3s 跑一次
  `git -C <repo> status --porcelain=v2 -z --untracked-files=all`。
- `git status` **默认会做 index refresh 优化**:把 stat-smudged 的 index 刷新后**写回
  `.git/index`**,为此**短暂持有 `.git/index.lock`(~0.4s)**。
- 用户的提交类操作没有重试时,只要撞上那 0.4s 窗口就失败。

实测主项目 `.git/index.lock` 在 8 秒内被创建/释放 3 次,每次 ~0.4s;抓 lock 存在瞬间
的 `git.exe` 命令行正是上面那条 status,父进程是 `Marina.exe`。证据链完整。

### 附带发现:原则违规

`AGENTS.md` / `软件定义书 §13.2 / §14.6` 反复声明 GitService「**只调 git status /
git diff,永不写 .git**」。但未禁用 optional locks 的 `git status` 会写 `.git/index`
(就是这造成了 lock)——也就是说修复前 Marina 每天都在「偷偷写 .git」,只是写完
就释放、没造成数据损坏而已。这是对自家设计契约的**无意违规**。

## 已修(根因)

`git-service.ts` 的 `runGit` 对所有 git 子进程统一注入 env
`GIT_OPTIONAL_LOCKS=0`。

- 效果等同正确位置的全局选项 `git --no-optional-locks ...`:git 跳过 index refresh
  写回,不再创建 `.git/index.lock`;状态结果仍包含 modified/untracked。
- 兼容性修正:0.3.1-dev.1 曾把全局选项错放成
  `git status ... --no-optional-locks`,status 因 unknown option exit 129,导致 Git 面板
  误报“干净”。env 方案没有参数位置问题。
- 同时让 Marina 严格符合「永不写 .git」契约。

回归保护:`git-service.test.ts` 断言 status args 不含错误 flag,并断言
`buildGitSpawnEnv` 保留父环境且注入 `GIT_OPTIONAL_LOCKS=0`。真实 Git
2.49.0.windows.1 Unity 仓库验证 status exit 0、能列出全部改动。

## 暂缓:watcher 绑定面板可见性(资源优化,非正确性)

`GIT_OPTIONAL_LOCKS=0` 消除了**正确性**问题(不再抢锁/不再写 .git)。剩余的是**资源**
问题:即使用户没看 Git 面板,后台仍在每 3s 跑一次 `git status`。中等仓库(<50ms)可忽略,
大仓库(如 Unity 项目,200ms+)+ 多 session 叠加时是实打实的 CPU/IO 浪费。

**为什么本期不做**:

- 现状 watcher 生命周期**完全在 main 端**驱动(`index.ts:471` →
  `sessionManager.attachGitStatusPrefetcher` → `prefetchStatus`),触发条件是
  「cwd 进仓库」,与面板可见性**解耦**。
- 面板可见性只在 renderer 端有(`store.tsx` 的 `activePanels` Map + `LayoutHost`
  派生 `activePanelId`),**没有 IPC 信号**告知 main「Git 面板对 session X 现在
  可见/不可见」。
- 要门控需新增:renderer→main 的面板可见性 IPC + Git 面板 mount/unmount 时 emit +
  多窗口语义(任一窗口可见即应轮询)+ 切换边角态处理。这是**跨层新能力**,按附录 E
  属 MINOR 级,不该塞进一次勘误。
- AGENTS.md §10:「保持简单是最好的性能策略」「不要在没问题的地方做性能优化」。

**触发条件(何时该做)**:

- 用户反馈大仓库下 CPU/风扇明显(多个 Unity session 同时开)。
- 或与 `.git/index` 的 `fs.watch` 即时刷新方案一起做(见
  `方案-Git面板增强-20260719.md` 层 3:该方案本就考虑过 watch `.git/index` +
  定时 status,届时可顺带把「定时」改成「面板可见才定时」)。

**实现草图(给未来做的人)**:

1. 新增 IPC `cmd:git:setPanelInterest`(renderer→main),payload = `{ sessionId, visible: boolean }`。
2. renderer:`GitPanel.tsx` 的 `useEffect` mount/unmount(或 LayoutHost 的
   `activePanelId` 切换)时 emit;多窗口下 main 端用 Set<windowId> 聚合,非空才轮询。
3. GitService:`prefetchStatus` 启 watcher 前判「是否有任一窗口对它感兴趣」;新增
   `setPanelInterest(sessionId, windowId, visible)` 维护该集合,空则 `stopWatcher`。
4. 边角态:面板瞬切(切走又秒切回)不应导致 watcher 反复 start/stop → 加短 debounce,
   或保留「最近一次 status 结果 + 组件外缓存」让重开瞬间有东西可看(`git-status-cache.ts`
   已具备此能力,见 `方案-Git面板增强` 层 1/2)。

## 关键文件

- `src/main/git-service.ts`:`runGit` / `getStatus` / `getStatusInternal` /
  `produceDiff` / `startWatcher`(786 行 `WATCHER_POLL_MS = 3000`)/ `prefetchStatus`(276 行)
- `src/main/git-service.test.ts`:getStatus 组装测试 + `GIT_OPTIONAL_LOCKS=0` 回归断言
- `src/main/index.ts:471`:`attachGitStatusPrefetcher` 注入点
- `src/renderer/store.tsx`:`activePanels` Map(panel 可见性真值源)
- `src/renderer/components/layout/LayoutHost.tsx`:派生 `activePanelId`
- `src/shared/git-status-cache.ts`:renderer 端组件外缓存(门控方案的依赖)

## 参考

- 外部调查文档(证据链):`04_index-lock-investigation.md`(temp 目录)
- 设计背景:`docs/方案-Git面板增强-20260719.md` 层 3(watcher 设计选型)
- git 文档:`GIT_OPTIONAL_LOCKS` / 全局选项 `git --no-optional-locks ...`
