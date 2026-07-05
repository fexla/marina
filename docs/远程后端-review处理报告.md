# 远程后端 · Reviewer 反馈处理报告

> **状态:✅ 6 项反馈全部处理** · 2026-07-05
> Reviewer:`reviewer` agent(fresh context,独立审查,未带本会话偏见)

---

## 背景

调用 `reviewer` agent 对本次会话的两批改动做独立 review:
- **改动 1**(代码 fix `f233a90`):session-manager SPAWN_ENV_SKIP 加 MARINA_SERVICE/MARINA_TOKEN
- **改动 2**(阶段0文档):spec ADR-014/§14.9 + ipc-protocol v2.0 + 方案文档

reviewer 的价值:它**复现验证了 fix 根因**(还原 `f233a90^` 跑测试确认失败,不只读 commit message),并抓到我犯的 1 个真实 blocker + 5 个建议。

---

## 反馈处理清单

| # | reviewer 反馈 | 级别 | 处理 | 状态 |
|---|---|---|---|---|
| 1 | **ipc-protocol claim/release 结构破损** + "v2.0 新增"标签错误(`cmd:session:release` v1 就存在,`protocol.ts:61`) | ❌ blocker | 改"v2.0 语义扩展"、复位 claim 的 Side Effects、删重复块 | ✅ |
| 2 | clientId/windowId 命名空间边界不清 + 附录 B.3 伪代码未 sweep | ⚠️ | 新增 §2.6.1 边界表(envelope=clientId / ownership=ownerClientId / 窗口实体=windowId);B.3 `ownerWindowId→ownerClientId` | ✅ |
| 3 | 自动 release 与重连握手的互斥未定义(断线瞬间重连竞争) | ⚠️ | release 段加"daemon 端 client 表单一锁串行化"保证 | ✅ |
| 4 | 方案风险表缺三项(跨 transport 仲裁 / daemon 崩溃回退 / TLS 指纹存储) | ⚠️ | 加 R10 / R11 / R12 | ✅ |
| 5 | spec §13.2"远程 SSH session 管理 — 不是产品定位"字面与远程后端冲突 | ⚠️ | 加 ADR-014 脚注消歧(SSH 已 §14 反转;远程后端是不同概念) | ✅ |
| 6 | fix:TERMINAL_ID 也该加进 SPAWN_ENV_SKIP(防御 + 自洽) | ⚠️ | 加 + 更新注释;新 commit `6897831`,push fork/main | ✅ |

---

## fix 增强(reviewer #6)

`TERMINAL_ID` 加入 `SPAWN_ENV_SKIP`。理由:虽被 createSession 无条件覆盖(L702 `env.TERMINAL_ID = sessionId`),但"本 session 唯一标识"语义上不该对继承开放,加进黑名单防御未来某路径忘了覆盖。与 MARINA_SERVICE/MARINA_TOKEN 同档位。

```typescript
const SPAWN_ENV_SKIP = [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_RENDERER_URL',
  'MARINA_SERVICE',
  'MARINA_TOKEN',
  'TERMINAL_ID',   // ← 本次新增
];
```

---

## 最终拓扑

```
b3d5165 merge feat/file-side-panel into fork main
  └─ 7903787 merge fix/copy-double-crlf into fork main
       └─ f233a90 fix(session): MARINA_SERVICE/MARINA_TOKEN 不继承     ── fork/main(已 push)
            └─ 6897831 fix(session): TERMINAL_ID 也加入 SPAWN_ENV_SKIP  ── fork/main 新头(已 push)
                 └─ 7a8b973 docs: 远程后端方案文档
                      └─ ccbb061 docs(spec): ADR-014 + §14.9
                           └─ 07c0f7c docs(ipc): v2.0 Transport-Ws
                                └─ f3208ba docs: 阶段0报告
                                     └─ a411a74 docs: 处理 reviewer 反馈  ── feat/remote-backend-stage0(当前)
```

**两条线分离干净**:
- `fork/main`(`6897831`):纯代码 fix(双 fix),已 push,可独立发版
- `feat/remote-backend-stage0`(`a411a74`):rebase 到含双 fix 的 fork/main 之上,5 个文档 commit

---

## 基线

- `npm test`:**551/551 passed**
- `npm run typecheck`:exit 0
- 工作树:干净

---

## reviewer 总评回顾 + 本次回应

| reviewer 结论 | 本次回应 |
|---|---|
| 改动1(fix):**可合并**(根因已复现验证、修复最干净、副作用在边角更正确) | ✅ 已合并 fork/main,且按 #6 建议增强了 TERMINAL_ID |
| 改动2(文档):**需先修 1 处 blocker 再推进** | ✅ blocker(ipc-protocol 结构)已修,5 个建议项全部处理 |

---

## 下一步

阶段0 + reviewer 反馈全部收口。`feat/remote-backend-stage0`(`a411a74`)是干净的阶段1 基点:
- 含双 fix(代码基线绿)
- 含完整设计文档(spec §14.9 / ADR-014 / ipc-protocol v2.0 / 方案 v0.2)
- reviewer 已扫过,无已知 blocker

可开 `feat/remote-backend-stage1` 推进**阶段1**(daemon 化 + WS 传输层)。

---

*本报告通过 file-panel 打开。reviewer 的完整 review 见上一条对话(agent 委派返回)。*
