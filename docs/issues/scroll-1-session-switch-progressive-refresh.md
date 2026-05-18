# SCROLL-1 · 切 session 时终端"从上往下刷屏"再到底

**状态**:**已修复(2026-05-18)** — 用 `term.write('', callback)` 作 fence,把 `scrollToBottom()` 放进 callback 内,等 xterm parser 真正 drain 完才锚底。`TerminalView.tsx` mount effect 的两条路径(主路径 + catch fallback)各改一处,并在文件头 `@关键设计` 补"步骤 4 视口锚定"的不变量,防未来再撞同样陷阱。
**优先级**:P1(每次切 tab / 选 session 都看得见,严重影响体感)
**首次报告**:2026-05-16(BETA-018)→ **本次重发现**:2026-05-18(用户日常使用 v0.1.0-beta.7)
**关联工单**:BETA-018(第一次修)、CURSOR-1 / state-replay(根因引入回归)、FLK-1(分片 write 主线程让出)
**关联代码**:
- `src/renderer/components/TerminalView.tsx:1062-1125`(scrollback replay 协议主路径)
- `src/main/session-manager.ts:1034-1089`(`getScrollbackForReplay`,数据源)
- `src/main/session-manager.ts:649-664`(headless terminal + SerializeAddon)

---

## 现象

切到一个已经有内容的 session(切 tab / 点侧栏路径下的 session / 托盘点窗口 focus 过去 / 简易模式切换),终端**不是一瞬间显示"已经在底部"的最终状态**,而是肉眼可见**从顶部开始,一行一行往下刷屏,直到内容铺满才停在底部**。

用户视角(原话):
> "切换到一个新终端之后没有直接从底部显示,而是从上往下刷屏到底部。"

可见度高:scrollback 越长(运行过 Claude Code / 长 npm install / `find /` 等多页输出),刷屏时长越久;短 scrollback 也能感觉到"闪了一下"。

**关键不是数据丢失**:刷屏完成后内容、光标位置都正确;问题只在**视觉过渡**。

---

## 与历史几次"已修"的关系(为什么是回归)

| 工单 | 时间 | 改动 | 当时是否修好 |
|---|---|---|---|
| **BETA-018** | 2026-05-16 commit `510e773` | `TerminalView.tsx` scrollback replay 主路径 + catch fallback 末尾各加一行 `term.scrollToBottom()`。注释明说"消除从上往下刷屏观感"。 | ✓ 当时通过用户测试 |
| **FLK-1**(更早) | — | 把 scrollback 一次性 write 拆成 16KB 分片 + `setTimeout(0)` 让出主线程,避免 2MB 同步阻塞 100-300ms。 | 不是修这个 bug,但**为后来回归埋了引信** |
| **CURSOR-1 Step 2** | 2026-05-17 commit `005ab41` | `cmd:session:get-scrollback` 数据源从 main 端裸字节 ring buffer 切到 `getScrollbackForReplay` → SerializeAddon 序列化的"完整状态 ANSI 流"。 | 顺手把 BETA-018 的 scrollToBottom 失效了 |
| **CURSOR-1 Step 4** | 2026-05-17 commit `0f8010f` | 删掉 main 端裸字节 ring,只留 state-replay 一条路径。 | 同上 |

`scrollToBottom()` 的代码**今天还在** — `TerminalView.tsx:1115` 和 `:1124` 两处都没动。所以是"修复代码原地不动,但根因变了导致它失效",不是"修复被改掉了"。

---

## 根因分析

### 数据流(切 session 时,TerminalView mount 路径)

```
MainPane.displayable 变 → React 用 key={displayable.id} 重建 TerminalView
  → new Terminal({...}) + term.open(container) + WebGL/DOM renderer load
  → IPC cmd:session:get-scrollback
       (main: flushPendingEmit → drain headless parser → addon.serialize({scrollback:5000})
        → 返回 base64 ANSI 字节流 + lastSeq)
  → 主路径 .then:
       for chunk in 16KB chunks:
         term.write(chunk)        ← 异步排队进 xterm writeBuffer,不阻塞
         if 还有下一片: await setTimeout(0)   ← 让 RAF 跑、xterm 渲染、用户看见
       term.scrollToBottom()       ← BETA-018 兜底
```

### `term.write()` 的关键事实(`@xterm/xterm@5.5.0` 官方 d.ts:1216)

```ts
/**
 * @param callback Optional callback that fires when the data was processed
 * by the parser.
 */
write(data: string | Uint8Array, callback?: () => void): void;
```

**`term.write()` 是异步的**:它把字节排进 xterm 内部 `writeBuffer`,parser 用 `setTimeout(0)` / RAF 分批消化。**调用返回时,数据通常还没解析**;只有 callback 触发时才真正落到 buffer / 屏幕。

### 因此 `scrollToBottom()` 的位置错了

现行代码:

```ts
for (let i = 0; i < all.length; i += CHUNK) {
  term.write(all.subarray(i, i + CHUNK));
  if (...) await new Promise((r) => setTimeout(r, 0));
}
// pending bytes...
term.scrollToBottom();   // ← 这一行在哪一刻执行?
```

