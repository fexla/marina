# CP-2 用户测试指南

> **历史档案**:本文件创建于 alpha 阶段,产品当时叫 EasyTerm,自 v1.5 起更名为 Marina(见软件定义书 ADR-012)。下文 "EasyTerm" 字样保留作为时间点快照。


照着这份单子按顺序测，每条标 ✅ 或 ❌ + 一句话说明。**全部 ✅ 后回 "CP-2 通过"，我才会开始 CP-3。**

> 如果某一条 ❌，把现象（截图 / 错误信息 / 日志）贴给我，我修完再发起一次自测。

---

## 准备

1. 当前在 `checkpoint-2` 分支
2. 如果 CP-1 时还在跑 `npm run dev`，先 **托盘 → 完全退出 EasyTerm** 再退出 dev 服务器
3. 重新拉依赖（CP-2 没新增 npm 包，但保险起见）：
   ```powershell
   npm install
   ```
4. 跑：
   ```powershell
   npm run dev
   ```
5. 看到一个深色窗口 + 左侧三栏侧栏（**收藏 / 临时 / 最近**），右侧欢迎区。✅ 表示基础启动 OK，继续。

> 如果你想从 CP-2 开始**全新体验**（重置所有持久化数据），删 `%APPDATA%\EasyTerm\` 整个目录后再 `npm run dev`。

---

## 测试 1：三栏始终显示（10 秒）

1. 应用启动后看左侧栏
2. **预期**：三个栏目标题 "收藏 / 临时 / 最近" 都可见，每个旁边显示数字 `0`，下面写"空"
3. 收藏栏右侧应有一个 **+** 按钮

**✅ 通过**：三栏全可见
**❌ 失败**：缺栏 / 顺序错 / + 按钮没了 → 截图给我

---

## 测试 2：+ 按钮选文件夹加入收藏（30 秒）

1. 点收藏栏的 **+**
2. **预期**：弹出 Windows 原生"选择文件夹"对话框
3. 选一个文件夹（比如 `E:\projects\terminal` 本身）
4. **预期**：
   - 收藏栏出现一个新条目，名字是文件夹的最后一段（如 `terminal`）
   - 收藏栏 count 从 `0` 变成 `1`

**✅ 通过**
**❌ 失败 → 失败现象**：
- 对话框不弹 → 主进程日志报错？
- 选了文件夹但收藏栏没变 → DevTools Console 报错？(F12 打开)

---

## 测试 3：拖 Explorer 文件夹加入收藏（30 秒）

1. 打开 Windows Explorer，找一个文件夹（**注意：必须是文件夹，不是文件**）
2. 把文件夹拖到 EasyTerm 的左侧栏（看到边缘有蓝紫色虚线高亮 = drag-over 反馈）
3. 松开鼠标
4. **预期**：收藏栏出现新条目

**✅ 通过**
**❌ 失败现象**：
- drag-over 高亮出现但松手没加入 → DevTools Console 报错（可能是 Electron 不暴露 `file.path` 在你机器上）
- 拖文件而不是文件夹 → 应该报 `PathNotDirectory`，主进程日志可见

---

## 测试 4：持久化（关闭 → 重开 → 收藏还在）（1 分钟）

1. 测试 2/3 已加 1-2 个收藏
2. 托盘右键 → **完全退出 EasyTerm**
3. 重新跑 `npm run dev`（或在终端 Ctrl+C 后重跑）
4. **预期**：收藏栏里之前加的条目仍在

**✅ 通过**
**❌ 失败**：
- 收藏丢了 → 看 `%APPDATA%\EasyTerm\bookmarks.json` 是否存在 + 内容
- 把这个 json 文件内容贴给我

---

## 测试 5：双击收藏路径新建终端（30 秒）

1. 双击侧栏里的某个收藏路径
2. **预期**：
   - 该路径自动展开（▶ 变 ▼）
   - 出现一个 session 子条目（绿色圆点 + "Shell"）
   - 右侧主区域显示终端，启动 PowerShell，能看到 `PS X:\...>` 提示符
   - 顶部 statusbar 显示 cwd
   - 在终端打 `dir` 回车有输出

**✅ 通过**
**❌ 失败 → 主进程日志（PowerShell 跑 `npm run dev` 那个窗口的输出）贴出来**

---

## 测试 6：关闭 session，路径仍在收藏（20 秒）

1. 承接测试 5
2. 找到 TabBar 上那个 tab，hover 时右侧出现 ×，点它（或在侧栏右键 session）
3. **预期**：
   - tab 消失，主区显示空状态（大加号 + 模板按钮）
   - 侧栏里那个收藏路径**仍在收藏栏**（不变到临时或最近）
   - count 从 `1` 变 `0`

**✅ 通过**：收藏路径就是不动
**❌ 失败**：收藏路径跑去了临时或最近 → 这是 bug，截图

---

## 测试 7：临时分类自动出现（1 分钟）

1. 在某个**没收藏的**路径开终端
2. 操作：直接在已开的 session 里打 `cd C:\Windows`（或任何不在收藏里的路径）
3. （CP-2 不实现 cwd 跟踪，所以 cd 不会让 path 自动迁移。要测临时分类需用其他方法）
4. **改用**：打开 Explorer，找一个**新**文件夹（不是已收藏的），拖到侧栏
5. 收藏栏新增条目；右键这个新条目（**注：CP-2 还没实现右键菜单**）

**实测 CP-2 临时分类的方式**：
- 在某收藏路径的 path 上启动 session，session 持续运行
- 点托盘 + 选"打开新窗口"，开第二个窗口
- 第二个窗口里 DevTools Console 跑：
  ```js
  const r = await window.api.invoke('cmd:bookmark:remove', {pathId: 'C:\\path\\you\\just\\bookmarked'})
  ```
- 该 path 因为有 session 在跑，从收藏被移到**临时**（应该出现在临时栏）

…这个测试比较绕，CP-3 起会更直接。可以**跳过这一项**，记 `⚠️ CP-2 简化模式下难以直观验证，跳过`。

**✅ 通过 / ⚠️ 跳过都可接受**

---

## 测试 8：临时 → 最近自动流转（30 秒）

类似上面，需要先制造一个临时 path（有 session 在跑且不在收藏）。最简单做法：

1. 双击一个收藏路径开 session
2. DevTools Console（F12）跑：
   ```js
   await window.api.invoke('cmd:bookmark:remove', {pathId: '<那个路径完整名>'})
   ```
   (路径名从侧栏 hover tooltip 复制)
3. **预期**：路径从收藏栏消失，出现在**临时**栏（因为有 session 在跑）
4. 关掉那个 session 的 tab × 
5. **预期**：路径从临时栏消失，出现在**最近**栏

**✅ 通过 / ⚠️ 跳过都可**（这条测得比较曲折）

---

## 测试 9：多窗口数据共享（1-2 分钟）

1. 启动应用，加 1-2 个收藏（测试 2/3 已做）
2. 托盘菜单 → "**打开新窗口**"
3. **预期**：弹出 Window 2，左侧栏的收藏列表与 Window 1 完全相同
4. 在 Window 2 里 + 按钮新加一个收藏
5. **预期**：Window 1 的收藏栏立即出现这个新条目（不需要刷新）
6. 在 Window 1 删除某个收藏（用 DevTools Console：`window.api.invoke('cmd:bookmark:remove', {pathId: '<path>'})`）
7. **预期**：Window 2 的收藏栏立即少一个

**✅ 通过**：跨窗口收藏列表实时同步
**❌ 失败**：Window 2 没同步 → 主进程日志 + 两个 DevTools Console 截图

---

## 测试 10：跨窗口主题同步（30 秒）

1. 应用顶部 header 中间有一个 "🎨 rose-pine" 按钮
2. 在 Window 1 多次点这个按钮，名字会循环 `rose-pine` → `rose-pine-dawn` → `rose-pine-moon` → `cutie` → `business` → `rose-pine`
3. **预期**：Window 2 的同名按钮**立即同步**显示新主题名
4. 关闭应用、重开，主题名持久化（不会回到默认）

> 注：CP-2 只演示**设置同步**，颜色实际应用是 CP-4。所以你看到主题名变了但颜色没变，是设计如此。

**✅ 通过**：两个窗口的按钮文字同步变 + 重启后保留
**❌ 失败 → 截图**

---

## 测试 11：关窗后 session 变无主、可在另一窗口接管（关键，2 分钟）

这是 CP-2 最重要的功能——session 跨窗口存活。

1. 启动应用（Window 1），双击某收藏路径开一个 session（A）
2. 在 session A 里打 `Get-Date` 等命令证明它活着
3. 托盘菜单 → "打开新窗口" → Window 2
4. 在 Window 2 里也展开同一个收藏路径，应该**看到 session A 灰显**（半透明 + 右侧 ↗ 图标），状态：在其他窗口持有
5. 在 Window 2 点击那个灰显 session
6. **预期**：Window 1 浮到前台被聚焦（**不是**接管）
7. 现在主动关闭 Window 1 的窗口（点 ×）
8. **预期**：
   - Window 1 消失
   - 应用没退（任务管理器仍有 EasyTerm）
   - Window 2 里那个 session 的灰显标记消失，但变成**橙色斜体**（无主，可接管）状态
   - session 仍在跑（PTY 没死）
9. 在 Window 2 点击那个 session 标签
10. **预期**：Window 2 接管该 session，能继续输入命令、看新输出
11. ⚠️ **CP-2 限制**：接管后**看不到 Window 1 时期的历史输出**，只看到接管后的新输出。这是 scrollback 未实现的合理表现，CP-3 接入后修复

**✅ 通过**：关 Window 1 → session 不死，Window 2 能接管继续打命令
**❌ 失败现象**：
- 关 Window 1 时整个应用退了 → 严重 bug
- 关 Window 1 时 session 也死了 → 最关键的 bug，截图 + 日志
- Window 2 看不到那个 session → 跨窗口同步没工作

---

## 测试 12（可选）：自动化测试 + typecheck

```powershell
npm test                # 应该 149/149 pass
npm run test:coverage   # 核心模块 > 70%
npm run typecheck       # 三个 tsconfig 严格模式无错
```

---

## 全部通过后

回复一句话：

> CP-2 通过

我会开始 CP-3（Session 墓地 / cwd 跟踪 / 启动模板 / scrollback）。

---

## 故障排查速查

| 现象 | 第一步看哪 |
|---|---|
| 加书签 + 按钮没反应 | DevTools Console (F12) 看 cmd:bookmark:pick-folder 是否报错 |
| 拖文件夹无反应 | DevTools Console 跑 `console.log(JSON.stringify(Object.keys(File.prototype)))`,看 `path` 是否在 |
| 双击路径不开终端 | 主进程日志 "PtySpawnFailed" → 查 PowerShell 是否在 PATH;查 cwd 是否存在 |
| 跨窗口不同步 | 两个窗口的 DevTools Console 都看 `evt:` 事件是否到达 |
| 主题按钮不变名 | DevTools Console 跑 `await window.api.invoke('cmd:settings:get')` 看返回 |
| 应用启动后 settings.json 不存在 | 这是正常的(等用户首次改设置才写),DEFAULT_SETTINGS 内存中已用 |
