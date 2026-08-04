# 方案:修复「安装 Skill」在 Linux 上装出 Windows 版的问题

**起草时间**:2026-08-05
**状态**:待开发者裁决决策点后开工
**关联**:`docs/方案-BETA-003-Linux支持-20260517.md`(Linux 总体方案)、`docs/ipc-protocol.md`(`cmd:skill:install-marina`)、`docs/known-issues.md`

---

## 0. 背景与已定结论(自包含)

Marina 自 v1.6 / BETA-003 起正式支持 Linux(deb/rpm/AppImage,POSIX PTY,bash 优先)。
内置的 `show-in-marina` skill 让 AI agent(Pi / Claude Code / Codex)把产出文档展示到
Marina 终端侧的文件面板,而不是把长文糊进聊天。

**症状(用户报告)**:Linux 上点「安装 Marina Skill…」装出来的 skill 是 **Windows 版**,
agent 跟着 `SKILL.md` 走会在 Linux 上彻底失效。

### 根因(已定位,代码证据)

`SkillInstaller`(`src/main/skill-installer.ts`)**完全平台无关**——它只是把内置源目录
整目录 `fs.cp` 复制到 `<project>/.{pi,claude,agents}/skills/show-in-marina`。问题出在
**被复制的源内容**本身是 Windows 专用的:

| 文件 | 现状 | Linux 上后果 |
|---|---|---|
| `marina.ps1`(637 行,真正逻辑) | 头注释明确"目标 Windows 用户,靠系统自带 PowerShell,无额外运行时" | 仅当装了 `pwsh` 才能跑,**不保证、未测** |
| `marina.cmd` | cmd.exe 启动器 → `powershell.exe -File marina.ps1` | Linux 无 cmd.exe,**完全无用** |
| `marina`(无扩展名 bash 包装器) | 头注释写明"@scope: Windows-only",搜 `powershell.exe`,找不到就 `exit 127` | **直接 127 报错退出**,skill 形同虚设 |
| `SKILL.md` | 只讲 Windows 调用(`.\marina.cmd` / `bash marina` for Git Bash),无 Linux 段 | agent 不知道在 Linux 上怎么用 |

**关键事实**:skill 真正的后端 `file-panel-service.ts`(`src/main/`)是 **HTTP + Bearer
鉴权、完全平台无关**的本地服务。CLI 只是个瘦客户端——读 `MARINA_SERVICE`/`MARINA_TOKEN`/
`TERMINAL_ID` 三个环境变量,发 HTTP 请求。所以 Linux 版 CLI **不需要任何 Windows 东西**,
只是缺一个原生 POSIX 客户端。

### CLI 的完整命令面(从 `marina.ps1` 提取,决定移植工作量)

子命令:`ping` / `workspace`[` list [--json]` / `bind --name X [--new]` / `new` / `unpin [--name X]`]
/ `show` / `run` / `close`[` --all` / `--stale` / `--glob PAT`] / `list [--json]` / `screenshot [path]`

HTTP 端点(全部 Bearer 鉴权、terminal 作用域;`/health` 免鉴权):

```
GET  /health                          ping
GET  /workspace?terminal=             当前工作区路径
GET  /workspace/list?terminal=        命名工作区列表
POST /workspace/bind                  绑定/切换命名工作区
POST /workspace/new                   切到全新匿名工作区
POST /workspace/unpin                 取消命名+置顶
POST /open-file                       show 一个文件
POST /run                             触发代码块执行(SKILL.md 的"可运行代码块")
POST /close-files                     批量关(--all/--stale/--glob)
POST /close-file                      关单个
GET  /opening-files?terminal=         list
GET  /screenshot?terminal=            截图(返回二进制 PNG)
```

退出码:`0` 成功 / `1` Marina 离线或未在 Marina 终端 / `2` 用法错误 / `3` Marina 在线但拒绝。

