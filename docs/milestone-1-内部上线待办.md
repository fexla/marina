# Milestone 1 · 内部上线待办清单

> **历史档案**:本文件创建于 alpha 阶段,产品当时叫 EasyTerm,自 v1.5 起更名为 Marina(见软件定义书 ADR-012)。下文 "EasyTerm" 字样保留作为时间点快照。


**目标**:把 EasyTerm 从"CP-4 已通过的 V1"打磨成"作者本人 daily driver"水平,然后切换主力终端开始真实使用。
**起点**:本清单写于 2026-05-11,基于 CP-1~CP-4 已通过 + CP-4 勘误回合已闭环的状态。
**不包含**:CP-5 开源准备(README 中英 / CONTRIBUTING / CI / GitHub Release)— 那是 Phase 2,daily 用够稳了再做。

---

## 0. 总览

| 优先级 | 含义 | 数量 | 累计工时(粗估) |
|---|---|---|---|
| **P0** | 阻塞内部上线 — 不做就持续被它伤害 | 8 | 12-18 h |
| **P1** | 强烈建议上线前补 — 影响"daily driver 感" | 14 | 16-24 h |
| **P2** | 上线后头两周内补 — 知道但不卡 | 12 | 12-20 h |
| **不做** | 故意不做(违哲学 / V1.x+ 范围) | — | — |

工时单位:S < 1h、M 1-3h、L 3-8h、XL > 8h。

> **建议节奏**:周末两个半天搞完 P0(必跑 dev/真机),再用一周晚间见缝插针做 P1,边用边修 P2。**P0 全部完成前不要"切换主力终端"** — 否则会反复回滚。

---

## P0 · 阻塞内部上线

### P0-1 · 自绘标题栏(custom titlebar)〔M〕

**现状**:`BrowserWindow` 用 OS 默认 frame,白/灰色标题栏在 Rose Pine 等深色主题下视觉割裂严重,标题区不能融入应用主题。Windows 11 还有"标题栏 + 菜单栏 + 应用 body"三层视觉断层。

**目标**:
1. `frame: false` + `titleBarStyle: 'hidden'`,自绘标题栏(已有 `.app-header` 元素,改成可拖拽 + 嵌窗口控制按钮)。
2. Win11 的 Window Controls Overlay(`titleBarOverlay: { color, symbolColor }`)走主题色,免重做窗口最小化/最大化/关闭按钮。
3. 双击标题栏切最大化(Electron 默认行为,frame:false 后需要自己实现)。
4. 标题栏文字 = `EasyTerm — Window N`,与 `.app-header` 合并,不再额外占一行。
5. 拖动区域用 CSS `-webkit-app-region: drag`,按钮区域 `no-drag`。
6. 主题切换时标题栏颜色立即跟。

**风险/边界**:
- Windows 7/10 没 WCO,降级到自绘按钮(用 lucide `Minus` / `Square` / `X`)。
- 全屏 / 最大化 时 padding 要变。
- 7 套主题里 `--surface` 用作标题栏底色,要确认每个主题下窗口控制按钮可见。

**完成判据**:
- 7 套主题切换时整个窗口顶到底是一块。
- 拖动 / 双击最大化 / 三个控制按钮全部工作。
- Alt+空格 (系统菜单) 仍可用(Electron `frame:false` 下默认禁,要 `app.on('browser-window-focus')` 内重绑;或者文档化为"内部上线接受")。

---

### P0-2 · 隐藏 Electron 默认应用菜单〔S〕

**现状**:Windows 上每个 BrowserWindow 默认带一条 `File / Edit / View / Window / Help` 菜单条(Electron 没显式 setApplicationMenu(null))。该菜单条与软件定义书第 7.1 节"不做应用内快捷键"哲学冲突,且与 P0-1 自绘标题栏会叠加成两条 chrome。

**怎么做**:`app.whenReady` 后 `Menu.setApplicationMenu(null)`;或 `autoHideMenuBar: true` + `BrowserWindow.setMenuBarVisibility(false)`。

**完成判据**:Alt 键不再弹菜单条;F12 / Ctrl+Shift+I 仍能开 DevTools(`before-input-event` 已处理)。

