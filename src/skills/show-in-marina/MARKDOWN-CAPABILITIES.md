# Markdown 面板能力参考（AI 写文档标准格式）

> 这份文档是 **Marina「已打开」文件面板渲染 Markdown 时的全部能力清单**，也是 AI 写
> Markdown 文档时应遵循的「标准格式」参考。凡是 `marina show <file>` 打开的 `.md`
> 文件，以及命令面板渲染的 Markdown 输出，都在下面这套能力范围里。
>
> **用途**：写报告 / 方案 / 排错指南 / 教程 / 任务看板时，按这里的能力主动使用可点击
> 链接、可运行代码块、图片、gallery 等，而不是只输出纯文本 Markdown。
>
> **对照源码**：
> - `src/renderer/components/file-panel/MarkdownDocument.tsx`（链接/图片/代码块/目录）
> - `src/renderer/components/file-panel/MarkdownCodeBlock.tsx`（可运行代码块，ADR-023）
> - `src/renderer/components/file-panel/GalleryViewer.tsx`（gallery，ADR-026）
> - `src/renderer/components/file-panel/FileViewer.tsx`（文件类型分发）
> - `src/shared/markdown-command.ts`（运行按钮语言判定）
> - `src/shared/gallery-parser.ts`（gallery 语法）

---

## 0. 一句话

面板把 Markdown 当**可交互文档**渲染：链接可点击、代码块可一键运行、图片可直接看图、
还能做画廊和目录导航。但这些能力大部分**只在「已打开」面板里打开真实文件的 Markdown
才完整可用**；命令输出（无文件路径）只有部分能力。

---

## 1. 可以打开哪些文件（点进面板的）

`marina show` 打开的文件按类型分流到不同查看器：

| 类型 | 查看器 | 说明 |
|---|---|---|
| `markdown` `.md`/`.markdown` | MarkdownDocument | 本篇说的所有交互能力 |
| `text` | TextViewer | 源码 / 日志 / 任意纯文本 |
| `image` | ImageViewer | 图片 |
| `diff` | DiffViewer | Git diff |
| 其它二进制 | 占位 | 提示「暂不支持预览」 |

想要可点击链接 + 可运行代码块 + 图片 + gallery，**用 `.md` 文件**。

---

## 2. 链接（`[text](target)`）— 按 scheme 分流

写 Markdown 链接时，**用什么链接形式决定点击后的行为**：

### 2.1 本地文件链接（默认，进面板）
路径**相对 Markdown 文件所在目录**解析（也可用绝对路径），点击在面板里**只读打开**
为目标文件的新标签。可以指向另一个文档、源码、日志、图片都行。

```markdown
看 [设计说明](./design-notes.md) 和 [入口文件](../src/main.ts)。
```

- 相对路径基准 = **md 文件自己的目录**（不是终端 cwd）——md 文件移动后只要相对布局
  不变，链接仍然有效。
- 点指不存在的 / 非文件路径 → toast 报错，面板不变。
- **目录链接是被拒绝的**（不是文件 → 报错）。要展开目录内容请用 gallery 或正文。

### 2.2 网页链接（系统浏览器）
写**完整** `http://` / `https://`（或 `mailto:`），点击用系统浏览器打开——面板不是浏览器。

```markdown
文档：<https://react.dev/learn> · 联系[我](mailto:me@example.com)
```

### 2.3 页内锚点（当前文档内滚动）
`#section-id` 在当前文档内定位。Marina 给标题分配稳定的 Unicode 兼容 id，
重复标题自动加 `-1`、`-2`…后缀。

```markdown
[跳到上面的「链接」](#2-链接texttarget-按-scheme-分流)
```

### 2.4 关键规则
- **不是完整 `http(s):/mailto:` 且不是 `#` 的，一律按本地文件处理**。所以：
  - 裸 `example.com/x`（无 scheme）、`data:`、`tel:`、`file:` → 被当本地路径，通常 toast 失败。
  - **网页链接永远要写完整 scheme**。
- 本地链接在面板里是**只读查看**，面板不是编辑器。

---

## 3. 可运行代码块（ADR-023）

fenced 代码块关键在**语言标签**：命中受支持 shell 就出现「运行」按钮。

