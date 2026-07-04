# ISO-2 · electron-builder 平台过滤部分失效:Windows 包仍夹带 darwin-* / win32-arm64 prebuilds

**状态**:**待修**(2026-05-25 发现于 v0.2.0 实际产物)

**优先级**:P3(产物功能完整,无 SIGSEGV 风险;仅 ~1MB 死重 + ISO-1 文档承诺的"零污染"目标未达成)

**首次发现**:2026-05-25(v0.2.0 release 后审查产物)
**关联工单**:[ISO-1 跨平台构建污染](./iso-1-cross-platform-build-pollution.md)(本工单是 ISO-1 三层防御中"打包层平台过滤"那一层的实测失效)

**关联代码**:
- `electron-builder.yml`(win / linux / mac 三段 `files` 负 glob)
- ISO-1 commit `99bb094` 加的过滤规则

---

## 现象

v0.2.0 Windows 安装包(`release/0.2.0/win-unpacked/`)解包后,`node-pty/prebuilds/` 内容如下:

```
node_modules/node-pty/prebuilds/
├── darwin-arm64/        ← 不该出现(macOS ARM,Windows runtime 不加载)
│   ├── pty.node         85,496 字节
│   └── spawn-helper     50,480 字节
├── darwin-x64/          ← 不该出现(macOS Intel)
│   ├── pty.node         52,864 字节
│   └── spawn-helper      9,248 字节
├── win32-arm64/         ← 不该出现(Windows ARM,Marina 只发 x64)
│   ├── conpty.node     302,592 字节
│   ├── conpty_console_list.node 122,368 字节
│   ├── pty.node        293,376 字节
│   ├── winpty-agent.exe 286,720 字节
│   ├── winpty.dll      236,032 字节
│   └── conpty/ (目录)
└── win32-x64/           ← 正确,Windows x64 用户加载这个
    ├── conpty.node     312,320 字节
    └── ... (5 个文件)
```

按 ISO-1 文档,`electron-builder.yml` 的 `win.files` 应过滤 darwin-* / linux-*:

```yaml
win:
  files:
    - '!**/node_modules/node-pty/build/**'
    - '!**/node_modules/node-pty/prebuilds/darwin-*/**'
    - '!**/node_modules/node-pty/prebuilds/linux-*/**'
```

**实测**:
- ✅ `build/Release/*` 过滤生效(目录在产物里不存在 — ISO-1 防 Linux ELF 加载的核心目的达成)
- ❌ `prebuilds/darwin-*/**` 过滤**未生效**(两个 darwin 目录都在)
- ⚠️ `prebuilds/win32-arm64/**` 没在过滤名单里,但对 Windows x64 用户也是死重(loader 不会用)

---

## 影响

### 严重性:低

- **不影响运行**:node-pty loader 优先级为 `prebuilds/{platform}-{arch}/`,Windows x64 命中 `prebuilds/win32-x64/pty.node` 后不加载其他目录。darwin-* / win32-arm64 内的文件在 Windows runtime 上**永远不会被 dlopen**,没有 SIGSEGV 风险。
- **无安全风险**:这些都是 node-pty 上游签名的官方 prebuild,不是恶意夹带。

### 实际代价:仅死重

- 多打约 **1.3 MB** 到 Windows 安装包(Setup.exe 与 Portable.exe 双份)
- 多占用约 **1.3 MB** 安装后磁盘空间

### ISO-1 文档承诺未兑现

ISO-1 工单顶部写"**已根治(2026-05-20)** — 三层防御...本仓自 beta.10 起的所有产物零污染"。v0.2.0 实测仍有污染(降级 — 从 Linux ELF 这种严重污染降级为同源死重),但承诺的"零"没达到。

---

## 根因(怀疑)

未做深查,以下是基于 electron-builder 行为的合理推测:

### 假说 A:负 glob 跟顶层 `files:` 合并语义不符预期

ISO-1 commit 的 `electron-builder.yml`:

```yaml
files:
  - "out/**"
  - "package.json"
  ... 顶层正 glob

win:
  files:
    - '!**/node_modules/node-pty/build/**'      ← 生效
    - '!**/node_modules/node-pty/prebuilds/darwin-*/**'  ← 失效?
    - '!**/node_modules/node-pty/prebuilds/linux-*/**'
```