---

### P0-3 · 拖文件夹到终端区 = 新建终端〔M〕

**现状**:软件定义书 7.3 列为 V1 必做项 — "Explorer 文件夹 → 终端区 → 在该路径新建终端"。当前只有 Sidebar 收藏区有 dropzone。`MainPane.tsx` / `TerminalView.tsx` 没 onDrop。

**怎么做**:
- `MainPane.main-pane` 接 `onDragOver` / `onDrop`(参考 Sidebar 已有逻辑)。
- 拿到 `dataTransfer.files[].path`,逐个调 `cmd:session:create`(`pathId = path`,默认模板)。
- 拖入时 main-pane 加 `.drag-over` 半透明遮罩,松手即新建。
- 与已存在 session 时:dropzone 浮在 TerminalView 之上,松手前 TerminalView 不接收事件。

**完成判据**:从 Explorer 拖一个文件夹到任意窗口的终端区 → 在该路径新建一个 session 并切到它。

---

### P0-4 · 右键菜单完整化(spec 6.2.2 / 6.2.3 / 6.3.2)〔L〕

**现状**:只有 Sidebar 收藏路径的"设默认模板"实现。其他 spec 内菜单项都缺。

**清单**(逐个对照 spec):

| 位置 | 菜单项 | IPC 是否已有 | 备注 |
|---|---|---|---|
| Sidebar 收藏 path | 重命名 | ✅ `BOOKMARK_RENAME` | UI 待加(行内编辑 or 弹输入框) |
| Sidebar 收藏 path | 移除收藏 | ✅ `BOOKMARK_REMOVE` | 待加;移除后该路径若有 session 就进临时,否则进最近 |
| Sidebar 收藏 path | 在 Explorer 中显示 | ✅ `SYSTEM_SHOW_IN_EXPLORER` | 待加 |
| Sidebar 收藏 path | 复制路径 | navigator.clipboard | 待加(纯 renderer 端) |
| Sidebar 收藏 path | 设置默认模板 | ✅ 已实现 | — |
| Sidebar 临时 path | 加入收藏 | ✅ `BOOKMARK_ADD` | 待加 |
| Sidebar 临时 path | 复制路径 / Explorer 中显示 | 同上 | 待加 |
| Sidebar 最近 path | 加入收藏 / 从最近移除 / 复制 / Explorer | ✅ `PATH_REMOVE_FROM_RECENT` 等 | 待加 |
| Sidebar session item | 重命名 | ❌ **缺 IPC** | 需新增 `cmd:session:rename` |
| Sidebar session item | 关闭 | ✅ `SESSION_CLOSE` | 待加 |
| Sidebar session item | 显示完整命令 | — | 弹 tooltip / 子窗口显示 template.command/args/env |
| Sidebar session item | 复制 PID / cwd | clipboard | 待加 |
| Tab(主区 tab-bar) | 关闭 | ✅ | 已有 ×;右键菜单还可补 |
| Tab | 重命名 | ❌ 同 session rename | 共用 IPC |
| Tab | 复制路径 / Explorer 中显示 | clipboard / SHOW_IN_EXPLORER | 待加 |

**怎么做**:
- 复用 `Sidebar.tsx` 里 `ContextMenuProvider`,提到 `App.tsx` 让全局都能用(或者每个组件各自 instance 也行)。
- 新增 `cmd:session:rename(sessionId, newDisplayName)` IPC:`SessionManager` 加 `rename` 方法 + emit `sessionStateChanged`。
- 重命名 UI:首选行内编辑(双击进入,Esc 取消,Enter 提交),弹窗也可接受。
- 删除/关闭 不弹二次确认(spec 哲学:不打扰)。

**完成判据**:用户在 Sidebar / Tab 任意路径或 session 右键都能看到对应分类的完整菜单,每条都工作。

---

### P0-5 · 主进程全局崩溃兜底〔S〕

**现状**:`main/index.ts` 只 `process.on('unhandledRejection')` 记日志。**没有** `uncaughtException` handler。任意未捕获同步异常会让 main 进程崩溃 → 所有 PTY 死 → 用户工作全丢。这是 daily driver 的最大风险。

