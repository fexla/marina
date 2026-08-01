# Marina Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/),版本号遵循 [SemVer](https://semver.org/)。

## [Unreleased]

> 开发期间(未分发)的改动记入此段。版本号按附录 E 纪律 1 攒批,不在每个小改时 bump;
> 等攒够一批、产开发构建(附录 F)或正式发布时,把本段折成一个版本号(并加日期)。

### 修复

- **切换终端偶发「闪一下又切回去」+ 文件页面报 NotOwner(根治)。** 根因是
  claim-gate 的旧契约把 claim 失败也当成「等待结束」放行面板请求,于是失败的接管
  仍会触发文件/Git 面板发注定 NotOwner 的请求;同时各接管路径的失败回滚是无条件的,
  迟到的失败会覆盖用户后续已经成功的选择。本次改造:`waitForClaim` 改为返回
  `{ ok: boolean }`(失败不再静默放行),FileTreePanel / GitPanel /
  useGitPollingDemand 在 `outcome.ok === false` 时中止请求不发 IPC(从根上消除
  NotOwner 错误态);MainPane / Sidebar 的 orphan 接管回滚加 generation 守卫
  (只在用户没有再点别的终端时才回滚);useCloseSession 续看的 claim 登记提前到
  乐观选择时(消除「面板在 claim 登记前就请求」的空窗)。回归测试新增 claim
  失败不得触发面板请求的组合用例。对应 ADR-005(一窗口一 owner)。
- **代码块按钮 hover 不再出黑块:透明外壳组件禁用主题 bg token。** 根因是
  `.md-code-block-btn:hover` 用了 `var(--color-bg-hover)` —— 该 token 按应用
  主背景调色,而代码块外壳透明、底下背景随面板/主题未知,深色主题下渲染成
  黑块。通用修复:透明外壳组件的 hover/选中反馈一律改
  `color-mix(in srgb, currentColor N%, transparent)`(由元素自身文字色派生,
  与任何背景都可读,永不变黑,明暗主题自适应)。新增样式契约守卫
  `src/renderer/styles/global-css.test.ts`:`npm test` 自动拦截“代码块规则里
  出现 var(--color-bg-\*)”与“hover 反馈色不用 currentColor”两类回归 ——
  这类问题以后由 CI 抓,不需要逐个主题人工测。
- **代码块支持运行选中片段:改为鼠标附近悬浮按钮。** 在代码块内选中文本后,
  松开鼠标会在鼠标附近浮出一个“运行选中”按钮(类似 VS Code 的 lightbulb),
  点它只跑选中部分。原工具栏“运行”按钮恢复成始终跑整块,两者职责独立。
  实现:selectionchange 只维护 ref + 选区消失时隐藏(拖选过程零重渲染);
  mouseup 时用鼠标坐标定位 fixed 浮层(贴合“鼠标附近”);onMouseDown
  preventDefault 避免点按钮清空选区。样式走 currentColor tint + 阴影,
  守样式契约(守卫测试覆盖)。
- **悬浮“运行选中”按钮改为不透明绿色 FAB。** 按钮使用不透明绿色底 + 白色
  三角图标(Material FAB 风格),只显示图标 —— 悬浮位置不确定,半透明在任意
  背景上都不够清晰。mouseup 监听放在 document,保证代码块边缘外松手也能完成
  归属校验;选中文本存 ref,点击按钮不会因浏览器先清空选区而丢失命令。
- **选区必须唯一归属于一个代码块。** 用 Range.comparePoint 统计选区实际相交的
  `.md-code-block > pre`:恰好一个且普通选区完整位于其中时才显示按钮;横跨两个
  或更多代码块时所有块均拒绝,不会每块各显示一个。普通拖选超出代码块同样拒绝。
  Chromium 三击末行会把 focus 自动扩到后续 H2,因此仅对 mouseup.detail >= 3
  且“起点在 pre 内、终点越过 pre 尾部”的已确认浏览器行为裁掉多选部分,保留
  三击最后一行的运行能力;该例外仍要求只相交一个代码块。
- **修复三击末行显示按钮但点击后不执行。** 点击悬浮按钮自身会冒泡新的
  document mouseup(detail=1),此前它在 click 之前把三击特殊选区按普通跨界选区
  清空,导致运行处理器读不到命令。document 选区监听现在忽略悬浮按钮自身的
  mouseup,保留 mousedown preventDefault 已保护的选区与命令 ref。
- **悬浮按钮改为代码块内部绝对定位并随文档滚动。** 选区 viewport 坐标在
  mouseup 时换算成 `.md-code-block` 内部坐标,wrapper 用 position:relative、按钮
  用 position:absolute;滚轮滚动 Markdown 页面时按钮随所属代码块移动,不再像
  fixed 元素一样钉在屏幕原位。位置同时钳在代码块边界内,不会浮到无关内容上。
- **代码块运行状态改为组件外 L1 缓存,切 terminal 不再停进程或丢输出。** 删除
  MarkdownCodeBlock 卸载时主动 stop 的旧逻辑;窗口级事件桥在组件不挂载时仍接收
  output/exited,切回后按 sessionId + 文档路径 + 源位置 + 代码摘要恢复运行状态、
  流式输出和退出码。缓存有 128 条 / 单条 2Mi 字符硬上限,只淘汰非 running 条目;
  敏感输出仅存在 renderer 内存,不写 localStorage、磁盘或日志。窗口真正关闭时仍由
  CodeBlockRunner.removeClient 终止该窗口启动的任务;源 Session 真正销毁时则由
  removeSession 只停止该 Session 的任务并向存活窗口发 exited 收口 cache。
- **代码块新增“清除”按钮。** 运行结束或启动失败后,在输出区底部 footer 的右侧
  显示清除操作(退出状态留在左侧);点击删除缓存结果并回到 idle,输出区和退出码
  一起消失。运行中不显示且 cache 拒绝误清,避免遗失存活任务的 runId;需要先停止
  或等待退出。
- **运行 / 停止 / 清除统一改为纯图标按钮。** 三个动作的图标语义已足够清晰,移除
  重复文字以降低工具栏和输出 footer 的视觉噪音;保留 title 悬停提示并补 aria-label。
- **所有代码块纯图标按钮统一为 24×24 正方形。** 复制 / 运行 / 停止 / 清除及
  “运行选中”悬浮按钮共用 md-code-block-btn 的固定正方形尺寸和 12px 图标;修复
  悬浮按钮继承横向 padding 后显示成长方形。定位仍测量顶部运行按钮的真实宽高。

### 改进

- **pwsh 代码块在未装 PowerShell 7 的机器上回退到 Windows PowerShell 5.1。**
  之前 detectShells 找不到 pwsh → spawn pwsh.exe ENOENT → 友好报错但无法
  运行。现在 pwsh 的 shell 偏好序改为 ['pwsh', 'powershell'],Windows 上
  powershell.exe 必装,绝大多数代码块在 5.1 / 7 下行为一致。UTF-8 前缀通用。
