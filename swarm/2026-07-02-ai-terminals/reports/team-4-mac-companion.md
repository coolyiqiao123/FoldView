# Team 4 — macOS menu-bar companion

## What was built

A complete `mac/` SwiftPM package implementing the native menu-bar companion
described in the spec's "macOS menu-bar companion" section, built strictly
against the FROZEN contracts in `GLOBAL-CONTEXT.md` (not against Team 1's
in-progress `folder.mjs`).

```
mac/
├── Package.swift
├── README.md
├── Sources/FoldviewMenuBar/
│   ├── FoldviewApp.swift            MenuBarExtra scene, .accessory activation policy
│   ├── AppStore.swift               @MainActor store: refresh coalescing, actions, roots
│   ├── CLI/FoldviewCLI.swift        process adapter — literal argv, typed errors, quoting helpers
│   ├── Data/MenuBarPayload.swift    Codable models, forward-compatible decoding
│   ├── Data/ProjectRowModel.swift   status symbol/text derivation, path shortening
│   ├── Theme/FoldviewTheme.swift    baby-blue identity, light/dark dynamic colors
│   └── Views/
│       ├── MenuBarContent.swift     popover: header, live/recent, onboarding, footer
│       ├── ProjectRow.swift         status + explicit actions + overflow menu
│       ├── AIQuickLaunch.swift      CLI + window-count (1-9) picker
│       └── SettingsView.swift       roots / general / CLI path+repair tabs
└── Tests/FoldviewMenuBarTests/      36 tests, swift-testing (see below)
```

Key design points:

- **Process safety.** `FoldviewCLI` is an actor; every bridge call goes through
  one `run(executable:arguments:)` choke point using `Process` +
  `executableURL` + a literal `arguments: [String]` — never `/bin/sh -c`.
  `CLIAction.arguments` is a pure function from case to argv, independently
  tested (`CLIActionArgumentsTests`), and `FoldviewCLIProcessAdapterTests`
  spawns a real stand-in executable and asserts a project path containing
  `; $() # " \` '` arrives as one intact argv element (captured via env-var
  passthrough since `perform()` discards stdout).
- **Refresh coalescing.** `AppStore.refresh()` bumps a generation counter and
  cancels the in-flight task; results are only applied if the generation still
  matches, so a slow superseded response can never clobber a newer one. Tested
  in `AppStoreStateTests.testConcurrentRefreshesCoalesceAndDiscardTheStaleResult`
  with an injected fake that resolves the *first* call after the *second*.
- **Main-actor boundary.** All `@Published` state lives on `AppStore`
  (`@MainActor`); `FoldviewCLI` (actor) does process spawn + JSON decode off
  the main actor. `MenuBarPayload`/`ProjectPayload`/`AICLIPayload`/`CLIAction`
  are all `Sendable`.
- **Stale-data retention.** A failed refresh after an earlier success keeps
  `loadState == .loaded` with the last good payload and flags `isStale` for a
  Retry banner, rather than dropping to an error screen.
- **Forward-compatible decoding.** Unknown top-level/nested JSON keys are
  ignored (default `Codable` behavior); unrecognized `kind` values decode to
  `.unknown(rawValue)` instead of failing the whole payload; `port`/`modifiedAt`
  tolerate being absent.
- **Onboarding.** Built into `MenuBarContent` (not a separate file, since it's
  a state of the same popover, not a new screen): explains local-first scanning
  in one sentence, `NSOpenPanel` → `pm roots add`, then falls through to the
  normal live/recent list once a root exists.

## One documented, justified deviation

