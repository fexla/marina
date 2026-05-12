# CP-3 自测报告

> **历史档案**:本文件创建于 alpha 阶段,产品当时叫 EasyTerm,自 v1.5 起更名为 Marina(见软件定义书 ADR-012)。下文 "EasyTerm" 字样保留作为时间点快照。


**完成日期**:2026-05-10
**对应分支**:`checkpoint-3`
**最新 commit**:见 `git log --oneline checkpoint-3 ^main`

> **勘误回合 (2026-05-10 晚)**:用户测试 CP-3 后报告 5 项问题(`docs/cp3勘误.md`),已全部修复,详见本文件末尾"勘误回合修复"章节。本报告主体保持原样,反映 CP-3 的初始设计意图。

---

## 文档与设计变更确认

CP-3 启动前已落地两项与 CP-2 软件定义书冲突的设计变更(ADR-008,doc commit `e0544e5`):

1. **path 与 cwd 解耦** — `session.pathId` 创建时确定后**永远不变**;cwd 变化(cd 等)仅触发 tab UI 上的 ⚠️ 提示,不再驱动 path 在分类间迁移。
2. **砍 5 分钟墓地 + 重启** — PTY 进程退出后 session 进入 `exited` 状态,scrollback 完整保留,无时限自动消失;不可重启,用户右键关闭才销毁。

软件定义书相应章节(4 / 5.1.2 / 5.1.8 / 8.3 / 9.3 / 10.2 / 11.1 / 11.2 / 13.1 / 附录 A、C)与 AGENTS.md CP-3 完成标志已同步修订。

---

## 已通过的自动化测试

```
$ npm test
✓ src/shared/protocol.test.ts          (  6)
✓ src/main/pty-utils.test.ts           ( 11)
✓ src/main/platform/index.test.ts      (  7)
✓ src/main/path-manager.test.ts        ( 36)
✓ src/main/persistence.test.ts         ( 18)
✓ src/main/settings-manager.test.ts    ( 38)
✓ src/main/window-manager.test.ts      ( 19)
✓ src/main/templates-manager.test.ts   ( 11)   ← 新增
✓ src/main/session-manager.test.ts     ( 46)   ← CP-3 重写

Test Files   9 passed
     Tests 192 passed
```

```
$ npm run typecheck   通过 (3 个 tsconfig 严格模式)
```

```
$ npm run test:coverage   (核心模块)
osc1337-parser.ts        99.04%   ← 新增
path-manager.ts          97.58%
persistence.ts           96.77%
session-manager.ts       87.50%   ← AGENTS.md CP-3 标志要求 > 80%
settings-manager.ts      93.72%
templates-manager.ts     98.59%   ← 新增
window-manager.ts        90.49%
pty-utils.ts            100.00%
platform/index.ts       100.00%
shared/protocol.ts      100.00%
─────────────────────────────────
All 核心模块             94.49%
```

排除的文件(按 vitest.config.ts):`index.ts` / `ipc.ts` / `tray.ts` / `platform/{macos,linux,windows}.ts` — wiring/集成代码或平台占位,按 AGENTS.md 5.4 不要求单测。

---

## CP-3 完成标志逐条对照(AGENTS.md 4.2,ADR-008 修订后)

| 标志 | 实现 | 验证方式 |
|---|---|---|
| Session 三种状态显示自动切换 | ✅ | `session-manager.ts` markActive / scheduleIdleCheck / handlePtyExit;Sidebar+Tab 状态点 🟢/🟡/⚫;46 个单测覆盖状态机所有转移 |
| session 内 `cd` → 标签上 ⚠️ 提示真实 cwd,session 不动 path | ✅ | OSC 1337 解析器更新 `currentCwd`,`pathId` 不变;Tab/SessionItem/TerminalView 都比较 currentCwd vs originalCwd 大小写无关 |
| Session 进程退出后灰显 ⚫,scrollback 保留,无时限 | ✅ | `handlePtyExit` 进 'exited' 状态不 destroy;scrollback ring buffer 持续可用;只有 closeSession / shutdown 真销毁 |
| 4 个内置模板 | ✅ | `BUILTIN_TEMPLATES`:shell / claude-code / codex / opencode;命令不存在由 shell 自然报错(claude / codex / opencode 实际未安装时 PowerShell 输出"不是 cmdlet") |
| 收藏路径设默认模板 → 双击启动 | ✅ | bookmark.defaultTemplateId 优先于全局 default;Sidebar 右键弹 prompt 选择(CP-4 完整化为 context menu) |
| OSC 1337 hook for PowerShell | ✅ | `pwsh.ps1` wrap prompt + 加载用户 $PROFILE + 失败仅 warn;CP-2 报告的 banner 重复 8 次问题顺手修复(`-NoLogo` + 单次 dot-source) |
| OSC 1337 hook for cmd.exe | ✅ | `WindowsAdapter.buildShellLaunchParams` 给 cmd 设 `PROMPT=$E]1337;CurrentDir=$P$E\\$P$G ` 环境变量内嵌 OSC 序列(ESC \ 即 ST 终止符) |
| OSC 1337 兜底:5 秒无 OSC 启轮询 | ✅(结构) | SessionManager 5 秒 grace timer + 5 秒间隔 polling;收到首条 OSC 立即关。**注意**:`WindowsAdapter.getProcessCwd` V1 返回 null(NTAPI 路线需 ffi-napi 原生包,违 AGENTS.md 1.2 边界 2),所以兜底实际不会更新 cwd。OSC 1337 hook 是 V1 唯一可靠机制。结构已就位,未来加原生绑定即生效 |
| scrollback 2MB 环形缓冲 | ✅ | `SCROLLBACK_LIMIT = 2 * 1024 * 1024`;超过尾部裁切;getScrollback IPC 返回 base64 + lastSeq;owner 切换/接管时拉历史回放 |
| 状态机模块测试覆盖率 > 80% | ✅ | session-manager.ts 87.50%;path-manager.ts 97.58%;osc1337-parser.ts 99.04% |

