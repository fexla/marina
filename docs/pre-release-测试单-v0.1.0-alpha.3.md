# Marina v0.1.0-alpha.3 发布前统一测试单

> 合并自:`CP-4-user-test-guide.md` + M1 工作记录 §2 真机验证清单 + `explorer-集成-工作记录-20260512.md` 手测脚本 + alpha.1 / alpha.2 修复项的回归。
> **测试对象**:packed `.exe`(Setup 或 Portable),不要在 dev 模式跑。alpha.2 已发布,本测试单针对**即将发布的 alpha.3**(在 alpha.2 基础上叠加 "标题栏拖动区域" 修复)。
> 预计耗时 45-60 分钟。每项要么打 ✅ 要么记下失败现象。

---

## 0. 准备

```powershell
# 1) 完全退出旧版(若有)
# 托盘右键 → 完全退出;任务管理器确认无 Marina.exe / EasyTerm.exe 残留

# 2) 备份旧数据(可选,出问题时可滚回)
Copy-Item -Recurse $env:APPDATA\Marina "$env:USERPROFILE\Desktop\Marina-backup-$(Get-Date -Format yyyyMMdd-HHmm)"

# 3) 安装本次测试包(Setup 或 Portable)
# Setup:双击 Marina-Setup-0.1.0-alpha.3-x64.exe → 默认路径
# Portable:把 .exe 拷到固定位置(避免事后改路径)

# 4) 启动 Marina
```

启动后应看到:自绘标题栏(无 OS 蓝条)+ 侧栏 + 主区 + ⚙ 设置按钮。

---

## A. 启动 + 窗口外壳 〔回归 + M1-A〕

| # | 测试 | 通过判据 | 备注 |
|---|---|---|---|
| A1 | 应用启动 | 主界面渲染,**不是白屏**,不报 `Not allowed to load local resource` | **alpha.1 回归** — packed renderer load 修复验收点 |
| A2 | 标题栏整条都能拖 | 鼠标放在标题栏**任意位置**(顶部边缘 / 底部边缘 / 文字之间 / "Window 1" 徽标处 / 中间空白)都能按住拖动窗口 | **alpha.2 回归** — `-webkit-app-region` 翻转修复验收点。这条最容易漏 — 务必试上下两条窄边 |
| A3 | 标题栏双击 | 切最大化 / 还原 | 自绘标题栏自接的行为 |
| A4 | Windows 风格三按钮 | min / max / close 可点;close hover 变红 | 默认 windowStyle |
| A5 | 切到 macOS 风格 | 设置 → 外观 → 窗口风格 = macOS → **立即**变左侧 traffic light;hover 显示内部 × − ⤢ | 即时切换 |
| A6 | 切回 Windows | 立即恢复右侧按钮 | |
| A7 | 7 套主题切换标题栏跟着变 | 切到任意主题(尤其 Dawn 浅色 / Ubuntu 棕紫 / Windows Terminal 黑),标题栏颜色立即跟,无残留 | |
| A8 | 关闭单窗口绝不弹对话框 | 点窗口右上 × → 直接关 → 任务管理器看 Marina.exe **还在**(进入纯托盘模式) | 产品哲学红线 |
| A9 | 单击托盘 → 重开窗 | 窗口编号 +1(Window 2)| CP-1 回归 |
| A10 | 完全退出 | 托盘右键 → 完全退出 → Marina.exe 真消失 | CP-1 回归 |

---

## B. 窗口位置记忆 + 多窗口 〔M1-G〕

| # | 测试 | 通过判据 |
|---|---|---|
| B1 | 拖窗口到非默认位置 + 改尺寸 → 关 → 重开 | 还在原位 + 原尺寸 |
| B2 | 最大化 → 关 → 重开 | 重开时也是最大化 |
| B3 | 拖到副屏(若有)→ 关 → 拔副屏 → 重开 | 不出屏(回到主屏居中) |

---

## C. 主题 / 字体 / UI 〔CP-4 chunk 2〕