**怎么做**:
```ts
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException — keeping process alive:', err);
  // 不调 app.exit(),让 Electron 继续跑;
  // 已经损坏的状态由各 manager 自愈或下次操作时重新校验
});
```
**配合**:`session-manager.ts` 内已有 `try/catch` 包裹大多数 PTY 操作;但 `handlePtyData` 里如果 parser 抛错会冒泡,加一层 try 兜底。

**完成判据**:故意在 dev 模式里 `throw new Error('test')` 进某个 IPC handler,应用不死;日志里看到错误且 UI 可继续操作。

---

### P0-6 · 持久化日志(electron-log)〔M〕

**现状**:全部 `console.log/warn/error`,生产 packaged 模式 stderr 没人看。`cmd:system:open-logs-dir` 创建空目录但没文件可看。Daily driver 出问题没法回溯。

**怎么做**:
- 不引入新 npm 包(违边界 2)→ 用 Node 内建 `fs.createWriteStream` 自己写 `~/AppData/Roaming/EasyTerm/logs/main-{date}.log`。
- 包装一个 `logger.ts`:`info / warn / error`,带 timestamp + module 前缀,同时镜像到 console(dev)和文件(both)。
- 滚动:按日切,保留最近 7 天。
- 大小:超过 5MB 强制切。
- 替换 `src/main/**` 的 `console.*` 调用(批量 sed)。
- Renderer 端的 console 通过 `webContents.on('console-message')` 镜像到同一日志(可选,先不做)。
- `cmd:settings:get-log-level` 已存在(advanced.logLevel),logger 实际尊重它(`debug` 只在 DEBUG 时落盘)。

**完成判据**:跑应用 → 关 → `~/AppData/Roaming/EasyTerm/logs/main-2026-05-11.log` 里能看到本次会话的关键事件(window create / session create / state change / error)。

---

### P0-7 · 应用图标(installer + tray + taskbar)〔M〕

**现状**:`tray.ts` 程序化生成 16x16 紫色方块,够用但丑;`build/` 目录空,electron-builder 用 Electron 默认 icon 打包(灰色圆圈)。任务栏 / 安装程序 / 桌面快捷方式 都是默认。

**怎么做**:
- 出一张 simple SVG(Rose Pine 紫底 + 白色终端提示符 `>_`),用 `electron-icon-builder` 或在线工具转 `build/icon.ico`(多尺寸:16/24/32/48/64/128/256)。
- 同时出 `build/icon.png` (1024x1024) 给 macOS/Linux 未来用。
- `electron-builder.yml` 取消注释 `icon: build/icon.ico`。
- `window-manager.ts` `createWindow` 里 `icon: resolve(__dirname, '../../build/icon.png')`(dev 模式生效)。
- `tray.ts` `generatePlaceholderTrayIcon` 改成 `nativeImage.createFromPath(build/icon.ico)`,并保留 fallback。
- 打包后验证安装包图标 / 任务栏图标 / 托盘图标三处一致。

**完成判据**:打包出来的安装程序、安装后的桌面快捷方式、任务栏、托盘四处图标一致且非默认。

---

### P0-8 · 导出归档隐私警告(API key 泄露)〔S〕

**现状**:`Template.env` 字段可能含 `ANTHROPIC_API_KEY` 等敏感凭据;`SETTINGS_EXPORT` 把它**明文**写进归档 JSON。用户分享归档 = 分享密钥。

**怎么做**:
- 导出对话框前弹 `dialog.showMessageBox`:
  > 归档将包含模板中的环境变量,可能含敏感凭据(API key、token 等)。
  > 是否包含?
  > [取消导出] [包含敏感凭据] [仅导出公开字段]
- "仅导出公开字段":`buildArchive` 中把 `templates[].env` 替换为 `{}`(或仅含非敏感键 — V1 难判别,直接清空稳)。
- 导出文件名加 `-with-secrets` / `-public` 后缀,提醒用户。

**完成判据**:导出时必须经过这一步选择;选"仅公开"后归档里所有 `env` 字段为空对象。

---

## P1 · 强烈建议上线前补

### P1-1 · 窗口位置/尺寸记忆〔M〕

