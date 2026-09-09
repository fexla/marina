---
name: show-in-marina
description: Use Marina's terminal-side file panel to show the user Markdown, text, code, or image results; or push a shell command whose output renders in the command panel via `marina run`. Use after producing a report, plan, review, research result, or other artifact worth reading outside chat. Markdown files shown this way can include fenced code blocks (bash/powershell/cmd) that the user runs with one click, and `marina:` action links that act as clickable `marina show`/`marina run` commands — write actionable docs (setup guides, cross-referenced issue sets, "try these" command menus, fix-verification steps). Requires Marina (the CLI checks; never read service/token vars yourself; use the workspace command for scratch paths).
---

# Show files in Marina

> **在你写 Markdown 文档之前，先读本目录的 `MARKDOWN-CAPABILITIES.md`** —— 那是面板
> 渲染 Markdown 的**完整能力清单**（标准格式）：可点击的本地文件链接/网页链接/页内锚点、
> `marina:` 动作链接（文档内点击等价于跑 `marina show`/`marina run`）、
> 可一键运行的代码块（bash/powershell/cmd）、` ```gallery ` 图片画廊、本地图片、目录导航，
> 以及硬性约束（只读查看器、>2MB 截断、**原始 HTML 被禁用**等）。按它写才能让文档在
> 面板里真正可交互，而不是纯文本。下文只摘最关键的三条（链接、marina: 动作链接、
> 可运行代码块）；gallery / 图片 / sudo / 文件类型见那份文档。

Place a result in the active terminal's Marina file panel instead of pasting a
long document into chat. This skill ships a small CLI that handles env
vars, HTTP, UTF-8 encoding, and Bearer auth for you. The same `marina`
entry point works on **Windows, Linux, and macOS**: it is a bash dispatcher
that transparently selects the right client for the host. There are four
files, all in the same directory as this SKILL.md:

- **`marina`** (no extension, a bash script) — the single entry point on
  every platform. On **bash / Git Bash / MSYS on Windows** it execs
  `marina.ps1` via `powershell.exe` (sidestepping a silent-success trap with
  `cmd /c`, see "Bash / Git Bash" below). On **Linux / macOS** it execs the
  native `marina.sh`. You usually just call this.
- **`marina.sh`** — the native POSIX client (bash + curl). The `marina`
  dispatcher runs this on Linux / macOS. It needs NO extra runtime (no
  PowerShell, no python, no jq) — only bash + curl, which ship with every
  mainstream desktop Linux and macOS.
- **`marina.cmd`** — Windows-only launcher for **plain cmd.exe or PowerShell**
  (no bash involved). It calls `powershell.exe -File marina.ps1` for you.
- **`marina.ps1`** — the Windows client (PowerShell). The `marina` dispatcher
  runs this on Windows. You normally do not call it directly.

All four live **in the same directory as this SKILL.md**. Always invoke them
by that resolved path — never assume a bare `marina` is on PATH (it is not),
and never modify PATH or create a launcher elsewhere.

## How to invoke the CLI (important)

### Linux / macOS (bash)

Use the **`marina`** dispatcher in this directory. It auto-detects that no
`powershell.exe` is present and runs the native `marina.sh` for you:

```bash
./marina ping
# or, if the file lacks the executable bit in your environment:
bash marina ping
```

The bash examples below use `./marina` for brevity; substitute the resolved
path when your working directory differs (e.g.
`bash /abs/path/to/skill/marina ping`). The dispatcher locates `marina.sh`
via its own location, so it works from any cwd. You can also call
`bash marina.sh` directly if you prefer. The native client needs only `bash`
and `curl` (both present on a default Linux/macOS install) — it does not
require PowerShell, python, node, or jq.

### PowerShell (or plain cmd.exe, no bash) — Windows

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

Linux / macOS:

```bash
./marina ping
```

Windows (PowerShell / cmd.exe):

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

For Markdown, optionally request a one-time jump to a visible heading:

```bash
./marina show report.md --heading "Verification"
```

PowerShell / cmd launcher:

```powershell
.\marina.cmd show report.md --heading "Verification"
```

`--heading` matches visible heading text after trimming/folding whitespace and ignoring case;
if the document repeats the same title, the first one wins. The request is transient: every
`show --heading` call navigates again, while later file-watch refreshes do not replay it. A
missing title still opens the file and Marina reports the navigation miss in the panel.

### Where to write the artifact: resolve the managed workspace first

Marina maintains a per-terminal managed scratch directory. Throwaway
display-only artifacts belong there; source-controlled deliverables still
belong in the project's `docs/`. The managed directory is isolated per
terminal and automatically reclaimed after the session closes (default
retention 7 days, configurable; `0` deletes immediately).

> **v0.3.3 contract change:** the directory used to be fixed at PTY spawn and
> readable from `$env:MARINA_WORKSPACE`. It is now **decoupled from the session
> and can switch at runtime** (bind a name, switch to a named workspace, start
> a fresh one). So `$env:MARINA_WORKSPACE` is the **stale spawn-time value** —
> after a `workspace bind`/`workspace new` switch it no longer points at the
> active directory. **Always resolve the current path via the CLI**, which
> queries Marina's main process (the source of truth).

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

#### Workspace lifecycle subcommands (v0.3.3)

These let you name and reuse a scratch directory across the session, or hand
work off between tasks. They all query main (require the Marina env vars);
there is **no `remove`** command — to stop preserving a named workspace use
`unpin` and it becomes reclaimable after the retention window.

- `marina workspace` — print this session's **current** bound workspace path
  (always query this; `$env:MARINA_WORKSPACE` is stale after a switch).
- `marina workspace list [--json]` — list named workspaces under the current
  path scope (name / created / file count / pinned).
- `marina workspace bind --name X [--new]` — **upsert**. If `X` is new, the
  current scratch dir is **named** `X` and pinned (preserved across restarts).
  If `X` already exists in this path scope, this session **switches** to that
  existing directory (the prior unnamed scratch is released; the command
  prints a hint so you notice it was a switch, not a create). `--new` forces a
  fresh create and **errors** if `X` already exists.
- `marina workspace new` — switch this session to a fresh empty unnamed
  scratch directory (a previously named workspace stays pinned).
- `marina workspace unpin [--name X]` — strip the name + pinned flag so the
  workspace returns to ordinary retention (reclaimed after the window). With
  no `--name`, unpins the session's current workspace.

Typical agent flow: do work in the default scratch; once you want to preserve
a deliverable for later reuse, `marina workspace bind --name <task>` early
(before accumulating throwaway output), then `marina workspace bind --name
<task>` again later to return to it.

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

### Use one document as the task dashboard (multi-turn work)

`show` is not only for a final result. Across the multiple turns of one task,
keep **one** document as the shared surface between you and the user: the
running progress, the options under consideration, the open questions, and the
user's own annotations all live in that file. Each turn you overwrite it and
re-`show` the same path; the tab refreshes in place and the chat stays a short
status line plus "see the doc".

This is far more stable than dropping long content into the chat across many
turns — the chat does not scroll, the user reviews one place, and you keep the
full current state without re-pasting. Concretely:

1. On the first turn, write the doc to the managed workspace (see above) and
   `show` it once. From then on that tab is the dashboard.
2. Each later turn, **overwrite the same file** (same path) and re-run
   `./marina show "$path"`. The panel refreshes the existing tab; it does not
   open a new one.
3. Keep the chat side short: a one-line status ("updated the plan, decision
   needed on X") plus a pointer to the doc. Put the detail in the doc.
4. Use clear sections in the doc (Status / Options / Open questions / Decided)
   so the user can jump to what changed.

Resolve the workspace once per terminal and reuse that concrete path for every
overwrite (the path is stable for the session; you do not need to re-resolve it
each turn).

## Run a command in the command panel

`show` is for a **finished document you wrote**. `run` is the other channel:
hand Marina a **shell command** and it executes that command, then renders the
**output** in a separate panel — the **command panel** (the 4th dock panel,
beside Open / Git / File-tree). Use it when the user wants to *watch a
command's output* without reclaiming the terminal (which you are usually
occupying): `gh issue list`, `git log`, a build status, a wayfinder map. The
command runs via **bash in the current session's cwd**, not through the
terminal PTY, so it never disturbs your shell session.

```bash
./marina run "gh issue list --limit 5"      # render that command's output
./marina run --title issues "gh issue list" # give the tab a custom title
./marina run git status --short             # quotes optional for a single arg
./marina run -q "make test"                 # -q / --quiet suppresses the line
```

(PowerShell / cmd.exe: `.\marina.cmd run ...` with the same args.)

Everything after `run` is joined into one command string, so quote it the way
your own shell expects (bash needs quotes around anything with spaces).
Marina does not parse the command — it passes the whole string to bash.

**`run` vs `show` — decide by what changes:**

- A **document you authored** that is done → `show` a file (Open panel).
- A **command's current output** that may differ on rerun → `run` the command
  (Command panel).

**Tabs and refresh are panel-side, not CLI options:**

- Each distinct command opens its own tab. Pushing the **same** command again
  does **not** add a tab — it re-runs the existing one (dedup).
- Refresh policy is per-tab and is chosen by the **user in the panel toolbar**,
  not by the CLI. Default is **foreground-only** (runs while the user views
  that tab; stops when they switch away, to save resources). The user may
  switch a tab to **background polling** (e.g. every 30s / 5s), **manual**, or
  **off**. Your `run` pushes the command and fires one immediate run; the
  policy is the user's call.
- Output renders as Markdown (plain text is valid Markdown, so raw output
  still looks right). URLs are clickable; fenced code blocks get a Run button,
  just like `show`.

Prereqs match `show`: needs `MARINA_SERVICE` / `MARINA_TOKEN` / `TERMINAL_ID`
(see `ping`). **SSH sessions are unsupported** — the command panel does not
appear (the session cwd is remote; the local daemon cannot spawn there),
symmetric with the Git panel. Exit codes are the same as `show` (0 ok, 1
offline, 2 usage, 3 rejected).

## Runnable code blocks in Markdown you show

Marina renders fenced code blocks in any Markdown file you `show` as
**interactive**: each block gets a **Run** button. One click executes the
block in the appropriate shell (`bash`/`sh` → Git Bash, `powershell`/`pwsh`
→ PowerShell, `cmd` → cmd.exe), streams stdout/stderr into the document under
the block, and shows the exit code. The terminal the user is working in is
never disturbed — the command runs in an independent spawned process. The user
can also **select lines inside a block** and run only the selection.

This means you can write Markdown documents that are **directly actionable**,
not just readable. Lean into it:

- **Repro / setup guides** — each step is a fenced block the user runs in
  sequence, seeing live output inline instead of copy-pasting into a separate
  terminal.
- **"Try these" command menus** — a few one-liners the user can click to
  inspect state (`git status`, `Get-Process node`, `dir /s *.log`).
- **Demos / tutorials** — narrate in prose, put the command in a block, the
  user runs it and reads the result in place.
- **Fix verification** — after applying a fix, put the verification command in
  a block so the user can confirm with one click.

Use these fenced languages (they get a Run button):

````markdown
```bash
uname -a
```

```powershell
Get-Date
```

```cmd
dir
```
````

Guidance:
- **One logical step per block.** If a block does five unrelated things the
  user can't run them independently. Prefer several small blocks over one big
  one — the user can run / re-run / select-run each.
- **Make output self-evident.** End commands with an `echo` / `Write-Host`
  label, or print the value being inspected, so the inline result is
  interpretable without the original command in view.
- **Each block is independent.** State (cwd, env vars, shell history) does not
  carry across blocks — each Run spawns a fresh shell. If a step depends on a
  prior step, put them in the **same block**, or have the later step re-establish
  what it needs.
- **Don't put destructive commands in runnable blocks** in docs you hand to
  the user unless that is clearly the intent. Prefer inspection commands in
  "try these" menus.
- Other fenced languages (e.g. ` ```js `, ` ```python `) render as static code
  (no Run button) — fine for reference snippets.

When you build a task-dashboard document (see above), consider making the
verification / next-step commands runnable blocks so the user can act on the
doc directly instead of switching to chat or a terminal.

## Links to local files and web pages in Markdown

Links (`[text](target)`) in any Markdown you `show` are split by Marina by
their **scheme** — use the right form so the click does what you intend:

- **Local file** (default): write the path **as-is**, relative to the Markdown
  file's directory (or absolute). A click opens that file **read-only in the
  panel** as a new tab — point at another doc, a source file, a log, an image,
  etc. Relative paths resolve against the Markdown file's location, the same
  rule Markdown images use.
  ```markdown
  See [the design notes](./design-notes.md) and [main.ts](../src/main.ts).
  ```
- **Web page**: write the **full** URL starting with `http://` or `https://`
  (or `mailto:`). A click opens it in the system browser — Marina's panel is
  not a browser.
  ```markdown
  Docs: <https://react.dev/learn> · contact [me](mailto:me@example.com)
  ```