electron-builder 24.x 文档说明 `<platform>.files` 是"override 而非 merge"。如果 `win.files` 是 override,顶层 `files: ["out/**", ...]` 在 Windows 包里就完全失效了 — 但实际看 Windows 包是完整的(含 out/、package.json 等),所以应该是 merge,但 negation 的合并时机/优先级不对。

### 假说 B:negation 顺序问题

electron-builder 的 file 解析按数组顺序处理 include / exclude。如果顶层 `node_modules/**` 等正 glob 在 `win.files` 的负 glob 之后处理,负 glob 不会生效。

### 假说 C:`asarUnpack` 路径优先级

`asarUnpack: - node_modules/node-pty/**` 的 `**` 可能优先于 `win.files` 的负 glob,把所有 prebuild 强制 unpack。

### 实证下一步

要**真改起来必须先打开 electron-builder debug log**(`DEBUG=electron-builder npm run build`),看每个文件最终决策路径,再决定:
- 改 negation 用更精确的 glob
- 用 `extraResources` + 显式枚举每平台二进制
- 或在打包前用 `scripts/clean.mjs` 物理删除其他平台 prebuilds(暴力但确定)

---

## 修复方向(候选)

按代价递增排:

### 方案 1:打包前物理删除(暴力,推荐先试)
- 在 `npm run build` 之前调 `scripts/clean.mjs --prebuilds=keep-win32-x64`(新参数)
- 优点:确定 100% 生效,易理解
- 缺点:破坏性操作,跨平台开发时切换平台后要重 `npm install` 恢复

### 方案 2:negation glob 精修
- 用 `--debug` 模式定位 negation 失效的具体原因
- 调 negation 位置 / 顺序 / 精度
- 优点:符合 electron-builder 文档意图
- 缺点:可能踩 electron-builder 暗坑,需多次实验

### 方案 3:显式 `extraResources`
- 顶层 `files:` 直接 `'!**/node_modules/node-pty/prebuilds/**'`(全删)
- 每平台用 `extraResources` 显式声明要包的二进制
- 优点:边界清晰,确定生效
- 缺点:跟 node-pty loader 路径约定耦合,node-pty 升级改 prebuild 布局会破坏

### 方案 4:Docker 构建 + 物理隔离(已部分落地)
- Windows 包在干净的 Windows 环境构建(只装 win32-x64 prebuild)
- Linux 包在 `Dockerfile.linux-build` 构建(ISO-1 已做)
- 优点:从源头杜绝
- 缺点:Windows 容器构建复杂,CI 成本上升;且本地开发体验是"切换平台要重置环境"

**首选**:**方案 1**(打包前 clean)— 简单暴力,等 CI 完整建好后再升级到方案 4。

---

## 验收标准

修后,v0.x.0 / v0.x.0-beta.x 的 Windows 安装包解包后应满足:

```
node_modules/node-pty/prebuilds/
└── win32-x64/   ← 只有这一个
```

且自动化 verify 脚本(`scripts/verify-artifacts.mjs` 已存在,但当前依赖 `release.mjs` 调用 — 见 ISO-3)能在 CI 上以 exit 1 拦截违反此规则的产物。

Linux 包同理:

```
node_modules/node-pty/build/Release/
└── pty.node    ← 只有 Linux ELF
node_modules/node-pty/prebuilds/  ← 整个目录不存在
```

---

## 关联

- **ISO-1**:本工单是 ISO-1 三层防御中"打包层平台过滤"那一层的实测失效。ISO-1 文档需要降级"已根治"声明,至少把"打包层"标为"部分生效"。
- **ISO-3**:`scripts/release.mjs` 的 Phase 6 Verify 阶段会自动用 `verify-artifacts.mjs` 检查产物纯净度,本工单的修复需要 ISO-3 先把 release.mjs 修通才能在 CI 上自动拦截。
- **v0.2.0**:本工单首次实测发现的版本。v0.2.0 已发版,已知带 ~1.3MB 死重 prebuilds,不影响功能,不召回。
