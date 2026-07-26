# Menu bar install + localhost-detection upgrade + cleanup — design

**Date:** 2026-07-11 · **Repo:** `~/Documents/foldview` · **Status:** executed autonomously (user asked tersely: "add and create menu bar, clean up code, improve the localhost detection"); recommended defaults chosen, interactive approval not possible.

## Context

- `folder.mjs` — single-file, zero-dependency Node ≥18 ESM TUI (~2,200 lines). This is its identity; it stays one file.
- `mac/` — complete SwiftPM `MenuBarExtra` companion (source + swift-testing suite) from the 2026-07-02 swarm, but **no install path**: `pm menubar` is a stub that just prints "not installed yet".
- Localhost detection probes a **fixed list of 18 COMMON_PORTS** (`folder.mjs:820`) with a TCP connect each, then shells out to `lsof` **twice per live port** (cwd) and once more per discovered port (`ps` comm). Servers on any unlisted port (e.g. `:8899`, `:37701`-style app ports are special-cased) are invisible; `::1`-only listeners are missed.
- Working tree has uncommitted edits from concurrent sessions (wordmark/`caution` color polish, `liveServerFor` app-port guard, `test/port-attribution.test.mjs`, big `site/index.html` work). **Preserve all of it; never touch `site/`.**
- Baseline: `npm test` → 90 tests, 89 pass, 1 skip, 0 fail.

## Approaches considered

1. **Detection: enumerate-all via one `lsof` sweep (chosen).** `lsof -nP -iTCP -sTCP:LISTEN` once → every listening port + pid + command + bind addr; one batched `lsof -a -p <pids> -d cwd` for owners. 2 shell-outs total (vs ~2×N), finds *every* port, covers IPv6/wildcard binds. Fallback to the existing probe list when `lsof` is unavailable (win32 / stripped Linux).
2. Detection: widen COMMON_PORTS + parallel probes — rejected: still guess-based, still misses arbitrary ports, more sockets each tick.
3. Menu bar: ship a prebuilt binary — rejected: no signing/notarization pipeline; building locally from `mac/` with the user's toolchain is honest and zero-dep.
4. Cleanup: split folder.mjs into modules — rejected: single-file is the product's stated identity (`bin` points at it); cleanup is dedupe/dead-code/comment-accuracy instead.

## Design

### 1. `pm menubar` — real install/launch flow (folder.mjs, darwin-only)
- `pm menubar` (no flags): if `~/Applications/FoldviewMenuBar.app` exists and is current → launch it (`open`). Else behave like `--force-install`.
- Install: `swift build -c release` in `mac/` → assemble bundle: `Contents/MacOS/FoldviewMenuBar` (copied binary), generated `Contents/Info.plist` (`LSUIElement=true`, `CFBundleIdentifier=com.foldview.menubar`, version from package.json), `PkgInfo`. Write CLI path to `~/Library/Application Support/Foldview/cli-path-v1` (atomic tmp+rename, absolute path to this `folder.mjs`). Then `open` the app.
- `--status` prints installed/not + paths; `--force-install` rebuilds unconditionally. No swift toolchain → actionable error, exit 1. Non-darwin → clear "macOS only" error.
- Bundle assembly is a pure plan function (`buildMenubarInstallPlan(...)` returning steps/paths) so tests cover it without a Swift toolchain; the command executes the plan.
- New `pm config get <key>` / `pm config set <key> <value>` for the frozen `menubar.refreshSeconds` / `menubar.showDiscoveredApps` config block — closes the documented bridge gap (mac/README "Known gaps") so Settings can persist cross-process. Validation: refreshSeconds integer 5–3600, showDiscoveredApps boolean.
- Help text updated; `SUBCOMMANDS` gains `config`.

### 2. Localhost detection upgrade (folder.mjs port-scan block)
- New `parseLsofListeners(text)` **pure function**: parses `lsof -nP -iTCP -sTCP:LISTEN -F pcn` field output → `[{port, pid, comm, addr}]`; folds IPv4/IPv6 dupes by port; keeps only loopback-reachable binds (`127.0.0.1`, `::1`, `*`, `0.0.0.0`, `[::]`).
- `scanPorts()`: one `sh(lsof …)` enumeration + one batched `lsof -a -p p1,p2,… -d cwd -Fn` → `Map port → {cwd, comm}` (shape stays compatible: existing callers read owner cwd; comm rides along so `mergeDiscovered` stops shelling out per port). Ports the enumeration finds but pid/cwd can't resolve keep `''` owner (existing semantics).
- Fallback: if the sweep errors/returns nothing where the probe finds something (no lsof), fall back to the current `checkPort` probe over `COMMON_PORTS ∪ appPorts` — behavior identical to today off-macOS.
- Discovered-app filter: skip ports < 1024 (system services) for *discovered* entries only (project attribution still works on any port); extend `SYSTEM_PROCS` conservatively (e.g. `AirPlayUIAgent`, `assistantd`, `bluetoothd`, `commerced`).
- `readLogPort`: also match `0.0.0.0:PORT`, `[::]:PORT`, and `http://<anyhost>:PORT`; keep last-match-wins so the final bound port survives auto-increment.
- `portCwd`/`portComm` remain as single-port helpers (used by tests/one-offs) but the hot path no longer loops them.
- Tests: unit-test `parseLsofListeners` with real lsof `-F` transcripts (v4+v6 dupes, wildcard binds, multi-pid), `readLogPort` new patterns, and keep `port-attribution.test.mjs` green; e2e test spins a throwaway `net` server on an uncommon port with cwd inside a temp project and asserts attribution.

### 3. Cleanup (folder.mjs + repo hygiene, no behavior change)
- Deduplicate the three separate `lsof`-pid lookups around the new scanner; remove superseded per-port shell-outs.
- Sweep stale comments (e.g. references to removed features), sync `printHelp` with actual surface, fix header comment drift.
- No renames of public surface (`pm`/`foldview` bins, subcommands, JSON schema stay frozen). `package.json` name stays `folderpreview` (published-identity change is a user decision — flagged in Next).
- **Out of scope:** `site/`, `web/`, committing anything, npm publish, signing/notarization.

### Error handling
Every shell-out stays behind `sh()` timeouts; lsof absence, swift absence, unwritable `~/Applications`, and stale bundles all degrade to actionable messages, never crashes. The TUI tick must never block > current behavior (the sweep is strictly fewer subprocesses).

### Testing / verification gates
1. `npm test` fully green (≥ current 89 pass, 1 skip; new tests added).
2. `swift build` + `swift test` (with the CLT `-F` flags from mac/README) green in *this* checkout.
3. Live e2e: real server on an unlisted port detected + attributed; `pm status --format menubar-json` still valid schema v1.
4. Multi-agent adversarial review of the diff before completion.

## Execution plan
Sequential on the shared file, parallel elsewhere: (A) Swift build/test fix-up in `mac/` ∥ (B) detection rewrite in folder.mjs → (C) menubar install + `pm config` in folder.mjs → (D) cleanup pass → (E) parallel review + adversarial verify → (F) e2e verification. Agents use anchor-based edits only (concurrent-session safety) and never commit.
