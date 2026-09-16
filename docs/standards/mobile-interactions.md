# 移动端交互规范(Android 壳,ADR-042)

> **这是长期维护的规范文档,不是一次性设计稿。** 任何触及移动端(安卓壳 /
> 共享 renderer 的移动布局)的改动,先读本文档对应章节;做出的新交互决策
> 必须回写到这里 —— 包括「踩过的坑为什么这么定」。移动端交互的漂移
> (各界面各玩各的)比某个单点 bug 伤害更大。
>
> 版本:1.8(2026-09-15 第十批:xterm-scrollbar DOM 隐藏(§5.2)/ 设置输入 blur 即生效(§7)/ 后台保活前台服务(§10)/ 档案编辑密码留空(§7);1.7:设置入口与 tab 同级钉底(§5.1);1.6:dnd 长按参数/armed 反馈 / 切换连接走 MobileBoot 层 / 侧栏远程段=切换)
> 变更历史见文末。

## 0. 背景与原则

Marina 安卓端是**纯远程客户端**(ADR-042):复用桌面 renderer 源码,通过
`useIsMobile()` 分支 + `html.marina-mobile/marina-native` 类(见 §1)适配
触屏/窄屏。这带来一个结构性约束:

- **交互逻辑必须有单一真相源**:同一件事(返回、唤起键盘、打开面板)在
  PC 和手机上是同一个组件/同一个数据源,只允许「形态」不同(双栏→单栏、
  常驻→浮层),不允许「行为」分叉(手机另建一套状态或数据源)。用户对
  一致性的预期 = 「PC 上有的,手机上以可用的形态都有」。

## 1. 布局判定(用户裁决 2026-09-14「平板交互」)

**方向就是布局**(原生壳内):竖屏 = 移动布局(三页手势,同手机),
横屏 = 桌面布局(三栏,同 PC)。手机在原生层锁竖屏(见下),不会出现
横屏手机。不按宽度判 —— 平板竖屏 CSS 宽可到 900+(如 Pixel Tablet
~915px),宽度断点够不到。

| 设备/朝向 | 判定 | 布局 |
|---|---|---|
| 原生壳·竖屏(手机/平板) | `isNativeShell() && portrait` | 移动布局(三页手势) |
| 原生壳·横屏(平板) | `isNativeShell() && landscape` | 桌面三栏(无手势) |
| 手机 | MainActivity 锁 `USER_PORTRAIT` | 恒竖屏(横屏无对应布局) |
| 非壳·窄窗口/手机浏览器 | `max-width: 900px` 或 `(max-height: 500px) and landscape` | 移动布局 |
| 非壳·桌面 Electron 常规窗口 | 其余 | 桌面三栏 |

- **手机锁竖屏在原生层**(MainActivity,`smallestScreenWidthDp < 600` →
  `SCREEN_ORIENTATION_USER_PORTRAIT`,允许倒持):web 侧锁不了方向,
  锁错了还会把平板一起锁死。
- **判定单源在 `src/renderer/mobile.ts`**(`useIsMobile`);CSS 侧
  mobile.css **不再自带媒体查询断点**,统一消费两个类:
  - `html.marina-native` —— 原生壳身份,横竖两态常驻(main.tsx 渲染前
    挂上):隐标题栏、状态栏避让、键盘视口、触屏手感 —— 横屏 PC 三栏
    同样需要这些;
  - `html.marina-mobile` —— 移动布局(App 的 `useMobileLayoutClass` 按
    useIsMobile 维护):三页手势形态(全屏抽屉/全屏面板/全屏设置/键条)。
  - main.tsx 在渲染前预挂两个类(防首帧闪桌面布局),之后由 React 接管。
- 桌面 Electron 窗口缩到极窄命中宽度断点时也走移动布局 —— 这是特性
  (响应式),不是 bug。
- **旋转时 dock 折叠态自动对齐**(LayoutHost snap):进入移动布局 = 折叠
  (终端页,全屏面板无把手可关);转回桌面布局 = 展开(与 PC 默认一致);
  移动布局下切换 session 同样强制落终端页。稳态不写(手势开合面板不会
  被反向改写);桌面冷启动不写(尊重 PC 已存状态)。

## 2. 返回键层级(back-bus)—— 核心交互

安卓返回键(含手势)是移动端的「撤销」原语。**规则:一次返回 = 退一层,
永远不直接杀 app**(终端会话在 PC 上跑,杀 app 是误伤;回后台用
`moveTaskToBack`)。

三页手势导航(§2.5)落地后,返回键在「终端/左栏/右面板」三页之间的语义
= 「回终端」—— 与反向滑手势等价。