- **In-page anchor**: `#section-id` scrolls within the current document.
  Marina assigns stable Unicode-aware heading ids and `-1`, `-2`, ... suffixes to duplicates.

Rules of thumb:
- **Anything that is not a full `http(s)://` / `mailto:` URL, not a `#`
  anchor, and not a `marina:` action link is treated as a local file.** So a
  bare `example.com/x` (no scheme) or a `data:`/`tel:`/`file:` target is read
  as a local path and opened in the panel — usually failing with a toast if it
  doesn't resolve. Always write the full scheme for web links.
- **Pointing at a missing/non-file path** shows a toast error; the panel is
  unchanged. Paths are resolved and checked on the Marina side (the Markdown's
  own directory is the base), so relative links keep working after the file is
  moved as long as the relative layout is preserved.
- Local links open **read-only**; Marina's panel is a viewer, not an editor.

## `marina:` action links — clickable CLI actions inside the document (v0.3.3)

A link whose target starts with `marina:` is an **action link**: clicking it
does what running the corresponding `marina` CLI subcommand would do — same
services, same session context, **no confirmation dialog** (you authored the
document; that carries your authority). They render as a distinct pill-shaped
chip with an icon (▶ run / 📄 show), and hovering shows the exact command.

Two verbs are available:

- **`marina:show <path> [--heading <title>]`** — open a file in this
  terminal's Open panel (read-only tab), exactly like `marina show`. The path
  resolves **relative to the Markdown file's directory**; in command-panel
  output (no file path) it resolves relative to the session cwd.