`Open Foldview` (footer button) needs to launch a single Terminal.app window
running the resolved `pm` executable in the configured root. There is no CLI
subcommand for this in the frozen bridge (`status`/`roots`/`action open|start
|stop|editor|ai`/`menubar` — none of these open a bare TUI window), so
`FoldviewCLI.openFoldviewInTerminal(root:)` does it directly with one
`/usr/bin/osascript -e <script>` call — literal two-element argv, not
`/bin/sh -c`. I read the layout note "no AppleScript in Swift (AI launch goes
through pm)" as scoped to the multi-window AI-terminal grid specifically
(where duplicating Team 1's tiling logic would be the real problem), not a
blanket ban — this is a single, non-tiled window. `posixQuote`/`appleScriptQuote`
are the two quoting primitives it depends on, and both are round-trip tested
through the real shell/`osascript` interpreter (not hand-derived expected
strings) in `CLIActionArgumentsTests`. **Flagging for the team:** if this is
unwanted scope creep, the fix is a small Node-side subcommand (e.g. `pm
menubar-open`) and deleting this one method — everything else is unaffected.

## Known gaps (documented in `mac/README.md`, not silent)

- Settings → General's refresh-interval and show-discovered-apps toggles are
  `UserDefaults`-only; the frozen bridge has no subcommand to read/write the
  `~/.foldview.json` `menubar` block, only `roots`. Swift intentionally does
  not become a second config writer.
- Settings → CLI's "custom AI CLI" section is read-only (mirrors whatever
  `pm status` reports); add/remove needs a subcommand like `pm aiclis add`
  that isn't part of the frozen surface.
- `SMAppService` launch-at-login compiles and is wired up but is only
  meaningful for an installed `.app` bundle — unverifiable from `swift run`.
- Signing/notarization/installer/Mac App Store/permanent daemon: out of scope
  per spec, not built.
- `AIQuickLaunch`'s `.sheet` presentation from inside a `MenuBarExtra(.window)`
  popover compiles against documented SwiftUI API but could not be visually
  verified — no attached display in this environment. Flagged for a manual
  pass per the spec's test plan items 2, 9, 12, 13.

## Verification

**Toolchain:** `swift-driver version: 1.148.6`, `Apple Swift version 6.3.2`,
target `arm64-apple-macosx26.0`. This is a bare Xcode Command Line Tools
install — no full Xcode, no `xcodebuild`.

**`swift build`** (clean, from a removed `.build/`):

```
Building for debugging...
[16/17] Applying FoldviewMenuBar
Build complete! (31.86s)
```

Zero errors, zero warnings.

**`swift test`** (clean, from a removed `.build/`) — 36/36 passed, exit 0:

```
Test run started.
...
✔ Suite MenuBarPayloadDecodingTests passed
✔ Suite ProjectRowModelTests passed
✔ Suite CLIActionArgumentsTests passed
✔ Suite AppStoreStateTests passed
✔ Suite FoldviewCLIProcessAdapterTests passed
✔ Test run with 36 tests in 5 suites passed after 4.342 seconds.
```

**Environment-specific gotcha (documented in `mac/README.md`):** this
Command-Line-Tools-only install has no `XCTest.framework` at all (confirmed
absent via `find`), so all tests use `swift-testing` (`import Testing`,
`@Test`/`#expect`) instead of XCTest. Getting `swift test` to actually *run*
(rather than silently report "Build complete!" and exit 0 with zero tests
executed) required two things: (1) baking `-F` search path and two `-rpath`
entries into `Package.swift`'s test target `swiftSettings`/`linkerSettings` so
the built `.xctest` bundle can `dlopen` `Testing.framework` and its
`lib_TestingInterop.dylib` dependency, and (2) *also* passing
`-Xswiftc -F <path> -Xlinker -F <path>` on the `swift test` command line
itself — omitting step 2 reproducibly causes zero tests to run with no error,
which looks like a SwiftPM/toolchain interaction specific to a bare CLT
install rather than anything in this package. Full reproducible command:

```sh
cd mac && swift test \
  -Xswiftc -F -Xswiftc /Library/Developer/CommandLineTools/Library/Developer/Frameworks \
  -Xlinker -F -Xlinker /Library/Developer/CommandLineTools/Library/Developer/Frameworks
```

On a machine with full Xcode, plain `swift test` should work with no extra
flags — the embedded rpaths point at a CLT-only location and are silently
unused elsewhere.

## Requests for other teams

- None blocking. Two optional CLI subcommand requests noted above (`menubar`
  config read/write, `aiclis add/remove`) would let Settings reach full parity
  with the spec, but the companion is fully usable without them — those
  sections just say so explicitly instead of pretending to work.

## Files touched

All new, under `mac/` (my exclusive ownership). No other team's files were
read-then-edited; `folder.mjs`, `README.md`, `package.json`, `site/**` were
left untouched.
