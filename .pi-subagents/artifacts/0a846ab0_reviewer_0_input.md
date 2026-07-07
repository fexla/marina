# Task for reviewer

审查 Marina 新加的 `--instance=<name>` 参数功能(让本地能开多个 Marina 实例调试远程连接)。用户要在同一台机器同时跑一个当 daemon、一个当 client 来 localhost 测远程,且不干扰正在跑的 `npm run dev`。

## 改动
1. `src/main/argv-utils.ts` 新增 `parseInstanceName(argv)`:解析 `--instance=<name>`,过滤非 `[A-Za-z0-9_-]` 字符(防路径注入),空则 null。
2. `src/main/index.ts` `bootstrap()`:在 `app.requestSingleInstanceLock()` 之前,如果 `parseInstanceName` 返回非 null,`app.setName('Marina (<name>)')`(覆盖 dev/portable/installed 的默认命名)。
3. `src/main/argv-utils.test.ts` 加 4 个测试(无参数/正常/非法字符过滤/过滤后为空)。

## 背景机制(已存在于代码,index.ts L97-108 DEV-COEXIST)
Electron 单实例锁键 = app name(底层是 userData 目录)。dev=`Marina (dev)`、portable=`Marina (portable)`、installed=`Marina`,三者本就独立。新参数让用户能任意命名 → 任意多实例。

## 请验证
1. **功能正确性**:parseInstanceName 解析 + 过滤逻辑是否正确?`app.setName` 在 `requestSingleInstanceLock` 之前调用,时序对吗(index.ts L141 才 requestSingleInstanceLock)?
2. **能否真正多实例并存**:`Marina.exe --instance=daemon` 和 `Marina.exe --instance=client` 是否真的各自独立(独立 userData、独立单实例锁、不互相挤掉)?会不会和正在跑的 `npm run dev`(Marina (dev))冲突?
3. **安全**:非法字符过滤够不够?`--instance=..\evil` 过滤后能注入路径吗?空字符串/null 处理对吗?
4. **日志/数据隔离**:不同 instance 的 userData 不同,那 settings、远程密码(daemon-credentials)、main.log 是否各自隔离(测试时不会串)?
5. **远程连接测试可行性**:用这个开两个实例后,client 连 `127.0.0.1`(localhost)测 daemon 是否可行?扫描 32780-32789 在 localhost 上工作吗?

关键文件:src/main/argv-utils.ts、src/main/index.ts(L94-145 bootstrap)、src/main/argv-utils.test.ts。

输出:功能是否正确生效 + 用户能否按预期开多实例 + 有无 BLOCKER。要严苛。

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

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