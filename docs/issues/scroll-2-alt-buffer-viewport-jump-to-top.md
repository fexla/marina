# SCROLL-2 · 运行 Claude Code / Pi 时滚动条偶发跳到最上面

**状态**:🟢 根因已定位 + 已修复(待验证)
**发现**:2026-07-30
**修复**:2026-07-30
**严重度**:中(影响体验,不丢数据)
**报告人**:开发者

## 现象

运行 Claude Code / Pi 这类 alt-screen TUI 应用时,终端滚动条**有时候**会奇怪地
跑到最上面(scrollback 顶部)。正常使用终端应该一直看最下面(最新输出),但偶尔
视口被拉到了 scrollback 顶部。

特征:
- **只发生在 alt-screen TUI 应用**(Claude Code / Pi / vim / lazygit 等);plain
  shell 长 `npm install` 输出不会触发
- **偶发**("有时候"),不是每次必现 → 时序/竞态相关
- **跟刷新策略有关**(开发者原话):切 session 回来 / 窗口失焦再回来 / 缓存淘汰
  重建时更容易出现

## 根因(已确认)

**Marina 的 `onScroll` 滚动位置记忆不区分 alternate buffer 与 normal buffer,被
alt-screen 切换事件污染。**

### 关键事实链(每一条都有源码佐证)

1. **Claude Code / Pi 是 alt-screen TUI**:进 TUI 发 `ESC[?1049h`(smcup)进
   alternate buffer,退出 / 切子界面发 `ESC[?1049l`(rmcup)回 normal buffer。
   Claude Code 的 Ink 框架频繁进出 alt screen(可设 `DISABLE_ALTERNATE_SCREEN=1`
   禁用,反证它是核心渲染机制)。

2. **xterm 在 buffer 切换时会 fire `onScroll` 事件**(这是关键!)
   `node_modules/@xterm/xterm/src/common/services/BufferService.ts:47-49`:
   ```ts
   this._register(this.buffers.onBufferActivate(e => {
     this._onScroll.fire(e.activeBuffer.ydisp);   // ← buffer 切换 = 一次 onScroll
   }));
   ```
   即 `?1049h` / `?1049l` 每次都会触发一次 `term.onScroll` 回调,参数是新激活
   buffer 的 `ydisp`。

   xterm 自己知道这个风险 —— `browser/Viewport.ts:101-106` 有注释:
   ```ts
   // Reset _latestYDisp when switching buffers to prevent stale scroll position
   // from alt buffer contaminating normal buffer scroll position
   ```
   xterm 内部 Viewport 做了防护,但 **Marina 的 onScroll 监听没做对应防护**。

3. **Marina 的 onScroll 无条件记录 viewportY,不检查 buffer 类型**
   `src/renderer/components/TerminalView.tsx:1278-1291`:
   ```ts
   const scrollMemoryDisposable = term.onScroll(() => {
     if (!replayed) return;
     const buf = term.buffer.active;          // ← 可能是 normal 也可能是 alternate
     latestScroll = {
       topLine: buf.viewportY,                 // ← alt buffer 的 viewportY 通常是 0
       wasAtBottom: buf.viewportY + term.rows >= buf.length,
     };
     ...flushScroll(120ms debounce 写 store)...
   });
   ```
   `buf.type`('normal' | 'alternate')从未被检查。

4. **恢复逻辑用 store 里的 topLine 做 scrollToLine**
   `src/renderer/components/TerminalView.tsx:1666-1670`(replay fence 内):
   ```ts
   const mem = appStateRef.current.terminalScroll.get(session.id);
   if (mem && !mem.wasAtBottom) {
     term.scrollToLine(mem.topLine);   // ← topLine 是小值 → 拉到顶部!
   } else {
     term.scrollToBottom();
   }
   ```

### 完整触发时序

```
1. 用户在 shell(normal buffer)滚到上面看了一会儿历史
   → normal buffer 的 viewportY 较小(比如 12)
   → onScroll 记录 {topLine:12, wasAtBottom:false} 进 store

2. 用户回到底部,运行 `claude`(或 `pi`)
   → 发 ESC[?1049h,进 alt buffer
   → onBufferActivate → onScroll.fire(alt.ydisp=0)
   → Marina onScroll 触发:buf=alt, 记录 {topLine:0, wasAtBottom:true}

3. Claude Code 运行中,频繁 ?1049h/?1049l(子界面 / pager / 退出确认等)
   每次 ?1049l(回 normal)→ onScroll.fire(normal.ydisp)
   → 如果 normal.ydisp 仍是步骤1残留的小值,又被刷新进 store
   ⚠️ store 里 {topLine:小值, wasAtBottom:false} 被反复巩固

4. 触发 replay(切走 session 再切回 / TerminalDeck LRU 淘汰 / 窗口刷新重建)

5. replay fence 读完 scrollback 写进 xterm 后,执行恢复逻辑(1666行):
   mem.wasAtBottom === false → term.scrollToLine(小值)
   → 视口被拉到 scrollback 顶部 ❌
```

