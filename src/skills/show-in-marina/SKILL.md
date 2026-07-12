---
name: show-in-marina
description: Use Marina's terminal-side file panel to show the user Markdown, text, code, or image results. Use after producing a report, plan, review, research result, or other artifact worth reading outside chat. Requires MARINA_SERVICE.
---

# Show files in Marina

Use this skill to place a result in the active terminal's Marina file panel instead of pasting a long document into chat.

## Check the environment

Marina provides these variables to every terminal session:

- `MARINA_SERVICE` — local HTTP base URL
- `MARINA_TOKEN` — Bearer token
- `TERMINAL_ID` — active terminal session identifier
- `MARINA_WORKSPACE` — session-owned temporary directory for display artifacts

Only call the API when `MARINA_SERVICE` is non-empty:

```bash
[ -n "$MARINA_SERVICE" ] && echo ok || echo "not-in-marina"
```

## Create a display artifact

Prefer the session-owned temporary directory for non-project artifacts. It avoids polluting the repository and Marina retains it after the terminal closes for the configured period (seven days by default).

```bash
SHOW_DIR="${MARINA_WORKSPACE:-${TEMP:-/tmp}/pi-marina}"
[ -n "$MARINA_WORKSPACE" ] || mkdir -p "$SHOW_DIR"
FILE="$SHOW_DIR/session-summary.md"

cat > "$FILE" <<'EOF'
# Work summary

- Result one
- Result two
EOF
```

`MARINA_WORKSPACE` is temporary. Do not put the only copy of a deliverable, a project file, or a long-lived archive there. Use the selected project’s `docs/` directory for deliverables that belong in source control.

## Open the file in the panel

Use an absolute path. For paths containing non-ASCII text, pipe JSON through `--data-binary` so Windows curl does not re-encode it.

```bash
printf '{"terminal":"%s","path":"%s"}' "$TERMINAL_ID" "$FILE" \
  | curl -sS "$MARINA_SERVICE/open-file" \
      -H "Authorization: Bearer $MARINA_TOKEN" \
      -H "Content-Type: application/json" \
      --data-binary @-
```

Marina automatically refreshes an opened file when it changes. Reuse a stable filename such as `session-summary.md` while iterating, rather than opening many tabs.

## Limits

- Markdown, text/code, and images are supported.
- Text is limited to 2 MB; images are limited to 10 MB.
- The panel complements a concise chat summary; it does not replace one.
