# AGENTS.md — Marina 项目 AI Agent 工作说明书

> 你正在 YOLO 模式下为 Marina 贡献代码。本文件**只放每次都要遵守的行为宪法**(工作模式、红线边界、注释/测试/提交纪律)。
> 场景性规则(构建/版本号/子系统规范/测试清单/历史归档)已拆到 `docs/` 下按需文档,见文末「按需文档索引」——做到对应工作时再去读,不必常驻。
>
> 文档版本:1.11 · 本文件的版本变更历史见 `docs/AGENTS-changelog.md`。

## 0. 你必须先读的文件

按顺序读完以下文件,你才有足够的上下文开始工作:

1. **`docs/软件定义书.md`** — 整个产品的设计共识。读懂第 2 章(设计哲学)和第 8 章(状态机),否则你写的代码会偏离产品方向。
2. **本文件(`AGENTS.md`)** — 你现在在读的。
3. **`docs/ipc-protocol.md`** — IPC 协议规格(若存在)。如果不存在,在你开始实现 IPC 之前需要先和开发者一起定。
4. **`README.md`** — 项目的对外说明。

如果上述任何文件不存在或内容残缺,**立刻停下来通知开发者**,不要自己脑补。

---

## 1. 你的工作模式:YOLO 模式

### 1.1 什么是 YOLO 模式

你被授权在不打扰开发者的前提下,**端到端**完成 Marina 的构建。这意味着:

* **可以自主决策**:文件命名、代码组织、变量名、内部 API 设计、测试用例选择、调试策略
* **可以自主执行**:写代码、跑构建、跑测试、提交 git commit、安装(限定范围内的)依赖
* **不需要每一步问开发者**:写完一个函数不用问、起一个新文件不用问、修复一个 bug 不用问

**你的默认行为是"继续干活"**,不是"等指示"。

### 1.2 YOLO 的三条边界

YOLO 不是"想干啥干啥"。以下三条边界**永远不能越过**,越过即停止:

#### 边界 1:破坏性操作前必须停

包括但不限于:
* 删除文件(除非是你刚才自己创建的临时文件)
* `git push --force` 任何操作
* 修改 `.git/` 目录
* 删除或修改 `~/AppData/Roaming/Marina/` 下的任何文件(即使是测试)
* 卸载 npm 包
* 修改系统注册表(Windows)
* 调用任何"清理"、"重置"、"reset"、"clean"类命令对实际数据生效

遇到这些操作前,**停下来,描述你想做什么,等开发者确认**。

#### 边界 2:超出技术栈的依赖

只允许使用 `软件定义书.md` 第 10.1 节列出的技术栈。如果你觉得需要新加一个 npm 包(例如某个工具库、UI 库、状态管理库等),**停下来问开发者**。

理由:agent 历史经验里经常引入冷门 / 已废弃 / 安全风险的包,这种决策必须人来做。

允许的例外:
* `@types/*` 类型定义包,可自由安装
* 明显的小工具(如 `uuid`、`debounce`),先在对话里告知一声再装
* 测试相关包(jest 等,见第 5 章)

#### 边界 3:产品哲学

`软件定义书.md` 第 2 章的四条哲学原则和第 13.2 节"永远不做"列表是**红线**。如果你发现某个功能实现起来"如果加个 XXX 会简单很多",而那个 XXX 出现在"永远不做"列表里,**不要做,停下来问**。

例如:
* 如果你想加"应用内快捷键来切换 session",**停**(违反"鼠标优先")
* 如果你想加"主窗口"概念来简化 session 持久化,**停**(违反"窗口平等")
* 如果你想给关闭窗口加确认对话框,**停**(违反"窗口零成本开关")
  * **唯一例外(v1.6,软件定义书 ADR-013)**:Linux 上"最后一个窗口关闭 + 仍有非 exited session"时弹同一个 `<LastSessionConfirm />`。非 Linux / 非最后窗口 / 全 exited session 时仍然禁止弹任何确认。详见软件定义书第 2 章 Linux 平台例外脚注与 ADR-013。

### 1.3 YOLO 的成功标准

如果你做到了下面所有事,这次 YOLO 就是成功的:

* [ ] 严格按 `软件定义书.md` 实现所有 V1 必做功能(5.1 节)
* [ ] 没有违反"永远不做"列表(13.2 节)
* [ ] 在每个检查点(见第 4 章)按规格停下来,等开发者测试
* [ ] 后端关键模块有自动化测试覆盖(见第 5 章)
* [ ] 代码注释充分,出问题时开发者能调试(见第 2 章)
* [ ] 所有 commit 历史清晰,git bisect 可用(见第 6 章)
* [ ] 应用能正确打包成 Windows 安装包,在干净的 Windows 11 上能跑

