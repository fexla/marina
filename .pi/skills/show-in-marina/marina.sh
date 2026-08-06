#!/usr/bin/env bash
#
# @file marina.sh
# @purpose Native POSIX client (bash + curl) for AI agents running inside a
#   Marina terminal on Linux (and macOS, unofficially) to drive Marina's
#   side file panel: show / close / list files, workspace path, run, probe.
#
# @why this file exists (the Windows-version problem):
#   The bundled show-in-marina skill historically shipped ONLY Windows
#   launchers: marina.ps1 (needs PowerShell), marina.cmd (cmd.exe), and a
#   `marina` bash wrapper that explicitly searched for powershell.exe and
#   exited 127 on non-Windows hosts. On Linux the skill was therefore dead.
#   Marina's file-panel backend (src/main/file-panel-service.ts) is a plain
#   HTTP + Bearer-token service that is completely platform-agnostic, so the
#   only thing missing on Linux was a native client. This file is that
#   client. It is the Linux counterpart of marina.ps1: same HTTP contract,
#   same exit codes, same subcommands, same output strings.
#
# @philosophy (no extra runtime -- same stance as marina.ps1):
#   marina.ps1's header rejects Python because "PowerShell ships with every
#   Windows install, so the skill needs NO extra runtime". The Linux
#   equivalent universally-present toolkit is bash + coreutils, and curl is
#   installed by default on every mainstream desktop Linux distribution
#   (and ships with macOS). We deliberately do NOT require jq, python, or
#   node: JSON parsing is done with small awk/sed extractors tuned to the
#   fixed, known response shapes of file-panel-service.ts (compact,
#   single-line JSON of flat objects). This keeps the skill zero-dependency,
#   exactly like its Windows sibling. If jq happens to be installed it is
#   simply ignored -- one code path, predictable everywhere.
#
# @how it is reached (the dispatcher):
#   The extensionless sibling `marina` is a tiny dispatcher. On a host that
#   has powershell.exe (Windows) it execs the old PowerShell path unchanged;
#   on a host without powershell.exe (Linux) it execs THIS file. So a Linux
#   agent invoking `./marina ping` is transparently routed here. Agents may
#   also call `bash marina.sh` directly (the contract tests do).
#
# @env vars (injected by Marina per session, read here automatically):
#   MARINA_SERVICE     HTTP base URL of the file-panel service (REQUIRED)
#   MARINA_TOKEN       Bearer token (auth)
#   TERMINAL_ID        active terminal session id
#   MARINA_WORKSPACE   per-session managed scratch directory (screenshot default)
#
# @exit codes (agents branch on these -- MUST match marina.ps1 exactly):
#   0 success
#   1 Marina offline / not in a Marina terminal / panel disabled / 401
#   2 usage error (unknown option, missing path/arg, unknown command)
#   3 Marina online but rejected (file missing on disk, 409 conflict, ...)
#
# @ascii-only (ENC-1): matches the sibling marina.cmd / marina.ps1 rule so a
#   non-ASCII byte can never sneak into a shebang/comment on a misconfigured
#   box and break parsing. English only, no BOM, LF line endings. Guarded by
#   shipped-scripts-ascii.test.ts (marina.sh is in LOCALE_SENSITIVE_FILES).
#
# @corresponding:
#   src/skills/show-in-marina/marina.ps1   Windows client -- SAME HTTP contract
#   src/skills/show-in-marina/marina       platform dispatcher (calls this on Linux)
#   src/skills/show-in-marina/marina.cmd   Windows cmd/PowerShell launcher
#   src/main/file-panel-service.ts         the backend (single source of truth)
#   src/main/marina-cli-mock-server.py     contract test fixture
#
# @drift rule: this file and marina.ps1 are two clients of ONE contract
#   (file-panel-service.ts). If you add/rename an HTTP endpoint or change a
#   response shape, you MUST update BOTH clients and the mock server together.

set -u  # treat unset vars as errors -- catches typo'd $MARINA_XXX reads.
# Do NOT enable -e: we manage exit codes ourselves and curl's non-zero
# (connection refused) is a handled branch, not a script-killing failure.

# -- exit codes (mirrors marina.ps1 $script:EXIT_*) ------------------------
EXIT_OK=0
EXIT_OFFLINE=1
EXIT_USAGE=2
EXIT_REJECTED=3

# HTTP timeouts in seconds (mirror marina.ps1: default 5, ping/health 2, screenshot 10).
HTTP_TIMEOUT_DEFAULT=5
HTTP_TIMEOUT_PING=2
HTTP_TIMEOUT_SCREENSHOT=10

