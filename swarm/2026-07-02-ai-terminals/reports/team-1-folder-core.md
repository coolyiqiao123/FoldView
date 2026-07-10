# Team 1 "folder-core" — report

Scope: `folder.mjs` (Phases A-D: AI terminals full spec, CLI bridge + managed registry, rebrand
copy inside folder.mjs, tests). Owned files only: `folder.mjs`, `test/**` (new).

## What shipped

### Phase A — AI terminals, full spec
- `KNOWN_AI_CLIS` table (Claude `c`, Codex `x`, Gemini `g`, OpenCode `o`, Aider `i`).
- `discoverAIClis()`: resolves known CLIs via `command -v` in Foldview's own env (no network, no
  shell-history), merges saved custom CLIs from `~/.foldview.json` `aiClis`, dedupes by resolved
  absolute path, assigns deterministic single-key shortcuts (`assignFreeKey`: own name's letters,
  then digits 1-9; entries with none stay in config but off the one-key menu).
- `resolveCustomCli()`: rejects empty input and shell metacharacters (`| & ; < > \` $ ( ) { }`
  newline), rejects relative paths, resolves bare names via `command -v`, validates absolute paths
  exist + are executable. Spaces are explicitly allowed (real paths can contain them).
- `state.ai = null | { project, phase: 'select-cli'|'custom-cli'|'select-count', choices, cli, input }`
  per spec. The `if (state.ai)` handler sits immediately after the search handler in `onKey`,
  consumes all input, `escape` works at every phase, `Ctrl-C` still quits the app, and it ends with
  `render(); return;`.
- `footerAi()`: same visual language as search/add-app; select-cli truncates the CLI list to
  terminal width (measured against the real `keyhints()` output, not an assumed separator width),
  always keeping `+ custom` / `esc cancel` when there's room; custom-cli shows the live buffer;
  select-count shows the chosen CLI name + `1-9` hint.
- `launchAITerminals` → `spawnAITerminals(project, cliEntry, n)`: macOS-only guard; re-validates
  the executable is still resolvable right before launch (never runs a different binary on
  failure); validates the project has a real local directory; builds
  `cd <shq path> && <shq exe>`; `computeGrid(n, screen)` (pure, `columns=ceil(sqrt(n))`,
  `rows=ceil(n/columns)` — this single formula also naturally yields "full area" for 1 and
  "side by side" for 2, with the final partial row sized like every other row); one detached
  `osascript` process creates all N windows via `do script`, collects references into an
  AppleScript list, applies the precomputed bounds only to those new windows, then activates
  Terminal; listens for both the child `error` event and non-zero exit, reporting
  `opened N × <name>` only on success and `could not open Terminal windows` otherwise — never
  throws, never crashes the TUI.
- `shq`/`asq` (POSIX single-quote / AppleScript double-quote escaping) are hoisted to module scope
  and reused by the CLI-bridge `action ai` path too.
- Copy: footer hints, `?` help overlay, and `printHelp()`/`pm --help` all describe AI terminals as
  "a detected or custom coding CLI," not just Claude/Codex.

