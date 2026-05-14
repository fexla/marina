# TIT-1 · OSC 标题 shell 启动垃圾覆盖 displayName

**状态**:workaround 已 ship(beta.2),根因待续查
**优先级**:P1(影响 daily driver 第一印象,已用启发式过滤兜底)
**首次报告**:2026-05-14,用户在 beta.1 安装后实测
**对应 commit**:`7264004 fix(session): TIT-1 过滤 shell 启动期的"裸路径"OSC 标题`

---

## 现象

新建 Shell 模板的 session 后,tab / sidebar 的 displayName 显示成 shell 自己的 exe 路径或 Git Bash 的默认 PS1 前缀,不是预期的 `"PowerShell"` / `"Bash"` / `"cmd"`:

```
C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe
MINGW64:/c/Users/HP/Desktop/work/SimHDL
C:\Windows\System32\cmd.exe
```

用户在两台机器上观察到(开发机 + HP 用户机),Claude Code / Codex 等带 `template.command` 的模板**不受影响**(他们启动后会发自己的 OSC 0 覆盖回友好名)。

## 当前 workaround(beta.2 已 ship)

`src/main/session-manager.ts looksLikeShellStartupGarbage(title)` — 在 `handleOscTitle` 接收端按内容过滤:整段是 Windows / UNC / Unix 裸路径,或 Git Bash `MINGW(32|64|ARM)?:` / `MSYS\d?:` 前缀,或裸 `*.exe` 文件名 → 拒绝,不更新 displayName。

合法 CLI 工具(vim / claude / make ...)的 verb-leading 标题不受过滤影响。测试覆盖 36 个 case(`describe('looksLikeShellStartupGarbage')` + 4 个 FakePty 集成),原 `'✻ Claude · ~/p (working…)'` 正向回归测试仍过。

## 已查清的部分

- **触发机制**:Windows ConPTY 把 `powershell.exe` / `cmd.exe` / `pwsh.exe` 启动时的 Win32 `SetConsoleTitle(<exe 路径>)` 自动翻译成 OSC 0 序列;Git Bash 默认 `PS1` 每次 prompt 主动发 `\e]0;MINGW64:<cwd>\a`。这些都被 `handleOscTitle` 当合法标题接受。
- **接收端实现**:`handleOscTitle` 和 `parseTitleOscPayload` 的字节实现自 `f96ae51 (2026-05-13 09:03, "feat(session): OSC 0/1/2 标题事件 ...")` 引入以来逐字未变,中间所有摸过 session-manager / osc1337-parser 的 commit 都过了一遍(`51ab975 → 8fad8fc → a9ebfa3 → bb88760 → 97befa4 → 5242d80`),accept 路径稳定。
- **shell 启动参数**:`buildShellLaunchParams` 在 `src/main/platform/windows.ts` 自 alpha.0 起未改动。
- **alpha.3 vs beta.1**:alpha.3 不含 OSC 0/1/2 标题路径(`handleOscTitle` 函数不存在),所以那个版本绝不可能出此现象;beta.1 是首个用户拿到的、含此路径的 build。

## 未解释的部分(关键)

**用户报告:在更早的某段时间内,即使是 Shell 模板的 session,displayName 也是友好名 `"PowerShell"` / `"Bash"`,没有暴露过裸路径。**

按上述代码考古,从 `f96ae51` 起任何 dev 模式启 Shell 模板的 session 都应当立刻露馅,但用户的实测体感不支持这个推论。我曾提出"测试场景偏差"假说(开发期默认走 Claude Code 模板,被 Claude 自己的 OSC 0 即时覆盖,所以裸路径肉眼看不见)— 用户明确拒绝,因为他们记得当时也测过 Shell 模板。

这道缺口意味着 **当前的 TIT-1 是 workaround,不是真正的根治**。某处一定有过一道我没找到的过滤 / 时序屏障,后来失效了。下一轮排查应当从这些方向入手:

### 还没排查的方向