### 2.1 层级表(从顶到底,一次 back 退一层)

| 层 | 状态 | back 动作 |
|---|---|---|
| 1 | 设置:分类内子页(如模板编辑器) | 关子页 |
| 2 | 设置:分类详情页(移动单栏) | 回分类列表 |
| 3 | 设置:分类列表 | 退出设置 |
| 4 | 面板 dock 展开(全屏右页) | 折叠 dock 回终端 |
| 5 | 侧栏抽屉开(全屏左页) | 关抽屉回终端 |
| — | 软键盘开 | **系统 IME 先消费**(收键盘),不进本链路 |
| 底 | 无浮层(终端页) | `moveTaskToBack` 回后台 |

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
- **不要在 onClickCapture 里 setState 卸载含目标按钮的子树**(踩过,设置
  打不开的根因):真实触摸的 click 是离散事件,React 在根节点 capture/bubble
  两次监听之间同步 flush 捕获阶段的更新 —— capture 里卸载抽屉后,「设置」
  按钮已不在树上,bubble 阶段它的 onClick 不执行。父级委托收浮层一律挂
  bubble(onClick)。

### 2.5 三页手势导航(用户裁决 2026-09-14)

**移动布局**(壳竖屏,或非壳窄窗口)下只有三页:**左栏(选终端)|
终端(默认)| 右面板(文档/已打开/文件树/Git/命令面板)**,左右页都
**全屏**(三分之二屏阅读成本高)。平板横屏走桌面三栏,无手势(见 §1)。

| 当前页 | 手势 | 结果 |
|---|---|---|
| 终端 | 左滑 | 开右面板(全屏) |
| 终端 | 右滑 | 开左栏抽屉(全屏) |
| 右面板 | 右滑 或 返回键 | 回终端 |
| 左栏 | 左滑 或 返回键 | 回终端 |

- 左右页**互斥**(三态模型,不是可叠浮层):开一页先关另一页。
- 检测原语:`attachMobileSwipeNavigation`(mobile.ts,window capture,
  单指、位移 ≥60px、水平 > 2×垂直、≤600ms;按 touchstart 落点
  closest 判上下文)。阈值改动要真机回归 —— 誤判成 tap 会误触发翻页。
- **没有浮球按钮**(第一版有,手势落地后裁决移除):抽屉/面板的入口只有
  手势,不要「顺手」加回按钮。
- dock 开关走 `PANEL_NAV_EVENT`('marina-panel-nav',App 手势层 →
  LayoutHost):collapsed 是 per-session 后端态,App 不知道,只能事件通知
  LayoutHost 执行 —— 不复用 back-bus(back 是层级退出语义,这是显式导航)。
- **手势 touchend 必须 preventDefault(非 passive)**:否则合成 mousedown
  在 touchend 之后派发,xterm 把焦点抢回 helper-textarea → IME 回弹盖住
  刚打开的全屏页(见 §4)。
- **离开终端页时主动 blur helper-textarea**(App 手势回调里):Android
  返回键只藏 IME 不清焦点,透明 textarea 仍盖在终端上,任何触摸(含这次
  滑动)的 touchstart 落上去 IME 立即回弹。回终端后点按终端重新唤起
  (tap-to-focus)。

## 3. 系统栏(状态栏/手势条)

- **方案 = inset 注入双通道**(decorFits 方案已弃用,见下):MainActivity
  的 insets listener 把 systemBars 高度换算成 CSS px,`evaluateJavascript`
  推送 `--android-inset-top/bottom` 到 :root;`MarinaNative.getInsets()`
  (@JavascriptInterface)供启动时同步拉 —— 推 + 拉双通道防丢首帧。
- **消费点必须直接作用在 `.app-body` 上(top/height),不能给
  `.app-content-shell` 加 padding**:`.app-body` 是 `position:absolute;
  inset:0`,absolute 子元素的 containing block 是父级的 padding box,
  padding 挡不住它 —— computed padding 39px 但 tab 栏仍顶进状态栏
  (2026-09-14 真机取证,两轮才定位)。
- mobile.css 里 `env(safe-area-inset-*)` 作兜底(浏览器端调试有用;WebView
  里恒为空)。
- **反例:不要用 `setDecorFitsSystemWindows(true)`** 回退 edge-to-edge ——
  Android 16 真机实测疑似冻结 WebView 渲染表面(UI 无响应、evaluate 挂起、
  CPU 0%),比遮状态栏严重得多。

## 4. 软键盘

