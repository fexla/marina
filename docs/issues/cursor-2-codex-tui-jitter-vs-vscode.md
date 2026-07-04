# CURSOR-2 · Codex TUI 光标在两个位置间逐帧跳变(仅 Marina,VSCode 无此问题)

**状态**:**未解决,挂起待续**(2026-06-01)
**优先级**:P1(影响 codex 用户日常使用,尤其是长按方向键 / 退格的高频输入场景)
**首次报告**:2026-05-31,用户日常使用 codex 时观察
**最后调研**:2026-06-01

> 这是一份"调研日记 + 失败实验清单",不是修复报告。当时跑过的所有假说在这里都有,**包括行为有变化的、没变化的、变得更差的**。下次接手前必读,避免重做。

---

## 现象

### 用户报告(原话)

> "codex 输入框,将退格键按住不放,光标就会闪到屏幕下面最后一个字符后面"
> "原本闪的还是比较慢,现在(EMIT_BATCH_MS=0)是稳定复现,每按一次退格键就必闪一次"
> "我刚刚打开 vscode 看过了,确实是完全没有这个问题"

### 客观特征

1. **触发场景**:codex CLI 在 alt buffer(进入 TUI 后),用户按住退格键(或任何持续输入)
2. **视觉**:系统光标在屏幕底部两个位置之间逐帧跳变。一个是输入光标位置(用户期待),另一个是 TUI 状态行某个 cell 末端
3. **对照**:**VSCode 集成终端无此现象**(同一个 codex 二进制,同一台机器,同一时间窗口测试)
4. **Claude Code 的相关问题**:Claude Code 在 Marina 中**无可见光标抖**(因为它发了 `?25l` 藏起来),但**中文 IME 候选框跟着同源的 cursor 移动飘**(详见 IME-2 工单,本工单不重复)
5. **`EMIT_BATCH_MS` 敏感**:见下文实验记录,这个 main 端 batch 窗口尺寸对抖动严重程度有明显影响

### 抖动的精确数据(2026-05-31 探针抓到)

加了 `[CURSOR-TRACK]` 探针后(挂 `onCursorMove` + `onRender`,每帧报"帧内 cursor 走过的位置 + 渲染位置 + 是否跟上一帧不同"),按住退格 1 秒输出:

```
[CURSOR-TRACK] F43 moves=1 last5=[(1,32)] rendered=(1,32) JUMP from (2,31)
[CURSOR-TRACK] F44 moves=1 last5=[(2,31)] rendered=(2,31) JUMP from (1,32)
[CURSOR-TRACK] F46 moves=1 last5=[(1,32)] rendered=(1,32) JUMP from (2,31)
[CURSOR-TRACK] F47 moves=1 last5=[(2,31)] rendered=(2,31) JUMP from (1,32)
... (持续逐帧两位置交替几十帧)
```

特征:
- `moves=1`:每帧 cursor 在 xterm 内部**只移动一次**,渲染位置就是这次移动的终点
- 两个位置稳定交替:`(1,32)` 是 TUI 末端绘制位置,`(2,31)` 是输入光标位置
- F43→F44 之间间隔 1 帧(~16ms),也偶有 F44→F46 这种 2 帧间隔(视字节到达时刻而定)

---

## 已确认的事实

### 1. codex 字节流形态(由 `[BYTES]` 探针抓到原始 ANSI)

按 EMIT_BATCH_MS=0(每 PTY chunk 一个独立 IPC)抓到的连续片段:

```
T+13093 seq=84  len=87: \e[?2026h\e[0 q\e[?25l\e[30;2H\e[K\n\e[K\e[32;22H\e[K\e[33;2H\e[K\e[?25h\e[?2026l\e[?25l\e[32;3H\e[?25h
T+13603 seq=86  len=87: <同上,完整一帧>
T+13620 seq=89  len=75: \e[?2026h\e[0 q\e[?2026l\e[?25l\e[30;2H...\e[32;3H\e[?25h   (空 SUM + 全部内容在外面)
T+13647 seq=90  len=68: \e[?2026h\e[0 q\e[?25l\e[30;2H\e[K\n\e[K\e[32;22H\e[K\e[33;2H\e[K\e[?25h\e[?2026l   (atomic 块,末位置 (1,32))
T+13659 seq=91  len=19: \e[?25l\e[40;3H\e[?25h   (光标回归 (2,31),12ms 后单独一包)
T+13675 seq=92  len=68: <同 seq=90 的 atomic 块>
T+13697 seq=94  len=94: <光标回归 + 新 atomic + 光标回归 — 三段都在一包>
```