**现状**:每次开窗口固定 1200×800 居中。daily driver 习惯把它放在屏幕特定位置,每次都要拖。

**怎么做**:
- `Settings.windowDefaults` 加 `{ x, y, width, height, maximized: boolean }`(单一组,不区分 window number)。
- `createWindow` 读取这组初始值;窗口 `close` 前把当前 bounds 写回 settings。
- 第一次启动 = 没值 → fallback 居中 1200×800。
- 多显示器:用 `screen.getDisplayMatching(bounds)` 校验保存的 bounds 还在屏幕内,否则 fallback。
- 不持久化每个 windowId 的位置(违反"窗口零成本开关"哲学,只记"最近一个"作为下次默认)。

**完成判据**:拖移/缩放窗口 → 关 → 重开 → 还在原位置原尺寸。

---

### P1-2 · 托盘菜单完整化(spec 6.5.3)〔M〕

**现状**:`tray.ts` 只有"打开新窗口"+"完全退出"。spec 6.5.3 完整版要"显示所有窗口 / 关闭所有窗口 / 正在运行的会话(子菜单)/ 设置 / 完全退出"。daily driver 经常想从托盘看一眼"我有几个 session 在跑、跑的是什么"。

**怎么做**:
- "正在运行的会话"子菜单:每条 = `{icon} {session.displayName}   {path}`,点击 → 聚焦 owner window + 选中该 session(走 `SESSION_FOCUS_OWNER` 或直接 webContents.focus + send focus-requested)。
- "显示所有窗口":遍历 windowManager.list 调 `focus()`(若被最小化先 restore)。
- "关闭所有窗口":`windowManager.closeAll()`。
- "设置":开个窗口(若没窗口先 createWindow),发 `view/enter-settings` 给该窗口的 renderer。
- `sessionManager.on('sessionCreated'/'sessionDestroyed'/'sessionStateChanged')` 时 `rebuildContextMenu()`(节流 500ms 避免高频抖动)。

**完成判据**:右键托盘菜单内容跟着真实 session 列表实时更新;每个动作 work。

---

### P1-3 · 托盘图标动态状态〔S〕

**现状**:托盘图标常态紫色方块,无视 session 状态。spec 6.5.1 要求"有 session 活跃 / 全空闲 / 等待输入(V1.1)"用图标变化区分。

**怎么做**:
- 三态图标:`default`(无 session) / `idle`(有 session 但全 idle) / `active`(有 session active)。
- 程序化生成 3 张(基色 + 角标色不同),或直接用 lucide 渲染到 PNG 后写盘 cache。
- 工时短先做"有/无 active 颜色不同"两态;V1.1 加 waiting-input。
- Tooltip 改成 `EasyTerm — N 个会话(M 活跃)`。

**完成判据**:启动一个 watch 命令 → 托盘图标变;命令结束 → 恢复。

---

### P1-4 · 状态识别的"启动期 grace"〔S〕

**现状**:session 刚创建 → state='active'(PowerShell 出 banner)→ 2s 内无输出 → idle。用户感受是"刚开就闪了一下"。CP-3 勘误已加 resize-quiet 窗口,但启动期 grace 仍没专门处理。

**怎么做**:
- `createSession` 时 `startupQuietUntil = now + 1500ms`。
- `markActive` 在 startup quiet 窗口内不发 evt(只重置 idle timer),让 banner 期不闪。
- 与 RESIZE_QUIET_MS 设计模式一致。

**完成判据**:打开 PowerShell session → 状态点直接稳定在 active(或快速到 idle),不再"闪 active → idle → active"。

---

### P1-5 · 第三方 prompt(starship / oh-my-posh)兼容性验证〔S 验证 / 视情况 M 修〕

**现状**:`pwsh.ps1` hook 加载用户 `$PROFILE` 后再 wrap prompt 函数。但 OMP / starship 在 $PROFILE 里**异步注入** prompt(set-content `function:prompt`)。我们 wrap 后再被它们覆盖 → OSC 1337 失效 → cwd ⚠ 永远不亮(但 path 仍正确)。