### Phase B — CLI bridge + managed registry
- New subcommands (first-token dispatch, `pm [path]` / `--list` / `--json` / `--help` behavior is
  byte-for-byte unchanged when the first arg isn't one of these words):
  `pm status --format menubar-json`, `pm roots list|add|remove`,
  `pm action open|start|stop|editor|ai --project <dir> [...]`, `pm menubar [--force-install]`.
  All work without a TTY (verified via subprocess tests).
- `buildMenubarStatus()`: fast path only — `scanProjects()` (markers + mtime) and
  `lightProjectInfo()` (package.json + mtime), never `computeStats()`'s LOC/disk/git walk. Warm,
  in-process it's ~15-30ms; as a full `node folder.mjs status ...` subprocess (incl. Node startup)
  it's consistently well under the 500ms target — see Verification.
- `~/.foldview.json` gained `schemaVersion`, `roots`, `recentProjects`,
  `menubar:{refreshSeconds,showDiscoveredApps}`, `aiClis` per the frozen schema.
  `ensureConfigDefaults()` fills in only what's missing, so nothing is ever dropped.
  `writeConfig()` is atomic (tmp file + `rename`); `updateConfig(mutator)` is the read-merge-write
  helper every writer now goes through.
- Managed runtime registry at `~/Library/Application Support/Foldview/runtime-v1.json` (atomic
  writes), entries `{project, pid, pgid, port, startedAt, command, logFile, launcher}`.
  `validateOwnership()` checks PID alive → command line matches → cwd is the project or a child →
  port (if any) is owned by that tree; **fixed a real bug found while testing**: macOS's
  `/tmp → /private/tmp` symlink made `path.resolve`-only comparisons falsely reject legitimately-
  owned processes, so both sides are now compared via `fs.realpathSync` (`realpathSafe`, falls
  back to `path.resolve` if the path no longer exists). Any validation failure deletes the stale
  record and leaves the process alone; `pm action stop` on an unvalidated entry prints exactly
  `Foldview did not start this server` per spec, never sends a signal.

### Phase C — rebrand copy inside folder.mjs
Updated every user-facing surface inside this file: the TUI header wordmark (`gradient('foldview')`
+ small folder-emoji accent, no longer per-letter-gradiented "📁"-suffixed "project manager"), the
`renderHelp()` overlay banner, `printList()`'s banner, `runDev()`'s banner, and `printHelp()`
(now leads with the frozen tagline/short-description, documents `a` as opening "AI terminals" with
detected/custom CLIs, and adds an ADVANCED section for the new subcommands). Did **not** touch
`README.md`, `package.json`, `site/**`, the config filename, or any bin/package name — all
unchanged per the frozen brand constants.

### Phase D — tests
63 tests across 8 files in `test/` (all zero-dependency `node --test`, `.mjs`):
- `quoting.test.mjs` — `shq`/`asq` round-tripped through a real shell / `osascript` (spaces,
  apostrophes, double quotes, backslashes, Unicode, composed `cd && cli` strings).
- `grid.test.mjs` — `computeGrid` for n=1-9: in-bounds, n=1 full-area, n=2 side-by-side,
  `ceil(sqrt(n))×ceil(n/columns)` shape, uniform final-row sizing, no overlaps, clamping.
- `ai-discovery.test.mjs` — known-CLI discovery with a fully isolated, mocked PATH; deterministic
  shortcut collision resolution; custom-CLI rejection (shell metachars, empty, relative paths) and
  acceptance (spaces allowed); dedupe by resolved path; config merging preserves unrelated/unknown
  fields; the "no free key left" case (all 36 shortcuts exhausted → 37th entry stays in config,
  omitted from the menu).
- `spawn-ai.test.mjs` — `spawnAITerminals` with a fake `osascript` on an isolated PATH: success
  (zero exit), failure (non-zero exit), spawn `error` (non-executable binary), "never runs a
  different executable" (unresolvable CLI never invokes osascript at all), missing local directory.
- `config.test.mjs` — missing-file defaults, atomic tmp+rename (valid JSON, no stray `.tmp-`
  files), read-merge-write preservation, a simulated-concurrent-writers case (documents the honest
  last-writer-wins limit for fields touched by both writers, while asserting the file itself is
  never corrupted).
- `registry.test.mjs` — ownership validation against real short-lived subprocesses: alive+matching
  (owned), exited (stale, auto-removed), command mismatch, cwd mismatch, implausible/long-gone PID,
  no record at all (external listener), and the `/tmp → /private/tmp` symlink regression above.
- `menubar-status.test.mjs` — contract tests: missing roots (falls back to cwd), corrupt config
  (no crash, defaults), empty project list, a stale registry record (never reported `managed`), the
  exact frozen per-project field set, and the `aiClis` wire shape (`{name, executable}` only).
- `render.test.mjs` — footer fits at the 64-col minimum width and keeps top-priority hints;
  `footerAi` fits at 64/80/120 cols and always keeps `+ custom`/`esc cancel` when there's room,
  omits key-less entries, and renders each of the three phases correctly; non-color (ANSI-stripped)
  readability.
- `cli-surface.test.mjs` — subprocess-level (`node folder.mjs ...`, no TTY): `--help`/`--list`
  unchanged, `--json` preserves every historical field, `roots add/list/remove` persists and
  rejects bad input, `action editor`/`action ai` validate and report correctly, `status
  --format menubar-json` works with no TTY and comfortably meets the <500ms target (a strict
  faster-than-`--json` assertion was tried but is genuinely too noisy across two fresh Node process
  starts on a small fixture — logged via `t.diagnostic` instead of asserted).

Internals are exported behind the existing `PM_NO_MAIN` guard (unchanged mechanism — no
`import.meta.url` rework needed); `pm`/`pm --list`/`pm --json`/`pm --help` observable behavior is
identical before/after.

## Verification (evidence)

```
$ node --check folder.mjs
(exit 0)

$ node --test                     # bare auto-discovery — see note below
ℹ tests 63
ℹ pass 62
ℹ fail 0
ℹ skipped 1   (documented: non-darwin branch, this box is always darwin)

$ node folder.mjs --help          # banner + AI terminals description present, unchanged usage lines
$ node folder.mjs --list /tmp/x   # table renders, unchanged columns
$ node folder.mjs --json /tmp/x   # 2 rows; every historical field present (name, path, loc, files,
                                   # srcBytes, nodeModules, total, branch, dirty, devName, devCmd,
                                   # port, pkgName, mtime, langs, ...)
$ time (cd /tmp/x && node folder.mjs status --format menubar-json)
schemaVersion: 1 projects: 2
0.10s user 0.02s system 154% cpu 0.079 total   # ~79ms wall total, incl. Node startup
```

**Node CLI quirk (not our bug, but affects the `npm test` script):** on this box's Node v25.9.0,
`node --test test/` (and `node --test ./test`) fail immediately with a generic `'test failed'` —
Node appears to treat the bare directory positional as a test-name pattern rather than a path in
this version, and even errors with `ERR_UNSUPPORTED_DIR_IMPORT` under
`--experimental-test-isolation=none test/`. `node --test` (bare, auto-discovery) and
`node --test 'test/*.test.mjs'` both run the exact same 63 tests correctly. **Team 2**: the
`package.json` `"test"` script currently reads `"node --test test/"`, which reproduces this failure
(`npm test` currently fails on this box) — please change it to `"node --test"` (bare) so `npm test`
actually runs the suite; I can't edit `package.json` myself (your file).

## Known limitations / follow-ups worth knowing about

- `pm action start`'s recorded port is a best-effort guess (`frameworkPort()` — same heuristic the
  interactive TUI already uses for `next`/`vite`/`astro`/etc.), not confirmed against the server's
  actual log output the way the interactive `pollServer()` does. For a dev command whose port can't
  be inferred from `package.json` (e.g. a bespoke script with no `--port`/framework signature),
  `pm action stop` will conservatively refuse with `Foldview did not start this server` rather than
  ever risk killing the wrong thing — this matches the spec's mandated fallback for inconclusive
  validation, but real accuracy for non-framework dev commands could be improved later by adding a
  short bounded `readLogPort()`-based refinement to `actionStart`, mirroring `pollServer()`.