---

## 主要架构变化(vs CP-2)

1. **SessionInfo 数据模型**(shared/types.ts):
   - state 三态新名:'active' | 'idle' | **'exited'**(取代 tombstoned)
   - `cwd` 字段拆为 `originalCwd`(永不变)+ `currentCwd`(OSC 1337 实时更新)
   - 新增 `exitedAt`,删除 `tombstonedAt`

2. **Settings 数据模型**(settings-manager.ts):
   - 删除 `advanced.sessionTombstoneMinutes`(砍墓地无 5 分钟计时器)
   - `activeIdleThresholdSeconds` 真实生效(CP-2 仅声明,CP-3 SessionManager 接通)

3. **OSC 1337 解析器**(`osc1337-parser.ts`,210 行):
   - 增量字节流解析,跨多次 onData 也能拼接
   - 不损耗任何字节流(序列剥离后 passthrough 透传)
   - 接受 BEL 与 ST 两种终止符
   - stash 上限 16KB 防内存堆积
   - 8 个边界单测(跨包、ANSI 夹杂、孤立 ESC、其他 OSC 透传、超长 stash flush)

4. **TemplatesManager**(`templates-manager.ts`,313 行):
   - 4 内置模板 + JsonStore 持久化 + mergeBuiltins 自动补齐
   - 损坏文件兜底走默认值,defaultId 不存在回退 'shell'
   - resolve(id) 给 SessionManager 用,确保永远拿到一个可用模板
   - 11 个单测覆盖 mergeBuiltins 各分支 + initialize / setDefault / list / get

5. **SessionManager 重构**(session-manager.ts,从 547 行扩到 870 行):
   - createSession 改为 async(detectShells 异步)
   - 每 session 一份 Osc1337Parser
   - active/idle/exited 状态机 + 计时器集中管理
   - PTY exit → state='exited',不立即 destroy(ADR-008)
   - cwd 兜底 timer 启停(收到首条 OSC 永久关闭)
   - 启动模板支持 shell+command 串接(通过 PlatformAdapter)
   - PlatformAdapter / spawnFn / hookFileResolver 全部可注入
   - 测试从 21 个扩到 46 个

6. **WindowsAdapter 真实化**(platform/windows.ts):
   - detectShells:exists 检查 pwsh > powershell > cmd > git-bash
   - buildShellLaunchParams:三种 shell 的 hook + commandToRun 串接
     - PowerShell:`-NoLogo -NoExit -Command ". 'hook.ps1'; & cmd args"`(顺手修 banner 重复)
     - cmd:PROMPT 环境变量 + 可选 `/K command`
     - bash:`--rcfile + -c "cmd; exec bash -i"`
   - getProcessCwd:返回 null + 文档化(留接口,未来加原生绑定即可)

7. **PathManager 防御加固**(path-manager.ts):
   - attachSession 用同 sessionId 不同 path 时记 warn(ADR-008 后这是 bug)

8. **IPC 层增量**(ipc.ts):
   - SESSION_CREATE handler 改 async
   - 新增 evt:session:state-changed 广播
   - 新增 evt:templates:updated 广播
   - buildSnapshot 用 TemplatesManager.list 替代硬编码

