# 方案:pi bridge 对 fork / 子会话的适配(分析 + 设计)

> 2026-08-17 · 由「resume 打开 workspace 没法处理 fork 对话 / subagent 对话」的反馈驱动。
> 本文上半部分是**事实与实证**(回答"当时做插件时考虑过吗"),下半部分是**设计修正与待裁决问题**。

---

## 裁决记录(2026-09-03,开发者已拍板,已实施)

| 问题 | 裁决 | 实现摘要 |
|---|---|---|
| Q1 fork 语义 | **新建 workspace 且继承原 workspace**(符合用户对 pi /fork 的预期) | `SessionWorkspaceManager.cloneWorkspace`:复制受管文件+面板快照,内部路径重写指向新目录;继承源优先 parentBinding,回退 payload 继承 entry,源已回收退化空新建 |
| Q2 /tree | **不处理** | bridge 不监听 session_tree;同文件内换分支不切 workspace |
| Q3 子会话深度 | (未单独裁决,按推荐执行)L0+L1 | 子会话 resume 仍是独立对话新空 workspace;亲缘(parentSessionFile/parentBinding)随事件上报并记日志,快照继承/运行时可见性列 backlog |
| Q4 共享策略 | **tree(同文件)共享;fork、subagent 不共享** | 同文件跨终端 resume 允许共享,release 改为最后占用者销毁才释放;fork 血统首次激活(payload==parentBinding)不切回父的,克隆一份并返回新 id 覆盖 entry |
| Q5 bridge 自动升级 | (未单独裁决,按推荐执行)做 | installer 启动时比对内置版与稳定目录版,不一致静默重拷;从未安装不预装 |

同时修复本文档 G1(first-match 死绑定导致 resume 无限新建空 workspace):
bridge 绑定读改为 `getBranch()` 离 leaf 最近匹配(旧版 pi 回退全量取末尾)。
规范依据:软件定义书 **ADR-033**。改动清单见文末「实施落地」。

---

## 背景与已定结论(已定部分,不再讨论)

以下机制已实现并通过测试,本文**不推翻**它们:

1. **哑转发器架构**(ADR-028):bridge 只转发事件,决策全在 Marina 侧
   (`packages/pi-marina-bridge/extensions/index.ts`)。
2. **主 piSessionId 锁定**:每个 Marina 终端同一时刻只绑一个主 pi 对话,
   其他 piSessionId(子 agent)的事件全部忽略
   (`src/main/coordinators/pi-session-coordinator.ts` 主锁段)。
3. **workspace 绑定存 pi 对话 entry**(`marina-workspace` custom entry,
   `pi.appendEntry` 落盘,跨重启跟对话走)——这是 v0.3.3 为修
   「piSessionId 内存映射 resume 时 miss」引入的机制,方向正确,
   但它的**读策略有 bug**(见 G1,这是本次分析的核心新发现)。
4. reason 分发:`new`/`fork` → 新建 workspace;`resume`/`startup` → 切回;其他不动。

本文要回答的:**fork、/tree、子 agent 会话这三种「非常规对话形态」下,绑定机制是否仍然正确、语义是否自洽。**

---

## 第一部分:事实(全部有出处)

### 1.1 pi 的会话模型——和 Marina 侧假设的关键差异

**名词定义**(下文全部沿用):

| 名词 | 定义 | 出处 |
|---|---|---|
| 会话文件 | `~/.pi/agent/sessions/<cwd-dir>/<date>_<uuid>.jsonl`,内容是**树** | pi `docs/sessions.md` |
| `sessionId` | 会话文件的 UUID(`getSessionId()`),**一个文件一个,终身不变** | pi `docs/session-format.md` |
| entry | 树上的一个节点(`id`/`parentId`),`marina-workspace` 绑定也是 entry 之一 | 同上 |
| leaf | 树上的「当前位置」,`/tree` 导航就是移动 leaf,**不换文件不换 sessionId** | 同上 |
| 分支(branch) | 从当前 leaf 沿 `parentId` 走到根的路径(`getBranch()`,leaf→root 顺序) | 同上 |
| 主对话/子会话 | 终端里用户直接操作的那个 pi 进程的当前会话 / pi-subagents 在同进程内 spawn 的子 agent 会话(独立落盘文件) | pi-subagents `docs/` |

**pi 里「分叉/换对话」有三种,行为完全不同:**

