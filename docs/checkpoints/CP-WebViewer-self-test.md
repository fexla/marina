# CP-WebViewer 自测报告（HTML 预览，ADR-034）

**分支**：`feat/v0.3.3` · **commits**：`30d9b9d`（shared）→ `cfb81c3`（main 协议层）→ `e49d003`（renderer）→ `ec5b284`（快照重检测）
**设计底稿**：`docs/方案-已打开面板-HTML预览.md`（六项裁决全按推荐执行）

## 跑过的自动化验证（全绿）

- [x] `npm run typecheck` 通过
- [x] `npm test` 通过（**1608 passed** / 1 skipped，较改动前 +11 个新用例：
      web-file-protocol 11 个 + 快照 kind 重检测 1 个 + file-kind web 判定翻转）
- [x] `npm run lint` 无错误
- [x] `npm run smoke`（启动冒烟）PASS —— main 启动路径变了
      （scheme 注册 + protocol.handle + will-download），5s 内起来无致命错误
- [x] `npm run smoke:interactive`（PTY 回环）PASS 3609ms —— 无回归
- [x] `npm run smoke:interactive --file-viewer-scroll` PASS 4613ms —— 面板滚动
      路径无回归（改了 FilePanel 的滚动清理分支）
- [x] `npm run smoke:interactive --file-viewer-html`（**新增场景**）PASS 663ms ——
      端到端断言：iframe 挂载（sandbox 属性精确匹配）+ **产物内联脚本真实执行**
      （postMessage 回执，证明 scheme 服务 + frame-src 放行 + app CSP 跳过注入 +
      逐响应 CSP 四件事在真实 app 里同时成立）+ 源码⇄预览切换往返

## 实现前的 PoC 实证（两大前提 + 三个意外发现）

1. ✅ custom scheme 文档**不继承**父页面 CSP → 内联 JS 可跑（方案的根基）
2. ✅ `frame-src 'self' marina-file:` 放行 iframe；负向对照：缺它被 `default-src` 回落拦下
3. ⚠️ 意外发现 A：`scheme:///path` 会被 Chromium 折叠成 `host=path首段` → URL 形态
   改为固定 host `marina-file://local/<path>`（VS Code 同款手法）
4. ⚠️ 意外发现 B：`webRequest.onHeadersReceived` **会**拦截 marina-file 响应 →
   必须 对 marina-file: 跳过 app CSP 注入，否则交集生效拦死内联脚本
5. ⚠️ 意外发现 C：不注册 `will-download` handler 时 Electron 直接取消下载 →
   handler 是 archify 导出按钮能用的必要条件

## 开发过程中修掉的两个 bug

- **CSP 拼接缺分号**：`connect-src 'self' ws: wss: frame-src ...` 把 frame-src 拼进了
  connect-src 的源表达式（renderer console 警告暴露，冒烟实测抓到）→ 已修 + 注释标注
- **冒烟脚本下标错误**（测试 bug，非产品 bug）：源码模式工具条切换钮下标与预览模式
  不同，点到了「浏览器打开」→ 组件改为切换钮恒定位首位 + 测试修正

## 已知降级（ADR-034 裁决确认，非缺陷）

- Ctrl+F 不搜 iframe 内容（opaque origin，与 ImageViewer 同款不消费 search）
- 切面板回来 iframe 整页重载（100-300ms，从顶部开始；iframe 对 renderer 是黑盒）
- localStorage 不可用（sandbox 不给 allow-same-origin）
- 深浅主题跟随 OS，不跟 Marina 应用主题
- 非同目录相对资源被白名单拒绝（403，自包含契约）
- iframe 自导航到外部 origin 未显式拦截（纵深项，靠 served CSP + sandbox 收敛；
  显式 onBeforeRequest 堵漏列在方案里，实现时评估为 v1 可延后 —— 风险面：
  外部页面在 iframe 内渲染，无 node 访问、无 popups、无父页面访问）

## 我没测的东西（需要开发者手测）

- 真实 archify 产物（我的 fixture 是最小模拟：内联脚本 + 内联 SVG）——
  深浅主题切换、轨迹动画、canvas 导出按钮的**体感**正确性
- 真实下载落盘（冒烟未断言 will-download 全链；Downloads 目录 + toast）
- 视觉（工具条样式、iframe 背景过渡、深浅主题下的观感）