**结论:这是个瘦 HTTP 客户端,纯 bash + curl 可以完整移植,无需任何额外运行时**——
正好延续 `marina.ps1` 头注释"拒绝 Python 以免引入运行时依赖"的同款哲学(Linux 上 bash +
curl + coreutils 是普遍存在的)。

---

## 1. 推荐方案:单目录 + 平台分支的入口分发器(Option D)

### 1.1 一句话

**不动安装器、不动打包**;在 skill 源目录里**新增一个原生 POSIX 客户端 `marina.sh`**
(bash + curl 实现 CLI 全部逻辑),并把无扩展名的 `marina` 改造成**平台分支分发器**:
检测到 `powershell.exe`(Windows)走老路(`powershell.exe -File marina.ps1`),检测不到
(Linux/macOS)`exec marina.sh` 走原生实现。

### 1.2 为什么是这个方案(对比过的备选)

| 方案 | 说明 | 取舍 |
|---|---|---|
| **A. 让 `marina` 直接内联全部 bash 逻辑** | 一个文件两种平台分支 | 单文件膨胀到 600+ 行,Windows/逻辑耦合,难维护 |
| **B. 要求 Linux 装 `pwsh`,复用 `marina.ps1`** | 改 bash 包装器找 `pwsh` | 引入运行时依赖,违背 ps1 头注释的哲学;用户得先 `apt install powershell`,门槛高 |
| **C. 平台变体目录(`show-in-marina-linux/`)** | 安装器按 `process.platform` 选源 | 要改安装器 + 打包 + 维护两份 `SKILL.md`,动件最多 |
| **D. 单目录 + 分发器 + `marina.sh`(推荐)** | 见上 | 安装器/打包零改动;Windows 行为 100% 不变;Linux 零额外运行时;唯一代价是 ps1/bash 两份客户端需随 HTTP 契约同步演进 |

选 D 的核心理由:**风险面最小**。AGENTS.md 第 7 章要求"已通过检查点的代码不许重构",
D 对 Windows 路径(`marina.ps1`/`marina.cmd`/Windows 上的 `marina`)零改动,只是**新增**
一个文件 + 给分发器加一个 else 分支。打包(`electron-builder.yml` 的 `extraResources:
src/skills → skills`)和安装器天然把整目录复制过去,无需感知平台。

### 1.3 文件改动清单

**新增**:
- `src/skills/show-in-marina/marina.sh` —— 原生 POSIX 客户端(`#!/usr/bin/env bash`,bash +
  curl,实现 ping/workspace/show/run/close/list/screenshot 全部子命令,退出码与 ps1 对齐)。

**改动**:
- `src/skills/show-in-marina/marina` —— 改成分发器:开头定位脚本目录;`command -v
  powershell.exe` 命中 → 现有 Windows 逻辑(powershell.exe -File marina.ps1);未命中 →
  `exec "${SCRIPT_DIR}/marina.sh" "$@"`。Windows 分支代码原样保留。
- `src/skills/show-in-marina/SKILL.md` —— 新增「Linux / macOS」调用段:直接 `./marina
  <cmd>`(分发器自动走 `marina.sh`)。把现有「PowerShell/cmd」「Bash/Git Bash on Windows」
  段落明确标注平台。补充 Linux 上若 `./marina` 无执行位用 `bash marina` 的兜底说明。
- `src/main/shipped-scripts-ascii.test.ts` —— 把 `marina.sh` 加入 `LOCALE_SENSITIVE_FILES`
  (保持 ASCII-only,与 `marina`/`marina.cmd`/`marina.ps1` 一致;ENC-1 规约延伸)。

**git 可执行位(必须处理,否则 Linux 上 `./marina` 直接 Permission denied)**:
- 现状:`git ls-files -s` 显示 `marina` 是 `100644`(**不可执行**),虽然当前 Windows 检出
  里文件系统显示 `-rwxr-xr-x`。git 按 per-file 存执行位,这个位没设。Linux 上 clone 后
  `./marina` 会失败。
