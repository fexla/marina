# Robustness Pass 工作记录 — 2026-05-13/14

> 分支:`fix/robustness-pass-20260513`(基于 `dev`)
>
> 范围:基于 `docs/终端渲染审计备忘录-20260513.md` 的 65+ 条目,系统修复
> 焦点 / 打字 / 复制粘贴 / 闪烁 / Resize / IPC / 字节路径 / 崩溃恢复 /
> 状态机 / 安全 9 大维度的 daily-driver 健壮性问题。
>
> 计划文件:`C:\Users\liyue\.claude\plans\glowing-pondering-steele.md`(已批准)
>
> 工作纪律:遵循 AGENTS.md 4.6 勘误回合工作流 — 每条审计条目转 commit,
> typecheck / test 在每个 commit 后即时验证,完成后文档同步。

---

## 用户授权的范围决策

四道范围问题(2026-05-13)用户均选"推荐"路径:

1. WebGL 渲染器:**引入 `@xterm/addon-webgl`** — AGENTS.md 1.2 边界 2 已确认
2. window.confirm 替换:**新增自绘 Modal 组件**(同时替换 window.prompt)
3. Bracketed paste 协议:**启用 + 用户可关**(settings.behavior.bracketedPaste)
4. IPC 反压:**main 端 8ms 聚合窗口合并 PTY chunk**

---

## Commit 清单与对应审计条目

按时间顺序排列。每条 commit 是单一目的的细颗粒提交(AGENTS.md 6.1):

| # | Commit | Phase | 审计条目 |
|---|---|---|---|
| 1 | docs(audit): 审计备忘补全修订记录 + 优先级/症状映射对齐 CPB-P/C | 准备 | (二轮补审尾巴) |
| 2 | fix(focus): 统一焦点归还工具 + paste/copy/drop/mount 兜底 | A1 | CPB-P1, CPB-C1, CPB-DROP-1, FOC-1 |
| 3 | fix(focus): chrome/tab/template 按钮交互后焦点归还终端 | A2 | FOC-2, FOC-3 |
| 4 | fix(focus): ContextMenu/Toast 关闭归还焦点 + xterm 拦截短路 IME | A3 | FOC-5, TYP-3, FOC-7, CPB-P9 |
| 5 | fix(focus): selectedSessionId 变更 / 托盘聚焦后自动 focus 终端 | A4 | FOC-6 |
| 6 | feat(ipc): sendInput/resize 返回 accepted 状态 + 渲染端可见反馈 | B1 | TYP-1, IPC-4 |
| 7 | fix(session): pty.write 异常包 try/catch + sendInput ownership 校验 | B2 | TYP-2, IPC-3 |
| 8 | fix(session): handlePtyData 加 destroyed guard | B3 | CPT-3 |
| 9 | feat(modal): 自绘 Modal/Confirm/Prompt 组件 + 替换 window.confirm/prompt | C1 | CPB-P2 |
| 10 | feat(paste): 启用 bracketed paste 协议 + ANSI 注入强警告 | C2 | CPB-P8, CPB-P3, CPB-P7 部分 |
| 11 | fix(paste): 粘贴前 sanitize preview + 大粘贴优化 | C3 | CPB-P4, CPB-P7, CPB-P3 修订, OSC-7 |
| 12 | fix(copy): selectOnCopy debounce + Ctrl+C 残留选区死循环 + 多行 CRLF | C4 | CPB-C2, CPB-C3, CPB-C4 |
| 13 | feat(perf): 装 @xterm/addon-webgl 渲染器 + DOM 回退 | D1 | PER-1, XTM-1 |
| 14 | fix(render): scrollback 分片写避免长任务 + 去掉 MainPane RO 双 dispatch | D2 | FLK-1, FLK-2 |
| 15 | fix(render): fit guard + Ctrl+滚轮节流 + exited 停止光标闪 | D3 | XTM-8, FLK-3/4/5/10, RSZ-4 |
| 16 | fix(render): cwd 漂移 PSDrive 前缀归一 + webfont 加载完成重 fit | D4 | FLK-9, XTM-9 |
| 17 | fix(resize): 最大化 leading resize + 打字时 flush 待定 resize | E1 | RSZ-2, XTM-7 |
| 18 | perf(ipc): main 端 PTY chunk 8ms 窗口聚合后 emit 给 renderer | F1 | PER-2 |
| 19 | perf(detect): shell 缓存 30s TTL | F2 | PER-4 |
| 20 | fix(scrollback): 尾部裁切对齐 ESC/换行边界避免接管首屏乱码 | G1 | OSC-2 |
| 21 | fix(osc): stash overflow 静默丢弃 + 0x9D 识别 + 标题 RTL sanitize | G2 | OSC-3, OSC-4, OSC-6 |
| 22 | fix(crash): render-process-gone 自动 reload + 记录 + 用户提示 | H1 | CRA-1 |
| 23 | fix(state): Enter 终结 input quiet + grace 期重置 idle 计时器 | I1 | CUR-1, STM-4 |
| 24 | feat(session): tab 右键加"恢复自动标题" + 重置 manuallyRenamed | I2 | STM-3 |
| 25 | fix(security): setWindowOpenHandler 白名单 http(s)/mailto | J1 | OSC-5, SEC-4 |
| 26 | fix(security): renderer sandbox=true 试验启用 | J2 | SEC-1 |
| 27 | fix(security): 拖文件元字符 confirm + Modal 危险警告 | J3 | SEC-5, SEC-6 |
| 28 | test: window-manager mock 补 setWindowOpenHandler / reload / send 兜底 | K1 | (测试兜底) |