**`scrollToBottom()` 执行的瞬间**:
- 所有 `write()` 调用都已发出,但 xterm 的 parser **正在分批消化 writeBuffer**
- 当前 buffer 里只有"已经被 parser 处理完"的那部分行
- 屏幕上显示的就是 buffer 当前状态
- 此后 parser 继续吃后面的字节、不断往 buffer 追加行,**自动 follow 把视口跟到新底部**

视觉上:用户看到的不是"瞬间到底部",而是"已写入的内容滚到底,然后剩余字节继续解析、行不断往下推",**正好就是"从上往下刷屏"的体验**。`scrollToBottom()` 等于没解决问题,因为它锚定的"底部"还在动。

### 为什么 BETA-018 当时能修好(旧架构下的偶然)

CURSOR-1 之前,`getScrollback()` 返回的是 **main 端 ring buffer 里的裸 PTY 字节**(2MB 上限,按 \n 边界裁切)。这条流的特点:

1. **量更小**:大多数 session 没攒到 2MB,常见在几十到几百 KB,**单片(16KB)一过完**就够,根本不进 `await setTimeout(0)` 分支(`if (all.length > CHUNK && i + CHUNK < all.length)` 不成立)
2. **解析快**:裸 PTY 输出含大量 plain text,不像 SerializeAddon 输出的"SGR 重置 + 移动光标 + 写一行 + 重复 N 次",parser 单次循环消化掉
3. 因此 `scrollToBottom()` 调用时,parser 通常已经 drain,viewport 直接到底,看起来"一瞬完成"

CURSOR-1 之后,`getScrollbackForReplay()` 返回的是 **SerializeAddon 序列化的完整状态 ANSI 重建流**:

1. **量更大**:`serialize({ scrollback: 5000 })` 几乎一定输出几十~几百 KB,**触发多次 chunk + yield**
2. **解析慢**:每行通常有完整 SGR 前缀 + 内容 + 重置,parser 状态机要走更多步
3. + 末尾 polyfill 还追加 `\x1b[?25l` / DECSTBM 等模式 setter

= **每次切 session 都稳稳触发分片渲染**,scrollToBottom 错位的失效从"偶发"变成"必现"。

### FLK-1 的角色 —— 放大器,不是根因(不要回滚)

回归一出,直觉会想"是不是 FLK-1 那个分片把 scrollback 写散了才有刷屏的?把 FLK-1 回滚不就好了?" 答案:**不要回滚**。

FLK-1(commit `493b2e5`,2026-05-14)做的事:把原来 `term.write(decodeBase64ToBytes(res.data))` 一把同步写,改成 16KB 一片 + 片间 `await setTimeout(0)` 让出。自报修复:"切 session 后黑屏一下,然后内容瞬间涌出" + "期间用户敲键的回显也能正常显示"。

不回滚的三条理由:

1. **FLK-1 修的是另一个真问题**:大 scrollback session(alt-buffer 应用 / 长 npm install 输出)切 tab 时主线程独占 100-300ms。`term.write()` 调用本身是异步排队,但 xterm 内部 `_innerWrite()` 在没让出时会"吃满预算"才回让事件循环;我们插的 `setTimeout(0)` 是把 RAF / IPC / 用户敲键的处理窗口塞进来的明确边界。回滚就把这个收益丢了。

2. **回滚解决不了 SCROLL-1 的根因**。根因是 `scrollToBottom()` 在 `term.write` queue 还在排队时就跑了,**与是否分片无关**:
   - 有 FLK-1:我们 yield + xterm time-slice → ~10-20 帧渐进渲染 → **明显**从上往下刷屏
   - 无 FLK-1:xterm 自己 time-slice → ~5-10 帧渐进渲染 → **短暂**闪一下,bug 仍在,只是"明显"变"轻微"
   - 唯一彻底消除渐进渲染的路径是同步一次性 write —— **正是 FLK-1 之前的状态**,带回 100-300ms 主线程卡顿

3. **FLK-1 没解决的部分另说**:`decodeBase64ToBytes(res.data)` 是 await 之前的同步解码,2MB base64 仍 ~50-100ms 一次性。但这是另一回事(若需要可走 OffscreenCanvas / Worker / `atob` 替代),与 SCROLL-1 不耦合。

**正确做法**:留 FLK-1,把 `scrollToBottom` 移进 fence callback,两件事不打架。

---

## 复现步骤

环境:Marina v0.1.0-beta.7 Windows 11(WebGL renderer),PowerShell 7。

1. 启动 Marina,新建一个 session
2. 跑一个产生足够 scrollback 的命令,例如:
   ```pwsh
   1..2000 | % { "line $_  $(Get-Random)" }
   ```
   等输出跑完
3. 新建第二个 session(随便)
4. 在 tab bar 上**切回第一个 session**
5. 观察:不是"一瞬间显示底部",而是**从顶端开始,文字一行一行往下铺,过 0.2~1s 才稳定在底部**