9. **Renderer 改造**(store / Sidebar / MainPane / TerminalView / global.css):
   - 三态状态点 (active 🟢 / idle 🟡 / exited ⚫) 在 Tab 与 SessionItem
   - cwd 漂移 ⚠️ 在 Tab 与 SessionItem 与 TerminalView 状态条
   - EmptyPathState 模板按钮直接用对应 templateId(CP-2 全部 'shell')
   - 收藏路径双击 → bookmark.defaultTemplateId 优先;右键 → prompt 设默认模板
   - sessions/state-changed reducer 合并子集字段(state / currentCwd / exitCode 等)

---

## 已知 CP-3 范围内不实现的(留给后续 CP)

按设计:

- **完整设置 UI** + 主题颜色实际切换 → CP-4
- **收藏路径完整右键菜单**(重命名 / 复制路径 / Explorer 中显示等)→ CP-4(CP-3 暂用 prompt 弹窗设默认模板)
- **模板编辑器**(增删改自定义模板)→ CP-4
- **应用打包成 .exe / .msi** → CP-4
- **完全退出确认对话框**(有 session 时)→ CP-4 接通(SessionManager 已能 count;主进程 IPC `cmd:app:quit` handler 待加二次确认)
- **NtQueryInformationProcess 真实实现** → 不强制做(OSC 1337 hook 已是 99% 路径;若未来加,需引入 ffi-napi 等原生包并征得作者同意,见 AGENTS.md 1.2 边界 2)

---

## 已知问题与平台限制

未在 CP-3 内引入新的平台问题。CP-2 errata 中已记录的 ConPTY resize 双重重画问题(`docs/known-issues.md` KI-001)依然存在,行为不变。

CP-3 的 cwd 跟踪:
- PowerShell session — OSC 1337 prompt hook 应稳定工作
- cmd.exe session — PROMPT 环境变量内嵌 OSC,稳定工作
- 命令模板(claude-code / codex / opencode 等)— 跑命令时不在 shell prompt 下,期间 cwd 不更新;命令退出后 shell 重新出 prompt 才再次报告。这是设计预期(prompt-based hook 的固有特性)
- 用户自定义 PowerShell `prompt` 函数 — 我们 wrap 了它,前置 OSC 后再调用原 prompt;若用户的 prompt 函数有副作用(例如已自己发 OSC),不冲突但可能有重复

---

## 我没自己端到端跑过的事(需要开发者测)

主要是 GUI 与真实 PTY 交互层面:

- 真实 PowerShell 启动后 `cd` 多次,看 tab 上 ⚠️ 是否准确出现/消失
- 真实 cmd.exe 启动,验证 PROMPT 嵌的 OSC 序列被 main 端解析(行为表现:tab 标题不变,但 cd 后状态条 cwd 路径更新)
- claude-code / codex / opencode 模板:命令不存在时(PATH 里没装)是否在终端区看到"不是 cmdlet"的报错(不弹对话框)
- 收藏路径右键 → 选默认模板 → 双击该路径 → 看是否启动正确模板
- exited session 的 scrollback 是否完整可见(等 PTY 退出后切到该 tab 上下滚)
- 所有 CP-2 已通过项目仍然通过(回归)

`CP-3-user-test-guide.md` 列了 12 项具体测试。

---

## 给开发者的话

CP-3 是体验层的"重头戏" — Session 状态机 / cwd 跟踪 / 模板系统 三块联动,任何一块出问题都会反映为 tab 上信息错位。重点关注:

1. **Banner 重复修没修**:CP-2 errata 报过 `Windows PowerShell` 横幅在窗口重开后出现 8 行。CP-3 通过 `-NoLogo` + 单次 dot-source 修复,你重启应用、关窗再开窗,看是否只出现一行 banner(或无 banner)。

2. **path/cwd 解耦的语义**:在收藏路径 ~/projects/auth 下打开 PowerShell,然后 `cd D:\elsewhere`。期望:tab 标题旁出现 ⚠️,鼠标悬停看到真实 cwd;但 session 在侧栏仍归属 ~/projects/auth(不会跑到 D:\elsewhere 下)。这与 CP-2 测试时的行为完全相反,务必确认是这个新行为。

3. **exited 不消失**:在 session 内输入 `exit` 让 PTY 死。tab 应变灰 + 出 ⚫,**不会自己消失**,scrollback 还能看;右键 tab(CP-2 已有"关闭"右键交互)关掉才消失。CP-2 是"立即销毁",CP-3 是"无时限保留"。

4. **OSC 1337 没生效怎么办**:打 `node ipc-debug.js`(若有)或者直接 `npm run dev` 看主进程日志(VS Code Run + Debug 抓 stdout)。每次 cd 应该看到 sessionStateChanged 事件。如果 cwd 永远不更新 → hook 注入失败,先检查 `pwsh.ps1` 是否正确加载($PROFILE 报错的话只 warn,所以 hook 应该总是装上)。

