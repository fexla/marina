# CP-WebViewer 用户测试指南（HTML 预览，ADR-034）

预计 3-5 分钟。前提：`npm install` 已装好依赖。

## 准备（1 分钟）

1. `npm run dev` 启动应用
2. 任一终端 session 里确认 Marina 环境：面板能出现即说明 CLI 通道正常

## 测试 1：基础 HTML 预览（预计 1 分钟）

1. 生成一个测试产物（在终端里跑）：
   ```powershell
   $ws = & ".pi\skills\show-in-marina\marina.cmd" workspace
   Set-Content -LiteralPath (Join-Path $ws 'test.html') -Encoding utf8 -Value @'
   <!doctype html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;padding:24px}button{font-size:16px;padding:8px 16px}</style></head>
   <body><h1>Marina HTML Preview</h1>
   <p id="status">script pending...</p>
   <svg width="120" height="40"><rect width="120" height="40" rx="8" fill="#4a9eff"/><text x="12" y="25" fill="#fff" font-size="14">inline svg</text></svg>
   <script>document.getElementById('status').textContent='inline script ran at '+new Date().toLocaleTimeString();</script>
   </body></html>
   '@
   & ".pi\skills\show-in-marina\marina.cmd" show (Join-Path $ws 'test.html')
   ```
2. **预期**：面板自动切到「已打开」，`test.html` tab 显示**渲染后的网页**（蓝色
   SVG 圆角块 + "inline script ran at 时间"字样），不再是源码文本
3. 工具条三个按钮：**查看源码 / 重新加载 / 浏览器打开**
4. 点**查看源码** → 显示高亮源码（工具条变两钮：返回预览/浏览器打开）→ 点
   **返回预览** → 回到渲染视图
5. **失败时**：把 `~/AppData/Roaming/Marina/logs/main.log` 最后 50 行发给 agent

## 测试 2：热刷新（预计 30 秒）

1. 保持 test.html 的 tab 打开
2. 用任意外部编辑器覆盖保存同一文件（把 h1 文字改掉）
3. **预期**：约 1 秒内面板里的网页自动重载为新内容（fs.watch 防抖 200ms + iframe 重挂）

## 测试 3：archify 真实产物（预计 1 分钟）

1. 让终端里的 agent 用 archify skill 生成一个架构图（或用它现成的任何 HTML 产物），
   `marina show <产物.html>`
2. **预期**：图表正常渲染；深色/浅色主题跟随**系统**设置（不是 Marina 的主题 ——
   这是裁决 Q4 确认的行为）；如有交互（hover/动画）应正常响应
3. 点产物里的**导出 PNG** 按钮（若有）
4. **预期**：右下角出现 in-app toast「已下载：xxx（下载文件夹）」，去系统
   「下载」文件夹确认文件存在

## 测试 4：安全边界抽查（预计 30 秒）

1. 把 test.html 里加一行 `<img src="https://example.com/x.png">` 覆盖保存
2. **预期**：图片加载失败/不显示（自包含档 CSP 禁一切 http(s) 出网）—— 这是设计行为
3. 同目录放一个 `style.css`，html 里 `<link rel="stylesheet" href="style.css">` → **应生效**
   （同目录兄弟资源在白名单内）；改成 `../style.css`（目录外）→ 不生效

## 测试 5：旧 tab 兼容（预计 30 秒）

1. 打开过 test.html 后**完全退出** Marina（托盘 → 完全退出），再启动
2. **预期**：该 session 恢复后 test.html 的 tab 直接是渲染视图（不是源码文本）——
   快照恢复时 kind 自动重检测升级

## 全部通过后

回复 agent："CP-WebViewer 通过"。发现问题按条列出。
