# project manager 📁

A zero-dependency terminal dashboard (baby-blue theme) and **launcher** for your
local projects. Every project is a folder — select one and press `↵` to
**🚀 launch** it: the project's website opens in your browser, and if the dev
server isn't running it's started **in the background**, with the browser opening
once it's up. The dashboard stays open the whole time (it never exits); `x` stops
a server pm started.

The **🚀 Launch** menu is pinned to the top of the dashboard at all times.

Plus lines of code, disk + `node_modules` size, language breakdown, git status,
and **live-localhost detection**.

```
  project manager 📁  ·  11 projects   ~/Documents                  ● 3000 5173
   🚀 Launch              ↵ launch — opens the site, starts the dev server if needed
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
 ↑↓ move · ↵ launch site · d start · x stop · o localhost · e editor · / find · q quit
```

The right column shows each project's dev port and whether it's live (`●`) or
stopped (`○`); `—` means no web server was detected.

## Run

It's installed as a global command (`pm`, with `project-manager` and `folder` as
aliases):

```bash
pm                     # scan the current directory
pm ~/Documents         # scan your projects
```

Or run it directly:

```bash
node folder.mjs ~/Documents
```

### Non-interactive

```bash
pm --list ~/Documents       # plain stats table
pm --json ~/Documents       # JSON, for scripting
```

## Keys

| Key | Action |
| --- | --- |
| `↑ ↓` / `j k` | move |
| `↵` / `l` | **🚀 launch** the selected project — open its site (starts the dev server in the background if needed) |
| `g` / `G` | jump to top / bottom |
| `d` | start the dev server in the **background** (no browser; dashboard stays open) |
| `x` | stop a dev server that pm started |
| `D` | run the dev server in the **foreground** (quits pm, shows live logs) |
| `o` | open the project in localhost (browser) without starting it |
| `e` | open the project in `$EDITOR` (default `code`) |
| `c` | copy the project path to the clipboard |
| `/` | search / filter by name |
| `r` | rescan projects + ports |
| `?` | help · `q` quit |

`● live` means a dev server is listening on the project's guessed port.
`✱n` means *n* uncommitted git changes.

## How it works

- **Projects** = directories (scanned up to 3 levels deep) containing a marker
  like `package.json`, `.git`, `Cargo.toml`, `go.mod`, `pyproject.toml`, …
- **Lines of code** counts source files, skipping `node_modules`, `.git`,
  `dist`, `build`, `.next`, `target`, lockfiles, and minified output.
- **Sizes** use `du` for speed; the localhost port is guessed from the framework
  (Next → 3000, Vite → 5173, Astro → 4321, …) or a `--port` flag in the script,
  then probed with a quick TCP connect.

No dependencies, no network calls — pure Node.
