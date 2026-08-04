# Skill Linux 支持 —— 用户测试指南

> 目标:确认 `show-in-marina` skill 在 **Linux** 上不再装出 Windows 版,且 `marina` CLI 在 Linux 上可用。
> 预计用时:5~15 分钟(取决于 10.9.0.1 的访问方式)。

## 背景(一句话)

之前点「安装 Marina Skill…」装出来的 skill 是 Windows 专用(`marina.ps1`/`marina.cmd`/拒绝非 Windows 的 bash 包装器),Linux 上 agent 跟着 `SKILL.md` 走会 `exit 127`。本轮加了原生 POSIX 客户端 `marina.sh`,并把无扩展名的 `marina` 改成平台调度器(Linux 自动走 sh,Windows 走 ps1 不变)。

---

## 测试 1:全量自动化测试(预计 2 分钟,在你 Windows 开发机上)

```bash
cd D:/data/projects/agent/marina
npx vitest run src/main/marina-sh.test.ts src/main/marina-cli.test.ts
```

**预期**:
- `marina-sh.test.ts`:**42 passed / 1 skipped**(skip 的是调度器路由,只 Linux 跑)。
- `marina-cli.test.ts`:**51 passed**(PowerShell 客户端回归守护)。

**失败时**:把失败的 assertion 行 + stderr 贴给我。

## 测试 2:独立验证脚本(预计 1 分钟,Windows Git Bash)

不需要 node/npm,纯 bash+curl+python:

```bash
cd D:/data/projects/agent/marina
bash scripts/verify-marina-sh-linux.sh
```

**预期**:`RESULT: pass=24 fail=1`,唯一失败是 `missing TOKEN exit 1`——因为它用 `/etc/hostname` 当测试文件,该文件在 **Windows 不存在**,所以 `show` 先报「not a file」(exit 3)而非走到 token 检查。**这是预期失败,不是 bug**(真 Linux 上该文件存在,此用例通过)。

---

## 测试 3(关键):真实 Linux 端到端 —— 在 10.9.0.1 上跑

这是我**无法独立完成**的部分。SSH 到 10.9.0.1 当前有两个阻塞:

1. **known_hosts 主机密钥已变**:`~/.ssh/known_hosts` 里 10.9.0.1 的旧密钥与服务器现在的不一致(SSH 报 `REMOTE HOST IDENTIFICATION HAS CHANGED`)。
2. **无密钥授权**:本地 `fex` / `fex03` / `id_*` 密钥均被 `Permission denied (publickey,password)` 拒绝。

> 我**没有**改你的 `~/.ssh/known_hosts` 或绕过主机密钥校验(这属于安全敏感操作,按 AGENTS.md 边界 1 该你拍板)。需要你二选一:
>
> **(A) 你授权我连**:确认「主机密钥变了是正常的(机器重装过)」,我用 `ssh-keygen -R 10.9.0.1` 清掉旧条目 + `accept-new` 接受新密钥;并告诉我用哪个密钥/账号(或把我的公钥加进 10.9.0.1 的 `authorized_keys`)。
>
> **(B) 你自己跑**:把下面三行命令在 10.9.0.1 上执行,把输出贴给我。

### 选项 B:你在 10.9.0.1 上自己跑(推荐,最省事)

10.9.0.1 上需要:git(或把仓库拷过去)+ bash + curl + python3。把仓库弄到机器上后:

```bash
# 在 10.9.0.1 上,仓库根目录
bash scripts/verify-marina-sh-linux.sh
```

**预期**:`RESULT: pass=25 fail=0 / ALL CHECKS PASSED`。
这会覆盖:ping / workspace / show / run / close / list / screenshot 全部子命令、退出码、env 严格性、**调度器在无 powershell.exe 时正确路由到 marina.sh**、执行位保留。

> 注:该脚本用内置的 Python mock server 模拟 Marina 的 file-panel 服务,**不需要装完整 Marina**。它验证的是 `marina.sh` 这个客户端的逻辑正确性。

### (可选)测试 3b:连真实 Marina Linux 构建

如果你在 10.9.0.1 上跑得动完整 Marina(`npm run build` 的 linux target,或装个 deb/AppImage),做这个更接近真实:

```bash
# 1. 启动 Marina,开一个终端,在里面确认环境变量已注入:
env | grep MARINA    # 应看到 MARINA_SERVICE / MARINA_TOKEN;TERMINAL_ID 也在

# 2. 把 skill 装到某个项目(右键收藏 → 安装 Marina Skill),或手动:
cp -r src/skills/show-in-marina /tmp/testproj/.pi/skills/

# 3. 在那个项目里,通过 agent 或手动跑:
cd /tmp/testproj
./.pi/skills/show-in-marina/marina ping           # → exit 0, "marina: online"
echo '# hello' > report.md
./.pi/skills/show-in-marina/marina show report.md # → 文件面板出现该 md
./.pi/skills/show-in-marina/marina list           # → 列出打开的文件
./.pi/skills/show-in-marina/marina screenshot     # → 打印一个 png 路径
```

**预期**:面板收到文件、list 正确、screenshot 存图。任一步 exit 1 = 离线(检查 env 变量),exit 3 = 被拒(看 stderr)。

---

## 测试 4(可选):Windows 回归确认(预计 1 分钟)

确认我没弄坏 Windows 路径。在 Windows 开发机的 Git Bash 里:

```bash
cd D:/data/projects/agent/marina
# 调度器在 Windows 应走 ps1 分支(powershell.exe 在)
./src/skills/show-in-marina/marina --help   # 应打印 PowerShell 版的 usage
```

或在已装 skill 的项目里用 `.\marina.cmd ping`(PowerShell)。

**预期**:Windows 行为与改动前完全一致。

---

## 全部通过后

回复我:**「Skill Linux 通过」**或**「Skill Linux 失败:<清单>」**。

- 通过 → 这部分封箱,可选地推进方案决策点 2 的其他 Linux 残缺(zsh/fish cwd hook 等)。
- 失败 → 我按勘误回合修。
