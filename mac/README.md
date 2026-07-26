# FoldviewMenuBar

A native macOS menu-bar companion for [Foldview](../README.md). It is a thin
presentation layer over the same `pm` CLI the TUI uses — it never rescans
projects, never writes `~/.foldview.json` directly, and never launches AppleScript
for the multi-window AI-terminal grid (that stays in `folder.mjs`). See
`../docs/superpowers/specs/2026-07-02-ai-terminals-design.md` §"macOS menu-bar
companion" for the full product spec and
`../swarm/2026-07-02-ai-terminals/GLOBAL-CONTEXT.md` for the frozen CLI/JSON
contracts this target is built against.

## Requirements

- macOS 14+
- Swift 5.9+ toolchain (developed against Swift 6.3.2)

## Dev workflow

```sh
cd mac
swift build
```

`swift run` launches the SwiftPM executable as a normal foreground process
rather than a proper `LSUIElement` accessory app. `FoldviewAppDelegate` compensates
by calling `NSApp.setActivationPolicy(.accessory)` on launch, which removes the
Dock icon/app-switcher entry the same way `LSUIElement = true` would for an
installed `.app` bundle. For a real local bundle, run `pm menubar` or
`./Packaging/package-app.sh`; it release-builds, validates, ad-hoc signs, verifies,
and installs exactly `~/Applications/Foldview.app`. The packager rejects symlinked
or unsafe user install ancestry, stages in a private random directory on the same
volume, and uses a single atomic rename (new install) or `RENAME_SWAP` (upgrade),
so an upgrade never creates an absent-target window. Ad-hoc signing is local-use
signing only, not Developer ID signing or notarization.

### Pointing dev builds at a local `pm`

`FoldviewCLI` resolves the absolute `pm` executable in this order:

1. `FOLDVIEW_CLI_PATH` environment variable, if set and executable — this is the
   explicitly allowed local override for development, e.g.:

   ```sh
   FOLDVIEW_CLI_PATH=/Users/you/Documents/foldview-cli/folder.mjs swift run
   ```

   (`folder.mjs` has a `#!/usr/bin/env node` shebang and is already `chmod +x`,
   so `Process` can execute it directly — no `node` prefix needed.)
2. `~/Library/Application Support/Foldview/cli-path-v1` — a one-line absolute
   path recorded by a real install (`pm menubar`).
3. A small fixed list of expected npm/Homebrew locations (`/opt/homebrew/bin/pm`,
   `/usr/local/bin/pm`, `~/.npm-global/bin/pm`, `~/.volta/bin/pm`,
   `~/Library/pnpm/pm`). The first one found is persisted back to
   `cli-path-v1` (atomic 0600 tmp-file + rename for both first creation and
   replacement) so the next launch skips the scan.

If none resolve, every CLI call throws `CLIError.executableNotFound` and the
Settings → CLI tab shows a repair prompt instead of a project list.

## Running tests

```sh
swift test
```

**Environment note:** this target was developed against a bare Xcode Command
Line Tools install (no full Xcode, no `xcodebuild`). In that configuration
`Testing.framework` (swift-testing) lives outside SwiftPM's default search
paths, and — for reasons that look like a SwiftPM/toolchain interaction bug
rather than anything in this package — `swift test` silently runs zero tests
and exits 0 unless the same `-F` search path is *also* passed on the `swift
test` command line itself (embedding it in `Package.swift`'s target settings,
which is done here, is necessary for the built test bundle to dlopen its rpath
dependencies, but is not sufficient on its own). The reliable invocation is:

```sh
swift test \
  -Xswiftc -F -Xswiftc /Library/Developer/CommandLineTools/Library/Developer/Frameworks \
  -Xlinker -F -Xlinker /Library/Developer/CommandLineTools/Library/Developer/Frameworks
```

On a machine with full Xcode installed, `Testing` resolves through the normal
toolchain paths and plain `swift test` should work without any of this — the
rpaths baked into `Package.swift` point at a Command Line Tools-only location
and are simply unused there (a missing `-F`/`-rpath` target is not an error).

## What this target does and does not do

Per the spec, the Swift target is presentation, payload decoding, and
process-launch adapters only:

- `Data/MenuBarPayload.swift`, `Data/ProjectRowModel.swift` — decode and present
  the frozen `pm status --format menubar-json` schemaVersion-1 payload. Decoding
  is forward-compatible: unknown JSON keys are ignored, unrecognized `kind`
  values fall back to `.unknown(rawValue)`, and every field the schema marks
  optional tolerates being absent.