- **show-in-marina 预制 skill 提示词新增“可运行代码块”指引。** SKILL.md 新增
  专节,告知 AI:经 `show` 展示的 Markdown 里 fenced 代码块(bash/powershell/
  cmd)自带运行按钮,用户一键执行 / 选中片段执行。AI 可借此自发产出可操作
  文档(分步 setup 指南、“试试这几条”命令菜单、修复验证步骤),而非仅可读文档。
  description 同步更新。src 与 .pi 两份同步。
- **GPU 合成降级时自动回退 DOM renderer(PER-2),根治 WebGL 导致的持续高 CPU。**
  Chromium 在 GPU 进程崩溃 / 显卡设备变化(如 AMD 驱动重装)后会自动给 renderer 加
  `--disable-gpu-compositing`,把网页合成从 GPU 降级到 CPU 软件光栅。但 xterm 的
  WebGL renderer(`advanced.terminalRenderer: auto`,Windows/macOS 默认)不感知这个
  降级,继续用 WebGL 画光标(`cursorBlink` 每帧),产物却要交给 CPU 合成 ——
  实测(真实 Electron,2026-07-31)GPU 进程持续烧 432–471% 单核(≈ 4 个核),整机体感
  “卡”;切 DOM renderer 后 GPU 进程瞬间降至 7-8%(↓ 60 倍)。现 preload 检测本
  renderer 命令行(`window.api.gpuCompositingDisabled`),auto 模式下据此强制回退 DOM,
  避免 “WebGL + CPU 合成” 最差组合;用户显式选 `webgl` / `dom` 不受影响。
- **飞行记录器不再低估 GPU 进程 CPU(PER-2)。** `aggregateElectronMetrics` 原用
  `app.getAppMetrics().cpu.percentCPUUsage` 单点采样,对 GPU 进程实测可低估 40-60 倍
  (报告显示 6.8%,实际 432%)。改用 `cumulativeCPUUsage`(Electron 22+ 运行时提供)
  差分换算真实平均 CPU%,首采样无基线时 fallback `percentCPUUsage`。这类“GPU 烧核”
  问题以后在自动报告里一目了然,不再隐藏。
- **切换终端提速(REPLAY-1):claim 不再重复序列化 scrollback。** `cmd:session:claim`
  响应从"完整 base64 scrollback + lastSeq"改为仅 O(1) lastSeq —— renderer 从不消费
  claim 响应里的 scrollback(冷挂载走 `get-scrollback`,暖切换由 TerminalDeck 缓存 +
  view lease 维持),历史实现让每次切换都在 main 重复 serialize(5000 行 ≈ 40-60ms)
  并传输 0.6-2MB 大 payload。协议、ipc-protocol.md、claim-gate 同步。
- **冷挂载 scrollback 重放提速(REPLAY-1):分片从 16KB + 每片 `setTimeout(0)` 改为
  256KB + 时间预算 + MessageChannel 让出。** 实测(真实 Electron,2026-07-31):
  Chromium 对连续嵌套 timer 有 ~4ms clamp,5000 行 120 列(≈590KB)重放 214ms、
  240 列 CJK(≈1.7MB)551ms,其中 timer 链单独占 130-500ms;不插 timer 的完整
  重放仅 47-81ms。新策略实测 34/47/49ms(590KB / 1.19MB / 1.74MB),提速 6-11 倍,
  保留 FLK-1 的"主线程可呼吸、敲键回显正常"收益。

## [0.3.2-dev.10] — 2026-08-01

> **开发构建**(AGENTS.md 附录 F)。dev.9 的代码块执行在中文兼容性上翻车:Electron main
> 的 PATH 没有 pwsh.exe / Git Bash(用户装了但不在 PATH),spawn 异步 ENOENT → 用户看到
> 退出码 -4058;cmd 输出按系统 ANSI 代码页(GBK)解码乱码;代码块外壳背景误用 elevated
> 导致“黑条”扩大。本版全部修复。SemVer 上 `0.3.2-dev.9 < 0.3.2-dev.10 < 0.3.2`。
> 产物 `Marina-Portable-0.3.2-dev.10-x64.exe`。

### 修复

- **代码块执行不再依赖 PATH:shell 走应用自身 detectShells 的绝对路径。** pwsh / bash /
  powershell / cmd 的 spawn 命令优先取 `detectShells` 结果(与 SessionManager 同一检测源,
  覆盖 `Program Files\PowerShell\7\pwsh.exe` / `Program Files\Git\bin\bash.exe` 等),
  Electron main 的 PATH 里没有这些可执行文件时不再报 ENOENT(退出码 -4058)。`run()`
  改为 async(等待 shell 解析),getShells 失败回退 PATH 名不阻塞。spawn 后异步 ENOENT
  也给出“找不到可执行命令”的友好提示而非裸的 -4058。
- **cmd 输出中文乱码修复:GBK/UTF-8 自动检测解码。** cmd.exe 按系统 ANSI 代码页(中文
  Windows = GBK)输出,`chcp 65001` 对管道输出无效(实测中文变问号)。新增
  `DetectingOutputDecoder`:纯 ASCII 直接输出,首段非 ASCII 字节用 fatal UTF-8 判定,
  失败则按 GBK 解码,TextDecoder(stream) 处理跨 chunk 多字节切分。同时移除 cmd 的
  chcp 前缀。PowerShell/pwsh 仍用命令前缀强制 UTF-8(dev.9 已验证生效)。
- **代码块外壳背景不再扩大“黑条”。** dev.9 把整块背景设为 elevated 变量导致黑区从
  toolbar 扩大到整块;改为外壳 / toolbar / 输出区全透明、仅 border 分层,代码区背景
  仍由各主题 pre 规则提供,明暗主题自适应。

## [0.3.2-dev.9] — 2026-07-31

### 新增

- **Markdown 代码块一键执行(ADR-023)。** Markdown 面板里 `bash` / `sh` / `powershell` /
  `pwsh` / `cmd` 等 fenced code block 现在带「复制」「运行」按钮。点击「运行」后
  main/daemon 直接 `child_process.spawn` 对应 shell 跑整段代码,**不经 PTY / xterm**,因此
  当前终端无论是 Claude Code / Codex / vim 还是普通 shell 都不会被干扰。工作目录取自
  该终端的服务端 `currentCwd`,输出在代码块下方流式显示,运行中可「停止」(SIGKILL),
  退出后显示 exit code。本地与远程后端行为一致(preload 自动路由);SSH 终端因命令需在
  远程主机跑、本进程无法 spawn 而明确拒绝。无确认弹窗(产品决策移除风险分级)。
  - 新增 `src/shared/markdown-command.ts`(语言归一化与可运行判定)、
    `src/main/code-block-runner.ts`(spawn + 流式输出 + 生命周期)、
    `src/renderer/components/file-panel/MarkdownCodeBlock.tsx`(工具栏 / 输出区)。
  - 新增 IPC:`cmd:system:run-code-block` / `cmd:system:stop-code-block` /
    `evt:system:code-block-output` / `evt:system:code-block-exited`。
  - **编码**:`StringDecoder('utf8')` 处理多字节字符跨 chunk 切分;PowerShell / pwsh
    命令前缀强制 `[Console]::OutputEncoding = UTF8`(中文 Windows 默认 GBK 输出会乱码);
    cmd 前缀 `chcp 65001` 切 UTF-8 代码页。bash 用 `-c`(非登录非交互,避免登录 shell
    profile 副作用导致的输出丢失)。
  - **样式**:代码块外壳统一背景 + 透明 toolbar / output(明暗主题自适应,不再出现
    固定黑条);无输出的运行也显示 exit code,不再“闪一下闪回”。

