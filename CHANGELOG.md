# Marina Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/),版本号遵循 [SemVer](https://semver.org/)。

## [Unreleased]

> 开发期间(未分发)的改动记入此段。版本号按附录 E 纪律 1 攒批,不在每个小改时 bump;
> 等攒够一批、产开发构建(附录 F)或正式发布时，把本段折成一个版本号(并加日期)。

## [0.3.3-dev.9] — 2026-08-23

> dev.8 出包后积累的两项：文档图片可交互 + show-in-marina skill 能力参考随包分发。

### Added

- **文档图片可交互(点开/右键复制/在资源管理器中显示)。** Markdown 正文内联图
  (MdImage)、图片文件(ImageViewer)、gallery 代码块(GalleryViewer)三个看图 surface 统一获得：
  单击 → main resolve 后用系统图片查看器打开(图片被链接包裹时单击仍归链接导航)；
  右键 → 用系统图片查看器打开 / 复制图片 / 在 Explorer 中显示(生成器收敛在 imageActions.ts，
  能力驱动)。新通道 `cmd:gallery:reveal-image` 与 `cmd:system:clipboard-write-image`(复制的就是
  看到的那一帧;GIF 只保留首帧)。命令面板输出无 fileContext，图片保持纯静态。

### Changed

- **show-in-marina skill 附带 Markdown 面板能力参考文档。** 随包分发的
  `src/skills/show-in-marina/` 新增 `MARKDOWN-CAPABILITIES.md`(面板渲染 Markdown 的完整能力清单：
  本地文件/网页/锚点链接、可运行代码块、gallery、本地图片、目录导航、硬性约束如 raw HTML 禁用)，
  并在 SKILL.md 顶部加指向它的摘要——AI 安装该 skill 后写文档时能按标准格式产出可交互文档，
  而不是只知道链接和代码块两条。仓库本地 `.pi/skills` 开发副本不受影响。

## [0.3.3-dev.8] — 2026-08-21

> 远程断网占用终端问题修复:补实现规格已定义的 WS 心跳 + 右键显式接管兜底。
> 心跳跑在 daemon 侧,远程机器需部署本构建才生效;客户端升级只为获得「占用此终端」菜单。

### Fixed

- **远程静默断线不再无限期占用终端所有权。** 断网(拔线/WG 掉线/NAT 超时)时 daemon 收不到
  FIN/RST,close 事件不触发 → 重连宽限期永不启动 → 僵尸 clientId 永久持有 session owner;
  网络恢复后重开的窗口拿新 clientId,claim 全部命中 `SessionAlreadyOwned`,表现为「终端被
  之前的窗口占用」。ipc-protocol §2.6 规定的 ping/pong 心跳(30s,3 次未响应判死)此前只有
  规格没有实现,现已补上:检出后走既有断开 → 宽限(10s)→ release 流程,最坏 ~2 分钟;
  客户端零改动(浏览器/ws 库协议层自动回 pong)。

### Added

- **右键「占用此终端」显式接管所有权**(v0.3.3 用户裁决,软件定义书 §8.4 增补显式占用例外)。
  session 被其他窗口/client 持有时,右键 Tab 或侧栏 session,菜单首位出现「占用此终端」,
  直接强占 owner(新命令 `cmd:session:takeover`,payload/response 与 claim 同形)。旧持有方
  UI 收广播自动转「其他窗口持有」;接管者此前持有的其他 session 按单焦点规则自动释放。
  既覆盖心跳检出前(最坏 ~2 分钟)的手动兜底,也覆盖多窗口间明确想抢回控制权的场景。
  默认点击行为不变:仍是聚焦持有方、不抢。

## [0.3.3-dev.7] — 2026-08-12

> 修复 pi 压缩上下文时侧边栏误显示闲置(dev.6 是诊断构建,合并升格)。

### 修复

- **pi 压缩上下文期间侧边栏不再误显示闲置。** 根因:pi-marina-bridge 只监听 `agent_start`/`agent_settled`,漏了 `session_before_compact`/`session_compact`。threshold 压缩(上下文累积超阈)常发生在 `agent_settled` 之后 —— 压缩全程 bridge 不发任何事件 → Marina 停在 settled(idle),与用户体感「还在工作」矛盾。bridge 现监听 `session_before_compact` → 发 `agent_working`(压缩=工作);`session_compact` → `willRetry=false` 发 `agent_settled`(压缩完无后续),`willRetry=true`(overflow retry)保持 working 等随后的 `agent_start`。

## [0.3.3-dev.5] — 2026-08-11

> 0.3.3 系列第 5 个 dev 构建。汇总 `0.3.3-dev.3` 之后的远程命令、终端链接、Git 面板、pi 集成与架构稳定性修复,供本地/内测验证。(dev.4 号未实际构建,合并升格为 dev.5)

### Added

- **命令面板支持远程 SSH session 的 sudo 执行**(反转 ADR-028 D7):SSH session 的命令现经
  `ssh <profile> '<cmd>'` 一次性 exec 在远程跑(stdout/stderr 流式回捕,复用 CodeBlockRunner)。
  `--sudo` / 🛡 toggle 让命令以 `sudo -S -p ''` 跑,sudo 密码由 main 内存仓库(sudo-password-store)
  按 SSH profile 隔离托管,经 stdin 喂入——**绝不落盘 / 进日志 / 进 env / 进 event payload**。
  CLI `marina run --sudo "<cmd>"`;AI 推送时缺密码则命令进入 `awaiting-sudo-password` 态,面板内联
  弹 masked 输入,录入后重跑(每服务器只发生一次)。详见 `docs/方案-命令面板远程sudo-20260807.md`。

### Changed

- **主进程边界收敛**:session workspace / pi / 生命周期职责拆入 coordinator，本地 HTTP API 收敛到
  `LocalHttpGateway`，IPC 新增 `CommandContractMap` 穷尽路由约束；保持现有产品行为不变，同时降低
  退出、远程路由和后续协议演进的回归面。

### Fixed

- **Git 面板动态出现/消失**:同一 cwd 中途执行 `git init` 或移除 `.git` 后，下一次 shell prompt
  会重评估仓库能力并更新 Git tab；异步结果加代次与生命周期保护，避免慢结果覆盖新状态或修改
  已退出 / 已销毁 session。
