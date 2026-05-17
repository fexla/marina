# RESIZE-1 · 拖大窗口后历史行卡在旧 cols(xterm `windowsMode: true` 关闭了 reflow)

**状态**:**根因已定位,修复未实施 — 等下次接手**
**优先级**:P1(Linux 上严重影响日常使用;Windows 上隐性存在但用户已 baseline 适应)
**首次报告**:2026-05-17(Liyue-Cheng 在 Ubuntu 22.04 Wayland 测试 BETA-003 v0.1.0-beta.4 Linux deb 时)
**关联工单**:BETA-003(Linux 支持)收尾遗留;`docs/beta反馈工单库-20260515.md` 应在 BETA-003 实施记录追加一条
**当前根因代码**:`src/renderer/components/TerminalView.tsx:754` `windowsMode: true`(无平台分支)

---

## 现象

Linux Ubuntu 22.04 GNOME(Wayland)上 Marina v0.1.0-beta.4 装包后跑:

1. 默认窗口尺寸 → `echo $COLUMNS` 输出 `133`
2. 拖小窗口 → `echo $COLUMNS` 输出 `83`(跟随 ✓)
3. **再拖大窗口** → 新命令的输出按新 cols 正常折行,**但屏幕上已有的旧 prompt / 历史 ls 输出仍按 83 cols 的 wrap 形式显示**,右侧大片留白
4. 极端表现:在 cols 较小时输出长 prompt(50 字符)+ 长日志行(180+ 字符),拖大窗口后这些行被截断/wrap 卡死,文本完全不重排,即使把窗口最大化也不动

用户当时贴的现象证据(节选):

```
liyue@liyue-ysyx:~/workbench/ysyx/ysyx-wor
2026-05-17T05:14:15.440Z [INFO] [main] req/marina"]}
liyue@liyue-ysyx:~/workbench/ysyx/ysyx-wor
^[[A2026-05-17T05:14:16.285Z [INFO] [main]rina/marina"]}
```

prompt 完整应是 `liyue@liyue-ysyx:~/workbench/ysyx/ysyx-workbench$ ` (50 字符),实际只显示前 42。INFO 行 `requestSingleInstanceLock result {...}` 也被截断成 `req/marina"]}`(用 `\r` 同行覆盖)。窗口实际宽度足够显示完整内容,但 xterm buffer 里的字符仍按旧 cols wrap。

## 根因(证据 100% 闭合)

### `windowsMode: true` 在我们代码里无条件启用

`src/renderer/components/TerminalView.tsx:749-754`

```ts
new Terminal({
  // ...
  // 勘误第二轮 #5:启用 Windows 模式。
  // 解决:在 Windows 上(尤其 ConPTY 下),PowerShell / cmd 输出的 \r\n
  // 与 xterm 的换行/重绘语义不完全匹配...
  windowsMode: true,
});
```

注释只写了"在 Windows 上",但实际代码没有 platform 分支,**Linux / macOS 也启用**了。

### xterm.js 官方文档明确:windowsMode 关闭 reflow