## [0.3.2-dev.8] — 2026-07-30

> **开发构建**（AGENTS.md 附录 F）。人工复验澄清此前所说的“滚动位置”指右侧
> Markdown / 文本 / Diff 等文件预览，不是中间 xterm；本版修复正确的状态对象。
> dev.7 的 TerminalDeck 保留为独立的终端生命周期修正。SemVer 上
> `0.3.2-dev.7 < 0.3.2-dev.8 < 0.3.2`。
> 产物 `Marina-Portable-0.3.2-dev.8-x64.exe`。

### 修复

- **右侧文件预览按终端、文件分别记住真实滚动位置。** 新增 renderer L1 view state `fileViewerScroll`，以 `sessionId + OpenedFile.path + kind` 隔离 Markdown、Text、Diff、Image/Unknown；切换工作区面板、文件 tab 或终端 Session 后恢复，关闭文件、清空面板或销毁 Session 时同步清理。Markdown/Image 使用 `.file-panel-body` 的文档级坐标，Text/Diff 使用各自内层双轴 scroller；Diff 同时恢复 `scrollLeft` / `scrollTop` 并同步左侧 gutter。滚动事件 120ms trailing debounce 写 store，切换前立即 flush，不使用模块级隐藏 Map，也不跨应用重启持久化。
- **异步加载、快速切换和搜索不再覆盖正确位置。** `useFileContent` 给响应绑定 request identity，同 kind 文件切换时同步隐藏上一文件内容；恢复走双 RAF + `ResizeObserver`（最多 4 秒），Markdown 图片等布局尚短时保留原目标，不能被浏览器 clamp 后的程序化 scroll 事件覆写。React DOM mutation 已先把复用容器归零时，cleanup 只 flush 事件阶段的 pending 真值，不重读 DOM；另对跨文件迟到 scroll、快速卸载和搜索 `scrollIntoView` 设置独立 fence，避免位置串档或互相抢滚动。

### 验证

- 新增真实 Electron `smoke:file-viewer-scroll`：覆盖初始 `maxTop=0` 后延迟长高、双 RAF 前快速卸载、搜索 active 且无匹配时 A→B→A、两个 Markdown 文件独立位置、Text 纵向恢复、Diff 横纵向 + gutter 同步，以及 panel / file / session 三类切换。最终 typecheck、ESLint、Stylelint、63 个测试文件（1000/1000）和该 smoke 全部通过。

## [0.3.2-dev.7] — 2026-07-29

> **开发构建**(AGENTS.md 附录 F)。dev.6 人工复验确认 Diff 双 pane 布局正确，
> 但终端滚动仍未修复；本版停止继续修 replay 标量，改为保留真实 xterm 实例。
> SemVer 上 `0.3.2-dev.6 < 0.3.2-dev.7 < 0.3.2`。
> 产物 `Marina-Portable-0.3.2-dev.7-x64.exe`。

### 修复

- **Session 切换改为持久 TerminalDeck，不再销毁/重建 xterm。** dev.4–dev.6 的 `viewportY`、live store、`preventScroll` 都未改变根因：MainPane 每次切换仍按 session key 卸载 TerminalView、`term.dispose()`，再从另一个 headless Terminal 的序列化结果重建，单个行号不可能表达真实 viewport/buffer/reflow 状态。现最多缓存 10 个访问过的 xterm slot，A→B→A 只切换 `visibility/inert/active`；同一 Terminal、DOM node、buffer、viewport 和 selection 原样存活。Main 新增每 Session 唯一只读 view lease：owner=null 时 parked xterm 仍定向接收后台输出，但无 input/resize/文件/Git 权限；跨 client 漏输出时 `continuous=false`，只重建该 slot。parked slot 释放 WebGL、active 再加载，避免 GL context 累积。真实 Electron smoke 创建 A/B、滚 A、让 A parked 期间继续输出、再切回 A，断言 viewport DOM identity 不变、`viewportY` 不变且后台 token 已收到，连续两次通过。
- **Diff 双栏分隔线不再亮粉。** dev.6 使用了不存在的 `--color-border`，命中调试 fallback `#f0f`。改用项目既有主题策略：`color-mix(var(--color-text-muted) 18%, transparent)`，七套主题均为低对比 hairline。

## [0.3.2-dev.6] — 2026-07-29

> **开发构建**(AGENTS.md 附录 F)。dev.5 后按人工复验纠正 Diff 查看器的基础布局，
> 不再用 sticky 遮罩修补正文穿透。SemVer 上 `0.3.2-dev.5 < 0.3.2-dev.6 < 0.3.2`。
> 产物 `Marina-Portable-0.3.2-dev.6-x64.exe`。

### 修复

- **Diff 行号栏与代码栏改为物理分离的双 pane。** dev.4/dev.5 的根本错误不是某个宽/高 CSS 值,而是布局把 gutter 放在代码横向滚动层里,再靠 sticky + 不透明背景遮住从下面滚过的正文；这让“穿透”成为设计上始终存在、只能打补丁掩盖的问题。现重构为 sibling panes:左 pane 只渲染数字/符号并固定不参与横向滚动,右 pane 独占代码横/纵滚动,两者只同步 `scrollTop`；数字栏有独立边界线,代码在 DOM clipping/布局层就不可能进入数字栏。中键平移、搜索 `scrollIntoView` 都作用于右 pane；鼠标停在左栏滚轮时转发给右 pane。水平滚动条实际高度会补入 gutter 尾部,保证滚到最底两边仍严格对齐。Chromium 几何探针确认横滚 140px 后左侧命中元素仍是 gutter、代码只在右 pane 的 clip 区内显示；100 行滚到底 `lastRowDelta=0`。

## [0.3.2-dev.5] — 2026-07-29

> **开发构建**(AGENTS.md 附录 F)。dev.4 人工复验确认终端滚动位置与 Diff gutter
> 两项旧修均未命中真正运行时问题；本版依据现场截图、React effect 时序与 Chromium
> 几何探针重新定位。SemVer 上 `0.3.2-dev.4 < 0.3.2-dev.5 < 0.3.2`。
> 产物 `Marina-Portable-0.3.2-dev.5-x64.exe`。

### 修复