### 3.1 受支持的运行语言（写对了才有按钮）
```markdown
```bash        # bash/sh/shell/zsh/fish/ksh/dash → POSIX/Git Bash
```powershell  # powershell/pwsh/ps1            → PowerShell
```cmd         # cmd/bat/batch/dos              → cmd.exe /c
```

其它语言（`python`、`json`、`ts`…）= **静态代码块**（可复制，无运行按钮）。

### 3.2 交互能力
- **运行**（整块）/ **运行选中**（选中几行浮出按钮，只跑选区）/ **停止**。
- 流式输出 + 退出码（0=绿，非 0=红）。
- 独立 `child_process.spawn`，**不经过 PTY** —— 不打扰当前终端/交互程序。
- `sudo` 运行仅对 **SSH 远程 session** 有意义（会要密码），本地 session 不会显示。

### 3.3 怎么写才可运行（标准格式）
- **一个逻辑步骤一个块**：块别做五件无关的事，用户没法分开跑。
- **输出要自解释**：命令末尾加 `echo` / `Write-Host` 打印要查看的值。
- **块之间状态不保留**：每个 Run 起全新 shell，跨块依赖要放同一块或让后块自建。
- 排错 / 教程向导：prose 叙述 + 命令放块里，用户原地点跑看结果。
- **不要把破坏性命令放进可运行块**（除非明确意图）；优先「try these」检查命令。

---

## 4. Gallery 图片表（ADR-026）

用 ` ```gallery ` 代码块把**一批图片**渲染成幻灯片（一次一张 + 缩略图条 + 键盘 `←/→`）。

### 4.1 语法
```gallery
# 每行一个图片引用；# 开头是注释，会被忽略
./screenshots/overview.png
./screenshots/detail.png
https://example.com/hero.png
```

- **每行一个**图片引用。来源两种：
  - 本地路径（相对 md 目录 / 绝对路径）
  - 网络 URL（`http(s)://`）
- 点主图 → 用**系统图片查看器**打开原图。
- 空块显示「（空 gallery…）」。

### 4.2 什么时候用 gallery
- 一组截图 / 设计稿对比 / 图片集展示，比散落的单个 `![...]()` 更整齐。
- 本地图相对 md 目录解析（与 markdown 图片同基准）。

---

## 5. 本地图片（Markdown 图片语法）

```markdown
![示例图](./img.png)
```

- 本地路径相对 **md 文件所在目录**解析。
- 网络图（`http(s)`）直接显示。
- 经 main 转 dataUrl，**CSP 安全**，不会因 scheme 不匹配被拦。
- 无文件路径的来源（命令输出）→ 显示本地图占位，不猜测目录。

---

## 6. 目录 / 标题导航

- Markdown 打开后**自动生成标题大纲**（窄轨道，hover 展开成可点目录）。
- 层级标题可折叠成章节。
- `marina show <file> --heading "xxx"` 打开后直接跳到该标题（一次性请求）。
- 内页 `#anchor` 与 `show --heading` 都基于同一套标题 id。

---

## 7. 其它能力与硬性约束

| 能力 | 说明 |
|---|---|
| 滚动位置恢复 | 切走切回、文件刷新后尽量复原阅读位置 |
| 文件内查找 | dock 级搜索 + 高亮 |
| 复制 | 代码块带复制按钮 |
| Markdown 主题 | 用户在设置里选 auto（Marina 主题）/ GitHub 官方样式 |

| 硬性约束 | 说明 |
|---|---|
| **只读查看器** | 面板不编辑文件 |
| **文件 >2MB** | 只渲染前 2MB，末尾显示截断标记 |
| **图片 >10MB** | 预览时拒绝 |
| **原始 HTML 禁用** | rehype-raw 关闭，Markdown 一律当不可信输入。AI 文档**不要**依赖 raw HTML，要用 Markdown 语法表达 |
| **无文件路径则降级** | 命令输出不能点本地链接/本地图/gallery（本地路径能力由真实文件路径 gate） |

---

## 8. AI 写文档的速查 checklist

写 Markdown 文档到面板前，逐条自问：

- [ ] 要引用别的文档 / 源码 / 文件？→ 用**本地相对路径链接**（`[x](./a.md)`），它会在面板点开。
- [ ] 要引用网页？→ 写**完整 `http(s)://`** URL。
- [ ] 要展示一份操作步骤？→ 每个步骤一个**可运行代码块**（bash/powershell/cmd），让用户点跑。
- [ ] 要展示一组图？→ 用 **` ```gallery `** 块，每行一张。
- [ ] 要贴单张图？→ 用 markdown **图片语法** `![alt](./x.png)`。
- [ ] 想在文档内跳转？→ 用 **`#锚点`** 链接。
- [ ] 有没有用 raw HTML？→ 换成 Markdown 语法（raw HTML 会被禁用）。