### 1.4 决策对齐 / grilling 纪律(关键)

当你在做需要开发者拍板的产品/架构决策(grilling)时——比如新 feature 的交互模型、
面板归属、数据流——**不要一次只抛一个问题**,那会让开发者看不到决策树全貌。
按下面的纪律来:

> **本节覆盖 `.claude/skills/grilling/SKILL.md` 的默认。** 该 skill 是第三方引入的、
> 保持原样不改(方便以后上游升级);它写的是「一次一个问题(one at a time)」。
> Marina 项目**不采用**那条默认——凡触发 grilling(无论是被 skill 触发还是自行发起),
> **一律以本节为准**:列全部问题 + 超 3 写文档 + 完整上下文。读到这里就记住,别回头
> 又按 skill 的 one-at-a-time 走。

#### 列出当前能提出的全部问题

把**此刻决策树上所有已经成型、可以回答的问题**一次性列出来(不是只列根问题),
让开发者能纵览要决定什么、彼此怎么依赖。问题之间用清晰的编号隔开,标注依赖
关系(如「问题 3 依赖问题 2 的答案」)。

#### 超过 3 个就写成文档在 Marina 里打开

如果成型问题超过 3 个,不要塞在对话里(滚动难读、上下文丢失)——**写成一个
Markdown 文档,用 `show-in-marina` skill 在 Marina 的「已打开」面板里打开**给
开发者看。文档结构:
- 顶部一段「背景与已定结论」(把前面几轮已经 grill 定的东西复述一遍,让文档
  自包含——开发者可能在另一个 session 打开它);
- 每个问题一个 `##` 小节,含「上下文/推理过程」「待裁决点」「我的推荐 + 理由」;
- 问题之间标注依赖。

这个文档是 grilling 的载体,开发者逐条回答,你据此推进。

#### 每个问题必须带完整上下文(关键)

**绝对不要**把你自己思考过程中的推论、自创的名词、未解释的术语直接拿来问。
典型反面:你在脑里走了「面板有 trigger 类型 → 现有两种 product-rule/program-push
→ 命令面板是第三种」三级推论,然后直接问「命令面板认第三种 trigger 吗?」——
开发者根本不知道「trigger 类型」是什么、为什么会有「第三种」、这词哪来的。

每个问题的上下文必须包含:
1. **背景事实**:这个问题从哪来的、为什么现在要问(引用前面已定结论或代码现状);
2. **推理过程**:你得出这个问题的完整思考链,**一级一级讲**,不跳步;
3. **名词定义**:任何你自己引入或从代码里借来的术语(如「trigger 类型」「demand
   模型」),第一次出现时一句话定义清楚;
4. **可选的代码证据**:文件路径:行号,让开发者能自己去核实;
5. **待裁决点 + 你的推荐 + 理由**:明确这是个需要他拍板的决策,给出你的倾向和为什么。

判断标准:把这个问题单独抽出来给一个**没读过你思考过程的人**看,他能在一分钟内
理解你在问什么、为什么问、选项各意味着什么。达不到就重写上下文。

这条纪律的动机:agent 经常省略推理中间步,直接拿结论问人,导致开发者要么猜你
在说什么(答错)、要么让你重述(浪费一轮)。把推理显式写出来,对齐成本最低。

## 2. 代码注释要求(关键)

### 2.1 为什么注释要求高

正常项目里,代码 review 是质量保证。**这个项目没人 review 你的代码**。
当你犯错时,开发者要在事后接手调试。如果你的代码他读不懂,他就只能扔掉重写。

所以你的代码必须满足:**任何一个有 TypeScript / Electron 经验的人,在没读过你思考过程的前提下,能在一小时内理解任何一个文件在做什么、为什么这么做、出问题时该看哪里。**

### 2.2 必须写注释的地方

#### 文件头注释(每个 .ts / .tsx 文件必须有)

```typescript
/**
 * @file session-manager.ts
 * @purpose 管理所有 PTY 会话的生命周期(创建、活跃/空闲检测、墓地、销毁)
 *
 * @关键设计:
 * - 每个 Session 在守护进程内是单例,owner_window_id 可为 null
 * - PTY 进程退出后进入"墓地"5 分钟,期间用户可恢复
 * - 字节流通过 IPC 推送给 owner window,无 owner 时仍写 scrollback
 *
 * @对应文档章节:软件定义书.md 第 5.1.2、8.3 节
 *
 * @不要在这里做的事:
 * - 不要解析 OSC 1337(那是 cwd-tracker.ts 的职责)
 * - 不要持久化 session(session 不持久化,设计如此)
 * - 不要管理 path 归属(那是 path-manager.ts 的职责)
 */
```

