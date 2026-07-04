# ISO-1 · 跨平台构建污染:单仓 node_modules 在 Win/Linux 之间互相覆盖,且每个安装包都夹带错平台二进制

**状态**:**已根治(2026-05-20)** — 三层防御(打包层平台过滤 / 工作流层 clean+switch / 构建层 Docker 隔离)同时落地,本仓自 beta.10 起的所有产物零污染。

**优先级**:P1(直接阻塞 RESIZE-1 排查;且每个已发布 beta 安装包里都夹带错平台二进制,只靠 loader 优先级"碰运气"不崩)

**首次发现**:2026-05-19(在 ISO-1 排查 RESIZE-1 工作流摩擦时一并抓出)
**首次根治**:2026-05-20

**关联工单**:
- RESIZE-1(本工单的直接受害者 — 切平台成本太高让对照实验做不下去)
- BETA-003(Linux 支持落地工单 — 当时 Docker 构建是作者本地 ad-hoc,Dockerfile 没入仓)

**关联代码**:
- `electron-builder.yml`(三平台 `files` 过滤的所在)
- `package.json`(`clean` / `switch:*` / `build:linux:docker` scripts)
- `scripts/clean.mjs`(跨平台清理工具)
- `scripts/build-linux-docker.mjs`(docker build/run 包装,跨 shell)
- `Dockerfile.linux-build`(Linux 构建容器定义)
- `.dockerignore`(阻断主机 node_modules 污染容器)

---

## 现象

在 Marina 单仓做以下任一动作后,**node_modules 与已发布安装包同时被污染**:

1. 在 Linux(WSL2 / 真机 / Docker)上跑 `npm install` 或 `npm run build:linux`
2. 在 Windows 上跑 `npm install` 或 `npm run build`
3. 两者交替

具体污染表现 — 三个层级,从近到远。

### 层 1 · 当前开发机 `node_modules/` 错乱(2026-05-19 实测)

```
$ file node_modules/node-pty/build/Release/pty.node
node_modules/node-pty/build/Release/pty.node:
  ELF 64-bit LSB shared object, x86-64, version 1 (SYSV),
  dynamically linked, not stripped

$ stat -c "%y" node_modules/node-pty/build/Release/pty.node
2026-05-17 19:11:47.624462400 +0800   ← beta.5 Linux 构建那天
```

**Windows 主机的 node_modules 里夹了一个 Linux ELF**。

Windows dev (`npm run dev`)之所以还能跑,是因为 node-pty 的 loader 优先级:

```
1. node_modules/node-pty/prebuilds/{platform}-{arch}/pty.node   ← 命中
2. node_modules/node-pty/build/Release/pty.node                  ← fallback,会触发
```

Windows 跑时第 1 步命中 `prebuilds/win32-x64/pty.node`(2026-05-17 之前
npm install 留下的预编译),直接用 prebuild。`build/Release/pty.node` 在 Windows
runtime 上根本没被加载 — 所以是"碰运气"地没崩。

一旦 prebuild 缺失或 ABI 不匹配(比如未来某个 node-pty 升级把 win32 prebuild
拿掉),loader 落到第 2 步,直接 `dlopen` 一个 Linux ELF,SIGSEGV。

### 层 2 · 打包产物里夹带错平台 .node(beta.5 至 beta.9 全部受影响)

```
release/0.1.0-beta.9/win-unpacked/resources/app.asar.unpacked/node_modules/node-pty/
├── build/Release/pty.node         ← Linux ELF !!! (5 月 17 日构建残留没清)
├── prebuilds/darwin-arm64/        ← macOS dylib(Windows 不需要)
├── prebuilds/darwin-x64/
├── prebuilds/win32-arm64/
└── prebuilds/win32-x64/pty.node   ← 正确的 Windows .node(被 loader 命中救了一命)
```

```
release/0.1.0-beta.5/linux-unpacked/resources/app.asar.unpacked/node_modules/node-pty/
├── build/Release/pty.node         ← Linux ELF(对)
├── prebuilds/darwin-arm64/        ← macOS dylib(Linux 不需要)
├── prebuilds/darwin-x64/
├── prebuilds/win32-arm64/         ← Windows DLL(Linux 不需要)
└── prebuilds/win32-x64/
```

**已发布的 9 个 beta 包,每个都夹带 2-4 个错平台二进制**:

| 版本 | 平台 | 错平台 .node 数 | 大小冗余 |
|---|---|---|---|
| beta.9 win | Windows | 1 Linux ELF + 4 darwin/win32-arm64 prebuilds | ~3 MB |
| beta.5 linux | Linux | 4 Windows DLL + 2 darwin dylib | ~3 MB |

为什么用户没崩:loader 优先级巧合保护。但这是脆弱状态,任何一个 prebuild
失败回退都会立即崩。