- 动作:`git update-index --chmod=+x src/skills/show-in-marina/marina`、对新文件
  `marina.sh` 同样 `chmod +x` 后提交,确保源仓库里两者是 `100755`,打包进 AppImage/deb
  后安装到项目的副本才带执行位(`fs.cp` 在 Linux 上会复制源文件 mode)。

### 1.4 `marina.sh` 实现要点(开工时的内部约束,非决策点)

- **HTTP**:`curl -sS -m <timeout>`;`-H "Authorization: Bearer $MARINA_TOKEN"`;
  `-H 'Content-Type: application/json'`;body 用 `printf '%s' "$json"` 传 `--data`。
  base URL 取 `MARINA_SERVICE` 末尾去 `/`。
- **terminal 编码**:`curl --data-urlencode` 或用 sed 做百分号编码(terminal id 一般是
  hex/安全字符,编码负担小)。对齐 ps1 的 `[uri]::EscapeDataString`。
- **JSON 字段提取**(`workspace` 要从响应取 `path` 字段、非 json `list` 要格式化):
  优先 `jq`(Linux 普遍有);**`jq` 缺失时**回退到一个小型 awk/sed 提取器(只取单字段
  够用,不实现完整 JSON 解析)。详见决策点 4。
- **screenshot**:`curl -sS -o "$out" "$url"`,二进制直接落盘,打印路径。退出码对齐(连接
  失败→1,HTTP 非 2xx→3)。
- **退出码语义**:严格对齐 ps1 的 0/1/2/3,包括"无任何 HTTP 响应(连接拒绝/超时)→1"。
- **参数解析**:手写 `case` 分发子命令 + while 循环吃 flag(`--json`/`--quiet`/`--name`/
  `--new`/`--all`/`--stale`/`--glob`),与 ps1 行为逐一对齐。用法错误统一 `exit 2`。
- **ASCII-only + 无 BOM + LF 行尾**(ENC-1;且 shebang 行不能有怪字节)。
- **与 ps1 共享的契约**:HTTP 端点表、env 变量名、退出码。在 `marina.sh` 头注释里交叉
  引用 `marina.ps1`,标注"两者是同一 HTTP 契约的两个客户端实现,改端点必须同步改"。

### 1.5 测试

- `src/main/skill-installer.test.ts`(若已存在则扩展,否则新建):验证复制后目录里包含
  `marina.sh`,且 `marina`/`marina.sh` 在源目录有可执行位(断言 `fs.access` X_OK)。
- `src/main/shipped-scripts-ascii.test.ts`:加入 `marina.sh` 后应自动覆盖 ASCII 守护。
- 新增 `src/skills/show-in-marina/marina-sh.test.ts`(或并入 `marina-cli.test.ts`):
  起一个内存 mock HTTP 服务(file-panel-service 的契约),跑 `marina.sh ping/show/list/
  close/screenshot`,断言退出码与 stdout。**不依赖真实 Marina 进程**(符合 AGENTS.md
  9.3"测试不许跨进程影响"——用 mock server)。Windows 上 `marina-cli.test.ts` 继续
  跑 `marina.cmd`;新测试只跑 `marina.sh`,在所有平台都能跑(纯 bash+curl+mock)。
- **手动验证**(需要开发者参与,见决策点 3):在真实 Linux 上 `./marina ping` → `show`
  一个 md → `list` → `screenshot`,确认面板行为正常。

---

## 2. 决策点(需要开发者拍板)

> 以下是开工前需要你裁决的点。每条都给了我的推荐 + 理由。

### 决策点 1:CLI 实现路线——确认 Option D(native bash+curl)?

**上下文**:见上文 §1.2 的四方案对比。核心权衡是"单目录 + 分发器 + 新增 `marina.sh`"
(推荐 D)vs"要求 Linux 装 pwsh 复用 ps1"(B)vs"平台变体目录"(C)。

**我的推荐**:Option D。
**理由**:风险面最小(Windows 路径零改动、安装器/打包零改动),Linux 零额外运行时依赖,
与 ps1"不引入运行时依赖"的既有哲学一致。唯一长期成本是 ps1/bash 两份客户端需随 HTTP
契约同步演进——但两者都是瘦客户端,契约(file-panel-service.ts)是唯一真值,可接受。

