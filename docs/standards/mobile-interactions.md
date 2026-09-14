# 移动端交互规范(Android 壳,ADR-042)

> **这是长期维护的规范文档,不是一次性设计稿。** 任何触及移动端(安卓壳 /
> 共享 renderer 的移动布局)的改动,先读本文档对应章节;做出的新交互决策
> 必须回写到这里 —— 包括「踩过的坑为什么这么定」。移动端交互的漂移
> (各界面各玩各的)比某个单点 bug 伤害更大。
>
> 版本:1.0(2026-09-14 建立,源于用户第二批勘误)
> 变更历史见文末。

## 0. 背景与原则

Marina 安卓端是**纯远程客户端**(ADR-042):复用桌面 renderer 源码,通过
CSS 媒体查询 + 少量 `useIsMobile()` 分支适配窄屏。这带来一个结构性约束:

- **交互逻辑必须有单一真相源**:同一件事(返回、唤起键盘、打开面板)在
  PC 和手机上是同一个组件/同一个数据源,只允许「形态」不同(双栏→单栏、
  常驻→浮层),不允许「行为」分叉(手机另建一套状态或数据源)。用户对
  一致性的预期 = 「PC 上有的,手机上以可用的形态都有」。

## 1. 布局断点

| 朝向/设备 | 判定 | 布局 |
|---|---|---|
| 竖屏手机/竖屏平板 | `max-width: 900px` | 移动布局 |
| 横屏手机(如 914x411) | `(max-height: 500px) and (orientation: landscape)` | 移动布局 |
| 横屏平板/桌面窗口 | 其余 | 桌面三栏 |

**断点必须两处同步改**:`src/renderer/mobile.ts` 的 `QUERY`(JS 判定,
`useIsMobile`)与 `apps/mobile/src/mobile.css` 的媒体查询(CSS 判定)。
只改一处 = JS 布局分支与 CSS 样式漂移(踩过:横屏手机 JS 走桌面、CSS 隐藏
标题栏,界面四不像)。

桌面 Electron 窗口命中断点时也走移动布局 —— 这是特性(响应式),不是 bug。

## 2. 返回键层级(back-bus)—— 核心交互

安卓返回键(含手势)是移动端的「撤销」原语。**规则:一次返回 = 退一层,
永远不直接杀 app**(终端会话在 PC 上跑,杀 app 是误伤;回后台用
`moveTaskToBack`)。

### 2.1 层级表(从顶到底,一次 back 退一层)

| 层 | 状态 | back 动作 |
|---|---|---|
| 1 | 设置:分类内子页(如模板编辑器) | 关子页 |
| 2 | 设置:分类详情页(移动单栏) | 回分类列表 |
| 3 | 设置:分类列表 | 退出设置 |
| 4 | 侧栏抽屉开 | 关抽屉 |
| 5 | 面板 dock 展开(overlay) | 折叠 dock |
| — | 软键盘开 | **系统 IME 先消费**(收键盘),不进本链路 |
| 底 | 无浮层 | `moveTaskToBack` 回后台 |

### 2.2 实现(marina-back 事件总线)

```
MainActivity.onBackPressed
  → evaluateJavascript("window.__marinaAndroidBack()")
    → main.tsx: dispatch 'marina-back'(cancelable CustomEvent)
      → 各浮层组件按层级消费(preventDefault = 消费)
    未消费 → moveTaskToBack
```

**层级顺序的实现约定(关键,新浮层必须遵守)**:

- 消费用 `preventDefault`;每个 handler 先检查 `e.defaultPrevented`。
- **capture 阶段 = 「设置层 + 抽屉层」**(App 的抽屉 handler 注册最早,
  `inSettingsView` 时放行;SettingsView/子页 Panel 用 `{capture:true}`,
  同阶段按注册序 = React mount 序「子先父」,天然子页→详情→列表)。
- **bubble 阶段 = dock 层**(LayoutHost,最低层)。
- **看不见的浮层不消费**:移动端设置的单栏详情是 CSS 位移隐藏、组件不
  卸载 —— 子页 Panel 必须用 `mobileDetailOpen` prop guard,否则会「关一个
  看不见的子页」,用户按返回没反应(踩过)。
- 桌面 UI 上的等价按钮(如设置 header 的 ‹)必须 dispatch 同一个
  'marina-back' 事件,不许直接改状态 —— 保证点按钮和按返回键行为一致。

## 3. 系统栏(状态栏/手势条)

- 原生壳用 `setDecorFitsSystemWindows(true)` 回退 edge-to-edge(targetSdk
  35 起默认强制,而 WebView 里 `env(safe-area-inset-*)` 恒为空,CSS 拿不到
  避让量,内容被状态栏盖住 —— 踩过,别改成「注入 inset 变量」方案,
  decorFits 还顺带恢复 adjustResize)。
- mobile.css 里保留 `env(safe-area-inset-*)` 兜底(浏览器端调试时有用)。

## 4. 软键盘

