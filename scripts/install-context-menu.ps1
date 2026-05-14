# !!! KEEP THIS FILE PURE ASCII -- DO NOT add non-ASCII characters !!!
# See src/shell-hooks/pwsh.ps1 header for the full rationale (ENC-1).
# Short version: Windows PowerShell 5.1 mis-decodes UTF-8 .ps1 files as
# CP936/GBK on Chinese-locale machines and the parser breaks.
# Regression guard: src/main/shipped-scripts-ascii.test.ts.
#
# ---------------------------------------------------------------------------
# scripts/install-context-menu.ps1
#
# Install the Marina Win11 new right-click menu (IExplorerCommand).
# Triggered by Settings -> "Win11 new menu -> Enable" via the main
# process invoking powershell.exe.
#
# Steps:
#   1) Self-elevate via UAC when not already admin. The cert must land in
#      Cert:\LocalMachine\TrustedPeople -- CurrentUser\TrustedPeople is
#      NOT enough on a clean Win11 box: Add-AppxPackage validates the MSIX
#      signature chain against LocalMachine and returns 0x800B0109
#      (CERT_E_UNTRUSTEDROOT) when the self-signed cert is only in the
#      CurrentUser store.
#   2) Import the self-signed cert into Cert:\LocalMachine\TrustedPeople.
#   3) Add-AppxPackage -Path <msix> (registers sparse package + IExplorerCommand).
#
# Output handling across the elevation boundary:
#   The elevated child cannot write to the non-elevated parent's stdout
#   pipe. We funnel everything through a transcript file under %TEMP%; the
#   non-elevated wrapper reads it after the child exits and re-emits to
#   its own stdout/stderr, so the Marina main process sees the same shape
#   it did before this change.
#
# Parameters:
#   -MsixPath  <abs>   Absolute MSIX path (resolved from extraResources by main)
#   -CertPath  <abs>   Absolute .cer path (same)
#   -_Relaunched       Internal flag set when self-relaunched as admin --
#                      DO NOT pass from the main process. Suppresses a
#                      second relaunch and skips the transcript file
#                      re-read.
#
# Exit codes (kept stable -- the main process inspects them):
#   0  success
#   2  required resource missing
#   3  Import-Certificate failed
#   4  Add-AppxPackage failed
#   5  elevation cancelled or failed (NEW)
#
# Idempotency: Import-Certificate is a no-op when the thumbprint already
# exists; Add-AppxPackage is skipped when Get-AppxPackage already reports
# the package (locale-independent -- the previous version matched
# error-message text, which broke on non-English Windows).

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$MsixPath,

    [Parameter(Mandatory = $true)]
    [string]$CertPath,

    [Parameter(Mandatory = $false)]
    [switch]$_Relaunched
)

$ErrorActionPreference = 'Stop'

# --- preflight: required resources exist (cheap, same check both sides) ---
if (-not (Test-Path -LiteralPath $MsixPath)) {
    Write-Error "MSIX package not found: $MsixPath"
    exit 2
}
if (-not (Test-Path -LiteralPath $CertPath)) {
    Write-Error "Certificate file not found: $CertPath"
    exit 2
}

