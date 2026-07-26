# Foldview

**Your projects and AI coding tools, ready in one terminal.**

Foldview is a friendly terminal home for projects, local apps, and AI coding
agents — a zero-dependency terminal workspace and launchpad for vibe coding.
Open it and see, in one screen, what projects you have, what's already
running, and the fastest way into the next AI coding session.

Foldview is not another coding agent. It's the calm control surface around
the agents and projects you already have.

**Local-first.** Foldview scans folders on your machine, detects the AI CLIs
and editors already installed, and reads/writes its own config at
`~/.foldview.json`. Project discovery, CLI detection, and configuration stay
on your machine — nothing is uploaded or sent over the network.

```
  foldview 🚀  ·  11 projects   ~/Documents                  ● 3000 5173
   🚦 Launch              ↵ launch — opens the site, starts the dev server if needed
┌─ Launch  ·  ↵ opens the website ┬────────────────────────────────────┐
│ ● Kalshi BOT          3000 ●  │ Kalshi BOT                          │
│ ✱ fantasy gov         3000 ○  │ ~/Documents/Kalshi BOT              │
│   AI card                  —  │ ───────────────────────────────     │
│   agent-factory       5173 ○  │ ● localhost:3000    ● live — ↵ opens │
│                              │                                     │
│                              │   Lines of code: 14,231             │
│                              │   Files:         188                │
│                              │   node_modules:  312M              │
│                              │   Git:           main ✱3 dirty      │
│                              │                                     │
│                              │   LANGUAGES                         │
│                              │   TypeScript ████████░░  68%        │
└──────────────────────────────┴─────────────────────────────────────┘
 ↑↓ move · ↵ launch site · d start · x stop · a AI terminals · o localhost · e editor · / find · q quit
```

## Quick start

```bash
npm i -g folderpreview     # installs `pm` (aliases: foldview, folderpreview, project-manager)

pm                 # scan the current directory
pm ~/Projects      # scan a folder of projects
```

From source:

```bash
git clone https://github.com/coolyiqiao123/FoldView.git foldview
cd foldview
npm link          # installs the `pm` command globally
```

Or run it directly without installing anything:

```bash
node folder.mjs ~/Projects
```

Select a project and press `↵`: the project's website opens in your browser,
starting the dev server in the background first if it isn't already running.
The dashboard stays open the whole time.

## What Foldview does

- **One dashboard for every local project** — folders are auto-detected by
  marker file (`package.json`, `.git`, `Cargo.toml`, `go.mod`,
  `pyproject.toml`, …) and sorted live-first, so what's already running
  floats to the top.
- **Launch without memorizing commands** — `↵` opens a project's site,
  starting its dev server in the background if needed; `d`/`D` start it in
  the background or foreground; `x` stops a server Foldview started.
- **AI terminals** — the flagship action. Pick a project, press `a`, choose a
  detected or custom AI coding CLI, and Foldview opens that many tiled
  Terminal.app windows already `cd`'d into the project, ready to run.
- **Local apps** — detected tools (like claude-mem, only if installed), any
  other live localhost server, and apps you pin yourself all show up
  alongside your projects.
- **Project stats** — lines of code, disk and `node_modules` size, language
  breakdown, and git status, without leaving the dashboard.
- **Scriptable output** — `pm --list` and `pm --json` for scripts and other
  tools; a small CLI bridge for automation and the optional menu-bar
  companion.

## Open AI terminals

Select a project and press `a`. The footer lists every AI CLI Foldview found
on your machine, plus a custom option:

```text
AI terminals — c claude · x codex · k kimi code · g gemini · + custom · esc cancel
```

Press the CLI's shortcut. For providers that expose a model catalog (Codex and
Kimi Code), Foldview loads it and lets you dial in the model and reasoning
effort with `←→` before continuing — the catalog comes from the CLI itself, so
the list is whatever your installed version actually supports:

```text
Codex model 2/6: GPT-5 · ←→ choose · ↵ next · esc back
gpt-5 · effort 3/4: high · ←→ choose · ↵ next · esc back
```

Then a digit `1`–`9` for how many windows to open:

```text
Codex · GPT-5 · high — how many windows? 1-9 · esc back
```

Foldview opens that many Terminal.app windows, each started in the selected
project directory running the chosen CLI, tiles them so none are fully
hidden behind another, activates Terminal, and reports the result:

```text
opened 3 × claude
```

`esc` cancels at any step, and existing Terminal windows are never moved.

**CLI discovery.** Foldview checks for these CLIs using `command -v` in its
own environment — no shell history is read and no discovery data leaves your
machine. Only CLIs that actually resolve are shown:

| Shortcut | CLI | Executable |
| --- | --- | --- |
| `c` | Claude | `claude` |
| `x` | Codex | `codex` |
| `k` | Kimi Code | `kimi` |
| `g` | Gemini | `gemini` |
| `o` | OpenCode | `opencode` |
| `i` | Aider | `aider` |

Codex and Kimi Code additionally expose a live model catalog, so their model
and effort can be chosen per launch and saved as a default.

**Custom CLIs.** Press `+` in the AI terminals prompt to add any other
executable by name or absolute path. Valid entries are saved to
`~/.foldview.json` under `aiClis` (deduplicated by resolved path) and appear
in the picker from then on, alongside your other configuration.

## Keys

