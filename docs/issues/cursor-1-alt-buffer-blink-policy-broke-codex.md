# CURSOR-1 · BETA-019 workaround(alt-buffer 关 cursorBlink)失败 + 破坏 Codex

**状态**:**已根治(2026-05-17)** — 改用 state-replay 架构(@xterm/headless + SerializeAddon),裸字节 scrollback 与启发式 workaround 全部删除
**优先级**:P1(完成)
**首次报告**:2026-05-17
**关联工单**:`docs/beta反馈工单库-20260515.md` BETA-019(随本工单一起结案)
**根因证实**:复现脚本 `scripts/repro-cursor-1.mjs` + DevTools REPLAY-DIAG 输出 `bufferType:'normal'` + `scrollbackKB:2047`,验证 `?1049h` 被 2MB 裁切丢失假设
**实施分支**:`fix/cursor-1-state-replay` —— 4 个 commit(repro 脚本 → 切数据源 → 删 workaround → 删裸字节存储)
**polyfill 追踪**:`docs/issues/xterm-serialize-mode-polyfill.md`(0.14.0 stable 不覆盖 `?25l` 与 DECSTBM,本地补两条,等 0.15.0 stable 删)

> 下面的"现象 / 修法选项 / 推荐决策 / 下次接手 checklist"为历史诊断过程的留档,**实际方案见末尾"2026-05-17 续:架构级根治方案"**。

---

## 现象

2026-05-16 落地 BETA-019 workaround:**alt-screen buffer 内关闭 `cursorBlink`,normal buffer 内开启**。意图是让 TUI 应用(Claude Code 等)期间避免 xterm 自带光标在 TUI 自绘内容中间闪烁。

实际效果:

1. **BETA-019 原问题(Claude Code 闪烁光标)仍经常出现**。workaround 没解决 — 用户反馈"这个问题还是经常出现"。
2. **引入新问题:Codex CLI 在 alt buffer 内看不到光标闪烁**。Codex 与 Claude Code 不同:
   - Claude Code:在 alt buffer 内**自绘输入区光标**(它自己用反色 cell 或 unicode 标记画一个光标位置)
   - Codex:在 alt buffer 内**依赖终端的系统光标**(由 xterm 按 `cursorBlink: true` 闪烁来指示输入位置)
   workaround 关闭 cursorBlink 后,Codex 用户看不到光标在哪里 / 是否在输入态。

净结果:**两个最常用的 AI CLI 都出 bug,而且根因还没找到**。

## 失败的根本原因

启发式 "alt-buffer 内 = TUI 应用 = 一律不需要终端光标 blink" 是错的。TUI 应用按光标策略分两类:

| 类型 | 代表 | alt-buffer 内 cursorBlink 需求 |
|---|---|---|
| 自绘光标 TUI | Claude Code / vim(normal mode) / htop / less | **不需要**终端 blink — 自己画 |
| 依赖系统光标 TUI | Codex / nano / vim(insert mode) / 某些 REPL | **需要**终端 blink — 让用户看到输入位置 |

`buffer.type === 'alternate'` 这一个信号**不足以**区分这两类。Marina 没有可靠的运行时方法判定当前 alt-buffer 是哪一类(没有标准 escape sequence、没有 PTY-level 元数据)。

业界标杆参考误用:之前文档里写 "Windows Terminal / iTerm2 / kitty 同此策略" — 重新核对后**这个说法是错的**。这些终端默认 `cursorBlink: false`(光标静态显示),Marina 默认 `cursorBlink: true`(模仿 Windows ConHost 行为),策略不同所以行为不同。Marina 借鉴"alt-buffer 关 blink"实际是在给自己造新问题。

## 已尝试

| 时间 | 改动 | 结果 |
|---|---|---|
| 2026-05-16 BETA-019 调研第一轮 | 静态分析排除 (a) WebGL atlas / (b) Claude Code 行为 / (c) IME / (d) cursorBlink timer 累积 | 假设全否,无修复 |
| 2026-05-16 BETA-019 调研第二轮 | 运行时 HUD 注入(`Object.defineProperty` 拦截 `coreService.isCursorHidden`)| 排除 (e) DECSTR/RIS 翻转 isCursorHidden 候选;bug 时段 `flips:0` |
| 2026-05-16 实施 workaround | alt-buffer 关 cursorBlink(本报告对象)| **失败**:Claude Code 仍闪 + Codex 看不到光标 |

## 修法选项

### A. 回滚 workaround,回到 BETA-019 原状态(接受未解决)

- 撤掉 `TerminalView.tsx` 的 `onBufferChange` listener + FLK-10 effect 的 `buffer.active.type` 读取
- BETA-019 原 bug(Claude Code 闪光标)回来,但 Codex 恢复正常
- 优点:把"破坏一个修不了的+破坏另一个"换回"只破坏一个"
- 缺点:Claude Code 用户体验仍差

### B. 更精细策略:alt-buffer 内**保持 cursorBlink=true**,但只在 `isCursorHidden=false` **且** 当前 cursor 位置不与字符 cell 内容碰撞时显示

- 需要 hook xterm 渲染管线(WebglRenderer 或 RectangleRenderer)
- 复杂、侵入,且 cell 碰撞检测的语义模糊(Claude Code 的 spinner cell 跟"应该显示光标"的位置如何区分?)
- 不推荐