#### 函数注释(公开函数必须有,私有复杂函数必须有)

```typescript
/**
 * 创建一个新 session 并启动 PTY。
 *
 * @param pathId 该 session 启动时的工作目录所对应的 path id
 * @param templateId 启动模板 id,从 templates.json 读
 * @param ownerWindowId 创建该 session 的窗口 id,设为初始 owner
 * @returns 创建的 SessionInfo
 *
 * @throws 'PathNotFound' 如果 pathId 不存在
 * @throws 'TemplateNotFound' 如果 templateId 不存在
 * @throws 'PtySpawnFailed' 如果 node-pty 启动失败(常见原因:cwd 不存在、shell 不存在)
 *
 * @副作用:
 * - 创建 node-pty 子进程
 * - 把 session 加入 path 的 session 列表
 * - 触发 path 状态机:可能让 path 进入"临时"分类
 * - 广播 pathTreeUpdated 和 sessionStateChanged 事件
 *
 * @常见问题排查:
 * - 如果 PTY 启动后立即退出 → 检查 shell 路径、cwd 权限
 * - 如果 OSC 1337 hook 不生效 → 检查 templateId 对应的 shell hook 文件是否注入
 */
async function createSession(
  pathId: string,
  templateId: string,
  ownerWindowId: string
): Promise<SessionInfo> {
  // ...
}
```

#### 复杂逻辑必须有"为什么这么写"的注释

不是写"这行代码做什么",而是写"为什么这么做,不那么做"。

```typescript
// 我们用 setImmediate 而不是 process.nextTick,因为 nextTick 优先级太高,
// 会饿死后续的 PTY data 事件,导致字节流堆积。这是踩过坑的。
setImmediate(() => {
  this.broadcastPathTreeUpdate();
});

// node-pty 的 onData 回调可能在 PTY 已经标记 destroyed 之后还触发一次
// (经验:Windows ConPTY 的关闭是异步的)。所以这里要 guard。
if (this.destroyed) return;
```

#### 状态机相关代码必须有状态图引用

任何涉及到状态转移的代码,在该函数顶部用注释画出 mini 状态图,或引用文档:

```typescript
/**
 * Session 状态转移逻辑。
 *
 * 状态机参见 软件定义书.md 第 8.3 节(v1.2 ADR-008 后)。
 * 简化:
 *   active <--有/无字节流--> idle
 *   active/idle --PTY 进程退出--> exited (灯显灰,scrollback 保留,无时限)
 *   exited --用户右键关闭 / 应用退出--> destroyed
 *   注:exited 不可回到 active(无重启路径,见 ADR-008)
 */
```

### 2.3 不要写的注释

* `// 设置 x 为 5` ← 重复代码本身,删掉
* `// TODO: fix this later` ← 要么修,要么写明白具体要修什么、为什么不现在修
* 注释掉的代码 ← 直接删,git 里有历史

### 2.4 错误信息要详细

任何你 throw 的 Error 必须包含:
* 出错的操作名
* 出错的关键参数值
* 可能的原因(至少猜两个)
* 建议的下一步

```typescript
// 不好
throw new Error('Failed to create session');

// 好
throw new Error(
  `[SessionManager] Failed to spawn PTY for templateId="${templateId}" cwd="${cwd}". ` +
  `Possible causes: (1) shell binary not found at "${shellPath}", ` +
  `(2) cwd does not exist or no permission, ` +
  `(3) node-pty native module not built for current Node version. ` +
  `Check logs in ~/AppData/Roaming/Marina/logs/main.log for stderr.`
);
```

### 2.5 日志要详细

主进程任何关键路径必须有日志,日志要带模块名 + 关键参数。开发者排查问题时,日志是他的眼睛。

```typescript
log.info(`[SessionManager] createSession: pathId=${pathId} template=${templateId} ownerWindow=${ownerWindowId}`);
log.info(`[SessionManager] PTY spawned: sessionId=${session.id} pid=${pty.pid}`);
log.warn(`[SessionManager] PTY exited unexpectedly: sessionId=${session.id} exitCode=${exitCode}`);
log.error(`[SessionManager] Failed to create session`, error);
```

日志级别:
* `debug` — IPC 消息内容、PTY 字节流(只在 settings.advanced.logLevel = DEBUG 时启用)
* `info` — 重要状态变化(session 创建/销毁、窗口开关、设置变更)
* `warn` — 异常但不致命(PTY 异常退出、单个 IPC 消息失败)
* `error` — 致命错误(无法启动守护进程、数据文件损坏)

---

## 3. 调试中的"10 轮规则"(关键)

### 3.1 什么算"一轮调试"

