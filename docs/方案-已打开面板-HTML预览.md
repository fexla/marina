# 方案:「已打开」面板支持 HTML 预览(WebViewer)

> 状态:**待裁决** —— 文内 6 个决策点(第 11 章)需要开发者拍板后才开始实现。
> 触发场景:archify 等 skill 产出独立 HTML 产物(内联 SVG + 内联 JS、深浅主题、
> 交互轨迹动画、导出按钮),经 `marina show` 推到面板后,目前只能按源码文本查看。

## 意图对比表(设计不变量 ↔ 本方案)

| # | 设计不变量(出处) | 本方案如何满足 |
|---|---|---|
| 1 | 面板是只读查看器,不是浏览器(软件定义书 §14.6 / ADR-016~018) | 只渲染本地文件;无地址栏、无导航历史;http(s) 链接一律外开系统浏览器;远程 URL 明确非目标 |
| 2 | renderer 无 node 访问、contextIsolation 不放松(window-manager.ts:187-208) | 预览运行在 sandbox iframe + 自定义 scheme 内,不触 preload、不加任何 webPreferences |
| 3 | 生产 CSP 只收紧不放空(index.ts:604-629) | `script-src` 纹丝不动;仅新增窄项 `frame-src marina-file:`;iframe 内容的 CSP 由协议层逐响应下发,比 app CSP 更严 |
| 4 | ADR-019 面板 remount 模型(ActivePanel key 重挂)不改 | WebViewer 是 FileViewer 的一个普通 case 分支;工作态显式降级为"无"(见第 7 章降级清单) |
| 5 | agent 产物工作流(show-in-marina skill)零改动 | `marina show` 已支持任意文件;kind 检测自动分流,CLI 与 HTTP 网关完全不动 |

## 1. 背景与现状

**需求**:面板目前支持 Markdown / 文本代码 / 图片 / diff 四种预览。archify 类 skill
的产物是自包含交互 HTML(单文件、内联 SVG/JS/CSS、`prefers-color-scheme` 响应式
主题、canvas 导出按钮),按源码文本看毫无意义,用户只能外开浏览器 —— 面板作为
"agent 产物的第一落点"的价值就断了。

**代码现状(已勘察核实)**:

- 分发结构早已留位:`FileViewer.tsx:5-8` 头注写明"若 FileKind 加入 'web',这里加
  一个 case 渲染 `<iframe>/<webview>` 即可"。`src/shared/types.ts:921-924` 的
  `FileKind` 注释同样预留 'web' 但未加入类型。