合计 28 个 commit(含本工作记录文档同步)。

---

## 关键架构变更

### 1. 焦点归还体系(Phase A)

历史:Marina 没有统一的焦点管理,paste/copy/menu/tab 等 UI 交互后焦点
漂走是用户主诉根因("粘贴后打不进字必须关窗口")。

新引入:
- `src/renderer/focus.ts` · `focusTerminalDom()` 跨组件入口,走 DOM
  查询 + rAF,自动避开搜索栏 / Modal / 设置视图
- `TerminalView` 内部 `focusTerminal(termRef, searchVisibleRef)` —
  组件内直接持有 ref 时用的快路径
- `ContextMenuProvider` 和 `Modal` 都实现 previousActiveElement 捕获
  + rAF 归还,且只在 activeElement 已落回 body 时归还(避免覆盖 onSelect
  内主动设置的焦点,如 rename input)
- `Toast` dismiss 时检测是否由用户点击触发,是的话调 focusTerminalDom

### 2. Modal 替换 window.confirm/prompt(C1)

历史:Electron 原生 window.confirm/prompt 关闭后 Chromium 焦点归还
不可控,这是用户主诉"粘贴 multi-line 后必须关窗口"的直接根因
(CPB-P2)。

新增:
- `src/renderer/components/Modal.tsx` · ModalProvider + useModal hook
- confirm/prompt 都返回 Promise,焦点 trap + 关闭归还 previousActiveElement
- 复用 ContextMenuProvider 的设计模式,统一风格

替换调用点:
- TerminalView 多行粘贴 confirm
- MainPane Tab 右键重命名 prompt
- TerminalView 含 ESC 转义粘贴的强警告(C2)
- TerminalView 大粘贴 (>1MB) 警告(C3)
- TerminalView 拖文件元字符警告(J3)

### 3. Bracketed paste 协议(C2)

handlePaste 包裹 `\x1b[200~ ... \x1b[201~`,支持 readline 的 shell
(PowerShell 7+ / bash 5+ / zsh / fish / Claude Code REPL)把粘贴
当 literal,用户可编辑后 Enter,**多行粘贴不再被立即执行**。

新增 settings:`behavior.bracketedPaste`(默认 true),cmd.exe 用户可关。

启用时多行 confirm 不再需要(shell 自然让用户编辑);禁用时保留旧
confirm 警告。含 ESC 转义的粘贴一律弹强警告(防 ANSI 注入)。

### 4. sendInput/resize accepted 反馈(B1)