一轮调试 = 你做了下面任意一件事:
* 修改了代码并重新跑(无论是测试还是手动跑)
* 加了一个 log 重跑
* 改了一个配置重跑
* 试图复现一个错误

### 3.2 触发"10 轮规则"

如果你在调试**同一个问题**(同一个 bug、同一个失败的测试、同一个不工作的功能)超过 10 轮还没解决,**立刻停下来**。

具体触发条件(满足任意一个):
* 同一个测试用例失败了 10 次以上
* 你修改同一段代码超过 10 次,问题仍在
* 你的对话里(或 commit message 里)反复出现"修复 X 问题"超过 10 次
* 你怀疑过 5 个以上不同根因,都不对

### 3.3 触发后该做什么

**不要继续猜**。立刻执行:

1. **停止所有修改**,把当前代码状态保留下来(不要回退)
2. 写一份 `BLOCKED.md` 文件放在仓库根目录,内容包含:
   - 问题简要描述
   - 你尝试过的所有思路(每条一行)
   - 你当前最强的怀疑(以及为什么没修好)
   - 你认为开发者应该看哪几个文件
   - 复现步骤
3. 在终端 / 当前对话里输出明显的求助信号:`🛑 BLOCKED: 调试 10 轮未果,需要开发者介入。详见 BLOCKED.md`
4. **等待**。不要再尝试修。

`BLOCKED.md` 模板:

```markdown
# BLOCKED: [问题一句话描述]

**触发时间**:2026-XX-XX
**调试轮次**:11+
**所在阶段**:Week X, 实现到第 Y 个 SKILL

## 问题表现
[具体的错误信息 / 行为描述]

## 复现步骤
1. ...
2. ...

## 我尝试过的思路
- [ ] 尝试 1:...(结果:...)
- [ ] 尝试 2:...(结果:...)
- [ ] 尝试 3:...(结果:...)
...

## 我目前最强的猜测
[为什么这是猜测?为什么修了还不对?]

## 关键文件
- src/main/xxx.ts:第 Y 行
- ...

## 相关日志
[贴出最具诊断价值的 5-20 行日志,不要全贴]
```

### 3.4 为什么有这条规则

经验告诉我们:agent 在卡死之后,继续往前冲只会让代码越来越糟、越来越难诊断。10 轮是一个保守的上限 — 大多数问题在 3-5 轮就该解决,如果 10 轮还没解决,通常说明你**对问题的理解从一开始就是错的**,这种情况下人介入比 agent 继续猜效率高 100 倍。

不要把这条规则当成"我要努力撑到第 10 轮"。如果你 5 轮就感觉走投无路,提前 BLOCKED 也是合理的。

### 3.5 不属于 10 轮规则的情况

以下不算"卡 10 轮":
* 你在做不同的功能,每个都跑了几次测试 — 这是正常工作,不是卡死
* 你在调试不同的 bug,每个 1-2 轮解决 — 这是正常工作
* 测试基础设施在反复跑(CI 失败重跑)— 不是逻辑卡死

10 轮规则**只针对单一问题反复修而不解决**的情况。

---

## 4. 检查点(关键)

### 4.1 检查点的作用

Marina 的开发被切分成 **N 个检查点**,与 `软件定义书.md` 第 15 章的 Phase 1 路线图对齐。

在每个检查点,**你必须停下来**:
1. 完成一份"自测报告"(你自己先冒烟测试一遍)
2. 完成一份"用户测试指南"(教开发者怎么测)
3. 在终端 / 对话里明显标记:`🛏️ CHECKPOINT N: 等待开发者测试`
4. **不许继续往下做下一个 Phase 的工作**,即使你觉得自己有空

开发者会:
* 按你的指南测试
* 反馈"通过"或"问题清单"
* 通过后,授权你进入下一个检查点

### 4.2 检查点列表

> V1 早期里程碑 CP-1~CP-5 的完成标志已归档至 `docs/checkpoints/CP-1to5-历史完成标志.md`(历史快照,不再常驻本文件)。
> 当前检查点体系已演进为**功能级 CP**,参见 `docs/checkpoints/` 下各 `CP-*` 文档,以及 `docs/软件定义书.md` 第 15 章 Phase 路线图。

### 4.3 检查点之间的工作纪律

* **不要在检查点 N 之前做检查点 N+1 的工作**。即使代码上看起来很容易顺手做完。
* **每个检查点的代码,在通过之前不能往 main 分支 merge**。每个检查点用一个 feature branch:`checkpoint-1`、`checkpoint-2`...
* **检查点失败时,你修复后必须重跑全部完成标志**,不能只修被指出来的那一项。
* **检查点的"自测报告"是必须做的**。你不能让开发者帮你找编译错误。