### C. 找 root cause(BETA-019 未结案的下次接手方向)

工单 BETA-019 里列了"剩余怀疑":**scrollback replay 后 cursor 状态被卡死**。验证方法:

- 在 `TerminalView.tsx:953` 的 `replayed = true` 之前 console.log 输出 `coreService.isCursorHidden` 最终值
- 或:replay 结束后强制 `term.write('\x1b[?25l')` 给 alt buffer

如果这条假设证实,真正的修复就是在 replay 结尾正确恢复 cursor 隐藏状态,**不需要全局关 cursorBlink**,Codex 也不受影响。

### D. 区分 Claude Code 与 Codex(不推荐)

理论上可以读 PTY 启动的进程名,如果是 `claude-code` 关 blink,如果是 `codex` 开。但:

- 需要 main 端 IPC 反向同步进程信息到 renderer
- 进程链可能复杂(`pwsh → claude-code` 或 `bash → npx claude-code`)
- 用户随时可能在同一 session 内切换跑不同 AI CLI
- 不可维护

## 推荐决策

**短期 → A(回滚)**:Codex 是日常使用工具,不能为了一个未根治的 workaround 把它弄坏。回滚后回到 BETA-019 单一缺陷状态,Codex 立即恢复。

**中期 → C(追根因)**:按 BETA-019 工单"剩余怀疑"章节列的验证方法,优先验证 scrollback replay 假设。这条若证实,修法对所有 TUI 一致正确,不需要区分应用类型。

## 关联约束

- **永远不要再凭"alt-buffer 内 = TUI = 不要终端光标"启发式做决策**。证据已证伪。
- 工单 BETA-019 维持"未结案"状态。

## 下次接手 checklist

1. 先回滚 workaround(本报告 A 方案):
   - `TerminalView.tsx` 删除 `onBufferChange` listener 块及其 cleanup `bufferChangeDisposable.dispose()`
   - FLK-10 effect 恢复原版:not-exited → 直接 `cursorBlink = true; cursorStyle = 'bar'`
2. 在 BETA-019 工单 / 本报告里追加回滚事实
3. 启动追根因(C 方案):scrollback replay 完成时刻 console.log + 强制 `?25l` 试探
4. 若 C 方案证实,实施定向修复并关闭本报告 + BETA-019 工单

---

## 2026-05-17 续:架构级根治(已实施,工单关闭)

### 真因

**`managed.scrollback: Buffer` 2MB 裸字节 ring 从头部 `\n` 边界裁切,不识别 DEC 模式 setter**。Claude Code / Codex / vim 启动只发一次 `?1049h`(进 alt-buffer)+ `?25l`(隐光标),之后无限刷帧。scrollback 涨过 2MB,裁切把开头那几个字节丢掉。renderer 重挂时 xterm 收到不含 `?1049h`/`?25l` 的字节流 → 留在 normal buffer + cursorBlink 保持 true。

诊断脚本 `scripts/repro-cursor-1.mjs` + DevTools `[REPLAY-DIAG]` 日志直接证实:`bufferType:'normal'` + `scrollbackKB:2047`(顶住 2MB cap)+ `cursorBlink:true`,与假设字节级吻合。

### 修法

把 `getScrollback` 数据源从"裸字节 ring 回灌"换成"@xterm/headless 状态机 + SerializeAddon 序列化重建":

- main 端 `managed.headlessTerm` 跟在 PTY 字节流后面镜像状态(本来就有,BETA-006 v2)→ 新增 `SerializeAddon` 挂在它上面
- 新方法 `SessionManager.getScrollbackForReplay`(async):`flushPendingEmit` → `await drainHeadless` → `serializeAddon.serialize({ scrollback: 5000 })` + polyfill 补 `?25l` 与 DECSTBM(参 `xterm-serialize-mode-polyfill.md`)
- renderer 收到的是"能完整重建当前终端状态"的 ANSI 流,直接 `term.write()` 就到位 — 字节级等价,模式不可能丢

### 工单关闭确认

- BETA-019 原 cursor flash:**消失**(state-replay 把 `?1049h` 始终注入到 ANSI 头部)
- Codex 静态 / 动态光标:**正常**(应用要藏就发 `?25l`,Marina 转发,不再二次猜)
- 切 tab "从顶到底刷屏" 副症状:**减轻**(serialize 输出体积比 2MB 裸字节小一两个数量级,FLK-1 分片几乎一次刷完)

### 删除清单(实际落地)

- `TerminalView.tsx`:`term.buffer.onBufferChange` listener + cleanup + FLK-10 effect 读 `buffer.active.type` 全删
- `session-manager.ts`:`managed.scrollback: Buffer` 字段 / `appendScrollback` / `SCROLLBACK_LIMIT` / `findSafeTruncationBoundary` / 旧 `getScrollback`(返裸字节)/ `recheckIdle` 内 `source==='raw'` 分支全删
- `shared/types.ts`:`ai.statusRecheckSource` 联合类型去掉 `'raw'`
- 设置 UI 去掉 raw 选项 + 老 settings.json 静默 coerce
- 相关测试:删 SCROLLBACK_LIMIT / OSC-2 / 旧 PER-2 v1/v2 case;补 state-replay 不变量 case
