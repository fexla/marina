# show-in-marina 改进清单 — 实施总结

> 对应需求:5 项(SKILL.md 文档 2 项 + CLI 功能 3 项),全部完成。
> 全量测试 992 通过,typecheck / lint / shipped-scripts-ascii 全绿。

## 关键发现:你看到的 SKILL.md 是旧的

你实际跑的是 **`.pi/skills/show-in-marina/`**(项目级安装快照),它**落后于源**
`src/skills/show-in-marina/`——缺 bash 封装脚本、SKILL.md/ps1 是旧版。

所以你列的 #2(`$MARINA_WORKSPACE` 陷阱警告)**在源里其实早已有完整覆盖**,
只是没同步到 `.pi/`。本次已把源整体同步到 `.pi/`,运行中的 app 重新打开终端即生效。

## 五项改动逐条

### #2 `$MARINA_WORKSPACE` 写文件陷阱(高 · 文档)— 已在源存在 + 同步
源 SKILL.md 已有「Where to write the artifact」一节 + `workspace` 命令,明确写出:
> A file-writing API/tool does **not** expand `$MARINA_WORKSPACE` … Passing one of
> those strings to such a tool creates a literal directory with that name under the
> current cwd — exactly the wrong behavior.

并给 PowerShell / bash 两条「先 `workspace` 拿真实路径再写」的范例。同步到 `.pi/` 后即生效。

### #1 文档作为任务沟通界面(高 · 文档)— 新增
SKILL.md 新增 `### Use one document as the task dashboard (multi-turn work)`:
固化「跨多轮同一任务用一份文档当沟通面,每轮覆写 + re-show 同一路径,CLI 只留状态」的模式。
这是 marina 通用能力,故进 SKILL.md 而非各项目提示词。

### #3 僵尸 tab 检测(中 · CLI + 服务)— 新增
- `OpenedFile` 新增可选 `missing?: boolean`。
- 服务:`fs.watch` 检测到删除即标 `missing=true`(重现清回 false);新增 `refreshStale()`;
  `GET /opening-files` 拉取前先刷一次磁盘真值。
- CLI:`marina list` 给僵尸 tab 打 `!` 前缀 + `(deleted)`,末尾提示 `marina close --stale`;
  `list --json` 输出 `"missing": true`。

### #4 批量 close(中 · CLI + 服务)— 新增
- CLI:`close --all` / `close --stale` / `close --glob '<PATTERN>'`;路径含 `*`/`?` 自动当 glob。
- 服务:新增 `POST /close-files {terminal, mode, pattern?}` + `closeAllFiles` / `closeMatchingFiles`;
  返回体带 `closed` 路径列表,CLI 据此打印「closed N file(s)」。
- glob 为内置极简实现(只 `*`/`?`,大小写不敏感,匹配 basename),**不新增依赖**。

### #5 close 路径匹配(低 · 文档 + 服务)— 新增
- 服务 `closeFile`:精确路径未中 → 回退大小写不敏感 **basename** 匹配。
  `close report.md`(只给文件名)也能关;多个同名时报错提示用完整路径或 glob,不猜不误关。
- renderer tab 关闭恒走精确路径,行为不变。
- SKILL.md 补「`close` matching」说明。

## 改了哪些文件

**源(skill 权威 + 被测)**
- `src/skills/show-in-marina/SKILL.md` — #1、#5 文档 + 命令清单更新
- `src/skills/show-in-marina/marina.ps1` — `close`(--all/--stale/--glob + 通配自动检测)、
  `list`(僵尸标记)、`Print-Usage` 更新。ASCII-only,parse OK。

**服务 / 类型**
- `src/shared/types.ts` — `OpenedFile.missing?: boolean`
- `src/main/file-panel-service.ts` — `missing` 维护、`refreshStale`、
  `closeAllFiles`/`closeMatchingFiles`、`closeFile` basename 回退、
  `GET /opening-files` 刷真值、`POST /close-files`、内置 `matchFileGlob`。

**测试(全绿)**
- `src/main/file-panel-service.test.ts` — +18 例(stale / basename / 批量 / HTTP 新端点)
- `src/main/marina-cli.test.ts` — +9 例(list 僵尸标记、close 各形态、互斥、通配自动)
- `src/main/marina-cli-mock-server.py` — 支持 `list_mode=mixed` fixture + `/close-files` 路由

**安装快照 + changelog**
- `.pi/skills/show-in-marina/` — 与源同步(含此前缺失的 bash 封装)
- `CHANGELOG.md` — `[Unreleased]` 段新增「show-in-marina 技能」小节(版本号未动,附录 E 纪律)

## 实测(对 mock server 真跑)

```
$ marina list
*  C:/fake/a.md  (markdown)
 ! C:/fake/gone.md  (markdown) (deleted)

1 deleted file(s) above no longer exist on disk. Run: marina close --stale

$ marina close --stale
closed 1 file(s) [stale]:
  C:/fake/gone.md

$ marina close --glob '*.md'
closed 1 file(s) [glob '*.md']:
  C:/fake/a.md

$ marina close --all --stale   # 互斥
exit=2  marina: close: --all / --stale / --glob are mutually exclusive
```

## 你需要做的

1. **重启终端 / 重开窗口** 让 `.pi/` 的新 skill 生效(运行中的旧终端仍用旧 CLI)。
2. 想即时验证:`./.pi/skills/show-in-marina/marina.cmd list` 看 `! (deleted)` 标记。
3. 这批是 PATCH 级(打磨已有 skill),记在 `[Unreleased]`;要产测试 portable 时再按附录 F 折成 `0.3.2-dev.N`。