- **终端滚动恢复改读 live store,焦点不再覆盖 viewport。** dev.4 已把位置重构为 store 一等 view state并改用正确的 `viewportY`,但 replay fence 仍读取 mount 时 `appState` 闭包。旧实例的 passive-effect cleanup 可能晚于新实例 render,导致刚 flush 的位置不在闭包里,恢复分支仍当作“无缓存”到底。现通过 `useAppStateRef()` 在异步 fence 当下读取最新 `terminalScroll`；直接聚焦 xterm helper textarea 统一使用 `preventScroll:true`,防止浏览器为了露出底部光标而把刚恢复的 viewport 再拉到底。
- **Diff 空 gutter 高度补齐(中间修正,dev.6 进一步改结构)。** 根据截图确认无行号 hunk 在 baseline grid 中 gutter 高度为 0,先用 `align-self:stretch` 补齐不透明背景。后续复盘确认“代码滚在 gutter 下方、靠背景遮住”本身就是错误布局,dev.6 改为真正分离的双 pane。

## [0.3.2-dev.4] — 2026-07-29

> **开发构建**(AGENTS.md 附录 F)。0.3.2-dev.3 验收后的一批修复:侧栏双击新建闪屏根治、
> 关闭终端续看按最近使用、切换终端记住滚动位置(重构为一等 view state)、Diff 无行号行 gutter。
> 仍预告版本号 `0.3.2`,dev 构建标识递增为 `-dev.4`。SemVer 上 `0.3.2-dev.3 < 0.3.2-dev.4 < 0.3.2`。
> 产物 `Marina-Portable-0.3.2-dev.4-x64.exe`。

### 修复

- **侧栏双击新建终端不再先闪一下「新建终端」页。** 0.3.2-dev.3 只修了 invoke 返回早于广播的时序类闪屏,漏了一个更根本的来源:双击序列里的第一击 `click` 会先派发 `view/select-path`,该 reducer 在 hideTopTabBar 模式下无条件清空 `selectedSessionId`,于是主区在 `dblclick` 触发 SESSION_CREATE 并返回之前一直显示 EmptyPathState。现给侧栏 `PathItem` 的单击选中加一个双击阈值窗口(230ms)的去抖:`click` 不立即派发选中,而是延后;若在该窗口内收到 `dblclick` 则取消这次选中,双击就只「直接新建终端」而不先切到新建页(标签栏可见模式同样受益)。这是文件管理器/终端启动器的标准 click-vs-dblclick 消歧模式。
- **关闭终端续看按最近使用顺序选候选。** 关掉当前终端后,若同目录有多个无主(orphan)终端,此前按侧栏/tab 的创建顺序取第一个,不贴合「关一个、看下一个」的直觉。现 store 记每个 session 的最后选中时间戳(`view/select-session` / `sessions/created` 写,`sessions/destroyed` 清),续看选候选改为按该时间戳降序——用户最近还看过的那个终端优先;无记录的(从未在本窗口选过的 orphan)排末尾,之间回退到原顺序做稳定兜底。
- **切换终端滚动位置进入 store(首次实现,dev.5 继续纠偏)。** 将位置做成一等 view state(`terminalScroll: Map<sessionId,{topLine,wasAtBottom}>`),onScroll debounce 写、卸载 flush、session 销毁清理；修正 `baseY`/`viewportY` 字段误用。人工复验发现异步 fence 仍读取 mount 时闭包,所以本版并未真正解决切换后恢复,后续由 dev.5 修复。
- **Diff 无行号 gutter 首次宽度修正(dev.5 继续纠偏)。** 始终渲染空行号槽并固定 gutter 宽度,保证 hunk/header 与普通代码行的正文起点一致。人工复验截图确认真正问题是空 gutter 高度为 0 导致横向正文穿透,所以宽度修正视觉上没有解决主诉；后续由 dev.5 修复。

## [0.3.2-dev.3] — 2026-07-26

> **开发构建**(AGENTS.md 附录 F)。0.3.2-dev.2 后积累的一批改动:Git 轮询按 repo 去重、
> Nerd Font 兑底、远程 permessage-deflate、面板 race / 续看 / 新建闪屏 / 代码查看器滚动等修复,
> 以及 show-in-marina 技能的僵尸 tab 检测 + 批量 close + 文档增强。仍预告版本号 `0.3.2`,
> dev 构建标识递增为 `-dev.3`。SemVer 上 `0.3.2-dev.2 < 0.3.2-dev.3 < 0.3.2`。
> 产物 `Marina-Portable-0.3.2-dev.3-x64.exe`。

### show-in-marina 技能

- **僵尸 tab 检测。** 面板里的 tab 指向的文件被从磁盘删除后,此前 tab 会无限期残留且用户无从发现。现 `FilePanelService` 为每个已打开文件维护 `missing` 标记:`fs.watch` 检测到删除时立即置 true(文件重现则清回 false),`GET /opening-files` 拉取前先 `refreshStale` 重刷磁盘真值(补 watcher 漏掉的事件,如 Marina 关闭期间被删)。CLI `marina list` 给僵尸 tab 打 `!` 前缀与 `(deleted)` 标记,并在末尾提示 `marina close --stale`;`list --json` 输出 `"missing": true`。
- **批量 close。** CLI `marina close` 新增三种批量形态:`--all`(关全部)、`--stale`(只关僵尸 tab)、`--glob <PATTERN>`(按 basename 通配关,支持 `*`/`?`)。路径参数含 `*`/`?` 自动当 glob(如 `close *.md`)。服务端新增 `POST /close-files {terminal, mode, pattern?}` 端点 + `closeAllFiles` / `closeMatchingFiles` / `refreshStale` 方法,返回体带 `closed` 路径列表供 CLI 输出「关了哪些」。glob 匹配为内置极简实现(不新增依赖)。
- **close 路径模糊匹配。** 此前 `close <PATH>` 必须与 `list` 输出的完整路径精确一致才关得掉,容易传错。现服务端 `closeFile` 精确路径未中时回退到大小写不敏感的 basename 匹配——只给文件名(如 `close report.md`)也能关;多个同名时报错并提示用完整路径或 glob,不猜不误关。renderer 的 tab 关闭恒走精确路径,行为不变。
- **文档:文档作为任务沟通界面。** SKILL.md 新增「Use one document as the task dashboard」一节,固化一个高频用法模式:跨多轮的同一任务用一份文档当与用户的沟通面(进展/选项/待确认项/用户批注集中在该文件,每轮覆写 + re-show 同一路径,CLI 只留状态 + 「详见文档」),比把长内容堆在 CLI 多轮里稳定得多。
- **安装的 skill 同步。** `.pi/skills/show-in-marina/`(项目级安装快照)此前落后于源(`src/skills/show-in-marina/`,缺 bash 封装、旧版 SKILL.md/ps1)。已与源同步,含上述全部改动与 bash 封装。

### 性能

