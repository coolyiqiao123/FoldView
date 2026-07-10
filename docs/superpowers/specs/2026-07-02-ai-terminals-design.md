# Foldview rebrand and AI Terminals — a helpful home for vibe coding

**Date:** 2026-07-02  
**Status:** approved by default; use the recommended choices below when the user is unavailable

## Product goal

Rebrand Foldview from a generic project manager into a helpful, local-first
terminal companion for vibe coders. It should give people one calm place to find a
project, understand what is running, open the right tools, and start one or more AI
coding sessions without memorizing shell commands. The full TUI remains the main
workspace; an optional macOS menu-bar companion provides quick access when the TUI
is closed or behind other windows.

The product is not another coding agent. It is the friendly control surface around
the agents and projects the user already has.

As the first flagship workflow, add an **AI terminals** action. From the selected
project, a user can choose an installed AI coding CLI and open 1–9 macOS Terminal
windows. Every window must:

- start in the selected project directory;
- run the selected AI CLI;
- be visible without completely covering the other new windows.

The feature must discover AI CLIs already available in Foldview's environment and
also let the user add a custom CLI executable.

## Rebrand brief

### Brand foundation

- **Product name:** Foldview. Use this spelling and capitalization everywhere.
- **Category:** terminal workspace and launchpad for vibe coding.
- **Primary tagline:** `Your projects and AI coding tools, ready in one terminal.`
- **Short description:** `A friendly terminal home for projects, local apps, and AI coding agents.`
- **Core promise:** open Foldview and know what to work on, what is already running,
  and how to launch the next coding session.
- **Trust promise:** local-first by default. Project discovery, CLI detection, and
  configuration stay on the user's machine unless a separate feature explicitly
  says otherwise.

Do not describe Foldview merely as a “project manager,” “folder viewer,” or “AI
agent.” Those labels miss the product's role. Prefer “terminal home,” “workspace,”
“launchpad,” and “helper.”

### Audience

Design first for vibe coders who can describe and ship software with AI tools but
may not know every terminal convention. This includes designers, founders, product
builders, students, and experienced developers coordinating several agents.

The interface must remain efficient for terminal experts without assuming that all
users understand ports, process ownership, package scripts, detached processes, or
shell quoting.

### Personality and voice

Foldview is capable, calm, and concise. It helps without sounding like a mascot or
pretending to be intelligent.

- Use plain actions: `open`, `start`, `stop`, `find`, `add`, `launch`.
- Explain failure in terms of the next useful action.
- Prefer `No local server is running — press ↵ to start one` over internal jargon.
- Keep success messages short and specific: `opened 3 × claude`.
- Avoid hype such as “revolutionary,” “magic,” “10×,” and “supercharge.”
- Avoid shaming terms such as “beginner error” or “invalid user input.”
- Do not call every feature “AI”; make AI visible only where it changes the task.

### Experience principles

1. **Useful in 30 seconds.** The default command should immediately show discovered
   projects, running local apps, and the most likely next action.
2. **One screen before many screens.** Keep the primary project status and actions
   in one readable dashboard. Use overlays only for focused choices or help.
3. **Detect, then let the user correct.** Auto-detect projects, ports, editors, and
   AI CLIs, while always providing a clear manual/custom path.
4. **Safe actions are direct.** Opening or launching should take one or two obvious
   keystrokes. Destructive or ambiguous actions need clear context.
5. **Local state is visible.** Say what Foldview reads, what it starts, and what it
   persists. Never imply cloud synchronization that does not exist.
6. **Progressive disclosure.** Show the common action first; place advanced details
   in the detail pane, help overlay, or documentation.
7. **Keyboard-first, not keyboard-secret.** Shortcuts must remain visible in the
   footer and help. The interface should never require guessing a key.

### Visual direction

Keep the existing baby-blue direction, but turn it into a deliberate Foldview
identity rather than a collection of colored terminal boxes.

- Use baby blue for selection and primary actions, cool gray for supporting text,
  green only for healthy/live state, amber for work in progress, and red only for
  errors or unavailable actions.
