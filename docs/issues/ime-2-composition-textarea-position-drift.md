# IME-2 · 中文 IME 候选框随 TUI 应用「闪动」漂移

**状态**:**workaround 已实施(2026-05-24)** — 在 `term.open()` 之后通过 `_core._compositionHelper` 私有路径 monkey-patch `updateCompositionElements`,让 IME composition 期间的 helper-textarea / compositionView 位置锁定在 `compositionstart` 瞬间的 `buffer.x/y`,核心逻辑在 `src/shared/ime-composition-position-lock.ts`,护栏单测就位。
**优先级**:P2(影响中文用户在 Claude Code / aider / vim insert mode 等 TUI 里的输入体感,不影响正确性)
**首次报告**:2026-05-24,用户在 CURSOR-1 结案后的回归检查里观察到「光标不再多出来一个,但 IME 候选框还是跟 Claude Code 的 spinner 跳来跳去」

---

## 现象

中文输入法(微软拼音 / 任何 Windows IME)开启,**正在 composition 状态**(已按拼音键、候选框已弹出),此时如果当前 session 跑着会持续重绘 alt-buffer 的 TUI 应用(Claude Code 的旋转 spinner、aider 的 status line、vim insert mode 下的 statusline 刷新等),候选框会**随着 TUI 的「闪动」在屏幕上跳来跳去**。

视觉表现:Windows 候选框先出现在输入光标位置,然后突然跳到 spinner 字符那个角落,下一帧又跳回,如此往复。打字本身不出错(发送给 PTY 的 `data` 是正确的),但视觉非常分散注意力,且候选框可能被遮挡 / 跨多块屏幕区域。

切英文输入法 → 现象消失(没有 composition,xterm 不会重新定位 textarea)。
不在 alt-buffer 的应用(普通 shell、`cat` 输出)→ 现象消失或几乎不可见(因为没有持续重绘,cursor 不会被 TUI 反复 save/restore)。

## 这不是 CURSOR-1 / IME-1 的回归

CURSOR-1(`docs/issues/cursor-1-alt-buffer-blink-policy-broke-codex.md`)已通过 state-replay 架构(2026-05-17)修干净 — alt-buffer 期间 xterm 自带光标按 `?25l` 正确隐藏,**不会再多出来一个**。本工单要解决的是另一个独立问题:**candidate window 的定位漂移**,根因和现象都不一样。

IME-1(`docs/issues/ime-1-chinese-ime-stale-textarea-flush.md`)的 workaround 只在 compositionend 之后 16ms 清空 `textarea.value`,**完全不动 textarea 的 style.top / style.left**,跟本工单的「composition 期间位置漂移」是正交的两个 race 路径。

排查时验证过的几条「可能是我引入的」嫌疑(全部排除):

| 怀疑路径 | 是不是元凶 | 证据 |
|---|---|---|
| `attachImeCompositionEndCleaner` | 不是 | 只在 compositionend 之后 16ms 改 `value`,不动 `style`;且此时 `_isComposing=false`,xterm 不再 reposition |
| IME PROBE A/B | 不是 | 纯只读 listener + ring buffer push,完全不碰 DOM |
| CURSOR-1 state-replay | 不是 | 只影响重挂时的 ANSI 注入,跟运行期每帧 `onRender` 完全无关 |
| FLK-10 `cursorBlink` 切换 | 不是 | 改 `term.options.cursorBlink`(闪不闪),不影响 textarea 定位 |

## 根因

`@xterm/xterm@5.5.0` 的 `CompositionHelper`(`node_modules/@xterm/xterm/lib/xterm.js`,反混淆后):

```ts
// Terminal 构造里注册:每一帧 onRender 都触发
this.register(this.onRender(() => this._compositionHelper.updateCompositionElements()));

// updateCompositionElements 内部 — 仅在 composition 期间生效
updateCompositionElements(skipRecurse) {
  if (this._isComposing) {
    if (this._bufferService.buffer.isCursorInViewport) {
      const x = Math.min(this._bufferService.buffer.x, cols - 1);
      const top = this._bufferService.buffer.y * cellHeight;
      const left = x * cellWidth;
      this._compositionView.style.left = left + "px";
      this._compositionView.style.top = top + "px";
      // ... 还有 textarea 的 style.top / left / width / height
      this._textarea.style.top = top + "px";
    }
    // 自递归 — composition 期间几乎是「忙轮询」反复刷位置
    skipRecurse || setTimeout(() => this.updateCompositionElements(true), 0);
  }
}
```

也就是说:**composition 期间 xterm 每一帧 + 每个 setTimeout(0) tick 都把 `.xterm-helper-textarea` 重新贴到「**此刻**的 `buffer.x` / `buffer.y`」对应像素坐标**。

Claude Code 这类应用绘制 spinner 的常见套路:

1. `\x1b[s` 或 `\x1b 7` — save cursor
2. `\x1b[N;Mf` — 移到 spinner 角落
3. 写 spinner 字形
4. `\x1b[u` 或 `\x1b 8` — restore cursor