- **Git 后台轮询按 repo 去重(ADR-021 方案 A)。** 此前每个 Git 仓库 session 各注册一个 3 秒/60 秒 polling task，同一 repo 开 N 个终端就重复轮询 N 次 `git status`（并占满全局并发预算，大仓库下制造 stall）。现改为按 repo 去重：一个 repo 只注册一个 task，run 时跑一次 git status 再 fan-out emit 给该 repo 下所有 session；每个 session 作为该 task 的一个 scheduler consumer（demand 由 scheduler 自动取各 session 最高）。同 repo 的 GitPanel mount / HOT immediate / 后台 poll 共享同一个 repo 级 in-flight，同 repo 任何时刻最多一个 git status 在跑。removePollingConsumer 改为枚举该窗口持有的 session 逐个撤 demand（demand consumerId 从 windowId 改为 sessionId）。

### 新增

- **内置 Nerd Font 兑底 + 自定义回退字体。** 很多 CLI 工具(powerlevel10k / starship / lsd / eza 等)在输出里塞 Nerd Font 图标,用户选的终端字体不含这些字形就会显方块。现应用内置 `Symbols Nerd Font Mono`(打包进 `assets/fonts/`,MIT 协议)作为终端字体栈的零配置兑底;字体栈由 `src/shared/font-stack.ts` 的 `buildTerminalFontStack()` 统一构建,优先级为主字体 → 用户自定义回退 → 内置 Nerd Font → 通用 monospace,保证 PUA 图标先命中符号字体而非被通用 monospace 截胡。另在「设置 → 外观」新增「回退字体」输入框(默认留空 = 仅用内置兑底),高级用户可填自定义回退(如自己装的完整 Nerd Font、emoji 字体),下方有实时 Nerd Font 图标预览 + 最终字体栈明文展示。

### 修复

- **远程连接(permessage-deflate)网络流量大幅下降。** 连远程 daemon 用终端时,PTY 字节流与 scrollback replay 都是高度可压缩的文本(大量 ANSI 转义/重复字符/空格),但此前 WS 传输未启用压缩,且经 base64+JSON 双重封装(约 +47% 膨胀)。现给 daemon 端 `WebSocketServer` 启用 permessage-deflate(RFC 7692):PTY 增量输出与切 tab 时的全量 scrollback replay(~2MB)压完常只剩几百 KB,典型远程流量可减 50–70%。client 端(preload 的浏览器原生 WebSocket)由 Chromium 自动发起 deflate 协商,无需改动;ws 库默认 threshold=1024,小于 1KB 的消息跳过压缩省 CPU。对齐 docs/方案-远程后端 R3 风险与 transport-ws.ts 顶部 TODO(P1 binary frame 后续再做)。
- **切换终端 tab 时文件/Git 面板不再报「当前窗口不持有该会话」(NotOwner)。** 同窗口内点一个之前被释放成无主(orphan)的终端时,面板会在终端视图刚切换、main 端 owner 关系尚未更新完成的瞬间发数据请求,被 `requireOwner` 判为 NotOwner 并把错误文字显给用户。根因是「乐观接管 orphan session」(renderer 先 dispatch 本地 owner 变更 + select,终端视图立即切换)与「main 端 SESSION_CLAIM 异步往返」(handler 内部要 await scrollback 序列化,非 ms 级)之间的 race —— 而 getScrollbackForReplay 免 owner 校验,所以终端本身不受影响,只有面板数据请求中招。现新增 `src/renderer/hooks/claim-gate.ts`:所有接管路径(tab 点击 / 侧栏点击 / 关闭续看 / 启动恢复)统一走 `claimSession()`,把 claim promise 登记进模块级 gate;面板(FileTreePanel / GitPanel / Git 轮询 demand)首次数据请求前 `await waitForClaim(sessionId)`,等 main 端 owner 就位再发,从根消除 race —— 终端切换的即时性不变。另给 main 端 `requireOwner` / `requireOwnerSession` 命中 NotOwner/SessionMissing 时补 `logger.warn`(带 sessionId/requester/真实 owner,区分「同窗口 race」与「跨窗口未接管」;只记 id 不记路径/命令,符合附录 H),此前这类面板错误在 main.log 里是黑洞。
- **关闭当前终端后自动续看(通用,不限 hideTopTabBar)。** 此前关掉正在看的终端,主区直接掉进「新建终端」页(即使同目录还有别的终端)——因为一个窗口同一时刻只持有 1 个 session,销毁后本窗口不再持有任何 session。现 tab 的 × / 右键菜单「关闭」/ statusbar「关闭」统一走续看逻辑:关掉当前终端时,若同目录有无主(orphan)终端就接管并切过去,没有才进新建页。乐观先选候选再 SESSION_CLOSE,避免中间闪一下新建页;claim 失败回滚到新建页。
- **hideTopTabBar 模式下「新建 / 关闭」放到底部 statusbar,不新增行。** TabBar 隐藏是为了省掉那一行,不能再用一条几乎全空的工具栏把它吃回去。改为复用终端底部已有的 statusbar(pid 那条,本就带简易模式切换等交互按钮),hideTopTabBar 模式下补「新建 / 关闭」两个小图标按钮。statusbar 仅在显示终端时存在,而 EmptyPathState(新建页)本身就有模板按钮,不重复。
- **新建终端不再闪一下「新建终端」页。** 双击侧栏目录 / EmptyPathState 模板按钮新建时,旧逻辑在 invoke 返回早于 `evt:session:created` 广播时选中的 id 尚未进入 state → 闪一下新建页。改用乐观 dispatch `sessions/created`(直接把 res.session 写入 state + 选中),广播后到达再幂等覆盖,全程无空窗。
- **代码查看器(DiffViewer / TextViewer)横向滚动后右侧裸露无底色 + 行号列挡不住代码。** 此前 diff 视图左右拖动查看长代码行时有两个叠加问题:(1) 往右拖后右侧区域没有行背景色;(2) 行号列挡不住滚过来的代码、文字重叠。根因是行级布局:每行(`.diff-line` / `.file-text-line`)是 `display:grid` 的 block 元素,宽度默认 = 填满滚动容器视口宽,而 `white-space:pre` 的代码内容溢出 grid box——于是行的 `background-color` 只画在视口宽的 box 上,溢出到右侧的代码文字区没有行底色;同时 add/del/hunk 行与查找聚焦行的底色用 `color-mix(..., transparent)` 叠在透明底上,`.diff-line-gutter` 的 `background:inherit` 继承到半透明色,也挡不住代码。修复两部分:(a) 在滚动容器与行之间新增一层 `.diff-lines` / `.file-text-lines` 包裹层,`width:max-content; min-width:100%`,让所有行(block 子元素)对齐到「最长行」的固有宽度,行背景随之覆盖到 scrollWidth 右端,横向滚动时背景连续不断裂;gutter 仍 sticky left:0 钉住。(b) 把上述半透明行底色的混合底从 `transparent` 换成不透明 `var(--color-bg-primary)`(视觉浓度几乎不变),gutter 即可正确遮挡滚过来的代码。DiffViewer 顺手把根元素从不规范的 `<pre>`(内含 block `<div>`)改为 `<div>`。两 viewer 同构,一并修好。

