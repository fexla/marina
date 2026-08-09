# 方案：workspace 绑定/复用 + 文件状态持久化（ADR-024）

> 关联：[规划-v0.3.3 § Feature D](./规划-v0.3.3-AI交互丰富度-20260801.md) ·
> [Wayfinder ticket #5（T04 grilling）](https://github.com/fexla/marina/issues/5)
> 日期：2026-08-01 · 状态：已定稿（grilling 闭环），待实现（T10）

## 1. 背景与目标

**用户意图**：AI 要能（1）在运行中的终端里**改变当前工作空间**；（2）退出 Marina 再启动时**继续用上一次的工作空间**（产物不丢、上下文延续）；（3）**绑定复用**以前的工作空间；（4）工作空间**记录文件面板状态**（打开了哪些文档、停在哪个位置、代码块运行结果），绑定时**自动恢复**。

**现状基线**（已探明）：
- workspace = **per-session 受管临时目录** `<root>/<sessionId-UUID>/`，1:1 绑 sessionId。
  - 创建：`session-workspace-manager.ts create(sessionId)`；注入：`session-manager.ts:926-930` 写 `env.MARINA_WORKSPACE`（注入在模板 env 之后，模板无法覆盖，有回归测试）。
  - 销毁：session 销毁 → `release()` 标 `closedAt`，目录保留 `workspaceRetentionDays`（默认 7）天后由 `cleanupExpired()` 删。
  - manifest：`{version:1, workspaces:{<sessionId>:{closedAt}}}`，只有 closedAt。
- CLI `marina workspace`：只读 `$env:MARINA_WORKSPACE` 打印路径，不生成/查找/接受参数。
- **缺口**：无 name/createdAt/pinned/pathScope；无枚举/bind/switch 接口；session 不持久化（ADR-008）→ sessionId 不可复用；7 天回收会删未保护 workspace；文件面板状态只在 renderer 内存（`store.tsx filePanels Map` + `code-block-run-cache.ts`），不落盘。

## 2. 关键决策（grilling 共识）

### 2.1 身份模型：workspaceId 解耦 sessionId
- 每个 workspace 有独立稳定 `id`（创建时生成 UUID，**与 sessionId 解耦**）。目录 = `<root>/<workspaceId>/`。session 运行中可"领养"别的 workspaceId 的目录。
- main 维护 `Map<sessionId, workspaceId>`（当前绑定）。CLI 一律**查 main**（按 `TERMINAL_ID`→session→workspaceId→dir）。
- 切换后子进程的 `$env:MARINA_WORKSPACE` 退化为 spawn 时的**陈旧初始值**——SKILL.md 必须更新契约：**"`$env` 不可靠，必查 main"**。非 shell 写工具调用 `marina workspace` 拿真值。

### 2.2 bind = upsert
`marina workspace bind --name X`：
- X 在当前 pathScope 内**不存在** → 把当前 workspace 命名为 X + `pinned=true` + 记 pathScope。目录不变、session 不动。
- X **已存在**（且 pathScope 匹配）→ 当前 session **切到 X 的目录**：当前临时 workspace `release` 弃掉（**不警告、不合并**，AI 应早 bind），main 把 session→workspaceId 指向 X，推 X 的快照给 renderer 恢复。

**命名冲突缓解（A2）**：
- 切到**已存在**的 X 时，CLI 打印提示「已切到现有 X（创建于 …，N 个文件）」让 AI 察觉这是切换不是新建。
- `bind --name X --new`：强制"必须新建"，X 已存在则**报错**（exit USAGE）。

### 2.3 pathScope = `session.pathId`（本地/SSH 统一）
- pathScope 取 `session.pathId`：本地 = normalize 的本地目录；SSH = `ssh:<profileId>:<remotePath>`。
- `bind`/`list`/`unpin` 按 pathScope 过滤；`bind` 校验 `target.pathScope === currentSession.pathId`，不符拒绝。校验在 **main 端**，不信 renderer。
- 目录永远在本地 daemon（远程 session 的 workspace 也是本地 dir），pathScope 只是**身份标签**，不代表目录位置。
- 边角：`~/repo` vs `~/repo/`（尾斜杠）会让 pathId 字符串不同→算不同 path，**v1 不特殊处理**（沿用 pathId normalize 现状）。

### 2.4 CLI 命令面（**砍掉删除能力，防 AI 误操作**）
- `workspace` — 打印当前 session 绑定的 workspace 绝对路径（查 main）。
- `workspace list [--json]` — 列当前 pathScope 下的 workspace（name/createdAt/closedAt/pathScope/files 数）。
- `workspace bind --name X [--new]` — upsert（见 2.2）。
- `workspace new` — 当前 session **切回一个新的空临时 workspace**；原命名 workspace 保留 pinned 不动。（原草案的 `unbind` 改名为 `new`，语义更直观。）
- `workspace unpin [--name X]` — **剥掉 name + pinned**，workspace 退回普通态：无人占用则 `closedAt=now` 按 `workspaceRetentionDays` 自然回收；当前 session 仍占用则等它关闭后再回收。这是"不要了"的**安全出口**——不立即删，给保留期兜底。
- **没有 `remove`**（防 AI 误删数据）。要清理只能 `unpin` 让它到期回收，或用户在设置页手动清（后续加入口）。

### 2.5 pinned 不自动回收；name 唯一性
- `pinned=true` 的 workspace **跳过** `cleanupExpired`，永不自动删（ADR 与既有保留期规则叠加）。
- name **pathScope 内唯一**：manifest `(pathScope, name)` 联合唯一；不同 path 可重名。
- name 合法字符：**非空、禁路径分隔符（`/` `\`）、≤64 字符**（name 只进 manifest + CLI 参数，**不进文件系统路径**）。

### 2.6 文件面板状态快照
- **位置**：独立文件 `<workspace>/__marina_state__/file-panel.json`，**不并入 manifest**（manifest 低频写、快照滚动高频写，分开避免 churn）。
- **粒度**：
  - `openedFiles:[{path,kind,origin?}]` + `activeFilePath`。`origin` 仅 Git 生成的 diff 使用，保存 `{kind:'git-diff',relativePath,repoIdentity,sourceMissing}`，确保 bind 切走再切回后「打开源文件」仍使用原仓库导航真值；旧快照无该可选字段仍兼容。
  - `scroll:{<filePath>:{scrollTop,scrollLeft}}`
  - **代码块运行结果**（C2，用户明确要）：`runs:[{key, state, output, exitCode}]`，key = `createCodeBlockKey(sessionId, documentPath, sourcePosition, code)`。⚠️ 运行输出**可能含敏感信息**，已接受该 tradeoff（与远程 gallery 同类顾虑）；落盘在本地 daemon 的受管目录，不外传。
- **路径形式**：workspace 内文件存**相对 workspace 根**；workspace 外文件（如 md-link 打开的用户磁盘文件）存**绝对路径 + 标记**。恢复时相对路径拼当前 workspace 根。
- **写入时机**：滚动**停滚 500ms debounce** 落盘；切走面板 / 关 session / 切 bind 时**强制 flush**；**不进逐字节热路径**（附录 H）。
- **恢复**：bind 切到某 workspace 后，main 读其 `file-panel.json` 推给 renderer 恢复 openedFiles/active/scroll/runs。文件或结果**缺失则跳过**；active 缺失退到第一个存在的或空。
- **粒度不做（本期内）**：只记"文件列表 + 滚动 + 运行结果"；不记其它面板 UI 状态。

### 2.7 CLI 离线退化
- `workspace`/`bind`/`new`/`unpin`/`list` 改查 main 后，main 不通（ping 失败）→ **报错退出**（exit 1，与现有 `show` 一致），**不悄悄 fallback 到 `$env:MARINA_WORKSPACE`**（fallback 给陈旧值，违背"main 是真值源"）。

## 3. manifest schema 与迁移

```jsonc
// <root>/manifest.json
{
  "version": 2,
  "workspaces": {
    "<workspaceId>": {
      "name": "feature-x" | null,     // null = 未命名临时
      "createdAt": 1699000000000,
      "closedAt": number | null,       // null = 仍有 session 占用
      "pinned": false,
      "pathScope": "C:\\proj" | "ssh:p1:~/repo" | null
    }
  }
}
```

**迁移**（version 1 → 2）：
- 旧 manifest 以 sessionId 为 key、record 只有 `closedAt`。
- 迁移：key 不变（把旧 sessionId 当作 workspaceId——这些目录本就是 `<sessionId>` 命名）；每条补 `name=null, createdAt=closedAt ?? now, pinned=false, pathScope=null`。
- 迁移幂等、原子写（JsonStore），损坏回退默认值。

## 4. 快照 schema

```jsonc
// <workspace>/__marina_state__/file-panel.json
{
  "version": 1,
  "openedFiles": [
    { "path": "review.md", "kind": "markdown", "external": false },
    {
      "path": "__marina_diff__/change.diff",
      "kind": "diff",
      "external": false,
      "origin": {
        "kind": "git-diff",
        "relativePath": "src/change.ts",
        "repoIdentity": "<opaque sha256>",
        "sourceMissing": false
      }
    }
  ],
  "activeFilePath": "review.md",
  "scroll": { "review.md": { "scrollTop": 240, "scrollLeft": 0 } },
  "runs": [
    { "key": "<createCodeBlockKey>", "state": "exited", "output": "...", "exitCode": 0 }
  ]
}
```

## 5. CLI 命令规格（摘要）

| 命令 | 行为 | 失败 |
|---|---|---|
| `workspace` | 查 main，打印当前 workspace 绝对路径 | 离线 exit 1 |
| `workspace list [--json]` | 当前 pathScope 下的 workspace 列表 | 离线 exit 1 |
| `workspace bind --name X [--new]` | upsert：新→命名+pin；存在→切+恢复（打印提示）；`--new`+存在→报错 | pathScope 不符/重名/离线 |
| `workspace new` | 切回新空临时 workspace | 离线 exit 1 |
| `workspace unpin [--name X]` | 剥 name+pinned，退回可回收 | X 不存在/非当前 pathScope |

## 6. 改动面

- `src/main/session-workspace-manager.ts`：manifest schema v2 + 迁移、`bind`/`list`/`new`/`unpin`、pathScope 校验、回收跳过 pinned、`create()` 改用 workspaceId。
- `src/main/session-manager.ts`：维护 `Map<sessionId, workspaceId>`（运行中可切）；`TERMINAL_ID`→session 查询接口；`MARINA_WORKSPACE` 从"注入即固定"改为"main 维护映射"。
- `src/main/file-panel-service.ts`：快照读写（`__marina_state__/file-panel.json` 含 runs）；bind 时推快照给 renderer；HTTP 路由加 `workspace list/bind/new/unpin` + `workspace`（查当前）。
- `src/skills/show-in-marina/marina.ps1` + `.cmd` + `marina`：`workspace` 改查 main；新增 `list/bind/new/unpin` 子命令。
- `src/skills/show-in-marina/SKILL.md`：更新契约（`$env` 不可靠，必查 main）。
- `src/renderer/store.tsx`：bind 后恢复 file-panel 状态（含 runs）；状态变化触发快照写（debounce）。
- `src/shared/protocol.ts`：workspace 相关 IPC（查当前/list/bind/new/unpin/状态快照）。
- `src/renderer/components/file-panel/code-block-run-cache.ts`：bind 恢复时把 snapshot 的 runs 灌进缓存。

## 7. 不做（本期内）

- 不做 `remove`（防误删；用 `unpin` 到期回收替代）。
- 不做 `unpin` 之外的"退回可回收"命令。
- 快照不记文件面板以外的 UI 状态（git/文件树面板状态不进 workspace 快照）。
- 不为 pathId 尾斜杠等 normalize 边角做特殊处理。
- pinned 不设数量上限（靠 unpin 自然回收；设置页手动清入口后续加）。

## 8. 测试要求

- manifest schema v1→v2 迁移（幂等、原子、损坏回退）。
- bind upsert 两路径（新建命名 / 切到已有）+ pathScope 校验（不符拒绝）+ `--new` 冲突报错。
- pinned 免回收（cleanupExpired 跳过 pinned）。
- 运行中切换：session→workspaceId 映射更新；CLI 查 main 返回新目录。
- 快照读写恢复（openedFiles/active/scroll/runs；缺失跳过；路径相对/绝对）。
- 跨重启复用：bind 后重启 → list 仍见 → bind 同名切回 → 快照恢复。
- CLI 集成（marina.ps1）：workspace/list/bind/new/unpin + 离线 exit 1。
- name 合法字符校验 + pathScope 内唯一性。