- 布局收缩:`--marina-mobile-vh`(= visualViewport.height)由
  `useMobileViewportFix` 写到 :root;`.app-body.mobile` 的高度 =
  `calc(vvh - inset-top - inset-bottom)`,键盘开时(html.mobile-keyboard-open)
  不再扣底部 inset(IME 已覆盖导航条)。底部消费方(辅助键条)**不要重复
  扣 inset**,app-body 已抬升。
- **键盘开合判定用基线法**(`subscribeMobileViewport`):本朝向的最大高度
  为基线,当前低于基线 15%(且 >120px)= 开。orientationchange 重置基线。
- 键盘开时:活跃终端 scrollToBottom。
- **tap 终端画布唤起键盘**:xterm 的 touch 处理会吃掉 tap 默认行为,合成
  click 不派发 → textarea 不 focus → 键盘唤不起(踩过)。TerminalView 在
  capture 阶段监听 touchstart/move/end,识别单指短 tap 后主动 focus
  helper-textarea(**必须在用户手势上下文内**,脱离手势的 programmatic
  focus 在 Android WebView 不弹 IME)。改 xterm 容器交互时别删这段。
- **IME 隐藏 ≠ 焦点清除**:返回键收起键盘后 helper-textarea 仍是
  activeElement(透明层盖着终端),之后任何触摸 touchstart 落上去 IME 立即
  回弹。翻页手势场景的对策见 §2.5(preventDefault + blur);其它场景出现
  「键盘莫名弹出」先查这个焦点链。

## 5. 触屏通用规则

- 触摸目标 ≥ 44px(桌面 8px padding 的按钮在移动端要覆写)。
- **触屏无 hover**:Chromium 触屏 tap 会触发 `:hover` 并粘滞到点别处。
  移动端样式里用 `@media (hover: none)` 把 hover 效果还原为常态,按压反馈
  用 `:active`(踩过:返回后按钮停留红色 hover 态,用户以为是坏按钮)。
- 双指 = 调字号(TerminalAuxBar 的 `usePinchFontSize`,原生 passive:false
  监听 —— React 合成 touch 在 WebView 下 preventDefault 不可靠);xterm
  区域 `touch-action: pan-y`(禁浏览器页面缩放,单指滚动保留)。
- **长按(≥500ms 不动)= 右键**(用户裁决 2026-09-14,已实现):
  `attachTouchLongPressContextMenu`(mobile.ts,原生壳内常挂,横竖两态)
  在触点合成 `contextmenu` MouseEvent —— 桌面端全部右键菜单链(收藏分组/
  session/文件树/终端链接)原样复用,不另建触屏菜单。例外:输入框
  (系统的文本选择/粘贴菜单)、dnd 拖拽元素(见下条)。菜单弹出后的抬手
  click 被吞(touchend preventDefault),防误点菜单项。
- **dnd 拖拽 = 长按激活**(用户裁决 2026-09-14;参数修订 2026-09-15):
  Sidebar 的传感器拆成 MouseSensor(distance:5,桌面不变)+ TouchSensor
  (**delay:500/tolerance:12**)—— 此前 PointerSensor distance:5 对触摸同样
  生效,手指划过分组 5px 就开始拖,滑动浏览必误触。触屏语义:**长按后移动
  = 拖拽;长按后不动抬起 = 右键**(零位移 onDragEnd →
  dispatchSyntheticContextMenu)。参数修订动机(用户勘误「想右键却几乎总
  是触发拖动」):delay 与全局长按同拍 500ms(350ms 时用户还在等右键,
  微晃就进了拖拽待命);tolerance 12px 吞住按住时的自然抖动。
- **dnd 拿起就位反馈(marina-drag-armed)**:长按层的 onTouchStart 对
  sortable 目标起 500ms 计时(与 TouchSensor 同拍),到点加
  `.marina-drag-armed`(轻微抬起:scale/shadow/brightness,mobile.css);
  移动 >10px 或抬起摘除。没有这个反馈用户不知道拖拽何时可用 ——
  「想右键却总在拖」的误感一半来自这里。dnd-kit 激活后用 inline
  transform 接管元素,armed 的 scale 自然让位,无需手动还原。
- **contextmenu 手势级去重**(踩过,关键):WebView 对长按会自己合成原生
  contextmenu(按住 ~500ms 时),与合成事件(抬手时)双发把菜单「开又关」
  —— 按手势去重:一次触摸手势只放行第一个 contextmenu(原生或合成先到
  先得),`pointerdown` 时按 pointerType 重置;鼠标不参与
  (`dispatchSyntheticContextMenu`,mobile.ts)。两个实现细节都是踩出来的:
  去重监听必须在**应用启动时就装**(懒装时原生 echo 先经过、标记没记上,
  后到的合成事件拦不住);输入类型判定必须用 `pointerdown.pointerType`
  (touchstart+mousedown 互补不行 —— Chromium 长按会在原生 contextmenu 前
  合成一个 mousedown,把 touch 标记错误清掉,真机取证双发依旧)。

