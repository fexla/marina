# 方案：pi 对话绑定 Marina workspace + 终端活动状态增强（pi ↔ Marina 联动 package）

> 关联：[ADR-024 workspace 绑定/复用](./方案-workspace绑定复用与状态持久化-20260801.md) ·
> [软件定义书 §13.2 / §14.6 / §14.10](./软件定义书.md) ·
> [session 指示灯现状测绘](./方案-pi对话绑定workspace-20260805.md)（第一轮）
> 日期：2026-08-05 · 状态：**全部定稿，待实现** · 第一轮 1-8 + 第二轮 9-14 均已裁决
> 实现顺序：软件定义书 ADR-028 → Marina 侧（types/settings/service/session-manager/renderer）+ 测试 → pi package

---

## 0. 进度状态

### 0.1 第一轮 8 条已定稿（✅ = 已裁决）

| # | 议题 | 裁决 | 备注 |
|---|---|---|---|
| 1 | 哲学：pi 对话自动绑 workspace 是否越界 | ✅ 允许 + 新 ADR | **已写入软件定义书 §13.2 / §14.6**（workspace=临时交互辅助，≠ project 容器） |
| 2 | 对话身份→命名 | ✅ `pi-<sessionId前8位>` | —— |
| 3 | 事件映射（new/fork→新；resume/startup→bind；reload→不动；shutdown→不动） | ✅ 按推荐 | —— |
| 4 | 改名同步 workspace | ✅ 不做 | **新增**：pi 对话名 → Marina 终端显示名（见 §2 问题 9） |
| 5 | 垃圾回收 | ⚠️ **改**：要自动清理，走原 retentionDays，不特殊持久 | 见 §1，影响问题 2 的实现 |
| 6 | `settings.piIntegration` 形态 | ✅ 按推荐（去掉清理按钮） | —— |
| 7 | package 放 `packages/pi-marina-bridge/` + 复用 install-marina 通道 | ✅ 按推荐 | —— |
| 8 | `POST /pi-session-event` fire-and-forget | ✅ 按推荐（事件类型需扩展，见 §2） | —— |

### 0.2 第二轮新增需求（用户追加）

> 用户在第一轮裁决后追加了两块新需求，本节展开为新的决策树（§2 问题 9-14）。

**(N1) 终端活动状态检测增强**（原话要点）：
- 左侧侧栏现有"检测终端里是否在运行 pi，运行则有 UI 提示"。
- 做了 pi 插件后可**更精准**：直接通过 pi 插件把准确信息传给 Marina（替代字节流 heuristic）。
- **新增状态**：pi 干完活了但用户还没看过 → 原本"整条转为竖线"，现在**竖线用警告色**（如黄色，依赖主题）告诉用户"工作完了但你还没看过"；用户切到那个终端 → 转回正常竖线颜色。

**(N2) 隐含功能**：Marina 需要准确知道**终端内是不是 pi 在工作**（区分"跑 pi"vs"跑别的"）。

**(N3) 对话名反映到终端名**（问题 4 衍生）：Marina 显示的终端名称可以直接用 pi 对话名。

---

## 1. 第一轮裁决的关键修正：问题 5（垃圾回收）

**用户裁决**：需要自动清理，**原有 workspace 自动回收逻辑不变**，本来就是临时数据，没了就没了。

**这对实现的影响**（关键，需确认我的理解对）：
- ADR-024 现状：`bind(name)` 会设 `pinned=true`，**pinned 免回收**。这与"走原回收逻辑"冲突。
- 用户意图：pi 对话绑定的 workspace **不特殊持久** —— 终端关闭即 `release`，按 `workspaceRetentionDays`（默认 7 天）自然回收。重启后 pi resume 那个对话时，workspace 可能已被回收（"没了就没了"），此时 resume 给当前终端一个新 workspace 即可。
- **结论**：pi 绑定的 workspace **不应 pinned**。但运行时切换对话（同一终端内 `/new` `/resume`）仍需"切回对应 workspace"的定位能力。