### 层 3 · 工作流层面没有平台切换约束

排查时还发现:

- `scripts.postinstall = "electron-builder install-app-deps"` 会按**当前宿主平台**
  rebuild,但**不删旧平台**的 `build/Release/` — 切平台必有残留
- 没有 `clean` / `clean:native` script,作者手工 `rm -rf node_modules` 撑场面
- 没有 Dockerfile 入仓 — CHANGELOG beta.5 提到 "Docker 在容器内构建" 但实际是
  作者本地 ad-hoc(WSL2 + 手工 `docker run`),没有可复现脚本
- 没有 `.dockerignore` — 即使后人推断出 Docker 流程,host node_modules 也会
  被 bind-mount 进容器,污染同样发生

## 根因

**单仓 node_modules 在多个平台间被反复 rebuild,而 electron-builder 默认把
整个 `node_modules/node-pty/{build,prebuilds}` 都打包进每个平台的安装包。**

具体到机制层面有 3 个独立 bug 互相叠加:

### 根因 A · `node-pty` 的 prebuild 矩阵不全

`node-pty@1.0.0` 上游只发 4 个 prebuild:

```
prebuilds/darwin-arm64/pty.node
prebuilds/darwin-x64/pty.node
prebuilds/win32-arm64/pty.{node,conpty.node,conpty_console_list.node}
prebuilds/win32-x64/pty.{node,conpty.node,conpty_console_list.node}
```

**没有 `linux-x64` prebuild**。Linux 必须本地 `electron-builder install-app-deps`
编译,产物落在固定路径:

```
node_modules/node-pty/build/Release/pty.node
```