## 5.1 触屏滚动与分界线拖动(用户勘误 2026-09-14)

- **可拖元素的 `touch-action` 用 `pan-y`,不用 `none`**:`none` 让手指落在
  该元素上的滑动变成死区(侧栏列表滚动失灵,`.sidebar-group-header` 踩过)。
  `pan-y` 与长按延迟拖拽兼容:激活前手指不动就不会被浏览器抢去滚动,
  激活后 dnd-kit 对 touchmove preventDefault。
- **分界线拖宽走 pointer 事件**(Sidebar/LayoutHost 两处,鼠标触摸同路):
  mouse 事件在触摸上不触发,触屏拖不了分界线。把手 CSS `touch-action: none`
  (横向拖动不被当滚动接走);`(pointer: coarse)` 下把手加宽(侧栏 12px、
  dock 18px)—— 手指比光标粗,原 4-6px 点不中。
- **宽度按比例,不按绝对像素**(用户裁决):侧栏存
  `marina.sidebar.widthRatio`(localStorage,旧 px key 按当前视口一次性换算,
  同机迁移无视觉变化),渲染 = ratio×视口 再按 [180,600]px 钳制;右 dock
  落盘同时带 px 与 `widthRatio`(per-session 后端态,main 白名单校验
  0.1~0.6),跨设备渲染优先 ratio(旧数据无 ratio 退回 px + 45% 视口钳制)。
  动机:PC 2560 上合适的 280/440 到平板 1292 上会把终端挤窄。
- **侧栏「远程」段不渲染收藏/临时/最近**(用户裁决,PC 同步):那是本机
  路径的收藏语义,远程段只有「Marina 电脑」列表。
- **侧栏骨架不变式:设置入口与两个 tab「同级」,钉死在左下角**(用户裁决
  2026-09-14「远程界面的设置位置还是在上面」第三轮定位):`.sidebar-footer`
  必须 `margin-top: auto` —— flex column 里剩余空间全归 footer 的 margin,
  设置按钮恒在侧栏底部,不随 tab 内容流走。没有这条时:本机 tab 靠
  dropzone 的 `flex:1` 把 footer 顶到底,而远程 tab 的电脑列表只有几十
  px 高,footer 紧跟其后悬在屏幕上部(真机:top 151/1292),同一个按钮
  两个 tab 两个位置。配套:tab 内容区(本机 `.sidebar-bookmarks-dropzone`
  / 远程 `.sidebar-computers`)一律 `flex:1 1 0 + overflow-y:auto` 同款
  内滚 —— 内容再长也只在自己的区段里滚,footer 永不被挤出视口。规则是
  全局 CSS,PC 与移动统一生效。

## 5.2 终端触摸滚动条 + 跳底按钮(用户勘误 2026-09-14 第八批)

- **xterm 自带滚动条在 Android WebView 上不可拖**(勘误④「拖一小段就
  中断」的根因):触摸被 xterm 区域的 `touch-action: pan-y` 内容滚动接管
  (pointercancel),按住起步还可能触发长按右键菜单。mobile.css 在原生壳内
  隐藏 `.xterm-viewport` / `.xterm-scrollable-element` 的 webkit 滚动条,
  终端右缘改渲染 `TerminalTouchScroller`(TerminalView):`touch-action:none`
  自绘轨道,拖动 = 比例映射 `term.scrollToLine()`。pan-y 滑动浏览与轨道
  拖动并存。
- **xterm 6 的滚动是虚拟的,DOM 滚动指标全是假象**(真机踩坑,重要):
  `.xterm-viewport` / `.xterm-scrollable-element` 的 scrollHeight 恒等于
  clientHeight、scrollTop 恒 0 —— 读它们只会得出「缓冲区是空的」(实际几百
  行)。位置与行程必须读 buffer API:`viewportY`(视口顶行)/ `length`
  (总行数)/ `rows`(一屏行数);滚动写 `scrollToLine` / `scrollToBottom`
  (后者还会清 user-scroll 态恢复自动跟随,直接改 DOM 不会)。
