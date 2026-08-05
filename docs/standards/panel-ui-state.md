# 面板 UI 状态 / 缩进 / icon 规范

> 从 `AGENTS.md` 附录 G 迁出。对应 **ADR-019**;方案论述见 `docs/方案-面板UI状态与缩进统一-20260721.md`。
> **何时读**:开发新面板、改文件树/缩进/icon 时。三条共享基础设施的使用规范。

## 规范正文


> 这三件事有了共享基础设施(ADR-019)。新面板开发按下表/决策,不再各面板自拼,
> 也不会再出「切面板丢状态 / 缩进不一致 / icon 都一样」的毛病。

### G.1 面板 UI 状态:按生命周期分三层(必选)

写面板状态前先问「这个状态丢了用户会烦吗」,按下决策:

| 丢了烦吗? | 例子 | 归属 | 用法 |
|---|---|---|---|
| 不烦(瞬态) | loading / error | L0 | 组件 `useState` |
| 烦,但重启可丢(工作态) | 展开目录 / 选中项 / 过滤草稿 | L1 | `usePanelUiState(sessionId, panelId, initial)` |
| 烦,且重启也该记(偏好) | 视图模式 / 排序方式 / 活跃项 | L2 | `usePanelPreference(panelId, key, fallback)` |

- L1 `usePanelUiState`(`src/shared/panel-ui-cache.ts`):组件外缓存,切面板再切回状态仍在。
- L2 `usePanelPreference`(`src/shared/panel-preferences.ts`):localStorage,跨重启。key 自动走 `marina.panel.<panelId>.<key>` 规范。
- **不许**:工作态存裸 `useState`(切面板即丢);偏好直接 `localStorage.setItem` 裸 key(绕过统一规范与老 key 迁移)。

> **教训(v0.3.4 修复)**:L1 只能放**纯 UI 工作态**。file-tree 曾把目录列表**数据快照**
> 也塞进 L1 且无失效源,远程文件系统上删除的文件几小时不消失;现失效源是 main 端
> FileTreePollingService(ADR-021 demand 轮询 + `evt:file-tree:changed` 事件推送,
> 见 `file-tree-polling-service.ts`)。任何面板若要把数据快照放进 L1,必须自带失效
> 机制(watcher / 事件 / 轮询),不得假设"无外部失效源"。

### G.2 树形缩进:单一真相源(必选)

- 所有树形层级缩进**只能**用 `<FileListRow depth={n}>`(唯一渲染入口),内部 `calc(var(--tree-indent-unit, 14px) * depth)`。
- 递归组件把 `depth` 往下传(根 0,每层 +1)。
- **不许**:自建 CSS 层叠缩进(`.x .x { margin-left }`)、自写 `depth * <硬编码>` inline style、改 `--tree-indent-unit` 的值(要改全局只改 `:root` 一处)。

### G.3 文件 icon:单一数据源(必选)

- 文件条目 icon 用 `fileIconFor(fileName)`(`src/shared/file-icon.ts`),按扩展名返回细分图标。目录用 `'folder'`。
- 新增文件类型 icon:扩 `file-icon.ts` 的扩展名集合(复用既有集合判定),并在 `icons.tsx` 注册同名 lucide 组件(`FileIconKey` ⊆ `IconName`,由 `file-icon.test.ts` 守护)。
- **不许**:硬编码 `icon="file"`、在组件里写 if-else 后缀判断。

### G.4 顶部多视图/多根切换

- 类似 Git 面板的 toolbar(`.git-panel-toolbar`)或 file-tree 的双根切换(`.file-tree-toolbar`):顶部按钮切换,内容区只渲染当前选中项。
- 切换状态(选中哪个)是**偏好** → L2 `usePanelPreference`。

---