**实现路径抉择**（这是实现细节，列出让开发者确认方向）：
- **路径 A（改 bind 解耦）**：让 `SessionWorkspaceManager` 支持"named but not pinned"（name 只作切换定位标识，pinned 仍 false）。改动 ADR-024 的"name 隐含 pinned"语义。
- **路径 B（独立映射，推荐）**：Marina 侧新增 `Map<piSessionId, workspaceId>` 独立映射（SessionManager 或新 service 持有），workspace 本身**不命名、不 pin**，完全走原回收逻辑。切换对话时查映射：目标 workspace 还活着就切回，死了就新建并更新映射。

**我的推荐**：**路径 B**。理由：(1) 完全不碰 ADR-024 的 name/pinned 语义（已封箱代码，AGENTS.md §7）；(2) workspace 保持"纯临时"，与用户"没了就没了"心智一致；(3) 映射是运行时内存态，终端关了连同 session 一起没，干净。

> ⚠️ 若确认路径 B，则问题 2 的"`pi-<短id>` 命名"就**不再需要**（切换靠映射不靠 name）。`marina workspace list` 里这些 workspace 显示为未命名临时。这没问题——用户说 workspace 不在 UI 暴露为列表概念。

---

## 2. 第二轮新决策树（逐条 grill）

### 问题 9（对话名 → 终端显示名）：pi 对话名怎么反映到 Marina 终端名？

**背景事实**（scout 测绘 + 现有代码）：
- Marina session 有 `displayName`，受 `manuallyRenamed` 标志保护：用户手动改名（`cmd:session:rename`）后，OSC 0/1/2 标题事件不再覆盖（`session-manager.ts`，IPC §5.2）。
- pi 有 `session_info_changed { name }` 事件（`/name` 设置对话名）。
- pi 对话名是用户在 pi 里给对话起的名字（如"重构认证模块"），可空、可改、可重复。

**推理过程**：
- "对话名 → 终端名"和"对话名 → workspace 名"是两件事（用户问题 4 原话："改对话名和 workspace 没关系，就像改用户名不改用户 id"）。
- 但终端名（sidebar/tab 显示）用对话名是合理的——用户一眼知道这个终端在干啥。
- 冲突点：pi 改名 vs 用户手动改终端名 vs OSC 标题，三者谁优先？
  - 现有优先级：用户手动改名（`manuallyRenamed=true`）> OSC 标题。
  - pi 改名应插在哪？pi 是终端里跑的程序，它的"对话名"语义上类似 OSC 标题（程序自己声明），但比 OSC 更结构化、更可信。

**名词定义**：
- **pi 对话名** = pi 内 `/name` 设的对话显示名，随 `session_info_changed` 上报。
- **终端名** = Marina session 的 `displayName`，显示在 sidebar/tab。

**待裁决点**：pi 对话名与"用户手动改终端名"的优先级？

**我的推荐**：
- **pi 对话名当作"程序声明标题"处理，受 `manuallyRenamed` 保护**：用户手动改了终端名 → pi 对话名**不覆盖**（尊重用户意图）；用户没手动改 → pi 对话名覆盖 OSC 标题（pi 比 shell 的 OSC 更可信）。
- 实现：extension 把对话名经 `/pi-session-event` 发给 Marina，Marina 在 `!manuallyRenamed` 时更新 `displayName`。这复用现有保护机制，零新优先级规则。
- 对话名为空（用户 `/name` 清空）→ 不主动改终端名（保持现状），不强制清空。

---

### 问题 10（pi 身份声明）：Marina 怎么准确知道"这个终端在跑 pi"？（需求 N2）

**背景事实**：
- 现状 Marina 靠字节流 heuristic 判 active/idle（有输出=active，2s 无输出=idle），**无法区分"跑 pi"vs"跑别的"**。
- BETA-006 的 `recheckIdle` 用 LLM 看 scrollback 判 keep-active/go-idle，是最接近的地基，但它只影响 active/idle 二元态，不区分程序身份。

**推理过程**：
- 要做 N1（精准状态 + done-unread），Marina 必须知道"这个终端是 pi"。否则 done-unread 的语义无处附着（普通终端没有"工作完成"概念）。
- 最干净的信号：pi extension 在 `session_start { reason: "startup" }` 时**主动声明身份** —— 告诉 Marina "TERMINAL_ID 这个终端里跑的是 pi"。终端退出（pi 进程结束 → session_shutdown reason:quit，或 session 销毁）→ 声明失效。
- 这替代了"靠 heuristic 猜是不是 pi"，且零成本（extension 本就知道自己是 pi）。

