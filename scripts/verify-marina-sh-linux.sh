#!/usr/bin/env bash
#
# @file scripts/verify-marina-sh-linux.sh
# @purpose Standalone end-to-end verification of the show-in-marina POSIX
#   client (marina.sh) on a Linux host. No node / npm / vitest needed -- only
#   bash + curl + python3, which is exactly marina.sh's own runtime
#   requirement. Used to validate the Linux skill on a real Linux box (e.g.
#   10.9.0.1) where the full Marina app / node toolchain may not be installed.
#
# @what it checks:
#   1. The bundled mock server (src/main/marina-cli-mock-server.py) implements
#      the file-panel-service HTTP contract; we point marina.sh at it.
#   2. Every subcommand: ping (online + marker strictness), workspace
#      (path/list/bind/new/unpin), show (existing/missing/quiet), run,
#      close (--all/--stale/--glob + mutually-exclusive), list (human + json +
#      zombie marking), screenshot (bytes + default path).
#   3. Exit codes match marina.ps1 (0/1/2/3).
#   4. The dispatcher `marina` (no extension) routes to marina.sh on a host
#      with no powershell.exe (the Linux path).
#   5. The executable bit survived packaging (./marina works, not just
#      `bash marina`).
#
# @usage:
#   bash scripts/verify-marina-sh-linux.sh
#   (run from the repo root, or pass the repo root as $1)
#
# @exit: 0 = all checks passed, 1 = at least one failed (see FAIL lines).
set -u

ROOT="${1:-$(pwd)}"
SKILL_DIR="$ROOT/src/skills/show-in-marina"
SH="$SKILL_DIR/marina.sh"
DISPATCHER="$SKILL_DIR/marina"
MOCK="$ROOT/src/main/marina-cli-mock-server.py"
TOKEN="verify-token-abc"

pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); printf '  FAIL %s%s\n' "$1" "${2+  $2}"; }
# run marina.sh with the given Marina env + args; captures status/stdout/stderr.
runsh() {
  local _service="$1"; shift
  MARINA_SERVICE="$_service" MARINA_TOKEN="$TOKEN" TERMINAL_ID="t1" \
    bash "$SH" "$@"
}

echo "== prerequisites =="
command -v bash   >/dev/null || { echo "MISSING bash"; exit 2; }
command -v curl   >/dev/null || { echo "MISSING curl (marina.sh needs it)"; exit 2; }
# Pick a python that can actually run code (on Windows, `python3` may be a
# store stub; on Linux `python3` is standard). Verify each candidate imports
# http.server before using it.
PYTHON=""
for _cand in python3 python; do
  command -v "$_cand" >/dev/null 2>&1 || continue
  if "$_cand" -c 'import http.server,sys; sys.exit(0)' >/dev/null 2>&1; then
    PYTHON="$_cand"; break
  fi
done
[ -n "$PYTHON" ] || { echo "MISSING python3 (only needed for the mock server)"; exit 2; }
echo "  bash=$BASH_VERSION (curl, $PYTHON present)"
echo "  marina.sh: $([ -f "$SH" ] && echo present || echo MISSING)"
echo "  dispatcher: $([ -f "$DISPATCHER" ] && echo present || echo MISSING)"

# start the mock server (mixed list mode so list/close have fixtures)
LOG="$(mktemp)"
"$PYTHON" "$MOCK" 0 "$LOG" "$TOKEN" marina mixed > /tmp/marina-verify-mock.out 2>&1 &
MPID=$!
trap 'kill $MPID 2>/dev/null; rm -f "$LOG" /tmp/marina-verify-mock.out' EXIT
sleep 1
PORT=$(grep -o 'listening [0-9]*' /tmp/marina-verify-mock.out | grep -o '[0-9]*')
BASE="http://127.0.0.1:$PORT"
echo "  mock server: $BASE"
[ -n "$PORT" ] || { echo "mock server failed to start:"; cat /tmp/marina-verify-mock.out; exit 2; }

echo ""
echo "== ping =="
out=$(runsh "$BASE" ping 2>/dev/null); rc=$?
[ "$rc" = 0 ] && [ "$out" = "marina: online" ] && ok || bad "ping online" "rc=$rc out=$out"

echo "== workspace =="
out=$(runsh "$BASE" workspace 2>/dev/null); rc=$?
[ "$rc" = 0 ] && echo "$out" | grep -q 'workspace' && ok || bad "workspace path" "rc=$rc out=$out"
out=$(runsh "$BASE" workspace list 2>/dev/null); rc=$?
{ [ "$rc" = 0 ] && echo "$out" | grep -q 'feat-x' && echo "$out" | grep -q 'pinned'; } && ok || bad "workspace list" "rc=$rc out=$out"
out=$(runsh "$BASE" workspace bind --name fresh 2>/dev/null); rc=$?
{ [ "$rc" = 0 ] && echo "$out" | grep -q 'Named current'; } && ok || bad "workspace bind created" "rc=$rc out=$out"
out=$(runsh "$BASE" workspace bind --name feat-x 2>/dev/null); rc=$?
{ [ "$rc" = 0 ] && echo "$out" | grep -q 'Switched to existing'; } && ok || bad "workspace bind switched" "rc=$rc out=$out"
runsh "$BASE" workspace bind --name feat-x --new >/dev/null 2>&1; rc=$?
[ "$rc" = 3 ] && ok || bad "workspace bind --new conflict exit 3" "rc=$rc"
runsh "$BASE" workspace new >/dev/null 2>&1; rc=$?
[ "$rc" = 0 ] && ok || bad "workspace new" "rc=$rc"
runsh "$BASE" workspace unpin >/dev/null 2>&1; rc=$?
[ "$rc" = 0 ] && ok || bad "workspace unpin" "rc=$rc"

