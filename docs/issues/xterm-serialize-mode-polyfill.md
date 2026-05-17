# XTERM-SERIALIZE-POLYFILL · `@xterm/addon-serialize@0.14.0` 模式覆盖不全的本地补丁追踪

**状态**:已知 polyfill,**等待上游 stable 切版本后删除**
**优先级**:P2(不影响正确性,只占两条 internal API 引用)
**首次记录**:2026-05-17
**关联**:CURSOR-1 / BETA-019(根治依赖 SerializeAddon 状态重建)

---

## 背景

CURSOR-1 / BETA-019 的真因是 main 端 `managed.scrollback: Buffer`(2MB ring,
`session-manager.ts:SCROLLBACK_LIMIT`)从头部 `\n` 边界裁切时把 alt-buffer 进入
指令 `\x1b[?1049h` / 光标隐藏指令 `\x1b[?25l` 等模式 setter 切掉,renderer 重挂
时拿到的字节流缺关键模式状态,xterm 重放后落不到正确 buffer / 光标状态。

根治方案:`getScrollback` 不再返回裸字节流,改为用 `@xterm/addon-serialize` 从
`headlessTerm`(每 session 一份 `@xterm/headless` 状态机镜像)序列化出**当前状
态的完整 ANSI 重建流**,renderer 写到 xterm 即恢复到字节级等价的状态。

## 问题

stable `@xterm/addon-serialize@0.14.0` 的 `_serializeModes` **不覆盖**两条对
TUI 应用至关重要的状态:

1. **光标可见性(`?25l` / `?25h`,DECTCEM)** — Claude Code / Codex / vim 在启动
   时发 `?25l`,如果不重建,重挂后光标可见且闪烁(正是 BETA-019 现象)
2. **滚动区域(`\x1b[<top>;<bot>r`,DECSTBM)** — vim / nano / less 等设过非默认
   滚动区的应用,重挂后滚动行为错

upstream master 已修(见 `addons/addon-serialize/src/SerializeAddon.ts` 的
`_serializeModes` 和 `_serializeScrollRegion`),但**仅在 `0.15.0-beta.*` 线发布,
stable 线 `0.14.0` 自 2024 年起未切换过**。

## 当前 polyfill 位置

`src/main/session-manager.ts` 的 `getScrollback`(或同等位置)在 SerializeAddon
输出末尾追加两条字节:

```ts
// XTERM-SERIALIZE-POLYFILL:0.14.0 stable _serializeModes 不覆盖光标可见性
// 与 DECSTBM,master / 0.15.0-beta 已修。直读 headless 内部状态补两条。
const core = (managed.headlessTerm as unknown as { _core?: {
  coreService?: { isCursorHidden?: boolean };
  buffer?: { scrollTop?: number; scrollBottom?: number };
} })._core;

let supplement = '';
if (core?.coreService?.isCursorHidden) supplement += '\x1b[?25l';
const top = core?.buffer?.scrollTop;
const bot = core?.buffer?.scrollBottom;
if (top !== undefined && bot !== undefined &&
    (top !== 0 || bot !== managed.headlessTerm.rows - 1)) {
  supplement += `\x1b[${top + 1};${bot + 1}r`;
}
```

这两条**字节级**等价于 master SerializeAddon 的对应实现,不是猜测式 workaround,
是**polyfill 性质的精确反向移植**。

## 与 BETA-019 类 workaround 的本质区别

| | BETA-019 workaround | 本 polyfill |
|---|---|---|
| 是否知道真因 | 否,凭"alt-buffer = 不要 blink"启发式 | 是,直读状态机字段 |
| 输出正确性 | 5% 错误率(用户实测仍闪) | 100% 正确(与 master SerializeAddon 字节级一致) |
| 依据 | 推测 | upstream master 源码 + BETA-019 第二轮已验证 `isCursorHidden` 可读 |

判定:这个 polyfill 写完后**不算引入新 workaround**,但**polyfill 数量必须保持 ≤ 2 个**。任何后续新 polyfill 出现意味着 stable 线被 upstream 完全遗弃,触发"升 beta"动作。

## 删除条件(以下任一满足即可)

**条件 A:`@xterm/addon-serialize` stable 出 ≥ 0.15.x 版本,且 `_serializeModes` 包含 cursor 可见性和 DECSTBM**

验证步骤:
1. `npm view @xterm/addon-serialize@latest version` ≥ `0.15.0`
2. 升级,re-run `scripts/repro-cursor-1.mjs`,close+reopen Marina 窗口
3. 在 `getScrollback` 临时 log 输出 SerializeAddon 原生 output,确认含 `\x1b[?25l` 和 DECSTBM(当对应状态成立时)
4. 确认后 → 删除 `session-manager.ts` 中的 polyfill 段(grep `XTERM-SERIALIZE-POLYFILL` 找位置)
5. 删除本 issue

**条件 B:Marina 主动升 xterm 栈到 6.1.0-beta.x 系列**

`@xterm/xterm` 6.0.0 stable 自 2023-11-01 起两年多未更新,实际活跃版本在
`6.1.0-beta.x`。若 Marina 决定主动升 beta(可能因其他原因,如某 addon 修了
我们关心的 bug),顺手把本 polyfill 删掉:beta 版 0.15.0-beta.x 原生覆盖
`?25l` 和 DECSTBM。

升级 checklist(以 219 系列为例):
- `@xterm/xterm@6.1.0-beta.219`
- `@xterm/headless@6.1.0-beta.219`
- `@xterm/addon-fit@0.12.0-beta.219`
- `@xterm/addon-search@0.17.0-beta.219`
- `@xterm/addon-web-links@0.13.0-beta.219`
- `@xterm/addon-webgl@0.20.0-beta.218`(注意:webgl 是 .218,不是 .219)
- `@xterm/addon-serialize@0.15.0-beta.219`

升级回归重点(基于 BETA-003 经验,WebGL 升级风险最大):
- Linux DOM renderer 兜底是否仍按预期跳过 WebGL
- xterm 5→6 是否有破坏性 API 变更(初步看仅扩展,需读 changelog)
- 全套渲染 / 字号 / 主题 / 搜索 / fit / 复制粘贴回归

## 不删除的红线

**不要为了"洁癖"在 polyfill 尚未失效时主动升 beta**。两条 internal API 引用的
维护成本远低于 7 包大版本升级的回归测试成本。只有出现下述情况时升 beta:

- polyfill 数量增长到 ≥ 3 个(意味着 stable 已显著落后)
- 出现另一个只能在 beta 里修的 bug
- upstream 宣布 stable 线归档

## 上游追踪

- `@xterm/addon-serialize` stable 发布历史: `npm view @xterm/addon-serialize versions`
- master SerializeAddon 源: `https://github.com/xtermjs/xterm.js/tree/master/addons/addon-serialize`
- 本 polyfill 字节级参考: `_serializeModes` 中 `if (!modes.showCursor) content += '\x1b[?25l'` 和 `_serializeScrollRegion` 整段

每 2-3 个月检查一次 stable 发布情况;若 ≥ 0.15.0 stable 出来,触发条件 A 流程。
