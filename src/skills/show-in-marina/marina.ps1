<#
.SYNOPSIS
  marina.ps1 -- CLI for AI agents running inside a Marina terminal to drive
  Marina's side file panel (show / close / list files, probe reachability).

.DESCRIPTION
  One command per action. The agent invokes this script (via the marina.cmd
  launcher that sits next to it) and never touches env vars, curl, or
  encoding.

  Why PowerShell (not Python): Marina targets Windows users, and PowerShell
  ships with every Windows install -- so this skill needs NO extra runtime.
  A Python skill would silently break on machines without Python. The
  marina.cmd launcher just calls `powershell -ExecutionPolicy Bypass -File
  marina.ps1` (bypassing the default policy + letting the agent type `marina`
  instead of the full powershell incantation).

  Env vars (injected by Marina per session, read here automatically):
    MARINA_SERVICE   HTTP base URL of the file-panel service (REQUIRED)
    MARINA_TOKEN     Bearer token (auth)
    TERMINAL_ID      active terminal session id

  Exit codes (agents branch on these):
    0 success
    1 Marina offline / not in a Marina terminal / panel disabled
    2 usage error
    3 Marina online but rejected (file missing, ...)

  ASCII-only (ENC-1): cmd.exe / PS 5.1 on a Chinese-locale machine reads
  .ps1 with the system code page when no BOM is present; a non-ASCII byte
  here can mis-decode and break the parser. Same rule as src/shell-hooks.
  No BOM. English only. Guarded by shipped-scripts-ascii.test.ts.

  NO STDIN MODE (design decision):
    An earlier version read generated content from stdin and staged it under
    MARINA_WORKSPACE. That stdin path is NOT reliable on Windows PowerShell 5.1:
    when an AI pipes content (`cat report.md | marina.cmd show`), the PS 5.1
    parent pipeline re-encodes the bytes to the console output code page
    (CP936/GBK on zh-CN) BEFORE they reach powershell.exe. Setting
    [Console]::InputEncoding = UTF8 inside this child cannot undo that --
    the bytes are already corrupted upstream. A real chain produced
    "# ???? ???" from Chinese input.
    The reliable interface is path-based: the AI writes the artifact with
    its own file-writing tool (UTF-8, no shell pipeline involved) and calls
    `marina show <path>`. Marina's main process then reads the file via
    Node fs as UTF-8 (buf.toString('utf8')). The agent's file-writing tool
    writes UTF-8 without a BOM, so no BOM handling is needed on either side;
    fully bypassing the PS pipeline.
    This removes the --as option and the stdin-staging mode, and with them
    the traversal / write-before-failure risks of the old mode.

    MARINA_WORKSPACE is NOT deprecated: it is the per-session scratch
    directory Marina injects into the child process env, and the RECOMMENDED
    place for the AI to write throwaway display-only artifacts before calling
    `marina show <path>` (see SKILL.md). This script itself never reads
    MARINA_WORKSPACE -- the agent writes files into it with its own tool, then
    hands the resulting path to `show`. The stdin pipeline problem above is
    specifically about piping bytes through a shell pipe; writing a file with
    a proper file-writing tool and then passing the PATH is unaffected and is
    exactly the supported usage. (Marina's main process creates and reclaims
    this directory per session; see src/main/session-workspace-manager.ts.)

  Corresponding Marina code:
    src/main/file-panel-service.ts  routes: GET /health (auth-free, returns
        the exact marker {ok:true, marina:true}), GET /opening-files,
        POST /open-file | /close-file
    src/skills/show-in-marina/marina.cmd  the launcher that calls this file
#>

# Args are parsed manually from $args below, NOT via a param() block.
# Reason: PowerShell's parameter binder treats `--help`-style tokens as
# parameter names and silently drops them, so Position=0 binding leaves
# $Command empty and `marina --help` misfires as "missing command". Reading
# $args directly is robust against any --foo token.

# Force UTF-8 on stdout/stderr. PowerShell 5.1 defaults the console output
# encoding to the system ANSI code page (CP936/GBK on zh-CN); non-ASCII
# paths in messages and `list --json` output would otherwise mangle.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$script:EXIT_OK = 0
$script:EXIT_OFFLINE = 1
$script:EXIT_USAGE = 2
$script:EXIT_REJECTED = 3