**待裁决点**：身份声明的粒度与生命周期？

**我的推荐**：
- **session 级布尔标记**：Marina 给 session 加一个 `isPiAgent: boolean`（运行时内存态，不持久化）。extension startup 时声明 true；session 销毁 / pi 退出时清除。
- 非 pi 终端 `isPiAgent=false`，Marina 完全走原 heuristic，**零行为变化**。
- 这个标记也驱动 done-unread 渲染（只有 `isPiAgent` 的 session 才有 done-unread 态）。

---

### 问题 11（pi 工作状态事件）：pi 用哪些事件表达"开始工作/完成工作"？

**背景事实**（pi 事件系统）：
- `before_agent_start` / `agent_start` — 用户提交 prompt 后，agent loop 开始。
- `agent_end` — 一次 agent run 结束（但可能自动重试/压缩后续跑）。
- `agent_settled` — pi 不会自动继续了（无重试/压缩/续跑），**真正"这一轮干完了"**。
- `turn_start`/`turn_end` — 每个 turn（一次 LLM 回复 + 工具调用）。

**推理过程**：
- "工作完成"的正确信号是 `agent_settled`，不是 `agent_end`（后者后头可能还有自动重试）。用户说"pi 干完活了"= settled。
- "开始工作"用 `agent_start`（或 `before_agent_start`）。用户提交 prompt → working。
- 中间态（turn 之间、工具调用）不必单独上报，Marina 只关心 working ↔ settled 两态。

**待裁决点**：上报的工作状态有哪几态？用什么事件驱动？

**我的推荐**：两态切换：
- `agent_start` → 上报 `pi-status: working`
- `agent_settled` → 上报 `pi-status: settled`（= "done"，若用户未查看则进入 done-unread）
- 不上报 turn 级中间态（噪音，Marina 用不上）。
- extension 把这两个事件经 `/pi-session-event` 转发（扩展问题 8 的 schema，见问题 14）。

---

### 问题 12（done-unread 状态机位置 + 指示灯视觉）：新状态怎么叠加？颜色怎么定？ ✅ 已裁决

**裁决**：**不独立 pi 维度**。改为 SessionInfo 的**通用运行时字段** `hasUnviewedWork: boolean`
（内存态，不持久化）。v1 由 pi `agent_settled` 触发；**后续会做一个普遍性逻辑处理非 pi 的情况**
（任何终端"工作完成但用户没看"都触发，不绑死 pi）。其他按推荐。

**背景事实**（scout 测绘，关键）：
- 指示灯 = `.session-state-bar`：active=满底(100%宽)+脉冲+`--color-info`；idle=3px 竖线+`--color-info`；exited=3px 竖线+`--color-text-muted`(灰)。
- **active/idle 同色，靠宽度区分**；只有 exited 靠变色。
- `--color-warning` 主题变量**每个主题都有值**（如 rose-pine→gold, dracula→yellow）。
- 现无 unread/badge 概念。

**最终设计**：
- **通用字段 `hasUnviewedWork`**（非 piStatus 维度）：
  - 触发：pi `agent_settled`（完成一轮工作）且用户当前没在看 → main 设 `hasUnviewedWork=true`。
  - 清除：用户查看（`cmd:session:mark-viewed`）/ pi 重新开始工作（`agent_working`→ false）/ session exited。
  - v1 只接 pi；v2 补非 pi 普遍逻辑（如"命令执行完且用户未查看"），字段已通用。
- **视觉**（按推荐）：`hasUnviewedWork && state==='idle'` → 3px 竖线背景改 `var(--color-warning)`，**不动宽度**。
  active 满底时忽略此色（按原 active 显示，不加额外提示）；exited 时失效。
- **复用现成 `--color-warning`**，零主题改动。
- 注意：问题 10 的 `isPiAgent` **只驱动 workspace 绑定**，**不再驱动指示灯**——指示灯只看通用 `hasUnviewedWork`。

