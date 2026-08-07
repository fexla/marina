# Marina

Marina 以 Path 为稳定工作位置、以 Session 为廉价临时活动，并用临时窗口观察和操作这些状态。

## Language

**Path**:
用户长期识别和组织的工作位置；可以是当前电脑目录或 SSH 远端目录。
_Avoid_: Project、Workspace、Repo 容器

**Session**:
在一个 Path 上启动的临时终端活动；创建后始终归属于该 Path。
_Avoid_: 持久工作区、可恢复任务

**PathKind**:
Path 所属的访问域；`local` 表示当前 backend 的文件系统，`ssh` 表示该 backend 经 SSH 访问的远端。
_Avoid_: 用“本机/远程窗口”替代 kind（远程 backend 的当前电脑仍是 `local`）

**Bookmark Group**:
用户组织收藏 Path 的虚拟容器；每个分组实例只属于一个 PathKind，local 与 ssh 共用分组能力但不共用分组实例。
_Avoid_: 跨 PathKind 的全局分组、Project、Workspace
