# @marina/pi-marina-bridge

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that bridges
pi's conversation and work lifecycle events to **Marina**, so Marina can:

1. **Bind each pi conversation to its own workspace** — switching conversations
   (`/new`, `/resume`) inside pi switches the terminal's managed workspace.
2. **Precisely signal work state** — when pi finishes a round of work that you
   haven't viewed yet, the sidebar indicator turns a warning color until you
   switch to that terminal.
3. **Mirror the conversation name** to the terminal's display name.

## It's a dumb forwarder

This package **only forwards events** to Marina over the injected
`MARINA_SERVICE` HTTP channel. It does **not** read Marina settings or make
workspace decisions — Marina is the decision maker (`settings.piIntegration`
controls whether each behavior runs).

## No-op outside Marina

If the three env vars are absent (`MARINA_SERVICE`, `MARINA_TOKEN`,
`TERMINAL_ID`), the extension subscribes to **nothing** and has zero effect.
You can safely install it globally — it activates only inside a Marina
terminal.

## Install

### From the Marina repo (local path)

```bash
pi install /path/to/marina/packages/pi-marina-bridge
```

Or via Marina's built-in installer (the same channel that installs the
`show-in-marina` skill), once enabled.

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
Marina terminal (TERMINAL_ID)
  └─ pi process
       └─ this extension
            • detects MARINA_SERVICE / MARINA_TOKEN / TERMINAL_ID
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
without the endpoint) only logs a warning and never blocks pi.

## Requirements

- Marina v0.3.3+ (adds the `/pi-session-event` endpoint + `piIntegration` settings)
- pi (any version with the lifecycle events above)

## Design reference

See Marina's `docs/软件定义书.md` **ADR-028** and
`docs/方案-pi对话绑定workspace-20260805.md`.