**如果你更看重"单一实现源"**:选 B(要求 pwsh),但接受用户得 `apt install powershell`
的门槛,且 ps1 在 Linux pwsh 下的行为(尤其编码、`Invoke-WebRequest` 截图)需要额外验证。

### 决策点 2:本次范围——只修 Skill,还是顺带扫一遍其他 Linux 残缺?

**上下文**:你说"Linux 支持还有些残缺",skill 是其中具体一例。我排查中还发现几个独立的
Linux 短板(都已定位、彼此独立):

1. **zsh/fish 的 cwd 跟踪不工作**(`src/main/platform/linux.ts:58-67` 注释自承):OSC 1337
   hook 文件 `zsh.sh`/`fish.fish` 存在,但 `SessionManager` 没在临时目录铺设正确的 rcfile
   文件名(`.zshrc` / `fish/config.fish`)。**结果:Linux 上只有 bash 能正确跟踪当前目录**,
   zsh/fish 会话目录不更新(影响 path 归属、Git 面板 cwd 等连锁功能)。bash 是默认且已测,
   所以普通用户暂不受影响,但选了 zsh/fish 就破。
2. **代码块 `cmd` 语言在 Linux 上 ENOENT**(`src/main/code-block-runner.ts:buildSpawnArgs`):
   SKILL.md 的"可运行代码块"里 ```` ```cmd ```` 在 Linux 上会因找不到 `cmd.exe` 报
   `ShellMissing`。bash/sh/pwsh 块正常。属于"用户在 Linux 写 cmd 块"的边角,可接受但未文档化。
3. `session-manager.ts` 有一处 `process.platform === 'win32'` 分支(~2862 行)我还没细看,
   可能与 Linux 正确性相关——需要单独核一遍。

**我的推荐**:**本次只做 Skill(决策点 1 的 D)**,做成一个独立 feature branch +
独立检查点提交;上面 1/2/3 作为**后续独立 patch**分别处理(它们互不依赖,且 zsh/fish
hook 那条工作量不小,值得单独 grill 一轮)。
**理由**:Skill 是你点名的问题,独立、自洽、可单独验证;混进去做会让检查点变臃肿、
`git bisect` 变难(违反 AGENTS.md 6.1 commit 颗粒度)。但如果你希望"趁热把 Linux 一起
打磨干净",我可以把范围扩到含 #1(zsh/fish hook)。

**请你选**:① 只 Skill / ② Skill + zsh/fish hook / ③ Skill + 全部三项。

### 决策点 3:Linux 验证环境——怎么测?

**上下文**:你的开发机是 Windows(`D:\` 路径)。`npm test` 里的 mock-server 测试全平台
能跑,但"真实 Linux 上 skill 端到端可用"需要一台 Linux 环境。历史上 CP-1 自测报告也
注明"没有干净 Linux 虚拟机"。

**我的推荐**:
- 单测(契约级)我来写,全平台跑通,覆盖退出码/参数/HTTP 调用。
- 端到端手动验证:你用 **WSL2(Ubuntu)** 或一台 Linux VM 跑一份 Marina Linux 构 build
  (`npm run build` 的 linux target),`./marina ping && ./marina show x.md && ./marina
  screenshot`,确认面板收到。我给你写一份 `docs/checkpoints/` 下的验证清单。

**问题**:你有可用的 Linux/WSL 环境做这次手动验证吗?如果没有,我们能接受"仅单测 +
代码审查"先合,把端到端验证标成 known-issue 待社区/后续补吗?

### 决策点 4:`marina.sh` 的 JSON 字段提取——要不要硬依赖 `jq`?

**上下文**:`workspace` 子命令要从 HTTP 响应取 `path` 字段并打印;非 json `list` 要把
JSON 格式化成可读行。ps1 里靠 `Invoke-RestMethod` 自动反序列化。bash 没有。

**选项**:
- (a)**优先 jq,缺失时回退 awk 提取单字段**。jq 在主流发行版预装或易装;回退保证极简
  环境也能跑(只取单字段,不做完整 JSON 解析)。
- (b)**硬依赖 jq**,缺失就报清晰错误让用户装。实现最简单、最稳。
- (c)**纯 awk/sed,不依赖 jq**。零依赖但最脆(JSON 嵌套/转义一变就可能挂)。

**我的推荐**:(a)。兼顾健壮与零门槛。回退提取器只在 `workspace`(取 path)这类单字段
场景用;`list --json` 直接透传原始 JSON(与 ps1 一致),非 json `list` 用 awk 按行格式化。

---

## 3. 工作分解(裁决后执行)

假设决策点 1=D、2=①、3=用 WSL、4=a,大致顺序:

1. `chmod +x` 修正 `marina` 的 git 执行位;新建 `marina.sh` 骨架(shebang + 头注释 + 分发
   占位)。→ commit `fix(skills): add executable bit to marina wrapper`
2. 实现 `marina.sh` 全部子命令(ping → workspace 族 → show/run → close 族 → list →
   screenshot),逐个对齐 ps1 退出码。→ commit `feat(skills): add native POSIX client for show-in-marina`
3. 改 `marina` 为平台分发器(Windows 分支原样保留,加 Linux else)。→ commit
   `feat(skills): dispatch marina wrapper to native client on non-Windows`
4. 更新 `SKILL.md`(Linux 段 + 平台标注)。→ commit `docs(skills): document Linux invocation`
5. 改 `marina` ASCII 测试 + 新增 `marina.sh` 契约测试(mock server)。→ commit
   `test(skills): cover native POSIX client and ASCII guard`
6. 写自测报告 + 用户验证指南(WSL 步骤),标记检查点等开发者测。

全程在 feature branch `fix/skill-linux`(或按当前检查点分支命名约定),不碰 main。
每个 commit 前跑 `npm run lint && npm test && npm run typecheck`。

---

## 4. 风险与回避

- **ps1 / bash 双实现漂移**:HTTP 契约(file-panel-service.ts 端点表)演进时两份客户端
  必须同步。**回避**:在 `marina.sh` 和 `marina.ps1` 头注释互引 + 共享端点表注释;新增
  契约测试同时覆盖两份客户端(同一 mock server)。
- **`jq` 不可用**:决策点 4 的回退提取器兜底;并在 `ping` 之外的命令启动时静默探测 jq,
  缺失且走到需要解析的命令时给一行 stderr 提示(不阻断,因为回退能跑)。
- **执行位丢失**:除了源仓库 `chmod +x`,还要确认 `fs.cp`(安装器)在 Linux 上保留
  mode——Node `fs.cp` 默认 `preserveMode: true`,但打包经 electron-builder 复制 + asar
  外 `extraResources` 拷贝,需在 Linux 构建产物里实际 `ls -l` 确认一次。
- **Linux 上 bash 版本**(macOS 自带的是 3.2,但 Marina V1 不测 macOS;Linux 发行版 bash
  ≥ 4):`marina.sh` 只用 POSIX + bash 4 常见特性(`${var,,}`、`[[ ]]`、数组),避开 bash
  4 独有的关联数组(用 case 替代),保证可移植。

---

## 5. 不做的事(边界)

- **不**改 Windows 路径的任何行为(`marina.ps1`/`marina.cmd`/Windows 上 `marina` 的逻辑
  原样保留——AGENTS.md 第 7 章"已通过检查点的代码不许重构")。
- **不**给 macOS 做实现(`macos.ts` 仍 throw `Not implemented`;`marina.sh` 在 macOS 上
  技术上能跑但不官方支持、不测试——AGENTS.md 第 8 章)。
- **不**引入新 npm 依赖(纯 bash + curl + 系统工具;AGENTS.md 边界 2)。
- **不**改安装器 / 打包配置(Option D 的核心就是不动它们)。