在 1-4 这几个字节之间的任意时刻,xterm 的 buffer cursor 就在「spinner 角落」。xterm render 不是「等 PTY 全部消化完再画」的语义,所以 cursor 会在 spinner 位置和真实输入位置之间反复抖动 — 哪一帧抓到哪个位置就贴哪。

Windows 输入法的候选框定位是跟随**当前 focused editable element 的 caret bounding rect**(IMM/TSF 通过 `ITfContextOwnerCompositionSink` 取 input scope),xterm 把 helper-textarea 移到哪,IMM 就把候选框定位到哪。**链路一通到底,所以肉眼可见地跟着 spinner 跳**。

## 修法

不动 xterm 源码(`@xterm/xterm` 5.5.0 / 当前 master 这块代码均未修改,且涉及 IRenderService / IBufferService 私有 DI,fork 维护成本高)。改成在 renderer 一侧做**位置锁定**:

1. 在 `term.open()` 之后,通过 `term['_core']._compositionHelper` 拿到 helper 实例
2. monkey-patch `updateCompositionElements`:进入 composition 时锁定一份 `{ x, y }`,之后每次调用都把 `bufferService.buffer.x / y` 临时换成锁定值,调原实现,再换回来 — finally 保证不污染 xterm 自己的状态
3. compositionstart 触发时拍快照,compositionend 触发时解锁

行为对比:

| 时机 | 改前 | 改后 |
|---|---|---|
| composition 起始 | textarea 贴到当前 cursor → 正确 | 同 — 锁位生效在第一次 update |
| composition 进行中,TUI 重绘移动 cursor | textarea 跟着抖 | textarea 锁在 composition 起点,**不抖** |
| composition 进行中,**用户**正常移动 cursor(比如 IME 选词触发 PTY 字符,cursor 推进) | textarea 跟着走 | textarea 不动 — **次要权衡**,但 composition 短期内 cursor 推进很小,且候选框就在原位反而更易读 |
| compositionend 之后 | textarea 留在最后 update 位置,下次 composition 开始才重定位 | 同 — 解锁后行为完全恢复 xterm 默认 |
| 非 composition 期间 | xterm 不 reposition | 同 — patch 内 early-return 走原实现 |

## 为什么用 monkey-patch 而不是其他方案

| 方案 | 评价 |
|---|---|
| **A. monkey-patch `_compositionHelper.updateCompositionElements`(本次实施)** | 私有 API,但跟 `xterm-serialize-mode-polyfill.md` 是同一组妥协,已经形成「xterm 升级时一并 verify」的工作流 |
| B. fork @xterm/xterm 改 CompositionHelper | 维护成本高;CompositionHelper 还涉及 `_dataAlreadySent` / `_finalizeComposition` 状态机,fork 后要跟上游各种 patch,ROI 低 |
| C. 给 helper-textarea 用 CSS `transition: top 0.2s` 平滑过渡 | 治标 — 抖动期间候选框还是会缓慢漂走,且候选框是 OS 级窗口,CSS transition 对它弹位位置查询不生效 |
| D. 监听 `compositionstart/update/end` 自己改 `style.top/left` | 与 xterm 的 `setTimeout(0)` 自递归 race,需要在每一拍后竞速覆盖,逻辑比 monkey-patch 还脏 |
| E. 强制 `_isComposing` 期间 `buffer.isCursorInViewport=false` | 副作用面更大,会影响 xterm 渲染对光标可视性的判定 |

## 风险

- 私有 API `_core._compositionHelper`:xterm 升级时可能改名 / 改结构。**护栏**:
  - patch 入口包 `try/catch`,失败只 console.warn,不阻塞挂载 — 退化为 xterm 默认行为,不至于让 IME 不可用
  - 单测覆盖「helper 不存在 / updateCompositionElements 不是函数 / bufferService 字段缺失」三个 fallback 路径
  - 工单留一行「xterm 升级 verify checklist」,跟 `xterm-serialize-mode-polyfill.md` 同样的对接方式
- 与 IME-1 workaround 的相互作用:两个 workaround 都挂在同一个 `.xterm-helper-textarea` 上,但 IME-1 监听 `compositionend` 改 `value`,IME-2 监听 `compositionstart/end` 拍/释快照,事件不冲突 — 单测会覆盖两个 listener 共存的情形(在 TerminalView 手测层面也容易看出来)

## 实施清单

- `src/shared/ime-composition-position-lock.ts` — 纯函数 + duck-typed 接口
- `src/shared/ime-composition-position-lock.test.ts` — 护栏测试
- `src/renderer/components/TerminalView.tsx` — `term.open()` 之后 attach,useEffect cleanup 时 detach

## xterm 升级 verify checklist(下次升 xterm 时执行)

1. `grep -n "updateCompositionElements" node_modules/@xterm/xterm/lib/xterm.js` 仍找得到
2. `_core._compositionHelper` 仍是 `Terminal` 实例的可访问字段
3. `_bufferService.buffer.x / y` 字段名未变(serialize polyfill 也依赖,可以一次性 verify)
4. 跑 `npm test -- ime-composition-position-lock` 通过
5. 手动复现:Claude Code 内开中文 IME 打字,候选框应稳定在输入位置,不跟 spinner 跳