## [0.3.2-dev.2] — 2026-07-23

> **开发构建**(AGENTS.md 附录 F)。0.3.2-dev.1 后增补 PTY 吞吐/背压诊断与独立报告
> 分析工具。仍预告版本号 `0.3.2`,dev 构建标识递增为 `-dev.2`。SemVer 上
> `0.3.2-dev.1 < 0.3.2-dev.2 < 0.3.2`。产物 `Marina-Portable-0.3.2-dev.2-x64.exe`。

### 新增

- **PTY 吞吐与背压诊断(ADR-020 增补)。** 此前性能报告只记 `pty.outputBytes` 总量,远程/重负载场景(远程编译、tail 日志、cat 大文件)看不出是平稳流还是突发流,且 stall 全标“活跃操作:无”,无法判断是否由背压引起。现报告新增:每采样窗口的 bytes/s、chunks/s(从 counter delta 推导,零热路径开销);全程峰值速率与突发窗口计数(阈值固定 1 MiB/s);sessionOutput IPC 发送耗时分布(`pty.sessionOutputDispatch`,背压信号——renderer 跟不上时该调用变慢);8ms 合并窗口吸收字节峰值(`pty.peakPendingEmitBytes`);stall 记录携带近窗口 PTY 速率,能区分 stall 由流量突发/背压引起还是无关抖动。报告 Markdown 新增「PTY 数据吞吐与背压」段,stall 表新增「近 PTY 速率」列。
- **独立报告分析工具** `scripts/analyze-performance-report.mjs`。传入报告 JSON 路径(或省略自动找最新)即可输出六维诊断:吞吐健康(总量/峰值/平均/突发)、背压事件(慢 dispatch)、stall↔流量相关性、瓶颈定位(operation heatmap)、内存健康、隐私自检。纯 Node 内置模块,零新依赖。

## [0.3.2-dev.1] — 2026-07-22

> **开发构建**(AGENTS.md 附录 F)。0.3.1 发布后积累的性能诊断子系统 + 需求感知
> 后台调度属 MINOR 级新能力模块,故预告版本号取 `0.3.2`,dev 构建标识 `-dev.1`。
> SemVer 上 `0.3.1 < 0.3.2-dev.1 < 0.3.2`,装此包相对 0.3.1 是升级、不触发降级拦截;
> 相对未来正式 0.3.2 仍是预发布。产物 `Marina-Portable-0.3.2-dev.1-x64.exe`。

### 新增

- **性能飞行记录器。** 每次运行自动在 `performance-reports/` 生成一份有界 JSON + Markdown：10 秒采样 main event-loop delay/utilization（100ms histogram resolution）、CPU/RSS/heap、active resource 类型、Electron Browser/Tab/GPU/Utility 进程 CPU/内存、window/session/Git watcher gauges；250ms timer 统计 >=100/250/1000ms stall；固定名称 operation heatmap 汇总 IPC、Git、session/PTY 生命周期。平时 5 分钟原子刷新，>=1 秒严重 stall 至多每 60 秒额外落盘；异常退出保留 `finalized:false` 最近现场，最多保留 30 次运行。自动报告不记录路径、命令、终端内容、IPC payload 或 stack trace。
- **按需 15 秒 V8 CPU Profile。** 设置 -> 高级可显式捕获 main 进程 `.cpuprofile`；操作前提示函数名/本地源码路径隐私风险，服务端限制 5-30 秒、禁止并发采集且每 run 最多保留 5 份，从不因 stall 自动启动。
- **性能报告入口。** 设置 -> 高级显示本次采样/stall/RSS 摘要，并提供“立即刷新报告”“打开报告目录”。
- **0.3.2 性能飞行记录器条目重命名。** 上述三条为本批次飞行记录器能力（ADR-020）。
- **需求感知后台任务调度器（ADR-021）。** 新增 main 端 `BackgroundWorkScheduler`，昂贵周期任务统一使用 recursive timeout、全局并发预算、HOT/WARM/NONE demand、多窗口最高需求合并、pre-registration demand 和 generation 竞态防护；窗口关闭、远程断线、owner/Session 生命周期统一清理。

### 性能

- **关键路径统一埋点。** IPC 注册中间件按固定 channel 统计 duration/error/in-flight；Git status/diff、poll skip、watcher/in-flight gauges 与 session/PTY counters 接入同一有界 registry。metric name 有 200 项硬上限，拒绝路径/动态高基数字符串。
- **Git 扫描按真实 UI 需求降频。** 当前聚焦窗口的当前 Git 面板为 HOT：立即刷新、完成后 3 秒再扫；当前 Session 显示其他面板、dock 折叠或窗口失焦为 WARM：60 秒；切换 Session、owner 释放、退出/离仓/零窗口为 NONE：完全停止。所有自动 Git status 全局最多一个并发，同 session+cwd 的 mount 拉取/prefetch/HOT immediate 合并为一个子进程。

## [0.3.1] — 2026-07-22

> **正式 PATCH 版**。合并 `0.3.1-dev.1` / `0.3.1-dev.2` 两轮开发构建：集中完成
> viewer 与面板体验修复、面板状态/图标/缩进基础设施、`show-in-marina` 路径查询、
> Git 只读契约修正，以及长期运行后台轮询资源退化修复。

### 新增

- **文件条目图标按后缀名细分(ADR-019)。** 此前 file-tree / git / file-panel 三面板的文件条目清一色通用 `file` 图标。新增 `src/shared/file-icon.ts`(`fileIconFor`),按扩展名映射 9 类图标(文档 / 代码 / 配置 / 资产如 Unity 的 `.prefab`/`.asset`/`.meta` / 可执行 / 图片 / 压缩 / 锁文件 / 默认),复用既有扩展名判定思路;`icons.tsx` 注册对应 lucide 图标。目录仍用 `folder`。
- **文件面板顶部「当前目录 / 临时工作区」切换(ADR-019)。** 此前双根并排为两个 section,现改为顶部 toolbar 按钮切换(常态双按钮;单/零根为 SSH 会话等异常兜底),活跃根跨重启记忆。
- **面板 UI 状态分层基础设施(ADR-019)。** 新增 `src/shared/panel-ui-cache.ts`(L1,组件外缓存,切面板再切回不丢展开目录)+ `src/shared/panel-preferences.ts`(L2,localStorage,统一 key 规范 `marina.panel.<panelId>.<key>`,收编散落的裸 key 并惰性迁移)。file-tree / git-tree 展开态、git viewMode、file-tree activeRootId 接入对应层;新面板按决策树选层。

### 变更

