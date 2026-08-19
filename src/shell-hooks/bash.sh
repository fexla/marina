#!/usr/bin/env bash
# Marina bash hook
#
# Git Bash on Windows + macOS / Linux bash 通用。通过 --rcfile 加载,绕过默认
# rcfile 解析,因此需要主动 source 用户的 ~/.bashrc。
#
# 关键设计:
# - 加载用户原 .bashrc 后再装 PROMPT_COMMAND,避免被用户配置覆盖
# - 用 PROMPT_COMMAND 在每次 prompt 前打印 OSC 1337
# - **Git Bash 特殊处理**:bash 的 $PWD 是 Unix 风格("/c/Users/foo"),Marina
#   的 PathManager 按 Windows 风格归类。若机器装了 cygpath(Git Bash 内置),
#   转成 "C:\Users\foo" 再发送;无 cygpath(POSIX 系统)时直接发 $PWD,
#   Marina 在 macOS / Linux 上自然认 Unix 路径。
#
# 对应文档: 软件定义书.md 12.5;v0.1.0-alpha.3 errata #6

# 加载用户原 .bashrc
if [ -f "$HOME/.bashrc" ]; then
    # shellcheck source=/dev/null
    . "$HOME/.bashrc"
fi

# 注入 OSC 1337 cwd hook (仅当不重复时)
# ADR-032:每次 prompt 渲染同时发 OSC 133 D+A(上一条命令结束、新 prompt
# 开始)— Marina 用 D(且只用 D)释放 program 标题槽。不发 C:pi 自己会往
# 输出里写 133;A/B/C 作消息分区标记,C 驱动的状态会被 pi 污染。
__marina_emit_cwd() {
    printf '\033]133;D\007\033]133;A\007'
    local cwd="$PWD"
    if command -v cygpath >/dev/null 2>&1; then
        # Git Bash / MSYS2 / Cygwin:转 Windows 风格
        local win
        win="$(cygpath -w "$PWD" 2>/dev/null)" && [ -n "$win" ] && cwd="$win"
    fi
    printf '\033]1337;CurrentDir=%s\007' "$cwd"
}
case ":$PROMPT_COMMAND:" in
    *":__marina_emit_cwd:"*) ;;
    *) PROMPT_COMMAND="__marina_emit_cwd${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
esac
