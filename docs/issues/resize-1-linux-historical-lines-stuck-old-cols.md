# RESIZE-1 · Linux 上拖大窗口后历史行卡在旧 cols

**状态**:**根因未定位,前一轮诊断被证伪,等下次接手重查**
**优先级**:P1(Linux 上严重影响日常使用)
**首次报告**:2026-05-17(Liyue-Cheng 在 Ubuntu 22.04 Wayland 测试 BETA-003 v0.1.0-beta.4 Linux deb)
**关联工单**:BETA-003(Linux 支持)收尾遗留
**关联代码**:`src/renderer/components/TerminalView.tsx`、xterm.js `Buffer.resize` / `BufferReflow.ts`

---

## 现象

Linux Ubuntu 22.04 GNOME(Wayland)上 Marina v0.1.0-beta.4(commit `7d4ebef` 之后,`transparent: false` 已修复 cols 跟随)装包后:

1. 默认窗口尺寸 → `echo $COLUMNS` 输出 `133`
2. 拖小窗口 → `echo $COLUMNS` 输出 `83`(跟随 ✓)
3. **再拖大窗口** → 新命令输出按新 cols 正常折行,**但屏幕上已有的旧 prompt / 历史 ls 输出仍按旧 cols(83)的 wrap 形式显示**,右侧大片留白

用户实测原话:**"新输出 OK 但历史内容卡在旧宽度"**。

用户最早报告(BETA-003 v0.1.0-beta.4 装包后)的更激烈版本:

```
liyue@liyue-ysyx:~/workbench/ysyx/ysyx-wor
2026-05-17T05:14:15.440Z [INFO] [main] req/marina"]}
liyue@liyue-ysyx:~/workbench/ysyx/ysyx-wor
```

prompt 完整应是 `liyue@liyue-ysyx:~/workbench/ysyx/ysyx-workbench$ ` (50 字符),实际只显示前 42。INFO 行 `requestSingleInstanceLock result {...}` 也被截断成 `req/marina"]}`(用 `\r` 同行覆盖)。

**关键对照(用户确认)**:**Windows 上无此 bug**,缩放完全正常。

## 已证伪假设(全部走过的死路)

### 死路 1:Wayland + transparent 让 ResizeObserver 滞后

**改动**:加 `BrowserWindow.on('resize')` 主进程 IPC 兜底 + renderer 三步 fit(立即 / rAF / 100ms trailing)。

**结果**:**失败**。`echo $COLUMNS` 仍卡。Revert (commit `ed70b65`)。

**复盘**:不是触发时机问题。fit 触发再多次,算出的 cols 仍错。

### 死路 2:`transparent: true` 污染 Wayland viewport

**改动**:Linux 上 `transparent: false` + 实色 backgroundColor(commit `7d4ebef`),代价是 Linux 上接受方角无圆角。

**结果**:**部分有效**。`echo $COLUMNS` 跟随窗口了。**但"历史行卡旧宽度"现象仍在**。说明 transparent 是另一个相关但独立 bug(BETA-003c),不是本 issue 根因。

**复盘**:这个改动应保留(Linux 圆角换 resize 跟随是值得的 trade-off),但不解决 reflow。

### 死路 3:`windowsMode: true` 无平台分支启用 = xterm.js 关闭 reflow

**假设**:`TerminalView.tsx:754` `windowsMode: true` 在 Linux 上启用,根据 xterm.js 官方文档关闭 reflow,导致 `reflowLarger` 不跑。

**证据来源**:WebSearch 工具返回的总结说 "windowsMode: A deprecated option that disables reflow and assumes lines are wrapped if the last character of the line is not whitespace"。

**结果**:**证伪**。

**关键反证**(用户实测,2026-05-17 晚):

- 代码里 `windowsMode: true` 是**全平台**启用(无 `if process.platform === 'win32'`)
- 如果它真关 reflow,**Windows 上应该也卡历史行**
- 但 Windows 上 reflow **完全正常**(用户原话:"windows 缩放行为是完全正常的,根本就没有 linux 上的这些 bug")
- 所以 `windowsMode` **不是** Linux reflow 失效的原因