protocol.ts 新增 `SendInputResponse` / `ResizeSessionResponse`,带
accepted + reason 字段。原 void 静默改为返回:
- session-not-found / pty-exited / not-owner / pty-write-failed /
  invalid-dimensions

renderer dataHandler 监听返回,accepted=false 时弹 warn toast
(5 秒节流防刷屏),根据 reason 显示对应消息。

直击用户主诉"敲键无反应必须关窗口"。

### 5. main 端 IPC 聚合(F1)

handlePtyData 不再直接 emit('sessionOutput'),走 queueEmit 入 8ms
窗口缓冲,timer 到点 flush 一次。

- scrollback append 和 outputSeq 仍同步(scrollbackLastSeq 准确)
- 接管 / replay 协议依赖的 lastSeq 不受影响 — 只是 IPC 推送被合并
- burst 场景 IPC 数压成 ~5-10×,renderer base64 解码 + xterm parse
  CPU 显著下降
- 用户视觉无延迟感(8ms = 125 FPS)

可通过 options.emitBatchMs=0 关闭(测试用)。

### 6. WebGL 渲染器(D1)

装 `@xterm/addon-webgl`,mount 时优先 load,context lost 回退 DOM。

性能预期(对比 DOM renderer):
- 长瀑布输出 CPU 80-100% 单核 → 10-20%
- xterm 内部 RAF 帧率 20-30 FPS → 60 FPS
- 主线程不再被 cell 节点 diff 占满

### 7. 渲染崩溃自动恢复(H1)

render-process-gone listener 在 reason !== 'clean-exit' 时
webContents.reload(),所有 session 在 main 端继续活,renderer 拉
新 snapshot + get-scrollback 重建 xterm 状态。

---

## 验证状态

```
npm run typecheck   # ✓ 通过 (node + preload + web 三 tsconfig)
npm test            # ✓ 250 passed (13 files)
npm run lint        # 待 K3 完整跑
npm run dev         # 待 K3 手测主路径
```

新增单测覆盖:
- sendInput 返回 accepted/reason 三态(session-not-found / pty-exited /
  正常)
- pty.write 抛错路径 pty-write-failed
- IPC chunk 聚合(emitBatchMs=8 时合并,=0 时立即 emit)
- scrollback 裁切对齐 \n 边界
- OSC parser stash overflow 静默丢弃
- C1 0x9D OSC 起始识别

合计新增 ~10 个测试,主线全过。

---

## 不在本轮范围内的事(已记入审计备忘录附录 C)

按 AGENTS.md 7 已封箱原则 + 1.2 边界 2 + 13.2 哲学红线:
- OSC-1(node-pty UTF-8 lossy)· 上游硬限制
- KI-001/RSZ-1/FLK-8(ConPTY resize 重画)· known-issues 文档
- KI-002/KI-003 · 独立 milestone
- XTM-4(themes 单源重构)· 大型重构,非 bug
- IPC-2/IPC-6 · 大型架构改造
- MTN-3(前端 e2e 测试)· AGENTS.md 5.1 明确不写
- XTM-2/XTM-5 · 防御性硬化,非紧迫

---

## 后续待办

1. **K3 全量验证**:`npm run typecheck && npm test && npm run lint`(自动)
   + `npm run dev` 手测(用户)主路径
2. **手测覆盖清单**(用户测试时按这个跑):
   - 粘贴后立即打字 ✓ 期望:能打字
   - 切 tab 后立即打字 ✓ 期望:能打字
   - 多行粘贴 ✓ 期望:bracketed paste 启用时不立即执行
   - 单行粘贴 ✓ 期望:无 confirm,直接送
   - PTY 死后敲键 ✓ 期望:toast"会话已退出"
   - Ctrl+滚轮调字号 ✓ 期望:本地立刻变,不跨窗口抖
   - 长跑 session 切窗口接管 ✓ 期望:不黑屏 + 不卡顿
   - `find /` 期间敲键 ✓ 期望:不延迟
   - 中文输入连续多字符 ✓ 期望:不卡死
   - 渲染崩溃 ✓ 期望:窗口自动 reload
   - Ctrl+C 在残留选区下 ✓ 期望:复制 + 清选区,再按 Ctrl+C 发 SIGINT
   - session 重命名 ✓ 期望:走 Modal 不走原生 prompt
   - 右键菜单"恢复自动标题" ✓ 期望:Claude Code 标题再次能更新
   - 终端 URL 点击 ✓ 期望:用系统默认浏览器打开
