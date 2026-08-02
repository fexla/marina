# 终端视图生命周期规范

> 从 `AGENTS.md` 附录 J 迁出。对应 **ADR-022**(TerminalDeck / active-parked / view lease)。
> **何时读**:改 TerminalDeck、session 切换的 xterm 复用、远程 view lease、WebGL renderer 归属时。
> 暂无独立方案文档;以本文为唯一规范来源。

## 规范正文


### J.1 普通切换禁止销毁 xterm

- A→B→A 普通 Session 切换必须复用同一个 Terminal、DOM node、buffer 与 viewport。
- 禁止用 `key=sessionId` 每次重建后再用单个 `viewportY` 猜测恢复；state replay 只用于
  首次 mount、cache eviction、窗口刷新或 view lease 断流。
- TerminalDeck 最多缓存 10 个访问过的终端；LRU 淘汰、Session destroy 才可 dispose。
- LayoutHost/File/Git panel 不进 deck，隐藏 panel 必须 unmount 并维持 NONE demand。

### J.2 active / parked 权限边界

- active slot 是唯一可 focus、input、fit、resize 的终端。
- parked slot 必须 `visibility:hidden + inert + pointer-events:none`，但继续解析定向输出。
- WebGL 只允许 active slot 持有；parked 释放 addon 回退 DOM renderer，但不销毁 Terminal core。
- 全局 focus selector 必须限定 `[data-terminal-active="true"]`，不得命中第一个隐藏 textarea。

### J.3 只读 view lease

- interactive owner 仍是单一真值；view lease 只获得 PTY 输出，绝不放行 input/resize/文件/Git。
- 每 Session 最多一个 lease；有 owner 发 owner，owner=null 发连续 parked view，绝不广播。
- `clientId + viewId` 必须匹配；旧 cleanup 不能删除新 lease。
- 其他 client 接管并产生输出后旧 view 标记 discontinuous；再次 attach 必须换 generation replay。
- Session destroy、本地窗口关闭、远程 client 断线与 cache eviction 都必须显式清 lease。

### J.4 验证

终端生命周期改动至少跑真实 Electron smoke，断言：
- A→B→A 的 `.xterm-viewport` DOM identity 不变；
- A parked 期间仍收到后台 output；
- 用户停在历史位置时 `viewportY` 切前/parked/切回一致；
- cache hit 不调用完整 state replay；
- 原 PTY round-trip smoke、typecheck、lint、全量测试仍通过。

---

**说明书结束**

> 这份说明书会随 Marina 项目演化而修订。如果你看的版本是 1.0,而 git 里有更新版本,以最新版本为准。
>
> 当你完成 V1 构建,你的最后一个 commit 应该是更新本文件的 "Last Updated" 字段并加一行:
> "构建完成于 2026-XX-XX,by [agent identifier]"。
