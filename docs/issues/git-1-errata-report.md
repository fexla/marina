# 勘误回合报告：Git 面板后台轮询抢 `.git/index.lock`

**日期**:2026-07-21 · **分支**:`feat/git-panel` · **对应调查**:`04_index-lock-investigation.md`

---

## 一句话结论

调查定位的根因(GitService 后台每 3s 跑 `git status`、抢 `.git/index.lock` 干扰外部 `git commit`)**已根治**——所有 `git status` 调用加 `--no-optional-locks`,不再持锁、不再写 `.git/index`,同时补齐 Marina 自家「永不写 `.git`」契约。typecheck / test(857 全绿)/ lint 全过。

## 根因(比调查更深一层)

调查停在「Marina 轮询 git status 抢锁」。但验证代码后发现**更本质的点**:

`git status` **不带 `--no-optional-locks` 时默认会做 index refresh 优化、写回 `.git/index`**——这就是锁的来源。也就是说,**修复前 Marina 每次 status 都在「偷偷写 `.git/index`」**,只是写完即释放、没造成数据损坏。这直接违反 AGENTS.md / 软件定义书 §13.2 / §14.6 / ADR-017 反复声明的 **GitService「永不写 `.git`」契约**。

→ 所以这不只是「性能/锁竞争」问题,而是**原则性违规**。`--no-optional-locks` 一举两得:消除锁竞争 + 恢复契约合规。

## 改了什么

| 文件 | 改动 |
|---|---|
| `src/main/git-service.ts` | **3 处** `git status` 调用(`getStatus` / `getStatusInternal` 后台轮询路径 / `produceDiff` 单文件查)全部加 `--no-optional-locks` flag,每处带「为什么」注释 |
| `src/main/git-service.test.ts` | 新增回归断言:status 调用的 args 必须含 `--no-optional-locks`,误删即测试失败 |
| `CHANGELOG.md` | `[Unreleased]` 段记一条(**不 bump 版本**,符合附录 E:dev 未分发) |
| `docs/软件定义书.md` | ADR-017 安全边界加「实现纪律」注,钉死「status 必须带 `--no-optional-locks`」 |
| `AGENTS.md` | CP-4 完成标志加「勘误 #6」checkbox |
| `docs/checkpoints/CP-Git-self-test.md` | 文末加「勘误回合修复 #6」章节 |
| `docs/issues/git-1-...md` | **新建** issue 文件:完整证据链 + 暂缓项 + 实现草图 |

## 暂缓(资源优化,非正确性)

`--no-optional-locks` 消除了**正确性**问题。剩余的是**资源**问题:用户没开 Git 面板时后台仍每 3s 轮询一次 status。**本期不做**,理由:

- watcher 生命周期完全在 main 端驱动(`index.ts:471`),与面板可见性**解耦**;面板可见性只在 renderer 端有(`store.tsx` 的 `activePanels`)。
- 门控需新增 renderer→main IPC + 多窗口聚合(任一窗口可见即轮询)+ 切换边角态,属**跨层新能力(MINOR 级)**,不该塞进一次 PATCH 勘误。
- AGENTS.md §10:「保持简单 / 不要在没问题的地方做性能优化」。

触发条件 + 实现草图全写在 `docs/issues/git-1-background-status-poll-lock-contention.md`,不会丢。

## ⚠️ 需要你决定的事:提交策略

工作树里有**两类未提交改动**混在一起:

1. **我这次的勘误**(应单独成一个 commit):
   - `src/main/git-service.ts`、`src/main/git-service.test.ts`
   - `CHANGELOG.md`、`AGENTS.md`、`docs/软件定义书.md`、`docs/checkpoints/CP-Git-self-test.md`
   - 新文件 `docs/issues/git-1-background-status-poll-lock-contention.md`

2. **上一会话遗留的未提交改动**(**不是我做的**,我没碰):
   - `package.json`(version `0.3.0` → `0.3.1-dev.1`)
   - `src/main/ipc.ts`(`filePanelUpdated` / `gitStatusUpdated` 从「定向 owner」改为「广播所有窗口」)
   - `AGENTS.md` 附录 F(开发构建版本号规则,大段)

我**没有提交任何东西**——按 AGENTS.md §6(commit 颗粒度)这两批应分开提交。你说怎么提:
- (a) 我只 stage 并 commit 我的勘误那一批(推荐,commit message:`fix(git): add --no-optional-locks to status calls to stop holding index.lock`),遗留那批留给你;
- (b) 两批我一起按颗粒度分两个 commit;
- (c) 你自己提,我不动 git。

## 验证

```
typecheck    ✅ 通过
test         ✅ 857/857(含新增回归断言)
lint         ✅ 零告警
```

---

🛏️ **CP-4 勘误 #6 完成,等待开发者验收。** 重点请看上面「提交策略」那段——需要你定夺。
