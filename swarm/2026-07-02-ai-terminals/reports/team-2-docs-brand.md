# Team 2 (docs-brand) report

## What changed

### README.md (full rewrite)
- Title/opening paragraph now identify the product as **Foldview**, with the
  frozen tagline (`Your projects and AI coding tools, ready in one terminal.`)
  and frozen short description, using "terminal workspace and launchpad for
  vibe coding" category language. No surviving "project manager" / "folder
  viewer" identity language (verified by grep, see below).
- Added a local-first trust statement near the top (project discovery, CLI
  detection, and config stay on the machine; nothing uploaded).
- Quick start section: `git clone` + `npm link` (this package is not on the
  npm registry — no prior quick-start existed), plus the `node folder.mjs`
  direct-run path, showing value (press `↵` to launch) immediately.
- "What Foldview does" feature summary.
- ASCII mockup's header line changed from `project manager 📁` to
  `foldview 📁` (compact lowercase wordmark per the frozen brand constant)
  and its footer key-hint line now includes `a AI terminals`.
- Key table rewritten to match the **actual** `case` statements in
  `folder.mjs` (verified via `grep -n "case '" folder.mjs`): includes every
  bound key (`↑↓/jk`, `↵/l`, `g/G`, `d`, `D`, `x`, `o`, `e`, `a`, `A`, `s`,
  `c`, `/`, `r`, `?`, `q`). `a` is described as opening 1-9 AI terminals with
  a **detected or custom** coding CLI (not just claude/codex), per spec
  §"Rendering and documentation".
- New "Open AI terminals" section documenting the full flow (`a` → pick CLI
  or `+` custom → digit `1`-`9` → tiled windows → `opened N × <name>`
  status), the 5-CLI discovery table (c/x/g/o/i → claude/codex/gemini/
  opencode/aider) and the `command -v`/no-network discovery rule, and custom
  CLI persistence to `~/.foldview.json` under `aiClis` (dedup by resolved
  path).
- New "CLI bridge" section with the exact FROZEN subcommand surface (`pm
  status --format menubar-json`, `pm roots list/add/remove`, `pm action
  open/start/stop/editor/ai`, `pm menubar`), noting the fast-path status
  contract.
- New "macOS menu-bar companion (optional)" section: `mac/`, macOS 14+,
  SwiftUI, optional, Node CLI/TUI unaffected without it.
- Kept "Non-interactive output" (`pm --list` / `pm --json`) verbatim in
  contract, explicitly noting it is unchanged by the rebrand.
- Kept/renamed "How Foldview finds projects" (unchanged technical content).
- Added a "Configuration" section showing the frozen `~/.foldview.json`
  schemaVersion-1 shape (roots, recentProjects, menubar, apps, hidden,
  aiClis) and the read-merge-write/atomic-write guarantee.
- Kept the closing "No dependencies, no network calls — pure Node." claim.
- **Corrected a pre-existing inaccuracy**: the old README claimed `view` as
  a bin alias; `package.json`'s `bin` field has no `view` entry (it has
  `pm`, `folderpreview`, `project-manager`, `billa`). Quick start and
  install language now match the actual `bin` field exactly.

### package.json
- `description`: rewritten with the Foldview short description + accurate
  feature list (AI terminals now described as opening a detected-or-custom
  CLI, not just claude/codex).
- `keywords`: added `terminal workspace`, `launchpad`, `ai coding`, `vibe
  coding`, `local-first`, `tui`; kept prior discoverability keywords (`cli`,
  `dashboard`, `projects`, `loc`, `project-manager`).
- `scripts`: added `"test": "node --test test/"` (Team 1 owns `test/`);
  `"start"` untouched.
- `name`, `bin`, `version`, `type`, `engines`, `license` — **unchanged**, as
  required.

## Verification evidence

```
$ node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('valid JSON')"
valid JSON

$ grep -n -i "project manager\|folder viewer\|view.*as.*alias" README.md
(no output — exit 1, i.e. no matches)

$ grep -c '^```' README.md
18   # even → all fences balanced
```

Key table and AI-CLI/flow copy were checked directly against
`folder.mjs`'s `case '...':` block (onKey handler, ~line 1144-1170) and the
frozen GLOBAL-CONTEXT.md contract, not assumed.

## Note on current vs. target state

At the time of writing, `folder.mjs` (Team 1, in progress — CLAIMS.jsonl
shows a `start` event, no `done` yet) still implements only claude/codex for
AI terminals and has not yet added the `pm status|roots|action|menubar`
subcommands or the "foldview" TUI wordmark. Per the task brief, README.md
and package.json were written against the **frozen target contract** that
Team 1 is implementing concurrently (GLOBAL-CONTEXT.md §CLI bridge, §Known
AI CLIs), not the current partial `folder.mjs` state. No claims were
invented beyond that frozen contract.

## Leftovers / requests for other teams

- None blocking. If Team 1 ends up deviating from the frozen CLI bridge
  subcommand names/flags or the 5-CLI discovery table, please flag it in
  your report — README.md and package.json would need a follow-up patch to
  stay accurate.
- Team 3 (site-brand): please keep `site/index.html` copy consistent with
  the README's tagline/short-description/category wording so the product
  reads as one voice (per spec §Acceptance criteria: "footer, help overlay,
  CLI help, and README describe the feature consistently").
