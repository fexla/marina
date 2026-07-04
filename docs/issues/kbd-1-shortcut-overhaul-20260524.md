# KBD-1 键盘交互全面整改

**日期**:2026-05-24
**状态**:已实施(branch `fix/kbd-overhaul-20260524`)
**触发原因**:用户反馈"软件的快捷键还有诸多问题",回看代码 / spec / PR 发现多处架构性硬伤,做一次无妥协的全面整改

---

## 症状清单

| # | 症状 | 影响 |
|---|------|------|
| 1 | Windows 上 Ctrl+V 不粘贴,反而发 `0x16` (Unix literal-next) 给 PTY | 用户必须右键菜单粘贴 / 语音输入程序(智模 / 闪电说)在终端中完全不工作 |
| 2 | Ctrl+Shift+V / Shift+Insert 双倍粘贴(内容发两遍) | 命令重复执行 |
| 3 | Ctrl+Shift+C / Ctrl+Insert 复制后**不清选区**,下次按 Ctrl+C 走复制分支不发 SIGINT | 死循环 / 卡住的进程无法中断,用户必须关 tab |
| 4 | 键盘 handler 是一段 60 行的嵌套 if/else,6 处早返 / 5 个特例 | 加新键位易漏改,spec / 代码 / UI 三处来源不一致 → 漂移 |
| 5 | Modal / ContextMenu 各自挂 window keydown listener 拦 Esc,无优先级 | 多 overlay 嵌套时 Esc 由"注册顺序的隐式优先级"决定,不可预测 |
| 6 | Modal 全局 keydown 无 IME 守卫,中文 IME 选词的 Enter 被误吃 | 中文用户输入路径名 / shell 命令时 modal 提前关闭 |
| 7 | session 切换 scrollback replay 期间 xterm 把"中间 buffer"画到 canvas | 用户看到刷屏抖动残留 |
| 8 | (#7 修法的隐患)如果只 visibility:hidden 但不 inert,replay 期间用户按键可能进 Sidebar 改名输入框 / Modal 等错位 focus | 按键误进非预期位置 |
| 9 | spec §7.1 / §13.2 写"只支持 Ctrl+C / Ctrl+V / Ctrl+F",代码实际已偏离(加进 Windows Terminal 五件套);spec 与代码不同步 | 新代码无锚,任何 PR 加新键位无判据 |

---

## 根因分析

### 架构层
1. **没有单一权威**:键位定义散落在 `attachCustomKeyEventHandler` 长 handler 内,spec 文档只说"Ctrl+C/V/F",代码实际更多,设置页无速查,三处永远不一致
2. **paste 是双层 listener**:xterm 自己在 helper-textarea 上挂 bubble-phase paste listener 直接送 PTY;Marina 在键盘 handler 内调 `handlePaste()`;两者并存导致双倍 / 漏触发
3. **overlay 无优先级模型**:每个 overlay 各自挂 window keydown,Esc 谁吃靠 React 注册顺序
4. **focus 行为在 replay 期未定义**:visibility:hidden 让 helper-textarea 不能 focus,但没显式 inert,焦点可能漂走

### 实现层
- Ctrl+V 在键盘 handler 里被漏掉,xterm 默认把它当 Unix literal-next 发 0x16
- Ctrl+Shift+C / Ctrl+Insert 没调 `clearSelection()`(对照 Ctrl+C 复制路径有调),导致 SIGINT 失效 bug
- Modal 全局 keydown 没读 `isComposing`,IME 选词 Enter 被误吃

---

## 修复方案

### 阶段 0 — spec 锁定(`docs/软件定义书.md`)
- §7.1:加"§7.2.2 清单是唯一权威来源"的不变式条款
- §7.2.2:写出完整终端键位清单表(Win/Linux + macOS 等价)+ 6 条实现不变式
- §13.2:把"应用内快捷键"扩展为"任何不在 §7.2.2 清单内的键位"

### 阶段 1 — 集成 PR #3 + 三处补强
- capture-phase paste listener:在 helper-textarea 和 container 上都挂,`stopImmediatePropagation` 阻 xterm bubble listener,所有粘贴来源走同一个 `handlePaste()`
- Ctrl+V 在键盘 handler 里 `return false`,阻 xterm 发 0x16,让浏览器自然触发 paste 事件由 capture listener 接管
- 补强:cleanup 显式 `removeEventListener` / IME 不变式注释 / 删本地导出的 `pr3.diff`

### 阶段 2.1 — 修 SIGINT 失效 bug
- `copy-or-sigint` action:有选区→复制+清选区;无选区→透传 ^C
- `copy-and-clear` action(Ctrl+Shift+C / Ctrl+Insert):有选区→复制+清选区;无选区→静默 consume
- 三套复制路径统一清选区,下次 Ctrl+C 永远能发 SIGINT

### 阶段 2.2 — 数据驱动 binding table
- `src/shared/terminal-keybindings.ts`:8 条 binding 集中,`matchKeybinding` 纯函数扫表
- 20 个单元测试覆盖所有键位 + 修饰键守护 + 表结构不变式
- TerminalView 长 handler 退化为"扫表 + switch dispatch",约 50 行

### 阶段 2.3 — Modal IME 守卫
- Modal.tsx `onKey` 首行 `if (e.isComposing || e.keyCode === 229) return;`
- 中文 / 日文 / 韩文 IME 选词的 Enter / Esc 不再被误吃

### 阶段 2.4 — UiOverlayStack
- `src/shared/ui-overlay-stack.ts`:纯命令式核心(push / pop / isTop)
- `src/renderer/ui-overlay-stack.ts`:React hook 包装 `useOverlayRegistration`
- Modal / ContextMenu mount 时 push,unmount 时 pop;keydown 前问 `isTop()` 决定是否吃
- 多 overlay 嵌套时 Esc 永远从最上层关起,行为可预测
- 8 个单元测试覆盖 push / pop / isTop / 乱序 pop / id 唯一性

### 阶段 3 — SCROLL-1 visibility:hidden + inert 双管
- 在 `hostRevealed=false` 期间 terminal-host 同时 `visibility:hidden` + `inert`
- visibility:hidden 消除中间帧暴露(canvas 仍累积像素,fit 仍能算尺寸)
- inert 阻止 focus 落入子树,replay 期间按键不会误进 Sidebar / Modal 等错位 focus
- 产品决策:replay 100-500ms 内按键不响应是有意为之 — 符合"切换中"直觉,避免 typeahead 误发到错位 focus
- React 18 不识别 inert 作为 known prop,在 `src/renderer/global.d.ts` module augmentation 让 TS 接受 `inert={'' | undefined}`(Electron 31 Chromium 126 原生支持 inert)
- reveal 后 useEffect 主动归还 focus 给 helper-textarea

### 阶段 4 — 制度化
- 设置页"行为"分类末尾加"终端快捷键速查"卡片,数据源 = `TERMINAL_KEYBINDINGS`
- `docs/键盘交互规范.md`:开发者实现锚
- 本工单留档

---

## 文件清单

**改**:
- `docs/软件定义书.md` — §7.1 / §7.2.2 / §13.2
- `src/renderer/components/TerminalView.tsx` — binding table + capture paste + SCROLL-1 二次修复
- `src/renderer/components/Modal.tsx` — IME 守卫 + overlay stack 接入
- `src/renderer/components/ContextMenu.tsx` — IME 守卫 + overlay stack 接入
- `src/renderer/components/SettingsView.tsx` — 加 KeybindingsReference 卡片
- `src/renderer/global.d.ts` — inert 属性的 React 18 type augmentation
- `src/renderer/styles/global.css` — .settings-keybindings-* 样式

**新建**:
- `src/shared/terminal-keybindings.ts` + `.test.ts` — 8 条 binding + 20 测试
- `src/shared/ui-overlay-stack.ts` + `.test.ts` — 命令式核心 + 8 测试
- `src/renderer/ui-overlay-stack.ts` — React hook 包装
- `docs/键盘交互规范.md` — 开发者实现锚
- `docs/issues/kbd-1-shortcut-overhaul-20260524.md` — 本文件

**删**:
- `pr3.diff` — 本地导出的 PR 快照,无入仓价值

---

## 验收测试

完整测试说明书见本 PR 描述附带的"测试说明书"章节,涵盖:
- 6 条粘贴路径(Ctrl+V / Ctrl+Shift+V / Shift+Insert / 语音输入 / 右键菜单 / 浏览器粘贴)不双倍
- 复制三套均清选区,SIGINT 永不失效
- IME 选词 Enter 不被 Modal 误吃
- Modal + ContextMenu 嵌套时 Esc 优先级正确
- session 切换 replay 期间按键不进 Sidebar / Modal,reveal 后焦点立刻回终端

---

## 关联

- PR #3 (fexla, 已合入本整改) — 粘贴路径 capture listener
- 历史 SCROLL-1 一次修复 commit `f56ae0a` — fence + scrollToBottom(本次叠加二次修复)
- CPB-C3 — Ctrl+C 残留选区死循环(本次扩展到三套复制路径)
- IME-1 系列 — IME composition 期间按键透传(本次保留)
- spec §7.1 / §7.2.2 / §13.2 — 本次同步更新