- Establish a compact `foldview` wordmark in the TUI header. The folder emoji may be
  retained as a small accent, not as the whole identity.
- Give the selected project and its next action the strongest hierarchy.
- Reduce decorative rules or gradients that compete with project status.
- Keep every view usable without emoji and with `NO_COLOR` or non-color output.
- Never rely on color alone; preserve symbols and text labels such as `● live`,
  `○ stopped`, and `— unavailable`.
- Prevent footer wrapping at narrow widths and preserve the highest-priority actions.

### Rebrand surfaces

Audit and update all user-facing brand surfaces in one pass:

- TUI header, launch menu, empty states, status messages, prompts, and help overlay;
- `pm --help`, `--list`, and `--json` documentation without changing their data
  contracts;
- README title, first paragraph, quick start, feature summary, key table, screenshots,
  and local-first explanation;
- `package.json` description, keywords, repository metadata, and command descriptions;
- `site/index.html`, page title, metadata, hero copy, feature copy, screenshots, and
  calls to action;
- the native macOS menu-bar icon, popover, settings, onboarding, and installer;
- documentation headings and examples.

Keep existing command aliases working. Do not rename the npm package, repository,
configuration file, or executable as part of copy/visual cleanup unless the task
explicitly includes a migration and backward-compatibility plan.

### CodeBurn inspiration