**关键观察**:
- codex 用 **DECSET 2026 (Synchronized Output Mode, SUM)** 标记每一帧:`\e[?2026h` 开,`\e[?2026l` 关
- atomic 块**末位置就是 (1,32)**(来自 `\e[33;2H`,1-indexed → 0-indexed 是 (1,32))
- "光标回归 (2,31)" 是 `\e[32;3H`(1-indexed → 0-indexed (2,31)),**在 atomic 块外面**
- 有时整帧 + 回归在一个 PTY 写(`seq=84`),有时分两个写、间隔 ~12ms(`seq=90` 和 `seq=91`)
- 还有一种诡异变体:**空 SUM 块 + 内容全在 SUM 外面**(`seq=89`)。来源未查清,推测 crossterm 内部某条 begin/end 路径
- 那个紧跟在 `\e[?2026h` 后面的 `\e[0 q`(DECSCUSR 重置 cursor 形状)在每帧都出现,跟现象本身无直接关系,可忽略

### 2. codex 输出来源(查 OpenAI codex 源码)

- 仓库:`github.com/openai/codex/codex-rs`
- 框架:Rust + Ratatui 立即模式渲染 + crossterm 后端
- `codex-rs/tui/src/custom_terminal.rs`:**没有**显式调 `\e[?2026h/l`,纯靠 crossterm 的 `queue!` + `flush()`
- `codex-rs/tui/src/terminal_probe.rs`:启动期 capability 探测,**不查 SUM 支持**;查的是 CPR / OSC 10/11 / kitty kbd protocol
- `codex-rs/tui/src/insert_history.rs`:同上,`queue!` + flush,无 SUM
- 推论:**SUM 标记由 crossterm 或 ratatui 自动注入**,不是 codex 业务代码主动发的。codex 不读 TERM_PROGRAM 来切策略

### 3. Marina 字节路径(实测代码)

```
PTY (codex)
  → main: SessionManager.handlePtyData (session-manager.ts)
    → queueEmit:setTimeout EMIT_BATCH_MS=8ms 攒批
    → 同步写一份给 managed.headlessTerm(state-replay 镜像)
  → IPC EVENT_CHANNELS.SESSION_OUTPUT
  → preload: contextBridge wrapped emit
  → renderer: window.api.on listener (TerminalView.tsx:1316)
  → decode base64
  → term.write(bytes)
  → xterm 内部 _writeBuffer
  → setTimeout(0) → _innerWrite → parser → onCursorMove / 写 buffer.x/y
  → RAF → render service → WebGL renderer → cursor render layer (独立 2D canvas)
```

### 4. VSCode 字节路径(查 VSCode 源码)

- `xtermTerminal.ts` 的 `write(data, callback)`:**直接 `this.raw.write(data, callback)`,无任何 batching / coalescing 包装**
- 数据来源:`TerminalDataBufferer`(`src/vs/platform/terminal/common/terminalDataBuffering.ts`)
- batch throttle:**默认 5ms**(我们 8ms,比 VSCode 还粗一点)
- 渲染器:WebGL,跟我们一样
- xterm 版本:`@xterm/xterm@^6.1.0-beta.220`(VSCode `package.json`,2026-05 版),**走 beta 线**

### 5. VSCode 同事件下表现

