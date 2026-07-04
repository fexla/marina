# ISO-3 · scripts/release.mjs 调用了 package.json 不存在的 npm scripts,发布流水线 Phase 3 必失败

**状态**:**待修**(2026-05-25 发现于 v0.2.0 实际发布过程)

**优先级**:P2(发版自动化失效,每次发版被迫绕过 release.mjs 直接用 `npm run build`,失去 ISO-1 verify 阶段对产物纯净度的自动校验,与 ISO-2 互锁)

**首次发现**:2026-05-25(v0.2.0 发版,跑 `node scripts/release.mjs --win` 在 Phase 3 Clean & Switch 步骤失败)
**关联工单**:
- [ISO-1 跨平台构建污染](./iso-1-cross-platform-build-pollution.md)(本工单是 ISO-1 commit 的 incomplete 状态)
- [ISO-2 electron-builder 过滤失效](./iso-2-electron-builder-cross-platform-filter-incomplete.md)(本工单不修,ISO-2 没有自动验收门)

**关联代码**:
- `scripts/release.mjs`(发布流水线主入口)
- `package.json` `scripts` 段(缺 7+ 个 release.mjs 引用的 npm script)
- ISO-1 commit `99bb094`(把脚本文件加进来但没同步 npm scripts)

---

## 现象

v0.2.0 发版过程,跑 `node scripts/release.mjs --win` 在 Phase 3 失败:

```
════════════════════════════════════════════════════════════════
║ Phase 3 · Clean & Switch
════════════════════════════════════════════════════════════════

  → 清 out/ 与 node-pty/build
  $ node scripts/clean.mjs --out --native
[clean] 完成:删了 2 / 3 个目标

  → switch:win(electron-builder install-app-deps --platform=win32)
  $ npm run switch:win
npm error Missing script: "switch:win"
npm error To see a list of scripts, run:
npm error   npm run
  ✗ switch:win 退出码 1
  ✗ 修复后重跑;或加 --skip-xxx 跳过对应阶段
```

`scripts/release.mjs` 内部用 `spawnSync('npm', ['run', 'switch:win'])` 调用,但 `package.json` 的 `scripts` 段**只有 17 个 script**,缺以下 7 个 release.mjs 引用的:

```
缺:
  clean:win        清 Windows 产物
  clean:linux      清 Linux 产物
  clean             — release.mjs Phase 3 也可能用
  switch:win       electron-builder install-app-deps --platform=win32 --arch=x64
  switch:linux     electron-builder install-app-deps --platform=linux --arch=x64
  build:linux:docker  通过 Dockerfile.linux-build 构建 Linux 包(本机非 Linux 时走容器)
  verify           调 scripts/verify-artifacts.mjs 校验产物纯净度

可能还缺(未深查 release.mjs 全文):
  release          release.mjs 本身的 npm 别名
  release:win
  release:linux
  release:all
```

---

## 影响

### 直接影响:发版自动化失效

`scripts/release.mjs` 设计是发版**单一入口**:
- Phase 1 Preflight(git 状态、平台、版本号)
- Phase 2 Code Quality(typecheck / lint / test)
- Phase 3 Clean & Switch(清 out + rebuild node-pty for target platform)
- Phase 4 Build(electron-vite + electron-builder)
- Phase 5 Verify(`scripts/verify-artifacts.mjs` 防 ISO-1 回归)
- Phase 6 Report(SHA256 + 产物大小 + 下一步)

实际上 v0.2.0 发版必须**手动绕过**,用 `npm run build` 直跑,跳过了:
- ❌ Phase 5 Verify — 产物纯净度无自动校验(这正是 ISO-2 被实测发现的原因 — 没人自动看产物)
- ❌ Phase 6 Report — SHA256 / 产物清单需要手动算

### 间接影响:跟 ISO-2 锁死

