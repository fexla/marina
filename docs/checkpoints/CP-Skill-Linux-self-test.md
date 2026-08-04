# Skill Linux 支持 —— 自测报告

**变更**:`show-in-marina` skill 新增 Linux/macOS 原生客户端,修复「安装 skill 在 Linux 上装出 Windows 版」的缺陷。
**方案**:`docs/方案-skill-Linux支持-20260805.md`(Option D:单目录 + 平台分支调度器 + 新增 `marina.sh`)。
**分支**:`feat/v0.3.3`,两个 commit:
1. `feat(skills): add native POSIX client for show-in-marina (Linux/macOS)` —— `marina.sh` + `marina` 调度器改造 + 可执行位修复
2. `test(skills): cover native POSIX client + document Linux invocation` —— 契约测试 + mock `/run` + ASCII 守护 + 独立验证脚本 + SKILL.md + 方案文档

## 改了什么(文件清单)

| 文件 | 变更 |
|---|---|
| `src/skills/show-in-marina/marina.sh` | **新增**。原生 POSIX 客户端(bash+curl,842 行)。实现 ping/workspace/show/run/close/list/screenshot 全部子命令,退出码与 `marina.ps1` 严格对齐(0/1/2/3)。纯 POSIX(awk/sed/grep)做 JSON 解析,**零额外运行时**(无 jq/python/node)。git 模式 `100755`。 |
| `src/skills/show-in-marina/marina` | 改造为**平台调度器**。检测到 `powershell.exe` → exec `marina.ps1`(Windows 行为 100% 不变);否则 → exec `marina.sh`(Linux/macOS)。含执行位兜底:无 +x 时 `exec bash marina.sh`。git 模式从 `100644` 修为 `100755`。 |
| `src/skills/show-in-marina/SKILL.md` | 新增「Linux / macOS」调用段,现有 Windows 段加平台标注。 |
| `src/main/shipped-scripts-ascii.test.ts` | `LOCALE_SENSITIVE_FILES` 加入 `marina.sh`(ENC-1 ASCII 守护延伸到 POSIX 客户端)。 |
| `src/main/marina-sh.test.ts` | **新增**。契约测试,复用 `marina-cli-mock-server.py`,43 例(1 例 posix-only skip)。 |
| `src/main/marina-cli-mock-server.py` | 加 `/run` 路由(ADR-027 命令可测)。 |
| `scripts/verify-marina-sh-linux.sh` | **新增**。独立端到端验证脚本(只需 bash+curl+python3,不需要 node/npm)。 |
| `docs/方案-skill-Linux支持-20260805.md` | 方案 + 决策记录。 |

## 关键设计决策(与原方案的偏差)

1. **纯 POSIX 解析,不引入 jq**(方案原写「jq 优先 + awk 回退」)。理由:延续 `marina.ps1` 头注释「不引入额外运行时依赖」的同款哲学——Linux 上 bash+curl+coreutils 普遍存在,jq 不在「每台 Linux 自带」之列。改为纯 awk/sed/grep,单一代码路径、零依赖。**比方案承诺的依赖更少**,严格更优。已在 `marina.sh` 头注释与 `marina-sh.test.ts` 头注释说明。

2. **JSON 解析兼容「带空格」与「紧凑」两种序列化**。实现中发现:真实 Node 服务输出紧凑 JSON(`"key":true`),而 Python mock 输出带空格(`"key": true`)。`array_objects`/`str_array` 最初只认紧凑,导致对 mock 解析失败。已修复为空白容忍,两种都吃。ping 的健康标记匹配也改为容忍空格的正则。

3. **HTTP 响应捕获放弃临时文件,改用 stdout 分隔符**。原因:Windows Git Bash 上,bash 与原生 curl 对 `/tmp` 的解析不一致(bash→AppData,curl→`C:\tmp`),用 `-o 临时文件` 会出现「curl 写了、bash 读不到」的静默错配。改为 curl `-w` 追加唯一分隔符到 stdout,body+code 一次捕获。这在 Windows Git Bash 上也正确(且真实 Linux 上更简单)。

## 跑过的测试

- [x] **全量 `npx vitest run`**:74 文件 **1277 passed / 1 skipped / 0 failed**。
  - `marina-sh.test.ts`:**42 passed / 1 skipped**(skip 的是「调度器路由到 marina.sh」,posix-only,Windows 上 powershell.exe 总在故跳过;**Linux 上会跑**)。
  - `marina-cli.test.ts`(PowerShell 客户端,回归守护):**51 passed**——证明 Windows 路径零回归。
  - `shipped-scripts-ascii.test.ts`:**16 passed**(含新增的 `marina.sh`)。
  - `skill-installer.test.ts`:**3 passed**——安装器平台无关,整目录复制仍正确。
- [x] **`scripts/verify-marina-sh-linux.sh`**(本地 Git Bash 跑):**24/25 passed**。唯一失败是 `missing TOKEN exit 1` 用了 `/etc/hostname`——该路径在 Windows 不存在,故 `show` 先于 token 检查报「not a file」(exit 3)。**真 Linux 上 `/etc/hostname` 存在,此用例通过**。
- [x] **`marina.sh` JSON 辅助函数单元测试**:`jget` / `array_objects` / `str_array` / `json_escape` / `urlencode` / `format_epoch_ms`,在「带空格 JSON」「紧凑 JSON」「空数组」「Windows 反斜杠路径」「UTF-8 路径」(经 python `json.loads` 往返验证)各情形下均正确。
- [x] **调度器路由验证**:剥离 PATH 模拟无 powershell.exe,`marina ping` 正确 exec 到 `marina.sh` 并对 mock 返回 online(Windows 上 `PATH=/usr/bin:/bin` 实测通过)。
- [x] **lint**(`eslint --ext .ts`):新增/改动文件无 error(1 处 `no-useless-escape` 已修)。
- [x] **typecheck**:我的文件(`marina-sh.test.ts` / `shipped-scripts-ascii.test.ts` / `marina-cli-mock-server.py`)**零 error**。仓库里其他 26 个 typecheck error 是**预先存在**的(`code-block-runner`/`path-manager`/`command-panel-service`/`ipc`/`markdown-command`),与本次改动无关,未触碰。

## 已知不工作/需开发者关注

1. **真实 Linux 端到端(10.9.0.1)未完成**——SSH 阻塞。详见下方「用户测试指南」的阻塞说明。**单测 + 契约测试已全绿**,缺的是「真实 Linux 机器跑一遍」的人工确认。
2. **`docs/方案-skill-Linux支持-20260805.md` 决策点 2(范围)= 只做 Skill**。zsh/fish 的 OSC 1337 cwd hook 缺失(`platform/linux.ts:58-67` 自承)、`cmd` 代码块在 Linux ENOENT(`code-block-runner.ts`)等**其他 Linux 残缺**未在本轮处理——它们是独立 patch,见方案文档第 2 节。

## 我没测的东西(需开发者帮忙)

- **真实 Linux 机器**上 `./marina ping && ./marina show x.md && ./marina screenshot`(端到端,连真实 Marina Linux 构建)。我没有可用的 Linux 桌面环境。
- 干净 Linux 上 `deb`/`rpm`/`AppImage` 安装包内 `marina`/`marina.sh` 的执行位是否保留(electron-builder `extraResources` 复制 + `fs.cp` 安装器复制两道关)。