1. **xterm.js / node-pty 版本与配置**:
   - `package-lock.json` 在哪几次 `npm install` 后整段重写过?
   - `xterm.options` 里和标题相关的字段(`windowOptions`、`bracketedPasteMode` 等)有没有变?
   - node-pty 的 ConPTY 接通方式有没有变?(`useConpty` 切换、`useConptyDll` 等)
2. **electron-builder 打包前后差异**:dev 模式跑 node-pty 与打包后跑 node-pty 在 ConPTY 调用上是否有差异(我们 dev 测得稳定 = 打包后才出问题,这点暗示打包路径上有变量)。
3. **shell 探测顺序变化**:pwsh 7 vs powershell 5.1 启动期 SetConsoleTitle 行为是否不同?如果开发机以前默认走 pwsh 7、现在切到 powershell 5.1,可以解释一部分体感差异(但仍不能解释"以前 cmd / Git Bash 也好")。
4. **PER-2 IPC chunk 聚合 (`14c2c62 2026-05-14 00:46`)**:把 PTY chunk 8ms 聚合后 emit 给 renderer。聚合可能改变了 chunk 边界,**但 OSC 解析在 main 端 emit 之前就完成了**,理论上不影响标题事件触发。再核一次是否真的无关。
5. **scrollback 截断 (`52c5e02 2026-05-14 00:51` OSC-2)**:截 scrollback 尾部对 OSC 解析 stash 有无影响?
6. **OSC 解析 stash 边界 (`51ab975 → 8fad8fc`)**:OSC-3/4 那一来回过程中,有没有一段窗口期 stash 行为差异导致首屏 OSC 被吞掉?那段窗口期没有 build 出货,但 dev 模式自测过,如果当时 dev 也测过 Shell 模板且没问题,可能正是 stash 行为差异掩盖了 bug。
7. **`pickDisplayName` 历史**:`f96ae51` 之前 `pickDisplayName` 函数是否就存在、是否就是当前形式?如果之前 displayName 计算方式不同(比如和 OSC 完全解耦),也能解释体感。
8. **renderer / store 侧某个隐式 guard**:虽然 grep 找不到对 displayName 的条件应用,但可能有间接路径(比如某个 reducer 在某些条件下不更新 sidebar)。

## Reproduction

1. 全新机器(尤其没装 PowerShell 7 的中文 Windows)安装 Marina beta.1
2. 加路径
3. 创建 session,模板选 **Shell**(默认,`command: ''`)
4. 观察 sidebar / tab 的 displayName

预期(beta.2+):`"PowerShell"` / `"Bash"` / `"cmd"`
beta.1 实际:见上述"现象"

## 防御性改进

- **smoke 断言扩展**:`scripts/smoke-interactive.mjs` / `src/main/smoke-interactive.ts` 当前只验 PTY echo 通,不断言 displayName。建议加一条 "Shell 模板创建后 displayName ∈ {'PowerShell', 'Bash', 'cmd', 'pwsh', ...}"。是 K3 反思里"补真实路径自动化"的延伸。
- **单测扩展**:`describe('looksLikeShellStartupGarbage')` 已覆盖启发式;若未来找到根因,把 workaround 改成根治后,这套测试可作为护栏继续保留(确认不再触发就行)。

## 参考

- `f96ae51 feat(session): OSC 0/1/2 标题事件 + input echo quiet 窗口 + shell override` — 引入 OSC 标题接收路径
- `7264004 fix(session): TIT-1 过滤 shell 启动期的"裸路径"OSC 标题, 不再覆盖 displayName` — 当前 workaround
- `docs/终端渲染审计备忘录-20260513.md` — 终端渲染相关审计条目
- `docs/robustness-pass-工作记录-20260513.md` §K3 — 测试场景盲点反思

## 下次回归此 issue 时

打开 `src/main/session-manager.ts` 找到 `looksLikeShellStartupGarbage` 函数,顶部注释提示了 TIT-1 + 本文档路径。若找到真正根因,**先 land 根治修复并验证启发式过滤不再被命中**(把 `looksLikeShellStartupGarbage` 改成只做日志告警不拒绝、跑一遍 daily driver 流程),确认没有 OSC 标题真的触发它,再移除过滤。否则保留启发式作为深度防御。
