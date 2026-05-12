# CP-1 用户测试指南

> **历史档案**:本文件创建于 alpha 阶段,产品当时叫 EasyTerm,自 v1.5 起更名为 Marina(见软件定义书 ADR-012)。下文 "EasyTerm" 字样保留作为时间点快照。

照着这份单子按顺序测,每条标 ✅ 或 ❌ + 一句话说明。**全部 ✅ 后回复"CP-1 通过",我才会开始 CP-2。**

> 如果某一条 ❌，把现象（截图 / 错误信息 / 日志最后 50 行）贴给我，我修完再发起一次自测。

---

## 准备

- 已经跑过 `npm install`（成功）
- 当前在 `checkpoint-1` 分支
- Node 20+

---

## 测试 1：基础启动 + xterm 显示 PowerShell（预计 1 分钟）

1. 在仓库根跑：
   ```powershell
   npm run dev
   ```
2. 等待 ~10 秒，应该看到：
   - PowerShell 里依次输出 Vite 编译信息（main + preload + renderer），最后停在 Vite dev server URL（127.0.0.1:5800 之类）
   - 一个 EasyTerm 窗口弹出（深色背景）
3. 窗口结构应为：
   - 顶部窄条：紫色 "EasyTerm" + 黄色框 "Window 1" + 右侧版本号 v0.1.0-alpha.0
   - 顶部之下另一窄条：绿色圆点 + "PowerShell · pid 12345" + 右侧 cwd 路径
   - 主区：xterm 终端，能看到 PowerShell 提示符（类似 `PS C:\Users\liyue>`）

4. 在终端里打 `dir` 回车，应看到当前 cwd（你的 user 目录）的文件列表
5. 打 `Get-Date` 看到当前时间

**✅ 通过**：以上每一条都成立
**❌ 失败现象 → 怎么贴日志**：
   - 窗口空白 / xterm 区域空：DevTools 应该已经独立打开（detached），切到 Console 标签页贴报错
   - 终端里无提示符或乱码：贴 `npm run dev` PowerShell 里的最后 50 行 + DevTools Console 报错
   - 窗口都没出现：贴 `npm run dev` 的全部输出
   - 窗口出现但顶部 statusbar 显示"启动 PowerShell 失败"：贴那段红色错误内容（点击错误展开）

---

## 测试 2：关闭窗口不退出应用（预计 30 秒）

承接测试 1 已开的应用。

1. 关闭那个窗口（点窗口右上角的 ×）
2. 看 Windows 系统托盘（任务栏右下角，可能要点向上箭头展开），应该有一个 EasyTerm 图标（深紫色边框 + 浅紫色内填的小方块）
3. 打开任务管理器（Ctrl+Shift+Esc），在"进程"标签搜索 "EasyTerm"
4. **预期**：你能看到 EasyTerm 进程仍在跑（多个，因为有 main + GPU + Renderer 等子进程）

**✅ 通过**：托盘里有图标 + 任务管理器里 EasyTerm 还在
**❌ 失败现象**：
- 关窗后任务管理器里 EasyTerm 完全消失 → 复制 `npm run dev` 终端的最后 30 行
- 托盘里看不到 EasyTerm 图标但进程还在 → 这是图标问题，不致命，记下来即可（CP-4 会有真图标）

---

## 测试 3：托盘单击 → 新开窗口编号 +1（预计 30 秒）

承接测试 2，应用还在跑（任务管理器里有进程，但没有窗口）。

1. **单击**系统托盘里的 EasyTerm 图标
2. 应弹出一个新窗口
3. 窗口顶部的徽章应显示 **"Window 2"**（不是 Window 1）
4. 新窗口的 xterm 里同样有 PowerShell 提示符可用

**✅ 通过**：新窗口出现且编号是 2
**❌ 失败**：
- 单击托盘没反应 → 确认托盘图标可见且鼠标命中正确（有些 Win11 任务栏需要单击展开三角形再点）
- 新窗口编号不是 2（比如又是 1）→ 这是 bug，截图给我