| Key | Action |
| --- | --- |
| `↑ ↓` / `j k` | move |
| `↵` / `l` | launch the selected project — opens its site, starting the dev server in the background if needed |
| `g` / `G` | jump to top / bottom |
| `d` | start the dev server in the background (no browser; Foldview stays open) |
| `D` | run the dev server in the foreground (quits Foldview, shows live logs) |
| `x` | stop a dev server Foldview started, or remove/hide an app row |
| `o` | open the project in localhost (browser) without starting it |
| `e` | open the project in `$EDITOR` (default `code`) |
| `a` | AI terminals — open 1-9 Terminal windows running a detected or custom AI coding CLI in the project |
| `A` | add a local app to the list (name @ port), saved to `~/.foldview.json` |
| `s` | pin a discovered local app |
| `c` | copy the project path to the clipboard |
| `/` | search / filter by name |
| `r` | rescan projects and ports |
| `?` | help · `q` quit |

`● live` means a dev server is listening on the project's guessed port.
`✱n` means *n* uncommitted git changes.

## Non-interactive output

For scripts and other tools:

```bash
pm --list ~/Documents       # plain stats table
pm --json ~/Documents       # JSON
pm serve ./site 8899        # serve a static folder on localhost, zero dependencies
```

These stay unchanged by the AI terminals feature and the CLI bridge below.

## CLI bridge

Foldview also exposes explicit subcommands so scripts, and the optional
menu-bar companion, can read status and trigger actions without a TTY —
using the same scanning, launching, and configuration code as the dashboard:

```text
pm status --format menubar-json
pm roots list --json
pm roots add <absolute-directory>
pm roots remove <absolute-directory>
pm action open --project <absolute-directory>
pm action start --project <absolute-directory> --open
pm action stop --project <absolute-directory>
pm action editor --project <absolute-directory>
pm action ai --project <absolute-directory> --cli <absolute-executable> --count <1-9>
             [--provider <codex|kimi>] [--model <id>] [--effort <value>] [--json]
pm ai catalog [--provider <codex|kimi>] --json
pm ai defaults get --provider <codex|kimi> --json
pm ai defaults set --provider <codex|kimi> --model <id> [--effort <value>] --json
pm config get --json
pm config set menubar.<setting> <value>
pm aiclis add --name <name> --executable <path>
pm aiclis remove --executable <path>
pm menubar [--status|--force-install]
pm agents --json
pm burn --json [--days N] [--refresh]
pm hooks install|uninstall|status
pm hook-bridge <claude|kimi> <EventName>   # internal shim used by installed hooks
```

`pm status --format menubar-json` is the fast path: it skips full
lines-of-code, disk-size, and git analysis, so it stays quick even on large
project roots.

`pm ai catalog` and `pm ai defaults` are the model-control bridge: Node owns
the provider catalogs and the saved model/effort defaults, so the TUI, the
CLI, and the menu-bar sliders all read and write the same source of truth.

`pm agents --json` reports the LLM coding agents currently active on this
machine (Claude Code, Kimi Code, Codex, claude-flow daemons) with roles,
current action, and last activity. `pm burn --json` aggregates token usage and
estimated cost per CLI/model, wall-clock coding time, Codex plan quota, and
GitHub commit contributions (via `gh`, the only network call). Both are local
reads of the CLIs' own transcript files — nothing is uploaded. `pm hooks`
installs/removes the hook entries that let the macOS companion show and answer
approval prompts (see below).

## macOS menu-bar companion (optional)

For macOS 14 and later, Foldview includes an optional native menu-bar
companion (`mac/`) built with SwiftUI. It shows which projects are live,
your recent projects, and lets you open, start, or launch an AI terminal
without finding a Terminal window first — all through the same CLI bridge
above, so there's no separate scanning or launch logic to keep in sync.

It also runs **Notch Nook**: a click-to-open panel under the MacBook notch
with four tabs — Agents (all your running LLM agents with their roles and
current actions, plus **Approve/Deny** for Claude Code permission prompts,
delivered over a loopback-only bridge and `pm hooks install`), Foldview (your
localhost projects), Burn (token/cost analytics, coding time, GitHub commits),
and Fans (MacBook fan speed readout and control via a one-password-prompt
root helper). See `mac/README.md` for the bridge contract, hook support
matrix, and fan privilege model.

The companion is entirely optional. `pm menubar` installs or launches it,
and the Node CLI and TUI work exactly the same with or without it installed.

## How Foldview finds projects

- **Projects** = directories (scanned up to 3 levels deep) containing a
  marker like `package.json`, `.git`, `Cargo.toml`, `go.mod`,
  `pyproject.toml`, …
- **Lines of code** counts source files, skipping `node_modules`, `.git`,
  `dist`, `build`, `.next`, `target`, lockfiles, and minified output.
- **Sizes** use `du` for speed; the localhost port is guessed from the
  framework (Next → 3000, Vite → 5173, Astro → 4321, …) or a `--port` flag
  in the script, then probed with a quick TCP connect.

## Configuration

Foldview reads and writes `~/.foldview.json` — pinned/hidden apps, project
roots, recent projects, custom AI CLIs, and menu-bar preferences all live
here. Foldview always reads, merges, and writes this file atomically, so
unrelated settings and unknown fields are preserved:

```json
{
  "schemaVersion": 1,
  "roots": ["/Users/example/Projects"],
  "recentProjects": ["/Users/example/Projects/my-app"],
  "menubar": { "refreshSeconds": 60, "showDiscoveredApps": true },
  "apps": [],
  "hidden": [],
  "aiClis": [{ "name": "my-agent", "executable": "/absolute/path/to/my-agent" }]
}
```

No dependencies, no network calls — pure Node.

## Website

The marketing site lives in `site/` as hand-authored `index.html`,
`styles.css`, and `app.js` — no build step, no framework, no bundler. Preview
it with Foldview's own static server:

```bash
pm serve site 8899     # → http://localhost:8899
```

## Development

```bash
npm test                       # Node test suite (zero dependencies)
cd mac && swift test           # macOS menu-bar companion
```

Contributions and issues: https://github.com/coolyiqiao123/FoldView

## License

MIT
