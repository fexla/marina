---
name: show-in-marina
description: Use Marina's terminal-side file panel to show the user Markdown, text, code, or image results. Use after producing a report, plan, review, research result, or other artifact worth reading outside chat. Requires Marina (the CLI checks; do not read env vars yourself).
---

# Show files in Marina

Place a result in the active terminal's Marina file panel instead of pasting a
long document into chat. This skill ships a small Windows CLI, `marina.cmd`,
that handles env vars, HTTP, UTF-8 encoding, and Bearer auth for you.

## How to invoke the CLI (important)

`marina.cmd` lives **in the same directory as this SKILL.md**. Always invoke it
by that path — never assume a bare `marina` is on PATH (it is not), and never
modify PATH or create a launcher elsewhere. Resolve `marina.cmd` next to this
SKILL.md and call that explicit path.

In PowerShell, from the directory containing this SKILL.md:

```powershell
.\marina.cmd ping
```

From any other working directory, pass the resolved path explicitly:

```powershell
& "<path-to-this-skill-directory>\marina.cmd" ping
```

The examples below use `.\marina.cmd` for brevity; substitute the resolved path
when your working directory differs.

**Do not** call `curl`, `Invoke-RestMethod`, or read `$MARINA_SERVICE` /
`$MARINA_TOKEN` yourself. The CLI is the only supported entry point.

## Quick check: am I in Marina?

```powershell
.\marina.cmd ping
```

The exit code tells you what to do:

- `0` → Marina is online. You can `show` results to the panel.
- `1` → not in a Marina terminal, the file panel is disabled, or the reachable
  service did not return the Marina health marker. Fall back to a concise
  result in chat.

## Show a result

There is **no stdin mode** and **no `--as` option**. Piping content through
stdin is unreliable on Windows PowerShell 5.1 (the parent pipeline re-encodes
bytes to the console code page before the CLI sees them, corrupting non-ASCII).
Instead:

1. Write the artifact to a file with your normal file-writing tool, as UTF-8
   (no BOM). Source-controlled deliverables belong in the project's `docs/`;
   throwaway display-only artifacts can go in the system temp directory.
2. Show that file's path:

```powershell
.\marina.cmd show .\docs\architecture-review.md
```

To iterate, overwrite the same file and re-run `show` with the same path — the
panel refreshes that tab in place instead of stacking a new one.

`-q` / `--quiet` suppresses the success line:

```powershell
.\marina.cmd show --quiet .\docs\architecture-review.md
```

## Other commands

```powershell
.\marina.cmd list              # files open in this terminal's panel
.\marina.cmd list --json       # machine-readable output
.\marina.cmd close .\docs\architecture-review.md   # close a file in the panel
```

## Exit codes

| code | meaning                                          | what to do                       |
|------|-------------------------------------------------|----------------------------------|
| 0    | success                                         | continue                         |
| 1    | Marina offline / not in Marina / panel disabled / health marker missing | paste result in chat |
| 2    | usage error (unknown option, missing path, unknown command) | fix the command        |
| 3    | Marina online but rejected (file missing, not a regular file, ...) | read stderr   |

## Notes

- Supported content: Markdown, text/code, images. Text over 2 MB is truncated
  in the preview; images over 10 MB are rejected at preview time.
- The panel complements a concise chat summary; it does not replace one.
- How the CLI finds the panel: it reads `MARINA_SERVICE` / `MARINA_TOKEN` /
  `TERMINAL_ID` that Marina injects into the session. If any required var is
  missing the command fails with exit 1 — there is **no** port-scanning or
  address fallback, so a silent misroute cannot happen.