---

## 测试 4：托盘右键菜单 + "完全退出"（预计 30 秒）

承接测试 3。

1. 右键托盘里的 EasyTerm 图标
2. 应弹出菜单：
   ```
   打开新窗口
   ─────────
   完全退出 EasyTerm
   ```
3. 先试"打开新窗口"：再开一个窗口，应是 **Window 3**
4. 再次右键托盘，点"完全退出 EasyTerm"
5. **预期**：所有 EasyTerm 窗口立即消失，托盘图标消失，任务管理器里 EasyTerm 进程完全没有了

**✅ 通过**：完全退出后任务管理器里没有任何 EasyTerm 进程残留
**❌ 失败**：
- 右键无反应 → 检查 Windows 11 是否有右键菜单延迟（多右键几次）
- "完全退出"后托盘图标残留几秒 → 短暂残留是正常的（OS 缓存），3 秒后还在才算 bug
- 任务管理器里还有 EasyTerm 进程 → 截图给我

---

## 测试 5：单实例锁 + second-instance 新开窗口（预计 1 分钟）

> 这一项需要打包后的 .exe 才能严格测试，但 dev 模式下也能近似验证 second-instance 行为。

### 简化版（dev 模式，足够 CP-1 验收）

1. 跑 `npm run dev`，等窗口出现（Window 1）
2. **不要关闭那个 PowerShell**，**新开一个 PowerShell** 窗口
3. 在新 PowerShell 里 `cd` 到 `E:\projects\terminal`
4. 跑 `npm run dev`
5. **预期**：新跑的 `npm run dev` 应当快速失败或提示"另一个实例已在运行"，原来那个 EasyTerm 窗口里**应该多出一个新窗口**（Window 2）

> 注：dev 模式下 `npm run dev` 会试图启动一个新的 Electron 进程，第二个 Electron 进程因为 `requestSingleInstanceLock` 返回 false 会自己 quit；但 main 进程的 `second-instance` 事件会在第一个进程触发，从而新开窗口。

**✅ 通过**：原应用里多出一个 Window 2，第二个 npm run dev 退出
**❌ 失败**：第二次 `npm run dev` 把第一个干掉了，或两个独立 EasyTerm 都跑起来 → 这是单实例锁的问题，告诉我

### 严格版（可选，需要 build；不算 CP-1 必测，CP-4 才打包）

跳过即可，CP-4 才正式做打包测试。

---

## 测试 6（可选健康检查）：自动化测试 + typecheck

1. 在 `E:\projects\terminal` 跑：
   ```powershell
   npm test
   ```
2. **预期**：4 个 test files 全过，43 个 tests pass
3. 再跑：
   ```powershell
   npm run typecheck
   ```
4. **预期**：无任何输出（即类型检查通过）

**✅ 通过**：43/43 测试通过 + typecheck 无输出
**❌ 失败**：把失败的输出贴给我

---

## 全部通过后

回复一句话即可：

> CP-1 通过

我会开始 CP-2（核心数据模型 + 多窗口共享数据 + 三栏侧栏）。

---

## 故障排查速查

| 现象 | 第一步看哪 |
|---|---|
| `npm run dev` 起不来，端口 EACCES | `netsh interface ipv4 show excludedportrange protocol=tcp` 检查保留段，必要时设环境变量 `$env:EASYTERM_DEV_PORT="8800"` |
| node-pty 报错 "module was compiled against a different Node.js version" | 跑 `npx electron-rebuild`（postinstall 应该会跑，但若手动需要） |
| xterm 区域空白但 DevTools 没报错 | 检查 ResizeObserver 是否触发了 fit；调浏览器窗口大小看是否补救 |
| 应用启动慢（>10 秒） | 第一次 Vite 编译比较慢，第二次会快很多 |
| 托盘图标看不见 | Win11 默认隐藏部分托盘图标，点 `^` 展开框 |
