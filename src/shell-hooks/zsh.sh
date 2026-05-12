#!/usr/bin/env zsh
# Marina zsh hook (留给 macOS / Linux 贡献者) — 原 EasyTerm,v1.5 改名
#
# V1 不主动启用 (软件定义书 12.5),框架供贡献者参考。
#
# 关键设计:
# - 通过 precmd_functions 在每次 prompt 前打印 OSC 1337
# - 加载用户原 .zshrc

# 加载用户原 .zshrc
if [[ -f "$HOME/.zshrc" ]]; then
    source "$HOME/.zshrc"
fi

# 注入 OSC 1337 cwd hook
__marina_emit_cwd() {
    printf '\033]1337;CurrentDir=%s\007' "$PWD"
}
typeset -ag precmd_functions
if (( ! ${precmd_functions[(I)__marina_emit_cwd]} )); then
    precmd_functions+=(__marina_emit_cwd)
fi