- `updateConfig`'s read-merge-write is not full snapshot isolation: two truly concurrent writers
  that touch the *same* field will still last-writer-win on that field (documented + tested); the
  atomic tmp+rename guarantee is only "the file is always valid JSON and unrelated fields survive,"
  not "no lost updates under a true race." Full safety would need file locking, which felt like
  scope creep for a zero-dependency CLI.
- The 3-phase `state.ai` `onKey` flow is exercised indirectly (its building blocks —
  `discoverAIClis`, `resolveCustomCli`, `spawnAITerminals`, `footerAi` — all have direct tests) but
  not via a scripted key-press integration test, since `onKey` calls `render()` which writes real
  ANSI bytes to stdout and can schedule an async follow-up render via `ensureStats`'s `setTimeout`;
  driving it safely in `node --test` would need stdout mocking that felt like more risk than value
  for the time available. `onKey` is exported for anyone who wants to add that later.
- Did not build a permanent `pm status` performance regression test with a hard "always faster than
  `--json`" assertion — two-fresh-Node-process wall-clock comparisons on a small fixture were
  observed to be within noise of each other (both ~60-70ms, dominated by process startup), so I
  kept the meaningful absolute `<500ms` assertion and switched the relative comparison to a logged
  diagnostic instead of a flaky hard assertion.

## Files touched

- `/Users/yc/Documents/Billa/folder.mjs` (only file I have write access to besides `test/**`)
- `/Users/yc/Documents/Billa/test/helpers.mjs` (new, shared test infra — no test() calls)
- `/Users/yc/Documents/Billa/test/quoting.test.mjs` (new)
- `/Users/yc/Documents/Billa/test/grid.test.mjs` (new)
- `/Users/yc/Documents/Billa/test/ai-discovery.test.mjs` (new)
- `/Users/yc/Documents/Billa/test/spawn-ai.test.mjs` (new)
- `/Users/yc/Documents/Billa/test/config.test.mjs` (new)
- `/Users/yc/Documents/Billa/test/registry.test.mjs` (new)
- `/Users/yc/Documents/Billa/test/menubar-status.test.mjs` (new)
- `/Users/yc/Documents/Billa/test/cli-surface.test.mjs` (new)
- `/Users/yc/Documents/Billa/test/render.test.mjs` (new)

No changes to `.git`, the spec, or any other team's files. Repo left with the same uncommitted
working-tree state as found (nothing committed, nothing reverted).