### 4.4 自测报告 vs 用户测试指南

每个检查点你提交两个东西:

#### 自测报告(`docs/checkpoints/CP-N-self-test.md`)

你自己跑过哪些测试,结果如何。这是给开发者看的"我做完了什么"。

```markdown
# CP-1 自测报告

## 跑过的测试
- [x] `npm test` 通过(35/35)
- [x] `npm run dev` 启动后,xterm 显示 PowerShell 提示符,输入 `dir` 有输出
- [x] 关闭窗口后,任务管理器查看 Marina.exe 仍在
- ...

## 已知不工作的事(需要开发者关注)
- 第二次启动 Marina.exe 时,新窗口的位置和第一个重叠了 → 这个属于 CP2 的窗口位置记忆功能,目前先不修
- ...

## 我没测的东西(需要开发者帮忙)
- 没有干净 Windows 11 虚拟机环境,无法验证安装包在新机器上工作
- ...
```

#### 用户测试指南(`docs/checkpoints/CP-N-user-test-guide.md`)

教开发者一步一步怎么测。**写得像给一个不熟悉这个项目的人看**。

```markdown
# CP-1 用户测试指南

## 准备
1. 确保 Node.js 20+ 已安装(`node --version`)
2. 在项目根目录跑 `npm install`(首次约 2-3 分钟)

## 测试 1:基础启动(预计 1 分钟)
1. 跑 `npm run dev`
2. 等待 ~10 秒,应该看到一个 Marina 窗口出现
3. 窗口右半部分应有一个黑色终端区域,显示 PowerShell 提示符,如 `PS C:\Users\xxx>`
4. **预期**:你能在终端里输入 `dir` 并看到当前目录列表
5. **失败现象**:窗口空白 / 终端显示乱码 / 终端输入无反应
6. **失败时**:打开 `~/AppData/Roaming/Marina/logs/main.log`,把最后 50 行贴给 agent

## 测试 2:窗口与应用解耦(预计 30 秒)
1. 关闭那个窗口(点右上角 ×)
2. 看 Windows 系统托盘(右下角),应该有一个 Marina 图标
3. 打开任务管理器,搜索 "Marina",应该看到 Marina.exe 进程仍在
4. **预期**:窗口关了,但应用还在
5. 单击系统托盘的 Marina 图标
6. **预期**:重新出现一个窗口,标题栏写 "Window 2"(不是 Window 1)

## 测试 3 ~ 测试 N:...

## 全部通过后
回复 agent:"CP-1 通过,可以开始 CP-2"
```

### 4.5 检查点的等待行为

当你标记 `🛏️ CHECKPOINT N: 等待开发者测试` 后:
* **不要往下做事**
* **不要"乘等待之机"重构旧代码**
* **可以**做的事:整理文档、更新 CHANGELOG、给现有代码补注释、修明显的 lint 警告
* 收到开发者"通过 CP-N"后,才能开始 CP-(N+1)
* 收到开发者"CP-N 失败,xxx 不工作"后,先修复,再次自测,再次提交检查点

### 4.6 勘误回合(checkpoint errata)

每个检查点开发者测试后,如果发现一批问题,会创建 `docs/cp{N}勘误.md` 把问题整理成自由文本。**勘误回合是检查点工作流的一部分,不是另一种特殊状态**。

工作纪律:
1. 通读勘误每一条(顺序无关),把每一条转成 task(`TaskCreate`),按用户原文写描述。
2. 若涉及包/技术栈选择(图标库、新依赖等),用 `AskUserQuestion` 在动手前对齐方向 — 这是边界 2 的延伸。
3. 实现完每条后 `TaskUpdate completed`;不能"批量做完一起更新",会丢追溯。
4. 至少跑过一次 `npm run typecheck` + `npm test` + `npm run lint`,通过再回报。
5. 把这次回合的总结沉淀到:
   - **软件定义书**:对应章节用"v{X.Y} 起 / CP-{N} 勘误"标注的方式更新,新增 ADR(若涉及决策变更)。
   - **AGENTS.md**:CP-{N} 完成标志列表把变更条目补上。
   - **CP-{N}-self-test.md**:在文末加"勘误回合修复"章节(参考 CP-3 自测报告的写法)。
6. 已通过的检查点代码"封箱"规则(第 7 章)在勘误回合内**临时解冻** — 你被授权改它们,因为正是它们出了问题;改完仍在同一 feature branch,不要新开。

历史回合参考:
* `docs/ch2勘误.md` — CP-2(banner / 主题切换 / 标签顺序)
* `docs/cp3勘误.md` — CP-3(banner 完全砍 / 状态点输出驱动 / tab 闪绿 / 右键无反应 / 标签顺序)
* `docs/cp4勘误.md` — CP-4(滚动条主题 / 移除跟随系统主题 / 字体真枚举 / 多行粘贴 / 图标库 / in-memory 导入 / CSP)

