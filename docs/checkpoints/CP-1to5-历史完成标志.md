# 检查点 1~5 历史完成标志(V1 早期里程碑)

> 从 `AGENTS.md` 第 4.2 节迁出,作为历史归档保留。
> 这些是 V1 构建阶段(Phase 1)早期里程碑 **CP-1~CP-5** 的完成标志快照。
> 当前检查点体系已演进为功能级 CP(见同目录 `CP-Git-*`、`CP-BackgroundScheduler-*` 等)。
> **检查点工作流纪律**(何时停、勘误回合、不跨 CP 重构)仍在 `AGENTS.md` 第 4 章。

## CP-1~CP-5 完成标志(原 4.2)


#### 检查点 1:技术骨架可跑(对应 Phase 1 / Week 1-2)

**目标**:有一个能跑的最小 Electron 应用。

**完成标志**:
- [ ] `npm install && npm run dev` 能在 Windows 上启动应用
- [ ] 能看到一个窗口,内含一个 xterm.js 实例
- [ ] xterm 里能正确显示 PowerShell 提示符,能输入命令并看到输出
- [ ] 关闭窗口 → 应用进入纯托盘模式(托盘图标还在,任务管理器里 Marina.exe 还在)
- [ ] 单击托盘图标 → 重新打开一个窗口(窗口编号变了)
- [ ] 右键托盘 → 看到菜单,菜单里"完全退出"能真正退出应用
- [ ] 启动第二次 Marina.exe → 在已运行实例上新开一个窗口(单实例锁工作)
- [ ] 至少 3 个 main 进程模块的单元测试存在并通过

**用户测试指南必须包含**:
1. 如何运行(precise commands)
2. 上述每一条 checkbox 对应的具体测试步骤(点哪里、按什么键)
3. 预期结果 vs 失败现象
4. 失败时去哪个日志文件看(精确路径)

#### 检查点 2:核心数据模型 + 多窗口(对应 Phase 1 / Week 3-4 前半)

**目标**:三栏侧栏可见,Path 状态机工作,多窗口共享数据。

**完成标志**:
- [ ] 侧栏显示"收藏 / 临时 / 最近"三栏(均为空时也显示)
- [ ] 能通过 "+" 按钮选文件夹加入收藏,关闭再开应用,收藏还在
- [ ] 能通过 Explorer 拖文件夹到侧栏加入收藏
- [ ] 在某收藏路径双击 / 单击新建终端按钮 → 该路径下出现一个 session
- [ ] 关闭那个 session → 路径仍在收藏里(因为是收藏)
- [ ] 在某非收藏路径新建终端 → 路径自动出现在"临时"分类
- [ ] 关闭该路径所有终端 → 该路径自动从"临时"移到"最近"
- [ ] 开第二个窗口(从托盘菜单)→ 第二个窗口看到相同的侧栏数据
- [ ] 在窗口 A 改设置(主题)→ 窗口 B 立即同步
- [ ] 关闭窗口 A 时持有的所有 session → 在窗口 B 里那些 session 变成"无 owner",可以接管
- [ ] 后端核心模块测试覆盖率 > 70%

#### 检查点 3:Session 完整 + cwd 跟踪(对应 Phase 1 / Week 3-4 后半)

**目标**:Session 状态机完整,cwd 跟踪工作,启动模板可用。

> v1.2 起本检查点的部分要求已修订,详见软件定义书 ADR-008:path 与 cwd 解耦、砍墓地。

**完成标志**:
- [ ] Session 有"活跃 / 空闲 / 已退出"三种状态显示,自动切换
- [ ] 在 session 里 `cd` 到另一个路径 → 该 session 在所属路径下不动,但其标签出现 ⚠️ 提示真实 cwd
- [ ] Session 进程退出后,标签灯显灰色 ⚫,scrollback 完整保留;**无时限自动消失**(用户右键"关闭"才销毁)
- [ ] 启动模板有 4 个内置:Shell / Claude Code / Codex / OpenCode(命令可执行,即使 claude 实际未安装也要能尝试启动并报错)
- [ ] 在收藏路径设置默认模板,双击该路径直接启动该模板
- [ ] OSC 1337 hook 注入对 PowerShell 工作(更新 session.currentCwd,不动 path 树)
- [ ] OSC 1337 hook 注入对 cmd.exe 工作
- [ ] OSC 1337 兜底:启动后 5 秒内若未收到任何 OSC,启动 NtQueryInformationProcess 轮询;收到首条后关闭轮询
- [ ] scrollback 2MB 环形缓冲(尾部裁切),owner 切换/接管时一次性推给 renderer
- [ ] 状态机相关模块测试覆盖率 > 80%