- `CLI/FoldviewCLI.swift` — the only place that spawns a process. Every call
  uses `Process` with `executableURL` + a literal `arguments: [String]` array —
  never `/bin/sh -c` with a built string. `CLIAction.arguments` is a pure
  function from case to argv, independently unit-tested.
- `AppStore.swift` — owns all `@Published` state on `@MainActor`; process spawn
  and JSON decode happen inside the `FoldviewCLI` actor, off the main actor.
  Refreshes are generation-counted so concurrent calls coalesce and a slow,
  superseded response can never clobber a newer one.
- `Views/*` — SwiftUI only. No second project scanner and no AppleScript for the
  AI-terminal grid; `AIQuickLaunch` calls `pm action ai`, which owns the
  multi-window tiling logic in `folder.mjs`.

### One narrow, intentional exception: `Open Foldview`

The footer's `Open Foldview` button launches a single (non-tiled) Terminal.app
window in the configured root running the resolved `pm` executable. This is
different from the multi-window AI-terminal launch and does not duplicate its
grid math, but it does need *something* to tell Terminal.app to run a command,
and there is no CLI subcommand in the frozen bridge for "open a TUI window."
`FoldviewCLI.openFoldviewInTerminal(root:)` does this with a single
`/usr/bin/osascript -e <script>` call (literal two-element argv, not
`/bin/sh -c`), where the embedded AppleScript source is built from
`FoldviewCLI.posixQuote` (shell-quotes the `cd` command) and
`FoldviewCLI.appleScriptQuote` (escapes the result for the AppleScript string
literal) — both are round-trip tested against the real interpreter in
`CLIActionArgumentsTests`. If this is unwanted scope for the menu-bar target,
the alternative is adding a `pm menubar-open` (or similar) subcommand to the
bridge that does the same thing Node-side.

## Notch Nook: notch panel, agent approvals, and fan control

Beyond the `MenuBarExtra` popover, the app runs a click-to-open panel anchored
to the MacBook notch (`Notch/NotchPanelController.swift` — a borderless,
non-activating `NSPanel` positioned from `NSScreen.safeAreaInsets` /
`auxiliaryTopLeftArea`; on notchless screens it anchors top-center). The closed
state is a slim pill (`◆ <active agents> · $<today burn>`); clicking it expands
four tabs:

- **Agents** — every detected LLM agent (Claude Code, Kimi Code, Codex,
  claude-flow daemons) from `pm agents --json`, as rounded-rectangle cards with
  one role pill per role, current action, and last-activity time. Pending
  approval requests pin to the top with **Approve** / **Deny**.
- **Foldview** — the same project list as the popover (shared
  `ProjectSectionsView`).