- 布局收缩:`--marina-mobile-vh`(= visualViewport.height)由
  `useMobileViewportFix` 写到 :root,`.app-body.mobile` 用它作高度。
  decorFits 模式下 WebView 真实 resize,vv.height 跟随,同一机制兼容。
- **键盘开合判定用基线法**(`subscribeMobileViewport`):本朝向的最大高度
  为基线,当前低于基线 15%(且 >120px)= 开。不要用 `innerHeight - vv.height`
  (decorFits 两种模式下该差值行为相反,踩过)。
- 键盘开时:隐藏浮球(`.mobile-keyboard-open` 类)、活跃终端 scrollToBottom。
- **tap 终端画布唤起键盘**:xterm 的 touch 处理会吃掉 tap 默认行为,合成
  click 不派发 → textarea 不 focus → 键盘唤不起(踩过)。TerminalView 在
  capture 阶段监听 touchstart/move/end,识别单指短 tap 后主动 focus
  helper-textarea(**必须在用户手势上下文内**,脱离手势的 programmatic
  focus 在 Android WebView 不弹 IME)。改 xterm 容器交互时别删这段。

## 5. 触屏通用规则

- 触摸目标 ≥ 44px(桌面 8px padding 的按钮在移动端要覆写)。
- **触屏无 hover**:Chromium 触屏 tap 会触发 `:hover` 并粘滞到点别处。
  移动端样式里用 `@media (hover: none)` 把 hover 效果还原为常态,按压反馈
  用 `:active`(踩过:返回后按钮停留红色 hover 态,用户以为是坏按钮)。
- 双指 = 调字号(TerminalAuxBar 的 `usePinchFontSize`,原生 passive:false
  监听 —— React 合成 touch 在 WebView 下 preventDefault 不可靠);xterm
  区域 `touch-action: pan-y`(禁浏览器页面缩放,单指滚动保留)。
- 长按 = 右键(规划中,尚未实现:文件树/终端链接/`session` 操作的触屏
  入口。实现时:模拟 contextmenu 事件或自建长按菜单,规则回写本节)。

## 6. 终端辅助键条

- 底部一排横向滚动:Esc / Tab / 方向 / PgUp / PgDn / Home / End /
  Ctrl+C / Ctrl+D / Ctrl+Z / Ctrl+L。字节直发 `SESSION_SEND_INPUT`
  (与物理键同路)。
- 渲染条件:移动布局 + 有活跃 session;挂在 `.terminal-workspace`
  (Deck 的兄弟层 —— deck-slot 是 absolute inset:0,放 Deck 内会被盖)。
- **方向键发 CSI 序列**(`\x1b[A` 等);应用程序光标模式(DECCKNM,vi 等)
  的 SS3 序列差异是已知简化,用户反馈强烈再改(需读 xterm 内部状态)。

## 7. 设置页(移动单栏)

- 两级导航:分类列表(全宽)→ 详情页(translateX 滑入)。header 左按钮:
  详情层 ‹(走 back-bus)/ 列表层 ×(退出设置)。
- **移动端隐藏依赖桌面本机能力的分类**(`MOBILE_HIDDEN_CATEGORIES`):
  system-integration / advanced / remote(对应命令在 mobile shim 报
  notSupported;profile 管理由 MobileBoot 连接页承载)。新增分类时判断:
  它的所有命令要么 local-control 已实现、要么 backend-data 天然远程,
  否则加进隐藏集合 —— 不给用户看死按钮。

## 8. 面板(文件树/Git/已打开)

- 移动端不参与水平 split(桌面 280px 下限会把终端挤成 12 列),改为
  **右缘全高 overlay**(宽 `min(92vw, 420px)`),collapsed 态 = 右缘把手。
- dock 展开/折叠状态沿用 per-session 持久(`SESSION_UPDATE_UI_LAYOUT`),
  与 PC 完全同一数据源 —— 这就是「一致性」:手机上展开的面板,PC 同
  session 也是展开的。
- resize 拖条隐藏(触屏无 mouse);返回键折叠(back-bus 第 5 层)。

## 9. 一致性检查清单(改移动端时过一遍)

1. PC 上有的功能,手机上能用吗?(能用=形态可不同;不能用=要么实现,
   要么明确裁剪并记在本文档)
2. 数据源是同一个吗?(收藏/模板/设置都来自 daemon 单流;不得在手机上
   另存一份)
3. 返回键对新加的浮层生效吗?(按 2.2 接入 back-bus)
4. 键盘弹出时新界面还可用吗?(`--marina-mobile-vh` 链路覆盖)
5. 断点两处同步了吗?(mobile.ts QUERY + mobile.css 媒体查询)
6. 触摸目标 ≥44px?hover 粘滞处理了吗?
7. 真机验证截图了吗?(桌面 devtools 的手机模拟 ≠ WebView 行为,大量
   差异只在真机暴露)

## 变更历史

- 1.0(2026-09-14):建立。源于用户第二批勘误:状态栏遮挡 / 返回键无效 /
  设置返回态异常 / 键盘唤不起 / 面板缺失 / 一致性诉求。