辅助验证(放大效果):
- 跑 `Get-ChildItem -Recurse C:\Windows\System32 -ErrorAction SilentlyContinue | Select-Object -First 5000` 等爆量输出
- 在 `Modal.confirm`(开发者工具 Performance / 性能面板)里录一段 → 帧序列可以直接看到 `xterm-screen` canvas 自上而下增长

不必走 alt-buffer 应用(vim / Claude Code)— **plain shell 的长输出就够触发**,这次回归不挑场景。

---

## 实施的修复(2026-05-18)

### 思路:`term.write('', callback)` 作 fence

xterm 的 `write(data, callback?)` 契约:callback 在**parser 处理完该 chunk 之前的所有 queued 字节**后触发。空 chunk 也走 FIFO 顺序,这是一个轻量的 drain fence — main 端 `session-manager.ts:1051-1053` 在 `getScrollbackForReplay` 里已经用同样模式 await headless parser drain,我们直接把这个 idiom 搬到 renderer 端。

代码改动(`src/renderer/components/TerminalView.tsx`):主路径与 catch fallback 各把末尾的:

```ts
// 旧 — 错位调用
replayed = true;
term.scrollToBottom();
```

改成:

```ts
// 新 — 用空 write 作 fence,callback 在 parser drain 后才触发
replayed = true;
term.write('', () => {
  if (disposed) return;
  term.scrollToBottom();
});
```

关键属性:

- **保留 FLK-1 的所有让出**:scrollback chunks 仍走 16KB + `setTimeout(0)` yields,主线程响应度不变
- **保留 pending 字节的 seq 过滤**:fence 在 `for (const c of pending)` 之后,所有 pending 写也排在 fence 前,callback 真正等到全部 drain
- **disposed 兜底**:fence callback 异步触发,期间组件可能卸载(用户切快了 / 关窗了),不查 disposed 直接调 scrollToBottom 会 throw

### 防回归的结构性保护

仅靠"在这里加个注释"不够 — CURSOR-1 当时改数据源时没意识到 BETA-018 的 scrollToBottom 是隐式依赖"数据量小到 parser 单帧能 drain"才生效的。这次留三道护栏:

1. **文件头 `@关键设计 Scrollback 重放协议` 块新增"步骤 4 视口锚定"**:明文写"scrollToBottom 必须在 fence callback 内,绝不在 `.then` 体里直接调";顺手把"`term.write()` 是异步排队"这条 xterm API 事实记进去,免得未来读代码的人(或 LLM)再误以为 write 是同步的。

2. **fence 调用处的注释**:本地长注释解释"为什么是 callback,不是直接调",并点名 SCROLL-1 工单号,git blame 一拉就到本文。

3. **本工单文档的"旁注"段保留**:任何未来改 scrollback 数据源(目前只有 `getScrollbackForReplay` 一条;若以后多一条增量 patch / 二进制快照路径),实施前都要回看本文档评估"我的新流是否破坏 fence 假设"。

不做的事:
- 不在 renderer 加 unit test —— 违反 `AGENTS.md` 5.1 节"`src/renderer/` 不需要测试"
- 不拆抽象 / helper function —— 当前两条路径(主 / catch)共 8 行,抽出函数不偿成本,且违反 7.1 "已通过的代码非必要不重构"原则
- 不动 FLK-1(理由见上一段)

---

## 测试卡点(开发者验证)

- [ ] 短 scrollback(< 16KB,如刚启动的 session):切回看上去和不切一样
- [ ] 中 scrollback(2000 行 plain text):切回**视觉无刷屏**,直接稳定在底部
- [ ] 长 scrollback(5000 行混合 SGR / `find /` 级量):切回**视觉无刷屏**,主线程不卡(可在 Performance 面板看 long task < 50ms)
- [ ] alt-buffer 应用(vim / Claude Code REPL 进行到中段):切回 viewport 落在 alt-buffer 当前状态,光标位置正确(CURSOR-1 不变量保留)
- [ ] Linux DOM renderer 路径同样 OK(`isLinux` 跳 WebGL 分支)
- [ ] catch fallback(`get-scrollback` rejected)路径同样 OK
- [ ] 切快(开 session 立刻切走):fence callback 触发时组件已 dispose,`disposed` 兜底生效,无 throw
- [ ] **不要回退** BETA-018 注释中的"重放是同步内容回灌,不是历史浏览,应当锚定底部"的不变量

---

## 旁注:防止下次再回归

- `getScrollbackForReplay` 的输出体积**结构性大于**旧裸字节路径,任何"切 session viewport"相关的 fix 必须假设流是几十~几百 KB、必然走分片
- 如果未来再有人改 scrollback 数据源,**心里要带一个问题**:"我变之后,`term.write` 在 fence 之前能 drain 完吗?" 不能,就要补 callback 或 visibility 兜底
- 这条认知值得沉淀进 `TerminalView.tsx` mount effect 的注释里(`@关键设计` 区块新增一条 "Scrollback replay 与视口锚定")
