#!/bin/sh
# BETA-003d · RHEL/Fedora/CentOS postinst —— 与 deb-postinst 等价语义,但调
# alternatives 而非 update-alternatives。
set -e

# /usr/bin/marina 符号链接,与 deb-postinst 同理
ln -sf /opt/Marina/marina /usr/bin/marina

if [ -x /usr/sbin/alternatives ]; then
    /usr/sbin/alternatives --install /usr/bin/x-terminal-emulator x-terminal-emulator /usr/bin/marina 50
elif [ -x /usr/bin/alternatives ]; then
    /usr/bin/alternatives --install /usr/bin/x-terminal-emulator x-terminal-emulator /usr/bin/marina 50
fi

if [ -x /usr/bin/update-desktop-database ]; then
    update-desktop-database -q /usr/share/applications || true
fi

exit 0