| 机制 | 换文件? | 换 sessionId? | 复制 entries? | 触发的事件 |
|---|---|---|---|---|
| `/fork`(从某条历史消息分叉) | ✅ 新文件 | ✅ | ✅ 复制 root→fork 点路径 | `session_shutdown(fork)` → `session_start(fork)` |
| `/tree`(树内导航) | ❌ 同文件 | ❌ | ❌ 只移动 leaf | `session_before_tree` / `session_tree`(**不触发 session_start**) |
| CLI `pi --fork` / `pi --resume <file>` | ✅ | ✅ | ✅(fork)/ ❌(resume) | `session_start(startup)` |

出处:pi `dist/core/extensions/types.d.ts` 的 `SessionStartEvent`
(`reason: "startup"|"reload"|"new"|"resume"|"fork"`)、`SessionShutdownEvent`
(`reason: "quit"|"reload"|"new"|"resume"|"fork"`)、`SessionBeforeForkEvent`
(`entryId`+`position`)、`SessionTreeEvent`;`docs/session-format.md` 的
SessionManager API(`getBranch(fromId?)` "Walk from entry to root, returning all
entries in path order")。

**关键事实:fork 会把父对话 root→fork 点路径上的所有 entry 复制进新文件——包括 `marina-workspace` 绑定 entry。** 会话 header 还有 `parentSession` 字段指向父会话文件路径(本机 92 个 marina 会话文件里 16 个带此字段,实证存在)。

**关键事实:子 agent 会话是一等公民文件。** pi-subagents 的 child session 真实落盘
(`context:"fork"` 明确要求「branched child session」可创建),出现在 `/resume`
列表里,用户**可以**直接 resume 一个子 agent 会话来检查它干了什么。

### 1.2 当时的设计考虑了什么、没考虑什么(回答第一问)

翻遍三份文档(`docs/方案-pi对话绑定workspace-20260805.md`、
`docs/pi联动-实现总结-20260806.md`、ADR-028):

- **考虑过的**:fork 作为**事件 reason**(方案文档问题 3 的映射表里有
  「new/fork→新」);subagent 作为**噪声**(ADR-028 主锁把它们过滤掉,防污染)。
- **没考虑过的**:
  1. fork 作为**文件复制语义**——绑定 entry 会被继承这件事,文档零提及;
  2. 绑定的**树位置语义**——`readMarinaWorkspaceId` 把会话当线性文件扫;
  3. 子会话作为**可 resume 的一等对话**——「用户主动打开一个子 agent 对话」
     的场景在所有文档中不存在;
  4. **跨终端共享 workspace 的互斥**——`switchSessionToWorkspace` 无任何防护。

**判词:不是「没想到 fork/subagent 这两个词」,而是当时把 pi 会话建模成了「一个线性文件 = 一个对话」,而 pi 实际是「一个树文件 = 很多可能的对话位置」+「子会话也是文件」。设计在这两个维度上都是缺的。**

---

## 第二部分:实证缺口(按严重度排序)

### G1(核心 bug,已在本机发生):绑定读策略 first-match → resume 绑定错乱 / 无限新建

**现状代码**(`packages/pi-marina-bridge/extensions/index.ts` 的
`readMarinaWorkspaceId`):`getEntries()` 全量扫描,**返回文件里第一个**
`marina-workspace` entry。

**推理链(一级一级)**:

1. 绑定 entry 是 `appendEntry` 落在**当时 leaf** 的树节点,不是文件级属性;
2. 同一个对话在生命周期里会落**多个**绑定 entry(workspace 被回收 →
   resume 时 Marina 新建 → append 新 entry);
3. 第 2 步一旦发生,文件里第一个 entry 就成了**死绑定**(指向已回收的 workspace);
4. first-match 读**永远命中死绑定** → Marina `getRecord` 返 null → 判定「被回收」
   → **每次 resume 都新建 workspace + append 新 entry** → 文件面板状态永远不恢复,
   且 entry 无限累积。

**本机实证**(`~/.pi/agent/sessions/--D--data-projects-agent-marina--/`):

- `2026-08-05T22-44-*.jsonl`(1957 行)含 **4 个** marina-workspace entry
  (行 1781/1821/1943/1944);
- `2026-08-14T07-34-*.jsonl`(3255 行)含 **4 个**(行 4/1511/2726/2727),
  first-match 永远读到行 4 的 `3dc65d5d`。

**这不是 fork 触发的边缘 bug——普通 `/resume` 在 workspace 被回收一次之后就会永久劣化。** 用户反馈的「resume 打不开对的 workspace」主因就在这里;fork 和子会话是叠加触发器。

### G2:fork 的绑定继承 + first-match → 父子对话共享/错绑 workspace

在 G1 之上叠加(推理链):

1. 对话 A 早期落了绑定 W1(entry 在文件前部);
2. 用户 `/fork` 从任意靠后的消息分叉 → 新文件 B **复制了 W1 entry**(1.1 节关键事实);
3. B 的 `session_start(fork)` → Marina 新建 W3 → bridge 把 W3 append 到 B 的 leaf;
4. B 的文件里现在有 W1(继承,位置靠前)+ W3(自己的,位置靠后);
5. first-match 读 W1 → **B 永远绑到 A 的(可能已死的)workspace**;W3 成孤儿;
6. 若 W1 还活着:A、B 两个对话操作同一个 workspace,文件面板互相污染,
   违反「一个对话 ↔ 一个 workspace」不变量;若 W1 已死:回到 G1 的无限新建。

### G3:子会话 resume 后亲缘关系全丢

子会话文件(带 `parentSession` header)被用户 resume 时:它没有绑定 entry
(运行期间事件被主锁正确过滤,从未 append)→ Marina 视为全新对话 → 新建空
workspace。**正确性没坏**(它确实是个独立对话),丢的是语义:它是谁的儿子、
父对话的 workspace 是哪个、它改过哪些文件——Marina 全部不知道。

### G4:workspace 共享无互斥(1:1 不变量可被打破,还有连带伤害)

`switchSessionToWorkspace`(`session-workspace-coordinator.ts:296`)直接
`set(sessionId, workspaceId)`,**不检查目标 workspace 是否已被其他活跃 session 绑定**。触发路径:跨终端 resume 同一文件、CLI fork 继承、G2 的父子共享。连带伤害:两 session 共享 W 后,任一终端关闭 → `onSessionDestroyed` 对 W 执行 `release` → **另一个终端还在用,W 却进入回收倒计时**,保留期一到文件面板内容蒸发。

### G5:`session_tree` 导航 Marina 完全不感知

`/tree` 换分支不触发任何被 bridge 监听的事件。现状效果 =「文件级绑定」
(同文件所有分支共享一个 workspace)。这是一个**可以辩护的现状**(见 Q2),
但它和「fork=新文件=新 workspace」的语义不对称:同样是「回到历史某点继续」,
fork 给新 workspace,/tree 却共享——用户心智上二者是同一个动作。

---

## 第三部分:设计修正

### 3.1 核心修正:绑定从「文件属性」改为「位置属性」

> 一句话:**「当前对话位置(leaf→root 路径)上最近的 marina-workspace entry」才是这个对话的 workspace。**

- **读**(bridge 侧):`getBranch()`(leaf→root 顺序)找**第一个**匹配,取代
  `getEntries()` first-match。约 5 行改动。
- **写**(现状不变):`appendEntry` 天然落在当前 leaf,即当前分支的末端。

**为什么这一个改动能同时修 G1/G2,而不是各修各的**(推演各场景):

| 场景 | 修后行为 |
|---|---|
| 同对话 resume,旧 ws 已回收 | 读到死 id → Marina 新建 → append 在 leaf → **下次读 leaf→root 最近 = 新 id**,chained churn 终止(G1 ✅) |
| fork:复制了父的 W1 | `session_start(fork)` → Marina 新建 W3 → append 在 B 的 leaf → 之后 B 读最近 = W3,**W1 沦为无害的祖先节点**(G2 ✅) |
| fork 自 ws entry 之前的位置 | 复制路径不含任何绑定 → 新建,天然干净 ✅ |
| fork 后又 /tree 回 fork 点之前 | 读最近 = W1——**位置语义下这是对的**(你回到了那个历史位置)|
| 同对话多次回收累积的死 entry | 留在文件里成为惰性噪声,`getBranch` 永远读到最近活的;pi entry 不可删,本就不需要清理 ✅ |

### 3.2 Marina 端:resume 切回前加互斥校验(修 G4)

`handlePiConversationSwitch` 的 resume 分支,在 `getRecord(payloadWorkspaceId)`
存活判定后**追加一步**:反查 `sessionWorkspaceBindings`,若该 workspace 已被
**其他活跃 session** 绑定 → 不共享,走新建分支并返回新 id(bridge 会 append 修正
entry)。这同时治了「跨终端 resume 同一文件」的共享。同终端内的绑定覆盖
(fork/new 换绑)不受影响。

### 3.3 子会话适配:分层,不一步到位

- **L0(正确性,现状已成立)**:子会话 resume = 独立对话 = 自己的新 workspace。
  主锁继续过滤运行期子会话事件(ADR-028 不动摇)。
- **L1(亲缘透传,推荐必做)**:bridge 在 `session_start` 时把会话 header 的
  `parentSession`(父文件路径,若存在)随事件带上;Marina 把它记进 workspace
  元数据/日志。成本:bridge +协议各加一个可选字段。收益:诊断能力 +
  为 L2 铺路,不引入任何新行为。
- **L2(快照继承,backlog 候选)**:resume 子会话时,Marina 从父对话的 workspace
  **复制快照**作为初始面板状态——「从父视角看这个子 agent 动了哪些文件」。
- **L3(运行时可见性,**已实现 v0.3.4 / ADR-038,2026-09-10 开发者明示重开**)**:
  子 agent 运行期间终端状态聚合。最终落地比本节原案**窄**:不做「N 个子 agent
  运行中」聚合文案,只取状态灯语义——终端「工作中」= 主 agent 在干 ∨ 任一注册
  子 agent 在干(沿用同一个绿灯),全部收工 → idle + hasUnviewedWork;配泄露
  回收(15min 无事件视为死)与延迟 teardown。实现见
  `src/main/coordinators/pi-session-coordinator.ts` 的 TerminalPiAggregate。

### 3.4 升级分发

bridge 是随 Marina 内置分发的独立包(`pi-bridge-installer.ts`):`install()` 每次
都先 rm 再 cp 稳定目录,**内容会随重装刷新**;但「已装检测」只看 settings.json
packages 数组,已装则跳过——即**升级依赖用户再点一次安装按钮**。建议:启动时
比对内置版与稳定目录版(package.json version),不一致静默重拷(不重跑
`pi install`,路径不变 settings 无需动)。

---

## 第四部分:待裁决问题

### Q1:fork 的 workspace 语义——全新空 workspace,还是继承父的快照副本?

- **上下文**:3.1 修复后,「fork → Marina 新建空 workspace」成为事实默认
  (reason=fork 走 wantsNew)。但 fork 的产品语义是「从历史某点重开一条线」,
  对话上下文继承了,文件面板状态却是空的,体验上有一个断层。
- **可选**:(a)维持新空 ws;(b)copy-on-fork——新建时把父 ws 的面板快照复制过来
  作为起点(需要 Marina 侧把「父 ws id」传进创建流程,bridge 侧把 fork 时读到的
  继承绑定随事件带上即可,协议已具备)。
- **推荐**:**本次先**;copy-on-fork 列 backlog,等 3.1/3.2 落地后用真实 fork
  工作流评估断层痛感再决定。理由:快照复制引入「快照时点= fork 点还是现在」
  的语义问题(父对话 fork 后可能还在前进),需要单独想清楚,不该搭车。

### Q2:`/tree` 导航要不要即时切绑定?(依赖:无,但与 Q1 同族)

- **上下文**:G5 所述。bridge 监听 `session_tree` → 重算 leaf→root 最近绑定 →
  上报 Marina 切 workspace,即可做到「位置级绑定」的完全体。
- **代价**:同文件内频繁切 ws(每次 /tree 都可能换面板状态),行为变化明显;
  且 `session_tree` 事件在旧版 pi 上不存在,需要防御。
- **推荐**:**不监听,保持文件级绑定**。理由:「文件 = 对话 = workspace」心智
  简单一致;位置语义已通过 3.1 在 fork/resume 场景自然生效(见推演表第 4 行),
  已覆盖用户可感知的错绑问题;`/tree` 后若真要换面板,`/fork` 是显式出口。
  若日后用户反馈「tree 切分支想要对应面板」,再作为独立 feature 做。

### Q3:子会话适配做到哪一层?(依赖:无)

- **推荐**:本次做 **L0(现状确认)+ L1(亲缘透传)**;L2/L3 列 backlog。
  理由:L1 成本极低且无行为风险;L2 有快照时点语义问题(同 Q1);L3 是
  ADR-028 有意识裁剪的范围,重开必须开发者点头,不搭车。

### Q4:共享互斥的策略——拒绝共享新建,还是允许只读共享?(依赖:无)

- **上下文**:3.2 推荐独占。另一选项是允许多 session 绑同一 ws 但只提示。
- **推荐**:**独占,冲突方新建**。理由:「一个对话 ↔ 一个 workspace」是
  软件定义书 §「对话 ↔ workspace 自动绑定」的原意;共享会把 release 生命周期
  搅成 G4 描述的连带伤害;新建的代价(丢面板历史)与现状 first-match bug 的
  后果相同,不更差,且 entry 会被 bridge 落新 id 自动修正。

### Q5:bridge 自动升级要不要做?(依赖:无)

- **推荐**:做(3.4 方案,启动时版本比对静默重拷)。本次 bridge 必改
  (`getBranch` 读法 + L1 字段),没有自动升级,存量用户全部停留在带 G1 bug
  的版本上,修复等于没分发。

---

## 第五部分:影响面与测试清单(裁决后执行)

**改动面**:

| 文件 | 改动 |
|---|---|
| `packages/pi-marina-bridge/extensions/index.ts` | `readMarinaWorkspaceId` 改 `getBranch()` 最近匹配;`session_start` 带 `parentSessionFile`;防御旧 pi 无 `getBranch` 时回退现行为 |
| `src/main/coordinators/pi-session-coordinator.ts` | resume 分支加共享互斥;透传 `parentSessionFile` 到日志/元数据 |
| `src/main/pi-bridge-installer.ts` | 启动时版本比对静默重拷 |
| 协议(`file-panel-service.ts` 校验 + shared 类型) | `parentSessionFile` 可选字段 |

**测试**(沿用 `session-manager.test.ts` pi 段模式):

- [x] fork 继承:parentBinding 活 → 克隆新建(`session-manager.test.ts` fork 段 4 例:继承/回退/回收退化/new 不继承)
- [x] fork 血统首次激活不共享(payload==parentBinding → 克隆而非切回;≠ → 正常切回)(2 例)
- [x] G1 回归:bridge 纯函数 `pi-bridge-binding.test.ts` 5 例(branch 末尾优先/回退末尾/他分支不算/空;父文件尾读 3 例含截半行)
- [x] release 防护:同文件双 session 共享,最后占用者才 release(`session-workspace-coordinator.test.ts`)
- [x] cloneWorkspace 真实文件系统:文件复制+快照内部路径重写+源不动(`session-workspace-manager.test.ts` 3 例)
- [x] installer 自动升级:版本不一致重拷不 spawn/一致 no-op/未装不预装/损坏重建(`pi-bridge-installer.test.ts` 4 例)

> 注:原计划的「Marina 侧 G1 回归测试」调整为 bridge 纯函数测试——G1 根因在
> bridge 读法(Marina 只能收到 bridge 读出的结果),bridge 拆出 binding.ts 后
> 可单测;Marina 侧「死 id → 新建并返回新 id」已有既有用例覆盖。

## 实施落地(2026-09-03)

| 文件 | 改动 |
|---|---|
| `packages/pi-marina-bridge/extensions/binding.ts`(新) | branch-aware 绑定读 + 父文件尾读亲缘绑定纯函数 |
| `packages/pi-marina-bridge/extensions/index.ts` | session_start 上报 workspaceId(branch-aware)+ parentSessionFile + parentBinding |
| `packages/pi-marina-bridge/package.json` | 0.3.3 → 0.3.4 → **0.3.5**(现场修复,见下) |
| 现场回归修复(0.3.5) | `readLastWorkspaceBinding` 原尾部 64KB 读窗在「只绑过一次、对话长到 MB 级」的父文件上读不到头部绑定(实证:父 1.06MB/唯一绑定 L4 → parentWs=null,靠 payload 回退救回);改 readline 流式全文件前扫取最后命中,+32MB 护栏。回归测试:头部绑定×大文件必读出 |
| `src/main/session-workspace-manager.ts` | `cloneWorkspace`(复制文件+快照重写路径)+ `remapWorkspaceInternalPath` |
| `src/main/session-manager.ts` | `SessionWorkspaceSource` 接口加 `cloneWorkspace` |
| `src/main/coordinators/session-workspace-coordinator.ts` | `cloneForSession`;`onSessionDestroyed` 最后占用者 release 防护 |
| `src/main/coordinators/pi-session-coordinator.ts` | fork 继承(parentBinding 优先/回退/退化);resume 血统相等判定不共享;亲缘日志 |
| `src/main/http/local-http-gateway.ts` + `file-panel-service.ts` | 协议可选字段 parentSessionFile/parentBinding |
| `src/main/pi-bridge-installer.ts` + `index.ts` | `ensureUpToDate` 启动自动升级 |

验证:`npm run typecheck` ✅ · `npm test` 1595/1595 ✅ · `npm run lint` ✅ · `npm run smoke` PASS ✅
