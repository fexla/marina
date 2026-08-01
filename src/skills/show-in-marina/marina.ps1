<#
.SYNOPSIS
  marina.ps1 -- CLI for AI agents running inside a Marina terminal to drive
  Marina's side file panel (show / close / list files, workspace path, probe).

.DESCRIPTION
  One command per action. The agent invokes this script (via the marina.cmd
  launcher that sits next to it) and never reads service/token vars directly,
  calls curl, or handles encoding. The workspace command safely returns the
  current session's MARINA_WORKSPACE as an absolute path.

  Why PowerShell (not Python): Marina targets Windows users, and PowerShell
  ships with every Windows install -- so this skill needs NO extra runtime.
  A Python skill would silently break on machines without Python. The
  marina.cmd launcher just calls `powershell -ExecutionPolicy Bypass -File
  marina.ps1` (bypassing the default policy + letting the agent type `marina`
  instead of the full powershell incantation).

  Env vars (injected by Marina per session, read here automatically):
    MARINA_SERVICE     HTTP base URL of the file-panel service (REQUIRED)
    MARINA_TOKEN       Bearer token (auth)
    TERMINAL_ID        active terminal session id
    MARINA_WORKSPACE   per-session managed scratch directory

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
    place for throwaway display-only artifacts before `marina show <path>`.
    Use `marina workspace` to obtain its concrete absolute path before calling
    a non-shell write/edit tool. Such tools do NOT expand `$MARINA_WORKSPACE`
    or `$env:MARINA_WORKSPACE`; passing either symbol as a path creates a
    literal directory with that name. The stdin pipeline problem above is
    specifically about piping bytes through a shell pipe. Writing a file with
    a proper file tool to the resolved absolute workspace path is supported.
    Marina creates and reclaims this directory per session.

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
    Service   = ($(if ($null -ne $env:MARINA_SERVICE) { $env:MARINA_SERVICE } else { '' })).Trim()
    Token     = ($(if ($null -ne $env:MARINA_TOKEN) { $env:MARINA_TOKEN } else { '' })).Trim()
    Terminal  = ($(if ($null -ne $env:TERMINAL_ID) { $env:TERMINAL_ID } else { '' })).Trim()
    Workspace = ($(if ($null -ne $env:MARINA_WORKSPACE) { $env:MARINA_WORKSPACE } else { '' })).Trim()
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

