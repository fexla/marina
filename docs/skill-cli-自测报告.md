# show-in-marina skill CLI 自测报告

**功能**: 给 AI agent 提供 Marina 文件面板 CLI。CLI 读取 Marina 注入的环境变量，
处理 Bearer 鉴权和 UTF-8 JSON，并用路径打开、关闭或列出文件。

**分支**: `fork-main`
**日期**: 2026-07-13

## 一、最终设计

### 调用位置

`marina.cmd` 与 `SKILL.md` 位于同一 skill 目录。AI 必须解析本 SKILL.md 旁边的
`marina.cmd`，并通过该显式路径调用；不假设命令在 PATH，不修改 PATH，也不在
项目根目录创建 shim。

从 skill 目录调用的 PowerShell 示例：

```powershell
.\marina.cmd ping
.\marina.cmd show .\docs\report.md
.\marina.cmd list --json
.\marina.cmd close .\docs\report.md
```

在其他工作目录时，使用已解析的 skill 目录：

```powershell
& "<path-to-skill-directory>\marina.cmd" show .\docs\report.md
```

### 生成内容工作流

公开工作流只有路径模式：

1. AI 用正常文件写入工具创建 UTF-8、无 BOM 文件。
2. AI 调用 skill 目录中的 `marina.cmd show <PATH>`。
3. Marina 主进程按文件路径读取并在侧面板展示。

stdin、`--as`、workspace staging 已全部移除。原因是 Windows PowerShell 5.1
父管道会在子脚本读取前按控制台代码页重编码数据，非 ASCII 内容可能损坏；旧模式
还引入了 staging 路径和写文件副作用。路径模式不经过 PowerShell 内容管道。

### 运行时与环境

- 生产 skill 只有 `marina.cmd` + `marina.ps1`，依赖 Windows 自带
  `powershell.exe`，没有 Python 依赖。
- Python 只用于 Vitest 的本地 HTTP mock server。初版 `marina.py` 设计已移除，
  不随生产 skill 分发。
- `MARINA_SERVICE` 严格必需；不扫描端口、不尝试备用地址。
- `MARINA_TOKEN`、`TERMINAL_ID` 在对应命令需要时严格校验。

### ping 语义

`ping` 只在 `GET /health` 返回 **HTTP 200** 且 JSON 标记严格为
`{"ok":true,"marina":true}`（两个字段均为布尔值）时返回 0。以下情况都返回
离线/exit 1：

- 连接拒绝、超时或 DNS 错误；
- HTTP 404/500；
- 无关 JSON；
- 缺少 `marina` 字段；
- `"true"` 字符串冒充布尔值。

没有任意 HTTP 状态即在线的遗留回退。

## 二、改动文件

| 文件 | 说明 |
|------|------|
| `src/main/file-panel-service.ts` | 新增免鉴权 `GET /health`，返回 Marina 专属标记。 |
| `src/main/file-panel-service.test.ts` | 覆盖 `/health` 无 token 与带 token。 |
| `src/skills/show-in-marina/SKILL.md` | 文档改为 PowerShell、相对 skill 路径及 `show <PATH>` 工作流。 |
| `src/skills/show-in-marina/marina.cmd` | 真实 Windows 启动器；通过 `%~dp0` 找同目录 ps1，并穿透退出码。 |
| `src/skills/show-in-marina/marina.ps1` | 路径模式 CLI；严格健康标记、严格 env、无 staging。 |
| `src/main/marina-cli.test.ts` | 通过真实 `marina.cmd` 做 22 个端到端测试。 |
| `src/main/marina-cli-mock-server.py` | 仅测试使用的 HTTP mock，可返回错误健康标记。 |
| `src/main/shipped-scripts-ascii.test.ts` | 将 cmd/ps1 加入 ASCII/no-BOM 守护。 |
| `.gitignore` | 忽略测试 mock server 的 Python bytecode cache。 |

## 三、自动化验证

### 聚焦 CLI 与编码测试

```text
npx vitest run src/main/marina-cli.test.ts src/main/shipped-scripts-ascii.test.ts
Test Files  2 passed (2)
Tests       34 passed (34)
```

其中 `marina-cli.test.ts` 的 22 个测试覆盖：

- 真实 `marina.cmd` 启动器，不直接调用 ps1；
- 启动器 exit 0/1/2/3 穿透；
- 从 skill 目录以 `.\marina.cmd` 相对路径调用；
- 精确健康标记接受，以及字符串标记、无关 JSON、HTTP 500、死端口拒绝；
- 打开既有文件及中文目录/中文文件名的 UTF-8 路径；
- stdin 不作为内容、无 `--as` 模式；
- 未知选项 usage error；
- 严格 `MARINA_SERVICE` / `MARINA_TOKEN` / `TERMINAL_ID`；
- `list`、`list --json`、`close`、`--quiet`。

### 全量检查

```text
npm run typecheck  -> passed (三套 tsc)
npm run lint       -> passed (0 errors)
npm test           -> 48 files passed, 738 tests passed
git diff --check   -> passed
```

独立字节检查与 Vitest 守护均确认：

```text
src/skills/show-in-marina/marina.cmd: ASCII, no BOM
src/skills/show-in-marina/marina.ps1: ASCII, no BOM
```

测试输出仅包含 npm mirror 配置弃用提醒、Node `shell:true` 的 DEP0190 提醒，及
仓库已有测试刻意产生的 warning 日志；没有测试失败。

## 四、剩余人工验证

- 安装包内应包含 `resources/skills/show-in-marina/SKILL.md`、`marina.cmd`、
  `marina.ps1`，不应包含生产 Python 客户端。
- skill 安装到项目后，应在 `.pi/.claude/.agents` 对应 skill 目录内保留三个文件
  的相邻关系，使 `marina.cmd` 的 `%~dp0` 解析生效。
- 本轮未运行安装包构建或真实 GUI 面板人工测试；自动化使用真实 cmd/ps1 和本地
  mock HTTP 服务覆盖 CLI 协议。
