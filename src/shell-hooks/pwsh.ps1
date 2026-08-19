# !!! KEEP THIS FILE PURE ASCII -- DO NOT add non-ASCII characters !!!
#
# Windows PowerShell 5.1 reads .ps1 using the system ANSI code page when
# no UTF-8 BOM is present. On a Chinese-locale machine that is CP936/GBK,
# and our UTF-8 multi-byte sequences get mis-decoded into stray "}" / "{"
# bytes that break the parser (real bug, v0.1.0-beta.1, see ENC-1).
#
# Marina prefers PowerShell 7 (which reads .ps1 as UTF-8 by default) but
# falls back to powershell.exe 5.1 when 7 is not installed -- so the bug
# hits every Chinese Windows user without pwsh 7. We do not ship a BOM
# (it would force every editor + tooling step to preserve it). Pure ASCII
# is the only stable solution.
#
# If you need to emit a Chinese string to the user, do it from the
# TypeScript side and pass it in as a parameter. Node reads .ts as UTF-8
# unambiguously; this file must stay ASCII.
#
# Regression guard: src/main/shipped-scripts-ascii.test.ts (vitest will
# fail if any byte > 0x7F or a BOM appears in this file).
#
# ---------------------------------------------------------------------------
# Marina PowerShell hook (formerly EasyTerm, renamed in v1.5).
#
# Emits an OSC 1337 sequence before every prompt so the main process can
# track the session's working directory in real time
# (see software-definition.md 5.1.8, ADR-003).
#
# Design notes:
# - Source the user's own profile first so we don't pollute their config.
# - Wrap the prompt function: emit OSC 1337, then call the original prompt.
# - OSC 1337 format: ESC ] 1337 ; CurrentDir=<path> BEL
#   ([char]27 = ESC, [char]7 = BEL; works on both PowerShell 5.1 and 7).
# - Injected by WindowsAdapter.buildShellLaunchParams via:
#     pwsh -NoLogo -NoExit -Command ". 'pwsh.ps1'"
#
# Corresponding docs: software-definition.md 5.1.8, 12.5; ADR-003, ADR-008.

# Source the user's profile if it exists. -Force is intentional: even on
# error we want the hook to install (a broken profile must not silently
# disable cwd tracking).
if (Test-Path $PROFILE) {
    try {
        . $PROFILE
    } catch {
        Write-Host "[Marina] user PowerShell profile failed to load (hook still active): $_" -ForegroundColor DarkYellow
    }
}

# Wrap the prompt function. Save the original first so we can call it,
# otherwise we would recurse infinitely if the user's profile already
# defined a prompt.
#
# ADR-032: in addition to the OSC 1337 cwd report, every prompt render also
# emits OSC 133 D ("command finished"; the shell only renders a new prompt
# after the previous foreground command exited for good). Marina's main
# process uses D -- and only D -- to release the "program" title slot, so
# the tab falls back to the shell/default name once the foreground program
# (pi, vim, ...) is gone. We deliberately do NOT emit C here: pi itself
# writes 133;A/B/C into its output as message-zone markers, so any state
# driven by A/B/C would be poisoned by pi. D is emitted by shells only.
$script:_marinaOriginalPrompt = $function:prompt
function prompt {
    # OSC 133 D then A: previous command finished, new prompt starts.
    # 133;D may carry an exit code param (VS Code form); Marina accepts both.
    $oscMark = "$([char]27)]133;D$([char]7)$([char]27)]133;A$([char]7)"
    [Console]::Write($oscMark)
    $cwd = (Get-Location).Path
    # OSC 1337: \x1b ] 1337 ; CurrentDir=<cwd> \x07
    $osc = "$([char]27)]1337;CurrentDir=$cwd$([char]7)"
    [Console]::Write($osc)
    if ($script:_marinaOriginalPrompt) {
        & $script:_marinaOriginalPrompt
    } else {
        # Default prompt: "PS C:\path>"
        "PS $cwd> "
    }
}