- **终端文件链接定位**:修正 CJK 宽字符、`@` 双候选和 `~` home 展开场景下的文件链接识别与定位。
- **Git diff 预览来源保持**:修复打开 diff 后来源身份丢失，确保同名文件与刷新路径仍指向正确变更。
- **文件树层级缩进统一**:目录与文件行统一使用共享树行缩进规则，避免 disclosure gutter 抵消层级。
- **pi settled 状态及时回落**:`agent_settled` 后立即切回 idle，不再等待字节流 idle 阈值。
- **pi resume 切回 workspace 后文件面板恢复(根治)**:此前 `/resume` 一个之前的 pi 对话后,该对话原打开的文件不恢复。根因(日志实证):pi resume 同一对话时 piSessionId 会变,Marina 内存映射 `piSessionId→workspaceId` 永远 miss → 每次新建空 workspace。改为把 workspace 绑定**存进 pi 对话本身**(`pi.appendEntry`,跨重启跟对话走):bridge 从对话 entry 读出 workspaceId 随 session_start 带上 → Marina 切回原 workspace + 重建面板恢复快照;新建 workspace 后返回 id 交回 bridge 存 entry。删掉了旧的内存映射,不依赖易变的 piSessionId。

## [0.3.3-dev.3] — 2026-08-08

> 0.3.3 系列第 3 个 dev 构建。汇总 `0.3.3-dev.2` 之后的 pi 集成打磨与架构复核修复,供本地/内测验证。

### Added

- **退出 quiesce 状态机**:退出流程补显式状态机(running→quiescing→flushing→stopped),quiescing 后本地 IPC / WebSocket / HTTP ingress 拒绝新工作(返回 `Quiescing` 错误 / HTTP 503,health 放行),before-quit 有序化为 enterQuiescing → shutdown → enterFlushing → flush(1s 预算) → enterStopped。避免 shutdown/flush 期间的新动作落在关闭之后。

### Changed

- **pi 集成设置从「外观」移到「AI」分类**:pi 集成(workspace 绑定 / 指示灯 / 安装 package)与视觉呈现无关,此前误放在外观分类。移到 AI 分类,安装反馈改用 toast。
- **workspace 命令路由改 backend-data(ADR-029)**:七个 `WORKSPACE_*` 命令此前误归 local-control,远程窗口的 workspace 读写静默脱节。改为随 session 归 backend(依据软件定义书 14.9.6「数据归 daemon」),ADR-024 的 local-control 声明作废(持久化机制不变)。命令路由补穷尽校验(未知 channel fail-closed),新命令漏分类不再静默走远程。
- **抽取 app-lifecycle 模块**:`isQuitting` 退出标志原是 index.ts 模块级状态,ipc.ts/tray.ts 反向 import 形成两个静态循环 import。拆出 `src/main/app-lifecycle.ts` 作为退出状态单一事实源,消除循环依赖,ipc.test.ts 移除专用 mock。

### Fixed

- **pi 工作期终端状态打架 + 「已查看」语义精准化(ADR-028)**:(1) pi 思考/读文件期间终端无字节流,旧字节流 idle 检测误判 session idle(黄灯闪烁)还白烧 BETA-006 LLM——新增 `piWorking` 锁,agent_working 时抑制 idle 计时器、稳定 active,settled 后解锁交还字节流检测。(2) 旧逻辑把「切换 terminal」当成唯一「已查看」清除条件——新增「正在看」判定(owner 窗口可见+选中该 session),settled 时若正被看则不标警告色;窗口 focus/从最小化恢复时清除未看标记。
- **子 agent 事件不再污染主终端(ADR-028)**:pi 调用 subagent 后终端名被改成 `subagent-worker-xxx` ——根因是 subagent 起独立子 session 触发的事件被当成主对话处理。新增「主 piSessionId 锁定」guard,每个 terminal 同一时刻只绑定一个主对话,不同 piSessionId 的子 agent 事件全部忽略;合法主切换(/new /resume /fork /重启)前 pi 必先发 session_shutdown 清空主绑定。
- **file-panel/gallery 命令加 owner 校验**:9 个文件面板/图片 handler 此前无 owner 校验,非 owner 窗口能读/改别的窗口的文件面板。新增 `requireFilePanelOwner`(本地 IPC 与 WS 都接入),错误带 `SessionNotFound`/`NotOwner` code;FilePanel mount 前 waitForClaim 消除乐观接管期命中 NotOwner 的 race。
- **session 销毁时回收 panel UI 缓存**:`clearPanelUiState` 文档声称 session 销毁时调用,但生产代码从未接线,已销毁 session 的 UI 缓存(展开目录/选中态/滚动位置)滞留内存随 session 数无界增长。在 SESSION_DESTROYED bridge 补上调用。
- **统一 frameless 窗口错误态外壳**:frame:false 窗口里「可见状态必须渲染 WindowChrome 才有标题栏」只靠各分支自觉,协议版本不匹配分支漏画标题栏;本机外观死耦合在连接成功路径,错误态拿不到主题。新增 `LocalAppearanceProvider`(顶层拉本机外观,与连接状态解耦)与 `FramelessShell`(结构上保证可见状态必有标题栏+本机主题),4 条握手/错误分支统一改走它。
- **新窗口默认选中「当前电脑」**:segment 此前持久化到 localStorage 且跨窗口共享,任意窗口切到「远程」后每个新窗口都默认选中远程段。移除持久化,每个新窗口独立从「本机」起步。
- **命令面板刷新时保留输出**:刷新期间保留上次完成结果直到重跑结束,恢复命令输出里的代码块文本选中,刷新进度指示可访问。

## [0.3.3-dev.2] — 2026-08-07

> 0.3.3 系列第 2 个 dev 构建。汇总 `0.3.3-dev.1` 之后的设置、侧栏分组与命令面板修复，供本地/内测验证。

### Added

- **设置页「允许远程连接」新增“启动时自动开启”开关**:勾选后 Marina 启动时自动启动远程服务端(绑定已有 `remoteDaemon.autoStart` 设置,此前仅能手动点“开启”;只影响下次启动)。

### Fixed

- **侧栏收藏分组按 PathKind 隔离**：每个分组实例只属于 local 或 ssh；远程段不再显示本机空分组壳。旧混合组自动拆分，分组拖拽继续提交全量布局，隐藏 kind 数据不会丢失。
- **命令面板复用“已打开”的 Markdown 正文模块**：主题、GFM、外链、代码块执行与正文搜索改为同一实现；命令输出不伪造文件路径，本地链接、图片与 gallery 仍仅对真实文件启用。

## [0.3.3-dev.1] — 2026-08-07

> 0.3.3 系列首个 dev 构建(预发布)。汇总 `0.3.3-preview.2`(2026-08-05)之后的已提交积累,供本地/内测验证。正式发版时合并升格为 `0.3.3`。

### Added