---

## 5. 自动化测试要求

### 5.1 后端必须有测试,前端不需要

**必须有测试**:
* `src/main/` 下所有非平凡逻辑模块
* `src/shared/` 下所有共享类型 / 协议 / 工具

**不需要写测试**(也不要写):
* `src/renderer/` 下任何代码(UI 由人工测)
* `src/preload/` 下的代码(简单转发)

理由:
* 主进程是产品的"大脑",数据状态机和 PTY 管理出错代价大,自动测试性价比高
* UI 测试在 Electron 里成本高(需要 spectron/playwright + Electron 的兼容性),收益低于人工测,资源不应花在这里
* 人工测试反而对 UI 更好,因为人能感知"丑"和"反人类",自动测试感知不到

### 5.2 测试栈与场景细则

> 测试栈选型(Vitest / mock / memfs)、必测场景清单(状态机/核心管理器/协议/持久化/解析)、不需要测试的部分、覆盖率目标、如何跑测试——已迁至 `docs/testing.md`。

### 5.3 agent 必须自己跑能跑的验证(关键)

不只是写单测。完成一批改动后,**agent 必须自己跑项目提供的所有能跑的验证设施,不要把能自测的东西丢给开发者手测**。开发者不读代码,他靠你跑过的自动化 + 真实交互体感来确认方向。

**每次改动后必须自己跑的**:
- `npm test`(单元测试)+ `npm run typecheck` + `npm run lint` —— commit 前必跑,全绿才能算"做完了"。
- `npm run smoke`(启动冒烟,`scripts/smoke-launch.mjs`)—— **改了 main 进程组装 / IPC / preload / 任何启动路径后必跑**。验证 main + 至少一个窗口能在 5s 内起来、无 preload-error / render-process-gone。先 `electron-vite build` 产 `out/` 再跑(或 `npm run dev` 已 build 则 `out/main/index.js` 已在)。日志看到 `bootstrap starting` + 无致命模式 = PASS。
- `npm run smoke:interactive [--terminal-deck|--file-viewer-scroll]`(`scripts/smoke-interactive.mjs`)—— 改了终端 / 文件面板 / session 创建路径后跑,验真实 Electron 下的交互。
- 项目里任何别的 integration / e2e 脚本。

**只有这些才让开发者手测**(自动化覆盖不到的最后一公里):
- UI 视觉("丑" / 反人类,自动化感知不到)
- 真实交互体感(延迟 / 顺滑度,需要人感知)
- agent 无法自动触发的真实外部依赖(真 pi 进程的对话行为 / 真远程 daemon / 真硬件)

**原则**:如果你能让一个脚本/测试自动验证某件事,就不要写进"用户测试指南"让开发者点。把能自测的全自测了,开发者测的才是自动化够不到的。

**配套陷阱(踩过)**:装 Electron 二进制**不要用 `--ignore-scripts`**。`npm install --ignore-scripts`(常用于重建被误删的 `node_modules/.bin`)会跳过 electron 的 postinstall(下载二进制),导致 `npm run dev` / `npm run smoke` 报 `Error: Electron uninstall`。装 electron 二进制用 `node node_modules/electron/install.js`(走 `.npmrc` 的 electron_mirror),或正常 `npm install`(不带 ignore-scripts)。

## 6. Git 提交纪律

### 6.1 commit 颗粒度

**每个独立的功能点 / bug 修复 / 重构,一个 commit**。

不要 "一天一个 commit 包含所有改动"。理由:出问题后 `git bisect` 是开发者唯一的救命稻草。

例子:
* 好:`feat(session-manager): add session creation` + `feat(session-manager): add tombstone logic` + `fix(session-manager): handle PTY exit before owner assigned`
* 坏:`progress on session manager`

### 6.2 commit message 格式

用 Conventional Commits:

```
<type>(<scope>): <subject>

[optional body]

[optional footer]
```

**type**:`feat` / `fix` / `refactor` / `test` / `docs` / `chore` / `perf`
**scope**:`main` / `renderer` / `session` / `path` / `tray` / `settings` / `ipc` / `theme` 等
**subject**:50 字以内,陈述句,小写开头

例子:
```
feat(session): add tombstone state with 5-minute retention

Session 进程退出后不立即销毁,保留 5 分钟以便用户从
墓地恢复。计时器在 SessionManager 内集中管理,避免每
个 session 各自起 setTimeout。

对应 软件定义书.md 8.3 节。
```

### 6.3 分支策略