3. **若 SEC-1 (sandbox=true) 启动期出问题** → 单独 revert 该 commit,
   留 SEC-1 待后续详查(typecheck 已通过,但运行时未实测)
4. **K2 后续**:
   - 软件定义书 5.1.4 加 bracketed paste / ANSI sanitize 行为
   - AGENTS.md CP-4 完成标志补 "WebGL renderer / bracketed paste /
     自绘 Modal"
5. **PR 准备**:`git push -u origin fix/robustness-pass-20260513`(需用户授权)

---

**K2 阶段记录结束**

> 本文件不复述每个 commit 的 message — 详情见 `git log --oneline
> fix/robustness-pass-20260513 ^dev` 与对应 commit body。

---

## K3 用户实测后续 — 2026-05-14

> K2 完成 push 前用户实测,触到两个真问题:
> 1. 程序根本起不来 — preload-error 闪退
> 2. 程序起来后 Claude Code v2.1.133 banner 渲染丢内容(上半 box 出来,
>    下半 + Tips + Welcome 大段空白,只剩零星字符)
>
> 经过若干轮排错 + bisect 定位 + 测试驱动修复,最终落地 3 个真问题修复
> + 2 个测试基础设施。

### K3 commit 清单

| # | Commit | 类别 | 内容 |
|---|---|---|---|
| 19 | `fix(security): SEC-1 sandbox 回退 — preload .mjs 与 sandbox 不兼容` | bug | window-manager.ts |
| 20 | `fix(osc): 回退 0x9D C1 OSC 识别 + stash overflow 改回透传 (OSC-3/4 回归)` | bug | osc1337-parser.ts + 测试 + 新增 fixture 测试 |
| 21 | `fix(perf): PER-2 scrollback / emit 原子 flush — 修复双写 race` | bug | session-manager.ts + race 不变量测试 |
| 22 | `test: 加启动 + 交互双层冒烟 — 拦 SEC-1 / PTY 通路类回归` | 测试设施 | scripts/smoke-launch.mjs + scripts/smoke-interactive.mjs + src/main/smoke-interactive.ts |

### 三个真问题根因 + 修复

#### 真问题 1:SEC-1 sandbox=true 与 preload `.mjs` 不兼容

- **现象**:启动期 `[WindowManager] preload-error: Cannot use import statement
  outside a module`,窗口创建失败。
- **根因**:Electron sandboxed preload 只支持 CommonJS,而 electron-vite 把
  preload 打成 ESM (`out/preload/index.mjs`)。SEC-1 (4d245f7) 注释里
  "node-pty 等原生模块需要"的历史结论是误解修对了,但 preload 产物格式
  这一层没考虑到,typecheck 通过但运行时立刻挂。
- **修复**:`sandbox: true` → `false`(window-manager.ts:152)。注释更新,
  重启 SEC-1 的正路是让 preload rollup 输出 cjs 格式 + 改 preload 路径为
  `index.js` — 当前 preload 源码无 top-level await 等纯 ESM 特性,转 CJS
  没阻塞,留作后续。

#### 真问题 2:OSC-4 误判 0x9D + OSC-3 静默丢内容 → 渲染回归

- **现象**:Claude Code v2.1.133 启动 banner 顶部 box 出来,下方大段空白
  + 零星字符。控制台无任何报错。
- **bisect 过程**(5 步,from `main` good 到 `c6a4adb` bad,18 commit):
  1. `493b2e5` (FLK-1/FLK-2) — good
  2. `51ab975` (OSC-3/4/6) — **bad**
  3. `fa35c9a` (RSZ-2/XTM-7) — good
  4. `914b6a4` (PER-4) — good
  5. `52c5e02` (OSC-2) — good → first bad commit = **51ab975**