- **xterm 6 的自带滚动条是真实 DOM 元素,`::-webkit-scrollbar` 藏不住它**
  (用户勘误 2026-09-15 第十批①,自绘轨道 + xterm 滑块双把手重叠的根因):
  结构是 `.xterm-scrollable-element > .xterm-scrollbar > .xterm-slider`,显隐
  由 xterm 自己加的 `xterm-visible/xterm-invisible` 类控制 —— 伪元素规则只
  对浏览器原生滚动条有效。原生壳内必须整棵 `.xterm-scrollbar`
  `display:none !important`(xterm 的可见性类会覆盖普通声明)。
- **跳底按钮**(勘误⑤):浏览位置在顶部 3/4 内(`viewportY/denom < 0.75`)
  时右下角浮出,点击 `scrollToBottom()`。alt-buffer(vim)与不足一屏时
  整套隐藏。轨道与按钮都带 `data-marina-touch-overlay` —— 全局长按层与
  tap 唤键盘层豁免(那里是滚动意图)。

## 5.3 触屏键盘焦点链(用户勘误 2026-09-14 第八批,核心不变式)

**不变式:原生壳内 helper-textarea 的焦点只能来自用户 tap 画布** ——
任何程序性聚焦都会让 Android 在「之后的任意触摸」上回弹输入法
(滑屏浏览终端必弹键盘)。为此 native 壳内关掉了三条程序性聚焦路径:

1. **mount 聚焦(FOC-1)**:`term.open()` 后不 focus;xterm 的 open 自己
   会 focus,须补一刀 `term.blur()`。
2. **重激活聚焦([active] effect)**:退设置/切 session 不 focus。
3. **关设置的 Chromium 焦点归还**:打开设置时 app-body 加
   `workspace-hidden`(visibility:hidden)会摘掉 textarea 焦点;关闭时
   Chromium **自动把焦点还给恢复可见的 textarea**(focus 日志可证),且
   正处于关设置手势的 user-activation 窗口内 → IME 弹出。无法阻止,只能在
   exitSettings 里 rAF×2 后补 blur 收掉(配合 1.5s 的
   `terminalAutoFocusSuppressed` 标记)。

配套:**滑动即 blur**(tap 判定层里位移 >10px 的第一帧 blur 掉聚焦中的
textarea —— 滚动意图收键盘);**helper-textarea 禁原生选择**
(`user-select:none`,mobile.css)—— 聚焦态下触摸 textarea,Android 优先
走文本选择而不是 pan,滑屏会被吃掉(xterm 的选中由自己管,无损失)。
键盘完整编排(真机验证):tap 画布=开,滑屏=收,关设置=不动。

## 5.4 取证方法论(第八批新增踩坑)

- **CDP screenshot 捕获的是 visual viewport**:软键盘开着时 PNG 尺寸 =
  压缩后的可视区(如 2402×2345),不是布局视口(914×1292)—— 用截图坐标
  反推 CSS 位置会全错。先 `visualViewport.height` 对齐再算。
- **视觉模型读终端行号不可靠**(把 550 读成 342 的事故):断言滚动位置用
  DOM 文本(`.xterm-rows > div` 的 textContent,DOM 渲染器)而不是截图。
- **WebView 的 WebGL 渲染器可能整体黑屏**(canvas 全黑、缓冲区正常;
  切 `terminalRenderer=dom` 立愈,重启/一段时间后 WebGL 可自愈)。排查
  「终端空白」先分清:DOM 文本有没有(数据链路)→ canvas 画不画(渲染器)
  → 再查代码。本次为环境性 GPU 状态问题,非代码回归。
- CDP devtools 通道会周期性失活(adb forward 后 "other side closed"):
  remove → 等 15-25s → 重建;app 重启后旧转发必死。

## 6. 终端辅助键条

- 底部一排横向滚动:Esc / Tab / 方向 / PgUp / PgDn / Home / End /
  Ctrl+C / Ctrl+D / Ctrl+Z / Ctrl+L。字节直发 `SESSION_SEND_INPUT`
  (与物理键同路)。
- 渲染条件:**原生壳横竖两态** + 非壳窄窗口 + 有活跃 session(用户勘误
  第八批「保持统一」—— 平板横屏是桌面布局但同样是软键盘);挂在
  `.terminal-workspace`(Deck 的兄弟层 —— deck-slot 是 absolute inset:0,
  放 Deck 内会被盖);CSS 选择器用 marina-native + marina-mobile 双门。
- **方向键发 CSI 序列**(`\x1b[A` 等);应用程序光标模式(DECCKNM,vi 等)
  的 SS3 序列差异是已知简化,用户反馈强烈再改(需读 xterm 内部状态)。

## 7. 设置页(移动单栏)