* `main`:只接受通过检查点的代码
* `checkpoint-N`:每个检查点一个分支
* `fix/xxx`:checkpoint 失败后的修复分支,基于 `checkpoint-N`

不要直接在 `main` 上写代码。

### 6.4 不要 force push

`git push --force` 任何分支都需要先停下来问开发者。

### 6.5 commit 前必须

* 跑过 `npm run lint`,无错误(警告可接受)
* 跑过 `npm test`,通过
* 代码格式化(prettier)

---

## 7. 不许重构已通过的代码

### 7.1 规则

一旦一个检查点通过,该检查点对应的代码就是"已封箱"的。在后续检查点,你**不许重构这些代码**,除非:

* 后续功能强制要求改它(比如 CP-2 加多窗口必须改 CP-1 的窗口管理代码)
* 它是个 bug 阻碍当前工作(那就修 bug,不是重构)
* 开发者明确指示"重构 X"

不许的"重构"包括:
* "我觉得这里命名不够好,改一下"
* "把 callback 改成 async/await"
* "把这段抽出一个工具函数"
* "顺便加个抽象层方便以后"

### 7.2 为什么

* agent 重构经常引入 regression
* 没人 review,引入了你也不知道
* 检查点已经测过了,改了等于让开发者重测一遍

### 7.3 例外:注释和格式

可以做的:
* 给已有代码补注释(满足第 2 章要求)
* 跑 prettier 格式化
* 修明显的 typo

这些不算重构。

---

## 8. 平台抽象与跨平台

### 8.1 V1 只测 Windows,但代码必须 platform-aware

`软件定义书.md` 第 12 章定义了 PlatformAdapter 抽象。

**你必须**:
* 所有平台特定 API 通过 `src/main/platform/` 调用
* `windows.ts` 完整实现
* `macos.ts` 和 `linux.ts` 留占位 throw `Not implemented`
* 不要往 `windows.ts` 之外的地方写 `process.platform === 'win32'` 之类的判断
* 测试时,如果某测试需要 platform adapter,用 mock,不要直接调 windows.ts

### 8.2 不要"顺手"实现 macOS 或 Linux

即使你觉得"这个 API node 标准库就有,顺便做了 Linux 也行",**也不要做**。

理由:
* 你不会在 macOS / Linux 上测,实现了等于发布未经测试的代码
* 这违反"V1 只 Windows"的承诺
* 留给社区贡献者去做,有意义的开源协作

如果你忍不住,先在 PR / commit 中提议,等开发者明确同意。

---

## 9. 数据安全

### 9.1 不许碰用户的真实数据

测试 / 调试 / 开发过程中,**永远不要**:
* 删除 `~/AppData/Roaming/Marina/` 下任何文件
* 修改 `~/AppData/Roaming/Marina/` 下任何文件(除非是应用本身的正常写入)
* 用真实的 Marina 数据目录跑测试

测试用临时目录或内存文件系统:
```typescript
// 测试里这么用
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'marina-test-'));
// 测试结束清理
await fs.rm(tempDir, { recursive: true, force: true });
```

### 9.2 不许提交敏感数据

* `.env`、`.env.local` 加入 `.gitignore`
* 不要在代码 / 注释 / commit message 里写真实路径(用 `~/projects/example` 这种占位)
* 不要写 API key / token / 密码,即使是注释里的"示例"
* 不要把测试用的真实输出贴进 commit message

### 9.3 测试不许跨进程影响

如果你的测试需要 spawn 真实进程,只用 mock 或在隔离环境(如 Docker)。绝不能让测试 spawn 真的浏览器、shell、应用。

---

## 10. 性能要求(底线)

V1 只是底线,不追求极致:

* 启动到第一个窗口可见 < 3 秒(冷启动)
* 创建一个 session 到 PTY ready < 1 秒
* PTY 字节流到 xterm 显示的延迟 < 50ms(目测无延迟)
* 设置变更到所有窗口同步 < 200ms
* **面板切换延迟(2026-07-19 增补,v0.3.0 Git 面板反馈驱动)**:
  - 有缓存时:Git / 文件 / 已打开 面板切换 **< 16ms**(1 帧,零感知)
  - 无缓存首拉:**< 300ms**(含 spawn git,Windows 上界)
  - 切走再切回:**必须命中缓存**,不得重新拉取
  - 实现约束:面板级数据在 renderer 端必须有**组件外缓存**(模块级 Map 或 store
    slice,如 `src/shared/git-status-cache.ts`),组件卸载不丢数据;main 端高频
    只读数据在 session 生命周期内至少缓存 1 次,watcher/event 主动失效。
    LayoutHost 用 `<ActivePanel key={...}>` lazy mount → 切走即卸载 useState,
    所以"组件外缓存 + main 端预取/事件推送"是满足本约束的必选模式。
  - 新面板若无法满足,**停下来评估设计**,不许"先上线后优化"。