---

### 问题 13（"用户查看了"的判定 + 状态归属）：done-unread 在哪维护？何时清除？

**背景事实**（scout）：
- `state.selectedSessionId`（renderer 私有 view state）+ `state.lastSelectedAt` 是现有"用户在看哪个"信号，但**只在 renderer，不上 main**。
- 多窗口下每个窗口 selected 私有。

**推理过程**：
- done-unread 的归属有两种放法：
  - **(A) main 端持有**：main 给 session 加 `piStatus` 字段，随 `evt:session:state-changed` 推给所有窗口。清除靠 renderer 上报"我选中了 X"。需新增一个轻量 IPC（select 不必上报，但"查看清除"要）。
  - **(B) renderer 端持有**：main 只转发 pi 的 working/settled 事件，每个窗口自己维护 `Map<sessionId, doneUnread>`，选中即清除。跨窗口不一致（A 窗看了清掉，B 窗还显示黄）——但这可能正是用户要的（每个窗口独立"我看过没"）。
- 用户原话"用户切换到那个终端，再转为正常"——单数语境，倾向 per-session 而非 per-window（任一窗口看了就算看过）。

**待裁决点**：done-unread 是 per-session（main 持有，任一窗口看即清）还是 per-window（renderer 持有，各窗独立）？

**我的推荐**：**per-session（路径 A）**。理由：
1. 语义准确："这个终端有未看成果"是 session 属性，不是窗口属性。用户在 A 窗看了，B 窗不该再提示。
2. 与 sidebar 跨窗口一致（sidebar 在每个窗口都显示同一份 session 状态）。
3. 代价小：只需一个"查看上报"IPC（renderer select-session 时顺带发 main），main 清 `piStatus` 并广播。

> 边角：用户没开 sidebar 的窗口/远程窗口 —— selectedSessionId 仍是"本窗口在看哪个"，远程窗口选中也会上报清除。符合"任一 client 查看即清"。

---

### 问题 14（HTTP 协议扩展）：`/pi-session-event` 的完整 schema（合并问题 8 + 新事件）

**背景事实**：问题 8 已定 `POST /pi-session-event` fire-and-forget。现需容纳：对话生命周期（start/shutdown）、身份声明、工作状态、对话名。

**推理过程**：一个端点多种 event，body 用 `event` 字段区分。extension 始终带 `terminal`（=TERMINAL_ID）+ `piSessionId`。

**待裁决点**：schema 如下是否 OK？

**我的推荐**：
```
POST /pi-session-event   (Bearer auth, body JSON)
body: {
  terminal: string;       // = env.TERMINAL_ID
  piSessionId: string;    // = ctx.sessionManager.getSessionId()
  event:
    | "session_start"     // 含 reason → 驱动 workspace 绑定/切换 + 身份声明
    | "session_shutdown"  // reason
    | "agent_working"     // pi 开始工作
    | "agent_settled"     // pi 完成工作 → 触发 done-unread
    | "name_changed";     // 对话名变更 → 更新终端名
  reason?: "startup"|"new"|"resume"|"fork"|"reload"|"quit";  // session_* 事件带
  name?: string | null;                                       // name_changed 带
}
response 200: { ok: true }   // fire-and-forget；Marina 异步处理，失败只 log
```
- extension 对每个事件独立 POST，不打包。
- `agent_working` 收到时 main 顺便把 `piStatus` 置 working（若有 done-unread 先清掉）。

---

## 3. 更新后的改动面（含新需求）

**Marina 侧（src/）**：
- `src/shared/types.ts`：`Settings` 加 `piIntegration`；`SessionInfo` 加运行时 `isPiAgent?`、`piStatus?`（'working'|'done-unread'|undefined）—— 内存态，不持久化。
- `src/main/settings-manager.ts`：`DEFAULT_SETTINGS.piIntegration` 默认值。
- `src/main/file-panel-service.ts`：`handle()` 加 `POST /pi-session-event`，分发到 SessionManager 新方法 `applyPiSessionEvent(...)`。
- `src/main/session-manager.ts`：
  - `applyPiSessionEvent`：按 event + settings 决策（workspace 切换走路径 B 的 `piSessionId→workspaceId` 映射；设 `isPiAgent`/`piStatus`；`name_changed` 时 `!manuallyRenamed` 则更新 displayName）。
  - done-unread 清除：新增轻量 IPC `cmd:session:mark-viewed`（renderer select 时发）。
