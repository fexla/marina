@echo off
REM EasyTerm cmd.exe hook (说明文档,实际不被调用)
REM
REM cmd.exe 没有 prompt function,无法像 PowerShell 那样包装。
REM EasyTerm 通过 WindowsAdapter.buildShellLaunchParams 直接设置 PROMPT
REM 环境变量来嵌入 OSC 1337 序列:
REM
REM   PROMPT=$E]1337;CurrentDir=$P$E\$P$G
REM
REM 其中:
REM   $E = ESC (0x1b)
REM   $P = current path
REM   $G = '>' (greater-than)
REM   ESC \ = ST (String Terminator,OSC 序列终止符)
REM
REM 这个文件保留用于文档化、跨平台 PlatformAdapter 接口完整性、以及
REM 未来如果改用 cmd /K hook.bat 路线时启用。
REM
REM 对应文档:软件定义书.md 5.1.8、12.5;ADR-003、ADR-008

echo [EasyTerm] cmd.exe hook is configured via PROMPT environment variable, not this batch file.
