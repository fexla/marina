#!/bin/sh
# BETA-003d · Debian/Ubuntu postinst —— 把 marina 注册为 x-terminal-emulator
# 候选,优先级 50(高于 gnome-terminal 默认的 40,低于已显式 set 的项)。
#
# 用户在 Marina 设置 → "设为默认终端" 调 LinuxAdapter.registerFileManagerIntegration
# 会跑 `update-alternatives --set ...`,把 marina 锁定为活跃项;不点也无害,
# 用户可手动 `sudo update-alternatives --config x-terminal-emulator` 切换。
set -e

# /usr/bin/marina 符号链接 —— 让 `marina` 命令在 shell 可用,marina.desktop 的
# Exec=marina --working-directory=%f 才能定位
ln -sf /opt/Marina/marina /usr/bin/marina

# Electron SUID sandbox:deb 包内 chrome-sandbox 默认 0755(根因见下)。
# 裸跑 `marina`(不带 --no-sandbox)时 Chromium 要求 SUID 4755,
# 否则直接 FATAL:setuid_sandbox_host.cc 退出。dpkg 安装后在此补上。
# 注意:chmod 必须放在所有 chown 之后(先有 owner 才能生效)。
if [ -f /opt/Marina/chrome-sandbox ]; then
    chown root:root /opt/Marina/chrome-sandbox
    chmod 4755 /opt/Marina/chrome-sandbox
fi

if [ -x /usr/bin/update-alternatives ]; then
    update-alternatives --install /usr/bin/x-terminal-emulator x-terminal-emulator /usr/bin/marina 50
fi

# 刷新 desktop database,让文件管理器立刻识别 marina.desktop
if [ -x /usr/bin/update-desktop-database ]; then
    update-desktop-database -q /usr/share/applications || true
fi

exit 0
