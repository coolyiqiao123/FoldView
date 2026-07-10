# GLOBAL CONTEXT — Foldview rebrand + AI terminals swarm (2026-07-02)

Spec (single source of truth, READ IT FULLY):
`/Users/yc/Documents/Billa/docs/superpowers/specs/2026-07-02-ai-terminals-design.md`

Repo: `/Users/yc/Documents/Billa` (git; HAS UNCOMMITTED CHANGES — build on top of the
working tree, never revert, never commit, never touch `.git`).

## Team ownership map (EXCLUSIVE write access — do not edit files you don't own)

| Team | Name | Owns (write) |
| --- | --- | --- |
| 1 | folder-core | `folder.mjs`, `test/**` (new) |
| 2 | docs-brand | `README.md`, `package.json` |
| 3 | site-brand | `site/**` |
| 4 | mac-companion | `mac/**` (new) |

Off-limits for everyone: `.git/**`, `docs/superpowers/specs/**` (the spec itself),
other teams' files. Everyone may READ anything. Shared swarm dir
(`swarm/2026-07-02-ai-terminals/`): append to `CLAIMS.jsonl`, write your own
`reports/team-<n>-<name>.md`.

## Coordination protocol

- Append one JSON line to `CLAIMS.jsonl` when you START and when you FINISH a major
  unit of work: `{"team":1,"event":"start|done","what":"...","ts":"<ISO date>"}`
  (use `date -u +%Y-%m-%dT%H:%M:%SZ`). Append with `>>`, never rewrite the file.
- Final report → `swarm/2026-07-02-ai-terminals/reports/team-<n>-<name>.md`:
  what changed, verification evidence (commands + output), anything you could NOT
  do, and requests for other teams (e.g. a package.json script you need).
- If you need a change in a file you don't own, put it in your report — do not edit.

## FROZEN CONTRACTS (all teams build against these exactly)

### Brand constants
- Product name: `Foldview` (this exact spelling/capitalization; TUI wordmark may be
  lowercase `foldview` as a compact wordmark).
- Tagline: `Your projects and AI coding tools, ready in one terminal.`
- Short description: `A friendly terminal home for projects, local apps, and AI coding agents.`
- Category wording: “terminal workspace and launchpad for vibe coding”; prefer
  “terminal home / workspace / launchpad / helper”; never ONLY “project manager” /
  “folder viewer” / “AI agent”. Local-first trust statement near the value prop.
- Voice: plain verbs (open/start/stop/find/add/launch); failures state the next
  action; no hype (revolutionary/magic/10×/supercharge); no shaming; keep the npm
  package name `folderpreview`, bins (`pm`/`view`/…), config filename, and repo name
  UNCHANGED.

### Config `~/.foldview.json` (schemaVersion 1)
```json
{
  "schemaVersion": 1,
  "roots": ["/abs/dir"],
  "recentProjects": ["/abs/dir"],
  "menubar": { "refreshSeconds": 60, "showDiscoveredApps": true },
  "apps": [], "hidden": [],
  "aiClis": [ { "name": "my-agent", "executable": "/abs/path" } ]
}
```
All writers: read-merge-write, preserve unknown fields, atomic tmp-file + rename.

### Status payload `pm status --format menubar-json` (schemaVersion 1)
```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-07-02T12:00:00.000Z",
  "summary": { "projectCount": 12, "liveCount": 2 },
  "projects": [ { "id": "/abs", "name": "my-app", "path": "/abs", "kind": "project",
    "live": true, "port": 5173, "launchable": true, "managed": true,
    "modifiedAt": 1782993600000 } ],
  "aiClis": [ { "name": "claude", "executable": "/abs/claude" } ]
}
```
Fast path: NO LOC/disk/dep-size/git walks; warm refresh < 500 ms target.

### CLI bridge subcommand surface (preserve `pm [path]`, `--list`, `--json`, `--help`)
```text
pm status --format menubar-json
pm roots list --json | pm roots add <abs-dir> | pm roots remove <abs-dir>
pm action open|start|stop|editor --project <abs-dir> [--open]
pm action ai --project <abs-dir> --cli <abs-executable> --count <1-9>
pm menubar [--force-install]
```
Mutating actions and status reads must work without a TTY.

### Managed runtime registry
`~/Library/Application Support/Foldview/runtime-v1.json`, atomic writes. Entry:
project path, pid, pgid, port, startedAt, command, logFile, launcher (`tui`|`menubar`).
Stop/`managed:true` only after validating: PID alive, command matches, cwd is the
project or child, port owned by that process tree. Stale records deleted; PID reuse
protected; inconclusive ⇒ leave running, say `Foldview did not start this server`.

### Known AI CLIs (discovery via `command -v`, Foldview's own env, no network)
| key | name | executable |
| c | Claude | claude |
| x | Codex | codex |
| g | Gemini | gemini |
| o | OpenCode | opencode |
| i | Aider | aider |
Deterministic collision resolution; footer shows the ACTUAL assigned key.

### Terminal grid
`columns = ceil(sqrt(n))`, `rows = ceil(n/columns)`; 1 ⇒ full usable display,
2 ⇒ side-by-side; small gap; stay in bounds; only windows created by this action
are moved; existing windows untouched; activate Terminal after layout.

## Verification bar (every team)
- Evidence before assertions: run the commands, paste key output in your report.
- Team 1: `node --check folder.mjs`; `node --test test/`; `pm --list`/`--json`
  behavior unchanged; help/footer render.
- Team 4: `swift build` + `swift test` if a toolchain exists (report if not).