- 两级导航:分类列表(全宽)→ 详情页(translateX 滑入)。header 左按钮:
  详情层 ‹(走 back-bus)/ 列表层 ×(退出设置)。
- **移动端隐藏依赖桌面本机能力的分类**(`MOBILE_HIDDEN_CATEGORIES`):
  system-integration / advanced(对应命令在 mobile shim 报 notSupported)。
  新增分类时判断:它的所有命令要么 local-control 已实现、要么
  backend-data 天然远程,否则加进隐藏集合 —— 不给用户看死按钮。
- **「远程」分类在原生壳内 = 本设备连接切换**(用户裁决 2026-09-14;
  交互修订 2026-09-15):渲染 `DeviceConnectionsPanel`(SettingsView)——
  列表/当前徽标/删除/添加,**行主体纯展示,「切换」是独立按钮**(不复用
  列表主体当按钮,用户勘误:复用的按钮语义不清且与启动页混淆)。数据是
  **本设备 localStorage** 的连接档案(web-api-shim 注入的
  `window.api.deviceConnections`,与 MobileBoot 同一存储),不是 daemon 侧
  的远程设置(「允许远程连接」等开关在手机上既不可操作也易误导,不出现)。
  桌面/浏览器端 remote 分类仍是 daemon 侧 RemotePanel。
- **切换连接的唯一入口在 MobileBoot 层**(用户裁决 2026-09-15,架构):
  main.tsx 暴露 `window.__marinaBootSwitchProfile(id)` —— 先**显式 close 当前
  transport** 再 reload 走完整 boot 序(断开 UI → 连接中 → snapshot → 挂
  renderer)。此前 shim 里 setLast+reload 不关旧连接:Android WebView 的
  页面卸载时序不保证及时关 WS,daemon 侧旧 socket 未收割时快速切回同一台
  会撞车(用户勘误「第二次切换报错」)。**侧栏「远程」段在原生壳内的语义
  = 切换本设备连接**(不是 PC 的 WINDOW_CREATE 开新窗口 —— 移动端单窗口,
  复用它 = notSupported 报错,同样是用户勘误点):当前连接打「当前」徽标,
  点其他电脑项即切换。任何新的切换入口都必须走 deviceConnections.connect
  (它转发 boot 层),不得自行 setLast+reload。
- **横屏(桌面形态)下设置页的避让**:settings-layer 是 content-shell 里的
  `absolute inset:0`,不吃 .app-body 的避让 —— mobile.css 有
  `html.marina-native:not(.marina-mobile)` 专用规则推 top/bottom(踩过:
  横屏开设置顶部顶进状态栏)。
- **控件行排版分屏宽两档**(用户勘误第八批「设置位置和 PC 不一致」):
  窄竖屏(<700px,手机)标签/控件纵向堆叠;**平板竖屏(CSS 宽 ~914px)
  沿用 PC 的标签左/控件右**(mobile.css `@media (max-width: 699.98px)` 才
  应用堆叠)。**踩坑**:纵向堆叠时 `.settings-row-meta` 的
  `flex: 0 0 200px` 基准从「宽」变「高」—— meta 被拉成 200px 高,标签下
  一大块空白(远程面板真机取证 161px 间隙);堆叠态必须补
  `flex: 0 0 auto`。
- **原生壳内的远程面板 = PC 面板结构**:DeviceConnectionsPanel 外层用
  `.settings-panel`(720px 约束,横屏排版与 PC 一致),区块头用 PC 的
  subsection 标题体系(`.settings-subsection-title` + desc),不拿
  SettingRow(label/控件行)当标题使。
- **移动端输入「点框外任意处 = 退出编辑并生效」**(用户勘误 2026-09-15
  第十批②):桌面 Chromium 点别处会自然 blur 掉 input;**Android WebView
  的触摸落在非可聚焦元素上不转移焦点** —— 输入框一直保持聚焦,而设置页
  大量输入(NumberInput 字号/UI 缩放、EnvTextarea)是 onBlur 才 commit,
  结果用户只能按软键盘「完成/回车」才能生效。SettingsView 在原生壳内挂
  window touchstart(capture):触点不在 `input/textarea/select/
  [contenteditable]` 内就主动 blur 当前聚焦元素 → 走各控件已有的 onBlur
  提交路径。**移动端新输入控件默认写 onBlur 提交**(onChange 只更新草稿),
  否则此机制对它无效。
