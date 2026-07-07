# Task for reviewer

审查 Marina 远程连接错误处理的最新修复(commit 409e619 + 当前未提交改动),重点验证三个用户报告的问题是否真的修复了。用户反馈前两次修复完全无效(header 依旧没有、错误无法复制、start 状态不更新),所以这次必须确认修复会真正生效。

## 三个要验证的问题

**问题 1(最重要):远程窗口连接失败时,错误页没有窗口标题栏(header,含最小化/最大化/关闭按钮),错误信息无法复制。**

已知根因(我刚发现,需要你验证):`getProtocolVersion` 内部调 `invoke()`,而 `invoke` 会 `await ensureTransport()`。远程窗口连不上 daemon 时,ensureTransport 在 **handshake 阶段**就 throw → handshake `.catch` → 走 `App.tsx` 的 handshake error 分支(`FullPagePlaceholder`,没 header)→ **永远到不了** `ConnectedShell` 里的 `RemoteConnectionErrorScreen`(那个才有 header 和复制按钮)。

我刚做的修复:`App.tsx` handshake error 分支也判断 backendId(远程窗口),显示 `RemoteConnectionErrorScreen`。

请验证:
1. 这个根因分析对不对?handshake 是不是真的会因为 ensureTransport throw 而失败?(看 `src/preload/index.ts` 的 `getProtocolVersion` + `invoke` + `ensureTransport`)
2. 修复(handshake error 分支走 RemoteConnectionErrorScreen)是否能让错误页显示 header + 复制?追踪完整渲染路径。
3. `RemoteConnectionErrorScreen` 本身能否正常渲染 WindowChrome?它现在包了 LanguageProvider + data-theme,但它在 handshake error 时被渲染,此时**还没有 AppStateProvider**(handshake error 在 App 组件,AppStateProvider 在 handshake OK 之后才挂)。而 RemoteConnectionErrorScreen 调用了 `useAppState()`。这是个问题吗?会不会崩溃?(关键:检查 RemoteConnectionErrorScreen 在没有 AppStateProvider 时 useAppState() 会怎样)

**问题 2:start 服务端后 UI 显示"未启动",但再点报"已在运行"。**

根因:`index.ts` 用 `controller.onStatusChange =` 赋值覆盖了 `ipc.ts` 设的 broadcast 回调。修复:controller 加 `addStatusListener`(多监听器),index 改用它。

请验证:`src/main/remote-daemon-controller.ts` 的 addStatusListener + emitStatus 逻辑,以及 `src/main/index.ts` 改用 addStatusListener 后,onStatusChange(broadcast)不再被覆盖,start 后 status 能推到 UI。

**问题 3:AUTH_TIMEOUT 诊断。** 我加了 daemon auth 日志 + probe 超时 1500→3000。这个次要,简单确认日志加对位置即可。

## 关键文件
- src/renderer/App.tsx(handshake error 分支、RemoteConnectionErrorScreen、ConnectedShell sync.error 分支)
- src/preload/index.ts(getProtocolVersion、invoke、ensureTransport)
- src/main/remote-daemon-controller.ts(addStatusListener、emitStatus)
- src/main/index.ts(addStatusListener 调用)
- src/renderer/store.tsx(useIpcSync、useAppState)

## 输出要求
对每个问题给出:① 根因分析是否正确 ② 修复是否真的生效(追踪渲染/执行路径)③ 还有什么遗漏会导致修复无效。特别关注问题 1 的 useAppState 在无 AppStateProvider 时是否会崩溃 —— 如果会,这是必须修的 BLOCKER。要严苛,用户已经因为前两次无效修复很不满了。

## Acceptance Contract
Acceptance level: checked
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope

Required evidence: changed-files, tests-added, commands-run, residual-risks, no-staged-files

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```