- **根因**:
  - **OSC-4**:`findNextOscStart` 用 `buf.indexOf(0x9D)` 不分上下文搜
    C1 OSC 起始。UTF-8 多字节字符的尾字节落在 0x9D 概率极高 — 比如
    `╝` U+255D = `E2 95 9D`,各种 CJK / 阿拉伯字母 / 西里尔字母同理。
    被误判后 parser 进入"寻找 BEL/ST 终止符"状态,后续字节全被当 OSC
    payload 吞。
  - **OSC-3**:stash overflow(> 16KB 未见终止符)从"整段透传"改为
    "静默丢弃 + console.warn"。与 OSC-4 叠加 → 正常 UTF-8 流被当未完结
    OSC 累积 → 超 16KB → 整段消失,banner 大块字节凭空蒸发。
- **修复**:
  - 仅识别 ESC `]`(7-bit 标准形式),不再识别 0x9D。极少数发 C1 OSC 的
    程序由 xterm 自己识别,我们 parser 不再误判
  - stash overflow 整段透传(回到 51ab975 之前的兜底)。哲学:**宁可
    渲染字面 ANSI 乱码也别让用户内容凭空消失** — 乱码用户能复现 + 报告;
    丢字节不留痕迹更难排查。
- **测试**:配套改两个 OSC 测试 + 新建 `osc1337-parser.fixtures.test.ts`
  (5 个 fixture 不变量测试)。

#### 真问题 3:PER-2 scrollback / emit 双写 race

- **背景**:bisect 已锁定 OSC-3/4 是 Claude Code 渲染回归元凶,但排错
  过程中我推理出 PER-2 (14c2c62) 还有一个独立 race,用户认可后写测试
  复现 + 修复。
- **race 时序**(8ms 窗口内 + renderer 拉 scrollback 的 race 窗口):
  ```
  T0  chunk1 来 → scrollback += c1, lastSeq=0, pendingEmit=[c1]
  T1  renderer 调 cmd:session:get-scrollback → 返回 {data: c1, lastSeq: 0}
  T2  chunk2 来 → scrollback += c2, lastSeq=1, pendingEmit=[c1+c2]
  T3  8ms 到 → flush emit {data: c1+c2, seq: 1}
  renderer:
    write scrollback(c1) → lastReplayedSeq=0;
    收 emit seq=1 > 0 → write c1+c2 整段 → **c1 被双写**
  ```
- **为什么用户没报告**:大多数 TUI 重画用 alternate screen + 绝对寻址,
  同一段字节序列被处理两次会写到同一位置覆盖同样内容 — 肉眼看不出。
  只有依赖 cursor 相对位置 / scroll region delta 的程序(部分 progress
  bar、`\r` 重写、`<` ANSI 滚动等)才会留可见 artifact。不变量已破但
  日常隐形。
- **为什么 67 个单测没抓到**:测试默认 `emitBatchMs=0` 走立即 emit 路径,
  恰好跳过了 race 窗口。
- **修复**:`appendScrollback` + `scrollbackLastSeq` 都进 `pendingEmit`,
  `flushPendingEmit` 时三步同步原子前进。任何时刻 `getScrollback` 返回
  的 `(data, lastSeq)` 严格反映"已 emit 的全部历史",pendingEmit 中尚
  未 flush 的字节对 renderer 不可见。
- **测试**:3 个 race 不变量测试。修复前 2/3 FAIL(复现 race),修复后
  72/72 全过。

### K3 测试基础设施:启动 + 交互双层冒烟

K3 三个真问题反复证明:单测全用 stub / mock 替换 Electron / node-pty / IPC
真实路径,"程序起不来"和"程序起来了但行为错"两层没有自动化拦截。本轮
补两层:

#### `scripts/smoke-launch.mjs` (`npm run smoke`)

- spawn `electron out/main/index.js`,5s 内监听 stdout/stderr 关键字
  - `[WindowManager] preload-error` / `render-process-gone` / `FATAL ERROR`
    → 致命模式 FAIL
  - `bootstrap starting` → milestone 达成
