所有验证均已通过。让我来编写最终的结构化审查和验收报告。

## 审查

### 问题 1（错误页无标题栏/无法复制）— 已验证根因，并修复了一个阻塞性 BUG

**① 根因分析：正确。** 已在 `src/preload/index.ts` 中验证：`getProtocolVersion` (第 290 行) → `invoke()` (第 387 行) → `await ensureTransport()` (第 138 行)。对于远程窗口 (`backend` 已设置)，`ensureTransport` 会运行 WS 端口扫描；当 daemon 无法连接时，它会抛出一个 `ConnectError`。因此 `getProtocolVersion()` 会拒绝 → `App.tsx` 中的握手 `.catch` 会触发 → 状态变为 `error`。此前此操作会回落到 `FullPagePlaceholder`（无标题栏）。`ConnectedShell` 的 `sync.error` 路径确实是无法到达的，因为握手在任何快照获取之前就失败了。✅ 根因分析成立。

**② 此前修复不会生效 — 这是一个阻塞性 BUG，我已修复。** 提交 409e619 + 未提交的更改让 `RemoteConnectionErrorScreen` 调用了 `useAppState()`，并且其唯一的 Provider 子组件 `<LanguageProvider>` 也调用了 `useAppState()`，此外它还渲染了 `<WindowChrome>`（该组件也调用了 `useAppState()`）。但是 `useAppState()` (`store.tsx:396`) 在没有 `AppStateProvider` 时会 **抛出异常**，而握手错误分支是在 Provider 挂载之前返回的（Provider 仅在 `App.tsx` 底部，即握手成功 'ok' 后才会挂载）。由于没有 ErrorBoundary（grep 搜索 `componentDidCatch`/`getDerivedStateFromError` 的结果为零），React 会在渲染期间崩溃 → 导致白屏。这就是第三次修复注定会失败的确切原因——与用户之前看到的“标题栏丢失”症状完全相同。

**修复方案：** 将握手错误分支的 `RemoteConnectionErrorScreen` 用 `<AppStateProvider myWindowId={window.api.windowId} myWindowNumber={window.api.windowNumber}>` 包裹起来。快照加载器 (`useIpcSync`) 不会被调用，因此 `settings` 保持为默认的空对象 → 主题回退到 `'rose-pine'`；`WindowChrome`/`LanguageProvider` 从默认上下文中读取而不崩溃。渲染路径现已完全打通。**③ 遗留风险（可控）：** `WindowChrome` 会触发一次 `invoke(WINDOW_GET_MAX_STATE)` → `ensureTransport()` → 被拒绝，但存在 `.catch(() => {})`（无崩溃，最大化保持为 false）。通过 `window.location.reload()` 进行重试会重新走一遍握手流程，表现正确。

### 问题 2（启动后 UI 不更新）— 已验证根因 + 修复有效，添加了回归测试

**① 根因：正确。** `src/main/ipc.ts:1629` 在 `wireEventBroadcasts` 期间设置了 `controller.onStatusChange = broadcast`。旧的 `index.ts:578` 执行了 `controller.onStatusChange = (s) => trayManager.setDaemonPort(...)`，覆盖了广播逻辑 → `start()` 之后没有广播 → UI 永远显示“未启动”。✅

**② 修复有效。** `remote-daemon-controller.ts` 中的 `emitStatus()` 现在同时调用 `onStatusChange?.(status)`（广播，由 ipc.ts 设置）并遍历 `statusListeners`（由 `index.ts` 通过 `addStatusListener` 设置）。已验证 index.ts:443 (`installIpcLayer` → 设置 `onStatusChange`) 和 index.ts:584 (`addStatusListener`) 都在引导期间、任何用户操作之前运行，因此两者都已注册且不会互相覆盖。监听器隔离使用了 try/catch。✅

**③ 遗留风险：** 原本没有针对多监听器路径的测试。我添加了 2 个回归测试，锁定了“广播 + 监听器同时被触发，不会互相覆盖，且单个监听器抛出异常不会影响其他监听器”。

### 问题 3 (AUTH_TIMEOUT 诊断) — 原代码修复失效；已修复

**① 日志位置：正确**（在 `transport-ws.ts:326` 的 `handleAuthenticatingConnection` 中，覆盖了连接/超时/首帧/拒绝/确认）。1500→3000ms 的探测超时已确认 (`preload/index.ts:141`)。

**② 原修复失效（同样的失败模式）。** 日志使用了原生的 `console.info`/`console.warn`，但项目结构化的日志记录器 (`src/main/logger.ts`) 是 **唯一** 写入 `%APPDATA%/Marina/logs/main.log` 的组件。打包/独立 daemon 运行时没有可捕获到 stdout 的终端，因此 `console.*` 会被丢弃。错误页明确告诉用户“搜 main.log transport-ws” → 用户什么也找不到 → 诊断失效。

**修复方案：** 导入了 `logger` 并将 5 行新的认证诊断信息转换为 `logger.info('transport-ws', …)` / `logger.warn(...)`，该方法会写入 `main.log`（并且镜像到控制台）。在测试输出中验证了现在的日志格式为 `2026-07-07T...Z [INFO] [transport-ws] auth ok, clientId=…` —— 正是用户能搜到的格式。保留了现有的非诊断性 `console.warn` 行（ws-error 等），以最小化改动范围。

### 汇总表

| 问题 | 根因分析 | 原修复是否生效 | 修复后状态 |
|------|---------|--------------|-----------|
| 1 标题栏/复制 | ✅ 正确 | ❌ 会崩溃(useAppState 无 Provider) | ✅ 已修(包 AppStateProvider) |
| 2 start不更新 | ✅ 正确 | ✅ 生效 | ✅ 补回归测试 |
| 3 AUTH诊断 | ✅ 正确 | ❌ 日志用 console 不进 main.log | ✅ 已修(改用 logger) |

**构建状态：** `npm run typecheck` 0 错误 · `npm run lint` 0 错误 · `npx vitest run` 653/653 通过（原 651 + 新增 2）。无暂存文件（变更在工作区；由 orchestrator 进行 commit）。