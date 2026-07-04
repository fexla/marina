# Marina

> Your terminal sessions shouldn't die just because you closed the window.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows-blue)](https://github.com/Liyue-Cheng/marina/releases)
[![Status](https://img.shields.io/badge/status-alpha-orange)](#roadmap)
[![中文文档](https://img.shields.io/badge/中文文档-README.zh--CN.md-red)](README.zh-CN.md)

A path-centric, AI-agent-friendly terminal manager for Windows. Built for developers who run multiple long-running tasks (including Claude Code, Codex, OpenCode, and other AI coding agents) across many local or SSH working directories — and refuse to lose them when the window closes.

> **History note**: Marina is the product previously known as EasyTerm during alpha development (CP-1 through Milestone 1). The rename happened at v1.5, and historical documents under `docs/` may still refer to "EasyTerm" — those are intentional snapshots of past decisions.

---

## The Problem

If you've ever:

- 🤖 Run 5 AI coding agents in 5 different projects and **forgotten which one was waiting for your input**
- 💀 Accidentally closed your terminal window and **killed a 2-hour build / a long pytest run / an agent mid-task**
- 🌀 Spent 10 seconds typing `cd D:\projects\company\some\deeply\nested\path` for the third time today
- 🔐 Jumped between remote servers and wished SSH sessions were organized by path, not by a pile of terminal tabs
- 📑 Tried to organize your work in Windows Terminal profiles and given up

...Marina is for you.

## The Solution

Marina rethinks how terminal sessions should be managed:

- **🔒 Sessions survive window closure.** Close every window. Sessions keep running in the background. Reopen any window to see them.
- **📍 Paths are first-class.** Bookmark working directories. Sessions are organized by where they live, not by which profile spawned them.
- **🖱️ Mouse-first.** No keyboard shortcuts to memorize. No `cd` typing. Click paths in the sidebar — that's the workflow.
- **🪟 All windows are equal.** No "main window" concept. Open as many as you want, close any of them — the app keeps running.

## Screenshots

> Screenshots coming with the first stable release. Below is a layout sketch.

```
┌────────────────────────────────────────────────────────────────────┐
│ Marina — Window 1                                    [_] [□] [×]  │
├──────────────────────┬─────────────────────────────────────────────┤
│ [Bookmarks] [Active] │  ┌─[claude] [shell] [pytest] [codex⚪]┐    │
│ [Recent]             │  └────────────────────────────────────┘   │
│                      │                                              │
│ ▼ ⌘ ~/projects/auth  │   ┌──────────────────────────────────────┐  │
│   ├─ ● claude code   │   │ $ claude                             │  │
│   ├─ ◐ shell         │   │ ✻ Welcome to Claude Code             │  │
│   └─ ○ pytest        │   │                                      │  │
│ ▼ ⌘ ~/projects/web   │   │ How can I help you today?            │  │
│   └─ ● codex         │   │ █                                    │  │
│ ▶ ⌘ ~/scripts        │   │                                      │  │
│                      │   │                                      │  │
│ ───── Active ─────   │   │                                      │  │
│ ▼ ⌚ ~/Downloads     │   │                                      │  │
│   └─ ○ shell         │   │                                      │  │
│                      │   │                                      │  │
│ ───── Recent ─────   │   │                                      │  │
│ • ~/test123          │   │                                      │  │
│ • D:\old\project     │   └──────────────────────────────────────┘  │
│                      │                                             │
│ [⚙] Settings         │                                             │
└──────────────────────┴─────────────────────────────────────────────┘
```

Marina ships with two title-bar styles (**Windows** controls on the right, **macOS** traffic-light on the left) selectable from Settings.

## Why Not Just Use [X]?

| Feature | Windows Terminal | Tabby | Wave | Warp | **Marina** |
|---------|:---:|:---:|:---:|:---:|:---:|
| Sessions survive window closure | ❌ | ❌ | ✅ | ❌ | ✅ |
| Path-centric organization | ❌ | ❌ | ❌ | ❌ | ✅ |
| Auto cwd tracking (⚠ on drift) | ❌ | ❌ | ✅ | ✅ | ✅ |
| Multi-window with shared session pool | ❌ | ❌ | ❌ | ❌ | ✅ |
| Close window without killing sessions | ❌ | ❌ | ✅ | ❌ | ✅ |
| Remote path bookmarks | ❌ | ❌ | ❌ | ❌ | ✅ |
| One-click remote tmux launch | ❌ | ❌ | ❌ | ❌ | ✅ |
| Built specifically for AI agent workflows | ❌ | ❌ | ❌ | ❌ | ✅ |
| Native Windows-first | ✅ | ✅ | ❌ | ❌ | ✅ |
| Mouse-first UI (no required shortcuts) | ❌ | ❌ | ❌ | ❌ | ✅ |

## For AI Agent Users

Marina was born from the frustration of running multiple Claude Code / Codex / OpenCode sessions concurrently and losing track of which one was idle, which one was waiting for input, and which one I'd accidentally killed by closing the wrong window.

If your workflow looks like this:

- One agent in `~/projects/frontend` working on the new dashboard
- Another agent in `~/projects/backend` refactoring the auth module
- A third agent in `~/scripts` running a long migration
- A fourth in `D:\client-work\report-tool` debugging a flaky test
- A fifth on `prod:~/repo` attached to a remote tmux session
- ...and you can't remember which is which

Marina gives you:

- **A persistent sidebar** showing every agent grouped by its project path
- **Status indicators** so you can see at a glance which agents are working vs. idle
- **CWD tracking** — when an agent `cd`s somewhere, the tab shows ⚠ with the real cwd in tooltip
- **SSH path bookmarks** — save remote profiles and bookmark remote working directories alongside local paths
- **Remote tmux launch** — start or attach to tmux on a remote host, and return to the remote shell when tmux exits
- **Templates** for `claude`, `codex`, `opencode` built-in, with full custom template support for your own commands
- **Session immortality** — close a window by accident and your agent keeps running. Reopen and continue where you left off.

## Quick Start

> ⚠️ Marina is in **Alpha**. Expect rough edges. See the [Roadmap](#roadmap) for what's planned.

### Install

1. Download the latest installer from [Releases](https://github.com/Liyue-Cheng/marina/releases)
2. Run `Marina-Setup-x.y.z.exe`
3. Launch from Start Menu or your desktop

### First-Run

- A window opens. The sidebar is empty.
- Click the **+** next to "Bookmarks" — pick a folder to add it
- Or drag a folder from File Explorer directly onto the sidebar (or onto the terminal area)
- Double-click a bookmarked path to open a terminal there
- Click `+` in the tab bar to start a Claude Code / Codex / shell session
- For remote work, add an SSH profile in Settings, bookmark a remote path such as `~/repo`, then connect normally or with tmux from the path view

### Try the Magic

To experience what makes Marina different:

1. Open 2-3 sessions in different paths
2. Close the window (the × button)
3. Look at your system tray — Marina is still running
4. Click the tray icon — a new window opens, all sessions are still there

That's it. That's the product.

## Core Features

### V1 (Current — alpha)

- ✅ **Path management**: bookmark, rename, reorder; auto-tracked "active" and "recent"
- ✅ **Remote paths**: SSH profiles, remote bookmarks, and sidebar labels that show profile + remote path context
- ✅ **Session lifecycle**: `active / idle / exited`; exited sessions stay visible until you close them manually (no time-based eviction, per ADR-008)
- ✅ **Launch templates**: built-in (Shell / Claude Code / Codex / OpenCode) + custom
- ✅ **SSH tmux mode**: per-launch attach-or-create tmux flow, directory-derived tmux session names, and shell fallback after tmux exits
- ✅ **Multi-window**: any number of equal windows; close-to-tray; cross-window session visibility
- ✅ **CWD tracking**: OSC 1337 hooks for PowerShell and cmd.exe
- ✅ **7 themes**: Rose Pine (default), Rose Pine Dawn, Rose Pine Moon, Cutie, Business, Ubuntu, Windows Terminal
- ✅ **Window style**: Windows or macOS (sets title-bar layout — not theme colors)
- ✅ **Settings**: live-applied, no save button; export/import config (with secrets-redaction option)
- ✅ **System tray**: persistent menu with running-sessions submenu; honest quit confirmation
- ✅ **Drop folder onto terminal area** to spawn a new session in that path
- ✅ **Multi-line paste guard** (confirm prompt prevents accidentally executing pasted scripts)
- ✅ **Terminal search** (Ctrl+F) with match count
- ✅ **Persistent logs** under `%APPDATA%\Marina\logs\`

### V1.1 (Planned)

- Status indicators for "waiting for input" / "error" via OSC 1337 command-completion events
- System notifications on session state changes
- Code signing

### V1.2 (Planned)

- Explorer right-click integration ("Open in Marina")
- Tab drag-and-drop reordering
- Tab tear-out to new window

### V1.6 (In Planning — Beta Feedback Round)

- **Linux support** (Ubuntu 22.04 GNOME as Tier 1; Fedora / CentOS Stream 9 / RHEL 9 as Tier 2 via `.rpm` + AppImage). No system-tray dependency on GNOME — Marina runs as a regular desktop app on Linux (`lifecycleModel: 'no-persistence'`), with a blocking modal on last-window-close when sessions are still running. File-manager integration via freedesktop standards (`.desktop` + `Categories=TerminalEmulator` + gsettings + update-alternatives), no Nautilus extension required. See [ADR-013](docs/软件定义书.md#adr-013) and [BETA-003](docs/beta反馈工单库-20260515.md#beta-003--linux-支持方案-a无托盘普通桌面-app).
- i18n (Chinese + English)
- AI assistant settings page (foundation for LLM status recheck)

### V2.0 (Community / Long-Term)

- macOS support (`lifecycleModel: 'dock-resident'`, native HIG)
- WSL session integration
- (Candidate) Daemon architecture — splitting Electron main into a background daemon + UI viewer, enabling sessions to survive UI crashes and updates across all three platforms. Not committed; evaluation window when crash/upgrade session loss becomes a frequent issue.

## Architecture (TL;DR)

Marina is built on **Electron 31 + TypeScript + React 18 + node-pty + xterm.js**.

- The **main process** is the daemon: it owns all PTYs, all data, and the system tray
- Each **window is a renderer process** with its own React UI
- Windows are pure observers — closing them never affects sessions
- Communication is via Electron IPC with a strict typed protocol (`docs/ipc-protocol.md`)

For details:

- [Software Definition (软件定义书)](docs/软件定义书.md) — what Marina is and why
- [IPC Protocol](docs/ipc-protocol.md) — the contract between main and renderer
- [AGENTS.md](AGENTS.md) — for AI agents contributing to this codebase

## Building from Source

```bash
# Prerequisites: Node.js 20+, Windows 10/11
git clone https://github.com/Liyue-Cheng/marina.git
cd marina
npm install
npm run dev      # development mode with hot reload
npm run build    # produces installer under release/
npm test         # runs the backend test suite
```

## Help Wanted

Marina is built and maintained by one person. **The architecture is intentionally cross-platform-ready** — see [`src/main/platform/`](src/main/platform/) and the `PlatformAdapter.lifecycleModel` field. Linux support is being implemented by the author for v1.6; macOS and other platforms are open for contributions:

### High Priority

- [ ] **macOS support** — implement `src/main/platform/macos.ts` with `lifecycleModel: 'dock-resident'`. Electron's `window-all-closed` darwin default already aligns with macOS HIG (app stays in Dock); the cross-platform `<LastSessionConfirm />` modal should trigger on `Cmd+Q` / App Menu Quit when non-exited sessions exist.
- [ ] **WSL session integration**

### Medium Priority

- [ ] Fish / Nushell shell hooks
- [ ] Tab drag-and-drop
- [ ] More themes (the 7 included are enough for me, but feel free)
- [ ] i18n beyond Chinese + English

### Low Priority

- [ ] Restore-on-launch for "important" sessions (user-marked)
- [ ] Performance benchmarks

If any of these speak to you, see `CONTRIBUTING.md` (TBD) for the platform abstraction philosophy and how to add new platforms without touching core code.

## Design Philosophy

If you want to understand why Marina makes the choices it does, the four principles are:

1. **Path is stable, Session is cheap, UI is temporary** — work flows by path, sessions come and go, windows are throwaway observers
2. **Don't make users type paths, make them click paths** — the `cd` command is a 1971 design that should be optional
3. **Minimize user decisions** — auto-categorize, auto-track, auto-resize; the user picks paths and templates, the rest is automatic
4. **Window and app are decoupled** — closing a window is free; the app lives in the tray until you explicitly quit it

Full reasoning in the [Software Definition (软件定义书)](docs/软件定义书.md), Section 2.

## What Marina is NOT

To save you time:

- ❌ **Not a terminal emulator replacement** — we use xterm.js like everyone else
- ❌ **Not a tmux competitor** — tmux is a TUI, Marina is a GUI; different audiences
- ❌ **Not a project management tool** — no kanban, no team features, no workspace concepts
- ❌ **Not a full SSH client suite** — Marina supports path-centric SSH sessions, but it is not trying to replace dedicated SSH managers with port forwarding, file transfer, or remote host administration workflows
- ❌ **Not a file editor** — open `code .` in a session if you need that
- ❌ **Not a "tile-everything" power-user tool** — if you love vim keybindings in your terminal manager, you'll find Marina's mouse-first approach annoying. That's a feature, not a bug.

## Roadmap

| Phase | What | When |
|-------|------|------|
| Phase 1 | V1: Internal use, Windows-only | In progress |
| Phase 2 | Open-source release, polish | After V1 stable |
| Phase 3 | V1.x: status indicators, notifications, Explorer integration | Post-release |
| Phase 4 | V2.0: cross-platform via community contributions | TBD |

This is a personal project built in spare time. There's no business behind it, no SLA, no committed timeline. If it solves your problem, great. If not, fork it.

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgments

Marina stands on the shoulders of:

- [Electron](https://www.electronjs.org/) — the application framework
- [electron-vite + Vite](https://electron-vite.org/) — build tooling
- [xterm.js](https://xtermjs.org/) — the terminal renderer
- [node-pty](https://github.com/microsoft/node-pty) — PTY bindings (Microsoft)
- [React](https://react.dev/) — UI framework
- [lucide-react](https://lucide.dev/) — icon library
- [Rose Pine](https://rosepinetheme.com/) — color palette inspiration
- [LXGW WenKai (霞鹜文楷)](https://github.com/lxgw/LxgwWenKai) — UI font

And inspiration from:

- [Wave Terminal](https://www.waveterm.dev/) — for showing that session persistence is possible in a polished GUI
- [tmux](https://github.com/tmux/tmux) — for proving sessions should outlive their UIs
- [iTerm2](https://iterm2.com/) — for OSC 1337, the unsung hero of cwd tracking

---

> Built because Windows Terminal had four years to ship close-to-tray and didn't.
