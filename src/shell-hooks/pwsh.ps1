# EasyTerm PowerShell hook
#
# 注入此 hook 后,每个 prompt 出现前会发送 OSC 1337 序列报告当前 cwd,
# 让 Main 进程实时跟踪 session 的工作目录变化 (软件定义书 5.1.8、ADR-003)。
#
# 关键设计:
# - 加载用户原本的 PowerShell profile,不污染用户配置 (软件定义书 12.5)
# - 包装 prompt 函数,在原 prompt 输出前追加 OSC 1337
# - OSC 1337 序列格式: ESC ] 1337 ; CurrentDir=<path> BEL
#   (PowerShell 5.1 + 7 都支持 `e 转义,等价于 [char]27)
# - 由 WindowsAdapter.buildShellLaunchParams 通过
#   `pwsh -NoLogo -NoExit -Command ". 'pwsh.ps1'"` 注入,只 dot-source 一次
#
# @对应文档章节: 软件定义书.md 5.1.8、12.5;ADR-003、ADR-008

# 加载用户原本的 profile (如果存在)。-Force 是为了即使有错误也尽量加载。
# 用户 profile 报错只 warn,不阻碍 hook 装上 (避免坏 profile 让 cwd 跟踪失效)。
if (Test-Path $PROFILE) {
    try {
        . $PROFILE
    } catch {
        Write-Host "[EasyTerm] 用户 PowerShell profile 加载报错 (hook 仍生效): $_" -ForegroundColor DarkYellow
    }
}

# 包装 prompt 函数,注入 OSC 1337 cwd 报告。
# 用 script-scope 变量保存原 prompt 引用,避免无限递归 (用户 profile 可能
# 已经定义过 prompt;我们把它存下来再调它)。
$script:_easyTermOriginalPrompt = $function:prompt
function prompt {
    $cwd = (Get-Location).Path
    # OSC 1337: \x1b ] 1337 ; CurrentDir=<cwd> \x07
    # `e 是 PowerShell 5.1+ 支持的 ESC 转义字符
    $osc = "$([char]27)]1337;CurrentDir=$cwd$([char]7)"
    [Console]::Write($osc)
    if ($script:_easyTermOriginalPrompt) {
        & $script:_easyTermOriginalPrompt
    } else {
        # 默认 prompt: "PS C:\path>"
        "PS $cwd> "
    }
}