**怎么做**:
- 验证:在装了 OMP 的 PowerShell 下跑应用,`cd` 不同目录,看 tab ⚠ 是否变化。
- 若失效:把 OSC 1337 emission 从 prompt 函数挪到 `PSConsoleHostReadLine` hook 之前(PSReadLine 提供 `Set-PSReadLineKeyHandler` -ScriptBlock 可挂);或 `[Console]::Write` 在 `Register-EngineEvent OnIdle` 内。
- 退路:接受第三方 prompt 下 OSC 1337 不工作,UI 上 `currentCwd` 等于 `originalCwd` 永远不漂 — daily driver 自用如未装 OMP,这项就不阻塞。

**完成判据**:用户真实 PowerShell 配置(含/不含 OMP)下 cwd 跟踪都工作,或确认了限制并文档化。

---

### P1-6 · 默认应用 menu 隐藏 + DevTools 行为〔S〕

(并入 P0-2,这里只补 DevTools 在 prod 模式的策略)

**现状**:`F12` / `Ctrl+Shift+I` 始终能开 DevTools(`before-input-event` 拦截)。生产环境是否保留?

**建议**:**保留**。daily driver 自用,DevTools 是诊断的唯一手段。但 production build 默认不打开 DevTools(`EASYTERM_DEVTOOLS=always` 才打开,已实现)。

**完成判据**:打包后启动应用 DevTools 默认不弹;按 F12 仍能打开。

---

### P1-7 · Ctrl + 滚轮调字号〔S〕

**现状**:spec 7.2.2 列了"Ctrl+滚轮 调字号",但代码没接。xterm.js 不内建。

**怎么做**:
- `TerminalView.tsx` 在 `containerRef` 上加 `onWheel`:`if (e.ctrlKey) { e.preventDefault(); dispatch settings update terminalFontSize ± 1 }`。
- 范围限 8-24,与设置项约束一致。
- 防抖 50ms 避免连续滚轮抖动。

**完成判据**:终端 focus 时 Ctrl + 滚轮调节字号,所有窗口同步(共享 settings)。

---

### P1-8 · 关于栏目的实际致谢内容〔S〕

**现状**:`SettingsView.tsx::AboutPanel` 致谢列表是硬编码 6 项。需要核对 `package.json` 里实际依赖是否包含。

**怎么做**:
- 检查 `lucide-react` 是否在致谢列表里 — **不在**,补上。
- 加 LICENSE 链接(`shell.openExternal` 到各项目 GitHub)。
- 加版本号显示(可从 `package.json` 读)。

**完成判据**:关于页能看到所有运行时依赖 + 各自 license + 链接到上游。

---

### P1-9 · 模板编辑器:env 字段密码遮罩〔S〕

**现状**:`SettingsView.tsx::TemplateEditor` 的环境变量 textarea 是普通文本,API key 一览无余。

**怎么做**:
- 默认遮罩(显示 `***`),旁边一个眼睛图标(lucide `Eye` / `EyeOff`)点击切换可见。
- 复制粘贴时仍是真实值。
- 与 P0-8 导出隐私警告呼应。

**完成判据**:打开模板编辑器,env 默认看不到值;点眼睛能看清。

---

### P1-10 · 错误反馈 toast 系统〔M〕

**现状**:IPC 失败 / createSession 失败 等只 `console.error`。用户看不到具体什么错。

**怎么做**:
- 新增 `Toast` 组件 + ToastContext(可挂在 App 根)。
- IPC handler 抛错 → renderer 端 catch → 转 toast(`error`)。
- 重要操作完成的提示也用 toast(`success`,比如"已添加收藏:~/projects/x")。
- 自动消失 4s,失败/错误手动关闭。

**完成判据**:故意停掉 PTY 或选个无效路径,UI 弹出可见的错误 toast 而不是只 console。

---

### P1-11 · 状态机性能 / 大量 session 压测〔S 测 / M 优化〕

**现状**:没真测过 10 session + 2 窗口 < 500MB(spec §10 性能底线)。Daily driver 可能日积月累跑 8 个 claude code,内存爆炸不被发现。