- `src/shared/protocol.ts`：新 HTTP 端点契约 + `cmd:session:mark-viewed`；`evt:session:state-changed` 的 `changes` 可携带 `piStatus`。
- `src/renderer/store.tsx`：select-session 时发 `mark-viewed`；订阅 `piStatus` 变化。
- `src/renderer/components/Sidebar.tsx`：`.session-state-bar` 渲染 —— `piStatus==='done-unread'` 时加 `data-pi-done` 属性。
- `src/renderer/styles/global.css`：`.session-state-bar[data-pi-done='true']` → `background-color: var(--color-warning)`（仅 idle 形态，不动 active/exited）。
- `src/renderer/...SettingsView.tsx`：piIntegration 设置 UI（总开关 + new/resume 两个开关；**无清理按钮**——走自动回收）。
- 软件定义书：新增 ADR-028（pi 集成）+ §14.10 pi 集成小节 + §8.3 状态机补"piStatus 叠加维度"说明。

**pi package 侧（packages/pi-marina-bridge/）**：
- `package.json`（pi manifest → `extensions/index.ts`，peerDeps：pi-coding-agent、typebox）。
- `extensions/index.ts`：检测 env（MARINA_SERVICE/TOKEN/TERMINAL_ID）→ 订阅 `session_start`/`session_shutdown`/`agent_start`/`agent_settled`/`session_info_changed` → fetch POST `/pi-session-event`。非 Marina 环境 no-op。
- `README.md`。

**测试**（`src/main/`，按 AGENTS.md §5 必测）：
- `applyPiSessionEvent`：settings 关闭时 no-op；session_start new→建 workspace+映射；resume→切映射（活则切/死则建）；agent_settled→piStatus=done-unread；mark-viewed→清 done-unread；name_changed 在 manuallyRenamed 时不动。
- 路径 B 映射：piSessionId→workspaceId，workspace 走原 release/retentionDays（不 pin）。
- 指示灯视觉人工测（renderer 不写自动测试）。

---

## 4. 不做（v1）

- 不做 workspace rename 同步（问题 4）。
- 不做 workspace 手动清理入口（问题 5 改：全自动回收）。
- 不做 active(working) 额外提示（问题 12c）。
- 不做 turn 级中间态上报（问题 11）。
- 不做 per-window done-unread（问题 13，选 per-session）。
- 不把 workspace 升格为 UI 一级概念（问题 1 边界）。

---

## 5. 请开发者逐条裁决（第二轮）

> 第一轮 1-8 已 ✅。请填第二轮 9-14。问题 5 的路径 A/B 也请确认。

- [ ] 问题 5 修正：pi workspace **不 pin**，走原 retentionDays 自动回收 → 实现走**路径 B（独立 piSessionId→workspaceId 映射，workspace 不命名）**？
- [ ] 问题 9：pi 对话名 → 终端名，受 `manuallyRenamed` 保护（用户手改终端名则 pi 不覆盖），对话名为空不动？
- [x] 问题 10：session 加运行时 `isPiAgent` 标记（extension startup 声明，销毁清除）？
- [x] 问题 11：`agent_start`→working、`agent_settled`→settled 两态，不上报 turn 中间态？
- [x] 问题 12：done-unread 改为**通用维度** `hasUnviewedWork`（不独立 pi 维度，后续普遍化处理非 pi）；视觉=3px 竖线换 `--color-warning`，不动宽度，active 不加提示。
- [x] 问题 13：done-unread per-session（main 持有，任一窗口查看即清，靠新 `cmd:session:mark-viewed`）？
- [x] 问题 14：`/pi-session-event` 多事件 schema（session_start/shutdown/agent_working/agent_settled/name_changed）如上？

全部定稿后我开实现：先软件定义书 ADR-028 + §14.10，再 Marina 侧（types → settings → service → session-manager → renderer 指示灯）+ 测试，最后 pi package。