* 内存:稳态(10 个 session,2 个窗口)< 500MB

如果你发现某个操作明显慢(超出上述底线 2 倍以上),停下来评估是否设计有问题。不要"先实现着,以后再优化"。

不要在没问题的地方做性能优化(过度抽象、缓存、异步队列等)。**保持简单是最好的性能策略**。

---

## 12. 关键提醒(给你的最后嘱托)

如果你在工作中陷入困惑,回到这几条:

1. **你的工作不是"写出最优雅的代码"**,而是"实现一个可用的 V1 Marina,让开发者接手后能维护"。
2. **写注释不是浪费时间**。开发者读不懂你的代码 = 你白干了。
3. **YOLO 不是"不顾后果"**,而是"在边界内自主"。边界(技术栈 / 哲学 / 破坏性操作)永远不能越。
4. **检查点是给你机会校准方向**,不是麻烦事。一次跑偏到 CP-4 才发现,损失大于 4 次检查点的开销之和。
5. **10 轮规则保护你和开发者**。不是失败,是诚实。
6. **测试是写给未来的你**,不是写给开发者看的。当你在 CP-3 改了 SessionManager 时,CP-2 写过的测试会告诉你有没有破坏旧逻辑。
7. **当你不确定时,问开发者比猜测好**。问的代价 = 一条对话消息;猜错的代价 = 几小时返工 + 信任流失。

---

## 附录 A:文件 / 目录权限速查

| 路径 | 你能读吗 | 你能写吗 | 你能删吗 |
|------|---------|---------|---------|
| 项目根目录及子目录 | ✅ | ✅ | ⚠️ 仅限你自己创建的临时文件 |
| `node_modules/` | ✅ | ⚠️ 通过 npm | ⚠️ 通过 npm |
| `.git/` | ✅ | ❌ | ❌ |
| `~/AppData/Roaming/Marina/` | ⚠️ 仅 Marina 应用代码 | ❌(测试不许碰) | ❌(永远不许) |
| 系统 / 注册表 | ⚠️ 通过 PlatformAdapter | ❌(只在 V1.2 启用 Explorer 集成时可,现在不许) | ❌ |
| 任意 `~/projects/*` 等用户文件 | ❌ | ❌ | ❌ |

## 附录 C:你绝对不能问的事(因为答案永远是不)

* "能不能加一个 vim 模式快捷键"(违反哲学,永远不)
* "能不能加 project / workspace 概念让 session 持久化"(违反哲学,永远不)
* "能不能让 main window 在关闭时弹确认"(违反哲学,永远不,而且根本没有 main window)
  * **唯一例外(v1.6,软件定义书 ADR-013)**:Linux 上当**最后一个窗口**关闭且**仍有非 exited session**时,弹同一个 `<LastSessionConfirm />` modal。Windows 关窗 / macOS 关窗 / 任何非最后窗口的关闭 / 全 exited session 的最后窗口关闭 —— **仍然永远不弹**。
* "我能不能 force push"(永远不,除非开发者明确叫你做)
* "我能不能为了过测试 mock 掉这个核心模块"(永远不,这是自欺欺人)

## 按需文档索引

> 本文件只放每次都要遵守的**行为宪法**。以下是场景性内容——做到对应工作时再去读,不必常驻记忆。

| 你要做的事 | 去读 |
|---|---|
| 构建 / 打包 / 发版(操作流水线) | `docs/打包发布流程.md` |
| 决定版本号 bump / 产出 dev 构建 | `docs/版本号规则.md`(原附录 E、F) |
| 写或审测试、判断某模块要不要测 | `docs/testing.md`(原第 5 章 5.2~5.7) |
| 新面板 / 改文件树缩进 / 文件 icon | `docs/standards/panel-ui-state.md`(ADR-019) |
| 动 performanceMetrics / 自动报告 / profile | `docs/standards/perf-metrics.md`(ADR-020) |
| 新增或改周期后台任务 / 调度 demand | `docs/standards/background-tasks.md`(ADR-021) |
| 改终端视图 / Session 切换复用 / view lease | `docs/standards/terminal-views.md`(ADR-022) |
| 查 AGENTS.md 历史版本说明(v1.1~v1.10) | `docs/AGENTS-changelog.md` |
| 查 CP-1~CP-5 早期里程碑完成标志 | `docs/checkpoints/CP-1to5-历史完成标志.md` |

## Agent skills

### Issue tracker

Issues and wayfinder maps live as GitHub issues (gh CLI). See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context layout. See `docs/agents/domain.md`.
