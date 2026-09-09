# 方案:pi-marina-bridge 整合 show-in-marina skill 与 Marina 系统提示词

- **日期**:2026-09-09
- **状态**:已实现(见文末验证)
- **归档**:ADR-028 决策 8(软件定义书)、CHANGELOG `[Unreleased]`
- **触发**:开发者指示 ——「直接把 Skill 整合到 PiBridge 里面。插件启动时检测到
  Marina 环境就自动注入 Skill 和系统提示词(内容参考 CharacterMarbleIdle
  CLAUDE.md 里和 marina 有关的部分)」。

---

## 0. 背景与动机

此前 show-in-marina skill 与 pi-marina-bridge 是两条独立分发路径:

| | show-in-marina skill | pi-marina-bridge |
|---|---|---|
| 物理位置 | `src/skills/show-in-marina/`(extraResources 单独打包) | `packages/pi-marina-bridge/` |
| 安装方式 | 每个项目手动:右键收藏路径 → 对话框选 pi/claude/codex | 一次全局 `pi install`(设置页按钮/侧栏右键) |
| 生效范围 | 装了的项目 | 本机所有项目(但仅 Marina 终端内激活) |
| 更新 | 手动重装 | Marina 启动时 ensureUpToDate 按 package version 静默刷新 |

问题:pi 用户要「装 bridge + 逐项目装 skill」两步;skill 副本永远停在安装日的
版本;两份内容(手动装的 skill / bridge)间无同步机制。

**新设计**:skill 随 bridge package 分发,extension 检测到 Marina env 后**自动**
注入 skill + 一段「Marina 输出习惯」系统提示词。装一次 bridge,所有 Marina 终端
里的 pi 全部自动获得,且随 bridge 版本自动更新。

## 1. 关键机制(pi 侧,调研结论)

对照 pi 0.84.4 源码(`dist/core/`)逐一验证:

1. **`resources_discover` 钩子**(pi ≥ 0.50.8):session_start 后触发,extension
   返回 `{ skillPaths, promptPaths, themePaths }` 即可贡献额外资源目录。贡献的
   skillPaths 走与 `~/.pi/agent/skills` 相同的递归发现(`skills/show-in-marina/
   SKILL.md` 被加载,名字+描述进系统提示词,正文按需 read —— 渐进披露)。
   - **package 的 manifest 优先收集**:package.json 有 `pi` manifest(pi.extensions)
     时,pi **不会**再自动扫描顶层 `skills/` 目录(`collectPackageResources` 的
     manifest 分支先返回)。→ 把 skill 放 `<pkg>/skills/` 且不声明进 manifest,
     目录天然「休眠」,只有我们主动贡献 skillPaths 才被加载。**这正是「仅 Marina
     环境注入」的实现基础**,不依赖 pi 的任何过滤配置。
2. **`before_agent_start` 钩子**:用户提交 prompt 后、agent 循环前触发,返回
   `{ systemPrompt }` 即替换本轮系统提示词(多 extension 链式,后者见到前者的
   修改)。pi **每轮从 `_baseSystemPrompt` 重建**(`agent-session.js` 里
   `emitBeforeAgentStart(..., this._baseSystemPrompt, ...)`),修改不跨轮持久 →
   每轮追加一次不会累积。
3. **`pi.on()` 无事件名校验**:handler 只存进 Map,老 pi(<0.50.8)遇
   `resources_discover` 注册静默不触发 —— 向后兼容,转发功能不受影响。
4. **jiti 下 `import.meta.url` 可用**(实测 pi 自带 jiti 加载 TS 文件,返回真实
   file URL;percent-encoding 由 `fileURLToPath` 解)→ extension 可定位包根。
5. **同名 skill 冲突先加载者胜**(只记 collision diagnostic):项目级
   `.pi/skills/show-in-marina` 旧副本**会遮蔽** bridge 注入的新副本 → pi 目标
   必须从手动安装里移除(见 §3)。

## 2. 实现桥(package 侧)

```
packages/pi-marina-bridge/
├─ extensions/
│  ├─ index.ts      # 注册 resources_discover + before_agent_start(env 守卫内)
│  ├─ inject.ts     # 注入纯函数:路径解析 + MARINA_SYSTEM_PROMPT + 幂等追加
│  ├─ pi-types.ts   # ExtensionAPI 本地最小结构化类型(见 §5)
│  └─ binding.ts    # (原有)workspace 绑定读取
└─ skills/
   └─ show-in-marina/   # 整目录自 src/skills/ git mv 而来(唯一真相源)
```

- **守卫**:沿用现有 `readMarinaEnv()` 三件套检测(`MARINA_SERVICE`/`MARINA_TOKEN`/
  `TERMINAL_ID`),env 缺失时整个 extension 早退 —— skill/提示词注入与事件转发
  一样,非 Marina 会话零注册零注入。
- **skills/ 目录缺失护栏**(打包遗漏/复制损坏):skill 与提示词**两个注入都不做**
  —— 提示词通篇引导模型用 show-in-marina skill,skill 缺席时只注入提示词会让
  模型反复找不存在的 skill,比都不注入更糟。转发功能照常。
- **幂等**:注入块首行放 `<!-- marina-bridge-system-prompt -->` 标记,
  `appendMarinaPrompt` 检测到标记即原样返回(pi 每轮从 base 重建,本不会累积;
  此为防御未来链式持久化/其它 extension 回灌)。
- **不走 Marina HTTP 往返**:注入是纯本地钩子行为,Marina 不通时 skill/提示词
  照样注入(展示 CLI 直连终端 env 指向的 service,与 main 的 workspace 决策无关)。
- **版本**:package 0.3.7 → 0.3.8。ensureUpToDate 按 version 比对静默重拷,已装
  用户自动拿到 skill + 新钩子。

