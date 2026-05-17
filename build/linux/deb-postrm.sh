#!/bin/sh
# BETA-003d · Debian/Ubuntu postrm —— remove / purge 时把 marina 从
# update-alternatives 候选里摘掉。upgrade 时不动(下一份 postinst 会 install 同名链)。
set -e

case "$1" in
    remove|purge)
        if [ -x /usr/bin/update-alternatives ]; then
            update-alternatives --remove x-terminal-emulator /usr/bin/marina || true
        fi
        rm -f /usr/bin/marina
        if [ -x /usr/bin/update-desktop-database ]; then
            update-desktop-database -q /usr/share/applications || true
        fi
        ;;
esac

exit 0