function Get-MarinaConfig {
  # Read the three Marina env vars. Empty string = not injected. We never
  # guess or fall back to anything -- strict on env (user requirement):
  # no port scan, no address retry, exactly MARINA_SERVICE.
  [pscustomobject]@{
    Service  = ($(if ($null -ne $env:MARINA_SERVICE) { $env:MARINA_SERVICE } else { '' })).Trim()
    Token    = ($(if ($null -ne $env:MARINA_TOKEN) { $env:MARINA_TOKEN } else { '' })).Trim()
    Terminal = ($(if ($null -ne $env:TERMINAL_ID) { $env:TERMINAL_ID } else { '' })).Trim()
  }
}

function Die([int]$Code, [string]$Message) {
  [Console]::Error.WriteLine("marina: $Message")
  exit $Code
}

function Resolve-AbsPath([string]$P) {
  # Get an absolute path WITHOUT requiring the file to exist (Resolve-Path
  # throws on missing paths; we want to resolve then Test-Path ourselves).
  $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($P)
}

function Send-MarinaRequest {
  # Single HTTP call to the file-panel service. Exits with the right code
  # on any error (offline / rejected). Returns the parsed JSON body on
  # success. UTF-8 encodes the JSON body so non-ASCII paths survive (the
  # curl GBK double-encode bug, ENC-1, killed at the source).
  param($Config, [string]$Method, [string]$Path, $Body, [int]$Timeout = 5)
  if (-not $Config.Service) {
    Die $script:EXIT_OFFLINE 'MARINA_SERVICE is unset (not in a Marina terminal, or file panel is disabled in settings)'
  }
  if (-not $Config.Token) {
    Die $script:EXIT_OFFLINE 'MARINA_TOKEN is unset'
  }
  $url = $Config.Service.TrimEnd('/') + $Path
  $headers = @{ Authorization = "Bearer $($Config.Token)" }
  $params = @{ Uri = $url; Method = $Method; TimeoutSec = $Timeout; Headers = $headers; ErrorAction = 'Stop' }
  if ($null -ne $Body) {
    $json = $Body | ConvertTo-Json -Compress -Depth 10
    $params['Body'] = [System.Text.Encoding]::UTF8.GetBytes($json)
    $params['ContentType'] = 'application/json'
  }
  try {
    return (Invoke-RestMethod @params)
  } catch {
    $resp = $_.Exception.Response
    if ($null -eq $resp) {
      # No HTTP response at all => connection refused / timeout / DNS. The
      # service is not reachable.
      Die $script:EXIT_OFFLINE "cannot reach $($url): $($_.Exception.Message)"
    }
    $code = [int]$resp.StatusCode
    if ($code -eq 401) {
      # Token rejected -- the agent cannot use Marina. Treat as offline.
      Die $script:EXIT_OFFLINE 'Marina returned 401 (token rejected)'
    }
    # Other 4xx/5xx: Marina answered but refused. Surface its error body.
    $bodyText = ''
    try {
      $stream = $resp.GetResponseStream()
      $reader = New-Object System.IO.StreamReader($stream)
      $bodyText = $reader.ReadToEnd()
      # Try to pull the "error" field out of a JSON body for a clean message.
      $parsed = $bodyText | ConvertFrom-Json -ErrorAction SilentlyContinue
      if ($parsed -and $parsed.error) { $bodyText = [string]$parsed.error }
    } catch {}
    Die $script:EXIT_REJECTED "Marina rejected (HTTP $code): $bodyText"
  }
}