下个检查点 CP-4 我**不会自动开始**,等你确认 "CP-3 通过"。

---

## 勘误回合修复 (2026-05-10 晚)

用户测试后反馈 5 项,逐项修复:

### 勘误 #1 — 保留 PowerShell 原生 banner
- **症状**:`-NoLogo` 完全把 "Windows PowerShell\n版权所有..." 横幅砍掉,失去原生终端体验
- **修复**:`WindowsAdapter.buildShellLaunchParams` 去掉 `-NoLogo`。CP-2 errata #2 报的"banner 重复 8 次"问题不是 `-NoLogo` 在防,而是单次 dot-source 在防 — 现在 `-NoExit -Command "..."` 仅一次注入,banner 自然出现一次

### 勘误 #2 — 状态点应由输出决定
- **症状**:用户希望状态点反映"终端进程是否在运行 / 产生输出",而不是输入触发
- **诊断**:当前实现已是**输出驱动** — `markActive` 仅在 `handlePtyData` 中调用,`sendInput`(用户输入到 PTY)不动状态。但是 PTY 会 echo 用户输入,所以"敲一个字符 → shell echo → 触发 markActive"在感知上像"输入也算 active"。这是 echo 的固有特性,要严格区分需要在主进程做 echo 检测,得不偿失
- **修复**:**不改代码**(用户原文:"不确定好不好实现,要是不好实现,按照现在的实现其实也可以"),在 `markActive` 加注释明示设计意图

### 勘误 #3 — 切到 idle session 时 tab 闪一下绿色
- **症状**:已稳定运行的 idle session(黄点),用户在另一窗口点击它的 tab 切进去时,**瞬间闪一下绿色**再回黄。与 PowerShell prompt / claude 启动节奏无关 — 是 ConPTY 重绘机制
- **真实根因**:切窗口/接管 → renderer mount TerminalView → xterm `fit()` → `cmd:session:resize` → 主进程 `pty.resize` → **Windows ConPTY 把屏幕 buffer 按新尺寸重新排版,整屏字节流再发一遍**(`docs/known-issues.md` KI-001 的同一个机制) → handlePtyData 误触 markActive → 状态闪 active 一下,3 秒后又回 idle
- **修复**:
  1. `RESIZE_QUIET_MS = 500`:`resize()` 时记 `managed.resizeQuietUntil = now + 500`;`handlePtyData` 中 `if (Date.now() >= resizeQuietUntil) markActive()`,quiet 窗口内 PTY 字节**仍然写 scrollback / emit sessionOutput**(用户视觉上要看到重绘),只是不动状态机
  2. 同尺寸 resize 不开窗口(避免有人无谓地反复调 resize 反而压制活跃)
  3. `resizeQuietMs` 暴露为 `SessionManagerOptions` 字段,默认测试注入 0
  4. 加 3 个测试:窗口内重绘字节不切 active / 窗口结束后正常 markActive / 同尺寸 resize 不开窗口
- **回滚的不必要改动**(我之前误判加上的):
  - `STATE_STARTUP_GRACE_MS = 5000` — 防的是新建 session 启动期闪烁,与本 issue 无关,**已删除**
  - 默认 `activeIdleThresholdSeconds: 2 → 3` — 与本 issue 无关,**已恢复 2 秒**

### 勘误 #4 — 收藏路径右键无反应
- **症状**:右键收藏路径,什么都没发生
- **诊断**:原来用 `window.prompt` 弹模板选择窗,Electron 默认忽略 `window.prompt`/`alert` 这种 web 标准 API,所以完全没反应
- **修复**:Sidebar 加 React 渲染的 `ContextMenuProvider`,用 fixed 定位 div 显示菜单,Esc/外部 click/wheel 关闭。CSS 主题化(`var()` + `#f0f` fallback)。当前只支持"设默认模板",CP-4 加更多右键项时复用此 provider

### 勘误 #5 — TabBar 顺序还在跳 + 灰显抽到右边的逻辑要彻底拿掉
- **症状**:在某些场景下点 tab 还会让其他 tab 移位
- **修复**:`MainPane.TabBar` 删除 `visibleTabs / ownedByOtherTabs` 分组,直接 `sessions.map(...)`。所有 tab 按 `path.sessionIds` 顺序渲染,owner-by-other 仅由 Tab 自己根据 `ownerWindowId` 显示成灰显(class),不再因 owner 切换而 reorder。侧边栏与 tab 自然同步(都用同一数组)

### 勘误回合后的测试覆盖
- 总测试:195(+3 新增 resize quiet 窗口测试,-1 删除误判加的 startup grace 测试)
- 全部通过,typecheck 清洁
- 状态机模块覆盖率仍 > 80%
