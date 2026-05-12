#!/usr/bin/env bash
# Marina bash hook (留给 macOS / Linux 贡献者) — 原 EasyTerm,v1.5 改名
#
# V1 不主动启用 (软件定义书 12.5),但已写好框架供贡献者参考与启用。
#
# 关键设计:
# - 通过 PROMPT_COMMAND 在每次 prompt 前打印 OSC 1337
# - 加载用户原 .bashrc 不污染 (source $HOME/.bashrc)
#
# 对应文档: 软件定义书.md 12.5

# 加载用户原 .bashrc
if [ -f "$HOME/.bashrc" ]; then
    # shellcheck source=/dev/null
    . "$HOME/.bashrc"
fi

# 注入 OSC 1337 cwd hook (仅当不重复时)
__marina_emit_cwd() {
    printf '\033]1337;CurrentDir=%s\007' "$PWD"
}
case ":$PROMPT_COMMAND:" in
    *":__marina_emit_cwd:"*) ;;
    *) PROMPT_COMMAND="__marina_emit_cwd${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
esac