| # | 测试 | 通过判据 |
|---|---|---|
| C1 | 7 主题切换 | 即时生效,**不闪白**,UI + xterm 颜色同步换 |
| C2 | 主题持久化 | 关应用 → 重开 → 仍是上次的主题 |
| C3 | 终端字体下拉 | 列出本机已装字体(Cascadia Mono / JetBrains Mono / Consolas …),未装的带 `(未装)` |
| C4 | 终端字号 8-24 即时生效 | 改到 18 → 字体变大 |
| C5 | 终端行高 1.0-2.0 即时生效 | 改到 1.5 → 行距变宽 |
| C6 | UI 字体 / UI 缩放 | 改了立即影响侧栏 / 标签 / 按钮 |
| C7 | Ctrl + 鼠标滚轮 调字号 | 在终端区滚 → 字号变;**所有窗口同步**(M1-I)|

---

## D. Shell 检测 + 模板系统 〔CP-3 + CP-4 chunk 2〕

| # | 测试 | 通过判据 |
|---|---|---|
| D1 | 默认 shell 下拉列出本机 shell | 至少 1 个(pwsh / powershell / cmd / git-bash 任一) |
| D2 | 切换默认 shell 后新建终端用新的 | `$PSVersionTable` 或 `ver` 验证版本 |
| D3 | 4 内置模板可见 | 🐚 Shell / 🤖 Claude Code / ⚡ Codex / 📦 OpenCode,内置不可删 |
| D4 | 设默认模板 | 点 [设为默认] → 紫色"默认" tag 移到该行 |
| D5 | 编辑内置模板 name | 点 [编辑] → 子页 → 改 name → 保存 → 列表更新 |
| D6 | 新建自定义模板 | name=echo-test / cmd=echo / args=hi → 创建成功 |
| D7 | 自定义模板可在主区选中并启动 | 选 echo-test 起 session → 终端输出 `hi` |
| D8 | 删除自定义模板 | 列表减一行 |

---

## E. Sidebar + 路径三态 〔CP-2 + CP-3〕

| # | 测试 | 通过判据 |
|---|---|---|
| E1 | + 添加收藏 | 弹文件夹选择器 → 选目录 → 进收藏分类 |
| E2 | 拖 Explorer 文件夹到侧栏 | 加入收藏分类 |
| E3 | 双击收藏路径 → 默认模板 session | 终端在该路径打开 |
| E4 | `cd D:\elsewhere` | tab 旁出 ⚠️;**session 仍归属原 path 分类**(不迁移)|
| E5 | session 内 `exit` | tab 变灰 + ⚫,scrollback 保留,**永不自动消失** |
| E6 | 右键灰 tab → 关闭 | tab 消失,session 真销毁 |
| E7 | 收藏移到最近 | 右键收藏路径 → 移除收藏 → 该路径若无 session → 进最近 |

---

## F. 右键菜单完整化 〔M1-C〕

| # | 测试 | 通过判据 |
|---|---|---|
| F1 | Sidebar 收藏路径右键 | 5 项可点;**重命名走行内编辑**(Enter 提交 / Esc 取消);"移除收藏" 标红 |
| F2 | Sidebar 临时路径右键 | 菜单项与收藏不同(有"加入收藏",无"移除收藏") |
| F3 | Sidebar 最近路径右键 | 菜单项再不同(有"加入收藏"+"从最近移除") |
| F4 | Sidebar session item 右键 | 6 项可点;"完整命令" 显示为 disabled hint(不能点,鼠标变 not-allowed) |
| F5 | Tab 右键 | 5 项可点;**跨窗口持有时**"重命名"和"关闭"灰显 |

---

## G. 拖文件夹到终端区 〔M1-B〕

| # | 测试 | 通过判据 |
|---|---|---|
| G1 | 从 Explorer 拖文件夹到终端区(不是侧栏) | 全屏出现半透明 dropzone + "松开鼠标 — 在该文件夹打开新终端" |
| G2 | 松手 | 在该路径新建 session 并切到 |

---

## H. 托盘菜单完整化 〔M1-H〕

| # | 测试 | 通过判据 |
|---|---|---|
| H1 | 右键托盘 | 完整菜单 6 项(打开新窗口 / 显示所有 / 关闭所有 / 正在运行的会话子菜单 / 设置 / 完全退出) |
| H2 | 会话子菜单 | 显示当前所有 session 列表 |
| H3 | 点会话子菜单条目 | 聚焦该 session 所属窗口 + 选中该 session |
| H4 | watch 命令运行时托盘动态图标 | 启动 `Get-ChildItem -Recurse C:\Windows\System32` 这种长输出的 → 托盘图标右下角出**绿点**;Ctrl+C 停止后绿点消失 |