- **文件树按需轮询**:文件树面板改走 `BackgroundWorkScheduler` 的 demand 感知(HOT/WARM/NONE),切走不刷新、切回立拉,降低后台开销。
- **右键菜单子菜单分层**:子菜单通过 `createPortal` 分层渲染,避免被父容器裁剪。
- **Pi 集成(ADR-028)**:pi 对话绑定 workspace、终端活动状态精准化;新增 `pi-marina-bridge` 哑转发器 extension;命令面板(`marina run`)使用文档补齐。
- **文件面板中键自动滚动**:中键改为浏览器风格自动滚动,替换原 hand-pan。

### Changed

- 侧栏:remote 窗口默认到「本机」段;"SSH" 改名为 "Remote"。

### Fixed

- 构建:恢复 preview2 的 release gates 与 `switch:*` npm 脚本(内部)。

## [0.3.3-preview.2] — 2026-08-05

> 第二个 0.3.3 预览构建（0.3.3-preview 的后续开发构建）。相对 `0.3.3-preview`(2026-08-04)
> 新增:侧栏拖拽 v3、收藏分组递归嵌套与重设计、远程 backend 窗口修复,以及
> `show-in-marina` skill 的 Linux/macOS 原生客户端(修复「装出 Windows 版」缺陷)。

### 修复

- **`show-in-marina` skill 在 Linux/macOS 上不再装出 Windows 版。**
  此前内置 skill 只带 Windows 启动器(`marina.ps1` 靠 PowerShell、`marina.cmd`
  靠 cmd.exe、无扩展名的 `marina` bash 包装器显式搜 `powershell.exe` 找不到就
  `exit 127`),Linux 上 agent 跟着 `SKILL.md` 走会彻底失效。后端 `file-panel-service`
  本是平台无关的 HTTP+Bearer 服务,缺的只是一个原生客户端。新增 `marina.sh`
  (bash+curl,零额外运行时——无 jq/python/node,与 `marina.ps1` 头注释「不引入
  额外运行时依赖」同款哲学),实现 ping/workspace/show/run/close/list/screenshot
  全部子命令,退出码与 ps1 严格对齐。无扩展名的 `marina` 改成平台调度器:检测到
  `powershell.exe` 走 ps1(Windows 行为 100% 不变),否则走 `marina.sh`。同时修了
  `marina` 的 git 可执行位(此前 `100644`,Linux 上 `./marina` 会 Permission denied)。
  详见 `docs/方案-skill-Linux支持-20260805.md`(Option D)。10.9.0.1(Ubuntu 26.04)
  端到端 25/25 通过。

- **侧栏拖拽改为不改变高度的单提示线模型（v3，用户裁决）。**
  此前拖动时会在每个间隙插入等高 placeholder，整列高度随拖动涨缩；且 DragOverlay
  跟随延迟 + placeholder 推挤邻居导致行 rect 漂移，出现“向下拖动，落点反而向上”
  的非单调现象。现在：拖动期间**不渲染任何占位 placeholder**，列表整体高度恒定；
  只有一条 `position:absolute` 的提示线，其垂直位置由指针 y 相对各子行中点单调
  推导，水平缩进/宽度由落点容器深度决定。更关键的是落点解析改为**纯坐标驱动**：
  拖动时不再依赖 dnd-kit 的 over/碰撞（它们用的是 DragOverlay 跟随矩形，有偏移与
  延迟），而是用真实 `pointermove` 的 clientX/Y 在 DOM 里命中行——**y 选在哪一行的
  上半/下半，x 决定是否嵌入指针所在的组**（拖路径到组标题、x 靠右=进入该组；
  x 靠左=作为同级）。提示线只画一条线、不带任何文字，缩进即层级，所见即所得。
  group/path/session 三类统一适用。已用真实 Electron + CDP 指针验证：向下拖索引
  单调、列表高度零变化、x 右移缩进加深并真正嵌入目标组、释放后 bookmarks.json
  正确更新。
- **修复「拖组想同级却嵌入」的交互缺陷（bug #2）。** 此前拖一个组想放到另一个
  组的**同级位置**时，最自然的指针落点是那个组展开后的子组列表空白区——但那块
  空白在视觉和数据上都属于该组内部，旧逻辑一律当「嵌入该组」，用户几乎无法表达
  「同级」。现修复为：指针落在某组的子组列表空白区时，**x 靠左（未越过子内容缩进列）
  = 同级后置**（放在该组之后、其下一个兄弟之前），**x 靠右 = 嵌入该组末尾**（保留原语义）。
  与「y 选行、x 定层」模型一致。已用 CDP 指针验证：同级缩进更浅、释放后组留在原父级、
  不误入被拖组；同时路径→组嵌入未回归。
- **拖动浮层优化 + 分组图标换。** 拖动浮层（DragOverlay）改为半透明（opacity 0.6），
  不再遮挡背景提示线/目标行；显示文字优先用名称，无名称时取路径 basename 而非完整路径。
  收藏分组图标从文件夹改为 `Tag`（价签）——组内条目才是文件夹，组本身是「归类」，
  用价签与文件夹正交、不再语义撞车。

### 新增

- **收藏分组可递归嵌套（子组）。**
  用户裁决后分组从单级升级为树：任意分组可建子组，组内路径与子组并存。
  group/path/session 拖拽使用真实容器的 `0..N` insertion slot：拖动时命中插槽会
  膨胀成等高 placeholder，邻居在释放前实时让位；最终层级和顺序只来自
  `targetContainerId + targetIndex`，不再根据起始深度、横向像素或祖先链猜测。
  （v3 起该“等高 placeholder”模型已被“不改变高度的单提示线”取代，见上。本条
  保留作为最初实现的说明，真实行为以上述 v3 修复为准。）
  可精确把深层子组提升一级或直接提升到根级；禁止拖入自身或后代（循环守卫）。
  解散分组时路径与子组提升到上级，绝不删数据。磁盘 schema 为 bookmarks.json
  v3（v1/v2 启动期自动迁移）。

- **侧栏分组/路径/终端菜单按用户任务重设计。**
  删除分组和收藏分类重复的 `⋯`，对象管理只保留右键。分组菜单首项可通过系统/
  backend 目录选择器“添加文件夹到此组”，`BOOKMARK_ADD {path,groupId}` 原子地
  直接归组，不经过未分组中间态；另有新建子组、重命名、解散分组，组头仍保留
  F2/Delete。路径菜单分「打开/定位、复制、组织、启动方式、项目工具」区；终端
  菜单提供主任务和“复制信息”子菜单。远程 backend / SSH 上下文不再显示会在
  用户看不到的电脑上执行的“在文件管理器中显示”。

### 修复

- **远程 backend 窗口点「+」加文件夹报错。**
  `BOOKMARK_PICK_FOLDER` 走 WS 到 daemon 后没有 Electron `webContents`，
  `getOwnerBrowserWindow` 抛 TypeError。新增 `RemoteDialogUnavailable` 防线，
  远程窗口改用 renderer 自绘、backend-data 驱动的点击式目录选择器（Home / 上级 /
  子目录，全程无路径输入，符合原则 2）。