## 3. Marina 侧联动

1. **SkillInstaller 去 pi 目标**:类型收窄为 `'claude' | 'codex'`(protocol /
   skill-installer / SkillInstallDialog 同步)。对话框正文注明「Pi 无需手动安装」。
   旧项目里已装的 `.pi/skills/show-in-marina` **不主动清理**(不动用户项目目录);
   如遮蔽 bridge 副本,删除该目录或随项目自决。
2. **SkillInstaller 源目录 = bridge 包内**:`<pkg>/skills/show-in-marina`(dev 从
   packages/ 源码读,packaged 从 extraResources `pi-marina-bridge/` 读)。claude/
   codex 手动安装与 pi 自动注入从此同一份物理内容。
3. **electron-builder**:删除 `src/skills → skills` 打包项(skill 已随 bridge
   package 整体打包);更新 bridge 条目注释。
4. **路径引用同步**:`marina-cli.test.ts`、`marina-sh.test.ts`、
   `shipped-scripts-ascii.test.ts`、`scripts/verify-marina-sh-linux.sh` 全部指向
   新位置;skill 内部脚本的 `src/skills/...` 注释改为 `./`(同目录引用,防再搬家
   失效)。
5. **UI 文案**:设置页 pi 集成两个 SettingRow 的 hint 补充「自动获得 show-in-marina
   skill 与 Marina 提示词」。

## 4. 系统提示词内容

来源 = CharacterMarbleIdle `CLAUDE.md` 中与 Marina 相关的三节,改写为 pi +
skill 语境(引用 `.claude/skills/show-in-marina/SKILL.md` 的地方改为「读
show-in-marina skill 的 SKILL.md」,即渐进披露):

1. **输出与展示** —— 大段输出(总结/报告/方案/review/调研/对比/决策)写成
   markdown 用 show-in-marina 展示;对话只留提炼 + 路径;短结论/单问/指令例外;
   多轮任务同文件覆写作看板。
2. **瀑布式输出** —— 最重要的内容放回复最底部。
3. **澄清提问(grilling)** —— 批量列出全部问题 + 标依赖;>3 个写进 marina 文档;
   每问带完整上下文;推论必须标注「这是推论,可能错」+ 依据。

分工:skill 教「CLI 怎么用」,提示词教「什么时候用、回复怎么排」。中文书写
(来源材料即中文;提示词随 bridge 版本演进,不提供用户自定义设置项 —— ADR-028
「不做」已记录)。

**不 gate 于 `piIntegration` 开关**:该开关管 workspace 绑定/指示灯;文件面板是
独立功能。注入只依赖「是否 Marina 终端」(env 三件套),与 `piIntegration=false
但仍在 Marina 终端里用面板` 的组合保持一致。

## 5. 附带修复:typecheck 红(48ec329 起)

`extensions/index.ts` 对 `@earendil-works/pi-coding-agent` 的 type-only import 在
Marina 仓不可解析(pi 是用户机器上的 CLI,Marina 仓不装该依赖),TS2307 级联 16 个
报错,HEAD 上 `npm run typecheck` 已红。修复:包内新增 `pi-types.ts` 本地最小
结构化类型(只声明实际使用的 `on` 9 事件重载 + `appendEntry` + ctx 切片,对照
pi 0.84.4 `types.d.ts` 核对),index.ts 改 import 它。jiti 运行时擦除类型,零影响;
不引入新 npm 依赖(边界 2 不触发)。

## 6. 验证记录

**自动化**(全绿):

- 新增 `src/main/pi-bridge-inject.test.ts`(12 用例):路径解析(含 percent-
  encoding)、幂等追加、提示词内容三节、真实 index.ts + mock pi 的注册逻辑
  (非 Marina env 零注册 / Marina env 下两钩子行为)。
- 更新 `skill-installer.test.ts`:双目标安装、pi 目标拒绝(`Unsupported skill
  target`)、冲突预检。
- 全仓:`npm test` 93 文件 1624 通过、`npm run typecheck` 0 错误(HEAD 原本 16
  个)、`npm run lint` 干净、prettier 已过。

**真实 pi 端到端**(pi 0.84.4,本机全局安装,`-e` 直接加载,**不碰用户 ~/.pi
配置**):探针 extension 排在 bridge 之后捕获链式 system prompt。

- 有 Marina env(伪 service 指向不通地址):skill 列表含
  `<name>show-in-marina</name>`,location 指向包内路径;提示词块恰好出现一次
  (marker 计数=1,三节俱全);事件 POST 失败只 warn,pi 流程不受阻(优雅降级)。
- 无 Marina env:marker=0、skill=0,完全 no-op。

**未覆盖 / 留给开发者手测**(自动化够不到的真实交互):

- 真实 Marina 终端里起 pi,问一个会产生长报告的问题,体感:模型是否主动读
  skill、写文档、`marina show`;对话回复是否只剩提炼 + 路径。
- 已装旧版 bridge 的机器升级后,ensureUpToDate 是否把 0.3.8(带 skills/)推到位
  (看 `~/.pi/agent/packages/pi-marina-bridge/skills/` 出现)。

## 7. 已知取舍

- **子会话(pi-subagents)同样被注入**:子 pi 进程继承父进程 env 三件套,其会话
  也会拿到 skill + 提示词。fork/子会话在 header 层不可区分(方案 20260817 已
  确认 parentSession 同源),提示词本身是「输出习惯」约定、子代理遵循无害,
  v1 不做区分;若实测发现子代理向面板刷屏,再考虑按 header/argv 特征屏蔽。
- **老项目 `.pi/skills` 旧副本遮蔽**:不主动删用户项目文件(边界 1);对话框与
  CHANGELOG 已说明。