#### 检查点 4:UI 完整 + 主题 + 设置(对应 Phase 1 / Week 5-6)

**目标**:产品对外可用版本。

**完成标志**:
- [ ] **7 套**主题都可切换,即时生效,xterm 颜色与 UI 同步(v1.3 起:Rose Pine / Rose Pine Dawn / Rose Pine Moon / Cutie / Business / Ubuntu / Windows Terminal)
- [ ] 设置页面 7 个分类都可访问,所有 V1 设置项都工作
- [ ] 设置即改即生效,无保存按钮
- [ ] 跨窗口设置同步
- [ ] 终端右键菜单(复制 / 粘贴 / 清屏 / 搜索)工作
- [ ] 终端搜索(Ctrl+F)工作 — 搜索栏显示命中数 `current/matches`(SearchAddon `onDidChangeResults`)
- [ ] Ctrl+F / Esc 通过 `term.attachCustomKeyEventHandler` 拦截,**不**透传成 ^F / 0x1B 给 PTY
- [ ] 多行粘贴前弹原生 `confirm`(行数 + 200 字预览),用户确认后再写 PTY
- [ ] 字体下拉枚举 `window.queryLocalFonts()`,推荐组置顶 + 系统已装组(main 端 `setPermissionRequestHandler` 自动放行 `local-fonts`)
- [ ] UI 系统图标走 lucide-react(不再 emoji);用户数据(Template.icon)保持 emoji
- [ ] 选中即复制 + 右键弹菜单的两种行为都工作
- [ ] 完全退出前的二次确认弹窗工作
- [ ] 关闭单个窗口绝不弹任何对话框(已验证)
- [ ] 启动模板编辑子页面工作(增删改自定义模板)
- [ ] 数据导出 / 导入工作 — **导入走 in-memory replace**(Manager.replaceAll + emit),不调 `app.relaunch`,运行中 PTY 不被关(ADR-009)
- [ ] CSP 通过 main 进程 `webRequest.onHeadersReceived` 注入(dev 含 unsafe-eval 给 React Refresh,prod 严格);移除 `index.html` 的 meta CSP
- [ ] 终端状态机有兜底:`createSession` 末尾立即 `scheduleIdleCheck()`,首波 PTY 数据是纯 OSC 时不会卡 active(CP-4 勘误 #5)
- [ ] GitService 启动的所有 git 子进程统一注入 `GIT_OPTIONAL_LOCKS=0` — 不抢 `.git/index.lock`、不干扰用户在 Marina 外部跑的 `git commit`/`add`,且符合「永不写 `.git`」契约。禁止把 git 全局选项 `--no-optional-locks` 错放在 `status` 子命令参数末尾(会 exit 129、面板误报干净);回归断言在 `git-service.test.ts`(CP-4 勘误 #6 兼容性修正,2026-07-21)
- [ ] 应用打包(`npm run build`)产生 Windows 安装包(.exe / .msi)
- [ ] 在干净的 Windows 11 虚拟机或机器上,安装该包,能正常启动并运行
- [ ] 后端整体测试覆盖率 > 75%

#### 检查点 5:开源准备(对应 Phase 2)

**目标**:可以公开发布的状态。

**完成标志**:
- [ ] README.md 中英双语完整(含截图)
- [ ] CONTRIBUTING.md 完整
- [ ] CHANGELOG.md 有 v1.0.0 条目
- [ ] LICENSE 文件存在(MIT)
- [ ] 所有代码注释中无脏话、无内部缩写、无敏感信息
- [ ] `.gitignore` 完整(node_modules / dist / 用户数据等)
- [ ] GitHub Actions CI 配置就位:lint + test + build for Windows
- [ ] 第一个 GitHub Release 草稿就位