- **收藏子组拖动改为所见即所得的真实插槽，local/SSH 混合收藏不再被后端拒绝。**
  分组块此前先后用“上半同级/下半嵌套”和“横移 24px 改一级”猜层级，三层以上
  无法直接选择父容器。现在 root 与每个 `group.subgroups` 都注册独立容器，边界
  重合时展开为多个有物理高度的插槽；组标题大目标统一表示“移入此组末尾”。
  path/session 同样在目标列表实时腾出占位。拖动布局始终基于 backend 全量收藏，
  不再因遗漏隐藏 segment pathId 被 `InvalidOrderList` 拒绝。

- **移除收藏不再暗中清掉最近记录。**
  菜单项只做它说的事；无 session 的路径按状态机自动进入「最近」。

- **侧栏路径 badge 只统计未退出终端，分类 tooltip 文案修正。**
  badge 回答「现在有几个终端活着」；「展开/折叠」tooltip 带上分类名。

### 变更

- **顶部路径切换改名「当前电脑 / SSH」。**
  远程 backend 窗口的「当前电脑」显示 daemon 名（如 FEX）；「Marina 电脑」仍为
  独立小节。

- **SSH 段「+」可就地创建并连接，不再跳设置。**
  0/1/N 个 profile 都打开同一个连接面板；已有连接一击选择，“新建 SSH 连接”
  始终可见。新表单把主机、用户名、认证方式放在首屏，端口/默认目录/ProxyJump
  收进更多选项；提交后保存 profile 并立即创建 session，错误留在表单内。

- **OS 文件夹拖入只在「客户端本机 backend + 当前电脑段」可用。**
  SSH 段 / 远程窗口不再显示拖入反馈，误拖给解释 toast。

## [0.3.3-preview] — 2026-08-04

### 修复

- **Ubuntu 26.04 的 `.deb` 可正确解析 GTK / AT-SPI 依赖。**
  Ubuntu 26.04 与 Debian 新版已把 `libgtk-3-0`、`libatspi2.0-0` 迁到 t64
  包名；旧配置会令 apt 报“没有安装候选”。现在 Debian control 使用
  `t64 | legacy` alternatives，同一 amd64 包兼容新旧 Ubuntu。

- **Windows 包严格剔除非目标 node-pty 二进制。**
  `files` 负 glob 与 `asarUnpack` 合用时仍会把 macOS / ARM64 prebuild 带入 staging
  （ISO-2）。新增 `afterPack` 钩子，只清理本次 `appOutDir`，按目标平台/架构保留
  node-pty；绝不修改开发机 `node_modules`。`0.3.3-preview` 首次严格校验由 2 个
  Mach-O 错误转为 3/3 Windows `.node` 匹配、0 错误、0 警告。

- **新建收藏分组入口收进侧栏右键菜单。**
  移除收藏列表底部突兀的虚线“新建分组”按钮；现在右键根级分类（收藏 / 临时 /
  最近）均可新建，右键已有分组则统一显示新建、重命名、删除。仍使用项目自绘
  Modal 输入名称，保留分组行尾重命名/删除快捷按钮。真实 Electron 鼠标验证三类
  根菜单均正常；并完成“右键收藏 → 新建 → 右键新组 → 删除”的完整闭环。

- **收藏路径拖拽释放后真正重排并支持移入空组。**
  旧逻辑在同容器向下拖时先删除源项、再按已经左移的目标 index 插入，导致相邻项
  释放后顺序原样；同时 `SortableContext` 不会自动注册空容器，空组和折叠组根本无法
  成为落点。现在排序由纯函数按 dnd-kit `arrayMove` 语义生成不可变布局，未分组区和
  分组整块均显式注册 droppable，并显示落点描边。真实 Electron 指针验证“同组交换并
  恢复”和“未分组 → 空组 → 未分组”均通过，原布局完整恢复；新增 7 个布局回归测试。

- **“已打开”中的 Diff 页签可一眼区分。**
  Diff 继续使用源文件类型 icon，并在右下角叠加 8px 的 “D” 角标；普通文本、Markdown
  等页签不显示角标。角标 icon 外层固定 14px，不会重新引入长文件名压扁图标的问题。
  真实 renderer 验证当前 Diff 页签显示 D，三个普通页签无角标，图标保持 14×14px。

- **“已打开”切文件不再先闪 dock 主题色。**
  旧 `file-panel-body` 完全透明，activePath 已切换但 viewer 等待 IPC 内容的约 100ms
  内会露出 dock 背景；GitHub Light Markdown 因而先闪深紫/深灰再变白。现在 active
  file 确定后即用隐藏取色 probe 复用目标 Markdown class（含自定义 CSS），在首帧
  paint 前给 body 铺最终背景；普通 Text/Diff/Image 则预铺主内容背景。真实 Electron
  4ms 采样验证：Text 切换始终 `rgb(13,17,23)`，Markdown tab 与 README 内本地链接
  打开的 100–250ms loading 期始终为白色，均未出现中间色。

- **侧栏路径与终端层级不再因状态变化跳缩进。**
  路径无终端时不再 `display:none` 掉展开槽，而是保留固定 12px 槽并隐藏箭头；有无
  终端的路径名 x 坐标由约 18px 差异归零。session 按 ADR-019 的一级缩进渲染模板
  icon（内置模板用统一 Lucide，自定义模板保留自定义 icon），内容从 x≈22 开始、名称
  从 x≈40 开始。收藏分组现在只缩进 path/session 内容，不再右移整行盒，因此
  active/idle/exited 色条在分组内外都紧贴侧栏 x=0；active 满底时 icon 与名称同步
  反色，不与层级槽争空间。真实 renderer 几何测量覆盖无/有终端路径、分组与 idle/active。

- **workspace 切回不再因残缺 `OpenedFile` 白屏。**
  main 已先恢复带 `name/size/mtimeMs` 的完整文件列表，但 renderer 随后的快照恢复又把
  `{path, kind}` 强转为 `OpenedFile[]` 覆盖它，最终 `fileIconFor(undefined)` 抛错、整窗
  白屏。现在文件列表/active 只认 main 的 `file-panel/updated`，renderer 快照仅补 scroll
  和 code-run 缓存。真实 CLI 强测通过：bind → new 清空 → bind 恢复；退出重启后同名
  bind 仍恢复 README，renderer console 0 错误。