**怎么做**:
- 跑 10 个 session(混合 active TUI + idle shell),每个 30 分钟,看 main 进程内存。
- 看 IPC event 频率(尤其 evt:session:output)是否压力 renderer。
- scrollback ring 真到 2MB 后裁切是否正常(写个 `yes` 1 分钟测)。
- 若超 500MB:检查 scrollback ring 是否漏裁、event 是否堆积、是否漏 disposable。

**完成判据**:跑 spec 底线场景半小时内存稳定。

---

### P1-12 · 设置:确认重置全局热路径〔S〕

**现状**:`AdvancedPanel` 的"重置所有设置"已有二次确认,但点完成功后没明显反馈。

**怎么做**:
- 重置完弹 toast(P1-10 完成后)"已重置为默认"。
- 同时 confirmingReset 状态自动关闭。

**完成判据**:重置后视觉上明确感知,无需翻看其他面板验证。

---

### P1-13 · 已知文件路径不存在的恢复路径〔M〕

**现状**:用户收藏的路径如果被删 / 改名(常见:重命名项目目录),下次双击会 `PtySpawnFailed`。当前 UI 只 console.error。

**怎么做**:
- `createSession` 失败带 `cwd-not-accessible` 错误码 → renderer toast 提示 + 弹一个"路径不可达,是否从收藏中移除?"对话框。
- Sidebar 上不可达的 path 加红色感叹号标记(可异步 stat 一遍所有收藏路径,启动时做一次,变化时增量做)。
- 改名场景没法自动恢复(对应不上),只能让用户手动重添。

**完成判据**:把一个收藏路径手动删掉再双击它,UI 明确告知 + 提供操作。

---

### P1-14 · 单实例锁:第二次启动的窗口聚焦行为〔S〕

**现状**:第二次启动 EasyTerm.exe 时 `second-instance` handler 直接 createWindow。但 spec 5.1.6 没明确"新开还是聚焦"。Daily driver 习惯:双击桌面快捷方式 → 应该聚焦已运行实例(若有窗口)而不是无脑新开。

**怎么做**:
- `second-instance` handler 改:
  ```ts
  const recent = windowManager.getMostRecentlyActive();
  if (recent) { recent.focus(); }
  else { windowManager.createWindow(); }
  ```
- 与单击托盘行为对齐(已经是这逻辑)。

**完成判据**:已有窗口时第二次启动 = 聚焦最近窗口,不是无脑新开。

---

## P2 · 上线后头两周内补

### P2-1 · IME / 中文输入测试〔S 测〕

测试矩阵:微软拼音 / 五笔 / 搜狗;在 cmd 行 / claude code 输入框 / 终端搜索框各试一遍。已知 xterm.js 处理 IME 有些 corner case,记录现象到 known-issues.md。

### P2-2 · 多显示器 / DPI 切换〔S 测〕

把窗口从 1080p 拖到 4K → DPI 变 → xterm fit 是否正确;字号是否突变。多显示器登录显示 OK 没专门测。

### P2-3 · 休眠 / 唤醒后 PTY 状态〔S 测〕

Windows 休眠 5 分钟唤醒,看 PTY 是否还活;OSC 1337 是否还工作;cwd 跟踪是否漂。

### P2-4 · Session 重命名 IPC + UI〔M〕

P0-4 已列依赖;若 P0-4 时偷懒只做了 bookmark rename,这里补上 session rename。

### P2-5 · 设置 import 失败回滚〔M〕

当前 `applyArchiveInMemory` 顺序调三个 Manager.replaceAll,中途某个失败时另两个已应用。需要事务化:先全部 validate,再全部 apply,最后 await flush。

### P2-6 · 缩略图 / Aero Peek(Windows 任务栏 hover 预览)〔M〕

`win.setThumbarButtons` / `win.setOverlayIcon` 可定制任务栏 hover 缩略图。Daily driver 加分项,非必需。

### P2-7 · Settings v1 → v2 迁移基础设施〔M〕

当前 `SettingsManager.initialize` 见 `version !== 1` 直接 throw IncompatibleVersion。日后改 schema 时这条会让所有老用户启动报错。加迁移函数链 `[v1→v2, v2→v3, ...]`,即使现在没 v2 也把骨架立起来。

