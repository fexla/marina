#!/bin/sh
# BETA-003d · RHEL/Fedora/CentOS postrm —— uninstall 时摘 alternative。
# RPM 的 %postun 参数为 0 表示真卸载,1 表示 upgrade。electron-builder 会把
# afterRemove 脚本编进 spec 的 %postun 段,$1 含义保留。
set -e

if [ "${1:-0}" = "0" ]; then
    if [ -x /usr/sbin/alternatives ]; then
        /usr/sbin/alternatives --remove x-terminal-emulator /usr/bin/marina || true
    elif [ -x /usr/bin/alternatives ]; then
        /usr/bin/alternatives --remove x-terminal-emulator /usr/bin/marina || true
    fi
    rm -f /usr/bin/marina
    if [ -x /usr/bin/update-desktop-database ]; then
        update-desktop-database -q /usr/share/applications || true
    fi
fi

exit 0