---

## I. 行为分类 〔CP-4 chunk 2 + M1-A〕

| # | 测试 | 通过判据 |
|---|---|---|
| I1 | "启动时行为" 切到"仅托盘" | 关所有窗口 + 退出 + 重启应用 → 不弹窗口,只托盘图标;单击托盘弹窗 |
| I2 | "完全退出前确认" | 有 session 时托盘"完全退出" → 弹 "还有 X 个终端在运行" → 取消 → 不退;再次 → 完全退出 → 真退 |
| I3 | 同 I2,但所有 session 已 exited | **不**应弹对话框,直接退 |
| I4 | "选中即复制" 开关 | 勾上:终端选中文字 → 粘贴记事本有内容;关掉:选中不复制 |
| I5 | "终端右键行为" = 弹菜单 | 终端区右键 → 弹菜单(复制 / 粘贴 / 清屏 / 搜索);选中文字时复制项可点,否则灰 |
| I6 | "终端右键行为" = 直接粘贴 | 切到此选项 → 右键终端 → 直接粘贴剪贴板内容,不弹菜单 |
| I7 | 开机启动 | 勾上 → `regedit` 看 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 有 Marina 项;取消勾 → 该项消失 | **可跳** 验证完整链路需重启 Win |

---

## J. 终端体验 〔CP-4 chunk 3〕

| # | 测试 | 通过判据 |
|---|---|---|
| J1 | Ctrl+F 搜索栏 | 终端右上角弹出 input + ↑ ↓ Aa ×;输入词 + Enter 高亮匹配 |
| J2 | 搜索导航 | Enter 下一个;Shift+Enter 上一个;Aa 切大小写敏感(匹配数变化) |
| J3 | Esc 关搜索 | 关闭 + 焦点回终端,可继续输入命令 |
| J4 | 多行粘贴确认 | 复制 ≥2 行文本 → 终端右键粘贴(或 Ctrl+V)→ **弹 confirm**;单行不弹 |

---

## K. 数据导入导出 〔CP-4 chunk 4〕

| # | 测试 | 通过判据 |
|---|---|---|
| K1 | 准备状态 | 先加几个收藏 + 新建几个 session + 创建一个自定义模板 + 改主题 |
| K2 | 导出 | 设置 → 数据 → 导出 → 保存对话框 → 文件名 `marina-config-YYYYMMDD-HHMM.json` |
| K3 | 导出文件可读 | 记事本打开 → 合法 JSON,顶层 `format: "marina-archive"` / `version: 1` / `settings` / `bookmarks` / `recent` / `templates`(读侧也接受旧 `easyterm-archive`)|
| K4 | 修改一些设置后再导入 | 改主题 + 删一个收藏 → 设置 → 数据 → 导入 → 选刚才的 JSON → **二次确认** |
| K5 | 导入生效 | 确认后 **不重启应用** (M1 改进:in-memory replace) → 主题 / 收藏 / 模板 / 设置全部回到导出时的状态 |

---

## L. 高级 + 关于 〔CP-4 chunk 4-5〕