- **codex**:零抖(用户亲测)
- **Claude Code**:VSCode 也抖(详见 [anthropics/claude-code#18084](https://github.com/anthropics/claude-code/issues/18084) 等 9 个月未结的工单 + Anthropic 2026-03 给出的 `CLAUDE_CODE_NO_FLICKER=1` 环境变量绕过)
- **结论**:VSCode 不是"完美终端",它对 Claude Code 同样抖;但对 codex 干净 — 说明 **codex 的字节流形态**有什么是 VSCode 的 xterm 6.1 beta 接得好,而我们的 xterm 5.5.0(原版)和 6.0.0 stable / 6.1.0-beta.256(本工单实验过的版本)都接不好

---

## 实验记录(按时间顺序,**全部失败或反效果**)

### 实验 1:加 `[CURSOR-JITTER-PROBE]` 数 SESSION_OUTPUT 与 term.write 的每帧次数

**假说**:Marina 的 8ms IPC batch 把 codex 的 atomic+cursor-return 切成两个 RAF,renderer 多次 `term.write` → xterm 多次 parser tick → 多次 `onRender` → 中间状态可见

**改动**:`TerminalView.tsx` 加 RAF loop,每帧打 `out=<次> write=<次> bytes=<总字节>`

**结果**:**所有有事的帧 `out=1 write=1`**,假说被推翻 — 不是 IPC 分片

**用户反馈**:"都是 1,我觉得方向对,但是不完全是这个原因"

### 实验 2:换 `[CURSOR-TRACK]` 探针追踪光标位置本身

**假说**:虽然 IPC 不分片,但 cursor 渲染位置可能逐帧跳。挂 `onCursorMove` 收集帧内每次移动,挂 `onRender` 报最终渲染位置 + 跟上帧 diff

**改动**:`TerminalView.tsx` 加 `term.onCursorMove` + `term.onRender` 探针

**结果**:**确认 pattern**(就是前面"现象"节的逐帧 JUMP 数据)。每帧 `moves=1`,两个位置稳定交替

### 实验 3:`EMIT_BATCH_MS` 8 → 0(砍 main 端 batch)

**假说**:8ms batch 切断 codex 的逻辑帧,改 0 让 xterm 内部 `_writeBuffer` 接管合批,等价 VSCode 进程内自然行为

**改动**:`src/main/session-manager.ts:110` `EMIT_BATCH_MS = 8` → `0`(走 `queueEmit` 已有的立即路径)

**结果(用户反馈)**:**显著变差**。"原本闪的还是比较慢,现在是稳定复现,每按一次退格键就必闪一次,刷屏的时候也是疯狂闪动"

**学习**:8ms batch 实际**在帮 xterm 合批多个 term.write**。砍了之后每个 PTY chunk 各自一次 `term.write`,xterm 在不同 task 间已经 drain,每次 write 各自走一次 `_innerWrite` → 各自一次 render,render 次数翻倍

### 实验 4:`EMIT_BATCH_MS` 0 → 32

**假说**:既然 batch 是帮合批的,加大窗口到 ~2 帧(60Hz),覆盖 codex 12-14ms 的 inter-write 间隔

**改动**:同上,改 32

**结果(用户反馈)**:**部分缓解**。"已经缓解一些了,但是还是有"

**学习**:timing 路径上**方向对但不彻底**。加大窗口能合上一部分原本被切开的逻辑帧,但仍有间隔超过 32ms 的情况(或 batch 边界刚好落在帧中间)

**评价**:这是 timing workaround,不是 root cause,放弃此方向

### 实验 5:升 `@xterm/xterm` 5.5.0 → 6.0.0 stable + 所有 addons 到 6.x 配套

**假说**:`@xterm/xterm` 6.0.0(2025-12-22 release)新增了 **DECSET 2026 (SUM) 原生支持**(PR #5453)。5.5.0 把 `\e[?2026h/l` 当未识别 DEC mode 丢掉,atomic 块内所有 cursor 移动逐个 render → 抖。升 6.0 后 SUM 走 atomic commit,只 render 一次

**改动**(全在 worktree `worktree-xterm-6-upgrade` 上,详见该分支 diff):
- `package.json`:
  - `@xterm/xterm` `@xterm/headless`:5.5.0 → 6.0.0
  - `@xterm/addon-fit/search/web-links/webgl`:升到 6.x 配套 stable(0.11.0 / 0.16.0 / 0.12.0 / 0.19.0)
  - `@xterm/addon-serialize`:留 0.14.0(无 6.x stable;对其他升级无冲突)
- 破坏性变更:`windowsMode: true`(5.x 单旗标)→ `windowsPty: { backend: 'conpty', buildNumber }`(6.x 颗粒化)
  - `buildNumber` 通过 preload 从 `os.release()` 解出来同步暴露
  - 在 `src/preload/index.ts` 新增 `windowsBuild` 字段
  - `TerminalView.tsx` 用 spread 表达式塞 `windowsPty`(满足 `exactOptionalPropertyTypes`)

**结果(用户反馈)**:**完全没变化**

**学习**:SUM 升级**对本现象零效果**。回头看其实可以预测到:SUM 只保证 atomic 块内**无中间帧暴露**,但不保证 atomic 块**结束位置**和 atomic 块**之外**那个"光标回归"在视觉上落在同一帧。codex 把"绘制结束位置 (1,32)"和"光标回归到 (2,31)"分成两个 PTY 写,两个写之间间隔 12ms,SUM 救不了

### 实验 6:再升到 `6.1.0-beta.256`(对齐 VSCode 用的 beta 线)

**假说**:发现 VSCode `package.json` 用的是 `@xterm/xterm@^6.1.0-beta.220`,不是 6.0 stable。6.0 → master 200+ commit 里**可能**有 cursor render 相关修复(比如 cursor render layer 的 debounce / coalesce)。直接对齐 VSCode 的 xterm 版本

**改动**:
- `@xterm/xterm` `@xterm/headless`:6.0.0 → 6.1.0-beta.256
- 所有 addons 升到对应 beta:`0.12.0-beta.256` / `0.17.0-beta.256` / `0.15.0-beta.256` / `0.13.0-beta.256` / `0.20.0-beta.255`

**验证(我这边)**:
- typecheck pass
- 全量 512 单测 pass(包括之前偶发的 persistence debounce flaky 测,这次也过)
- production build pass

**结果(用户反馈)**:**完全没变化**

**学习**:跟 xterm 自身版本/SUM 实现**完全无关**。VSCode 跟我们装的是同一个 xterm beta,但 VSCode 不抖、我们抖 → 差别**不在 xterm**,在外围

---

## 已被排除的假说

| # | 假说 | 排除方式 | 结论 |
|---|---|---|---|
| H1 | 每 RAF 多次 SESSION_OUTPUT 导致多次 term.write 多次 render | `[CURSOR-JITTER-PROBE]` 探针实测每帧 `out=1` | **否** |
| H2 | xterm 5.x 不支持 SUM,中间帧暴露 | 升 6.0 stable 后无任何改变 | **否** |
| H3 | xterm 6.0 stable 离 VSCode 用的 beta 200+ commit,中间有 cursor 修复 | 升 6.1.0-beta.256 后无任何改变 | **否** |
| H4 | EMIT_BATCH_MS 是元凶,砍掉就好 | 改 0 显著变差 | **否(反向)** |
| H5 | codex 检测 TERM_PROGRAM 切策略,我们 'Marina' 让它走差的分支 | 看 codex 源码 `terminal_probe.rs`,无 TERM_PROGRAM 检查;capability 探测只查 CPR / OSC 10/11 / kitty kbd protocol | **否(无证据)** |
| H6 | VSCode 在 `term.write` 外加了 batching / coalescing 包装 | 直接看 VSCode `xtermTerminal.ts:write`,纯透传 `this.raw.write(data, callback)`,无任何额外处理 | **否** |
| H7 | VSCode 的 `TerminalDataBufferer` throttle 比我们小(5ms vs 8ms),所以更紧凑 | 5ms 更短理论上应该 jitter 更多,而 VSCode 不抖。我们改成 0(等价"零 batch")反而变差 | **否(数据矛盾,反向)** |

---

## 已被弱确认但**部分管用**的方向(timing workaround,非根因)

| # | 假说 | 实测效果 | 评价 |
|---|---|---|---|
| W1 | 加大 EMIT_BATCH_MS 让更多 codex 写合在一个 IPC | 32 时"已经缓解一些" | timing 类 workaround。覆盖大部分 12-14ms 间隔的情况,但凡 codex 间隔超过 batch 窗口仍抖 |

---

## 目前还**没**测试、值得下次先试的方向

按"信息密度 / 实施成本"排:

### D1. 把 `cursorBlink` 改成 false,看视觉感受

- VSCode 默认 `terminal.integrated.cursorBlinking: false`,我们默认 `cursorBlink: true`
- **理由**:即便底层 cursor 位置确实在两个值之间跳,blink off 时是个静态光标,**人眼对"位置跳"的容忍度比"位置跳 + 闪烁开关"高得多**。VSCode 的"零抖"很可能部分来自这条
- **可执行**:`TerminalView.tsx:900` 改 `cursorBlink: false`,跑一次比较。若用户主观感受改善明显,可考虑做成"设置项"或直接对齐 VSCode 默认
- **风险**:用户可能习惯了 blink。需要做成可配置

### D2. 看 WebGL renderer 的 CursorRenderLayer 实际什么节奏 render

- xterm 6.x WebGL renderer 把 cursor 画在**独立 2D canvas** 上(主 WebGL canvas 之上),见 issue #2614
- 这个 cursor 层 的 render 节奏跟主 canvas 是否完全同步?有没有自己的 RAF loop?有没有 debounce?
- **可执行**:读 `node_modules/@xterm/xterm/src/browser/renderer/webgl/CursorRenderLayer.ts`(或 6.1 beta 内对应文件),找 `refresh` / `renderRequest` / `RAF` 出现的所有位置,搞清"cursor 位置变了之后多久 commit 到 canvas"
- 如有 debounce 间隔,这就是"为什么 VSCode 不抖"的答案(他们的 render 间隔大到能跨越 codex 的 12-14ms gap,我们的间隔更短)
- 不太可能,因为我们和 VSCode 用同一个 xterm,但值得 30 分钟一查

### D3. 在 `term.write` 旁挂 onWriteParsed,逐次记录"哪些字节进、parse 完时 cursor 在哪里"

- 升级路径上 onWriteParsed 应该还在(xterm 5.x 起一直有)
- **可执行**:把字节流(`payload.data` 解 base64 后)和 onWriteParsed 时的 `term.buffer.active.cursorX/Y` 一起 log。能直接看出"哪一段字节让 cursor 落在 (1,32)、哪一段把它推回 (2,31)"
- 跟现有 `[BYTES] T+xxx seq=yyy ... | rendered=(...)` 探针组合起来就是完整因果链
- 重点关注 seq=90 → seq=91 这种**两 IPC 跨 RAF** 的情况下,onWriteParsed 在 seq=90 之后到底有没有 fire,如果 fire 了 cursor 位置是什么

### D4. VSCode 的 PTY host 是不是有 codex 专用的什么处理

- 我已经查过 `xtermTerminal.ts` 的 write 路径,纯透传
- 但 VSCode 的 `terminalProcessManager` / `ptyService` 那层可能在 PTY → terminal data 之间还有什么
- **可执行**:逐文件读 `vs/workbench/contrib/terminal/browser/terminalProcessManager.ts` 和 `vs/platform/terminal/node/ptyService.ts`,grep `flush` / `coalesce` / `debounce` / `synchronizedOutput`,看有没有跟 codex 字节流相关的特殊路径

### D5. node-pty 版本差别

- 我们用 `node-pty@^1.0.0`,VSCode 可能更新
- node-pty 在 read 端是否做合批 / 怎么调度 emit 'data',会影响 codex 写到 main 这一段的时序
- **可执行**:看 VSCode `package.json` 的 node-pty 版本,对比 changelog

### D6. 自绘 cursor overlay(实验 0:已被用户在 2026-05-30 删除)

- 用户上次开过 `experiment-stable-cursor-overlay` 分支,实施"xterm 系统 cursor 隐藏 + 我们在 DOM 上画一个稳态 cursor"
- 该分支被删了 + stash 也丢了(2026-05-31 会话开头),原因是用户说"这次实验没有成功"
- **如果上面 D1-D5 都不行,这是最终路径**:从协议层解耦 cursor 视觉与 xterm parser 状态。彻底治本,但 IME 候选框跟随逻辑(那是 OS 级 TSF 跟着 `.xterm-helper-textarea` 的 caret rect 走的)还要分别解决,工程量大
- **如果走这条**,要把"上次没成功"的具体失败原因找出来再开始,避免重复

---

## 调研期间引入的探针 / 实验改动

**2026-06-03 收尾说明**:用户决定不在 Marina 这层继续追(底层差别在 xterm / 渲染管线,不是我们能动的);**所有调研期实验改动已 `git restore` 回退,xterm 6.1.0-beta.256 升级单独从 worktree 合入 main**。本节列出当时植入过什么,下次重启调研时按这里重新植入即可。

### 探针(植入位置:`src/renderer/components/TerminalView.tsx`)

1. **`[CURSOR-TRACK]`**:挂 `term.onCursorMove` + `term.onRender`,每帧报 `F<frame> moves=<N> last5=<...> rendered=(<x>,<y>) JUMP from <prev>`。只打 `moves>1 || JUMP` 的帧,console 噪音可控。注意 cleanup 要 dispose 两个返回的 Disposable
2. **`[BYTES]`**:在 `SESSION_OUTPUT` listener 内 `term.write(bytes)` 之前,console.warn 打 `T+<ms> seq=<seq> len=<len>: <escAnsi(bytes)>` — 捕 codex 完整字节流
3. **`escAnsi(bs: Uint8Array, max = 160)` 辅助**:ESC → `\e`,其他控制字符 → `\xHH`,可见字符原样

### 实验值(植入位置:`src/main/session-manager.ts:110` 附近)

4. **`EMIT_BATCH_MS`**:原值 8。实验过 0(变差,见 H4)和 32(部分缓解,见 W1)。**已回退到 8**

### worktree 状态(`worktree-xterm-6-upgrade` 分支)

- 路径:`E:\projects\terminal\.claude\worktrees\xterm-6-upgrade`
- 改了 `package.json` / `package-lock.json` / `src/preload/index.ts` / `src/renderer/components/TerminalView.tsx`
- xterm 升到 6.1.0-beta.256,`windowsMode` → `windowsPty`(+ preload 同步暴露 `windowsBuild`)
- **对本工单无效**,但**typecheck / 全量 512 测试 / build 全过**,无回归
- **2026-06-03**:用户决策合入 main(版本更新有价值,独立于本工单是否解决)

---

## 时间线

| 日期 | 事件 |
|---|---|
| 2026-05-31 | 用户报告 codex 抖 + Claude Code IME 飘 |
| 2026-05-31 | 加 `[CURSOR-JITTER-PROBE]`,实测 out=1 per RAF,排除 IPC 分片假说 |
| 2026-05-31 | 换 `[CURSOR-TRACK]`,确认逐帧 JUMP pattern(两位置交替) |
| 2026-05-31 | 加 `[BYTES]` 探针,捕到 codex 完整字节流,确认 SUM 标记存在 |
| 2026-05-31 | 实验 EMIT_BATCH_MS=0(变差) → 32(部分缓解) |
| 2026-05-31 | 发现 xterm 5.5.0 无 SUM,假说 SUM upgrade 能修 |
| 2026-05-31 | 开 worktree `xterm-6-upgrade`,升 6.0 stable,**无效** |
| 2026-06-01 | 发现 VSCode 用 6.1 beta 线,升我们到 6.1.0-beta.256,**仍无效** |
| 2026-06-01 | 写本工单,挂起 |
| 2026-06-03 | 用户决策放弃在 Marina 这层继续追;清掉所有实验改动;xterm 6.1 beta 升级独立合入 main(版本更新独立有价值) |

---

## 给下次接手的人的话

1. **不要重做** Markdown 上面所有"已被排除"的实验。那些路径已经确认走不通,再做只是浪费时间
2. **先试 D1**(`cursorBlink: false`)。这是最便宜的实验,5 分钟可以做完,而且能直接判断"VSCode 不抖是不是因为 blink 关了"
3. **如果 D1 改善明显**,这就是部分答案(感知层),但 underlying cursor 位置仍在跳,只是视觉淡化。要不要做成默认行为是产品决策
4. **如果 D1 无改善**,走 D2 / D3,直接读 xterm 6.1 beta 的 CursorRenderLayer 和 RenderService 源码,找 render 时序
5. **关于 IME-2 lock**:本次 6.x 升级**没删** `ime-composition-position-lock.ts`,因为 codex 这种"光标回归在 SUM 外"模式 SUM 救不了,lock 仍有防御价值。如本工单 D1-D5 把根因找到了,IME-2 lock 可以一起评估是否退役
6. **关于探针**:`[CURSOR-TRACK]` 和 `[BYTES]` 写得就是为了反复调研用的,删之前确认本工单结案。中途不要嫌弃 console 噪音就顺手删了

## 关联工单

- [`docs/issues/cursor-1-alt-buffer-blink-policy-broke-codex.md`](./cursor-1-alt-buffer-blink-policy-broke-codex.md) — CURSOR-1 是 state-replay 架构层面的 alt buffer cursor 问题(已结)
- [`docs/issues/ime-2-composition-textarea-position-drift.md`](./ime-2-composition-textarea-position-drift.md) — IME-2 是同源问题的 IME 候选框侧症状,目前用 monkey-patch 兜底
- [`docs/issues/xterm-serialize-mode-polyfill.md`](./xterm-serialize-mode-polyfill.md) — serialize addon 的 `?25l` / DECSTBM polyfill,在 worktree 6.1 beta 测试期间没变化

## 关联外部资料

- xterm.js PR #5453 — Add synchronized output support (DECSET 2026):https://github.com/xtermjs/xterm.js/pull/5453
- VSCode TerminalDataBufferer:5ms throttle:https://github.com/microsoft/vscode/blob/main/src/vs/platform/terminal/common/terminalDataBuffering.ts
- Claude Code flicker(VSCode 也有,与本工单的 codex 不抖对照):https://github.com/anthropics/claude-code/issues/18084
- VSCode `package.json` xterm 版本:https://github.com/microsoft/vscode/blob/main/package.json
- OpenAI Codex Rust 源码:https://github.com/openai/codex/tree/main/codex-rs/tui