ISO-2 修复后需要自动验收门拦阻退化(产物里又混入 darwin-* 等),但**自动验收门**就是 `scripts/release.mjs` Phase 5 + `verify-artifacts.mjs`。ISO-3 不修,ISO-2 的修复每次发版都靠人肉检查 `release/*/win-unpacked/...`,迟早再退化。

### 严重性

- **不影响产品功能**:`npm run build` 替代品能用
- **影响发版质量**:每次发版人工绕过流水线 = 早晚漏掉 verify

---

## 根因

ISO-1 commit `99bb094 chore(ISO-1): 加跨平台构建隔离 + 发布脚本 + 流程文档` 加入了:
- ✅ `Dockerfile.linux-build`
- ✅ `.dockerignore`
- ✅ `scripts/clean.mjs`
- ✅ `scripts/build-linux-docker.mjs`
- ✅ `scripts/release.mjs`
- ✅ `scripts/verify-artifacts.mjs`
- ✅ `docs/issues/iso-1-cross-platform-build-pollution.md`
- ✅ `docs/打包发布流程.md`
- ✅ `electron-builder.yml` 加平台过滤
- ❌ **`package.json` `scripts` 段未同步**

推测:作者写 release.mjs 时心里有一套 npm script 名,记进文档,但 commit 时漏改 `package.json`,且本地从未真跑过 `release.mjs --win`(本地 dev 都直跑 `npm run build`)。

ISO-1 commit 后唯一一次发版尝试在 v0.2.0(本次),立即暴露。

---

## 修复方向

直接,工作量 < 30 分钟:

### 1. 补 package.json scripts 段

```json
{
  "scripts": {
    // ... 现有
    "clean": "node scripts/clean.mjs --out --release --cache",
    "clean:native": "node scripts/clean.mjs --native",
    "clean:all": "node scripts/clean.mjs --all",
    "switch:win": "electron-builder install-app-deps --platform=win32 --arch=x64",
    "switch:linux": "electron-builder install-app-deps --platform=linux --arch=x64",
    "build:linux:docker": "node scripts/build-linux-docker.mjs",
    "verify": "node scripts/verify-artifacts.mjs",
    "release": "node scripts/release.mjs",
    "release:win": "node scripts/release.mjs --win",
    "release:linux": "node scripts/release.mjs --linux",
    "release:all": "node scripts/release.mjs --all"
  }
}
```

(具体参数要对照 `scripts/release.mjs` 内部 `spawnSync('npm', ['run', 'xxx'])` 的每一处调用核实,本工单只列出 v0.2.0 现场抓到的一个,完整列表需逐行扫 release.mjs。)

### 2. 验证

`node scripts/release.mjs --win --skip-typecheck --skip-tests` 能完整跑完 6 个 Phase,Phase 5 Verify 报告产物纯净度。

### 3. 顺手 — release.mjs 自检

在 release.mjs 入口加一段:启动时检查所需 npm script 都存在,缺的话明确提示用户先补 package.json(而不是跑到 Phase 3 才崩)。

---

## 验收标准

- [ ] `npm run` 列出 `release` / `release:win` / `release:linux` / `release:all` / `verify` / `switch:win` / `switch:linux` 等 script
- [ ] `node scripts/release.mjs --win --skip-typecheck --skip-tests` 在 Windows 主机上从 Phase 1 跑到 Phase 6 不中断
- [ ] Phase 5 Verify 阶段输出产物清单 + 平台二进制分布,有问题时 exit 1
- [ ] 下一次发版(v0.2.1 / v0.3.0)可以 `npm run release:win` 一键发,不再手动绕过

---

## 关联

- **ISO-1**:本工单是 ISO-1 commit 的 incomplete 状态,补完后 ISO-1 的"三层防御"才真的就位
- **ISO-2**:本工单修完才能给 ISO-2 提供自动验收门 — 否则 ISO-2 修了也没人自动看
- **v0.2.0**:本工单首次发现的版本;v0.2.0 发版绕过 release.mjs 直跑 `npm run build` 完成,产物功能 OK,但 ISO-2 的死重就是因为绕过 Verify 漏发现