# -- config: read Marina env vars, trimmed. Empty string = not injected.
#   We NEVER guess or fall back (no port scan, no address retry): strict on
#   env, exactly MARINA_SERVICE -- same contract as marina.ps1.
read_config() {
  SERVICE="${MARINA_SERVICE-}"
  TOKEN="${MARINA_TOKEN-}"
  TERMINAL="${TERMINAL_ID-}"
  WORKSPACE="${MARINA_WORKSPACE-}"
  # Trim leading/trailing whitespace. ${var//...} needs the var set (set -u),
  # so default to '' first above, then trim.
  SERVICE="${SERVICE#"${SERVICE%%[![:space:]]*}"}"; SERVICE="${SERVICE%"${SERVICE##*[![:space:]]}"}"
  TOKEN="${TOKEN#"${TOKEN%%[![:space:]]*}"}"; TOKEN="${TOKEN%"${TOKEN##*[![:space:]]}"}"
  TERMINAL="${TERMINAL#"${TERMINAL%%[![:space:]]*}"}"; TERMINAL="${TERMINAL%"${TERMINAL##*[![:space:]]}"}"
  WORKSPACE="${WORKSPACE#"${WORKSPACE%%[![:space:]]*}"}"; WORKSPACE="${WORKSPACE%"${WORKSPACE##*[![:space:]]}"}"
}

# Print "marina: <msg>" to stderr and exit with the given code. Mirrors
# marina.ps1 Die: every user-facing failure line is prefixed "marina: ".
die() {
  local code="$1"; shift
  printf 'marina: %s\n' "$*" >&2
  exit "$code"
}

# -- JSON helpers (pure POSIX awk/sed/grep; NO jq, NO python) --------------
# All file-panel-service responses are compact, single-line JSON built from
# flat objects (one optional level: arrays of flat objects). These helpers
# are tuned to that shape -- they are NOT a general JSON parser.

# Escape a string for a JSON string literal (covers the chars that occur in
# paths / commands: " \ and control chars). Non-ASCII UTF-8 bytes pass
# through verbatim, which is valid JSON when the stream is UTF-8 (it is --
# Marina and our bodies are UTF-8). Used to build POST bodies.
json_escape() {
  local s="$1" i=0 ch out=''
  for ((i = 0; i < ${#s}; i++)); do
    ch="${s:i:1}"
    case "$ch" in
      '"') out+='\"' ;;
      '\') out+='\\' ;;
      $'\n') out+='\n' ;;
      $'\r') out+='\r' ;;
      $'\t') out+='\t' ;;
      # Other control chars 0x00-0x1F are absent from our inputs (paths /
      # commands / titles). If one ever appears it is passed through, which
      # is the only correctness risk here -- acceptable for the known inputs.
      *) out+="$ch" ;;
    esac
  done
  printf '%s' "$out"
}

# Extract the value of a top-level (or first-occurrence) key from compact
# JSON. String values are unescaped; non-strings (true/false/null/number)
# are printed raw. Prints empty string if the key is absent. Implemented in
# awk so it has no external dependency beyond awk itself (always present).
# $1 = json text, $2 = key (no quotes).
jget() {
  # NOTE: pipe the json via printf (NOT an unquoted heredoc) so any `$` /
  # backtick inside the JSON is passed literally to awk, never shell-expanded.
  printf '%s' "$1" | awk -v key="$2" '
    function unescape(s,   out, i, n, ch, nx) {
      out = ""; n = length(s); i = 1
      while (i <= n) {
        ch = substr(s, i, 1)
        if (ch == "\\") {
          nx = substr(s, i + 1, 1)
          if (nx == "n") out = out "\n"
          else if (nx == "t") out = out "\t"
          else if (nx == "r") out = out "\r"
          else if (nx == "b") out = out "\b"
          else if (nx == "f") out = out "\f"
          else if (nx == "u") { out = out substr(s, i, 6); i += 6; continue }
          else out = out nx   # \" \\ \/  (and any other escaped char passes through)
          i += 2
        } else { out = out ch; i++ }
      }
      return out
    }
    {
      line = $0
      needle = "\"" key "\""
      i = index(line, needle)
      if (i == 0) { print ""; exit }
      rest = substr(line, i + length(needle))
      c = index(rest, ":")
      if (c == 0) { print ""; exit }
      rest = substr(rest, c + 1)
      # skip spaces between colon and value (our server emits none, but be safe)
      while (substr(rest, 1, 1) == " " || substr(rest, 1, 1) == "\t") rest = substr(rest, 2)
      fc = substr(rest, 1, 1)
      if (fc == "\"") {
        # string value: accumulate until an unescaped closing quote
        val = ""; i = 2; n = length(rest)
        while (i <= n) {
          ch = substr(rest, i, 1)
          if (ch == "\\") { val = val substr(rest, i, 2); i += 2 }
          else if (ch == "\"") { break }
          else { val = val ch; i++ }
        }
        print unescape(val)
      } else {
        # non-string (true / false / null / number): raw up to a delimiter
        val = ""; i = 1; n = length(rest)
        while (i <= n) {
          ch = substr(rest, i, 1)
          if (ch == "," || ch == "}" || ch == "]") break
          val = val ch; i++
        }
        print val
      }
    }
  '
}

# Print each flat object {...} (one with NO nested braces) found INSIDE the
# JSON array value at $2=key, one per line. Used to iterate the `files` array
# in /opening-files and the `items` array in /workspace/list. We slice the
# specific array first (from `"key":[` to its closing `]`) so that an EMPTY
# array yields zero objects -- a bare flat_objects() over the whole body would
# wrongly match the outer wrapper {...} when the array is empty. Flat objects
# contain no [ ] themselves, so the first `]` after `"key":[` is the array's
# closing bracket.
array_objects() {
  # Whitespace-tolerant: the real Node service emits compact JSON
  # ("key":[...]), but the Python mock and some clients emit spaced JSON
  # ("key": [...]). We locate "key", skip any spaces, expect ':', skip
  # spaces, expect '[', then read to the matching ']'. Flat objects contain
  # no '[' / ']' of their own, so the first ']' closes the array.
  local sliced
  sliced=$(printf '%s' "$1" | awk -v key="$2" '{
    line = $0
    needle = "\"" key "\""
    i = index(line, needle)
    if (i == 0) { exit }
    rest = substr(line, i + length(needle))
    # skip whitespace
    while (substr(rest, 1, 1) == " " || substr(rest, 1, 1) == "\t") rest = substr(rest, 2)
    if (substr(rest, 1, 1) != ":") { exit }
    rest = substr(rest, 2)
    while (substr(rest, 1, 1) == " " || substr(rest, 1, 1) == "\t") rest = substr(rest, 2)
    if (substr(rest, 1, 1) != "[") { exit }
    rest = substr(rest, 2)
    n = length(rest); out = ""; j = 1
    while (j <= n) {
      ch = substr(rest, j, 1)
      if (ch == "]") break
      out = out ch; j++
    }
    print out
  }')
  [ -n "$sliced" ] && printf '%s' "$sliced" | grep -o '{[^{}]*}'
}

# Print each quoted-string element of the array value at $2=key. Used for the
# `closed` array in /close-files responses (a list of path strings). Strings
# are printed with simple backslash unescaping.
str_array() {
  # Whitespace-tolerant array-of-strings extractor (see array_objects).
  printf '%s' "$1" | awk -v key="$2" '
    function unescape(s,   out, i, n, ch, nx) {
      out = ""; n = length(s); i = 1
      while (i <= n) {
        ch = substr(s, i, 1)
        if (ch == "\\") { nx = substr(s, i + 1, 1); out = out nx; i += 2 }
        else { out = out ch; i++ }
      }
      return out
    }
    {
      line = $0
      needle = "\"" key "\""
      i = index(line, needle)
      if (i == 0) exit
      rest = substr(line, i + length(needle))
      while (substr(rest, 1, 1) == " " || substr(rest, 1, 1) == "\t") rest = substr(rest, 2)
      if (substr(rest, 1, 1) != ":") exit
      rest = substr(rest, 2)
      while (substr(rest, 1, 1) == " " || substr(rest, 1, 1) == "\t") rest = substr(rest, 2)
      if (substr(rest, 1, 1) != "[") exit
      rest = substr(rest, 2)
      n = length(rest); j = 1
      while (j <= n) {
        ch = substr(rest, j, 1)
        if (ch == "]") break
        if (ch == "\"") {
          val = ""; j++
          while (j <= n) {
            c = substr(rest, j, 1)
            if (c == "\\") { val = val substr(rest, j, 2); j += 2 }
            else if (c == "\"") { break }
            else { val = val c; j++ }
          }
          print unescape(val)
        }
        j++
      }
    }
  '
}

# URL-encode a query-string value (for ?terminal=<enc>). Terminal ids are
# normally ASCII-safe (hex), but we encode correctly so a future id shape or
# an unusual char cannot break the URL. Mirrors PowerShell [uri]::EscapeDataString.
urlencode() {
  local s="$1" i=0 ch ord out=''
  for ((i = 0; i < ${#s}; i++)); do
    ch="${s:i:1}"
    case "$ch" in
      [A-Za-z0-9.~_-]) out+="$ch" ;;
      *)
        # %XX per byte. LANG-independent: ord via printf of the char's code point.
        ord=$(LC_CTYPE=C printf '%02X' "'$ch")
        out+="%${ord}"
        ;;
    esac
  done
  printf '%s' "$out"
}

# Format an epoch-millisecond timestamp (the server sends createdAt in ms)
# as local time "YYYY-MM-DD HH:MM", matching marina.ps1's
# [datetimeoffset]::FromUnixTimeMilliseconds(...).LocalTime format. Uses GNU
# date (`date -d @<seconds>`), available on Linux + macOS coreutils. If date
# cannot parse it (non-GNU / out of range) we print empty -- mirroring ps1's
# try/catch that degrades to an empty string rather than crashing.
format_epoch_ms() {
  local ms="$1"
  [ -n "$ms" ] || { printf ''; return; }
  case "$ms" in
    ''|*[!0-9]*) printf ''; return ;;  # non-numeric guard
  esac
  local sec=$(( ms / 1000 ))
  date -d "@${sec}" '+%Y-%m-%d %H:%M' 2>/dev/null || printf ''
}

# -- HTTP core -------------------------------------------------------------
# do_http: perform ONE Bearer-authenticated JSON request. On a connection-
# level failure (refused / timeout / DNS) exit OFFLINE; on 401 exit OFFLINE;
# on other 4xx/5xx exit REJECTED with the server's error body. On 2xx set
# globals HTTP_BODY / HTTP_CODE and return. $1=method $2=path $3=body(opt)
# $4=timeout(opt, default HTTP_TIMEOUT_DEFAULT).
do_http() {
  local method="$1" path="$2" body="${3-}" timeout="${4:-$HTTP_TIMEOUT_DEFAULT}"
  if [ -z "$SERVICE" ]; then
    die "$EXIT_OFFLINE" 'MARINA_SERVICE is unset (not in a Marina terminal, or file panel is disabled in settings)'
  fi
  if [ -z "$TOKEN" ]; then
    die "$EXIT_OFFLINE" 'MARINA_TOKEN is unset'
  fi
  local url="${SERVICE%/}${path}"
  # Capture the response body AND the HTTP code from a SINGLE curl call via
  # stdout, with a unique delimiter appended by -w. We deliberately avoid an
  # -o temp file: on a Windows Git Bash host, bash and the native curl binary
  # disagree on what `/tmp` means (bash -> AppData, curl -> C:\tmp), so the
  # body file would silently never be read. JSON bodies are single-line text
  # and cannot contain the delimiter, so splitting is unambiguous and portable.
  local delim=$'\n__MARINA_HTTP_CODE__'
  local resp curl_rc
  if [ -n "$body" ]; then
    resp=$(curl -sS -m "$timeout" -X "$method" \
        -H "Authorization: Bearer ${TOKEN}" \
        -H 'Content-Type: application/json' \
        -d "$body" \
        -w "$delim%{http_code}" "$url" 2>/dev/null); curl_rc=$?
  else
    resp=$(curl -sS -m "$timeout" -X "$method" \
        -H "Authorization: Bearer ${TOKEN}" \
        -w "$delim%{http_code}" "$url" 2>/dev/null); curl_rc=$?
  fi
  # curl non-zero => no HTTP response at all (refused / timeout / DNS).
  if [ "$curl_rc" -ne 0 ]; then
    die "$EXIT_OFFLINE" "cannot reach ${url}: curl exit ${curl_rc} (connection refused / timeout / DNS)"
  fi
  HTTP_BODY="${resp%%"$delim"*}"
  HTTP_CODE="${resp#*"$delim"}"
  if [ "$HTTP_CODE" = "401" ]; then
    die "$EXIT_OFFLINE" 'Marina returned 401 (token rejected)'
  fi
  # 2xx => success (return body via HTTP_BODY). Anything else 4xx/5xx rejected.
  case "$HTTP_CODE" in
    2*) return 0 ;;
    *)
      # Try to surface the server's "error" field for a clean message; fall
      # back to the raw body. Mirrors marina.ps1's ConvertFrom-Json .error path.
      local err
      err=$(jget "$HTTP_BODY" error 2>/dev/null)
      [ -n "$err" ] || err="$HTTP_BODY"
      die "$EXIT_REJECTED" "Marina rejected (HTTP ${HTTP_CODE}): ${err}"
      ;;
  esac
}

