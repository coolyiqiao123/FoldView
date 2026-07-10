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

There is no bundled `.app` for local development — `FoldviewMenuBar` is a plain
SwiftPM executable, so `swift run` launches it as a normal foreground process
rather than a proper `LSUIElement` accessory app. `FoldviewAppDelegate` compensates
by calling `NSApp.setActivationPolicy(.accessory)` on launch, which removes the
Dock icon/app-switcher entry the same way `LSUIElement = true` would for an
installed `.app` bundle. When Phase 7 (Distribution) ships a real `.app` bundle
with an `Info.plist`, set `LSUIElement = true` there and this call becomes
redundant (harmless either way).

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
   `cli-path-v1` (atomic tmp-file + rename) so the next launch skips the scan.

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

## Known gaps vs. the full spec (by design, not oversight)

- **Settings → General (`refreshSecondsSetting`, `showDiscoveredApps`)** are
  stored in `UserDefaults`/`@AppStorage` only. The frozen `~/.foldview.json`
  schema has a `menubar: { refreshSeconds, showDiscoveredApps }` section, but
  the frozen CLI bridge subcommand surface only exposes read/write for
  `roots`, not for the `menubar` config block. Swift intentionally does not
  become a second writer of `~/.foldview.json` (per spec), so full
  cross-process persistence of these two settings needs a CLI subcommand
  (e.g. `pm config set menubar.refreshSeconds <n>`) that does not exist yet.
- **Settings → CLI → custom AI CLI management**: the CLI bridge now exposes
  `pm aiclis list [--json] | add <name|abs-path> | remove <name|abs-path>`
  (mirroring the TUI's `+` custom-CLI flow and reusing the same
  validate/resolve/save helpers in `folder.mjs`), so a future menu-bar
  Settings → CLI window can become read-write by shelling out to it instead of
  only mirroring `pm status`. Wiring that UI up is still to do; the subcommand
  is the missing piece it was blocked on.
- **Launch at login** (`SMAppService.mainApp.register()`) compiles and is
  wired to the Settings toggle, but `SMAppService` registration is only
  meaningful for an installed, bundled `.app` — it cannot be manually verified
  against a bare `swift run` binary. Untested beyond "compiles and calls the
  documented API."
- **Signing, notarization, installer/upgrader, checksum verification, Mac App
  Store distribution, a permanent daemon** — explicitly out of scope per the
  spec's Phase 7 and "Out of scope" section. Nothing here attempts them.
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
│   ├── AppStore.swift               @MainActor state, refresh coalescing, actions
│   ├── CLI/FoldviewCLI.swift        process adapter (literal argv, typed errors)
│   ├── Data/MenuBarPayload.swift    Codable models for the frozen JSON schema
│   ├── Data/ProjectRowModel.swift   status symbol/text derivation, path shortening
│   ├── Theme/FoldviewTheme.swift    baby-blue identity, light/dark dynamic colors
│   └── Views/
│       ├── MenuBarContent.swift     popover: header, live/recent, onboarding, footer
│       ├── ProjectRow.swift         one project row + explicit actions
│       ├── AIQuickLaunch.swift      CLI + window-count picker
│       └── SettingsView.swift       roots, general, CLI path/repair
└── Tests/FoldviewMenuBarTests/      swift-testing (see "Running tests" above)
```
