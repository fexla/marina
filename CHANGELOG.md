# Marina Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/),版本号遵循 [SemVer](https://semver.org/)。

## [0.2.3] — 2026-06-05

issue #4 续 — hideTopTabBar 模式重选当前 path 不进 EmptyPathState 的修复。

### 修复

- **hideTopTabBar=true 时,点已选中的 path 不会回到新建页(issue #4 续)。** 现象:开了文件夹 A 的终端后再点 A 本身,view 不动;必须先点 B 再点回 A 才能看到 EmptyPathState。根因:`view/select-path` reducer 把"清空 selectedSessionId"放在 `action.pathId !== state.selectedPathId` 守卫里,同 path 走 no-op 分支,selectedSessionId 不变 → MainPane 继续渲染 TerminalView。修法:hideTopTabBar=true 时无条件清空 selectedSessionId(同 path / 切 path 都清),恢复 issue #4 设计意图——"点 PathItem 永远进新建页"。配套修正 `Sidebar.handlePickFolderForTemp` 在临时栏 + 新建 session 后显式补一次 `view/select-session`,否则新 reducer 行为会把 `sessions/created` 刚 set 的 selectedSessionId 又抹掉,用户刚显式新建却看到空白页。

## [0.2.2] — 2026-06-03

issue #4 落地 + xterm 6.1 升级对齐 VSCode + CURSOR-2 调研记录归档。

### 新增

- **设置 → 外观 → 隐藏顶部标签栏(issue #4)。** Sidebar 已按路径分组显示所有 session,TabBar 内容重复且占纵向空间。新增 `appearance.hideTopTabBar` 开关(默认关),勾上后 MainPane 不渲染 TabBar;同时改写 `view/select-path` reducer 的拦截语义 —— 点 Sidebar 里的 PathItem 永远进 EmptyPathState 新建页(不再自动选第一个本窗口持有的 session),要切到已有 session 必须从 Sidebar 显式点 SessionItem。与 BETA-027 simpleMode 正交:simpleMode 仍连 Sidebar 一起藏,只是优先级更高。`SettingsManager` deep-merge 保证老 settings.json 缺字段时静默回落 `false`。

### 改进

- **`@xterm/xterm` / `@xterm/headless` 升级到 6.1.0-beta.256 — 对齐 VSCode bundle 版本。** 6.x 破坏性变更:`windowsMode: true` → `windowsPty: { backend: 'conpty' | 'winpty', buildNumber }`,buildNumber 从 preload `os.release()` 同步暴露给 renderer。本升级独立于 CURSOR-2 调研结论,版本对齐本身是基础设施层面的 hygiene(便于未来从 VSCode 反向移植 patch / 比对行为)。

### 文档

- **CURSOR-2 调研记录归档 — `docs/issues/cursor-2-codex-tui-jitter-vs-vscode.md`。** Codex TUI 在 Marina 中光标逐帧跳变(VSCode 无此问题)的三天调研挂起记录:7 条假说排除表 + 6 次实验细节 + 6 条尚未尝试的下一步方向(D1-D6,按 ROI 排序)。下次接手优先级:D1(`cursorBlink: false` 5 分钟)→ D2(读 xterm 6.1 WebGL CursorRenderLayer 源码)→ D3(`onWriteParsed` 探针)。GitHub issue #11 同步建档。

## [0.2.1] — 2026-05-26

0.2.0 后的体验微调 patch — sidebar 形态调整 + Git Bash 警告标志根因修复。

### 改进

- **Sidebar 右侧 resize handle:宽度可拖动 + localStorage 持久化。** 在 sidebar 右边缘加 4px 拖动条,鼠标按下后全局 mousemove 接管,松开落盘到 `marina.sidebar.width`(范围 [180, 600],默认 280)。双击 handle 复位默认宽度。拖动期间 `document.body.cursor = 'ew-resize'` + `userSelect = 'none'`,避免越过边界进入终端区时光标抖 / 误选中文本。hover 时 handle 显出莫紫色半透明高亮线,平时透明不抢视觉。
- **Sidebar 全顶格 — padding-left 统一压到 8px。** 旧版三层缩进(category 12 / path 28 / session 44)在 280px 窄边栏里把内容推得太靠右,无 chevron 的路径行被"夹在中间不顶格"。改为五处行(`.sidebar-category-header` / `.path-item-row` / `.session-item` / `.sidebar-empty` / `.sidebar-footer`)共享 8px 左 padding,内容左缘共线;session 层不再额外缩进,由 state-dot 圆点形状区分层级。
- **移除右上角"隐藏侧边栏"按钮 + 整套 sidebarVisible 状态机。** 实际从未被高频使用,删除后 Sidebar 永远显示。`WindowChrome` Windows / macOS 两套标题栏的 toggle 按钮、`toggleSidebar` handler、`PanelLeftClose` / `PanelLeftOpen` import、`useAppDispatch` import 全删;App.tsx 不再按 `state.sidebarVisible` 条件渲染;store 的 `sidebarVisible` 字段、`view/toggle-sidebar` / `view/set-sidebar-visible` 两个 action、reducer case、初始值一并清掉。

### 修复

- **Git Bash 路径误触 cwdDrifted ⚠️ — `normalizeCwd` 加 POSIX 驱动器路径转换。** bash hook 用 `cygpath -w` 把 `/c/Users/foo` 转 Windows 风格再 emit OSC 1337,但首个 prompt 之前 / hook 加载失败 / cygpath 不可用三种边缘情况下,发的仍是 POSIX 风格。Windows 上 `path.resolve('/c/Users/foo')` 会把 `/c` 当当前盘根下的相对路径,解出 `<drive>:\c\Users\foo` 这个不存在的怪路径 → `currentCwd ≠ originalCwd` → Sidebar / Tab / 状态栏 ⚠️ 一直亮。修法:在 `normalizeCwd` 的 PSDrive 剥离 + `~` 展开之后,win32 平台新增一步 POSIX 驱动器路径(`^/[a-zA-Z](/.*)?$`)→ Windows 风格转换;POSIX 平台不动(`/c/foo` 在 Linux 是合法绝对路径)。新增 2 条 `it.skipIf(process.platform !== 'win32')` 测试覆盖 `/c/Users/foo` 与驱动器根 `/c` 归一。

## [0.2.0] — 2026-05-25

**M1 里程碑达成 — Marina SSH 终端模式正式就位。** 本地用户视野与 beta.9 完全一致(UI 层 segmented + filter 守住),SSH 用户能完成"管理远程服务器 + 进 shell 干活 + 用 tmux 保持会话 + 多 session 复用 SSH 连接 + 主动重连"完整工作流。同期合入 KBD-1 键盘交互全面整改 / SCROLL-1 session 切换二次修复 / ISO-1 跨平台构建隔离三层防御 / IME-2 候选框位置锁定 / spec §14 远程 SSH 模式定型 + presentation 三件升 v0.2.0 + 28 份 alpha 历史档案清理。

### 新增

- **SSH 阶段 2+3:ssh_config / ssh-agent / ProxyJump / ControlMaster / known_hosts / 重连按钮 — 一次性推到 M1 里程碑(0.2.0 GA)。** 在阶段 1 的 UI 分离 + 类型强化基础上,把剩下的"基础 SSH 终端"功能全做掉。
  - **ProxyJump 多级跳板(§阶段 2.3)**:`SshProfile.proxyJump: string[]` 字段,`buildSshLaunchParams` 拼成 `-J host1,host2,host3`。RemotePanel SSH 表单加 ProxyJump 输入(逗号分隔多跳板,支持 `user@host:port` 段)。每段最多 5 跳防滥用,空段静默过滤。3 个新单测覆盖单/多跳板 + 空数组。
  - **ssh_config 集成(§阶段 2.1)**:新建 `src/main/ssh-config-parser.ts`(258 行 + 13 个单测),解析 `~/.ssh/config` 的 Host 块 + Include 指令(递归深度 16 防循环)+ 通配符 Host 过滤 + Match 块整段跳过(V1 范围外)+ `Key=Value` / 引号 value / `key value` 三种行格式。`advanced.includeSshConfig` 开关默认 false;开后 RemotePanel 显示已发现 Host 列表(只读,改请直接编辑 ssh_config)。
  - **ssh-agent 检测(§阶段 2.2)**:新建 `src/main/ssh-agent.ts`(140 行 + 9 个单测)。POSIX 看 `SSH_AUTH_SOCK`,Windows 看 OpenSSH Authentication Agent 服务;统一通过 `ssh-add -l` 列已加载 key(bits / SHA256 指纹 / comment / keyType)。RemotePanel 显示 agent 状态 ✅/⚠️ + key 列表 + 刷新按钮。无 agent 时给 actionable 提示(`eval $(ssh-agent)` 等)。
  - **ControlMaster 性能层(§阶段 3.5)**:`advanced.enableControlMaster` 默认 true。`buildSshLaunchParams` 加 `-o ControlMaster=auto -o ControlPath=~/.ssh/cm-%r@%h:%p -o ControlPersist=10m`,同一 host:port:user 的 5 个 session 只 1 次握手(~3s → <100ms / session)。Windows OpenSSH 8.x+ 走 named pipe,ControlPath 被忽略仍照样复用,失败时 OpenSSH 自动回退到独立连接 — Marina 不需要兜底。2 个新单测验证 args 出现 / 不出现。`PlatformAdapter.getSshControlPath()` 可选接口(POSIX 三平台返回 `~/.ssh/cm-%r@%h:%p`)。
  - **KnownHostsManager(§阶段 3.1)**:新建 `src/main/known-hosts-manager.ts`(190 行 + 8 个单测),解析 `~/.ssh/known_hosts` 每行(支持 plaintext / hashed `|1|` host / @cert-authority 跳过 / 注释跳过),计算 SHA256 指纹(与 `ssh-keygen -lf` 一致)。新增 `known-hosts-history.json` 持久化指纹时间线 — 同 host 指纹变化时报告 changes(potential MITM),timeline 跨重启保留。RemotePanel 顶部高亮变化条目(红框),下方列当前所有条目(前 10 条)。
  - **ReconnectBanner(§阶段 3.4)**:TerminalView statusbar 在 SSH session `state === 'exited'` 时显示"重连"按钮(玫紫色 accent),点击 = 同 pathId + 同 templateId + 当前 dims 起新 session,reducer 自动 select 新 session,旧 exited tab 留给用户决定。不做自动重连(留 V2 配 powerMonitor / navigator.onLine 体系)。CSS `.reconnect-button` 配 hover / disabled 态。
  - **IPC + bootstrap**:新增 3 个通道 `cmd:ssh-config:list` / `cmd:ssh-agent:status` / `cmd:known-hosts:refresh`。`KnownHostsManager` 跟其他 store 一样走 `JsonStore` + `initialize` / `flush` 生命周期,挂进 `installIpcLayer({ ...deps, knownHostsManager })`。
  - **RemotePanel UI 集成**:新增 4 个 SettingRow — agent 状态卡片 / ssh_config 开关 + 列表 / ControlMaster 开关 / known_hosts 浏览器(含变化高亮)。新 CSS class 8 个(`.ssh-agent-card / .ssh-agent-status-line / .ssh-agent-key-list / .ssh-config-list / .ssh-config-hint / .ssh-known-hosts-list / .ssh-known-hosts-changes / .reconnect-button`)。新 i18n key 0 个(用 tx 双语字面量)。
  - **测试 + CI Gate**:新增 33 条测试(`ssh-config-parser.test.ts` 13 + `ssh-agent.test.ts` 9 + `known-hosts-manager.test.ts` 8 + `session-manager.test.ts` 新增 ProxyJump×3 + ControlMaster×2 = 5)。全量 501 个测试通过,typecheck + ESLint + stylelint 全过。
  - **已跳过的 M1 后续工单(放 V1.1 或 V2)**:
    - **HostKeyPromptModal**(首次连接的 `Are you sure you want to continue connecting?` 拦截 + Marina 自绘 modal)— 需要 PTY 输出实时扫描 + 写 ssh stdin,跨平台行为细节多。当前体验:用户在终端里直接按 yes,known_hosts 由 OpenSSH 自动写入,Marina 下次 refresh 时检测到新条目。
    - **MFA / TOTP modal**(截获 `Verification code:` prompt → Marina modal)同上原因。
    - **自动重连 + 网络变化检测**(navigator.onLine + powerMonitor sleep/wake → 倒计时自动重连)— 实现简单但需要时序测试,且重连频率受 ControlPersist 影响较大,V2 跟"会话冻结/解冻"一起做。
    - **远端 tmux session 列表面板**(只看不操作)— PR #2 已实现 per-launch attach-or-create,列表面板属于增值功能。
  - **M1 里程碑达成判定**:阶段 0(spec + PR #2 merge)+ 阶段 1(UI 分离 + 类型强化)+ 阶段 2-3 核心(本 PR)= Marina SSH 终端模式正式就位。SSH 用户能完成"管理远程服务器 + 进 shell 干活 + 用 tmux 保持会话 + 多 session 复用连接 + 主动重连"完整工作流。下一步走 0.2.0 GA 发版(beta.10 → beta.11 → 0.2.0)。

- **SSH 阶段 1:UI 分离 + 类型强化 + PR #2 polish。** 落地 `docs/方案-SSH-完整支持-20260524.md` §阶段 1,把 PR #2 的 SSH MVP 收尾成"本地用户视野与 beta.9 100% 一致 + SSH 用户专属入口"。
  - **PathKind discriminated union(§II.1)**:`Bookmark / RecentEntry / PathNode` 改严格 discriminated union,`kind` 必填,ssh 变体 `sshProfileId` narrow 为必填。所有使用 Path 的函数走 `switch on kind` 自动 exhaustiveness check;新增 `assertNeverPathKind` 兜底,未来加 `'wsl'`/`'docker'` 时编译器强制找出所有需要补 case 的位置。
  - **磁盘迁移**:beta.9 之前的旧 schema(无 kind 字段)在 PathManager 启动时由 `migrateBookmarkOnLoad`/`migrateRecentOnLoad` 静默 coerce 为 local;损坏条目(kind=ssh 缺 sshProfileId)启动期丢弃不让用户进不来 Marina,导入 archive 走严格校验直接拒。新增 `PersistedBookmark`/`PersistedRecentEntry` 磁盘宽松 schema,与内存严格类型分离。
  - **Sidebar segmented control(§II.3)**:顶部加 `[本地] [远程]` segmented control,默认本地;`hasSshProfiles || advanced.enableRemote` 时才渲染(本地用户 = sidebar 跟 beta.9 完全一致);切到本地段时 device sections / temporary / recent 都按 `kind !== 'ssh'` 过滤,反之亦然。状态 localStorage 持久化跨重启保留。
  - **设置页 SSH 条件渲染(§II.6)**:把 SSH UI 从"数据"分类抽出来,做成顶级"远程"分类。`buildVisibleCategories` 纯函数控制 nav 显示:无 SshProfile 且 `advanced.enableRemote=false` 时不出现,设置页永远 8 个分类;有 profile 或勾了 enableRemote 时第 5 位插入"远程"成 9 个。RemotePanel 含 SSH 服务器 CRUD / 远程文件夹收藏 / `enableRemote` 开关。
  - **`advanced.enableRemote` 设置**:新增字段,默认 false。是"本地视野守护"的唯一显式触发条件;RemotePanel 内可勾掉,关掉后无 profile 则刷新设置后远程分类隐藏。
  - **PR #2 polish**:RemotePanel 全部 inline style → CSS class(`ssh-profile-form / ssh-profile-grid / ssh-key-picker / ssh-password-field / ssh-profile-actions / ssh-enable-toggle / remote-bookmark-form`)。Sidebar segmented control + 远程分类 i18n 中英全覆盖(`sidebar.segment.* / settings.category.remote`)。SSH profile edit / 密钥文件选择器 / 保存密码 PR #2 已实现,本阶段无需重做。
  - **CI Gate-1 invariant 测试**:新增 `src/shared/path-invariants.test.ts`(13 条 — 包含 `// @ts-expect-error` 验证 local 分支不能访问 sshProfileId)+ `path-manager.test.ts` 增 4 条迁移不变量。全量 466 个测试通过(原 452 + 新增 14),typecheck + ESLint + stylelint 全过。
  - **M1 里程碑前进**:阶段 0(spec §14 草案、PR #2 merge)+ 阶段 1(本次)完成。剩 ssh_config / 完整认证矩阵 / ProxyJump(阶段 2)+ known_hosts UX / 重连 / tmux / ControlMaster(阶段 3)。

### 修复 / 改进

- **KBD-1:键盘交互全面整改 — binding table + paste 路径 + overlay 栈 + SCROLL-1 二次修复。** 整合 PR #3(Windows Ctrl+V 不粘贴 / 语音输入失效 / 双倍粘贴)并叠加架构层整改,把 spec / 代码 / 设置页 UI 三处对齐到唯一权威表,从根上消除"键位漂移 / 双倍粘贴 / SIGINT 失效 / Esc 优先级靠注册顺序 / IME 选词被吃 / replay 期 focus 错位"六类历史问题。
  - **Ctrl+V 不粘贴 + 双倍粘贴**(PR #3):xterm 把 Ctrl+V 当 Unix literal-next 发 `0x16` 给 PTY,且 Ctrl+Shift+V / Shift+Insert 跟 xterm native paste listener 双倍触发;语音输入程序(智模 / 闪电说)依赖"写剪贴板 → 模拟 Ctrl+V"的链路因此整个失效。修法:helper-textarea + container 双层 capture-phase paste listener,`stopImmediatePropagation` 阻 xterm bubble listener,所有粘贴来源(Ctrl+V / Ctrl+Shift+V / Shift+Insert / 语音输入 / 右键 / 浏览器)走同一个 `handlePaste`。Ctrl+V 在键盘 handler `return false` 不发字节,让浏览器 paste 事件由 capture listener 接管。
  - **SIGINT 失效 bug**(CPB-C3 扩展):Ctrl+Shift+C / Ctrl+Insert 复制后没清选区,残留 selection 让下次 Ctrl+C 走复制分支不发 SIGINT,死循环 / 卡住进程无法中断。修法:三套复制路径(`copy-or-sigint` / `copy-and-clear`)统一清选区。
  - **数据驱动 binding table**:新建 `src/shared/terminal-keybindings.ts`,8 条 binding 集中,`matchKeybinding` 纯函数扫表;TerminalView 60 行嵌套 if/else 退化为"扫表 + switch dispatch" 50 行。新增 20 个单测覆盖所有键位 + 修饰键守护 + 表结构不变式。
  - **Modal / ContextMenu IME 守卫**:Modal 全局 keydown 无 `isComposing` 检查,中文 / 日文 / 韩文 IME 选词的 Enter 被误吃,modal 提前关闭。修法:Modal / ContextMenu 全局 keydown 首行 `if (e.isComposing || e.keyCode === 229) return`。
  - **UiOverlayStack**:Modal / ContextMenu 各自挂 window keydown 拦 Esc,多 overlay 嵌套时 Esc 由"注册顺序的隐式优先级"决定,不可预测。新建 `src/shared/ui-overlay-stack.ts`(命令式核心)+ `src/renderer/ui-overlay-stack.ts`(React hook 包装),overlay mount 时 push、unmount 时 pop;keydown 前问 `isTop()` 决定是否响应。多 overlay 嵌套时 Esc 永远从最上层关起。新增 8 个单测。
  - **SCROLL-1 二次修复(visibility:hidden + inert)**:一次修复的 fence + scrollToBottom 只锚最终位置,没解决"分片 write + setTimeout(0) yield 之间 xterm RAF 把已处理 chunks 的部分 buffer 画到 canvas"的中间帧暴露。修法:terminal-host 在 `hostRevealed=false` 期间同时 `visibility:hidden` + `inert`,canvas 仍累积像素只跳 compositing,fit 仍能算尺寸;`inert` 阻 focus 落入子树,replay 100-500ms 期间用户按键不会误进 Sidebar 改名框 / Modal 等错位 focus。fence cb + scrollToBottom + 一帧 RAF 后才 reveal,reveal 后 useEffect 主动归还 focus 给 helper-textarea。React 18 不识别 inert 作为 known prop,`src/renderer/global.d.ts` module augmentation 让 TS 接受 `inert={'' | undefined}`(Electron 31 Chromium 126 原生支持)。产品决策:replay 期间不响应按键是有意为之,符合"切换中"直觉,避免 typeahead 误发到错位 focus。
  - **spec / 文档同步**:`docs/软件定义书.md` §7.1 加"§7.2.2 是唯一权威"不变式,§7.2.2 写完整终端键位清单表(Win/Linux + macOS 等价)+ 6 条实现不变式,§13.2 把"应用内快捷键(除 Ctrl+C/V/F)"扩展为"任何不在 §7.2.2 清单内的键位"。新建 `docs/键盘交互规范.md` 开发者实现锚,工单留档 `docs/issues/kbd-1-shortcut-overhaul-20260524.md`。
  - **设置页快捷键速查卡片**:设置 → 行为末尾加 `KeybindingsReference`,数据源即 `TERMINAL_KEYBINDINGS` 数组,navigator.platform 判断 mac 显 Cmd 别名。spec / 代码 / UI 三处永不漂移。

## [0.1.0-beta.9] — 2026-05-19

UI 视觉一致性收尾:把"无边框 / hairline / lucide 矢量图标"语言推进到 ctx-menu 和 sidebar 加号按钮两处遗漏。

### 修复 / 改进

- **UI-1:ctx-menu 边框走 alpha hairline + 删双重描边。** 原 `border: 1px solid var(--color-bg-strong)` + box-shadow `0 0 0 1px var(--color-bg-elevated)` 两条同色 1px 叠成 2px 实线;在浅色主题下 box-shadow ring 还会换成更重的 `var(--color-text-muted)`,cutie 樱花粉底上呈"莓棕墨水线",和 a393bfa 删 sidebar/statusbar 边框的方向矛盾。改用 `color-mix(in srgb, var(--color-text-primary) 8%, transparent)`,一处定义跨 10 套主题自动 do-the-right-thing:深底叠浅文字色 → 极淡 highlight 线,浅底叠深文字色 → 极淡 shadow 线。box-shadow 第二层 ring 同步删除,drop shadow 单层足够撑立体感。浅色主题 ctx-menu 特化块瘦身,只保留 28%→14% 阴影减淡。对齐 UI-1 RFC §3 "组件级浮卡边界用 hairline 而非实色 token"的主流做法。
- **UI-1:sidebar 加号按钮去实色边框 + 字符 `+` 换 lucide `plus` icon。** 同批次又一处实色 token 描边遗漏 — `.sidebar-category-action` 的 `border: 1px solid var(--color-bg-elevated)` 在 cutie / dawn 浅色主题下边框色与 surface 对比 ΔL\* < 1,基本隐形,既起不到 "有可点按钮" 的 affordance 又破坏无边框语言。改 ghost 风格:`transparent` + hover 出 `--color-bg-active`,跟 `.tab-close / .titlebar-btn` 同种语言。同时把 `actionLabel="+"` 字符改成 `<Icon name="plus" size={12} />` — 原字符 + 视觉中心与 SVG 不在同一基线,粗细跟旁边 bookmark/clock/history 三个 lucide icon 不一致;改 icon 后字号声明也一并清理,跨主题继承 text-muted → text-primary 的 hover 升级。`CategoryProps.actionLabel: string` → `ReactNode`(类型放宽,内部 interface)。

## [0.1.0-beta.8] — 2026-05-19

### 新增

- **UI-2:新增 4 个主题 — Catppuccin Latte / Tokyo Night Day / Light Pink / Fairyfloss。**
  补完 Catppuccin / Tokyo Night 浅色家族;Light Pink 走"多色少女"区分于 Cutie 的"单粉色家族";Fairyfloss 是项目第一个"深色可爱"主题。所有 ANSI bright 系按 BETA-035 标准在浅底 ≥4.5:1。`global.css` 加 4 个 `[data-theme]` 块 + 浅色主题 `ctx-menu / modal / toast / select-arrow / bootstrap-placeholder` 特化扩展。
- **TERM-PROGRAM:子 shell 现在能识别 Marina 宿主身份 + 完整终端能力。** 仿 iTerm2 / WezTerm,统一注入 `TERM=xterm-256color`、`COLORTERM=truecolor`、`TERM_PROGRAM=Marina`、`TERM_PROGRAM_VERSION=app.getVersion()`。覆盖父进程继承的旧值(避免 Marina 从 VS Code 终端启动时子 shell 看到 `vscode`);若 `appVersion` 缺失则主动 `delete` 继承值。用户 `.bashrc / Profile.ps1` 可分支判断 `$env:TERM_PROGRAM -eq 'Marina'`;starship / oh-my-posh / fzf / bat / delta 等显式读 `COLORTERM` 决定 24-bit 渐变。node-pty `spawn name` 同步改 `xterm-256color`。

### 修复 / 改进

- **SCROLL-1:切 session 时终端"从上往下刷屏再到底"再现 — 用 `term.write('', cb)` 作 fence 根治回归。**
  BETA-018 在 2026-05-16 修过同一现象,但 CURSOR-1 把 `get-scrollback` 数据源从 main 端裸字节 ring 切到 SerializeAddon 序列化的完整状态 ANSI 流后,体积从"单片 16KB 一过完"变成"几十~几百 KB 必走分片 + yield",原修复(`.then` 体内直接 `scrollToBottom`)隐式依赖"parser 单帧能 drain 完",于是失效。根因:`term.write()` 是异步排队(d.ts:1216),`.then` 体内的 `scrollToBottom` 锚的"底"在后续 parser 解析新行时会被持续往下推。修复把 `scrollToBottom` 移进 `term.write('', cb)` 的 callback 内,callback 由 parser drain 后才触发,等价 fence。主路径 + catch fallback 各改一处,带 `disposed` 兜底。文件头 `@关键设计` 加"步骤 4 视口锚定",明文禁止"`.then` 体里直接调"。详见 `docs/issues/scroll-1-session-switch-progressive-refresh.md`。
- **IME-1 探针 v2:LEAK 判定升级 + 持久化日志通道,根治"DevTools 没开就丢现场" + 正常长输入误报。**
  用户在 2026-05-18 当晚反馈 `[IME-LEAK]` 在 console 里只剩 "Object" 占位,定位不了哪条 race;同步抓到的另一条现场 `len=24 head=tail=taTail=24 字` 又是"一次性长 IME 提交"被原始阈值 `data.length > 20` 误报。两个动作:**(a)** LEAK 判定从单一阈值升级到 `data.length > 20 AND taLen ≥ data.length + 8`(物理意义:textarea 必须严格长于 data 才说明有"前面那段历史"没被取出);**(b)** PROBE B 的 `composition* / keydown(229)` 不再 `console.warn` 每条(中文用户日常输入每按一个标点都打一条),改进 ring buffer (capacity 50) 暂存;LEAK 触发时整个 ring 一次性 IPC dump 到 main 端,通过新增的 `logger.ime` 通道落盘 `%APPDATA%/Marina/logs/ime-YYYY-MM-DD.log`(按日切、5MB rotate、保 7 天,与 `llm` 排障日志同套设施)。判定与 ring 下沉到 `src/shared/ime-probe-ring.ts`,配 10 条护栏单测。观察期结束移除探针时,本通道一并退役。详见 `docs/issues/ime-1-chinese-ime-stale-textarea-flush.md` "探针 v2 升级"段。
- **UI-1:无边框风格收尾清理 4 处遗漏 `border` + tab 改 Chrome 风格(缩放替代横向滚动)。**
  之前 4 个区块(`.sidebar / .sidebar-category / .tab-bar / .tab`)已固化"无边框",但还有 4 处遗漏仍画 1px 实色线:`.sidebar-footer / .terminal-statusbar / .settings-header / .settings-nav`,统一删掉。tab-bar / tab-list `overflow: hidden` 替代 `overflow-x: auto`,`.tab` 从 `flex: 0 0 auto` 改成 `flex: 0 1 180px` + `min-width: 40px`,空间不够时一直缩到 40px 被 `.tab-name` 的 ellipsis 截断,不再出水平滚动条。浅色主题 hairline 补强方案以 RFC 形式归档于 `docs/issues/ui-1-borderless-style-light-theme-hairline.md`(保留 open question)。

## [0.1.0-beta.7] — 2026-05-18

### 修复

- **IME-1:中文输入法按标点偶发冲刷一大段历史输入。** 根因在
  `@xterm/xterm@5.5.0` 的 CompositionHelper:整个 xterm 只在 Enter / Ctrl+C
  时清 helper-textarea,中文用户长时间不按 Enter(Claude Code / aider 等 TUI
  多行编辑场景)时 textarea 累积到几百几千字符;再叠加 compositionend 用
  `substring(start)` 取从开头到 textarea 末尾、以及 keydown 229 + replace
  diff 等几条 race 路径,就会把历史一起送给 onData,看起来像"按一个标点冲刷
  出几十上百字的重复"。Workaround:在 `term.open` 之后给 helper-textarea 挂
  `compositionend` 监听,延迟 16ms(~1 帧,晚于 xterm 自己的 `setTimeout(0)`
  substring 读取窗口)清空 textarea.value,从根上断"textarea 累积历史"这个
  前提,所有三条 race 路径同时失效。核心逻辑抽到
  `src/shared/ime-textarea-workaround.ts`(纯函数 + duck-typed 接口),
  AGENTS.md 5.1 红线下沉到 shared 后写了 7 条护栏单测,确保未来 xterm 升级 /
  TerminalView 重构不会悄悄删掉 workaround。`onData` 与 helper-textarea 上的
  IME 探针(PROBE A / PROBE B)保留作为长期监控,观察两周无 `[IME-LEAK]` 报警
  后整体移除。详见 `docs/issues/ime-1-chinese-ime-stale-textarea-flush.md`。

## [0.1.0-beta.6] — 2026-05-18

紧急 hotfix:在 Marina 启动的 Git Bash 里 `powershell.exe` / `cmd.exe` / `reg.exe`
/ `wmic.exe` / `ssh.exe`(OpenSSH 版)等所有 `C:\Windows\System32` 系原生命令
都无法通过 PATH 解析(BETA-ENV-1)。用户报告 Claude Code 的 PowerShell 工具
直接返回"PowerShell is not available on this system."。

### 修复

- **BETA-ENV-1:Windows 子进程 PATH 占位符未展开 + canonical `SystemRoot`
  缺失,导致 system32 系工具全部从 PATH 上消失。** 两个独立但叠加的 bug:
  1. `WindowsAdapter.getRefreshedPath` 从注册表 `HKLM\…\Environment\Path`
     读到的是 `REG_EXPAND_SZ` 字面字符串(含 `%SystemRoot%\System32` 等占位符),
     直接塞进子进程 env 没做 `ExpandEnvironmentStrings`。
  2. 子进程 env 块里 `SystemRoot`(canonical casing)是空串,只有 `SYSTEMROOT`
     有值;Win32 内部展开 `%SystemRoot%` 按字面 key 名查,大小写不一致就替
     换成空。
  修复采用**两层防御**:
  - Layer 1(源头):`getRefreshedPath` 读完注册表立即调
    `expandWindowsEnvPlaceholders` 展开,name 查找大小写不敏感、未命中保留原
    样(对齐 Win32 ExpandEnvironmentStringsW)。
  - Layer 2(兜底):新增 `PlatformAdapter.normalizeSpawnEnv` 接口,Windows
    实现在 spawn 前补齐 `SystemRoot` / `SYSTEMROOT` / `windir` 三个 casing 的
    canonical 值,并对 PATH / Path / PATHEXT / PSModulePath / ComSpec 等
    PATH-like 字段再做一次展开;残留占位符通过 `logger.warn` 上报。
  - 配套 40 条单测覆盖回归(`src/main/platform/windows-env.test.ts` +
    `src/main/platform/windows.test.ts` 的 BETA-ENV-1 部分),把用户报告里
    `SystemRoot='' + SYSTEMROOT='C:\\Windows'` 的诡异组合钉成回归测,任何
    回归都会让 CI 挂掉。
  - Linux / macOS adapter `normalizeSpawnEnv` 走 no-op(Win32 占位符在 POSIX
    上不存在)。

## [0.1.0-beta.5] — 2026-05-17

beta.4 之后的开源准备 + Linux 首发回合。三件大事:**Linux 包正式可下载(Tier 2,
可用但不可靠)**、**CURSOR-1 / BETA-019 cursor 闪烁通过 scrollback 架构重构根治**、
**仓库开源 + 演示资料统稿**。

### 新增

- **Linux 支持**(BETA-003):LinuxAdapter 真实现替换全部 NOT_IMPLEMENTED
  桩;detectShells 走 /etc/shells 过滤;buildShellLaunchParams 对 bash / zsh /
  fish 三 shell 各自走 --rcfile / ZDOTDIR / XDG_CONFIG_HOME 分支;getProcessCwd
  走 /proc/<pid>/cwd;setAutoStart 写 ~/.config/autostart/marina.desktop;
  registerFileManagerIntegration 走 gsettings + update-alternatives /
  alternatives 双分支(Debian / RHEL 系)。`PlatformAdapter.lifecycleModel` 字段
  新增,三平台分别 `tray-resident` / `dock-resident` / `no-persistence`。
  LastSessionConfirm modal 在 Linux 最后窗口 + 仍有 alive session 时弹二次确认。
  详见 ADR-013 与 `docs/方案-BETA-003-Linux支持-20260517.md`。
- **Linux 安装包三种**:`.deb`(Debian/Ubuntu)、`.rpm`(Fedora/RHEL/CentOS)、
  `.AppImage`(通用)。Docker 在容器内构建,Tier 1 测试目标 Ubuntu 22.04 GNOME。
- **dev / portable / installed 三套实例共存**:数据目录、单实例锁、任务栏图标
  全自动按 instance kind 分离,可同时跑三套不冲突。(a8739b7)
- **AI 助手 v2.2**:按键时间线元数据 + LLM 日志独立通道,scrollback 复核请求与
  普通日志分流。(BETA-006 v2.2)
- **在新窗口中打开 Tab**:Tab 右键 / 标签拽出可直接送到新窗口。共享右键菜单
  构造器统一三处 menu。删 TerminalToolbar。
- **CURSOR-1 / BETA-019 根治**(scrollback 架构重构):
  - main 端 SessionManager 用 `@xterm/headless` 维护权威 ANSI buffer
  - GetScrollbackResponse 改 ANSI 重建流(原裸字节)
  - 删 renderer 端 BETA-019 workaround 与 main 端裸字节存储
  - 配套 `docs/issues/cursor-1-alt-buffer-blink-policy-broke-codex.md` 与
    `docs/issues/xterm-serialize-mode-polyfill.md` 全程留档

### 改动

- **Linux 上跳过 WebGL renderer**(BETA-003 perf):某些发行版 / 显卡组合下
  WebGL 触发秒级滚动卡顿,DOM renderer 在 Linux 上更稳。Windows 行为不变。
  (1dbc8bc)
- **Linux 上 transparent: false + 方角窗口**(BETA-003c):BETA-003b 为修圆角
  开启 `transparent: true`,Wayland 下污染 viewport 计算导致 `$COLUMNS` 卡死;
  撤回 transparent,接受方角(与 gnome-terminal / wezterm 等所有主流 Linux 终端
  一致)。(7d4ebef)
- **i18n 切换语言实时生效**:原 `useEffect setLocale` 延迟一帧,改同步派发。
  (1fea493)
- **取消"系统"独立分组**:桌面 / 主目录改为默认收藏种子,首装更直观。
  (7870d02)
- **浅色主题 token 三层架构**(BETA-038 后续):Token / Semantic / Component
  三层重构,顺手修浅色主题 xterm dim 字对比度。
- **拖文件光标闪烁修复**(DROP-1):重构决策点 + 补 dragenter,F7-F11 五轮
  sidebar dropzone 体验打磨。
- **UI 精简**:无边框 + 工具栏瘦身。**Cutie 主题重设计为樱花奶昔风**(粉色
  少女向,撤 80s 复古糖果一版)。

### 修复

- **dev 端口探测器避开 Hyper-V/WinNAT 保留段**:旧探测在 Windows 上偶发
  EACCES,改避开保留段。(7ecfa4d)
- **BETA-019 cursor 闪烁**:CURSOR-1 重构前先 ship workaround,重构落地后删除。
- **beta 勘误第二轮 F1-F6**:系统路径 / 警告槽位 / 主题作用域 / 标题圆角 /
  斜体切断 / AI Base URL 一次性收口。(53eba4b)

### 文档

- **试用说明 → 上手指南**(`docs/presentation/上手指南.md`):删公司痕迹,
  §2.4 加 "E · Linux: 可用但不可靠" 五条已知问题清单(RESIZE-1 / 方角 /
  WebGL / 无托盘 / 中文 IME),§5 改为开源协作渠道。(1bbcae3)
- **产品完整介绍**(`docs/presentation/产品完整介绍-20260517.md`):12 章
  完整产品说明书,适合官网 / GitHub README 长版 / BD 材料。(2f56a58)
- **分享会-完整介绍**(`docs/presentation/分享会-完整介绍-20260517.md`):
  15-25 分钟分享提纲 + 关键句 + Q&A 备弹。
- **RESIZE-1 工单**(`docs/issues/resize-1-windows-mode-disables-reflow.md`):
  Linux 上拖大窗口历史行不 reflow 根因定位(`windowsMode: true` 无平台分支
  关闭 xterm reflow),方案 A(1 行改)与方案 B(升级到 windowsPty)对比,
  **修复未实施 — beta.6 处理**。
- **IME-1 / DROP-1 工单存档**:中文 IME 标点冲刷 + sidebar 拖文件光标闪烁,
  根因待定。
- BETA-003 实施方案存档:`docs/方案-BETA-003-Linux支持-20260517.md`。

### 已知限制(beta.5 仍存在,等后续 release 修)

- **RESIZE-1**(P1, Linux):拖大窗口后旧 cols 卡死,见上方文档章。**beta.6 修**
- **方角窗口**(Linux):接受的妥协,trade-off 是 resize 能用
- **WebGL 关闭**(Linux):滚动比 Windows 略卡
- **无系统托盘**(Linux):平台限制(GNOME 移除 system tray),配套二次确认 modal
- **IME-1**(Linux + Windows):中文 IME 按标点偶发冲刷历史输入,根因调查中
- **KI-004**(全平台):ConPTY 强约束 — Marina 主进程崩则所有 PTY 必死。
  长任务请挂 tmux / screen / nohup 兜底
- **无代码签名 + 无自动更新**:beta 阶段如此,公测前会做

### 工程

- 测试 320+ 通过(含 `linux.test.ts` 新增 18 个用例:detectShells /
  buildShellLaunchParams / getProcessCwd / setAutoStart /
  registerFileManagerIntegration)
- 仓库正式开源:**https://github.com/Liyue-Cheng/marina** (MIT)
- 分支:`fix/cursor-1-state-replay` no-ff merge 到 `main`

---

## [0.1.0-beta.4] — 2026-05-16

Beta 反馈勘误回合一次性收口 32 条工单。详见 `docs/beta反馈工单库-20260515.md`。
跳过的工单:**BETA-003**(Ubuntu 支持,Linux 集成方案仍在修改)与
**BETA-019**(Claude Code 光标闪烁,唯一未知根因,等用户复现信息)。

### 新增

- **AI 助手**:设置页新分类(Brain icon),支持 Anthropic / OpenAI 两个 provider,
  含 apiKey 输入(显示/隐藏切换)、model 输入、测试连接按钮、状态复核开关。
  (BETA-031)
- **LLM 状态复核**:`active→idle` 跃迁前可让 LLM 看一眼 scrollback 复核,
  避免 Vite 等长输出工具被误判 idle。失败时回退原阈值不阻塞。需要 BETA-031
  设置开启。(BETA-006)
- **简易页面 + 终端工具栏**:Tab bar 右端新增 4 个 lucide 按钮 ——
  复制全部 scrollback / 清屏(同时清 main ring buffer)/ 搜索 /
  简易模式切换。Explorer 右键 / 命令行 `--mode=simple` 可直接进入简易模式。
  (BETA-027 / BETA-028)
- **系统路径分组**:Sidebar 新增第 4 栏"系统",含桌面 / 主目录 / 临时目录。
  整体 + 逐项开关在外观设置里。(BETA-011)
- **4 个新主题**:One Dark Pro / Dracula / Tokyo Night / Catppuccin Mocha。
  主题总数 7→11。(BETA-033)
- **同名末级智能去重**:同 category 内多个路径末段同名时自动补父目录,
  `proj1/src` 与 `proj2/src` 区分;手动命名的不参与。(BETA-014)
- **路径存在性检查**:启动期扫描所有 bookmarks / temporary / recent /
  systemPaths,不可访问的路径标 ⚠️ 不可访问 + 半透明显示。(BETA-043)
- **中英双语 i18n**:`src/shared/i18n.ts` 自写轻量框架,~80 个 key 覆盖
  Sidebar / Settings / TerminalToolbar 等关键 UI;设置页可切换"跟随系统
  / 中文 / English"。(BETA-004)
- **完成/失败 icon 区分**:exited session 状态点叠 ✓(exitCode=0)/ ✗
  (非零)/ 仅灰底(强杀)。(BETA-007)
- **macOS 红绿灯悬浮符号开关**:外观设置可选 hover 时是否显示 ×/−/+,
  默认关。(BETA-023)
- **Win11 右键菜单**:install/uninstall 成功后 toast 提示"请重启计算机"
  以确保 MSIX 加载生效。(BETA-044)

### 改动

- **创建终端初始状态从 active 改为 idle**:语义反转,`active` = 用户命令
  正在执行,`idle` = 等待命令(含 banner 期 + prompt 等待)。消除"新建即
  闪绿"。推翻 CP-4 勘误 #5。(BETA-008,ADR-014)
- **spawn 前从注册表合并最新 PATH**:Windows 安装新软件后,新 PTY 立刻
  能看到新的 python.exe / node.exe,无需重启 Marina。(BETA-001)
- **多行粘贴判定逻辑修复**:原 normalize 只剥一个尾换行,`"ls\n\n"` 被算
  2 行误触发 confirm,改为剥所有尾空行。(BETA-041)
- **切换终端不再"从上往下刷屏"**:scrollback 重放完立即 `scrollToBottom()`。
  (BETA-018)
- **新窗口右键打开终端时自动展开 path**:Explorer "在 Marina 终端中
  打开" 新窗口里直接看到 session,不再要手动展开。(BETA-042)
- **主题选择 UI 改纯文本列表**:删 5 色块色卡,改纯文本 + 深色/浅色 tag。
  (BETA-032)
- **Cutie 主题重设计**:从单调奶油粉换 80s 复古糖果风(iBook G3 / 马卡龙
  色系);所有 ANSI 16 色对浅底对比度 ≥ 4.5:1。配色细节欢迎用户反馈。
  (BETA-034)
- **浅色主题 ANSI bright 集对比度修复**:Rose Pine Dawn 的 brightBlack /
  brightYellow / brightCyan 全部调到 ≥ 4.5:1,解决 Claude Code 在浅色主题
  下出现"浅底白字"问题。(BETA-035)
- **浅色主题右键菜单 / Modal 边框 + 背景透明度调整**:边框换 --muted,
  modal backdrop 改 22%(原 45% 在浅底突兀)。(BETA-037)
- **数据目录显示真实路径**:设置页用 `app.getPath('userData')` 替换硬编码
  `%APPDATA%\Marina`,portable / dev / 自定义 userData 场景准确。(BETA-039)
- **Sidebar 分组标题字号 / 颜色加重**:font-size 11→12,color --subtle
  → --text。(BETA-012)
- **Sidebar 三角形换 lucide ChevronRight/Down**:文字 ▶ 视觉上不够清晰。
  (BETA-013)
- **Sidebar 顶部与右侧 Tab bar 对齐**:32px spacer。(BETA-016)
- **Sidebar 点空白处取消选中**:`e.target === e.currentTarget` 判断。
  不依赖快捷键(哲学约束)。(BETA-017)
- **Tab 卡片加顶部圆角 + padding-right**:浏览器风格圆角;斜体字右上角不
  再被切。(BETA-020 / BETA-025)
- **Window 标题栏改动**:删底部 border 分割线;`Window N` badge 去矩形
  仅留纯文字。(BETA-021 / BETA-022)
- **macOS 风格标题染色修复**:浅色主题下 `--subtle` 对背景不可见,改 `--text`。
  (BETA-024)
- **删 logo 中的金色光标方块**:视觉上与 `>_` 提示符语义重复。(BETA-026)

### 删除

- **设置页"复制 PS 命令"调试按钮**:Win11 右键菜单卡片内不再展示
  install/uninstall 命令副本。(BETA-038)

### 已知限制

- **KI-004**:Windows ConPTY 强约束 — Marina 主进程崩溃则所有 PTY 必死。
  接受为 V1 限制,用户应定期 export 设置;长任务挂 tmux / screen / nohup
  以独立于 Marina 主进程。(BETA-002)

### 工程

- 新依赖:`@anthropic-ai/sdk` + `openai`(AI 助手用,用户已确认)
- 测试:320 全过(+10 来自 `path-display.test.ts`)
- 分支:`fix/beta-feedback-20260515`,基于 `dev`(beta.3)

### 跳过

- **BETA-003 Ubuntu 支持**:Linux 集成方案仍在迭代,本轮不动
- **BETA-019 Claude Code 光标闪烁**:唯一未知根因 bug,等用户复现信息

---

## [0.1.0-beta.3] — 2026-05-15

Beta 试用阶段,详见 git log。