### 为什么是"有时候"(偶发)

需要**多个条件同时成立**才触发,所以是偶发:
- (a) 用户进 TUI 前 normal buffer 留下了一个非贴底的 viewportY(看过历史 / 光标
      在非末行);**或** TUI 运行中 alt buffer 因某种原因产生了非贴底状态
- (b) 之后发生了 replay 重建(不是普通 deck 切换 —— 普通 A→B→A 复用 Terminal,
      xterm 自己保留 viewport,不走 scrollToLine 恢复路径)

两个条件都不总是成立 → 偶发。Claude Code / Pi 频繁进出 alt screen 让 (a) 的命中
率远高于 plain shell,所以只在它们身上明显。

## 与既有 SCROLL-1 / CURSOR-1 的关系

- **SCROLL-1**(`scroll-1-session-switch-progressive-refresh.md`)修的是"切 session
  时从上往下刷屏",加的是 replay fence + visibility 兜底,解决的是**视觉**问题,
  没碰 onScroll 记录逻辑。本 issue 是 onScroll 记录**语义**错误,SCROLL-1 的修复
  不覆盖。
- **CURSOR-1** 删了 `term.buffer.onBufferChange` listener(BETA-019 启发式),改用
  state-replay。当时只关注 cursor 可见性,**没注意到 onScroll 也有同样的
  buffer-type 盲区**。

## 已实施的修复(2026-07-30)

**核心:onScroll 记录前 gate 掉 alternate buffer。**

`src/renderer/components/TerminalView.tsx` 的 onScroll 回调顶部加了 buffer 类型守卫:

```ts
const scrollMemoryDisposable = term.onScroll(() => {
  if (!replayed) return;
  const buf = term.buffer.active;
  // alt-screen TUI(Claude Code / Pi / vim)的 alternate buffer 无 scrollback,
  // 且 ?1049h/?1049l 切换时 xterm 会 fire onScroll(BufferService.ts:47)。
  // 若在这里记录,会把 alt/normal 切换瞬间的 ydisp 当成用户滚动写进 store,
  // 下次 replay 恢复时 scrollToLine 到错误位置(滚到顶部)。滚动位置记忆只对
  // normal buffer 有意义 —— alt buffer 的"底"就是当前屏幕,无需记忆。
  if (buf.type !== 'normal') return;
  latestScroll = { topLine: buf.viewportY, wasAtBottom: ... };
  ...
});
```

这是**最小、最对齐根因**的修法。理由:
- alt buffer 本来就没有 scrollback,viewport 恒在屏幕顶部,"滚动位置记忆"对它
  无语义。只有 normal buffer 的 scrollback 才需要记忆视口位置。
- 不需要改恢复逻辑(1666 行)、不需要改 store 结构、不破坏 SCROLL-1 的 fence。
- 与 xterm Viewport.ts:102 的防护思路一致(都在 buffer 切换边界做隔离)。

### 验证

- [x] typecheck / lint / test 全过(typecheck:本修复零新增错误,17 个 pre-existing
      错误均在 `code-block-runner`/`markdown-command`,与本次无关;lint:TerminalView.tsx
      零告警;test:66 文件 / 1037 测试全过)
- [ ] 跑 Claude Code 中途切走再切回(普通 deck 切换),viewport 不跳顶  ← 待开发者实测
- [ ] 跑 Claude Code 中途触发 TerminalDeck eviction(开 >10 个终端挤掉它)再切回,
        replay 后 viewport 落在正确位置(贴底),不跳顶
- [ ] plain shell 滚到上面看历史,切走再切回,仍能恢复到看历史的位置(本修复不
        破坏 normal buffer 的合法记忆)
- [ ] 真实 Electron smoke:`.xterm-viewport` DOM identity / viewportY 不变断言仍过

## 关键文件

- `src/renderer/components/TerminalView.tsx:1278-1295` — onScroll 记录(缺陷点)
- `src/renderer/components/TerminalView.tsx:1666-1670` — replay 恢复(放大缺陷)
- `node_modules/@xterm/xterm/src/common/services/BufferService.ts:47-49` — buffer
  切换 fire onScroll(xterm 侧事实)
- `node_modules/@xterm/xterm/src/browser/Viewport.ts:101-106` — xterm 自己的防护注释