Use [getagentseal/codeburn](https://github.com/getagentseal/codeburn) as product
research, not as a template to copy. Its useful patterns are:

- one direct outcome in the tagline and opening paragraph;
- a local-first trust statement close to the main value proposition;
- automatic detection of the tools a user already uses;
- a useful one-screen dashboard before deeper reports;
- a quick-start path that demonstrates value immediately;
- consistent interactive, plain-text, and JSON surfaces;
- simple keyboard navigation with visible shortcuts;
- documentation organized around user questions and outcomes rather than internals.

Apply those patterns to project and agent launching. Do **not** copy CodeBurn's
name, logo, screenshots, source code, exact wording, or token/cost analytics. Spend
tracking, session-file ingestion, model comparison, and optimization scoring are
outside Foldview's current product scope.

CodeBurn's macOS companion is also a useful architecture reference: it uses a
native Swift/SwiftUI `MenuBarExtra`, keeps the Dock clear with an accessory app,
decodes a dedicated JSON payload from its CLI, and invokes the CLI directly with
argv rather than through a shell. Foldview should use that separation of concerns
and add explicit schema versioning for its own contract, adapted to project
launching rather than usage analytics. See
[CodeBurn's macOS implementation notes](https://github.com/getagentseal/codeburn/tree/main/mac).

## macOS menu-bar companion

### Purpose

The menu bar is Foldview's quick-control surface, not a miniature copy of the whole
TUI. It answers three questions:

1. Which projects are live right now?
2. What did I work on recently?
3. Can I open, start, or launch an AI session without finding a Terminal first?

The companion is optional. The Node CLI and TUI must continue to work without the
native app installed.

### Recommended architecture and reasoning

Build a native Swift 6/SwiftUI companion in `mac/`, targeting macOS 14 or later.
Use `MenuBarExtra` with an accessory-app lifecycle (`LSUIElement = true`) so it has
no normal Dock icon.

This architecture is preferred because:

- SwiftUI provides the native menu-bar lifecycle, popover behavior, permissions,
  accessibility, dark mode, and launch-at-login integration without Electron.
- The existing Node code already owns project scanning, app configuration, port
  ownership, dev-command detection, browser opening, and AI-terminal launching.
  Reimplementing those rules in Swift would create two sources of truth.
- A stable JSON/action CLI bridge lets the TUI, menu bar, scripts, and future UI
  surfaces reuse the same behavior.
- A permanent Node daemon is unnecessary for the first version. A lightweight
  status process on refresh plus short-lived action processes is simpler to install,
  debug, and secure.

The current code cannot simply be embedded unchanged:

- `state.projects`, `state.livePorts`, and `state.servers` belong to one running TUI
  process. A menu-bar process cannot read those JavaScript objects.
- `state.servers` forgets ownership when the TUI exits, even though detached dev
  servers may continue running.
- `printList()` calls full LOC, disk, dependency, language, and Git analysis for
  every project. That is too expensive for periodic menu-bar refreshes.
- the current argument parser treats the first non-flag token as a directory, so it
  must learn explicit subcommands before menu-bar commands are added.

Therefore, first extract a lightweight, process-independent core inside
`folder.mjs` (or small focused modules if the single file becomes unsafe), expose a
versioned status contract, and persist ownership only for processes Foldview starts.

### Popover experience

Use a compact popover approximately 360–420 points wide. It must work in light and
dark mode and use the same baby-blue Foldview identity as the TUI.

#### Menu-bar item

- Show a simple monochrome Foldview/folder symbol suitable for a macOS template
  image; do not use a full-color logo in the system menu bar.
- When at least one project is live, optionally show the live count beside the icon.
- Do not show token cost, notifications, or animated status in the menu-bar item.

#### Popover layout

1. **Header:** Foldview wordmark, live-project count, and last refresh time.
2. **Live now:** every detected live project, sorted alphabetically.
3. **Recent projects:** the most recently opened/acted-on projects, excluding
   duplicates already shown under Live now. Show at most eight rows before scrolling.
4. **Footer:** `Open Foldview`, `Refresh`, `Settings`, and `Quit`.

Each project row shows:

- a text-and-symbol status such as `● live :5173`, `○ ready`, or `— no dev server`;
- project name and a shortened parent path;
- explicit actions rather than ambiguous row behavior:
  - `Open` for a live website;
  - `Start` for a stopped launchable project;
  - `AI` for the detected/custom CLI and window-count picker;
  - an overflow menu for `Open in editor`, `Copy path`, and `Stop` when safe.

`Stop` appears only when Foldview has a validated ownership record for that process.
Never offer to kill an arbitrary listener merely because its working directory or
port resembles a project.

`Open Foldview` launches Terminal.app in the configured root and runs the resolved
`pm` executable. If no root is configured, it opens onboarding instead.

### First-run onboarding and settings

The menu-bar app does not have a meaningful shell working directory, so it cannot
use `process.cwd()` as its project root. On first launch:

1. explain in one sentence that Foldview scans local project folders and does not
   upload project data;
2. let the user choose one or more project roots with `NSOpenPanel`;
3. discover available AI CLIs and the preferred editor;
4. show the first populated popover.

Settings include:

- add/remove project roots;
- show/hide discovered local apps;
- manage custom AI CLI executables;
- refresh interval, with 60 seconds as the default;
- launch Foldview at login using `SMAppService`;
- show the resolved Foldview CLI path and a repair/re-detect action.

Root and custom-CLI changes must go through the Foldview CLI/config layer so Swift
does not implement a second configuration writer.

### Shared configuration

Evolve `~/.foldview.json` without discarding its existing `apps`, `hidden`, or
`aiClis` fields. Add a schema version and menu-bar fields such as:

```json
{
  "schemaVersion": 1,
  "roots": ["/Users/example/Projects"],
  "recentProjects": ["/Users/example/Projects/my-app"],
  "menubar": {
    "refreshSeconds": 60,
    "showDiscoveredApps": true
  }
}
```

All writers must read-merge-write, preserve unknown fields, and use an atomic
temporary-file-plus-rename update. Handle simultaneous TUI/menu-bar writes without
producing invalid JSON or silently losing unrelated settings.

### CLI bridge

Add explicit subcommands while preserving the current `pm [path]`, `--list`,
`--json`, and `--help` behavior.

Recommended interface:

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
pm menubar
pm menubar --force-install
```

The exact names may change, but status reads and mutating actions must be explicit,
machine-testable, and independently usable without a TTY.

`status --format menubar-json` must be a fast path. It may read project markers,
`package.json`, modification times, configured apps, live ports, and the runtime
registry. It must not walk every source file, calculate directory sizes, or run full
Git status. Target a warm refresh below 500 ms for ordinary project roots and avoid
blocking the Swift main actor.

Use a versioned payload:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-07-02T12:00:00.000Z",
  "summary": { "projectCount": 12, "liveCount": 2 },
  "projects": [
    {
      "id": "/Users/example/Projects/my-app",
      "name": "my-app",
      "path": "/Users/example/Projects/my-app",
      "kind": "project",
      "live": true,
      "port": 5173,
      "launchable": true,
      "managed": true,
      "modifiedAt": 1782993600000
    }
  ],
  "aiClis": [
    { "name": "claude", "executable": "/absolute/path/to/claude" }
  ]
}
```

Swift must spawn the recorded absolute `pm` executable with `Process` and a literal
argument array—never `/bin/sh -c`. Decode stdout with `Codable`; treat stderr and a
non-zero exit as an error state with a `Retry` action. Keep the last valid payload
visible during transient refresh failures.

Refresh on popover open, after every action, and every 60 seconds in the background.
Coalesce concurrent refreshes and cancel stale results. Perform process execution
and JSON decoding off the main actor, then publish UI state on the main actor.

### Managed process registry

To support `Stop` across TUI and menu-bar lifetimes, record only dev servers started
by Foldview in:

```text
~/Library/Application Support/Foldview/runtime-v1.json
```

Each entry includes project path, PID/process-group ID, detected port, start time,
command, log path, and launcher (`tui` or `menubar`). Write it atomically.

Before displaying `managed: true` or stopping a process, verify that:

- the PID still exists;
- its command matches the recorded dev command;
- its working directory is the recorded project or a child of it;
- the live port, when known, is owned by that process tree.

Delete stale records. Protect against PID reuse. If validation is inconclusive,
leave the server running and show `Foldview did not start this server`.

### Native project layout

Use a small, testable Swift package/app structure:

```text
mac/
├── Package.swift
├── README.md
├── Sources/FoldviewMenuBar/
│   ├── FoldviewApp.swift
│   ├── AppStore.swift
│   ├── CLI/FoldviewCLI.swift
│   ├── Data/MenuBarPayload.swift
│   ├── Data/ProjectRowModel.swift
│   ├── Theme/FoldviewTheme.swift
│   ├── Views/MenuBarContent.swift
│   ├── Views/ProjectRow.swift
│   ├── Views/AIQuickLaunch.swift
│   └── Views/SettingsView.swift
└── Tests/FoldviewMenuBarTests/
```

The Swift target should contain presentation, payload decoding, and process-launch
adapters—not a second project scanner.

### Installation and lifecycle

For development, support `swift run` with an explicitly allowed local CLI path.
For users, `pm menubar` should install or launch a signed and notarized
`FoldviewMenuBar.app` in `~/Applications`.

- Record the absolute CLI path during install in
  `~/Library/Application Support/Foldview/cli-path-v1`.
- Fall back only to a small list of expected npm/Homebrew locations and show a repair
  screen if none is valid.
- Verify release checksums before replacement.
- Do not bypass Gatekeeper as the normal installation strategy.
- Preserve the previous working app if download, checksum, signature, or replacement
  fails.
- Explain the macOS Automation prompt before the first AI-terminal launch; denying
  Terminal control must produce a recoverable error with instructions.

The Node CLI remains zero-dependency. The optional native companion introduces no
runtime dependency for non-macOS users.

### Delivery phases

1. **Core extraction:** separate lightweight project/dev-command status from full
   LOC/disk/Git analysis; add roots and atomic config updates.
2. **Stable bridge:** implement and test the versioned menu-bar JSON payload and
   direct action subcommands.
3. **Native read-only shell:** build `MenuBarExtra`, payload decoding, live/recent
   sections, loading/error/empty states, and manual/background refresh.
4. **Safe actions:** wire open, editor, start, persistent runtime ownership, validated
   stop, and recent-project updates.
5. **AI quick launch:** reuse the same CLI discovery and terminal tiling action as
   the TUI; do not implement separate AppleScript in Swift.
6. **Settings and onboarding:** roots, custom CLIs, refresh preferences, CLI repair,
   and optional launch at login.
7. **Distribution:** app icon/template icon, signing, notarization, checksummed
   releases, installer/upgrader, and recovery tests.
8. **Brand QA:** review TUI, menu bar, README, website, and CLI help as one product.

Do not skip directly to Swift UI work before the lightweight JSON contract exists.
Otherwise the menu bar will either duplicate logic or depend on expensive full scans.

## User experience

### Standard flow

1. Select a project and press `a`.
2. The footer lists detected AI CLIs and a custom option. For example:

   ```text
   AI terminals — c claude · x codex · g gemini · + custom · esc cancel
   ```

3. Press the displayed shortcut for a CLI.
4. The footer asks for a window count:

   ```text
   claude — how many windows? 1-9 · esc cancel
   ```

5. Press a digit from `1` through `9`.
6. Foldview opens that many Terminal.app windows, tiles them on the main display,
   activates Terminal, and reports:

   ```text
   opened 3 × claude
   ```

`esc` cancels at any step. Keys not offered by the active prompt are ignored.
When no project is selected, `a` does nothing.

### CLI discovery

On startup or when the AI prompt opens, check known AI CLI executable names with
`command -v` using Foldview's own environment. Include only executables that are
actually resolvable. At minimum, recognize:

| Shortcut | Display name | Executable |
| --- | --- | --- |
| `c` | Claude | `claude` |
| `x` | Codex | `codex` |
| `g` | Gemini | `gemini` |
| `o` | OpenCode | `opencode` |
| `i` | Aider | `aider` |

Shortcut collisions must be resolved deterministically, and the footer must show
the actual assigned shortcut. Do not inspect shell history or send any discovery
data over the network.

If no known CLI is found, still show `+ custom` and `esc cancel`.

### Custom CLI flow

Pressing `+` opens a text prompt:

```text
Custom AI CLI executable: █ · enter save · esc cancel
```

The value is an executable name or absolute executable path, not an arbitrary shell
expression. Reject pipes, redirects, command separators, command substitutions, and
empty input. Resolve a bare name with `command -v`; validate that an absolute path
exists and is executable.

Save valid custom entries in `~/.foldview.json` under an `aiClis` array so they
appear in future AI prompts. Preserve all unrelated configuration fields. A useful
shape is:

```json
{
  "aiClis": [
    { "name": "my-agent", "executable": "/absolute/path/to/my-agent" }
  ]
}
```

Deduplicate entries by resolved absolute path. Assign each custom entry an unused
single-key shortcut and display that key in the prompt. If no shortcut is available,
keep the entry in configuration but omit it from the one-key menu.

## Terminal window layout

New Terminal windows currently open directly on top of one another. Avoid this by
capturing every window created by AppleScript and assigning explicit bounds after
all windows have opened.

- Use the usable bounds of the main display.
- For one window, use the available display area.
- For two windows, place them side by side.
- For three through nine windows, use a compact grid with
  `columns = ceil(sqrt(n))` and `rows = ceil(n / columns)`.
- Add a small gap between cells and keep every window within the display bounds.
- Size the final row consistently even when it contains fewer windows.
- Apply bounds only to windows created by this action. Never move the user's
  existing Terminal windows.

If macOS or Terminal enforces a minimum size, use the closest non-overlapping layout
possible. A slight cascade is acceptable only as a fallback; fully overlaid windows
are not.

## Implementation requirements

Keep the AI-terminal runtime logic in `folder.mjs` unless a focused test file is
needed. The rebrand intentionally spans the existing product surfaces listed above;
do not force README, package metadata, or website copy into `folder.mjs`.

Before editing, inventory every visible occurrence of the old identity and group
changes into:

1. product copy and terminology;
2. TUI hierarchy and theme tokens;
3. AI-terminal behavior;
4. documentation and website alignment.

Do not combine the rebrand with unrelated architecture rewrites. Preserve existing
commands, configuration, project scanning, local-app discovery, server controls,
and noninteractive output contracts.

### State

Extend TUI state with an AI prompt object. It should represent these phases without
affecting search or add-app input:

```js
state.ai = null | {
  project,
  phase: 'select-cli' | 'custom-cli' | 'select-count',
  choices,
  cli,
  input
}
```

The exact property names may differ, but the three phases and selected project must
be explicit.

### Input handling

Place the `if (state.ai)` handler immediately after the search handler in `onKey`.
It must consume all input while the AI prompt is active, handle `escape` at every
phase, and finish with `render(); return;`.

- Selection phase: accept only displayed CLI shortcuts, `+`, and `escape`.
- Custom phase: accept printable text, backspace, return, and `escape`.
- Count phase: accept only digits `1–9` and `escape`.
- `Ctrl-C` must retain the application's existing quit behavior.

### Rendering and documentation

Add an `if (state.ai)` branch in `footer()` using the same visual language as the
search and add-app prompts. Truncate the discovered CLI list to terminal width
without wrapping; always retain `+ custom` and `esc cancel` when possible.

Document `a` in:

- the normal footer hint list;
- the `?` help overlay under **ACTIONS**;
- `printHelp()` / `pm --help`;
- the README key table, if one exists.

Describe the action as opening AI terminals with detected or custom coding CLIs,
not only Claude and Codex.

### Launch action

Implement `launchAITerminals(project, cli, count)` in the actions section.

1. If `process.platform !== 'darwin'`, set
   `AI terminals: macOS only for now` and return.
2. Resolve the selected entry to an absolute executable path. Do not silently run a
   different executable if resolution fails.
3. Validate that the selected row has a real local directory. Pinned apps without a
   directory must produce a status message and return.
4. Build a shell command equivalent to:

   ```sh
   cd <safely quoted project path> && <safely quoted absolute CLI path>
   ```

5. POSIX single-quote shell arguments, then escape the complete command for an
   AppleScript string. Paths containing spaces, apostrophes, quotes, backslashes,
   or Unicode must work.
6. Start one detached `osascript` process that:
   - creates exactly `count` new Terminal windows;
   - runs the command once in each window;
   - retains references to those new windows;
   - applies the grid bounds described above;
   - activates Terminal after layout is complete.
7. Listen for both the child's `error` event and non-zero `exit` status. Report
   `opened N × <name>` only after a successful launch. On failure, report
   `could not open Terminal windows`. Never crash or exit the TUI.

Do not interpolate untrusted values into AppleScript source without the required
shell and AppleScript escaping.

## Acceptance criteria

- The product consistently identifies itself as `Foldview` across the TUI, CLI help,
  README, package metadata, website, and specification.
- The first screen communicates the selected project, whether it is live, and the
  most useful next action without requiring the help overlay.
- Copy describes Foldview as a local-first terminal workspace/launchpad for projects
  and AI coding tools, not only as a generic project manager.
- Error messages use plain language and provide a next step when one exists.
- Keyboard shortcuts remain visible and the footer does not wrap at supported widths.
- Status is never communicated by color alone, and non-color output remains readable.
- Existing commands and configuration continue to work after the rebrand.
- On macOS 14+, the optional Foldview menu-bar app runs without a normal Dock icon
  and remains useful when no TUI process is running.
- The menu bar shows live and recent projects from configured roots using a versioned,
  lightweight CLI JSON payload.
- Menu-bar status refresh does not perform full LOC, disk-size, dependency-size, or
  Git analysis and normally completes within the stated performance target.
- Open, start, editor, and AI actions use the shared Node implementation rather than
  duplicated Swift scanning/launch logic.
- `Stop` is available only for a process whose persisted Foldview ownership record
  passes PID, command, working-directory, and port validation.
- A refresh failure retains the last good project list and presents a retry action.
- First-run onboarding can configure a root without requiring the user to edit JSON
  or launch the TUI first.
- Installing the menu-bar app does not add a runtime requirement to the Node CLI or
  to non-macOS users.
- `a` opens the AI CLI picker for the selected project.
- Only installed known CLIs and valid saved custom CLIs appear.
- `+` validates and persists a custom executable without overwriting other
  `~/.foldview.json` settings.
- `a` → `c` → `2` opens two Claude windows when `claude` is installed.
- `a` → `x` → `3` opens three Codex windows when `codex` is installed.
- Every launched window starts in the selected project and runs exactly one CLI
  process.
- Two windows are side by side; three through nine are tiled and do not fully
  overlap.
- Existing Terminal windows are not moved or resized.
- `esc` cancels cleanly from CLI selection, custom entry, and count selection.
- Invalid custom executables produce a clear status and do not launch Terminal.
- Missing project directories, unsupported platforms, `osascript` spawn errors,
  and non-zero exits are handled with status messages.
- `pm --list` and `pm --json` output and behavior are unchanged.
- The footer, help overlay, CLI help, and README describe the feature consistently.

## Test plan

### Automated

- Unit-test POSIX quoting and AppleScript string escaping with spaces, apostrophes,
  double quotes, backslashes, and Unicode.
- Unit-test known-CLI discovery with mocked `command -v` results.
- Unit-test custom CLI validation, deduplication, shortcut assignment, and config
  merging.
- Unit-test grid bounds for counts `1–9`, including screen-edge and gap assertions.
- Unit-test `osascript` error and non-zero-exit handling.
- Confirm `pm --list` and `pm --json` snapshots are unchanged apart from unrelated
  existing worktree changes.
- Add focused rendering assertions for the Foldview wordmark, action-oriented empty
  states, visible status labels, and footer behavior at minimum supported width.
- Search for stale user-facing product names and generic “project manager” copy;
  retain those terms only where they are technically necessary or historical.
- Contract-test `status --format menubar-json` against schema-versioned fixtures,
  missing roots, invalid config, stale runtime records, and empty project lists.
- Measure the lightweight status path separately from full `--list`/`--json` scans.
- Test atomic configuration and runtime-registry updates under concurrent writers.
- Test ownership validation against exited processes, PID reuse, command mismatch,
  working-directory mismatch, and externally started listeners.
- In Swift tests, decode valid/forward-compatible payload fixtures and cover loading,
  empty, stale-data, error, refresh-coalescing, and action-result states.
- Assert that the Swift process adapter passes a literal executable and argv array;
  project paths and CLI paths must never become shell source.

### Manual on macOS

1. Use a benign command first to verify that one `osascript` invocation creates and
   tiles the requested number of new windows.
2. Run `a` → Claude → `2`; verify both windows start in the project and remain
   simultaneously visible.
3. Run Codex with `3`, then another CLI with `9`; verify the grid and ensure existing
   Terminal windows do not move.
4. Add a custom CLI, restart Foldview, and verify it remains in the picker.
5. Test a project path containing spaces and apostrophes.
6. Test cancellation and all failure statuses.
7. Review the TUI, `pm --help`, README, and website together; confirm they describe
   the same product, use the same tagline, and show the same primary workflow.
8. Test at the minimum supported terminal size and with color disabled.
9. Launch the native app with no config, choose a project root, and verify that live
   and recent sections populate without a TUI running.
10. Start a project from the menu bar, quit/reopen the app, and verify that the live
    status and validated `Stop` action survive process boundaries.
11. Start a similar server outside Foldview and verify that the menu bar detects it
    but never offers a managed stop action.
12. Deny Terminal Automation permission, attempt AI quick launch, and verify that the
    app explains how to recover without crashing or repeatedly prompting.
13. Verify refresh-on-open, the 60-second refresh, manual refresh, offline operation,
    launch at login, light/dark mode, and VoiceOver labels.
14. Install, upgrade, interrupt an upgrade, and repair a missing CLI path; verify the
    previous working app is not destroyed on failure.

## Out of scope

- iTerm2 or other terminal applications;
- tabs instead of windows;
- more than nine windows;
- per-project default CLI or window count;
- Linux or Windows terminal launching;
- arbitrary shell snippets for custom CLIs;
- automatic multi-agent orchestration inside the selected CLI;
- becoming an AI coding agent itself;
- CodeBurn-style token, cost, model, or session analytics;
- copying another project's brand assets or implementation;
- Linux or Windows tray/menu-bar applications;
- reproducing the complete TUI inside the menu-bar popover;
- a permanent Node background daemon for the initial menu-bar release;
- cloud sync, remote project control, push notifications, or account systems;
- Mac App Store distribution for the initial release.