**诊断错误回顾**(下次避免同样的坑):

从 xterm.d.ts verbatim 拿到的 `"If !(backend === 'conpty' && buildNumber >= 21376) - Reflow is disabled"` 实际是 **`windowsPty`** 选项的 JSDoc,**不是 `windowsMode`**。WebSearch 工具返回的关于 `windowsMode` 的描述("disables reflow")是 LLM 合成的总结,**不是 xterm.js 官方原文**。两者被混为一谈,导致错误下结论。

**教训**:**WebSearch 工具的合成总结不能当作原文引用**。涉及第三方库 API 行为判定,必须 verbatim 引用 d.ts / 源码 / 官方文档,且要明确字段名与引文路径精确匹配。

## 真实差异面 — Linux vs Windows 代码路径

代码里**目前**两平台不同的地方:

| 路径 | Windows | Linux | 关联工单 |
|---|---|---|---|
| `transparent` | `false` | `false`(BETA-003c 修过) | — |
| WebGL renderer | 启用 | **跳过**(走 xterm DOM renderer) | PER-LINUX `TerminalView.tsx:943` 起,跳 WebGL 是为解决 Linux swiftshader 软渲秒级渲染 |
| `windowsMode` | `true` | `true`(无平台分支) | 仍可疑,但证伪了"它关 reflow"这个具体机制 |
| Shell hook | pwsh/cmd/git-bash | bash | — |
| Wayland 合成 | 不适用 | Ubuntu 22.04 GNOME = Wayland session | — |

**最大新嫌疑**:**Linux 跳 WebGL 后走 xterm DOM renderer**。理论上 reflow 是 buffer 层操作不受 renderer 影响,但实际可能:

- DOM renderer 在 `term.resize` 后没正确刷新 viewport(reflow 在 buffer 里发生了,但屏幕上的 DOM 节点还是旧的)
- DOM renderer 的 viewport 高度 / lineHeight 测量在 Wayland 下有 quirk,导致 `proposeDimensions` 算出错,reflow 用错的 cols
- DOM renderer 与 fit 的 charSize 协议有差异

**这是新假设,未经验证,不要照搬下定论**。

## 下次接手 checklist(诊断方向,不是修法)

按"快胜利 → 慢挖根"顺序:

### 步骤 1:做对照实验,精确划定 bug 边界

在 Marina **dev 模式** 下(`npm run dev`)做以下对照:

| 平台 | renderer | 现象 |
|---|---|---|
| Windows 11 dev | WebGL(默认) | reflow OK(用户已验证) |
| Linux Wayland deb | DOM(PER-LINUX 跳了 WebGL) | reflow 卡 |
| **Linux Wayland dev,强制启用 WebGL** | WebGL | **关键对照** — reflow OK 则证实 DOM renderer 是根因;reflow 仍卡则排除 renderer |
| **Windows dev,强制跳 WebGL** | DOM | **关键对照** — reflow 卡则证实 DOM renderer 是根因(平台无关) |

强制切 renderer 的方法:在 `TerminalView.tsx:943` `isLinux` 判断处临时反转或加 URL 参数控制。改完跑 dev 现场测,看到现象后撤回。

### 步骤 2:如果 DOM renderer 是根因

查 xterm.js 5.5 DOM renderer 源码(`@xterm/xterm/src/browser/renderer/dom/DomRenderer.ts` 或类似):

- 看 `onResize` / `_updateDimensions` 等 handler
- 比对 WebGL renderer 同位置实现差异
- 搜 xterm.js GitHub issues:"DOM renderer resize reflow"
- 可能的修法:resize 后强制 `term.refresh(0, term.rows - 1)` 重画所有可见行
- 或:DOM renderer 上 `requestAnimationFrame` 后再做一次 `term.refresh`

如果 DOM renderer 是根因,**性能损失换 reflow 正确性**可能不值。备选:Linux 上保留 WebGL 但跳过 swiftshader(用 `chrome://gpu` 探测 + URL flag)。