function Invoke-MarinaProbe {
  # For `marina ping`. Returns @{ reachable; detail }.
  #
  # reachable=True ONLY when GET /health returns HTTP 200 with the exact
  # Marina marker {"ok":true,"marina":true}. We do NOT treat an arbitrary
  # HTTP response (e.g. an unrelated service returning 500, or an old Marina
  # build without /health returning 404) as "online": the agent would then
  # try to show files into a service that is not Marina. Connection-level
  # failure (refused / timeout / DNS) and any non-marking response both map
  # to reachable=False. The marker is matched as strict [bool] to reject
  # look-alikes such as {"ok":"true","marina":"true"} (string) that would
  # pass a loose truthiness check.
  param($Config)
  if (-not $Config.Service) { return @{ reachable = $false; detail = 'MARINA_SERVICE unset' } }
  $url = $Config.Service.TrimEnd('/') + '/health'
  try {
    $resp = Invoke-RestMethod -Uri $url -Method GET -TimeoutSec 2 -ErrorAction Stop
  } catch {
    return @{ reachable = $false; detail = "cannot reach $($url): $($_.Exception.Message)" }
  }
  if ($null -eq $resp) { return @{ reachable = $false; detail = '/health returned empty body' } }
  $okBool = ($resp.PSObject.Properties.Name -contains 'ok') -and ($resp.ok -is [bool]) -and $resp.ok
  $marBool = ($resp.PSObject.Properties.Name -contains 'marina') -and ($resp.marina -is [bool]) -and $resp.marina
  if ($okBool -and $marBool) { return @{ reachable = $true; detail = 'online' } }
  return @{ reachable = $false; detail = '/health did not return the Marina marker {ok:true, marina:true}' }
}

function Invoke-CmdPing {
  param($Config)
  if (-not $Config.Service) {
    [Console]::Error.WriteLine('marina: offline (not in a Marina terminal, or file panel disabled)')
    return $script:EXIT_OFFLINE
  }
  $r = Invoke-MarinaProbe -Config $Config
  if ($r.reachable) {
    [Console]::Out.WriteLine('marina: online')
    return $script:EXIT_OK
  }
  [Console]::Error.WriteLine("marina: offline ($($r.detail))")
  return $script:EXIT_OFFLINE
}

# Reject any unrecognized --foo / -x token instead of silently swallowing it.
# An agent that typo'd `--quie` would otherwise think the command succeeded.
function Assert-NoUnknownOptions([string[]]$CmdArgs, [string[]]$Allowed, [string]$CmdName) {
  foreach ($a in $CmdArgs) {
    $s = [string]$a
    if ($s.StartsWith('--') -or ($s.StartsWith('-') -and $s.Length -gt 1 -and $s -notmatch '^-\d+$')) {
      if ($Allowed -notcontains $s) {
        Die $script:EXIT_USAGE "${CmdName}: unknown option: $s"
      }
    }
  }
}

function Invoke-CmdShow {
  <#
    Path mode only. The agent must pass an existing file path -- there is no
    stdin/staging mode (see file header for why). Quiet mode suppresses the
    success line. Any other --foo is a usage error, not a silent ignore.
  #>
  param($Config, [string[]]$CmdArgs)
  Assert-NoUnknownOptions -CmdArgs $CmdArgs -Allowed @('--quiet', '-q') -CmdName 'show'
  $quiet = $false; $path = $null
  $i = 0
  while ($i -lt $CmdArgs.Count) {
    $a = [string]$CmdArgs[$i]
    if ($a -eq '--quiet' -or $a -eq '-q') { $quiet = $true; $i++ }
    else { $path = $a; $i++ }
  }
  if (-not $path) {
    Die $script:EXIT_USAGE 'show: requires a PATH (no stdin mode -- write the file, then `marina show <path>`)'
  }
  $p = Resolve-AbsPath -P $path
  if (-not (Test-Path -LiteralPath $p -PathType Leaf)) {
    Die $script:EXIT_REJECTED "not a file: $p"
  }
  if (-not $Config.Terminal) { Die $script:EXIT_OFFLINE 'TERMINAL_ID is unset' }
  Send-MarinaRequest -Config $Config -Method 'POST' -Path '/open-file' -Body @{ terminal = $Config.Terminal; path = $p } | Out-Null
  if (-not $quiet) { [Console]::Out.WriteLine("shown: $p") }
  return $script:EXIT_OK
}