- **树形缩进统一到单一真相源(ADR-019)。** 此前 file-tree 用 CSS 层叠缩进(`.file-tree-entry .file-tree-entry { margin-left:14px }`),git/file-panel 用 inline style(`depth*14`),14px 三处硬编码。现统一为 CSS 变量 `--tree-indent-unit` + `FileListRow` 的 `depth` prop 唯一渲染入口,file-tree 改走 depth 递归传递,两面板视觉/机制一致,新面板用 `FileListRow`+`depth` 即得正确缩进。

### 修复

- **长期运行不再因退出 session 的 Git 轮询累积而拖慢系统。** 此前每个 Git 仓库 session 都有 3 秒 `git status` poller；PTY 自然退出只进入 `exited`、不会 `sessionDestroyed`，因此关掉终端程序甚至所有窗口后 poller 仍永久 spawn `git.exe`，多个历史 session 会造成低平均 CPU 但明显的磁盘/Defender/游戏帧时间尖峰。现 exited/destroyed、cd 出仓库、运行时禁用 Git 四条路径都显式停止 watcher；慢 poll 加 per-session in-flight guard，禁止 3 秒 interval 与 5 秒 timeout 重叠；prefetch 在异步边界后重查 session state，防退出竞态“复活” watcher。新增 5 组生命周期/反压回归测试。
- **`show-in-marina` 不再把 `$MARINA_WORKSPACE` 当作字面目录。** 内置 skill 旧规则要求始终使用变量符号,但 `write`/`edit`/Python/Node 等非 shell 工具不会展开 `$MARINA_WORKSPACE` 或 `$env:MARINA_WORKSPACE`,会在当前项目下错误创建同名字面目录。CLI 新增 `marina workspace`,输出当前 session 受管临时目录的绝对路径;skill 强制 AI 先执行该命令、取得具体路径后再传给写文件工具,并禁止构造 `<cwd>/$MARINA_WORKSPACE/...`。新增成功/未注入/目录不存在/多余参数集成测试。
- **Git 面板既不抢 `.git/index.lock`,也不再误报“工作区干净”。** `git status` 默认会为 index refresh 写回 `.git/index` 并短暂持锁,会干扰外部 `git commit`/`add`。0.3.1-dev.1 尝试给三处 status 加 `--no-optional-locks`,但它是 git **全局选项**,旧实现却把它放在 `status` 子命令参数末尾(`git status ... --no-optional-locks`)→ status 报 unknown option、exit 129;真实有大量改动的 Unity 仓库因此被面板误报为“干净”。现 `runGit` 对所有 git 子进程统一注入 env `GIT_OPTIONAL_LOCKS=0`——无参数位置问题、状态结果不变、仍不写 index/不持锁。真实 Git 2.49.0.windows.1 仓库验证 status exit 0;`git-service.test.ts` 同时守护“命令行不带错误 flag + env 注入为 0”。资源优化(watcher 绑定面板可见性)仍暂缓。

### 修复（dev.1 阶段）

- **代码查看器布局:行号栏与代码栏分离(TextViewer + DiffViewer)。** 此前 TextViewer 用 `white-space: pre-wrap` + `word-break: break-all` + `inline-block` 行号,长行换行时换行文字从容器的 `x=0` 开始,**盖住行号栏**(开发者反馈)。改为 grid 双列:`[行号 sticky left:0][代码 white-space:pre]`。代码**不换行**,超宽出水平滚动条;行号 `position:sticky` 钉住左侧,横向滚动时不跟着移;行号 `background:inherit` 取所在行底色(含 search-current 高亮),挡住滚过来的代码。与 VS Code / 一般编辑器一致。
- **DiffViewer 补行号槽。** 此前 diff 没有行号(v0.3.2 时刻意没加)。本批从 hunk header `@@ -a,b +c,d @@` 解析行号:ctx 用 new-side、del 用 old-side、add 用 new-side(对齐 GitHub / VS Code)。DOM 改为 `[gutter(行号+符号) sticky][body pre]` 三段,gutter `background:inherit` 跟随行底色(add 绿/del 红/hunk 蓝)。
- **中键拖动平移(手型工具)。** 新 `useMiddleClickPan` hook:按住鼠标中键上下/左右拖动自动滚动(浏览器 / VS Code / Acrobat 同款)。阻止原生中键自动滚动光标(Windows 默认那个圆形滚动图标)。TextViewer / DiffViewer / MarkdownViewer 三个滚动容器都接入。此前无法用中键拖动面板。
- **后台终端的面板状态现在能持续更新。** 此前用户切去看终端 B 时,终端 A 变 orphan(`ownerWindowId=null`,见 `SessionManager.claimOwner` → `releaseAllOwnedBy`),而 `filePanelUpdated` / `gitStatusUpdated` 事件照搬了 PTY 字节流「仅推 owner 窗口」的策略,带 `if (!session?.ownerWindowId) return` 守卫 → orphan 期间的事件被直接丢弃,A 的面板状态在 renderer 里停在旧值,**下次切回 A 看到的还是旧文件列表 / 旧 diff**。现这两个事件改为 `broadcastEvent`(广播给所有窗口);PTY 字节流保持「定向 owner」不变(只有 owner 的 xterm 渲染它)。修复开发者反馈的「A 就不会发生面板切换,我下次换到 A 前台,面板依然是旧的」——不抢前台,只保证状态持续同步。

### 新增（dev.1 阶段）

- **diff/代码语法高亮语言表扩到 18 种。** 开发者反馈打开 go/rust/java 等文件的 diff “看起来没高亮”——其实是这些扩展名不在按需注册表里,回退纯 diff 语言(只有行底色)。补 go / rust / java / kotlin / ruby / php / sql 共 7 种(+~58KB)。现覆盖 ts/js/py/json/bash/yaml/markdown/xml/c/cpp/cs/go/rust/java/kotlin/ruby/php/sql。

## [0.3.0] — 2026-07-20

> **版本号规则生效后的首个版本**(AGENTS.md 附录 E)。此前 0.3.0/0.3.1/0.3.2 连着三个 minor 是失误,本版合并规整为一个 0.3.0(MINOR bump,含 Git 面板 + 面板搜索两个新功能模块)。

### 新增