### 步骤 3:如果 renderer 不是根因(WebGL 路径也卡)

排查别的:

- Wayland 合成器 → Chromium 内部 → DOM layout 的链路某处有 quirk
- 加诊断 log:resize 前后打印 `term.buffer.active.length` / `term.buffer.active.getLine(0).isWrapped` 看 reflow 真否跑了
- 真实读一份 xterm.js `Buffer.resize` 在 `term.cols` 变化时具体走哪个分支
- 检查 `term.refresh(0, term.rows - 1)` 主动强制重绘是否能解决(若 buffer 反正确,只是 viewport 没刷)

### 步骤 4:LOG-1 单独立项(顺便)

用户报告截图里有 `[INFO] [main] requestSingleInstanceLock result {...}` **出现在 PTY 中**。这是单独的 logging 卫生问题,与本 issue 解耦,下次单独开 `LOG-1`:

- 主进程 logger 在 packaged build 应只写 `~/.config/marina-app/logs/*.log`,不该写 stdout
- 当前现象解释:用户从一个 Marina session 里 spawn 了另一个 marina 进程(嵌套),新 marina 的 stdout 继承自父 PTY → 字节流被 shell 当输入显示

## 不要再走的路

❌ **不要再加触发兜底**(BrowserWindow.on('resize') IPC / 三步 fit / rAF 链)。死路 1 已证伪,根因不在触发时机。

❌ **不要再凭 WebSearch 合成总结诊断 xterm.js API 行为**。死路 3 教训,必须 verbatim 引用 d.ts / 源码,且字段名要精确匹配。

❌ **不要 revert transparent 改动**。BETA-003c 是有效的(`echo $COLUMNS` 跟随),保留方角换 cols 跟随是好 trade-off。

❌ **不要给 `windowsMode` 加平台分支**。证据不足,且 Windows 上 reflow 正常说明它没坏现状。

## 参考链接

- [xterm.js typings/xterm.d.ts](https://github.com/xtermjs/xterm.js/blob/master/typings/xterm.d.ts) — 官方 JSDoc,**注意 `windowsPty` 与 `windowsMode` 行为可能不同**,引用前 verbatim 核对原文
- [xterm.js BufferReflow.ts](https://github.com/xtermjs/xterm.js/blob/master/src/common/buffer/BufferReflow.ts) — reflow 算法实现
- [Issue #1941 Reflow doesn't work](https://github.com/xtermjs/xterm.js/issues/1941)
- [Issue #63 Horizontally resizing will not reflow terminal until input is changed](https://github.com/xtermjs/xterm.js/issues/63)
- [Issue #2296 Reset isWrapped in windowsMode](https://github.com/xtermjs/xterm.js/issues/2296)
- [Issue #2666 Windows mode does not flag some conpty lines are wrapped](https://github.com/xtermjs/xterm.js/issues/2666)
- BETA-003 实施记录:`docs/方案-BETA-003-Linux支持-20260517.md`
- 前置修复 BETA-003c(commit `7d4ebef`):Linux `transparent: false`,修了 `$COLUMNS` 跟随
- PER-LINUX(commit `1dbc8bc`):Linux 跳 WebGL renderer 走 DOM renderer

## 变更历史

| 日期 | 改动 | 作者 |
|---|---|---|
| 2026-05-17 | 初创(诊断指向 `windowsMode` 关 reflow,信心很高) | Claude Opus 4.7 |
| 2026-05-17 | **重写**:用户实测证伪诊断 — Windows 同样 `windowsMode=true` 但 reflow OK。把内容改为"根因未定位",列出已死路 + 新嫌疑 DOM renderer + 下次接手 checklist。文件改名 `resize-1-windows-mode-disables-reflow.md` → `resize-1-linux-historical-lines-stuck-old-cols.md`(现象命名,不再带根因猜测)。 | Claude Opus 4.7 + Liyue-Cheng 反证 |
