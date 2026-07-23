---
name: show-in-marina
description: Use Marina's terminal-side file panel to show the user Markdown, text, code, or image results. Use after producing a report, plan, review, research result, or other artifact worth reading outside chat. Requires Marina (the CLI checks; never read service/token vars yourself; use the workspace command for scratch paths).
---

# Show files in Marina

Place a result in the active terminal's Marina file panel instead of pasting a
long document into chat. This skill ships a small Windows CLI that handles env
vars, HTTP, UTF-8 encoding, and Bearer auth for you. There are three entry
points, all in the same directory as this SKILL.md:

- **`marina`** (no extension, a bash script) — use this when your shell is
  **bash / Git Bash / MSYS** on Windows. It wraps the real logic and avoids a
  silent-success trap with `cmd /c` (see "Bash / Git Bash" below).
- **`marina.cmd`** — the launcher for **plain cmd.exe or PowerShell** (no bash
  involved). It calls `powershell.exe -File marina.ps1` for you.
- **`marina.ps1`** — the real logic. You normally do not call it directly; the
  two launchers above do.

All three live **in the same directory as this SKILL.md**. Always invoke them
by that resolved path — never assume a bare `marina` is on PATH (it is not),
and never modify PATH or create a launcher elsewhere.

## How to invoke the CLI (important)

### PowerShell (or plain cmd.exe, no bash)

From the directory containing this SKILL.md:

```powershell
.\marina.cmd ping
```

From any other working directory, pass the resolved path explicitly:

```powershell
& "<path-to-this-skill-directory>\marina.cmd" ping
```

The PowerShell/cmd examples below use `.\marina.cmd` for brevity; substitute
the resolved path when your working directory differs.

### Bash / Git Bash / MSYS on Windows

Use the **`marina`** wrapper in this directory, NOT `marina.cmd`.

```bash
./marina ping
# or, if the file lacks the executable bit in your environment:
bash marina ping
```

The bash examples below use `./marina` for brevity; substitute the resolved
path when your working directory differs (e.g.
`bash /abs/path/to/skill/marina ping`). The wrapper locates `marina.ps1` via
its own location, so it works from any cwd.

> **Do not** invoke the CLI from bash as `cmd /c "marina.cmd ..."`.
> MSYS / Git Bash rewrites the `/c` flag into the path `C:/` before cmd.exe
> sees it, so cmd.exe starts an **interactive** session instead of running
> marina.cmd — and it returns **exit 0**, which makes a failed or never-run
> command look successful. This is a silent trap. The `marina` wrapper sidesteps
> cmd.exe entirely (it calls `powershell.exe -File marina.ps1` directly).

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
   (no BOM).
2. Show that file's path.

### Where to write the artifact: resolve the managed workspace first

Marina injects a per-terminal scratch directory as `MARINA_WORKSPACE`.
Throwaway display-only artifacts belong there; source-controlled deliverables
still belong in the project's `docs/`. The managed directory is isolated per
terminal and automatically reclaimed after the session closes (default
retention 7 days, configurable; `0` deletes immediately).

**Critical path rule:** shell variable syntax is expanded only by that shell.
A file-writing API/tool (`write`, `edit`, Python `open`, Node `fs`, etc.) does
**not** expand `$MARINA_WORKSPACE`, `$env:MARINA_WORKSPACE`, or
`%MARINA_WORKSPACE%`. Passing one of those strings to such a tool creates a
literal directory with that name under the current cwd — exactly the wrong
behavior.

Use the CLI to resolve the workspace to a concrete absolute path:

PowerShell / cmd launcher:

```powershell
$workspace = & ".\marina.cmd" workspace
$artifact = Join-Path $workspace 'architecture-review.md'
Set-Content -LiteralPath $artifact -Value '# Architecture review' -Encoding utf8
.\marina.cmd show $artifact
```

Bash / Git Bash wrapper:

```bash
workspace="$(./marina workspace)" || exit $?
artifact="${workspace}/architecture-review.md"
printf '# Architecture review\n\n...' > "$artifact"
./marina show "$artifact"
```

When using a non-shell file-writing tool, follow this exact sequence:

1. Run the appropriate launcher with `workspace`.
2. Capture the single absolute path printed to stdout.
3. Append the filename to that concrete path.
4. Pass the concrete absolute path to `write` / `edit` / Python / Node.
5. Pass the same path to `show`.

Resolve it again for each terminal/session; do not reuse a path captured from
another terminal. Never construct `<cwd>/$MARINA_WORKSPACE/...`, and never
pass an environment-variable symbol as a path to a non-shell tool.

To iterate, overwrite the same file and re-run `show` with the same path — the
panel refreshes that tab in place instead of stacking a new one.

`-q` / `--quiet` suppresses the success line:

```bash
./marina show --quiet "$artifact"
```

## Other commands

```bash
./marina workspace              # print this terminal's managed scratch path
./marina list                   # files open in this terminal's panel
./marina list --json            # machine-readable output
./marina close "$artifact"      # close the previously resolved artifact
```

(PowerShell/cmd.exe: use `.\marina.cmd`; resolve `$artifact` from the
`workspace` command as shown above.)

## Exit codes

| code | meaning                                                                 | what to do           |
| ---- | ----------------------------------------------------------------------- | -------------------- |
| 0    | success                                                                 | continue             |
| 1    | Marina offline / not in Marina / panel disabled / health marker missing | paste result in chat |
| 2    | usage error (unknown option, missing path, unknown command)             | fix the command      |
| 3    | Marina online but rejected (file missing, not a regular file, ...)      | read stderr          |

## Notes

- Supported content: Markdown, text/code, images. Text over 2 MB is truncated
  in the preview; images over 10 MB are rejected at preview time.
- The panel complements a concise chat summary; it does not replace one.
- How the CLI finds the panel: it reads `MARINA_SERVICE` / `MARINA_TOKEN` /
  `TERMINAL_ID` that Marina injects into the session. If any required var is
  missing the command fails with exit 1 — there is **no** port-scanning or
  address fallback, so a silent misroute cannot happen.