echo "== show =="
F=$(mktemp); echo '# hi' > "$F"
out=$(runsh "$BASE" show "$F" 2>/dev/null); rc=$?
[ "$rc" = 0 ] && echo "$out" | grep -q 'shown:' && ok || bad "show existing" "rc=$rc out=$out"
runsh "$BASE" show "$F.nonexistent" >/dev/null 2>&1; rc=$?
[ "$rc" = 3 ] && ok || bad "show missing exit 3" "rc=$rc"
runsh "$BASE" show >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && ok || bad "show no path exit 2" "rc=$rc"
out=$(runsh "$BASE" show --quiet "$F" 2>/dev/null); rc=$?
[ "$rc" = 0 ] && [ -z "$out" ] && ok || bad "show --quiet" "rc=$rc out=$out"
rm -f "$F"

echo "== run =="
runsh "$BASE" run "echo hello" >/dev/null 2>&1; rc=$?
[ "$rc" = 0 ] && ok || bad "run" "rc=$rc"

echo "== list =="
out=$(runsh "$BASE" list 2>/dev/null); rc=$?
{ [ "$rc" = 0 ] && echo "$out" | grep -q 'gone.md' && echo "$out" | grep -q '(deleted)' && echo "$out" | grep -q 'close --stale'; } && ok || bad "list mixed" "rc=$rc out=$out"
out=$(runsh "$BASE" list --json 2>/dev/null); rc=$?
{ [ "$rc" = 0 ] && echo "$out" | grep -q '"files"'; } && ok || bad "list --json" "rc=$rc"

echo "== close =="
runsh "$BASE" close --all >/dev/null 2>&1; rc=$?
# state mutated; restart mock for next
kill "$MPID" 2>/dev/null; sleep 0.5
"$PYTHON" "$MOCK" 0 "$LOG" "$TOKEN" marina mixed > /tmp/marina-verify-mock.out 2>&1 &
MPID=$!; sleep 1
PORT=$(grep -o 'listening [0-9]*' /tmp/marina-verify-mock.out | grep -o '[0-9]*'); BASE="http://127.0.0.1:$PORT"
runsh "$BASE" close --stale >/dev/null 2>&1; rc=$?
[ "$rc" = 0 ] && ok || bad "close --stale" "rc=$rc"
runsh "$BASE" close --glob 'ZZNOMATCH.md' >/dev/null 2>&1; rc=$?
[ "$rc" = 0 ] && ok || bad "close --glob" "rc=$rc"
runsh "$BASE" close --all --stale >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && ok || bad "close mutually exclusive exit 2" "rc=$rc"

echo "== screenshot =="
OUT=$(mktemp -d)/shot.png
out=$(runsh "$BASE" screenshot "$OUT" 2>/dev/null); rc=$?
{ [ "$rc" = 0 ] && [ -s "$OUT" ]; } && ok || bad "screenshot explicit" "rc=$rc"
# verify PNG header bytes (8-byte signature)
hdr=$(head -c 8 "$OUT" 2>/dev/null | od -An -tx1 | tr -d ' \n')
[ "$hdr" = "89504e470d0a1a0a" ] && ok || bad "screenshot PNG header" "hdr=$hdr"
out=$(runsh "$BASE" screenshot 2>/dev/null); rc=$?
{ [ "$rc" = 0 ] && echo "$out" | grep -q 'marina-screenshot-'; } && ok || bad "screenshot default path" "rc=$rc out=$out"

echo "== env strictness =="
runsh "$BASE" show /etc/hostname >/dev/null 2>&1; rc=$?
# (file exists, so it should proceed; but we test missing TOKEN:)
MARINA_SERVICE="$BASE" TERMINAL_ID="t1" bash "$SH" show /etc/hostname >/dev/null 2>&1; rc=$?
[ "$rc" = 1 ] && ok || bad "missing TOKEN exit 1" "rc=$rc"

echo "== dispatcher routing (no powershell.exe) =="
# On Linux there is no powershell.exe, so `marina` MUST exec marina.sh.
out=$(MARINA_SERVICE="$BASE" "$DISPATCHER" ping 2>/dev/null); rc=$?
{ [ "$rc" = 0 ] && [ "$out" = "marina: online" ]; } && ok || bad "dispatcher -> marina.sh" "rc=$rc out=$out"

echo "== executable bit =="
[ -x "$SH" ] && ok || bad "marina.sh is +x" "(would need 'bash marina.sh' fallback)"
[ -x "$DISPATCHER" ] && ok || bad "marina dispatcher is +x"

echo ""
echo "== RESULT: pass=$pass fail=$fail =="
[ "$fail" = 0 ] && echo "ALL CHECKS PASSED" || echo "SOME CHECKS FAILED"
exit $([ "$fail" = 0 ] && echo 0 || echo 1)