- **Markdown 页内锚点真正滚动。**
  `react-markdown` 默认 heading 没有 id，旧 `#anchor` 分支放行浏览器默认行为却无目标，
  scrollTop 完全不变。现在按 Unicode-safe GitHub 风格 slug 在当前 Markdown 容器内定位
  h1–h6 并 `scrollIntoView`；实测 smoke 文档从 scrollTop 301.9 回到 8.1。同步修正
  v0.3.3 smoke fixture 的仓库相对链接层级（`docs/test-fixtures` 到根应为 `../../`）。

- **长文件名只省略文本，不再压扁 icon。**
  `FileListRow` 的 Lucide SVG 原本继承 flex item 默认 `flex-shrink: 1`；约 196 字符的
  文件名会把 14px icon 横向压到 4.6px，视觉上像 icon 和文字一起缩小。现在 list/tab
  的 icon、chevron、关闭按钮固定尺寸，只有 label 槽承担负空间并在末尾 ellipsis。
  真实 renderer computed layout 验证：短/长文件 icon 均为 14×14px、文字均 12px，
  长文本保持 `scrollWidth > clientWidth + text-overflow: ellipsis`。

- **大结果集交互不再冻结整个窗口。**
  真实 Electron/CDP Long Task 基准覆盖四条高风险路径：文件树展开 500 项
  (旧 max rAF gap 120–175ms)、文件树搜索命中 500 项(180ms)、Git 未跟踪组展开
  500 项(145ms)、只读 50k 行文本/diff(分别冻结 4.7s/7.0s)。文件树/Git 的大列表
  更新改为 React transition，面板搜索 query 改用 deferred value；文件树搜索仍扫描
  5000 项但最多挂载 200 个匹配并提示缩小查询。TextViewer 限 1000 行、DiffViewer
  限 500 行并修复“先高亮完整 50k 行再 slice”的隐藏全量工作，视口外行用
  `content-visibility` 跳过 layout/paint。修复后四条基准均无 >100ms Long Task，窗口
  拖动、终端输入与动画不会再被一次大列表 commit 长时间阻塞。

- **Markdown 表格内链接换行优化(方案 B)。**
  MarkdownViewer 表格窄列里的链接(文字 + URL)原本只在空格处断行,文字留本行、
  URL 挤下一行,视觉上像两条链接、点击区也分裂。现对 `td a` 设
  `overflow-wrap: anywhere`,链接可在任意字符处断行、不撑宽表格(靠表格已有的
  `overflow-x: auto` 横向滚动兜底)。代价是长 URL 会从中间断,但整条 `<a>` 仍是
  一个节点,点哪半都生效。覆盖三种 markdown 风格(auto / github / custom)。