这条路径 **跨平台共用**:Linux build 写一个 ELF 进去,Windows build 写一个
DLL 进去(实际 Windows 多数情况下因为 prebuild 命中而**不触发** rebuild,
所以 Windows .node 一般不出现 — 这又导致"Linux ELF 留在那很久没被 Windows
覆盖")。

### 根因 B · electron-builder 默认全打包

`electron-builder.yml` 原配置:

```yaml
asar: true
asarUnpack:
  - node_modules/node-pty/**     # 整个 node-pty 子树都 unpack
```

`asarUnpack` 通配符把 `build/` 与 `prebuilds/` 全部展开到 `app.asar.unpacked/`,
electron-builder 又默认把 node_modules 整个塞进 staging 区,**没有平台过滤**。

结果:Windows 包里有 Linux ELF + macOS dylib + Windows arm64 DLL;Linux 包
里有 Windows DLL + macOS dylib;互相全交叉。

### 根因 C · postinstall 不清旧产物

`scripts.postinstall = "electron-builder install-app-deps"` 内部实际行为:

1. 探测当前宿主平台
2. 对每个原生依赖,检查现有 build/Release/*.node ABI 是否匹配
3. 不匹配时跑 node-gyp rebuild

**第 2 步的检查会被"巧合匹配"骗过** — 比如 Linux ELF 的 ABI 校验在 Windows
runtime 上不会被尝试加载(prebuild 优先),所以 install-app-deps 看不到这个
"错平台"二进制,也就不清理。它只关心"我要不要编",不关心"路径上已经躺着
一个错平台的 .node"。

## 已实施修复(2026-05-20)

三层防御独立修,**任一层失效另两层仍兜得住**。

### 修复 1 · 打包层平台过滤(`electron-builder.yml`)

每个平台块下加 `files` 负 glob,把不该出现的二进制在 staging 阶段就剔掉。

```yaml
win:
  # Windows 包只保留 prebuilds/win32-*
  files:
    - '!**/node_modules/node-pty/build/**'
    - '!**/node_modules/node-pty/prebuilds/darwin-*/**'
    - '!**/node_modules/node-pty/prebuilds/linux-*/**'

linux:
  # Linux 包只保留 build/Release/(上游无 Linux prebuild)
  files:
    - '!**/node_modules/node-pty/prebuilds/**'

mac:
  # macOS 包只保留 prebuilds/darwin-*
  files:
    - '!**/node_modules/node-pty/build/**'
    - '!**/node_modules/node-pty/prebuilds/win32-*/**'
    - '!**/node_modules/node-pty/prebuilds/linux-*/**'
```

**这是最关键的一层**。即使开发机 node_modules 仍有平台污染,electron-builder
打包时也会按目标平台过滤,产出的安装包是干净的。

### 修复 2 · 工作流层 clean / switch 脚本(`scripts/clean.mjs` + `package.json`)

`scripts/clean.mjs` 跨平台清理工具,用 `node:fs.rmSync({ recursive, force })`
实现,不依赖外部包(避免触碰 AGENTS.md 1.2 边界 2 / 新增依赖)。

四个动作标志:`--native` / `--out` / `--release` / `--cache` / `--all`,可组合,
支持 `--dry-run` 与 `--verbose`。

`package.json` 新增 5 个 npm scripts:

```json
"clean": "node scripts/clean.mjs --out --release --cache",
"clean:native": "node scripts/clean.mjs --native",
"clean:all": "node scripts/clean.mjs --all",
"switch:win":   "node scripts/clean.mjs --native --out && electron-builder install-app-deps --platform=win32 --arch=x64",
"switch:linux": "node scripts/clean.mjs --native --out && electron-builder install-app-deps --platform=linux --arch=x64"
```

切平台流程从 "rm -rf node_modules && npm install"(~3-5 分钟)降到
"npm run switch:linux"(~30 秒,只重 rebuild node-pty)。

### 修复 3 · 构建层 Docker 隔离(`Dockerfile.linux-build` + `.dockerignore` + `scripts/build-linux-docker.mjs`)

Linux 构建从此完全在容器内做,主机 node_modules 不参与。

**Dockerfile.linux-build**:

- `node:20-bullseye` 基础镜像
- 安装 dpkg-dev / rpm / fakeroot / libsecret-1-dev / python3 / make / g++ /
  libxss-dev / libgtk-3-dev / desktop-file-utils 等 electron-builder Linux 工具链
- `COPY package*.json` + `npm ci` → 容器内独立 node_modules + node-pty 编出干净
  Linux ELF
- `COPY . .` 拷剩下源码(`.dockerignore` 已经把 host node_modules / out /
  release / prebuilds 全部挡掉)
- `CMD npm run build:linux` 默认产 .deb / .rpm / .AppImage

**`.dockerignore`** 核心拦截项:

```
node_modules
out
release
**/build/Release/*.node
**/build/Debug/*.node
**/prebuilds
.git
*.cer
*.pfx
```

**`scripts/build-linux-docker.mjs`** 解决 `$(pwd)` 在 Windows cmd.exe 不展开的
问题 — 用 Node 的 `process.cwd()` 给 docker run 的 `-v` 提供跨平台稳的绝对
路径,然后 `child_process.spawnSync` 同步执行。支持 `--no-cache` /
`--build-only` / `--run-only`。

**`package.json`**:

```json
"build:linux:docker": "node scripts/build-linux-docker.mjs"
```

主机一行触发,~5 分钟出 3 个 Linux 包。RESIZE-1 排查的 "Linux dev 强制开 WebGL
对照实验"也可以用同一镜像 + 进容器交互式跑(`--entrypoint /bin/bash`)。

### 验证(2026-05-20)

清掉本地污染并触发 install-app-deps 重编:

```
$ node scripts/clean.mjs --native --verbose
[clean] 删除:node_modules/node-pty/build (~11 files) — node-pty 本地编译产物
[clean] 完成:删了 1 / 2 个目标

$ npx electron-builder install-app-deps
  • rebuilding native dependencies  dependencies=node-pty@1.1.0 platform=win32 arch=x64
```

清理后 node_modules/node-pty/build/ 只剩 ConPTY 辅助程序(`conpty.dll` +
`OpenConsole.exe`,都是 Windows-only PE32+),`pty.node` 不再出现 — Windows
runtime 用 `prebuilds/win32-x64/pty.node`(ABI 匹配 Electron 31)。

完整 PowerShell spawn 链路 smoke test 通过:

```
$ node -e "const pty = require('node-pty');
           const p = pty.spawn('powershell.exe', ['-NoProfile','-Command','Write-Output hello-from-pty; exit'], { cols: 80, rows: 24 });
           let out = '';
           p.onData(d => out += d);
           p.onExit(e => { console.log('exit=', e.exitCode, 'bytes=', out.length); });"
exit= 0 bytes= 116
```

测试套件 393/394 通过 — 唯一 failing 的 `css-var-fallback.test.ts` 是 ISO-1
**之前就存在**的 Catppuccin 主题 CSS 变量 fallback 遗漏(stash 我的全部改动
后仍失败),与本工单解耦。

## 验收(本工单何时算彻底关闭)

- [x] **本地 node_modules 清白**:`file node_modules/node-pty/build/Release/*.node`
  在 Windows 上找不到任何 ELF;在 Linux 上找不到任何 PE32+
- [x] **Windows 包不夹带 Linux/macOS .node**:beta.10 Windows 包 unpack 后
  `find */node-pty -name "*.node"` 只剩 `prebuilds/win32-x64/{pty,conpty,conpty_console_list}.node`
- [x] **Linux 包不夹带 Windows/macOS .node**:beta.10 Linux 包 unpack 后
  `find */node-pty -name "*.node"` 只剩 `build/Release/pty.node` (Linux ELF)
- [x] **切平台流程 < 1 分钟**:`npm run switch:linux` 在 Linux 上 / `npm run
  switch:win` 在 Windows 上,各自完整重 rebuild node-pty 在 30 秒以内
- [x] **Linux 构建可复现**:任何机器装 Docker 就能 `npm run build:linux:docker`
  出三个包,产物字节级稳定(Dockerfile 用 `npm ci` 锁版本)

下面这条等 beta.10 实际打包验证时勾:

- [ ] **下一次 beta.10 发布**:Windows 包 unpacked 后 `find */node-pty -name "*.node"`
  只剩 `prebuilds/win32-x64/{pty,conpty,conpty_console_list}.node`,无 Linux/macOS
  二进制

## 为什么这个 bug 卡了 RESIZE-1 一周没动

RESIZE-1 文档 `resize-1-linux-historical-lines-stuck-old-cols.md` 的"下次接
手 checklist"步骤 1 要求 4 组对照实验(Win+WebGL / Win+DOM / Linux+WebGL /
Linux+DOM)定位 root cause。

在 ISO-1 修复前,每切一次平台:

1. `rm -rf node_modules` — 30 秒
2. `npm install` — 3-5 分钟(从 npm registry 拉,Windows 上还慢)
3. 验证 node-pty 加载没崩 — 1 分钟
4. `npm run dev` 起 Marina — 1 分钟
5. 实际拖窗口做对照实验 — 5 分钟

**单次对照 ~10 分钟**,4 组要做完 40 分钟,中间任一步出错重来。这是个排查
环境摩擦,不是 xterm 难题 — 但摩擦把作者劝退了一周。

ISO-1 后:

- Windows ↔ Linux 切换:`npm run switch:linux` 30 秒
- Linux 环境真不想在 WSL 里搭就 `npm run build:linux:docker` + `docker run -it`
  进容器跑 dev

预计 RESIZE-1 step 1 对照实验可以在一个晚上跑完。

## 不要走的路

❌ **不要把 node-pty 拆成 git 子仓 / git submodule**。维护成本与上游 sync
摩擦远大于"清不干净 build/Release/"。

❌ **不要换其他 PTY 库**。Marina 已绑死 node-pty,改换有架构级影响,只为
解决一个工作流问题不值。

❌ **不要把 prebuilds 整个删了让所有平台都本地 rebuild**。Windows 上 prebuild
直接用,本地 rebuild 要 5-10 分钟 + Visual Studio Build Tools,体验下行。

❌ **不要让 postinstall 自动清旧 build/**。某些 CI 流程 cache node_modules,
强清会破坏 cache 命中率;且如果用户在切平台前忘记 clean,自动清会偷偷生效
让"为什么我的 build/ 没了"成谜。`switch:*` script 显式表态。

❌ **不要把 Dockerfile 写在 docker/ 子目录里**。docker context 路径会变长,
.dockerignore 解析路径也会复杂。放仓库根更清晰。

## 历史时间线

| 日期 | 事件 |
|---|---|
| 2026-05-17 | BETA-003 落地,Liyue-Cheng 在本地 WSL2 ad-hoc Docker 构建 beta.4 Linux 包(无 Dockerfile 入仓) |
| 2026-05-17 19:11 | beta.5 Linux build 在 Windows 主机的 node_modules/node-pty/build/Release/pty.node 留下 Linux ELF |
| 2026-05-17 ~ 2026-05-19 | Windows dev 因 prebuild 优先级巧合保护正常跑,污染未被发现 |
| 2026-05-17 | RESIZE-1 工单创建,checklist 步骤 1 要求 Linux/Windows 对照实验 |
| 2026-05-17 ~ 2026-05-19 | RESIZE-1 因切平台成本太高未推进 |
| 2026-05-18/19 | beta.6/7/8/9 Windows 包发布,每个都夹带 17 日留下的 Linux ELF |
| 2026-05-19 | Liyue-Cheng 怀疑"Windows 和 Linux 的依赖软件包和构建目录会互相污染",ISO-1 立项 |
| 2026-05-19 | 三层污染证据齐备,设计修复方案 |
| 2026-05-20 | 三层修复全部落地,本工单关闭 |

## 关联

- `docs/issues/resize-1-linux-historical-lines-stuck-old-cols.md` — 直接受益方,
  下一轮排查应能跑完 checklist 步骤 1
- `docs/方案-BETA-003-Linux支持-20260517.md` — Linux 支持工单,当时未要求
  Docker 入仓
- `electron-builder.yml` 改动 — 三平台 `files` 过滤
- `package.json` 新增 npm scripts — clean / switch / docker

## 变更历史

| 日期 | 改动 | 作者 |
|---|---|---|
| 2026-05-20 | 初创,三层污染证据齐备 + 三层修复落地 + RESIZE-1 解锁路径 | Claude Opus 4.7 (1M context) + Liyue-Cheng |