- **Git 变更浏览面板(ADR-017)。** 当前终端 session 的 cwd 在 Git 仓库内时,右侧 dock 自动出现「Git」tab,列出工作区变更(modified / added / deleted / renamed / untracked / conflict),点文件跳「已打开」面板查看 unified diff。**动态 LayoutNode**:cd 进/出仓库时该 tab 自动出现/消失,非仓库 cwd 不显示空状态文案——评审裁决直接不渲染 tab。严格**只读**:只调 `git status` / `git diff`,**永远不做** stage / commit / push / pull / fetch / merge / rebase / stash / branch / checkout / log / blame 等 Git 管理操作(§13.2 / §14.6)。SSH session 不支持;`advanced.enableGitPanel = false` 时 tab 永不出现(视野守护)。
- **面板 Ctrl+F 搜索(VS Code 风格)。** 右 dock 顶部共享搜索栏,Ctrl+F 唤出(焦点在终端时 xterm 拦截走终端搜索,不冲突)。两种形态按当前活动面板自动切换:
  - **列表过滤型(Files / Git / Opened)**:输入即收窄,匹配片段高亮。Files 进入搜索态时调 `file-tree:list-recursive` 一次拉全量递归扁平 entries 缓存,本地过滤(此前懒加载只能搜已展开目录);Git 树形/平铺都支持;Opened 只收窄 tab 列表。
  - **文件内查找型(TextViewer / DiffViewer / MarkdownViewer)**:行级跳转 + 命中数 `x/N`,Enter 下一个 / Shift+Enter 上一个 / Esc 关闭 / Aa 大小写。统一用 CSS Custom Highlight API(`::highlight`,Chromium 105+)在渲染后 DOM 文本节点上 overlay 高亮,**不改 DOM** → 避开 hljs span 嵦套冲突,三 viewer 一套机制。交互对齐终端搜索栏。
- **文件条目统一抽象(ADR-017 + ADR-018)。** 右 dock 三面板的文件条目代码层统一:`<FileListRow>`(渲染统一) + `buildFileEntryMenu(FileEntryContext)`(菜单统一,能力驱动)。面板只填能力(primary / openFile / copyRelative / copyAbsolute / reveal / openExternal / close),菜单形态/顺序/文案自动统一,**新增面板零拼装**。路径解析保持各面板特色(file-tree rootId 抽象 / git repoRoot 在 main / file-panel 绝对路径),不强制统一实现。
- **diff 双层语法高亮。** `DiffViewer` 用 highlight.js 做双层高亮:(1) 外层 diff 行色——新增行绿底、删除行红底、hunk header 蓝底粗体;(2) 内层代码语法高亮——从 `+++ b/foo.ts` 推断语言,对 `+const x = 1` 行去掉 `+` 后用 TypeScript 高亮。按需 import core + 11 高频语言(ts/js/py/json/bash/yaml/markdown/xml/c/cpp/cs,未命中回退 diff 语言)。token 色用主题变量映射,7 套主题自适应。
- **TextViewer 语法高亮 + 行号。** 打开代码文件现在有语法着色(此前 DiffViewer 有高亮、打开文件本身反而黑白)。hljs 栈抽到共享 `highlight.ts` 复用。行首行号槽(`user-select:none` 不参与复制)。
- **文件右键菜单扩充。** 三面板统一加「用默认应用打开」(.png→图片查看器 / .pdf→阅读器,新通道 `system:open-path` + `file-tree:open-path`)。Git 文件节点加「打开文件」(打开文件本身,非 diff;deleted 自动禁用) / 「复制绝对路径」(`git:resolve-path`)。Git 树**目录节点**右键此前无反应,现与 file-tree 目录对称(展开/收起 + 复制路径 + reveal + openExternal)。
- **Git 变更计数。** Git 面板顶部 chip 条:「3 修改 · 1 新增 · 2 未跟踪」,按 tone 分类着色。变更过多被截断时显示提示。
- **大文件保护。** main 端字节截断(2MB)之外,renderer 端加行数兜底(5万行):超阈值只渲染头部 + 截断提示。
- **设置项。** 「高级」分类新增「启用 Git 面板」开关(默认开)与「Git 二进制路径」(空 = PATH 查找),即改即生效。

### 重构

- **共享 hljs 模块。** DiffViewer 的 hljs 栈抽到 `highlight.ts`,TextViewer 复用,消除重复。
- **统一搜索 hook。** `useDomTextHighlight` 取代 useContentSearch(行级) + useMarkdownSearch(DOM)两套实现。TreeWalker 遍历渲染后 DOM 文本节点,`skipSelector` 跳过行号槽/diff 符号等非内容文本。

### 安全

- `GitService` 与 `FileTreeService` 同构:每次请求校验 `ownerWindowId === requesterId` + SSH 拒绝 + realpath + repoRoot 包含校验;`runGit` spawn 限 5s 超时 + 8MB stdout 上限防恶意大输出。`cmd:git:get-status` 不回传 `repoRoot` 绝对路径给 renderer。
- 「在 Explorer 中显示」对 file-tree 条目走专用 `cmd:file-tree:reveal-path` IPC,main 端做与 `open-file` 同一套根包含校验后调 `shell.showItemInFolder`,renderer 始终拿不到受限根外的绝对路径。

### 设计哲学

- 维持「终端管理器」边界:Git 面板只取 JetBrains 同类的**浏览**能力,明确不取**管理**能力,避免滑向 Git GUI(§13.2 / ADR-017)。
- 维持 ADR-016 不变:`LayoutNode` 仍由 main 端产品规则维护,renderer 无修改布局树的 IPC;只是规则从静态模板变为按 session 能力(cwd 是否在仓库)动态生成。

## [0.2.6] — 2026-07-12

### 新增

- **收藏项目右键安装 Marina Skill。** 本地收藏路径右键菜单新增“安装 Marina Skill…”，弹窗可同时选择 Pi、Claude Code、Codex；将内置 `show-in-marina` skill 分别复制到 `.pi/skills/`、`.claude/skills/`、`.agents/skills/`。同名 skill 已存在时先列出全部冲突，必须显式确认才覆盖。
- **内置 `show-in-marina` skill。** 安装后的 agent 可使用 `MARINA_SERVICE` 打开文件展示面板，并优先将临时报告写入每 terminal 的 `MARINA_WORKSPACE`。

### 安全与兼容

- 安装器只复制 Marina 随包携带的受控 skill，不执行或安装任意用户提供的目录；覆盖范围严格限制为项目内同名 skill 目录。
- 远程 backend 窗口将安装请求路由给 daemon，在远程项目上执行；SSH 路径不显示该菜单，避免把远端路径误当作本地文件系统。

## [0.2.5] — 2026-07-12

### 新增

- **终端专属文件面板布局。** 文件展示面板的宽度与折叠状态进入 session 临时 UI 布局；切换终端、跨窗口接管同一 session 后均会恢复，session 销毁或应用重启后自然失效。拖动仅在鼠标松开时同步最终宽度，避免高频 IPC 广播。
- **每终端受管临时展示工作区。** 每次新建 session 都会获得 `MARINA_WORKSPACE`，内部程序可在其中生成文档，再沿用 `MARINA_SERVICE /open-file` 展示给用户。工作区位于 Marina 数据目录的专用受管根内，关闭终端后默认保留 7 天；设置可调 0–365 天，0 为立即删除。启动会回收过期目录，PTY 启动失败会立即撤销未交付的目录。

### 安全与维护

- 工作区 manifest 仅接受 UUID session id，删除操作限定在受管根目录内；损坏记录不会把回收路径导向用户文件。
- 新增 `SessionWorkspaceManager` 单测，覆盖创建、延期回收、崩溃恢复、spawn 前撤销边界与路径安全；SessionManager 增加 UI 布局和环境变量覆盖保护测试。

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