# Resolve a possibly-relative path to an absolute one WITHOUT requiring it to
# exist (mirrors marina.ps1 Resolve-AbsPath). Used by show/close so the
# server always receives an absolute path regardless of the agent's cwd.
resolve_abs() {
  local p="$1"
  case "$p" in
    '') printf '%s' '' ;;
    /*) printf '%s' "$p" ;;                 # already absolute (POSIX)
    *)  printf '%s/%s' "$PWD" "$p" ;;       # relative -> cwd-prefixed
  esac
}

# -- option rejection (mirrors marina.ps1 Assert-NoUnknownOptions) ---------
# Reject any unrecognized --foo / -x token instead of silently swallowing it
# (an agent that typo'd `--quie` would otherwise think it succeeded). A token
# is "option-like" if it starts with `--`, OR starts with `-` and is longer
# than one char and is NOT a negative number like `-3`. Allowed tokens are
# passed as the remaining args. $1=command label for the error message.
reject_unknown_options() {
  local label="$1"; shift
  local allowed=("$@")
  local a
  for a in "${ARGS[@]:-}"; do
    [ -n "$a" ] || continue
    local optlike=0
    if [ "${a:0:2}" = "--" ]; then
      optlike=1
    elif [ "${a:0:1}" = "-" ] && [ "${#a}" -gt 1 ] && ! printf '%s' "$a" | grep -qE '^-[0-9]+$'; then
      optlike=1
    fi
    if [ "$optlike" = "1" ]; then
      local ok=0 al
      for al in "${allowed[@]}"; do [ "$a" = "$al" ] && { ok=1; break; }; done
      [ "$ok" = "1" ] || die "$EXIT_USAGE" "${label}: unknown option: ${a}"
    fi
  done
}

# -- commands --------------------------------------------------------------

cmd_ping() {
  # ping does its OWN /health probe (no auth, 2s timeout) rather than going
  # through do_http, and requires ONLY MARINA_SERVICE (token/terminal NOT
  # needed -- a probe). Strict marker match: reachable only when /health
  # returns 200 with the exact {"ok":true,"marina":true} (both bool). We
  # match `"ok":<ws>true` / `"marina":<ws>true` (optional whitespace, to
  # accept BOTH the real Node service's compact output and the Python mock's
  # spaced output); requiring the bare token `true` (no quotes) rejects the
  # string look-alike {"ok":"true"}. Connection failure and any non-marking
  # response both map to offline.
  if [ -z "$SERVICE" ]; then
    printf 'marina: offline (not in a Marina terminal, or file panel disabled)\n' >&2
    return "$EXIT_OFFLINE"
  fi
  local url="${SERVICE%/}/health"
  # Capture body + code from stdout (no temp file: see do_http for the
  # Git Bash `/tmp`-mismatch rationale).
  local delim=$'\n__MARINA_HTTP_CODE__'
  local resp curl_rc
  resp=$(curl -sS -m "$HTTP_TIMEOUT_PING" -w "$delim%{http_code}" "$url" 2>/dev/null); curl_rc=$?
  local body="${resp%%"$delim"*}"
  local code="${resp#*"$delim"}"
  if [ "$curl_rc" -ne 0 ] || [ -z "$code" ] || [ "$code" = "000" ]; then
    printf 'marina: offline (cannot reach %s)\n' "$url" >&2
    return "$EXIT_OFFLINE"
  fi
  if [ "$code" = "200" ] \
     && printf '%s' "$body" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true([,}[:space:]])' \
     && printf '%s' "$body" | grep -Eq '"marina"[[:space:]]*:[[:space:]]*true([,}[:space:]])'; then
    printf 'marina: online\n'
    return "$EXIT_OK"
  fi
  local detail
  if [ -z "$body" ]; then detail='/health returned empty body'; else detail='/health did not return the Marina marker {ok:true, marina:true}'; fi
  printf 'marina: offline (%s)\n' "$detail" >&2
  return "$EXIT_OFFLINE"
}

cmd_workspace() {
  # v0.3.3 ADR-024: workspaceId is decoupled from sessionId, so
  # $MARINA_WORKSPACE is the STALE spawn-time value -- always query main.
  # All subcommands require SERVICE + TOKEN + TERMINAL (no $env fallback).
  local sub="${ARGS[0]-}"
  # shift ARGS[0] off into subArgs for the sub-handlers
  local subArgs=()
  if [ "${#ARGS[@]}" -gt 1 ]; then
    subArgs=("${ARGS[@]:1}")
  fi

  if [ -z "$SERVICE" ]; then die "$EXIT_OFFLINE" 'MARINA_SERVICE is unset (not in a Marina terminal, or file panel is disabled in settings)'; fi
  if [ -z "$TOKEN" ]; then die "$EXIT_OFFLINE" 'MARINA_TOKEN is unset'; fi
  if [ -z "$TERMINAL" ]; then die "$EXIT_OFFLINE" 'TERMINAL_ID is unset'; fi

  local term_enc; term_enc=$(urlencode "$TERMINAL")
  case "$sub" in
    '')
      do_http GET "/workspace?terminal=${term_enc}"
      local p; p=$(jget "$HTTP_BODY" path)
      [ -n "$p" ] || die "$EXIT_REJECTED" 'session has no bound workspace'
      printf '%s\n' "$p"
      return "$EXIT_OK"
      ;;
    list)
      ARGS=("${subArgs[@]}"); reject_unknown_options 'workspace list' '--json'
      do_http GET "/workspace/list?terminal=${term_enc}"
      local json_flag=0 a
      for a in "${subArgs[@]:-}"; do [ "$a" = "--json" ] && json_flag=1; done
      if [ "$json_flag" = "1" ]; then
        # Raw passthrough of the server body. (marina.ps1 re-emits only the
        # items array; we pass the full body, which is richer and equally
        # machine-parseable. Documented difference.)
        printf '%s\n' "$HTTP_BODY"
        return "$EXIT_OK"
      fi
      local count; count=$(printf '%s\n' "$HTTP_BODY" | grep -o '{[^{}]*}' | wc -l | tr -d ' ')
      if [ "${count:-0}" = "0" ]; then
        printf '(no named workspaces under the current path scope)\n'
        return "$EXIT_OK"
      fi
      local obj name fc ca pinned pin_tag dt
      while IFS= read -r obj; do
        [ -n "$obj" ] || continue
        name=$(jget "$obj" name); [ -n "$name" ] || name='(unnamed)'
        fc=$(jget "$obj" fileCount); [ -n "$fc" ] || fc='0'
        ca=$(jget "$obj" createdAt)
        pinned=$(jget "$obj" pinned)
        pin_tag=''; [ "$pinned" = "true" ] && pin_tag=' [pinned]'
        dt=$(format_epoch_ms "$ca")
        printf '%s  %s files  %s%s\n' "$name" "$fc" "$dt" "$pin_tag"
      done <<<"$(array_objects "$HTTP_BODY" items)"
      return "$EXIT_OK"
      ;;
    bind)
      ARGS=("${subArgs[@]}"); reject_unknown_options 'workspace bind' '--name' '--new'
      local name='' force_new=0 i a
      i=0
      while [ "$i" -lt "${#subArgs[@]}" ]; do
        a="${subArgs[$i]}"
        case "$a" in
          --name) i=$((i+1)); [ "$i" -lt "${#subArgs[@]}" ] || die "$EXIT_USAGE" 'workspace bind: --name requires a value'; name="${subArgs[$i]}" ;;
          --new) force_new=1 ;;
        esac
        i=$((i+1))
      done
      [ -n "$name" ] || die "$EXIT_USAGE" 'workspace bind: --name X is required'
      local body="{\"terminal\":\"$(json_escape "$TERMINAL")\",\"name\":\"$(json_escape "$name")\",\"new\":${force_new}}"
      do_http POST '/workspace/bind' "$body"
      local kind; kind=$(jget "$HTTP_BODY" kind)
      if [ "$kind" = "created" ]; then
        printf "Named current workspace '%s' (pinned)\n" "$name"
      else
        local fc ca dt
        ca=$(jget "$HTTP_BODY" createdAt); fc=$(jget "$HTTP_BODY" fileCount)
        dt=$(format_epoch_ms "$ca")
        printf "Switched to existing workspace '%s' (created %s, %s files)\n" "$name" "$dt" "$fc"
      fi
      return "$EXIT_OK"
      ;;
    new)
      ARGS=("${subArgs[@]}"); reject_unknown_options 'workspace new'
      [ "${#subArgs[@]}" -gt 0 ] && [ -n "${subArgs[0]}" ] && die "$EXIT_USAGE" 'workspace new: takes no arguments'
      do_http POST '/workspace/new' "{\"terminal\":\"$(json_escape "$TERMINAL")\"}"
      local d; d=$(jget "$HTTP_BODY" dir)
      printf 'Switched to a fresh empty workspace: %s\n' "$d"
      return "$EXIT_OK"
      ;;
    unpin)
      ARGS=("${subArgs[@]}"); reject_unknown_options 'workspace unpin' '--name'
      local name='' i a body
      i=0
      while [ "$i" -lt "${#subArgs[@]}" ]; do
        a="${subArgs[$i]}"
        case "$a" in
          --name) i=$((i+1)); [ "$i" -lt "${#subArgs[@]}" ] || die "$EXIT_USAGE" 'workspace unpin: --name requires a value'; name="${subArgs[$i]}" ;;
        esac
        i=$((i+1))
      done
      if [ -n "$name" ]; then
        body="{\"terminal\":\"$(json_escape "$TERMINAL")\",\"name\":\"$(json_escape "$name")\"}"
      else
        body="{\"terminal\":\"$(json_escape "$TERMINAL")\"}"
      fi
      do_http POST '/workspace/unpin' "$body" >/dev/null
      printf 'Unpinned (stripped name+pinned; now reclaimable)\n'
      return "$EXIT_OK"
      ;;
    *)
      die "$EXIT_USAGE" "workspace: unknown subcommand: ${sub}. Available: list / bind / new / unpin"
      ;;
  esac
}

cmd_show() {
  # Path mode only (no stdin, no --as -- see marina.ps1 header for why).
  reject_unknown_options 'show' '--quiet' '-q'
  local quiet=0 path='' i a
  i=0
  while [ "$i" -lt "${#ARGS[@]}" ]; do
    a="${ARGS[$i]}"
    case "$a" in
      --quiet|-q) quiet=1 ;;
      *) path="$a" ;;
    esac
    i=$((i+1))
  done
  [ -n "$path" ] || die "$EXIT_USAGE" 'show: requires a PATH (no stdin mode -- write the file, then `marina show <path>`)'
  local p; p=$(resolve_abs "$path")
  [ -f "$p" ] || die "$EXIT_REJECTED" "not a file: ${p}"
  [ -n "$TERMINAL" ] || die "$EXIT_OFFLINE" 'TERMINAL_ID is unset'
  do_http POST '/open-file' "{\"terminal\":\"$(json_escape "$TERMINAL")\",\"path\":\"$(json_escape "$p")\"}" >/dev/null
  [ "$quiet" = "1" ] || printf 'shown: %s\n' "$p"
  return "$EXIT_OK"
}

cmd_run() {
  # Run an arbitrary shell command in Marina's command panel (ADR-027). All
  # args after `run` are joined into one command string (caller's shell does
  # the quoting). --title sets the tab title; --quiet suppresses output.
  reject_unknown_options 'run' '--quiet' '-q' '--title'
  local quiet=0 title='' cmd_parts=() i a
  i=0
  while [ "$i" -lt "${#ARGS[@]}" ]; do
    a="${ARGS[$i]}"
    case "$a" in
      --quiet|-q) quiet=1 ;;
      --title) i=$((i+1)); [ "$i" -lt "${#ARGS[@]}" ] || die "$EXIT_USAGE" 'run: --title requires a value'; title="${ARGS[$i]}" ;;
      *) cmd_parts+=("$a") ;;
    esac
    i=$((i+1))
  done
  local command; command=$(printf '%s ' "${cmd_parts[@]:-}"); command="${command% }"
  [ -n "$command" ] || die "$EXIT_USAGE" 'run: requires a COMMAND (e.g. `marina run "gh issue list"`)'
  [ -n "$TERMINAL" ] || die "$EXIT_OFFLINE" 'TERMINAL_ID is unset'
  local body="{\"terminal\":\"$(json_escape "$TERMINAL")\",\"command\":\"$(json_escape "$command")\""
  [ -n "$title" ] && body+=",\"title\":\"$(json_escape "$title")\""
  body+='}'
  do_http POST '/run' "$body" >/dev/null
  [ "$quiet" = "1" ] || printf 'ran: %s\n' "$command"
  return "$EXIT_OK"
}

cmd_close() {
  # Four forms: --all / --stale / --glob PAT / <PATH>. A PATH containing a
  # wildcard char is auto-treated as --glob so `close *.md` just works.
  reject_unknown_options 'close' '--quiet' '-q' '--all' '--stale' '--glob'
  local quiet=0 all=0 stale=0 glob=0 glob_pat='' path='' i a
  i=0
  while [ "$i" -lt "${#ARGS[@]}" ]; do
    a="${ARGS[$i]}"
    case "$a" in
      --quiet|-q) quiet=1 ;;
      --all) all=1 ;;
      --stale) stale=1 ;;
      --glob) glob=1; i=$((i+1)); [ "$i" -lt "${#ARGS[@]}" ] && glob_pat="${ARGS[$i]}" ;;
      *) path="$a" ;;
    esac
    i=$((i+1))
  done
  [ -n "$TERMINAL" ] || die "$EXIT_OFFLINE" 'TERMINAL_ID is unset'

  # mutual exclusion: at most one of all/stale/glob; none of them take a PATH.
  local batch=0
  [ "$all" = "1" ] && batch=$((batch+1))
  [ "$stale" = "1" ] && batch=$((batch+1))
  [ "$glob" = "1" ] && batch=$((batch+1))
  [ "$batch" -gt 1 ] && die "$EXIT_USAGE" 'close: --all / --stale / --glob are mutually exclusive'
  [ "$batch" -eq 1 ] && [ -n "$path" ] && die "$EXIT_USAGE" 'close: --all / --stale / --glob do not take a PATH'
  [ "$glob" = "1" ] && [ -z "$glob_pat" ] && die "$EXIT_USAGE" 'close: --glob requires a PATTERN'
  [ "$all" = "0" ] && [ "$stale" = "0" ] && [ "$glob" = "0" ] && [ -z "$path" ] && die "$EXIT_USAGE" 'close: requires a PATH (or use --all / --stale / --glob)'

  # implicit glob: a PATH with * or ? -> glob.
  if [ -n "$path" ]; then
    case "$path" in
      *\**|*\?*) glob=1; glob_pat="$path"; path='' ;;
    esac
  fi

  local term_body="\"terminal\":\"$(json_escape "$TERMINAL")\""
  if [ "$all" = "1" ]; then
    do_http POST '/close-files' "{${term_body},\"mode\":\"all\"}"
    [ "$quiet" = "1" ] || print_close_result "$HTTP_BODY" 'all'
  elif [ "$stale" = "1" ]; then
    do_http POST '/close-files' "{${term_body},\"mode\":\"stale\"}"
    [ "$quiet" = "1" ] || print_close_result "$HTTP_BODY" 'stale'
  elif [ "$glob" = "1" ]; then
    do_http POST '/close-files' "{${term_body},\"mode\":\"glob\",\"pattern\":\"$(json_escape "$glob_pat")\"}"
    [ "$quiet" = "1" ] || print_close_result "$HTTP_BODY" "glob '${glob_pat}'"
  else
    # single close via /close-file: server does exact-path then basename
    # fallback. We do NOT check existence (target may be deleted on disk
    # while the tab still exists -- that's the whole point of close).
    local p; p=$(resolve_abs "$path")
    do_http POST '/close-file' "{${term_body},\"path\":\"$(json_escape "$p")\"}" >/dev/null
    [ "$quiet" = "1" ] || printf 'closed: %s\n' "$p"
  fi
  return "$EXIT_OK"
}

# Format the batch-close result: "closed N file(s) [label]:" + paths, or the
# "closed 0 file(s) [label] (nothing matched)" note. Mirrors Print-CloseResult.
print_close_result() {
  local body="$1" label="$2"
  local n; n=$(printf '%s\n' "$body" | str_array "$body" closed | grep -c . | tr -d ' ')
  if [ "${n:-0}" = "0" ]; then
    printf 'closed 0 file(s) [%s] (nothing matched)\n' "$label"
    return
  fi
  printf 'closed %s file(s) [%s]:\n' "$n" "$label"
  local c
  while IFS= read -r c; do [ -n "$c" ] && printf '  %s\n' "$c"; done < <(str_array "$body" closed)
}

cmd_list() {
  reject_unknown_options 'list' '--json'
  local as_json=0 a
  for a in "${ARGS[@]:-}"; do [ "$a" = "--json" ] && as_json=1; done
  [ -n "$TERMINAL" ] || die "$EXIT_OFFLINE" 'TERMINAL_ID is unset'
  local term_enc; term_enc=$(urlencode "$TERMINAL")
  do_http GET "/opening-files?terminal=${term_enc}"
  if [ "$as_json" = "1" ]; then
    # Raw passthrough of the server body (richer than ps1's re-serialization;
    # still fully machine-parseable JSON).
    printf '%s\n' "$HTTP_BODY"
    return "$EXIT_OK"
  fi
  local active; active=$(jget "$HTTP_BODY" activePath)
  local obj path kind missing mark stale_mark kind_tag del_tag stale_count=0 has_files=0
  while IFS= read -r obj; do
    [ -n "$obj" ] || continue
    has_files=1
    path=$(jget "$obj" path)
    kind=$(jget "$obj" kind)
    missing=$(jget "$obj" missing)
    [ "$missing" = "true" ] && stale_count=$((stale_count+1))
    if [ "$path" = "$active" ]; then mark='*'; else mark=' '; fi
    if [ "$missing" = "true" ]; then stale_mark='!'; else stale_mark=' '; fi
    if [ -n "$kind" ] && [ "$kind" != "null" ]; then kind_tag="(${kind})"; else kind_tag=''; fi
    if [ "$missing" = "true" ]; then del_tag=' (deleted)'; else del_tag=''; fi
    printf '%s%s %s  %s%s\n' "$mark" "$stale_mark" "$path" "$kind_tag" "$del_tag"
  done <<<"$(array_objects "$HTTP_BODY" files)"
  if [ "$has_files" = "0" ]; then
    printf '(no files open in this terminal)\n'
    return "$EXIT_OK"
  fi
  if [ "$stale_count" -gt 0 ]; then
    printf '\n'
    printf '%s deleted file(s) above no longer exist on disk. Run: marina close --stale\n' "$stale_count"
  fi
  return "$EXIT_OK"
}

cmd_screenshot() {
  # v0.3.3 T12: capture this terminal's owner window as a PNG. Binary
  # response -- uses curl -o directly instead of the JSON do_http path.
  reject_unknown_options 'screenshot'
  if [ -z "$SERVICE" ]; then die "$EXIT_OFFLINE" 'MARINA_SERVICE is unset (not in a Marina terminal, or file panel is disabled in settings)'; fi
  if [ -z "$TOKEN" ]; then die "$EXIT_OFFLINE" 'MARINA_TOKEN is unset'; fi
  if [ -z "$TERMINAL" ]; then die "$EXIT_OFFLINE" 'TERMINAL_ID is unset (cannot identify owner window)'; fi
  local out=''
  if [ "${#ARGS[@]}" -ge 1 ] && [ -n "${ARGS[0]-}" ]; then
    out=$(resolve_abs "${ARGS[0]}")
  else
    # default: <workspace>/marina-screenshot-<timestamp>.png, else temp dir
    local dir
    if [ -n "$WORKSPACE" ] && [ -d "$WORKSPACE" ]; then dir="$WORKSPACE"; else dir=$(mktemp -d 2>/dev/null || printf '%s' "${TMPDIR:-/tmp}"); fi
    local stamp; stamp=$(date '+%Y%m%d-%H%M%S')
    out="${dir}/marina-screenshot-${stamp}.png"
  fi
  local term_enc; term_enc=$(urlencode "$TERMINAL")
  local url="${SERVICE%/}/screenshot?terminal=${term_enc}"
  local tmpcode
  tmpcode=$(curl -sS -m "$HTTP_TIMEOUT_SCREENSHOT" \
      -H "Authorization: Bearer ${TOKEN}" \
      -o "$out" -w '%{http_code}' "$url" 2>/dev/null)
  local curl_rc=$?
  if [ "$curl_rc" -ne 0 ]; then
    die "$EXIT_OFFLINE" "cannot reach ${url}: curl exit ${curl_rc} (connection refused / timeout / DNS)"
  fi
  if [ "$tmpcode" = "401" ]; then die "$EXIT_OFFLINE" 'Marina returned 401 (token rejected)'; fi
  case "$tmpcode" in
    2*) ;;
    *)
      local b; b=$(cat "$out" 2>/dev/null); : > "$out" 2>/dev/null
      local err; err=$(jget "$b" error 2>/dev/null); [ -n "$err" ] || err="$b"
      die "$EXIT_REJECTED" "Marina rejected screenshot (HTTP ${tmpcode}): ${err}"
      ;;
  esac
  printf '%s\n' "$out"
  return "$EXIT_OK"
}

print_usage() {
  cat <<'USAGE'
usage: marina [-h] {ping,workspace,show,run,close,list,screenshot} ...

Drive Marina's side file panel from inside a Marina terminal. Env vars are
read automatically; do not pass them as CLI options.

commands:
  ping              check whether Marina is reachable (exit 0/1)
  workspace         print this session's bound workspace path (queries main;
                    $MARINA_WORKSPACE is stale after a switch, always query)
  workspace list    list named workspaces under the current path scope
                    --json      raw JSON output
  workspace bind --name X [--new]
                    upsert: new name -> name+pin current; existing -> switch
                    --new + existing name -> error (must be a fresh create)
  workspace new     switch this session to a fresh empty temp workspace
                    (previously named workspace stays pinned)
  workspace unpin [--name X]
                    strip name+pinned; the workspace becomes reclaimable
                    (no `remove` command -- unpin is the safe exit)
  show <PATH>       open an existing file in the panel
                    -q, --quiet suppress success output
  run <COMMAND>     run an arbitrary shell command (bash) and render its
                    markdown output in the command panel (ADR-027)
                    all args after `run` are joined into one command string
                    --title "X"  set the tab display title
                    -q, --quiet  suppress success output
                    e.g. marina run "gh issue list --limit 5"
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
`marina show <PATH>`.

On Linux this dispatcher runs marina.sh (bash+curl, no extra runtime); on
Windows it runs marina.ps1 via the bundled PowerShell. See SKILL.md.
USAGE
}

# -- dispatch --------------------------------------------------------------
main() {
  # Sanity: curl is the only external binary we depend on. It ships with
  # every mainstream Linux desktop and macOS; if it is somehow absent, fail
  # clearly rather than with a confusing "command not found" mid-request.
  command -v curl >/dev/null 2>&1 || die "$EXIT_OFFLINE" 'curl is required but not found on PATH. Install curl (e.g. `apt install curl`) and retry.'
  read_config

  local command="${1-}"
  shift 2>/dev/null || true
  ARGS=("$@")

  if [ -z "$command" ]; then die "$EXIT_USAGE" 'missing command. Run: marina --help'; fi
  case "$command" in
    -h|--help|help) print_usage; exit "$EXIT_OK" ;;
    ping)       cmd_ping ;;
    workspace)  cmd_workspace ;;
    show)       cmd_show ;;
    run)        cmd_run ;;
    close)      cmd_close ;;
    list)       cmd_list ;;
    screenshot) cmd_screenshot ;;
    *)          die "$EXIT_USAGE" "unknown command: ${command}" ;;
  esac
}

main "$@"
