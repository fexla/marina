这确认了顺序：
- L113-117: `app.setName(...)` — 包括 `parseInstanceName` 分支。
- L147: `app.requestSingleInstanceLock()` — 在 setName **之后**。
- L165: `app.getPath('userData')` — 在 lock **之后**，因此它解析为正确的 name-derived 目录。

顺序正确。在 `setName` 之前没有过时的 `getPath('userData')` 或 `setPath`。

让我再检查一下 `setAppUserModelID` 是否被显式调用过（它会影响任务栏分组，但不会影响锁）。上面的 grep 没有找到任何对 `setAppUserModelId` 的显式调用，所以它默认使用 name——这对任务栏分组来说是没问题的（每个实例会有自己的任务栏图标，这对调试来说是理想的结果）。

我已经掌握了所需的全部证据。让我来整理最终的审查报告。

## 审查

### 正确：功能上表现良好（有证据）

1. **`parseInstanceName` 解析和过滤是正确的** (`src/main/argv-utils.ts:82-93`)。正则表达式 `/[^A-Za-z0-9_-]/g` 是一个严格的允许列表（allowlist）：它剥离了路径分隔符（`/` `\`）、点（`.`）、冒号、空格以及所有非 ASCII 字符。结果为空 → 返回 null → 回退到默认命名。没有绕过的方法。

2. **调用顺序正确** (`src/main/index.ts:112-147`)。`app.setName('Marina (<name>)')` 在 L113 被调用，位于 L147 的 `app.requestSingleInstanceLock()` 之前，且在 L165 的第一次 `getPath('userData')` 之前。代码注释（L103, L110）正确地说明了 Electron 在第一次解析后会缓存 `userData` 路径。锁键基于 `userData` 路径 → 基于名称 → 因此不同的名称会生成不同的锁文件和不同的 `userData` 目录。✓

3. **多实例共存确实可以工作。** 名称是唯一的派生键：`Marina (dev)` / `Marina (portable)` / `Marina` / `Marina (daemon)` / `Marina (client)`。每个都生成 `%APPDATA%\Marina (<name>)\`，并拥有自己的锁文件、`settings.json`、`templates.json`、`marina-daemon-credentials.json` 和 `logs/main.log`。`npm run dev` (→ `Marina (dev)`) 无法与 `--instance=daemon` (→ `Marina (daemon)`) 发生冲突，因为名称不同 → 锁文件不同。✓

4. **安全过滤是充分的。** `--instance=..\evil` → `raw='..\evil'` → 过滤后 → `'evil'`。`--instance=...` → `''` → null。路径注入（遍历到父目录、盘符 `C:`、UNC `\\server`）是不可能的：点、斜杠、反斜杠、冒号都会被剥离。✓

5. **数据/日志隔离是完整的。** `daemon-credentials.ts` 通过 `path.join(userDataDir, FILENAME)` 进行键控 (L64-66)。`logger` 走 `join(dataDir, 'logs')` 路径 (index.ts L168)。所有管理器存储都在 `dataDir` 下。因此，`daemon` 实例和 `client` 实例在测试期间不会互相干扰凭据/设置/日志。✓

6. **测试足够且通过。** 在 `argv-utils.test.ts:128-146` 中添加了 4 个新测试，涵盖了：no-flag→null、valid name、illegal-char filtering、empty-after-filter→null。全部 20 个测试通过（`npx vitest run src/main/argv-utils.test.ts` → 20 passed）。类型检查干净 (`tsc --noEmit` → 无错误)。

### 阻塞问题：无

### 注意（次要观察，非阻塞问题）

1. **空 `--instance=` 边界情况可以通过逻辑处理，但未进行明确测试。** `--instance=`（等号后无值）→ `raw=''` → `cleaned=''` → `return '' || null` → null。逻辑是正确的，但该分支没有明确的测试。建议（可选）：添加 `expect(parseInstanceName(['exe','--instance='])).toBeNull()` 以明确意图。

2. **仅支持 `--instance=<name>` 形式，不支持 `--instance <name>`（空格分隔）。** 这与现有的 `--working-directory=`、`--port=` 和 `--mode=` 约定一致，因此对于代码库来说是一致且正确的选择。仅作为潜在的用户困惑点提出 —— 如果用户输入 `--instance daemon`（空格），它将被静默忽略并回退到默认命名。在此处并不是 bug（已记录的行为），但如果错误形式是静默的，建议在面向用户的文档或 `--help` 中注明该要求。

3. **远程连接可行性（第 5 点）：** `Marina.exe --instance=daemon --headless --daemon`（`daemon` 实例，自己的 `userData`，自己的凭据）和 `Marina.exe --instance=client`（`client` 实例）的 localhost 测试是可行的。`daemon` 会记录其配对 token (`index.ts:423`)，用户在 `client` 的配对 UI 中输入该 token。端口默认为 32780；如果发生冲突，客户端必须指向 `daemon` 的实际端口。该任务提到了 32780-32789 范围的“扫描”——我没有在代码中找到客户端端口*扫描/发现*循环；`client` 通过配置的 profile URL (`remote-daemon-profiles.json`) 进行连接。所以在 localhost 上：这可行，**前提是** (a) 用户读取 `daemon` 的 token 并进行配对，以及 (b) `client` 的远程 profile 指向正确的 `127.0.0.1:<port>`。与本次更改无关 —— 这属于既有的远程功能。

4. **任务栏分组副作用（预期内且是理想的）：** 因为 `app.name` 不同，且没有任何地方调用 `setAppUserModelId`，所以每个实例在 Windows 任务栏上显示为单独的图标。对于多实例调试，这是理想的结果（你可以一眼区分 `daemon` 和 `client`）。这不是 bug。