function Invoke-CmdClose {
  param($Config, [string[]]$CmdArgs)
  Assert-NoUnknownOptions -CmdArgs $CmdArgs -Allowed @('--quiet', '-q') -CmdName 'close'
  $quiet = $false; $path = $null
  $i = 0
  while ($i -lt $CmdArgs.Count) {
    $a = [string]$CmdArgs[$i]
    if ($a -eq '--quiet' -or $a -eq '-q') { $quiet = $true; $i++ }
    else { $path = $a; $i++ }
  }
  if (-not $path) { Die $script:EXIT_USAGE 'close: requires a PATH' }
  if (-not $Config.Terminal) { Die $script:EXIT_OFFLINE 'TERMINAL_ID is unset' }
  $p = Resolve-AbsPath -P $path
  Send-MarinaRequest -Config $Config -Method 'POST' -Path '/close-file' -Body @{ terminal = $Config.Terminal; path = $p } | Out-Null
  if (-not $quiet) { [Console]::Out.WriteLine("closed: $p") }
  return $script:EXIT_OK
}

function Invoke-CmdList {
  param($Config, [string[]]$CmdArgs)
  Assert-NoUnknownOptions -CmdArgs $CmdArgs -Allowed @('--json') -CmdName 'list'
  $asJson = $false
  foreach ($a in $CmdArgs) { if ([string]$a -eq '--json') { $asJson = $true } }
  if (-not $Config.Terminal) { Die $script:EXIT_OFFLINE 'TERMINAL_ID is unset' }
  $qs = '?terminal=' + [uri]::EscapeDataString($Config.Terminal)
  $data = Send-MarinaRequest -Config $Config -Method 'GET' -Path ('/opening-files' + $qs)
  if ($asJson) {
    [Console]::Out.WriteLine(($data | ConvertTo-Json -Depth 10))
    return $script:EXIT_OK
  }
  $files = $data.files
  if (-not $files -or $files.Count -eq 0) {
    [Console]::Out.WriteLine('(no files open in this terminal)')
    return $script:EXIT_OK
  }
  $active = $data.activePath
  foreach ($f in $files) {
    $mark = if ([string]$f.path -eq [string]$active) { '*' } else { ' ' }
    $kind = if ($f.kind) { "($($f.kind))" } else { '' }
    [Console]::Out.WriteLine("$mark $($f.path)  $kind")
  }
  return $script:EXIT_OK
}

function Print-Usage {
  [Console]::Out.WriteLine(@'
usage: marina [-h] {ping,show,close,list} ...

Drive Marina's side file panel from inside a Marina terminal. Env vars
(MARINA_SERVICE/TOKEN/TERMINAL_ID) are read automatically; do not pass them.

commands:
  ping              check whether Marina is reachable (exit 0/1)
  show <PATH>       open an existing file in the panel
                    -q, --quiet suppress success output
  close <PATH>      close a file in the panel
  list              list files open in this terminal's panel
                    --json      raw JSON output

There is no stdin mode. Write the artifact to a file first (with your
file-writing tool, UTF-8; the recommended location is $MARINA_WORKSPACE),
then `marina show <PATH>`. The PS 5.1 pipeline corrupts non-ASCII bytes
piped through stdin before this script sees them.
'@)
}

# -- dispatch ------------------------------------------------------------
$Command = if ($args.Count -gt 0) { [string]$args[0] } else { '' }
$Rest = if ($args.Count -gt 1) { $args[1..($args.Count - 1)] } else { @() }
$cfg = Get-MarinaConfig

if (-not $Command) { Die $script:EXIT_USAGE 'missing command. Run: marina --help' }
if ($Command -in @('-h', '--help', 'help')) { Print-Usage; exit $script:EXIT_OK }

switch ($Command) {
  'ping' { exit (Invoke-CmdPing -Config $cfg) }
  'show' { exit (Invoke-CmdShow -Config $cfg -CmdArgs $Rest) }
  'close' { exit (Invoke-CmdClose -Config $cfg -CmdArgs $Rest) }
  'list' { exit (Invoke-CmdList -Config $cfg -CmdArgs $Rest) }
  default { Die $script:EXIT_USAGE "unknown command: $Command" }
}