function Invoke-CmdWorkspace {
  # Print the concrete absolute workspace path. This command intentionally
  # does not require MARINA_SERVICE/TOKEN: the directory is a local env
  # capability created before the PTY starts. Non-shell write tools must use
  # this concrete path because they never expand shell variable syntax.
  param($Config, [string[]]$CmdArgs)
  if ($CmdArgs.Count -gt 0) {
    Die $script:EXIT_USAGE 'workspace: does not accept arguments'
  }
  if (-not $Config.Workspace) {
    Die $script:EXIT_OFFLINE 'MARINA_WORKSPACE is unset (not in a Marina terminal, or this session predates managed workspaces)'
  }
  $p = Resolve-AbsPath -P $Config.Workspace
  if (-not (Test-Path -LiteralPath $p -PathType Container)) {
    Die $script:EXIT_REJECTED "MARINA_WORKSPACE is not an existing directory: $p"
  }
  [Console]::Out.WriteLine($p)
  return $script:EXIT_OK
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

<#
  close has four forms:
    close --all                 close every file in this terminal's panel
    close --stale              close only zombie tabs (file deleted on disk,
                                i.e. missing == true)
    close --glob <PATTERN>     close files whose basename matches a glob
                                (PATTERN supports * and ?)
    close <PATH>               single close via /close-file. The server first
                                tries an exact path match, then falls back to a
                                basename match (so passing just the file name
                                works too).

  A PATH argument containing `*` or `?` is automatically treated as --glob, so
  the intuitive `close *.md` works. --quiet applies to all forms.
#>
function Invoke-CmdClose {
  param($Config, [string[]]$CmdArgs)
  Assert-NoUnknownOptions -CmdArgs $CmdArgs -Allowed @('--quiet', '-q', '--all', '--stale', '--glob') -CmdName 'close'
  $quiet = $false; $all = $false; $stale = $false; $glob = $false
  $globPattern = $null; $path = $null
  $i = 0
  while ($i -lt $CmdArgs.Count) {
    $a = [string]$CmdArgs[$i]
    switch -CaseSensitive ($a) {
      '--quiet' { $quiet = $true; $i++ }
      '-q' { $quiet = $true; $i++ }
      '--all' { $all = $true; $i++ }
      '--stale' { $stale = $true; $i++ }
      '--glob' { $glob = $true; $i++; if ($i -lt $CmdArgs.Count) { $globPattern = [string]$CmdArgs[$i]; $i++ } }
      default { $path = $a; $i++ }
    }
  }

  if (-not $Config.Terminal) { Die $script:EXIT_OFFLINE 'TERMINAL_ID is unset' }

  # Mutual-exclusion: the batch flags are exclusive with each other and with
  # a PATH (--all/--stale/--glob take no PATH).
  $batchFlags = @($all, $stale, $glob) | Where-Object { $_ }
  if ($batchFlags.Count -gt 1) {
    Die $script:EXIT_USAGE 'close: --all / --stale / --glob are mutually exclusive'
  }
  if ($batchFlags.Count -eq 1 -and $path) {
    Die $script:EXIT_USAGE 'close: --all / --stale / --glob do not take a PATH'
  }
  if ($glob -and -not $globPattern) {
    Die $script:EXIT_USAGE 'close: --glob requires a PATTERN'
  }
  if (-not $all -and -not $stale -and -not $glob -and -not $path) {
    Die $script:EXIT_USAGE 'close: requires a PATH (or use --all / --stale / --glob)'
  }

  # A PATH with wildcard chars is implicitly --glob, so `close *.md` is not
  # treated as a literal path.
  if ($path -and ($path.Contains('*') -or $path.Contains('?'))) {
    $glob = $true; $globPattern = $path; $path = $null
  }

  if ($all) {
    $resp = Send-MarinaRequest -Config $Config -Method 'POST' -Path '/close-files' -Body @{ terminal = $Config.Terminal; mode = 'all' }
    if (-not $quiet) { Print-CloseResult -Resp $resp -Label 'all' }
    return $script:EXIT_OK
  }
  if ($stale) {
    $resp = Send-MarinaRequest -Config $Config -Method 'POST' -Path '/close-files' -Body @{ terminal = $Config.Terminal; mode = 'stale' }
    if (-not $quiet) { Print-CloseResult -Resp $resp -Label 'stale' }
    return $script:EXIT_OK
  }
  if ($glob) {
    $resp = Send-MarinaRequest -Config $Config -Method 'POST' -Path '/close-files' -Body @{ terminal = $Config.Terminal; mode = 'glob'; pattern = $globPattern }
    if (-not $quiet) { Print-CloseResult -Resp $resp -Label "glob '$globPattern'" }
    return $script:EXIT_OK
  }

  # Single path via /close-file. The server does exact-path then basename
  # fallback. We do NOT Test-Path here: the target may not be in cwd, and may
  # even be deleted on disk while the tab still exists (that's the point).
  $p = Resolve-AbsPath -P $path
  Send-MarinaRequest -Config $Config -Method 'POST' -Path '/close-file' -Body @{ terminal = $Config.Terminal; path = $p } | Out-Null
  if (-not $quiet) { [Console]::Out.WriteLine("closed: $p") }
  return $script:EXIT_OK
}

# Batch-close output: `closed N file(s)` plus the path list. When closed is 0 we
# print a note (e.g. `close --stale` with no zombies should not look like it
# silently closed something).
function Print-CloseResult($Resp, [string]$Label) {
  $closed = $Resp.closed
  $n = if ($closed) { @($closed).Count } else { 0 }
  if ($n -eq 0) {
    [Console]::Out.WriteLine("closed 0 file(s) [$Label] (nothing matched)")
    return
  }
  [Console]::Out.WriteLine("closed $n file(s) [$Label]:")
  foreach ($c in @($closed)) { [Console]::Out.WriteLine("  $c") }
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
  # missing=true = zombie tab: the file is gone from disk but the tab is kept.
  # Mark it with a leading `!` and (deleted) so it stands out and can be bulk-
  # cleaned via `marina close --stale`. The server already refreshStale'd on the
  # GET /opening-files, so `missing` here reflects the live disk truth.
  $staleCount = 0
  foreach ($f in $files) {
    $isMissing = [bool]$f.missing
    if ($isMissing) { $staleCount++ }
    $mark = if ([string]$f.path -eq [string]$active) { '*' } else { ' ' }
    $staleMark = if ($isMissing) { '!' } else { ' ' }
    $kind = if ($f.kind) { "($($f.kind))" } else { '' }
    $deletedTag = if ($isMissing) { ' (deleted)' } else { '' }
    [Console]::Out.WriteLine("$mark$staleMark $($f.path)  $kind$deletedTag")
  }
  if ($staleCount -gt 0) {
    [Console]::Out.WriteLine("")
    [Console]::Out.WriteLine("$staleCount deleted file(s) above no longer exist on disk. Run: marina close --stale")
  }
  return $script:EXIT_OK
}

function Invoke-CmdScreenshot {
  # v0.3.3 T12(testability enabler): capture this terminal's owner window as a PNG.
  # Used by agents to self-verify UI without a human screenshot. Unlike other commands
  # this returns BINARY (image/png), so it uses Invoke-WebRequest -OutFile directly
  # rather than the JSON Send-MarinaRequest. Default output path = a timestamped
  # file under the managed workspace (so agents can `read` it); explicit PATH overrides.
  param($Config, [string[]]$CmdArgs)
  Assert-NoUnknownOptions -CmdArgs $CmdArgs -Allowed @() -CmdName 'screenshot'
  if (-not $Config.Service) {
    Die $script:EXIT_OFFLINE 'MARINA_SERVICE is unset (not in a Marina terminal, or file panel is disabled in settings)'
  }
  if (-not $Config.Token) { Die $script:EXIT_OFFLINE 'MARINA_TOKEN is unset' }
  if (-not $Config.Terminal) { Die $script:EXIT_OFFLINE 'MARINA_TERMINAL is unset (cannot identify owner window)' }

  # Resolve output path: explicit arg > workspace/<timestamp>.png > temp fallback.
  $outPath = if ($CmdArgs.Count -ge 1 -and $CmdArgs[0]) { Resolve-AbsPath -P ([string]$CmdArgs[0]) } else { $null }
  if (-not $outPath) {
    $ws = if ($Config.Workspace) { Resolve-AbsPath -P $Config.Workspace } else { $null }
    $dir = if ($ws -and (Test-Path -LiteralPath $ws -PathType Container)) { $ws } else { [System.IO.Path]::GetTempPath() }
    $stamp = (Get-Date -Format 'yyyyMMdd-HHmmss')
    $outPath = Join-Path $dir "marina-screenshot-$stamp.png"
  }

  $url = $Config.Service.TrimEnd('/') + '/screenshot?terminal=' + [uri]::EscapeDataString($Config.Terminal)
  try {
    # Binary download: Invoke-WebRequest writes the response body straight to disk.
    Invoke-WebRequest -Uri $url -Method GET -TimeoutSec 10 -Headers @{ Authorization = "Bearer $($Config.Token)" } `
      -OutFile $outPath -ErrorAction Stop | Out-Null
  } catch {
    $resp = $_.Exception.Response
        if ($null -eq $resp) { Die $script:EXIT_OFFLINE "cannot reach $($url): $($_.Exception.Message)" }
    $code = [int]$resp.StatusCode
    $bodyText = ''
    try {
      $stream = $resp.GetResponseStream(); $reader = New-Object System.IO.StreamReader($stream)
      $bodyText = $reader.ReadToEnd()
      $parsed = $bodyText | ConvertFrom-Json -ErrorAction SilentlyContinue
      if ($parsed -and $parsed.error) { $bodyText = [string]$parsed.error }
    } catch {}
    Die $script:EXIT_REJECTED "Marina rejected screenshot (HTTP $code): $bodyText"
  }
  [Console]::Out.WriteLine($outPath)
  return $script:EXIT_OK
}

function Print-Usage {
  [Console]::Out.WriteLine(@'
usage: marina [-h] {ping,workspace,show,close,list,screenshot} ...

Drive Marina's side file panel from inside a Marina terminal. Env vars are
read automatically; do not pass them as CLI options.

commands:
  ping              check whether Marina is reachable (exit 0/1)
  workspace         print this session's managed scratch directory
  show <PATH>       open an existing file in the panel
                    -q, --quiet suppress success output
  close <PATH>      close one file (exact path, or just the file name)
  close --all       close every file in this terminal's panel
  close --stale     close only tabs whose file no longer exists on disk
  close --glob <P>  close files whose name matches a glob (e.g. '*.md')
                    (a PATH containing * or ? is treated as --glob)
                    -q, --quiet suppress success output
  list              list files open in this terminal's panel
                    deleted files are marked with ! and (deleted)
                    --json      raw JSON output (includes `missing`)
  screenshot [PATH] capture this terminal's owner window as a PNG
                    default: <workspace>/marina-screenshot-<timestamp>.png
                    prints the saved path; agents can `read` it to self-test UI

There is no stdin mode. Run `marina workspace` to get the concrete scratch
path, write the artifact there with your file-writing tool (UTF-8), then run
`marina show <PATH>`. Never pass a literal $MARINA_WORKSPACE or
$env:MARINA_WORKSPACE string to a non-shell tool: it will not be expanded.
The PS 5.1 pipeline corrupts non-ASCII bytes piped through stdin.
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
  'workspace' { exit (Invoke-CmdWorkspace -Config $cfg -CmdArgs $Rest) }
  'show' { exit (Invoke-CmdShow -Config $cfg -CmdArgs $Rest) }
  'close' { exit (Invoke-CmdClose -Config $cfg -CmdArgs $Rest) }
  'list' { exit (Invoke-CmdList -Config $cfg -CmdArgs $Rest) }
  'screenshot' { exit (Invoke-CmdScreenshot -Config $cfg -CmdArgs $Rest) }
  default { Die $script:EXIT_USAGE "unknown command: $Command" }
}
