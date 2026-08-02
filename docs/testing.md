# 自动化测试场景清单

> 从 `AGENTS.md` 第 5 章(5.2~5.7)迁出。
> **原则**(后端必测、前端不测、用什么栈)仍在 `AGENTS.md` 第 5 章;本文是具体场景细则。
> **何时读**:写/审测试、判断某模块要不要测试时。

### 5.2 测试栈


* **测试框架**:Vitest(若 Jest 配置更顺手则用 Jest,你决定)
* **mock 库**:Vitest 内置或 sinon
* **PTY 测试**:用 mock,不要 spawn 真的 PowerShell(慢且不稳)
* **文件系统测试**:用 `memfs` 或临时目录,不要写真实数据目录

### 5.3 必须测试的场景(后端)
#### 状态机类(必测)
* Path 状态机的所有转移(收藏 ↔ 临时 ↔ 最近)
* Session 状态机的所有转移(active ↔ idle → exited → destroyed,v1.2 ADR-008 后)
* 应用生命周期状态机(启动 → 有窗口 ↔ 纯托盘 → 退出)

#### 核心管理器(必测)
* SessionManager:创建 / 销毁 / 状态查询 / owner 切换
* PathManager:增删改 / 自动分类 / 容量限制(最近最多 30 个)
* SettingsManager:读 / 写 / 验证 / 默认值合并 / 版本迁移
* WindowManager:窗口编号分配 / owner 关系维护

#### 协议类(必测)
* IPC 消息的序列化 / 反序列化
* 消息 schema 验证

#### 持久化类(必测)
* 原子写(写临时文件 → rename)
* 损坏恢复(JSON 损坏时回退到 .bak / 默认值)
* 版本迁移

#### 解析类(必测)
* OSC 1337 序列解析
* PTY 字节流的状态识别(active / idle 阈值)

### 5.4 不需要测试的(后端)

* 第三方库的 wrapper(如 node-pty 的简单封装)
* 简单的 getter / setter
* IPC handler 仅做转发的部分(转发逻辑测,handler 本身不测)
* `console.log` 等纯日志代码

### 5.5 测试覆盖率目标

* CP-2 时:核心数据模块 > 70%
* CP-3 时:状态机模块 > 80%
* CP-4 时:整个 `src/main/` > 75%

不追求 100%,追求**关键路径有保护**。

### 5.6 测试要"会出错"

测试不仅测 happy path,还要测:
* 错误输入(null、undefined、错误类型、超长字符串)
* 边界条件(0 个 / 1 个 / N 个 session;路径数量到 30 上限)
* 并发(同一个 session 被两个窗口同时 claim)
* 异常(PTY 启动失败、JSON 损坏、磁盘写失败)

### 5.7 跑测试

* `npm test` 跑所有测试
* `npm run test:watch` 开发时用
* CI 必须跑测试,失败必须阻止 merge

---