- **连接档案表单:编辑模式密码留空 = 保留原密码,校验不得一刀切**
  (用户勘误 2026-09-15 第十批④):MobileBoot ProfileForm 的必填校验是
  `!host || (!initial && !password)` —— 地址永远必填,密码只有**新增**
  必填;编辑模式留空走 `password || initial.password` fallback。此前
  `!host || !password` 一刀切:编辑模式点「保存并连接」被静默拦截(无
  报错无反应),与表单 placeholder「留空保持不变」自相矛盾。数据层
  (web-api-shim save)的 fallback 一直是对的,坑只在 UI 校验层。

## 8. 左栏抽屉 / 右面板(三页的左右页)

**左栏抽屉**:
- 渲染的就是 `<Sidebar />` 本体(收藏/临时/最近 + 分组 + session 节点,
  **与 PC 同一组件同一数据源**,这就是「一致性」的实现方式)。
- **抽屉必须是 flex column 且让 .sidebar 撑满**(mobile.css):sidebar 在
  桌面靠 .app-body 的 flex 行 align-stretch 拿到全高,抽屉里没有这个机制
  —— 不给高度时 flex column 把它压成内容高,收藏/临时/最近全被塞进十几
  像素的缝里(2026-09-14 真机取证的「抽屉里什么都没有」)。
- 底部设置入口(sidebar-footer)随 flex 沉到抽屉底;点 session/设置后
  自动收抽屉(事件委托,挂 **bubble**,见 §2.2 末条)。

**右面板 dock**:
- 移动端不参与水平 split(桌面 280px 下限会把终端挤成 12 列),全屏
  overlay:width/max-width/min-width 三连 `!important` —— inline style 带
  桌面 width(280-440)与 global.css 的 max-width,不全压掉会得到 280px
  残宽(踩过)。
- **collapsed 态完全隐藏**(无把手圆钮 —— 手势是唯一入口,用户裁决);
  无持久化布局的 session 移动端**默认折叠**(LayoutHost 兜底),否则新建
  session 被面板盖住且无把手可关。
- dock 展开/折叠状态沿用 per-session 持久(`SESSION_UPDATE_UI_LAYOUT`),
  与 PC 完全同一数据源 —— 手机上展开的面板,PC 同 session 也是展开的。
  布局形态切换(旋转/跨断点/移动布局下换 session)时 snap 一次(§1);
  稳态尊重当前值,手势开合不会被反向改写。
- resize 拖条隐藏(触屏无 mouse);返回键折叠(back-bus 第 4 层)。

## 9. 一致性检查清单(改移动端时过一遍)

1. PC 上有的功能,手机上能用吗?(能用=形态可不同;不能用=要么实现,
   要么明确裁剪并记在本文档)
2. 数据源是同一个吗?(收藏/模板/设置都来自 daemon 单流;不得在手机上
   另存一份)
3. 返回键对新加的浮层生效吗?(按 2.2 接入 back-bus)
4. 新浮层/新页面有手势入口吗?和三页模型(§2.5)冲突吗?
5. 键盘弹出时新界面还可用吗?(`--marina-mobile-vh` 链路覆盖)
6. 布局判定改动回写 mobile.ts 了吗?CSS 是不是走类门(marina-mobile /
   marina-native)而不是新开媒体查询断点?(判定单源,见 §1)
7. 触摸目标 ≥44px?hover 粘滞处理了吗?
8. 真机验证截图了吗?(桌面 devtools 的手机模拟 ≠ WebView 行为,大量
   差异只在真机暴露;取证工具:adb forward + apps/mobile/scripts/cdp-*
   —— eval/shot/type 三件)

## 10. 后台保活(用户勘误 2026-09-15 第十批③「切后台断连」)

- **断连的根因不在心跳**:WS 保活是协议层 ping/pong —— daemon 侧
  transport-ws.ts 每 30s 发协议 ping,Chromium 网络栈自动回 pong,**不
  需要页面 JS 参与**(定时器节流不影响)。真正断连是 Android 把后台 app
  进程冻结/限网(CachedAppFreezer、Doze):WebView 进程一停,90s 心跳
  窗口内 daemon 判死连接。
- **方案 = 前台服务(Termux 同款)**:`KeepAliveService`(Android 原生,
  FGS type `dataSync`)由 MainActivity 驱动 —— **onPause 启动**(此刻 app
  仍算前台,满足 Android 12+「后台不得启动 FGS」限制)、**onResume 停止**。
  「正在后台保持连接」通知只在后台期间存在,不做常驻通知。
- **已知边界**:Android 15 对 dataSync 类型 FGS 有 6 小时/天累计限时,
  超时系统停服务 —— 兜底是 renderer 的指数退避自动重连
  (remote-transport,回前台 JS 恢复后立即续上),下次退后台服务重新启动。