- **终端 URL 链接点击打不开浏览器(T13 / v0.3.3)。**
  `WebLinksAddon` 默认 handler 走无参 `window.open()`,被 window-manager 的
  `setWindowOpenHandler` deny 成 null(deny 前正则拿到空 url → `shell.openExternal`
  永不执行),故点 `https://`/`mailto:` 零反应。改为给 `WebLinksAddon` 传自定义
  handler 直接走 IPC `SYSTEM_OPEN_EXTERNAL`(main 侧已白名单 http/https/mailto),
  绕开脆弱的 window.open 链路。`setWindowOpenHandler` 保留作 OSC 8 / 其他
  window.open 的安全兼底(拒 file:// / javascript: 等)。

### 新增

- **终端输出相对路径 → 可点链接(Feature F / v0.3.3)。** 终端里带斜杠的相对路径
  (`src/x.ts:42`)现在变成可点链接:鼠标移上去出现下划线(xterm 内置),点击在右 dock
  「已打开」面板只读打开该文件(相对 session.currentCwd 解析,复用 cmd:file-panel:open);
  带 `:行号` 的路径打开后自动滚动到该行(不做高亮)。两种触发:(A) 自动链接 — xterm
  自定义 link provider,STRICT 正则(要斜杠+扩展名,挡住属性访问 `.length`/`.map` 和裸
  文件名,降误识别);(B) 右键菜单「在面板打开」— 选中终端文本后右键,选区文本直接丢给
  main 解析(裸文件名也认,用户主动选中=意图明确)。URL 由现有 WebLinksAddon 优先接管。
  SSH session 不启用(远程本地图不可达,套 SshUnsupported 模式)。文件不存在 → toast 提示,
  不预探盘(hover 不发 IPC)。行号跳转走 renderer 端 pending-line-jump 缓存(不动 protocol/main)。
  设计依据 ADR-027(T14 grilling 定稿)。TextViewer 新增 scrollToLine 能力(双 rAF 排在
  useFileViewerScroll 的 restore 抑制之后)。

- **Gallery 图片表代码块(Feature A / v0.3.3)。** Markdown 文档里 `` ` ``gallery ` ` `` ` 代码块
  (每行一个图片链接:本地路径或 http(s) URL)渲染成幻灯片:一次一张、左右切换、缩略图条
  快速跳转、指示器 `N/总数`、键盘 ←/→(gallery 聚焦时拦截)。点图用系统图片查看器打开。
  交互参数按 T05 HITL 原型裁决(ADR-026):主图自适应流式(按比例,上限 480px)、
  缩略图条 56px 单行横滚、网络图失败占位 + 重试 + ⚠计数(超时 10s 不自动重试)、
  懒加载 ±1(窗口外骨架)。网络图在 daemon 下载到 workspace 的 `__marina_gallery__/`
  缓存(绕开 prod CSP `img-src` 限制),随 workspace 回收;缓存命中不重复下载。
  SSH 远程 session 的本地图不可达走 main 自然降级(失败占位),网络图正常。

- **workspace 绑定/复用 + 文件面板状态持久化(Feature D / v0.3.3)。**
  v0.3.3 最重的 feature(ADR-024)。workspaceId 与 sessionId 解耦,目录 =
  `<root>/<workspaceId>/`,session 运行中可领养别的 workspaceId。CLI `marina workspace`
  系列改查 main(workspaceId 解耦后 `$env:MARINA_WORKSPACE` 是 spawn 时陈旧值,
  切换后退化为初始值,不可靠;ADR §2.1):`workspace`(查当前路径)、`workspace list`
  (列命名 workspace)、`workspace bind --name X [--new]`(upsert:新→命名+pin;存在→切+
  恢复快照)、`workspace new`(切新空临时)、`workspace unpin`(剥 name+pinned 退回
  可回收;无 remove 防误删)。manifest schema v1→v2(加 name/createdAt/pinned/pathScope,
  自动迁移旧 sessionId 当 workspaceId),pinned 免回收,name pathScope 内唯一。文件面板
  状态快照(openedFiles/active/scroll/**代码块运行结果**)持久化到
  `<workspace>/__marina_state__/file-panel.json`,bind 切换后自动恢复(滚动 500ms
  debounce 落盘,不进逐字节热路径)。详见 ADR-024。

- **命令面板(Feature G / v0.3.3)。**
  第 4 个 dock 面板(ADR-027)。补足「终端被 AI coding agent 占着、没法瞄一眼命令输出」
  的需求:AI 用 `marina run "<任意命令字符串>"` 推送指令,Marina 复用 CodeBlockRunner
  (ADR-023)跑它(bash,在 session.currentCwd 下,不经 PTY),把输出渲染成 markdown
  进面板。多 tab(同 command 去重 upsert)+ per-指令 刷新策略(默认仅前台跑、少数
  后台轮询走 BackgroundWorkScheduler ADR-021)+ 手动重跑。输出里的 http(s)/mailto
  链接可点(走系统浏览器)。SSH session 拒绝(对称 Git/代码块)。设计上是通用面板
  (map/ticket 只是第一个用例),不内建 GitHub 耦合,避免「跨 session 上下文累积」红线。
  持久化(command-panel.json,套用 ADR-024 机制)接口已就绪,触发器待 Feature D 的
  renderer 恢复/flush 接线一起完成。

- **侧栏收藏分组 + 拖拽排序(Feature E.1+E.2 / v0.3.3)。**
  收藏路径告别平铺:加**一级分组**虚拟容器(GroupNode,path 身份不变),分组可折叠/重命名/
  删组(删组子路径归未分组,绝不删 path)。**@dnd-kit 拖拽**:收藏路径可组内排序 + 跨组移动
  (拖完发统一分层 BOOKMARK_REORDER {ungrouped, groups[{id,childOrder}]});各路径下终端
  可同 path 内拖序(决策 #15:服务端内存真值,不落盘,重启重置)。临时/最近不可分组/拖序
  (决策 #13)。分组折叠态走 L2 偏好 usePanelPreference(附录 G)。bookmarks.json schema
  v1→v2 自动迁移(幂等/原子/损坏回退;旧 path 归未分组)。新依赖 @dnd-kit/core +
  @dnd-kit/sortable(npm 核活跃度已验,2024-12 仍在维护)。详见 ADR-025。

- **远程截图(`marina screenshot`)—— agent 自测 enabler(T12 / v0.3.3)。**
  新增 `GET /screenshot?terminal=<id>` HTTP 路由(Bearer 鉴权,同其他路由)截该 session
  owner window 的屏返 `image/png`;capture 回调注入式(`attachWindowCapture`,index.ts
  闭合 sessionManager→ownerWindowId→windowManager.getById→webContents.capturePage→toPNG),
  服务层不引 electron 保持可测。CLI `marina screenshot [PATH]`(`Invoke-WebRequest -OutFile`)
  默认落 `<workspace>/marina-screenshot-<时间戳>.png` 并打印路径 —— agent 截图后 `read` 即可
  自测 UI,消除人工截图依赖(T05/T06 类 HITL)。无 owner/窗口销毁/未注入分别返 400/503。

- **Markdown 文档里的本地文件链接 → 面板只读查看(Feature B / v0.3.3)。**
  MarkdownViewer 的链接按 scheme 分流(决策 #4):`http://`/`https://`/`mailto:`
  外链仍走系统浏览器;页内 `#锚点` 滚动;**其余一律当本地文件**,相对 md 文件
  所在目录解析后进文件面板**只读查看**(复用 FilePanelService 状态机:加 tab +
  切 active + watcher)。新增 `cmd:file-panel:open-path` 通道 + `openFileFromMarkdown`
  方法,与 `readImageAsset`(图片)同源安全模型:mdPath 成员校验 + main 端 resolve
  - stat。文件不存在/不是文件/源 md 不在面板 → toast 提示。链接约定写进
    `show-in-marina` SKILL(本地文件直接写路径→面板;网页写完整 `https://` URL→
    浏览器)。

- **Diff 视图「打开源文件」入口(Feature C / v0.3.3)。** DiffViewer 左上角新增
  工具栏,放 `file-text` 按钮;点击走 `cmd:git:open-file` 在文件面板**只读**打开
  diff 对应文件的工作区原文(非 diff)。路径从 diff 文本的 `+++ b/<path>` 解析
  (单文件 diff 适用;多文件 diff 因无法确定目标文件而禁用按钮);删除文件
  (`+++ /dev/null`)自动禁用按钮并 tooltip「文件已删除」。与 Git 面板右键「打开
  文件」复用同一通道。纯路径解析逻辑抽到 `src/shared/diff-path.ts`(单测覆盖
  normal/added/deleted/renamed/多文件/含空格路径/二进制等场景)。

- **侧栏 terminal 条目状态色条 + 缩进(Feature E.3 / v0.3.3,T06 视觉定稿)。**
  session 行的状态指示从 9px 圆点改为**左侧竛条「变宽覆盖整行」动画**。T06 HITL
  定稿(用户文字描述 + 原型确认,代替截图):idle = 左侧 3px 细竛条(info 色);
  active = 细条 `cubic-bezier(0.16,1,0.3,1)` 1s 变宽覆盖整个背景 + **文字同步反色**
  (bg-primary)+ 稳态 opacity 脉冲(2.6s,延迟 1s 等变宽完成)。active→idle 是
  idle→active 的逆变化(用 `transition` 双向,非 `@keyframes` 定格)。配色用
  `var(--color-info)`(跟主题变,rose-pine=青绿),不 color-mix 派生。exited 复用
  灰细条 + 现有 exit-code 图标 + 整行 dim(色条只管 idle/active 两态)。
  `prefers-reduced-motion` 关闭动画(active 直接铺满静止)。已知取舍:info 满底 +
  反色在 cutie(淡紫)对比度不足(~2.3:1)、github-dark 满屏高饱和蓝扎眼,用户
  看过原型矩阵后接受(换取强状态感知;替代的「洗涤 wash」方案通用可读但覆盖感弱
  被否)。详见 `docs/方案-E3色条动画-20260802.md`。
  session 行加一级缩进(`--tree-indent-unit`,附录 G 单一真相源)与父 path 行形成层级。
  exited check/X 图标在行内(竛条太窄),成功绿勾 / 失败红叉。

### 修复

- **修复运行 alt-screen TUI(Claude Code / Pi / vim 等)时终端滚动条偶发跳到
  最顶部的问题(SCROLL-2)。** 根因是 xterm 在 alternate/normal buffer 切换
  (`?1049h`/`?1049l`)时会 fire 一次 `onScroll`,而滚动位置记忆的 `onScroll`
  监听未区分 buffer 类型,把切换瞬间的 `ydisp` 当成用户滚动写进 store;下次
  replay 重建执行 `scrollToLine(topLine)` 时把视口拉到 scrollback 顶部。修复:
  `onScroll` 回调顶部加 `if (buf.type !== 'normal') return;` 守卫 —— alt buffer
  本就无 scrollback,滚动位置记忆只对 normal buffer 有意义。详见
  `docs/issues/scroll-2-alt-buffer-viewport-jump-to-top.md`。

## [0.3.2] — 2026-08-01

> 相对 0.3.1 的 MINOR 版本:落地性能诊断子系统、需求感知后台调度、Markdown 代码块
> 一键执行、终端视图 TerminalDeck 等新能力模块,并大幅改进切终端/文件预览体验。
> 本版本由 `0.3.2-dev.1` ~ `0.3.2-dev.10` 十个开发构建合并升格而来。

### 新增

- **性能飞行记录器(ADR-020)。** 每次运行自动在 `performance-reports/` 生成有界
  JSON + Markdown 报告:10 秒采样 main event-loop delay/utilization、CPU/RSS/heap、
  Electron 各进程、window/session/Git watcher gauges;250ms timer 统计 ≥100/250/1000ms
  stall;固定名称 operation heatmap 汇总 IPC、Git、session/PTY 生命周期。平时 5 分钟
  原子刷新,≥1 秒严重 stall 至多每 60 秒额外落盘;异常退出保留 `finalized:false` 现场,
  最多保留 30 次运行。自动报告不记录路径、命令、终端内容、IPC payload 或 stack trace
  (附录 H 隐私红线)。
- **按需 15 秒 V8 CPU Profile。** 设置 → 高级可显式捕获 main 进程 `.cpuprofile`;
  操作前提示函数名/本地源码路径隐私风险,服务端限制 5-30 秒、禁止并发采集且每 run
  最多保留 5 份,从不因 stall 自动启动。
- **性能报告入口。** 设置 → 高级显示本次采样/stall/RSS 摘要,并提供「立即刷新报告」
  「打开报告目录」。
- **PTY 吞吐与背压诊断(ADR-020 增补)。** 报告新增每采样窗口 bytes/s、chunks/s(从
  counter delta 推导,零热路径开销)、全程峰值速率与突发窗口计数、sessionOutput IPC
  发送耗时分布、8ms 合并窗口吸收字节峰值;stall 记录携带近窗口 PTY 速率,能区分 stall
  由流量突发/背压引起还是无关抖动。
- **独立报告分析工具** `scripts/analyze-performance-report.mjs`。传入报告 JSON 路径
  (或省略自动找最新)输出六维诊断(吞吐/背压/stall 相关性/瓶颈/内存/隐私自检),纯 Node
  内置模块零新依赖。
- **需求感知后台任务调度器(ADR-021)。** 新增 main 端 `BackgroundWorkScheduler`:
  昂贵周期任务统一 recursive timeout、全局并发预算(默认 1)、HOT/WARM/NONE demand、
  多窗口最高需求合并、pre-registration demand 与 generation 竞态防护;窗口关闭、远程
  断线、owner/Session 生命周期统一清理。
- **Markdown 代码块一键执行(ADR-023)。** Markdown 面板里 `bash`/`sh`/`powershell`/
  `pwsh`/`cmd` 等 fenced code block 带「复制」「运行」「停止」「清除」按钮。点击「运行」
  后 main/daemon 直接 `child_process.spawn` 对应 shell 跑整段代码,**不经 PTY / xterm**,
  因此当前终端无论是 Claude Code / Codex / vim 还是普通 shell 都不会被干扰。工作目录
  取自该终端的服务端 `currentCwd`,输出在代码块下方流式显示,退出后显示 exit code。
  本地与远程后端行为一致(preload 自动路由);SSH 终端因命令需在远程主机跑、本进程无法
  spawn 而明确拒绝。
  - 选中片段:代码块内选中文本后,鼠标附近浮出「运行选中」按钮(类似 VS Code
    lightbulb),只跑选中部分;选区须唯一归属一个代码块,横跨多个或拖出代码块时拒绝。
    按钮随文档滚动定位,钳在代码块边界内。
  - 运行状态改为组件外 L1 缓存:切终端不停止进程、不丢失输出,切回后按 sessionId +
    文档路径 + 源位置 + 代码摘要恢复运行状态/流式输出/退出码。缓存 128 条 / 单条 2MiB
    上限,只淘汰非 running 条目;窗口关闭/Session 销毁时收口。
  - shell 走应用自身 `detectShells` 的绝对路径(与 SessionManager 同源,不依赖 Electron
    main 的 PATH);cmd 输出 GBK/UTF-8 自动检测解码(中文 Windows 默认 GBK 输出会乱码,
    `chcp 65001` 对管道无效),PowerShell/pwsh 用命令前缀强制 UTF-8。代码块外壳/toolbar/
    输出区全透明,仅 border 分层,明暗主题自适应不再出现固定黑条。
- **内置 Nerd Font 兑底 + 自定义回退字体。** 应用内置 `Symbols Nerd Font Mono`(MIT)
  作为终端字体栈零配置兑底,解决 powerlevel10k / starship / lsd / eza 等 CLI 工具输出的
  Nerd Font 图标显方块问题。字体栈由 `buildTerminalFontStack()` 统一构建:主字体 → 用户
  自定义回退 → 内置 Nerd Font → 通用 monospace。「设置 → 外观」新增「回退字体」输入框,
  下方有实时图标预览 + 最终字体栈明文展示。

### 改进

- **pwsh 代码块在未装 PowerShell 7 的机器上回退到 Windows PowerShell 5.1。** pwsh 的
  shell 偏好序改为 `['pwsh', 'powershell']`,Windows 上 powershell.exe 必装,绝大多数代码
  块在 5.1 / 7 下行为一致。
- **show-in-marina 预制 skill 增强。** 僵尸 tab 检测(指向的文件被删后 tab 标 `!`/`(deleted)`
  并提示 `close --stale`);批量 close(`--all` / `--stale` / `--glob`);close 路径模糊匹配
  (只给文件名也能关);SKILL.md 新增「文档作为任务沟通界面」用法模式与「可运行代码块」
  指引。项目级安装快照与源同步。
- **远程连接启用 permessage-deflate(RFC 7692)。** PTY 字节流与 scrollback replay 都是
  高度可压缩文本,典型远程流量减 50–70%;client 端由 Chromium 自动协商,无需改动。

### 性能

- **切终端提速(REPLAY-1)。** `cmd:session:claim` 不再序列化/返回全量 scrollback
  (renderer 从不消费它:冷挂载走 get-scrollback,暖切换走 TerminalDeck 缓存 + view lease),
  改为 O(1) lastSeq —— 消除每次切换 40-60ms serialize + 0.6-2MB payload 传输。冷挂载
  scrollback 重放分片从 16KB + 每片 `setTimeout(0)` 改为 256KB + 时间预算 + MessageChannel
  让出(Chromium 对连续嵌套 timer 有 ~4ms clamp);实测(真实 Electron 31,5000 行)
  590KB/1.19MB/1.74MB 重放 214/375/551ms → 34/47/49ms,提速 6-11 倍。
- **终端视图改为持久 TerminalDeck,不再销毁/重建 xterm(ADR-022)。** A→B→A 复用同一个
  Terminal、DOM node、buffer、viewport 和 selection,最多缓存 10 个访问过的 xterm slot。
  main 新增每 Session 唯一只读 view lease:owner=null 时 parked 终端仍定向接收后台输出,
  但无 input/resize/文件/Git 权限;parked slot 释放 WebGL、active 再加载,避免 GL context
  累积。
- **Git 后台轮询按 repo 去重(ADR-021 方案 A)。** 此前每个 Git 仓库 session 各注册一个
  polling task,同一 repo 开 N 个终端就重复轮询 N 次 git status 并占满全局并发预算。现按
  repo 去重:一个 repo 只注册一个 task,run 时跑一次 git status 再 fan-out emit 给该 repo
  下所有 session;每个 session 作为该 task 的一个 scheduler consumer(demand 取各 session
  最高)。同 repo 的 GitPanel mount / HOT immediate / 后台 poll 共享同一个 repo 级 in-flight。
- **关键路径统一埋点。** IPC 注册中间件按固定 channel 统计 duration/error/in-flight;
  Git status/diff、poll skip、watcher/in-flight gauges 与 session/PTY counters 接入同一
  有界 registry。metric name 有 200 项硬上限,拒绝路径/动态高基数字符串。
- **Git 扫描按真实 UI 需求降频。** 当前聚焦窗口的当前 Git 面板为 HOT(立即刷新 + 完成后
  3 秒);当前 Session 显示其他面板、dock 折叠或窗口失焦为 WARM(60 秒);切换 Session、
  owner 释放、退出/离仓/零窗口为 NONE(完全停止)。所有自动 Git status 全局最多一个并发,
  同 session+cwd 的 mount 拉取/prefetch/HOT immediate 合并为一个子进程。
- **GPU 合成降级时自动回退 DOM renderer(PER-2)。** Chromium 在 GPU 进程崩溃/显卡设备
  变化后会给 renderer 加 `--disable-gpu-compositing`,但 xterm WebGL renderer 不感知降级,
  继续用 WebGL 画光标却交给 CPU 合成 —— 实测 GPU 进程持续烧 432–471% 单核。现 preload
  检测本 renderer 命令行,`auto` 模式下据此强制回退 DOM(GPU 进程降至 7-8%,↓ 60 倍);
  用户显式选 `webgl`/`dom` 不受影响。
- **飞行记录器不再低估 GPU 进程 CPU。** `aggregateElectronMetrics` 改用
  `cumulativeCPUUsage` 差分换算真实平均 CPU%(原单点 `percentCPUUsage` 对 GPU 进程可低估
  40-60 倍),首采样无基线时 fallback。

### 修复

- **切换终端偶发「闪一下又切回去」+ 文件/Git 面板报 NotOwner(根治)。** 根因是 claim-gate
  旧契约把 claim 失败也当成「等待结束」放行面板请求,于是失败的接管仍触发面板发注定
  NotOwner 的请求;同时各接管路径的失败回滚是无条件的,迟到的失败会覆盖用户后续已经成功
  的选择。`waitForClaim` 改为返回 `{ ok: boolean }`(失败不再静默放行),FileTreePanel /
  GitPanel / useGitPollingDemand 在 `outcome.ok === false` 时中止请求不发 IPC;MainPane /
  Sidebar 的 orphan 接管回滚加 generation 守卫(只在用户没再点别的终端时才回滚);
  useCloseSession 续看的 claim 登记提前到乐观选择时(消除「面板在 claim 登记前就请求」的
  空窗)。对应 ADR-005(一窗口一 owner)。
- **右侧文件预览按终端、文件分别记住真实滚动位置。** 新增 renderer L1 view state
  `fileViewerScroll`,以 `sessionId + OpenedFile.path + kind` 隔离 Markdown/Text/Diff/Image;
  切换工作区面板、文件 tab 或终端 Session 后恢复。异步加载、快速切换和搜索不再覆盖正确
  位置(响应绑定 request identity、双 RAF + ResizeObserver 恢复、迟到 scroll 独立 fence)。
- **关闭当前终端后自动续看(通用,不限 hideTopTabBar)。** 关掉正在看的终端时,若同目录
  有无主(orphan)终端就接管并切过去;续看选候选改为按最后选中时间戳降序(最近看过的优先)。
  tab 的 × / 右键「关闭」/ statusbar「关闭」统一走续看逻辑,乐观先选候选再 SESSION_CLOSE,
  避免中间闪新建页。
- **hideTopTabBar 模式下「新建 / 关闭」放到底部 statusbar,不新增行。** 复用终端底部已有
  的 statusbar 补两个小图标按钮,不再用一条几乎全空的工具栏吃掉省下来的那一行。
- **侧栏双击新建终端不再先闪一下「新建终端」页。** 双击序列的第一击 `click` 会先派发
  `view/select-path`,该 reducer 在 hideTopTabBar 模式下清空 `selectedSessionId` → 主区在
  `dblclick` 触发 SESSION_CREATE 返回前显示 EmptyPathState。现给单击选中加 230ms 双击阈值
  窗口去抖(click-vs-dblclick 消歧)。新建终端整体也不再闪新建页(乐观 dispatch
  `sessions/created`,广播后幂等覆盖)。
- **代码查看器(DiffViewer / TextViewer)横向滚动后右侧裸露无底色 + 行号列挡不住代码
  (根治)。** 根因是行级 `display:grid` block 宽度默认填满视口,而 `white-space:pre` 代码
  溢出 → 行背景只画在视口宽 box 上、溢出区无底色。重构为在滚动容器与行之间新增
  `.diff-lines`/`.file-text-lines` 包裹层(`width:max-content; min-width:100%`),行背景
  覆盖到 scrollWidth 右端;gutter 与代码改为物理分离的双 sibling pane(左 pane 只渲染
  数字/符号且固定不参与横向滚动,右 pane 独占横/纵滚动,只同步 scrollTop),代码在 DOM
  clipping 层就不可能进入数字栏。半透明行底色的混合底从不透明 `--color-bg-primary` 派生,
  明暗主题均为低对比 hairline(不再命中调试 fallback 亮粉)。

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
