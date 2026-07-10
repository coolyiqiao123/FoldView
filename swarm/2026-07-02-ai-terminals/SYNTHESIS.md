# SYNTHESIS — Foldview rebrand + AI terminals swarm (2026-07-02)

Swarm: `swarm-1782999817185-e4n7vg` (hierarchical/specialized; 4 worker teams + reconciler).
Spec: `docs/superpowers/specs/2026-07-02-ai-terminals-design.md`. All work UNCOMMITTED on `main`.

## Outcome: all 4 teams delivered; reconcile pass green

| Team | Scope | Result |
| --- | --- | --- |
| 1 folder-core | folder.mjs + test/ | AI terminals to full spec, CLI bridge, runtime registry, in-TUI rebrand; 63 tests |
| 2 docs-brand | README.md, package.json | Foldview identity, frozen tagline, key table, bridge docs, config schema |
| 3 site-brand | site/index.html | Rebrand + AI-terminals flagship card; fixed real bugs (install cmd `foldview`→`folderpreview`, dead repo links → real `lazyproj` remote) |
| 4 mac-companion | mac/ (new) | SwiftPM MenuBarExtra companion per frozen contracts; swift build clean |

## Independent verification (re-run by reconciler, not team self-reports)

- `npm test` → **63 tests: 62 pass, 0 fail, 1 skipped** (documented non-darwin branch).
- `node --check folder.mjs` OK; `pm --help` shows foldview wordmark, tagline, `a` docs, full bridge surface.
- `pm status --format menubar-json` → valid schemaVersion-1 payload in **0.06 s** (target < 0.5 s); no LOC/disk/git walks.
- `pm roots list --json` → `[]` (works, TTY-independent).
- `swift test` (bare-CLT invocation documented in mac/README.md) → **36/36 pass in 5 suites**, incl. literal-argv/no-shell-source proof with hostile path `; $() # " \ '`.
- `git status` → only expected files: M README.md folder.mjs package.json site/index.html; ?? docs/ mac/ swarm/ test/. No ownership violations.

## Reconciler fixes applied after team reports

1. package.json `test` script `node --test test/` → `node --test` (Node v25 treats a bare
   directory positional as a name pattern; flagged by Team 1).
2. folder.mjs `--help` stale alias list `project-manager, view` → `folderpreview, project-manager, billa`
   (bins were renamed `view`→`billa` in the working tree, apparently by a concurrent session mid-swarm).

## Notable engineering finds

- Team 1: macOS `/tmp`→`/private/tmp` symlink made path.resolve-only ownership comparison
  falsely reject owned processes — fixed with `fs.realpathSync` both sides + regression test.
- Team 4: on bare Xcode CLT, `swift test` silently runs ZERO tests and exits 0 unless the
  swift-testing framework `-F` path is passed on the CLI too — reliable invocation in mac/README.md.

## Documented judgment calls / known gaps (not silent failures)

- mac: “Open Foldview” uses one narrow osascript in Swift (no bridge subcommand exists for
  “open bare TUI window”); acceptable reading of the spec — future `pm action open-tui` could replace it.
- mac Settings: refresh-interval/show-discovered-apps are UserDefaults-only (no `menubar` config
  subcommand yet); custom-CLI management read-only (no `pm aiclis add`). Candidate bridge additions.
- SMAppService launch-at-login + sheet-from-popover compile but need an installed .app / display to verify.
- Out of scope per spec: signing, notarization, installer/upgrader, Mac App Store.

## What remains (needs a human / macOS GUI)

1. Manual test plan §Manual on macOS: `a`→CLI→count flows, tiling with 2/3/9 windows, paths with
   spaces/apostrophes, Automation-permission denial recovery, menu-bar onboarding, VoiceOver.
2. Commit the working tree (4 modified + 3 new dirs) — nothing is committed.
3. Optional: `pm menubar` install flow is a stub; distribution phase not built.