- 仅验证"main 起得来 + preload 加载成功 + 5s 内无致命错",不交互。
- **实测能抓 SEC-1 类回归**:sandbox=true 时 preload-error 立即触发 FAIL。

#### `scripts/smoke-interactive.mjs` (`npm run smoke:interactive`) + `src/main/smoke-interactive.ts`

- `MARINA_SMOKE_INTERACTIVE=1` 触发 main 内 harness(仅命中时动态 import,
  生产路径不引入)
- main 启动后,第一个 BrowserWindow `did-finish-load` 后 `executeJavaScript`
  注入测试脚本
- 注入脚本走真实 IPC:`window.api.invoke('cmd:session:create')` → 真实
  node-pty spawn → `window.api.invoke('cmd:session:send-input')` 喂
  `echo TOKEN\r` → `window.api.on('evt:session:output')` 等 8s 内 captured
  含 TOKEN
- 结果通过 `ipcMain 'smoke:report'` 回报,main 写 stdout 后 `app.exit`
- 外部脚本独占 OS temp `user-data-dir`,跑完延迟重试清理(规避 Windows
  lockfile EBUSY)
- 实测 PASS:~2s 完成 PTY round-trip
- **能抓**:IPC handler 缺失 / preload bridge 异常 / SessionManager 路径
  断裂 / PTY spawn 失败 / sessionOutput 通路异常

### K3 测试覆盖现状(累计)

- 单元测试:`vitest` 14 个 test file / 258 个测试全过
- 启动冒烟:`npm run smoke` PASS (~5s)
- 交互冒烟:`npm run smoke:interactive` PASS (~2s,真 PTY round-trip)
- typecheck:`npm run typecheck` 全过

**抓 bug 能力矩阵**:

| 测试 | SEC-1 | OSC-3/4 | PER-2 race | 通用 IPC/PTY 异常 |
| --- | --- | --- | --- | --- |
| 原 67 单测 | ✗ | ✗ | ✗(emitBatchMs=0 跳过) | ✗ |
| parser fixture 测试 | ✗ | **✓** | ✗ | ✗ |
| PER-2 race 不变量 | ✗ | ✗ | **✓** | ✗ |
| `npm run smoke` | **✓** | ✗ | ✗ | ✗ |
| `npm run smoke:interactive` | **✓** | 间接* | 间接* | **✓** |

\* smoke-interactive 当前 marker 是 ASCII,不直接踩 OSC-4 0x9D 路径;
  但任何让 PTY → renderer 通路彻底断的 bug 都会让它超时 FAIL。

### K3 反思

测试漏掉 K3 三个 bug 的结构性原因:

1. **单测全用 stub / mock,真实 Electron / preload / node-pty / IPC 路径
   零覆盖** — SEC-1 这种"配置层"bug 单测看不到。
2. **测试输入是设计者构造的预期场景,不是真实 PTY 流的字节多样性** —
   OSC-4 误判 0x9D 的测试输入(`[0x9D, '1337;...', BEL]`)证明了"能识别",
   但没人喂"含 UTF-8 多字节字符尾字节是 0x9D"的真实 banner。
3. **单测默认配置跳过 race 路径** — PER-2 测试默认 `emitBatchMs=0`,race
   窗口根本不存在。
4. **fix commit 不强制带 regression test** — 本分支多个 fix commit 没附带
   测试 case,K3 三个 bug 都属于此类(commit 提交时 typecheck/单测通过,但
   行为对错没被测过)。

K3 补的两层 smoke + fixture 不变量是直接对策。后续若要进一步加强,选项:
- 把"fix commit 必带 regression test"写进 AGENTS.md 作为约定
- smoke-interactive 加 UTF-8 marker 变体抓 OSC parser 类回归
- Playwright + Electron 端到端(成本高,日常 bug 密度暂不需要)

---

**K3 工作记录结束**

> 本轮新增 4 commit(SEC-1 / OSC-3/4 / PER-2 race / smoke 设施)。
> HEAD = `de896b3`。
> 累计 258 个单测 + 2 层冒烟全过,可推 PR。