# --- elevation gate ---
# Detect admin via WindowsPrincipal -- works on both Windows PowerShell 5.1
# and PowerShell 7. When not admin, relaunch self with -Verb RunAs and
# replay the elevated child's output via a transcript file so the main
# process keeps getting a uniform stdout/stderr stream.
$principal = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent()
)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin -and -not $_Relaunched) {
    $transcript = Join-Path $env:TEMP "marina-msix-install.log"
    # Wipe any stale transcript from a prior run so we only ever read this
    # invocation's output.
    if (Test-Path -LiteralPath $transcript) {
        Remove-Item -LiteralPath $transcript -Force -ErrorAction SilentlyContinue
    }

    # The elevated child needs to capture BOTH its own stdout/stderr AND
    # the relaunch wrapper around it. Easiest reliable trick: have the
    # child wrap its work in Start-Transcript / Stop-Transcript pointed at
    # $transcript, then exit with the inner exit code.
    $childInvocation = @(
        '-NoProfile'
        '-ExecutionPolicy', 'Bypass'
        '-File', $PSCommandPath
        '-MsixPath', $MsixPath
        '-CertPath', $CertPath
        '-_Relaunched'
    )

    try {
        # -Verb RunAs triggers the UAC prompt. -Wait blocks until the
        # elevated process exits so we can inspect its exit code and
        # transcript synchronously. -PassThru returns the Process object.
        # WindowStyle Hidden suppresses a visible console window flash;
        # UAC is its own modal, unaffected by this.
        $proc = Start-Process -FilePath 'powershell.exe' `
            -ArgumentList $childInvocation `
            -Verb RunAs `
            -WindowStyle Hidden `
            -Wait `
            -PassThru
    } catch {
        # User clicked No on UAC, or the desktop is in a state where UAC
        # cannot prompt (e.g. policy). Both surface as Win32Exception.
        Write-Error "Elevation cancelled or failed. Win11 new menu install needs admin rights to import the cert to LocalMachine\TrustedPeople. ($($_.Exception.Message))"
        exit 5
    }

    # Replay the elevated child's transcript so the main process sees the
    # same diagnostic output it saw before this change. Start-Transcript
    # adds a header / footer; we strip nothing -- the main process logs
    # this verbatim, and the extra lines are harmless.
    if (Test-Path -LiteralPath $transcript) {
        try {
            Get-Content -LiteralPath $transcript -ErrorAction Stop | ForEach-Object {
                Write-Output $_
            }
        } catch {
            # If we cannot read the transcript, the child still exited
            # with a meaningful code -- fall through.
        }
        Remove-Item -LiteralPath $transcript -Force -ErrorAction SilentlyContinue
    }

    exit $proc.ExitCode
}

# --- elevated context (or already admin) ---

# When we reach here we are admin. If we got here via self-relaunch, write
# a transcript so the non-elevated wrapper can replay it. We tolerate
# Start-Transcript failures -- worst case the user just sees less
# diagnostic output, the install itself still proceeds.
$transcriptStarted = $false
if ($_Relaunched) {
    $transcript = Join-Path $env:TEMP "marina-msix-install.log"
    try {
        Start-Transcript -LiteralPath $transcript -Force | Out-Null
        $transcriptStarted = $true
    } catch {
        # Continue without a transcript -- the wrapper will just see no
        # output, but the exit code still propagates.
    }
}

try {
    Write-Output "[1/2] Importing certificate to Cert:\LocalMachine\TrustedPeople"
    try {
        $imported = Import-Certificate -FilePath $CertPath -CertStoreLocation Cert:\LocalMachine\TrustedPeople -ErrorAction Stop
        Write-Output "    Imported thumbprint=$($imported.Thumbprint)"
    } catch {
        Write-Error "Import-Certificate failed: $($_.Exception.Message)"
        exit 3
    }

    Write-Output "[2/2] Registering MSIX package"
    $existing = Get-AppxPackage -Name 'Marina.ContextMenu' -ErrorAction SilentlyContinue
    if ($null -ne $existing) {
        Write-Output "    Already installed ($($existing.Version)), skipping Add-AppxPackage"
    } else {
        try {
            Add-AppxPackage -Path $MsixPath -ErrorAction Stop
            Write-Output "    Registered Marina.ContextMenu"
        } catch {
            Write-Error "Add-AppxPackage failed: $($_.Exception.Message)"
            exit 4
        }
    }

    Write-Output "Done. The new menu should appear in Explorer within seconds; restart Explorer if it does not."
    exit 0
} finally {
    if ($transcriptStarted) {
        try { Stop-Transcript | Out-Null } catch { }
    }
}
