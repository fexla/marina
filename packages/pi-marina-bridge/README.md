# @marina/pi-marina-bridge

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that bridges
pi's conversation and work lifecycle events to **Marina**, and injects the
`show-in-marina` skill + Marina system prompt inside Marina terminals, so
Marina can:

1. **Bind each pi conversation to its own workspace** — switching conversations
   (`/new`, `/resume`) inside pi switches the terminal's managed workspace.
2. **Precisely signal work state** — when pi finishes a round of work that you
   haven't viewed yet, the sidebar indicator turns a warning color until you
   switch to that terminal.
3. **Mirror the conversation name** to the terminal's display name.
4. **Auto-inject the `show-in-marina` skill + a Marina system prompt** — when
   pi runs inside a Marina terminal, the bundled
   `skills/show-in-marina` is contributed via the `resources_discover` hook,
   and a short "Marina output conventions" block (long outputs go to the file
   panel via the skill; waterfall-style replies; batched clarifying questions)
   is appended to the system prompt via `before_agent_start`.

## Forwarder part is still a dumb forwarder

Event forwarding **only forwards events** to Marina over the injected
`MARINA_SERVICE` HTTP channel. It does **not** read Marina settings or make
workspace decisions — Marina is the decision maker (`settings.piIntegration`
controls whether each behavior runs). The injection part is deliberately
**not** gated on `piIntegration`: the file panel is an independent Marina
feature, and the skill/prompt only depend on "is this a Marina terminal"
(the same three env vars).

## No-op outside Marina

If the three env vars are absent (`MARINA_SERVICE`, `MARINA_TOKEN`,
`TERMINAL_ID`), the extension subscribes to **nothing**, injects **nothing**,
and has zero effect. You can safely install it globally — it activates only
inside a Marina terminal.

## Install

### From the Marina repo (local path)

```bash
pi install /path/to/marina/packages/pi-marina-bridge
```

Or via Marina's built-in installer (Settings → AI 助手, or the sidebar
right-click menu on a favorite path).

### Globally (user settings)

```bash
pi install /absolute/path/to/marina/packages/pi-marina-bridge
```

Project-local:

```bash
pi install -l ./relative/path/to/packages/pi-marina-bridge
```

## How it works

```
Marina terminal (TERMINAL_ID, PI_HYPERLINKS=1)
  └─ pi process
       └─ this extension
            • detects MARINA_SERVICE / MARINA_TOKEN / TERMINAL_ID
            • resources_discover → contributes <pkg>/skills (show-in-marina)
            • before_agent_start → appends Marina system prompt (idempotent)
            • registerMarkdownTransformer → linkify (see below)
            • subscribes to pi events
            • POST /pi-session-event  →  Marina main (decision maker)
                                          ├─ workspace bind/switch (ADR-024 infra)
                                          ├─ hasUnviewedWork indicator
                                          └─ displayName sync
```

Events forwarded:

| pi event | forwarded as | Marina does |
|---|---|---|
| `session_start` {reason} | `session_start` | bind/switch workspace + declare pi identity |
| `session_shutdown` {reason=quit} | `session_shutdown` | clear pi identity |
| `agent_start` | `agent_working` | clear "unviewed work" flag |
| `agent_settled` | `agent_settled` | set "unviewed work" flag (warning indicator) |
| `session_info_changed` {name} | `name_changed` | update terminal display name |

All posts are **fire-and-forget**: a failure (Marina offline, old Marina
without the endpoint) only logs a warning and never blocks pi. The injection
hooks never do IO either — if the bundled `skills/` directory is missing
(broken install), both injections are skipped with a warning and event
forwarding continues to work.

### Markdown linkify transformer (0.3.14, terminal interactive links)

Registered via pi's official `registerMarkdownTransformer` (display-only; runs
before pi's own markdown rendering for streaming chunks, final messages and
restored sessions — must be a pure function, no IO):

- bare file paths (STRICT detection, vendored from Marina
  `src/shared/terminal-path-detector.ts` with a corpus-parity test) →
  `[原文](marina:show "<abs>" [--line N])`; relative paths resolved against
  pi's cwd, `~` expanded, truncated `D:/x` drive prefixes restored;
- bare URLs → wrapped as links; labels longer than `max(28, width/2)` are
  shortened to `host…tail` (href stays complete);
- fenced code blocks, inline code, existing `[label](href)` links and images
  are passed through untouched.

pi renders the resulting links as **OSC 8 hyperlinks** (enabled by the
`PI_HYPERLINKS=1` env Marina injects into every PTY); Marina's xterm renders
them natively and they survive soft line wraps — detection happens at the
source-text level, so terminal wrapping can no longer break a link. Clicks are
routed by Marina (`marina:` actions reuse the ADR-035 dispatch; see
`docs/方案-终端可交互链接-20260912.md` / ADR-041). Requires a pi version that
has the transformer API; older versions silently skip it (pi's native
`[]()` → OSC 8 still works via `PI_HYPERLINKS=1`).

## Requirements

- Marina v0.3.3+ (adds the `/pi-session-event` endpoint + `piIntegration` settings)
- pi (any version with the lifecycle events above; skill injection needs
  pi ≥ 0.50.8 for the `resources_discover` hook — older versions silently
  skip injection while forwarding keeps working)

## Design reference

See Marina's `docs/软件定义书.md` **ADR-028** (decision 8) / **ADR-041**
(terminal interactive links), `docs/方案-终端可交互链接-20260912.md`,
`docs/方案-pibridge-skill与提示词注入-20260909.md`, and
`docs/方案-pi对话绑定workspace-20260805.md`.