- `.html/.htm` 当前归 `'text'`(`src/shared/file-kind.ts:80-82`,注释"等 WebViewer
  再改"),由 TextViewer 按 xml 高亮展示源码。
- **核心障碍是 CSP**:生产 CSP `script-src 'self'`(index.ts:612-614)。按 HTML 规范,
  `srcdoc` / `about:blank` / `data:` / `blob:` 文档会**继承**父页面的 policy
  container —— 也就是说这些方式嵌入的 HTML,其内联脚本会被 app 自己的 CSP 拦死
  (style 能活,因为 `style-src` 已有 `'unsafe-inline'`)。这是"留位但未做"的根因。
- 无 custom protocol、无 iframe/webview 使用、无 sanitizer 依赖;图片走
  base64 dataUrl over IPC(`readFile`,`file-panel-service.ts:483-524`)。
- 读取链:fs.watch → mtimeMs 变 → `evt:file-panel:updated` → renderer 重读。
  WebViewer 可完全复用这条链做热刷新(见 5.4)。

## 2. 被拒方案清单(rejection list)

| 方案 | 结论 | 理由 |
|---|---|---|
| 放宽 app CSP(加 `script-src 'unsafe-inline'`) | ❌ 永不 | 违反不变量 3;等于给整个 renderer 开内联脚本口子 |
| `iframe srcdoc` / `data:` URL | ❌ | 继承父 CSP,内联 JS 被杀;data: 下相对资源引用全断。只能做"无脚本的静态预览",不满足 archify 交互需求 |
| sanitizer(DOMPurify 等)+ innerHTML 注入 app 页 | ❌ | 引入新依赖(边界 2);破坏保真度(交互全废);svg 已有"走 `<img>` 不走 innerHTML"的安全先例(file-kind.ts:14-15) |
| `<webview>` tag | ❌ | Electron 官方弃用方向;需开 `webviewTag`;每 viewer 一个 webContents,与 remount 生命周期模型冲突 |
| WebContentsView 叠加 | ❌ | 窗口级 overlay,无法嵌进 dock 面板的布局/层级,与面板架构错配 |
| 复用 local-http-gateway 加只读路由 | ❌ | localhost 是全机共享面(任意本地进程可达);网关可被 settings 关闭→功能随机关闭;职责混杂 |
| 远程 URL 支持 | ❌ 本轮非目标 | "面板不是浏览器"是已定边界;http(s) 链接维持外开系统浏览器 |

## 3. 推荐架构:自定义特权 scheme + sandbox iframe

```
┌─ renderer window (app 页面, CSP: script-src 'self' 不变) ────────────┐
│  FileViewer case 'web' → WebViewer                                   │
│    <iframe sandbox="allow-scripts allow-downloads"                   │
│            src="marina-file:///D%3A/.../arch.html?v=mtimeMs-size" /> │
│         │ 加载被 app CSP 新增窄项放行: frame-src marina-file:        │
└─────────┼─────────────────────────────────────────────────────────────┘
          ▼
┌─ main: protocol.handle('marina-file') ───────────────────────────────┐
│  1. URL → 解码 → 还原 Windows 绝对路径(拒绝 .. 与非白名单根)       │
│  2. fs.realpath 验证仍在白名单根内(防 symlink 逃逸)                │
│  3. stat:必须普通文件, ≤ 32MB                                        │
│  4. 按扩展名定 MIME;html 响应附自包含档 CSP(见 4.3)               │
│  5. 流式返回(Response + stream)                                     │
└───────────────────────────────────────────────────────────────────────┘
```

**为什么这条路成立**:custom scheme 的文档**不继承**父页面 CSP —— 它的 policy
container 来自我们在 `protocol.handle` 里逐响应下发的响应头,完全由我们控制。inline
JS 因此可以跑,而 app 自身 CSP 一字不松。这正是 VS Code webview
(`vscode-webview:` scheme)的同款做法。scheme 必须在 `app.ready` 前用
`registerSchemesAsPrivileged` 注册(Electron 31 支持,`protocol.handle` 自 25 起可用):

```ts
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'marina-file',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
    // standard: URL 按层级解析 → 相对路径引用(css/js/图)才能正确解析
    // 不设 bypassCSP:我们要让下发的 CSP 真实生效
  },
]);
```

## 4. 安全模型(本方案的核心)

预览内容是**不可信代码**(agent 生成的 HTML)。四层防线:

### 4.1 路径白名单(哪些文件可被服务)

`marina-file:` 只服务满足以下任一条件的路径(逐请求实时计算,不缓存):

1. 该路径本身是**某个 session 面板中当前打开的文件**(主文档永远满足);
2. 该路径位于**某个已打开文件所在目录**(兄弟资源:同目录 css/js/svg);
3. 该路径位于**受管 workspace 目录**内(`session-workspace-manager` 的根)。

- 解码后重验 `..` 段;`fs.realpath` 后做包含检查(防符号链接逃逸);根集合的
  realpath 结果缓存、roots 变化时失效。
- 后果:HTML 引用**非同目录**的相对资源(如 `../../shared/x.css`)会 403。
  这是"自包含产物"契约的一部分(archify 本来就是单文件输出)。
- 谁还能请求这个 scheme?app 页面自身的 JS(可信)与 iframe 内的子资源请求
  (受 4.3 CSP 约束)。Markdown 渲染走 react-markdown(默认转义不注 HTML)、
  终端是 canvas,均无注入面。

### 4.2 iframe sandbox 属性

```
sandbox="allow-scripts allow-downloads"
```

- **不含** `allow-same-origin` → opaque origin:拿不到自身 origin 的
  localStorage/cookie,更不可能摸到父页面 DOM(加上 custom scheme 与 app 页面
  本就跨 origin,双保险)。Chromium 文档明示 `allow-scripts +
  allow-same-origin` 组合等于逃出沙箱,我们不给。
- **不含** `allow-popups` / `allow-top-navigation` / `allow-forms` → 无法弹窗、
  无法导航顶层、无法提交表单。
- sandbox 标志**级联到嵌套 browsing context**(内嵌 iframe 同样被套住)。
- `allow-downloads` 保留 archify 的"导出 PNG"下载链路(见 4.5)。

### 4.3 逐响应 CSP(自包含档)

html/htm 响应统一附带(比 app CSP 严得多的封闭档案):

```
default-src 'none';
script-src  marina-file: data: blob: 'unsafe-inline';
style-src   marina-file: data: blob: 'unsafe-inline';
img-src     marina-file: data: blob:;
font-src    marina-file: data:;
media-src   marina-file: data: blob:;
connect-src marina-file: data: blob:;
frame-src   marina-file: data: blob:;
object-src 'none'; form-action 'none'; base-uri 'none';
```

要点:**任何 http(s) 都不在白名单** —— 产物可以跑自己的脚本、用自己的本地兄弟
资源,但连不出网(外链 CDN 脚本/图片/追踪一概断)。svg 响应额外加
`script-src 'none'`(svg 经 `<img>` 引用本就不执行脚本,这是防 `<iframe src=x.svg>`
的纵深)。其余类型不附 CSP。所有响应带 `Access-Control-Allow-Origin: *`
(opaque origin 下 fetch 相对资源是跨源请求,需放行)与 `Cache-Control: no-cache`
(热刷新靠 URL 查询参数,见 5.4)。

### 4.4 app CSP 的唯一改动 + 导航堵漏

- `cspProd` / `cspDev` 各加窄项 `frame-src 'self' marina-file:`(iframe 的加载
  受父页面 `frame-src` 管控,回落 `default-src 'self'` 会拦掉 custom scheme ——
  这一步不加,整个方案不工作)。同步更新 `scripts/csp` 集成测试。
- 纵深(可选项,实现时评估 ~10 行):`webRequest.onBeforeRequest` 过滤
  `resourceType: 'subFrame'` 且目标 scheme ∉ {marina-file:, data:, blob:} 的
  请求直接 cancel —— 堵"iframe 自导航到外部 origin"这最后一个口子。

### 4.5 下载行为

sandbox 里的下载按钮会触发 session 的 `will-download`。Marina 目前没有 handler
(未注册时 Electron 可能直接取消下载)。计划:注册 handler → 存到系统"下载"目录
→ toast 通知路径。这是 archify 导出按钮能用的必要条件。

## 5. 变更清单(按层)

### 5.1 shared(`~30 行`)

| 文件 | 改动 |
|---|---|
| `src/shared/types.ts:921-924` | `FileKind` 加入 `'web'`,注释从"预留"改为"已实现" |
| `src/shared/file-kind.ts` | 新增 `WEB_EXT = {'html','htm'}`,检测优先级置于 TEXT_EXT 之前;头注与 TEXT_EXT 内注释同步改 |
| `src/shared/file-icon.ts` | `.html` 已有 fileCode 图标,不动(后续想换 globe 图标再议) |

### 5.2 main(`~250 行`)

| 文件 | 改动 |
|---|---|
| `src/main/index.ts` | ① bootstrap 顶部(app ready 前)`registerSchemesAsPrivileged`;② ready 后 `protocol.handle('marina-file', …)`(handler 逻辑抽成可测的独立模块 `src/main/web-file-protocol.ts`:URL→路径还原、白名单判定、realpath 包含检查、MIME 表、按 MIME 的 CSP 表、大小上限 32MB);③ CSP 两个字符串加 `frame-src`;④ `will-download` handler;⑤ (可选)subFrame 导航堵漏 |
| `src/main/file-panel-service.ts` | ① `openFile` 对 web kind 超限(>32MB)仍打开但标记,由 viewer 显示"文件过大"占位 + 外开按钮;② 快照恢复路径(`session-workspace-manager.ts:811-816` 目前信任存储的 kind)改为重新 `detectFileKind` —— 否则升级后旧快照里的 .html 仍按 text 恢复 |

### 5.3 renderer(`~180 行`)

| 文件 | 改动 |
|---|---|
| `src/renderer/components/file-panel/WebViewer.tsx`(新) | sandbox iframe;src = 按 `file.path` 编码 + `?v=${mtimeMs}-${size}` 缓存击穿;文件变化(fs.watch→事件→mtimeMs 变)自动重载;超限/读取异常时占位 UI + "用浏览器打开";顶部小工具条:**重新加载** / **源码⇄预览切换** / **外部打开**(视 Q3/Q4 裁决) |
| `FileViewer.tsx:34-55` | 加 `case 'web'` —— 兑现头注预留的槽位 |
| `FilePanel.tsx:146-153` | 切入 web 时清外层滚动(对齐 text/diff 的既有处理);背景 probe 走 `--color-bg-primary` |
| `store.tsx` viewer 身份键 | `(sessionId, path, kind)` 已含 kind,天然隔离,无需改 |

**IPC 零新增**:预览内容不经 `FILE_PANEL_READ`(协议层直接流式服务);
"源码切换"复用 TextViewer,`readFile` 对 web kind 走 text 分支(UTF-8 + 2MB
截断;`protocol.ts:2110` 的 `ReadableFileKind` 相应放开并更新注释)。

### 5.4 热刷新机制(零新代码,复用现有链)

fs.watch(200ms 防抖)→ `refreshOne` 重 stat → mtimeMs/size 变 →
`evt:file-panel:updated` → WebViewer 因 `?v=` 参数变化而重渲染 → iframe 换 src
自动重载。agent 覆盖写同一文件再 `marina show`,面板原地刷新 —— 与 Markdown
行为一致。

## 6. 边界 case 走查

1. **HTML 引用了白名单外的资源**(如 `../../shared/x.css`)→ handler 403,页面
   样式缺失。V1 接受(自包含契约);不做可视化错误提示(浏览器控制台不可见,
   属预期降级)。
2. **用户打开 50MB 的 HTML** → openFile 不拒绝(tab 出现),WebViewer 显示
   "文件过大(>32MB),请用外部浏览器打开"占位 + 按钮。子资源同理受 32MB 上限。
3. **升级兼容**:旧快照里 .html 存的 kind 是 'text' → 5.2 的重检测修复;
   重检测失败(文件已移动)走既有 stale 流程。
4. **主文档请求时 tab 已被关闭**(竞态)→ 不在白名单 → 403,iframe 即将销毁,
   无感知。

## 7. 已知降级(与 Q5/Q6 对应,待一次性确认)

| 能力 | 降级 | 原因 |
|---|---|---|
| Ctrl+F 面板内搜索 | 不支持(web kind 报告不可搜索) | opaque origin 下父页面摸不到 iframe DOM;现有 CSS Custom Highlight 机制全部基于 renderer DOM |
| 滚动位置持久化 | 不做(切面板/切 tab 回来从顶部开始) | 同上,读不到 iframe 内 scrollTop;注入桥接脚本会改写产物内容,不做 |
| localStorage | iframe 内不可用 | sandbox 不给 allow-same-origin;archify 主题偏好若依赖 localStorage 则每次加载回默认 |
| 深浅主题 | 跟随 **OS** 的 `prefers-color-scheme`,不跟 Marina 应用主题 | 见 Q4(nativeTheme 反向耦合与 CP-4 勘误 #2 的移除方向冲突) |
| 非同目录相对资源 | 断链 | 白名单契约(4.1) |
| 切走再切回的 <16ms 缓存预算 | 达不到 —— iframe remount 即整页重载(本地磁盘 + 解析,典型 100-300ms) | iframe 内容对 renderer 是黑盒,保活需要改 ADR-019 remount 架构,不做;作为**已记录的偏离**写入 ADR-034 |

## 8. 测试与验证

- 单测(`src/main/web-file-protocol.test.ts` 新增):URL→路径往返、`..` 拒绝、
  realpath 逃逸拒绝、白名单三条件各自命中/不命中、MIME/CSP 表、32MB 上限。
- 既有测试修订:`file-kind.test.ts:31`(`.html` 断言 'text'→'web',补 htm/大小写/
  路径含点号用例);`file-panel-service.test.ts`(web kind openFile 路径、超限标记、
  快照重检测);`scripts/csp`(frame-src)。
- PoC 复核(实现首日):最小 Electron 验证两件事 —— ① custom scheme 文档确不继承
  父 CSP(内联 JS 可跑);② `frame-src marina-file:` 放行生效。方案的两大前提
  各一行代码可证。
- 冒烟:`npm run smoke`(动了 main 启动路径)+ `npm run smoke:interactive
  --file-viewer-scroll`(动了 viewer)+ 新增 `--file-viewer-html` 场景(向
  workspace 写一个内联脚本+SVG 的测试 HTML → show → 截图核验)。
- 按第 5.3 章纪律:typecheck / test / lint 全绿后才算完。

## 9. 文档义务

- **ADR-034**(新):WebViewer 安全模型(scheme、白名单、逐响应 CSP、sandbox、
  frame-src、下载、已接受降级)。含被拒方案表(本文第 2 章直接搬)。
- `docs/ipc-protocol.md` §6.6:注明 web kind 的读取不经 IPC、走 marina-file 协议。
- 软件定义书 §14.6:补"v0.x 起,ADR-034:面板支持本地 HTML 预览(只读、自包含档)"。
- `.pi/skills/show-in-marina/SKILL.md` 的 Supported content 行补 HTML。

## 10. 实施切分(4 个 commit,均在 feature branch)

1. `feat(shared): detect .html/.htm as web file kind` —— shared 三处 + 测试;
2. `feat(main): add marina-file protocol with scoped serving + CSP frame-src`
   —— scheme/handler/下载/导航堵漏 + web-file-protocol 测试 + csp 脚本 + ADR-034;
3. `feat(renderer): add WebViewer with sandboxed iframe` —— 组件 + case + 滚动/probe
   + 源码切换 + smoke 场景;
4. 快照重检测单独一个 `fix(file-panel): re-detect kind on snapshot restore`(它
   独立可测、独立可回滚)。

规模估计:代码+注释约 600-700 行,测试约 250 行,文档 3 处。

---

## 11. 待裁决问题(共 6 个;Q1 是根决策,其余依赖它)

> 按 AGENTS.md 1.4 纪律列出当前全部已成型问题。Q1 定了方向,其余大多是参数级确认。

### Q1. 渲染架构:采用方案 A(自定义 scheme + sandbox iframe)吗?

- **背景**:CSP 继承规则决定了 srcdoc/data: 路线跑不了内联 JS(第 1、2 章);
  能跑交互 HTML 的可行路只有 custom scheme(方案 A)、webview tag(已弃用方向)、
  WebContentsView(与面板架构错配)三条。
- **推理链**:archify 产物需要内联 JS → 嵌入文档不能继承父 CSP → 必须让文档拿到
  独立 policy → custom scheme 是 Electron 生态的标准答案(VS Code 同款)。
- **待裁决**:确认走方案 A,还是退到"仅外开浏览器"(零实现,面板继续按源码文本
  展示 .html)。
- **推荐**:方案 A。理由:这是"已打开"面板作为 agent 产物第一落点的关键补全;
  安全面完全可控(四层防线,app CSP 只加一个窄项);代码预留槽位就是为它准备的。

### Q2. 服务能力档位:自包含档(禁外网)还是联网页档(允许 CDN)?

- **背景**:4.3 的 CSP 把 http(s) 全禁了。archify 产物是自包含单文件,不受影响;
  但如果用户想看引用了 CDN 脚本(如 mermaid.js CDN 版)的本地 HTML,会渲染残缺。
- **待裁决**:V1 锁自包含档,还是放行外网?
- **推荐**:V1 锁自包含档。理由:安全面小一个数量级(无任何出网通道 = 无数据
  外泄可能);面板定位是"看产物"不是"跑网页";联网页档留作后续 ADR 升级
  (只是改一张 CSP 表)。**依赖 Q1=方案 A。**

### Q3. 源码⇄预览切换:viewer 工具条上加不加?

- **背景**:.html 从源码文本视图升级为渲染视图后,"看源码"的既有能力消失了
  (开发者常需要)。readFile 让 web kind 走 text 分支即可复用 TextViewer,
  成本约 30 行。
- **待裁决**:加切换按钮,还是砍掉源码查看(右键"用外部程序打开"兜底)?
- **推荐**:加。成本极低,保住既有能力。**依赖 Q1=方案 A。**

### Q4. 主题:跟随 OS(默认)还是同步 Marina 应用主题?

- **背景**:iframe 里 `prefers-color-scheme` 查询的是 **OS** 设置。Marina 自己的
  深浅主题与应用主题无关;且 CP-4 勘误 #2 特意**移除**了 nativeTheme 耦合
  (index.ts:882-883 有案可查)。要同步只有 `nativeTheme.themeSource` 一条路,
  但那会影响整个应用进程的原生 UI 呈现,方向上与当年移除的耦合相反。
- **待裁决**:V1 接受"OS 深浅 → HTML 跟随,Marina 主题不影响它"?还是冒险同步?
- **推荐**:V1 接受跟随 OS,并在 ADR-034 记录;同步方案留给用户实际抱怨后再议。
  **依赖 Q1=方案 A。**

### Q5. 下载行为:接 will-download 存到系统下载目录 + toast?

- **背景**:不接 handler,archify 的"导出 PNG"按钮在 sandbox 里点了没反应
  (4.5)。接了才有完整闭环。
- **待裁决**:确认接;存储位置用系统下载目录(不弹保存对话框,减少打断)。
- **推荐**:接,存下载目录 + toast 显示路径。弹对话框方案也可选,但打断感强。
  **依赖 Q1=方案 A。**

### Q6. 降级清单打包确认(第 7 章全部)

一次性确认以下六项可接受:Ctrl+F 不支持 web / 滚动不持久 / localStorage 不可用 /
主题跟随 OS / 非同目录相对资源断链 / 切回重载(偏离 16ms 预算,100-300ms)。
有任何一项不可接受,请单独指出 —— 它们各自对应不同的补救成本。

---

*本方案由 agent 起草,等待开发者对第 11 章裁决后进入实现。*