| # | 测试 | 通过判据 |
|---|---|---|
| L1 | 日志级别 INFO / DEBUG 切换 | 写入 `%APPDATA%\Marina\settings.json`,DEBUG 模式 logs/ 下文件变大 |
| L2 | "打开日志目录" | Explorer 弹出 `%APPDATA%\Marina\logs\` |
| L3 | 重置所有设置 | 二次确认 → 主题回 Rose Pine / 字号回 13;**bookmarks / templates 不动** |
| L4 | 关于页:版本号 | 显示 `0.1.0-alpha.3` |
| L5 | 关于页:构建信息 | `commit <短 hash> · <ISO 时间>`,short hash = 当前 HEAD 前 7 位 |
| L6 | "打开 GitHub Releases" | 系统浏览器打开 https://github.com/Liyue-Cheng/marina/releases |
| L7 | 致谢链接 | 点 Electron → 浏览器打开 electronjs.org |

---

## M. ⭐ Explorer 右键集成 〔本次新功能,重点验〕

| # | 测试 | 通过判据 |
|---|---|---|
| M1 | 设置 → 系统集成 → 勾选"启用" | `regedit` 看 `HKCU\Software\Classes\Directory\shell\Marina` + `Directory\Background\shell\Marina` 各 2 个键值(default + command 子 key) |
| M2 | command 字段正确 | command 子 key 默认值 = `"<exe 绝对路径>" --open-here "%1"`(Directory)/ `"%V"`(Background)|
| M3 | 桌面新建文件夹 → 右键 | 出现"在 Marina 终端中打开" |
| M4 | 点击触发(默认 new-window) | **新开一个窗口** + 该路径 PowerShell session(cwd = 该文件夹) |
| M5 | 切到 "在最近活动的窗口新开标签" | 设置 → 系统集成 → 切换选项 → 再右键文件夹 → **当前窗口新 tab**(不开新窗) |
| M6 | 文件夹空白处右键 | 进 `Documents` → 在空白处右键 → 同样有菜单项 → 点击 → cwd = `Documents` |
| M7 | 冷启动场景 | 完全退出 Marina → 右键任一文件夹 → Marina 启动 + 直接打开新窗 + 落在该路径(冷启动一律新窗,即使设置是 recent-window-tab)|
| M8 | 关闭功能 | 设置 → 取消勾选 "启用" → regedit 验 Marina 两个根 key 消失 → Explorer 右键不再出现菜单项 |
| M9 | 路径不存在兜底 | PowerShell 跑 `& "<exe path>" --open-here "Z:\nonexistent"` → Marina 启动 / 现窗,session cwd 退回 `%USERPROFILE%`,**不闪退** |
| M10 | EasyTerm 残留清理(可选)| `regedit` 手动建 `HKCU\Software\Classes\Directory\shell\EasyTerm`(default 随便填)→ 启动 Marina → 该 key 应被自动删 |

---

## N. 全局护栏 〔M1-D + M1-J〕

| # | 测试 | 通过判据 |
|---|---|---|
| N1 | 主进程崩溃兜底 | 任意窗口按 F12 开 DevTools → console 跑 `throw new Error('test')` → **应用不死** → `%APPDATA%\Marina\logs\` 下有日志记录 |
| N2 | 不可达路径 toast | 用 Explorer 把一个已收藏的文件夹删掉或重命名 → 在 Marina 双击该收藏路径 → 弹 toast 错误 |
| N3 | OS 默认菜单已禁 | 按 Alt 键 → **不**弹 File / Edit / View 顶部菜单条 |
| N4 | DevTools 仍可开 | F12 / Ctrl+Shift+I 切换 DevTools(诊断通道,packed 模式也要可用)|

---

## O. 打包与首次安装

| # | 测试 | 通过判据 |
|---|---|---|
| O1 | Setup 安装 | 双击 → 安装向导 → 默认路径 + 桌面 + 开始菜单快捷方式都创建 |
| O2 | 控制面板"程序"列表有 Marina | 显示版本 0.1.0-alpha.3 |
| O3 | Setup 卸载 | 控制面板卸载 → 安装目录文件清干净 |
| O4 | Portable 双击直跑 | 不弹安装向导,直接启动 |
| O5 | 无 missing DLL 错误 | 干净 Win11 上首次启动不报 `VCRUNTIME140.dll 找不到` 之类 | 干净 Win11 VM 没条件可跳 |

---

## 已知不测 / 不做(显式)

- 跟随系统主题 — CP-4 errata #2 已移除该功能,UI 上没有此开关
- `build/icon.ico` — 暂未生成,任务栏 / Explorer 右键菜单图标走 Electron 默认灰齿轮
- 自动更新 — 见 `docs/known-issues.md` KI-002,本期不做
- 干净 Win11 VM 测试 — 没条件可跳
- 开机启动需重启 Win 验证 — I7 可跳

---

## 测试完后

- **全部 ✅** → 回 "可以发 alpha.3"
- **有 ❌** → 列出失败项 + 现象(截图 / regedit 内容 / 错误文本均可),我修复后再打包

下面这些回归项**务必单独标注**(它们是这次发布的核心修复):
- **A1**:packed renderer 能加载(否则白屏)
- **A2**:标题栏整条都能拖(否则只能拖文字窄带)
- **M1-M10**:Explorer 右键集成(本期新功能)

其余项目大多在 CP-1 / CP-2 / CP-3 / M1 阶段已经在 dev 模式 / 之前的版本验证过,这次主要做**回归确认 + 在 packed exe 上首次跑通**。