- **Burn** — `pm burn --json`: per-CLI token/cost rollups, 7-day chart, coding
  time (wall-clock segments over all three CLIs' transcripts), Codex plan
  quota, GitHub commit contributions.
- **Fans** — MacBook fan telemetry and control (see "Fan privilege model").

### Approval bridge (`Bridge/NotchBridgeServer.swift`)

The app hosts a loopback-only HTTP server (NWListener on `127.0.0.1`, ephemeral
port, per-launch bearer token). Port + token + pid are written atomically
(0600) to `~/Library/Application Support/Foldview/notch-bridge-v1.json`, which
is how the CLI hook shim (`pm hook-bridge`, installed into Claude Code /
Kimi Code hook configs by `pm hooks install`) finds it. Routes:

- `POST /event` (Bearer) — fire-and-forget hook events (SessionStart/Stop,
  SubagentStart/Stop, Notification, Kimi `PermissionRequest`/`Result`); feeds
  the Agents tab activity list and Kimi's display-only pending cards.
- `POST /approve` (Bearer) — Claude Code `PreToolUse` only. The request is held
  open up to 240s; clicking Approve/Deny in the panel responds
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":…}}`,
  which `pm hook-bridge` prints to stdout for Claude to consume. Timeout or
  dismissal → `204`, the shim prints nothing, and Claude falls back to its
  normal in-terminal prompt. Every failure path is fail-open: if the app is
  not running, hooks behave as if they were never installed.
- `GET /health` — `{"ok":true}`. Everything else 404s; bad/missing auth 401s.

Remote approve/deny is only possible for **Claude Code** (its PreToolUse hooks
support permission decisions). Kimi Code hooks fire *before* permission checks
and cannot approve, so Kimi approvals are display-only; Codex has no hook
surface at all.

### Fan privilege model (`Fans/`)

macOS 26 blocks SMC value reads for unprivileged processes (GetKeyInfo and key
enumeration work; reads return empty). Fan telemetry therefore comes from a
root helper: clicking **Enable fan access** in the Fans tab re-executes the app
binary once per app session as `--fan-daemon <appPid>` through
`/usr/bin/osascript -e 'do shell script "…" with administrator privileges'`
(one macOS password prompt). The daemon tries SMC reads as root, falls back to
parsing `powermetrics --samplers smc`, and writes
`fan-state-v1.json` (2s cycle, atomic) which the app reads. Speed changes go
the other way through `fan-command-v1.json` (SMC `F<i>Tg`/`FS! ` writes, typed
per the key's reported format — `flt ` on M-series, `fpe2` on Intel). The
daemon exits when the app does (parent-pid watch, 24h cap) and removes its
state file. If neither SMC nor powermetrics yields data (possible on future
silicon), the tab degrades to an explicit "unavailable on this Mac" state.
Legacy one-shot `--fan-write`/`--fan-auto` helper modes remain for diagnostics.
No kext, no SMJobBless, no sudoers edits.

## Remaining distribution and manual-verification gaps

- **Settings → General and custom AI CLI management** now use `pm config` and
  `pm aiclis`; Swift remains a presentation layer and never writes
  `~/.foldview.json` itself. Changing the refresh interval restarts the live
  timer, and changing discovered-app visibility refreshes Node-backed status.
- **Launch at login** (`SMAppService.mainApp.register()`) compiles and is
  wired to the Settings toggle, but `SMAppService` registration is only
  meaningful for an installed, bundled `.app` — it cannot be manually verified
  against a bare `swift run` binary. Untested beyond "compiles and calls the
  documented API."
- **Developer ID signing, notarization, checksum-backed remote updates, Mac App
  Store distribution, a permanent daemon** remain out of scope. The included
  packaging script performs ad-hoc signing for local installation only.
- **Sheets from a `MenuBarExtra(.window)` popover** (`AIQuickLaunch`) compile
  against the documented SwiftUI API but could not be visually verified in
  this headless environment — there is no attached display to actually open
  the menu-bar item and click through the flow. Worth a manual pass per the
  spec's "Manual on macOS" test plan (items 2, 9, 12, 13 in particular) before
  shipping.

## Native project layout

```text
mac/
├── Package.swift
├── README.md                        (this file)
├── Sources/FoldviewMenuBar/
│   ├── FoldviewApp.swift            MenuBarExtra scene + accessory lifecycle
│   │                                (+ fan-write helper mode, notch startup)
│   ├── AppStore.swift               @MainActor state, refresh coalescing, actions
│   ├── CLI/FoldviewCLI.swift        process adapter (literal argv, typed errors)
│   ├── Data/MenuBarPayload.swift    Codable models for the frozen JSON schema
│   ├── Data/AgentsPayload.swift     `pm agents --json` models (tolerant decode)
│   ├── Data/BurnPayload.swift       `pm burn --json` models (sections optional)
│   ├── Data/FanModels.swift         FanReading + fan write errors
│   ├── Data/ProjectRowModel.swift   status symbol/text derivation, path shortening
│   ├── Bridge/NotchBridgeServer.swift  loopback HTTP bridge for agent approvals
│   ├── Fans/                        SMC wrapper, root fan daemon, state/command file protocols
│   ├── Notch/                       click-to-open notch panel + 4 tabs
│   ├── Stores/                      @MainActor stores: agents, burn, fans, activity
│   ├── Theme/FoldviewTheme.swift    baby-blue identity, light/dark dynamic colors
│   └── Views/
│       ├── MenuBarContent.swift     popover: header, live/recent, onboarding, footer
│       ├── ProjectSectionsView.swift  project-list body shared by popover + notch tab
│       ├── ProjectRow.swift         one project row + explicit actions
│       ├── AIQuickLaunch.swift      CLI + window-count picker
│       └── SettingsView.swift       roots, general, CLI path/repair
└── Tests/FoldviewMenuBarTests/      swift-testing (see "Running tests" above)
```