引文(从 [xterm.js typings/xterm.d.ts](https://github.com/xtermjs/xterm.js/blob/master/typings/xterm.d.ts) 的 ITerminalOptions JSDoc):

> **"If !(backend === 'conpty' && buildNumber >= 21376) - Reflow is disabled"**

引文(从 [ITerminalOptions API 文档](https://xtermjs.org/docs/api/terminal/interfaces/iterminaloptions/)):

> **"windowsMode: A deprecated option that disables reflow and assumes lines are wrapped if the last character of the line is not whitespace"**

windowsMode 在 xterm.js 5.2 起被 `windowsPty` 替代。windowsMode=true 内部等价于一种未完整配置的 windowsPty,触发"reflow disabled"路径。

### 现象与机制完美吻合

xterm.js `term.resize(cols, rows)` 内部:

| 场景 | 函数 | reflow 依赖 |
|---|---|---|
| cols 缩小 | `reflowSmaller` | 单纯把宽行折短,不依赖 wrapped 标志 |
| cols 扩大 | `reflowLarger` | 把连续 `wrapped=true` 行合并回单行 |

- `reflowLarger` 在 windowsMode=true 时**直接被 disable**(官方文档原话)
- 所以缩小 OK(reflowSmaller 仍跑)、扩大不 OK(reflowLarger 不跑)
- PTY cols 跟随窗口(由 `cmd:session:resize` IPC 走通,与 xterm.js reflow 解耦)→ `$COLUMNS` 显示正常
- 新写入的字节按当前 cols 折行 → 新命令输出正常
- buffer 里已有的旧行不会重排 → 用户看到"历史卡在旧宽度"

### Windows 上的隐性表现

Windows 上 windowsMode=true 是它的正确配置(ConPTY 怪行为需要它),但**reflow 也是被禁的**。Windows 用户拖大窗口后历史行也不会自动 reflow —— 只是 ConPTY 用户(包括 Windows Terminal / VSCode terminal 用户)对此 baseline 习惯了,把它当默认行为,不感知为 bug。Marina Windows 行为与 Windows Terminal 一致,可以不修;但 Linux 应当跟 gnome-terminal / kitty 等行为一致,期望 reflow 工作。

## 已尝试 / 已排除

| 时间 | 尝试 | 结果 |
|---|---|---|
| 2026-05-17 早 | 加 `BrowserWindow.on('resize')` IPC + renderer 三步 fit(立即 / rAF / trailing 100ms)兜底,假设根因是 Wayland 下 ResizeObserver 滞后 | 失败(commit 974e3ba,已 revert ed70b65)。fit 触发再多次,算出来的 cols 仍是错的,因为根因不在触发时机 |
| 2026-05-17 中 | 假设根因是 `transparent: true`(BETA-003b 为修圆角加的)在 Wayland 下污染 viewport 计算 | 部分有效(commit 7d4ebef)。改回 `transparent: false` + 实色 backgroundColor 后,`echo $COLUMNS` 跟随了窗口拖动。但"历史行卡在旧宽度"现象仍在 — 说明 transparent 是另一个相关但独立的 bug |
| 2026-05-17 晚 | 上网核实 xterm.js windowsMode 行为 | **根因坐死**:官方文档明确 windowsMode 关闭 reflow |

## 修复方案

### 方案 A:一行改 — `windowsMode` 按平台分支(推荐先做)

`src/renderer/components/TerminalView.tsx:754` 改为:

```ts
const isWindowsRenderer =
  typeof navigator !== 'undefined' && /windows nt/i.test(navigator.userAgent);

new Terminal({
  // ...
  // 平台分支:windowsMode 文档明确"reflow is disabled" — 只在 Windows ConPTY
  // 需要它弥补 wraparound 缺失。Linux / macOS PTY 自身有正确 wraparound,
  // 强行开 windowsMode 会让 reflow 全程禁用,历史行不跟随窗口拖动重排。
  // 见 docs/issues/resize-1-windows-mode-disables-reflow.md
  windowsMode: isWindowsRenderer,
});
```

**改动量**:1 行 + 1 个 const。

**影响范围**:
- Linux / macOS:reflow 启用,拖大窗口历史行自动合并 → 修复
- Windows:维持现状 `windowsMode=true`(包括 Git Bash on Windows,它走 ConPTY)→ 无变化
- 验证:Linux 上重建 deb,拖窗口测试 + Windows 上 dev 跑确认 ConPTY 行为不变(BETA-019 等 ConPTY 相关 workaround 应仍正常)

### 方案 B:升级到 `windowsPty` + buildNumber(更优但工作量大)

`windowsMode` 已 deprecated,xterm 6.x 会移除。`windowsPty` 接受 `{ backend, buildNumber }`,且文档明示:**Windows 11 22H2+ (build ≥ 21376) 用 conpty 时 reflow 仍启用**。这意味着新 Win11 Marina 用户也能享受历史行 reflow,体验跟 Linux 对齐。

实施步骤:

1. **preload / IPC 暴露 Windows build number**:主进程 `process.platform === 'win32'` 时调 `os.release()` 拿到 build number(eg. "10.0.19045"),通过 preload bridge 暴露给 renderer 作为 `window.api.windowsBuildNumber`
2. **TerminalView 用 windowsPty 替代 windowsMode**:
   ```ts
   const buildNumber = window.api.windowsBuildNumber; // null 表示非 Windows
   new Terminal({
     // ...
     windowsPty: buildNumber !== null
       ? { backend: 'conpty', buildNumber }
       : undefined,
   });
   ```
3. **删 `windowsMode` 字段**
4. **验证矩阵**:Win 10 (build < 21376,reflow 仍禁用,与原行为一致)/ Win 11 22H2+ (build ≥ 21376,reflow 启用)/ Linux / macOS(无 windowsPty,reflow 启用)

**工作量**:30-60 min(preload 类型 + 主进程 IPC + TerminalView 改造 + 跨平台测试)

### 方案对比

| 维度 | A. windowsMode 平台分支 | B. 升级到 windowsPty |
|---|---|---|
| 代码改动 | 1 行 + 1 const | 3 文件(主进程 + preload + renderer) |
| Linux/macOS 修好? | ✅ | ✅ |
| Win11 22H2+ reflow 启用? | ❌(维持现状不修) | ✅ |
| Win10 / 老 Win11 | 维持现状(reflow 禁) | 维持现状(reflow 禁) |
| 长期维护 | windowsMode v6 会移除,届时强制迁移 | 已用 v6 推荐 API |

### 推荐决策

**先做 A 验证根因**(1 行改 + 重建 deb + Linux 实测拖窗口)。验证 OK 后:

- 时间紧:停在 A,记 TODO 升级到 B
- 时间充裕:顺势做 B,把 Win11 用户也带上车,避免未来 xterm 6.x 强迫升级

## 关联与副作用

### 一个意外发现(顺便记)

调研期间用户贴的输出里有 `2026-05-17T05:14:14.654Z [INFO] [main] requestSingleInstanceLock result {...}` 这类**主进程 logger 行出现在 PTY 中**。这与 resize 无关,但反映 Marina 主进程的 logger 把信息写到了启动 marina 的父 shell 的 stdout — 启动方式可能是嵌套(从 marina 的 PTY 里 spawn 另一个 marina 实例,新实例的 stdout 写到父 PTY)。

**待评估**:logger 是否应该完全隔离 stdout,只写文件 + DevTools console?或 packaged build 完全静默 stdout?这是单独的 logging 卫生问题,不影响 resize 修复。可单独开 issue:`LOG-1 · 主进程 logger 不应该写父进程 stdout`。

### `transparent: false` 决策(BETA-003c)的反思

为修圆角加的 `transparent: true`(BETA-003b)虽然不是 resize 根因,但确实在 Wayland 下让 `$COLUMNS` 也跟不上窗口(commit 7d4ebef 撤销后才修)。现 Linux 上接受方角换 resize 正常,这个决策仍然正确,不要再改回 transparent:true。

## 下次接手 checklist

1. **实施方案 A**(1 行改):
   - `src/renderer/components/TerminalView.tsx:754` 把 `windowsMode: true` 改成 `windowsMode: isWindowsRenderer`(`isWindowsRenderer` 用 `navigator.userAgent` 检测)
   - 在该行注释引用本 issue 文件路径
2. **重建 Linux deb**(Docker 容器内,见 BETA-003 实施记录):
   ```powershell
   docker run --rm -v "${pwd}:/project" -w /project `
     -e ELECTRON_CACHE=/root/.cache/electron `
     -e ELECTRON_BUILDER_CACHE=/root/.cache/electron-builder `
     electronuserland/builder:wine bash -c "rm -rf release/0.1.0-beta.4 && npm run build:linux"
   ```
3. **Linux 实测验收**:
   - `sudo apt install --reinstall ./Marina-0.1.0-beta.4-amd64.deb`
   - 启动 Marina,跑 `ls`、`echo hello world | tee /tmp/foo` 等让屏幕有内容
   - 拖小窗口到 cols=50 左右,等待重排
   - 拖大窗口到 cols=200 左右
   - **期望**:旧内容自动 reflow,长 prompt / 长输出合并回单行,无右侧大片留白
4. **Windows 回归测试**:
   - dev 模式跑 `npm run dev`
   - 拖窗口确认 ConPTY 行为不变(prompt 不出怪折行,BETA-019 cursor 状态不变)
5. **(可选)继续 B 升级**:做 windowsPty 改造,提升 Win11 22H2+ 体验。或开新 issue 标记 TODO。
6. **更新工单库**:在 `docs/beta反馈工单库-20260515.md` BETA-003 实施记录区追加一条:`resize-1 修复(commit XXX):windowsMode 按平台分支,Linux/macOS reflow 恢复`
7. **删除本 issue 文档**(若工单库已记录)或改其状态为"已完成,保留作历史"

## 参考链接

- [xterm.js typings/xterm.d.ts](https://github.com/xtermjs/xterm.js/blob/master/typings/xterm.d.ts) — windowsPty / windowsMode JSDoc 原文,含"reflow is disabled"原话
- [xterm.js ITerminalOptions API 文档](https://xtermjs.org/docs/api/terminal/interfaces/iterminaloptions/) — windowsMode "disables reflow" 官方说明
- [Issue #2296 Reset isWrapped in windowsMode](https://github.com/xtermjs/xterm.js/issues/2296) — windowsMode 对 isWrapped 影响的历史讨论
- [Issue #2666 Windows mode does not flag some conpty lines are wrapped](https://github.com/xtermjs/xterm.js/issues/2666) — windowsMode 启发式失效场景
- [PR #2569 Move WindowsMode to common/](https://github.com/xtermjs/xterm.js/pull/2569) — windowsMode 到 windowsPty 的演进
- BETA-003 实施记录:本仓库 `docs/方案-BETA-003-Linux支持-20260517.md`
- BETA-003c (commit 7d4ebef):Linux 上 `transparent: false` 决策,本 issue 的前置修复