### P2-8 · DevTools 默认关 + 错误页面〔S〕

打包后用户看到错误时(handshake 失败、snapshot 失败等)应该有"打开 DevTools / 报告问题"按钮;现在只有静态错误 placeholder。

### P2-9 · 字体下拉的"应用某字体后无效"提示〔S〕

用户选了某字体但系统没装 → 应用 fallback,但用户不知道。在字体选项旁加"未装"标(已实现 ✓)+ 当前生效字体可视化(用所选字体本身渲染该 option label,已实现 ✓ — 验证一遍)。

### P2-10 · OSC 序列调试模式〔S〕

`advanced.logLevel = DEBUG` 时,把 PTY 出来的所有 OSC 序列(不止 1337)记入日志,方便调第三方工具兼容性问题。

### P2-11 · 终端搜索区分大小写默认状态记忆〔S〕

当前每次开搜索栏 `searchCaseSensitive=false`。用户多半固定一种风格,该状态可记入 settings(behavior 分类下加个开关或 session-private)。

### P2-12 · ipc-protocol.md 升 v1.1 / v1.2〔M〕

(昨天工作记录 §4 已标记)把 ADR-008 / ADR-009 的实际生效部分对齐 — 删墓地相关 cmd / evt / error code,加 settings:export/import / template:add 等 schema。文档债不阻塞 daily 用,但开源前必须清。

---

## 不做(明确)

- 应用内非标准快捷键(Ctrl+Shift+T 新建 / Ctrl+W 关闭 等) — 违反"鼠标优先"哲学(spec 7.1)
- 全局快捷键(Win+`)— 同上
- 拖拽改 tab 顺序 / 拖出新窗口 — V1.2 范围(spec 5.2)
- WSL session 直接挂载 — V2.0
- macOS / Linux 实现 — V2.0
- 内置 AI chat / Workspace 概念 — 永远不做(spec 13.2 红线)
- 关闭单窗口确认对话框 — 永远不做(spec 13.2 红线)

---

## 工时累计

| 优先级 | 项数 | 工时 |
|---|---|---|
| P0 | 8 | 12-18 h |
| P1 | 14 | 16-24 h |
| P2 | 12 | 12-20 h |
| **合计** | **34** | **40-62 h** |

按业余时间(每周 8-10 h)估算:**P0 一个周末 + P1 两到三周晚间 = 4-5 周开始 daily-driver**。

---

## 推荐攻克顺序

1. **第一天(P0 视觉 + 安全墙)**:P0-2 隐藏菜单 → P0-1 自绘标题栏 → P0-5 全局崩溃兜底 → P0-7 应用图标
2. **第二天(P0 数据流 + UX)**:P0-3 拖文件夹到终端 → P0-4 右键菜单完整化(分两轮:Sidebar 一轮、Tab 一轮)→ P0-8 导出隐私
3. **第三天(P0 收尾 + P1 起手)**:P0-6 持久化日志 → P1-1 窗口位置记忆 → P1-2 托盘菜单完整化
4. **本周剩余晚间(P1 主体)**:P1-3~P1-9 依个人时间见缝插针
5. **下周(P1 收尾 + 切主力)**:P1-10~P1-14 + 真机用 1 周 → 期间记录 P2 + 新发现的勘误
6. **第三周起**:P2 + ipc-protocol.md 文档对齐 + 准备 CP-5 开源材料

---

## 升级到 Milestone 2 / V1.1 的触发条件

完成本清单 **P0 全部 + P1 ≥ 10/14** 后:
- 把"主力终端"从原工具切换到 EasyTerm
- 实际用 2 周(每天 4+ 小时)
- 把发现的新问题汇总成 `docs/m1勘误.md`,按 AGENTS.md 4.6 勘误回合纪律处理
- 全部消化后即 Milestone 2 起点 — 这时候可以开始考虑 V1.1 范围(状态识别"等待输入" / 通知 / Explorer 集成)

---

**清单结束**

> 这个清单是"我认为内部上线前应该做"的快照,不是合同。审完后想重排优先级 / 增删条目 / 改工时估算都可以,直接编辑这份文件即可,我下次拿到的就是新版。
