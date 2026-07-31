@echo off
REM @file marina.cmd
REM @purpose Windows launcher for marina.ps1. Calls the system-built-in
REM   powershell.exe with -ExecutionPolicy Bypass -File marina.ps1, forwarding
REM   all args AND preserving the child's exit code across setlocal/endlocal.
REM
REM @why powershell (not python)
REM   Marina targets Windows users, and PowerShell ships with every Windows
REM   install -- so this skill needs NO extra runtime. A python skill would
REM   silently break on machines without python. This .cmd exists only to
REM   (1) bypass the default ExecutionPolicy (agents cannot be asked to run
REM   Set-ExecutionPolicy first) and (2) let the agent type `marina` instead
REM   of the full powershell incantation.
REM
REM @ascii-only (ENC-1): cmd.exe parses .cmd with the OEM code page on
REM   Chinese Windows (CP936/GBK); a non-ASCII byte here would mis-decode and
REM   can break the parser. English only, no BOM. Same rule as the .ps1/.bat
REM   files under src/shell-hooks/ (see shipped-scripts-ascii.test.ts).
REM
REM @exit-code-preservation
REM   `exit /b` with NO argument does NOT reliably return powershell.exe's
REM   exit code: when a setlocal block is active, the implicit endlocal at
REM   script end runs after `exit /b` resolves its (empty) argument and can
REM   reset ERRORLEVEL to 0. Empirically verified: a child `exit 5` returned
REM   0 through this launcher. The fix is the canonical pattern
REM   `endlocal & exit /b %errorlevel%`: cmd evaluates the WHOLE line in the
REM   current (setlocal) scope before running endlocal, so %errorlevel% is
REM   captured while it still holds the child's code. The same pattern is
REM   used on the not-found branch with an explicit literal (127).
REM
REM @corresponding: src/skills/show-in-marina/marina.ps1 (the real CLI logic).
REM @see-also: src/skills/show-in-marina/marina (a bash wrapper for agents
REM   whose tool shell is Git Bash / MSYS on Windows). Use THAT wrapper, not
REM   this .cmd, when invoking from bash: `cmd /c "marina.cmd ..."` is unsafe
REM   in MSYS because it rewrites the `/c` flag to the path `C:/`, silently
REM   starting an interactive cmd.exe that returns exit 0. The bash wrapper
REM   calls `powershell.exe -File marina.ps1` directly and dodges the trap.

setlocal

REM %~dp0 is this .cmd's directory, with a trailing backslash. Resolving
REM marina.ps1 next to this launcher (NOT via PATH) is the skill-resource
REM contract: the show-in-marina directory is copied unchanged into
REM .pi/skills/, .claude/skills/, or .agents/skills/, so the .cmd and .ps1
REM always live side by side. SKILL.md tells the agent to invoke this .cmd
REM by its path -- never assume a bare `marina` is discoverable.
set "SCRIPT=%~dp0marina.ps1"
if not exist "%SCRIPT%" (
  echo marina: marina.ps1 not found next to %~f0 1>&2
  endlocal & exit /b 127
)

REM powershell.exe is Windows-built-in (System32, always on PATH). -NoProfile
REM skips the user profile for a clean, fast startup. -ExecutionPolicy Bypass
REM lets the .ps1 run regardless of the machine's default policy. %* forwards
REM every arg. The trailing `endlocal & exit /b %errorlevel%` (see header)
REM is what makes the child's exit code survive this launcher.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
endlocal & exit /b %errorlevel%