- **`marina:run [--title <label>] <command...>`** — push the command to the
  command panel and run it, exactly like `marina run`. `--title` must come
  **before** the command; anything after the command starts (including
  `--flags`) is part of the command.

```markdown
See [issue #42](<marina:show issue-42.md>) or jump to
[the repro section](<marina:show report.md --heading "Repro Steps">).
[Refresh the list](<marina:run gh issue list --limit 20>) anytime,
or [watch the build](<marina:run --title "build" make test>).
```

**Syntax rules (important):**

- **Wrap the target in angle brackets `<>` whenever it contains spaces.**
  CommonMark does not allow spaces in a bare link target:
  `[x](marina:show a.md)` does **not** parse as a link at all (it renders as
  plain text). `[x](<marina:show a.md>)` is the correct form. Inside `<>`
  you can write spaces and quotes naturally.
- Alternative: percent-encode every space as `%20`
  (`[x](marina:show%20a.md)`). The whole target is URL-decoded once before
  parsing.
- **Quote multi-word `--heading` / `--title` values**
  (`--heading "Repro Steps"`); an unquoted second word would be joined into
  the path/command instead.
- Backslashes are literal (Windows paths like `D:\ws\x.md` survive); the only
  escape is `\` immediately before the same quote character inside a quoted
  value. Positional tokens are joined with single spaces, so
  `marina:show%20my%20report.md` and `marina:show "my report.md"` both mean
  the path `my report.md`.

**When to use them:**

- **Cross-reference menus** — you fetched/preprocessed a set of documents
  (issues, specs, reports); link them to each other so the user browses the
  whole set from the panel without asking you to `show` each one.
- **Menu-style docs** — a dashboard where each entry opens a detail doc
  (`show`) or runs an inspection command (`run`), letting the user choose
  what to look at.
- Prefer `show` for reading and `run` for live output; don't embed
  destructive commands — the user clicks these without a prompt.
- Only `show` and `run` exist as document actions. Everything else
  (`workspace`, `list`, `close`, `screenshot`) stays a terminal-side CLI
  command.

## Other commands

```bash
./marina workspace              # print this terminal's managed scratch path
./marina list                   # files open in this terminal's panel
./marina list --json            # machine-readable output (includes `missing`)
./marina screenshot             # capture this window as a PNG, print its path (T12)
./marina screenshot /abs/x.png  # ...to an explicit path
./marina close "$artifact"      # close one file
./marina close report.md        # ...or just the file name (basename match)
./marina close --all            # close every file in this terminal's panel
./marina close --stale          # close tabs whose file no longer exists on disk
./marina close --glob '*.md'    # close files whose name matches a glob
./marina close '*.md'           # a path containing * or ? is auto-treated as --glob
```

**`screenshot` (self-test enabler).** Captures this terminal's owner window as a
PNG so you can visually verify UI you changed without a human in the loop. It
prints the saved path; read that PNG back to inspect it. Default output is a
timestamped file under the managed workspace; pass an explicit path to choose.
Requires `MARINA_SERVICE` / `MARINA_TOKEN` / `TERMINAL_ID` (same as `show`).
Fails with exit 1 if those are unset, exit 3 if Marina refuses (no owner
window, window closed, etc.).

**`list` marks zombie tabs.** A tab whose file has been deleted from disk is
shown with a leading `!` and `(deleted)`, plus a `close --stale` hint at the
bottom. `list --json` reports this as `"missing": true` on the file.

**`close` matching.** A single `close <PATH>` first tries an exact path match,
then falls back to a case-insensitive **basename** match — so you can pass just
the file name as shown by `list` instead of the whole path. If several open
files share that basename it errors (use the full path or a glob). A path or
name containing `*` or `?` is treated as a glob and closes every match.

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