- **验证方法**(真机):退后台 → `dumpsys activity services so.marina.app`
  应见 `KeepAliveService isForeground=true`;回前台计数归零。连接活性用
  真 WS RPC 验证(如 `cmd:settings:list-shells`,注意 mobile shim 的
  local-commands 会本地 mock 掉部分 channel,`remote-daemon:get-status`
  在手机上返回假数据,不能用来验证 WS)。实测后台 146s(>90s 心跳判死
  窗口)后 RPC 双向 133ms 正常。
- 锁屏同样走 onPause → 保活生效(锁屏≠断连,符合「终端在 PC 上跑」的
  预期)。

## 变更历史

- 1.0(2026-09-14):建立。源于用户第二批勘误:状态栏遮挡 / 返回键无效 /
  设置返回态异常 / 键盘唤不起 / 面板缺失 / 一致性诉求。
- 1.1(2026-09-14):用户裁决三页手势导航(左右页全屏、终端为家、滑动
  切页),移除浮球与 collapsed 把手;第三批勘误回写:设置打不开根因
  (capture 卸载杀 bubble onClick)、抽屉塌陷(sidebar 无拉伸机制)、
  状态栏避让改 app-body 直改(decorFits 反例)、IME 焦点残留规则。
- 1.2(2026-09-14):用户裁决平板交互:方向即布局(竖=三页手势,横=PC
  三栏)、手机锁竖屏(原生层)。布局判定单源化到 mobile.ts,CSS 媒体查询
  门换成 html 类门(marina-native/marina-mobile —— 平板竖屏 CSS 宽可
  >900px 媒体查询够不到);旋转时 dock 折叠态自动 snap;触屏手感规则
  (hover 粘滞/xterm pan-y/隐标题栏/避让)扩到横屏。
- 1.3(2026-09-14):平板勘误四项:横屏设置层避让(not(.marina-mobile)
  专用规则);「远程」分类壳内改渲染本设备连接切换(deviceConnections,
  与 MobileBoot 同存储,daemon 侧开关不再出现);长按=右键全面落地
  (全局长按合成 contextmenu + dnd TouchSensor 延迟激活 + 零位移释放=右键
  + WebView 原生 echo 的手势级去重)。
- 1.4(2026-09-14):平板勘误:组头 touch-action none→pan-y(滚动死区)、
  分界线拖宽改 pointer 事件 + 粗指针把手加宽、侧栏/dock 宽度改比例制
  (localStorage ratio + 后端 widthRatio 白名单)、远程段移除收藏/临时/
  最近;长按去重两处实现修正(启动时安装 + pointerdown.pointerType)。
- 1.5(2026-09-14):第八批勘误:设置行排版分档 + flex-basis 200px 堆叠坑
  (§7);辅助键条横竖两态统一(§6);触屏键盘焦点链不变式(§5.3,焦点只
  来自 tap);终端触摸滚动条 + 跳底按钮(§5.2,xterm 6 虚拟滚动必须走
  buffer API);取证方法论(§5.4,visual viewport 截图/WebGL 黑屏排查)。
- 1.6(2026-09-15):第九批勘误:TouchSensor delay 500/tolerance 12 +
  marina-drag-armed 拿起就位反馈(§5);切换连接的唯一入口收敛到
  MobileBoot 层(__marinaBootSwitchProfile:先关 transport 再走 boot 序,
  修「第二次切换报错」的时序根因);侧栏远程段原生壳内 = 切换本设备连接
  (当前徽标;不再复用 PC 的 WINDOW_CREATE);设置面板行主体纯展示 +
  独立「切换」按钮(§7)。
- 1.7(2026-09-15):第九批续「远程界面的设置位置还是在上面」第三轮定位:
  前两轮修的是设置页内容排版,真因是 `.sidebar-footer` 无 margin-top:auto、
  跟 tab 内容流走。确立侧栏骨架不变式(§5.1):设置入口与两个 tab 同级、
  margin-top:auto 钉死左下角,tab 内容区一律 flex:1+内滚;全局 CSS 两端
  统一生效。
- 1.8(2026-09-15):第十批:xterm 自带滚动条是 DOM 元素(.xterm-scrollbar),
  伪元素规则藏不住,双把手重叠 → display:none 整棵隐藏(§5.2);Android
  WebView 触摸非输入区不转移焦点 → 设置层 touchstart 主动 blur,输入
  「点框外即生效」(§7);后台断连根因是进程冻结而非心跳 → KeepAliveService
  前台服务(onPause 起/onResume 停,dataSync 类型,6h 限时 + 重连兜底)
  (§10);MobileBoot 档案编辑密码留空校验不再一刀切(§7)。
