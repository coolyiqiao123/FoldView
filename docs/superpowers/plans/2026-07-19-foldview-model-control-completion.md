# Foldview model control and product-completion plan

Status: ready for phased implementation

Date: 2026-07-19

Canonical root: `/Users/yc/Documents/foldview`

Prototype source: `prototypes/model-dial/`

This plan supersedes the model/session exclusions in
`docs/superpowers/specs/2026-07-02-ai-terminals-design.md` for Codex and Kimi
Code. It also supersedes the destructive parts of
`docs/superpowers/plans/2026-07-15-foldview-website-redesign.md` that conflict
with later user decisions.

## Outcome and definition of complete

Foldview becomes the local project manager and launch surface for Codex and
Kimi Code. From either the terminal UI or the native menu-bar app, a user can:

1. Choose a project.
2. Choose Codex or Kimi Code from installed AI CLIs.
3. Slide through the models reported by that installed tool.
4. Slide through only the reasoning-effort values supported by the selected
   model.
5. Launch one to nine Terminal windows in the project with those one-session
   settings.
6. Explicitly save the same selection as that CLI's future default.
7. See precise loading, unsupported, stale, success, and failure states without
   exposing credentials.

For this plan, **local-product complete** means the Node CLI, TUI, native app,
local installer, settings bridge, current website, automated tests, and manual
macOS acceptance matrix all agree and pass on this Mac. Developer-ID signing,
Apple notarization, npm publication, and a GitHub release are release operations
requiring separate credentials or explicit publishing authority; the local
product must not pretend those external steps have happened.

## Current verified baseline

- Active root is `/Users/yc/Documents/foldview`, not either Rhea Foldview copy.
- Node runtime is Node 18+ ESM with zero runtime dependencies.
- `npm test`: 98 pass, 1 intentional macOS-branch inspection skip, 0 fail.
- `swift build`: pass.
- `swift test`: 36 tests in 5 suites pass.
- Current model controls: none.
- `pm menubar`: a tested informational stub, not an installer.
- Native source exists, but no installed Foldview app bundle exists.
- Valuable TUI/site/test/context work remains modified or untracked. Preserve it.
- The current website redesign plan is unimplemented and conflicts with later
  directions to retain the corrected vanilla MacBook scene, retain the added
  iPhone scene unless explicitly removed, and keep the founder/About section
  deleted.

## Binding architecture

```text
Foldview TUI or Swift menu-bar view
        │
        │ literal arguments / versioned JSON
        ▼
folder.mjs CLI bridge
        ├── project discovery and status
        ├── Codex/Kimi catalog adapters
        ├── external default-config adapters
        ├── model/effort validation
        └── Terminal command + grid owner
                 │
                 ▼
          Codex or Kimi Code
```

Node remains the source of truth. Swift must not scan projects, inspect provider
configuration directly, write TOML, build the multi-window AppleScript, or
invent model capabilities. Catalog work is on demand and never runs inside the
periodic `pm status --format menubar-json` fast path.

## Phase 0 — Documentation discovery and allowed APIs

### Sources read and patterns to copy

- Product/runtime contract: `package.json`, `README.md`.
- Existing AI discovery and validation: `folder.mjs`, anchors
  `KNOWN_AI_CLIS`, `discoverAIClis`, `resolveCustomCli`.
- Existing safe writes: `folder.mjs`, anchors `ensureConfigDefaults`,
  `readConfig`, `writeConfig`, `updateConfig`.
- Existing AI launch path: `folder.mjs`, anchors `shq`, `asq`,
  `buildAITerminalsScript`, `spawnAITerminals`, `actionAi`, `cmdAction`.
- Existing TUI phases: `folder.mjs`, anchors `state.ai`, `footerAi`,
  `openAiPrompt`, and the `if (state.ai)` branch in `onKey`.
- Existing fast payload: `buildMenubarStatus` and
  `test/menubar-status.test.mjs`.
- Native boundary and process adapter: `mac/README.md`,
  `mac/Sources/FoldviewMenuBar/CLI/FoldviewCLI.swift`.
- Native state and sheet: `AppStore.swift`, `MenuBarContent.swift`,
  `AIQuickLaunch.swift`, `SettingsView.swift`.
- Prototype domain/config/catalog/state/UI/packaging:
  `prototypes/model-dial/Sources/ModelDial/`,
  `prototypes/model-dial/Packaging/`, and
  `prototypes/model-dial/Tests/ModelDialTests/`.
- Node test patterns: `test/ai-discovery.test.mjs`,
  `test/spawn-ai.test.mjs`, `test/cli-surface.test.mjs`,
  `test/config.test.mjs`, `test/quoting.test.mjs`.
- Swift test patterns: `CLIActionArgumentsTests.swift`,
  `FoldviewCLIProcessAdapterTests.swift`, `FakeFoldviewCLI.swift`,
  `AppStoreStateTests.swift`.

### Allowed APIs

- Node standard library only: `fs`, `path`, `os`, `child_process`, existing
  process helpers, JSON, and ESM.
- Existing `folder.mjs` atomic temp-file/rename and quoting conventions.
- `execFile`/`spawn` with literal argv; never user-authored shell fragments.
- Versioned JSON contracts with explicit required and optional fields.
- SwiftUI, Foundation, AppKit, ServiceManagement already used by the target.
- Swift `Process.executableURL` plus literal `arguments: [String]` inside the
  `FoldviewCLI` actor.
- `Codable`, `Sendable`, `@MainActor`, task cancellation, and stale-result
  generation checks following existing code.
- Discrete SwiftUI `Slider` values derived from arrays reported by Node.
- Atomic external-config writes that preserve permissions, unknown content,
  and a recoverable sibling backup.

### APIs and assumptions not allowed

- No React/Vite/Tailwind or other new runtime dependency in this lineage.
- No TOML package without an explicit dependency-policy change.
- No direct Swift writes to `~/.foldview.json`, `~/.codex/config.toml`, or
  `~/.kimi-code/config.toml`.
- No model catalogs inside the periodic status payload.
- No change to schema-v1 `aiClis` entries; they remain exactly
  `{name, executable}`.
- No hard-coded UI list of GPT or Kimi models.
- No provider detection based only on editable display names.
- No generic `--extra-args` or environment-variable editor.
- No second AppleScript/grid implementation in Swift.
- No claim that a running session can be externally live-switched. Controls
  apply to newly launched sessions; persistent defaults apply to later starts.

### Phase 0 verification

- Re-run all baseline tests before implementation.
- Confirm the installed Codex/Kimi command signatures from their live help and
  catalog output.
- Confirm the cited semantic anchors still exist because `folder.mjs` is dirty.
- Record any discovered provider drift in the contract tests before coding.

## Phase 1 — Preserve work and freeze the additive contract

### What to implement

Create a recoverable snapshot of the current modified and untracked Foldview
work before touching shared files. Do not clean, reset, rebase, or overwrite
the current tree. A git preservation commit is preferred, but requires the
user's explicit commit/push instruction if it has not already been granted.

Add a model-control spec addendum under
`docs/superpowers/specs/2026-07-19-model-control-design.md`. Copy the existing
versioned-bridge style from
`docs/superpowers/specs/2026-07-02-ai-terminals-design.md`; do not silently edit
the historic frozen contract.

Freeze these commands:

```text
pm ai catalog --json
pm ai catalog --provider <codex|kimi> --json
pm ai defaults get --provider <codex|kimi> --json
pm ai defaults set --provider <codex|kimi> --model <id> [--effort <value>] --json

pm action ai --project <absolute-directory>
             --cli <absolute-executable>
             --count <1-9>
             [--provider <codex|kimi>]
             [--model <id>]
             [--effort <value>]
```

The existing three-required-argument `pm action ai` form remains valid and
launches the CLI with its existing defaults.

Freeze this on-demand catalog envelope:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-07-19T00:00:00.000Z",
  "providers": [
    {
      "id": "codex",
      "name": "Codex",
      "executable": "/absolute/path/to/codex",
      "available": true,
      "error": null,
      "defaultModel": "reported-model-id",
      "defaultEffort": "reported-effort",
      "models": [
        {
          "id": "reported-model-id",
          "label": "Reported model label",
          "detail": "Provider-supplied description",
          "efforts": ["low", "medium", "high"],
          "defaultEffort": "medium"
        }
      ]
    }
  ]
}
```

Each provider returns independently. One unavailable or malformed tool must not
remove the other provider's catalog.

### Target files

- New `docs/superpowers/specs/2026-07-19-model-control-design.md`.
- New catalog/default fixtures under `test/fixtures/ai-catalog/`.
- Update `README.md` only after implementation makes the contract true.

### Verification checklist

- The spec defines this-launch versus saved-default semantics.
- Unsupported provider/model/effort and stale catalog behavior are explicit.
- The JSON contains no API keys, tokens, full config text, or backup paths.
- Schema-v1 status fixtures remain byte-shape compatible.
- Every option in the UI can be traced to one catalog field.

### Anti-pattern guards

- Do not use `quality` as a wire value; it is presentation language only.
- Do not mutate defaults when a slider merely moves.
- Do not make catalog failure fatal to project status or unrelated providers.
- Do not put provider configuration into `~/.foldview.json` as a second truth.

## Phase 2 — Implement Node provider adapters and safe defaults

### What to implement

Inside `folder.mjs`, add Kimi to `KNOWN_AI_CLIS` and add a stable internal
provider ID to recognized Codex and Kimi entries while preserving the existing
legacy output shape returned by `buildMenubarStatus`.

Add provider-adapter functions near `discoverAIClis()`:

```js
async function buildAIProviderCatalog(providerFilter = null)
async function loadCodexCatalog(executable)
async function loadKimiCatalog(executable)
function classifyAIProvider(executable)
function validateAISelection(provider, catalog, model, effort)
function buildAIProviderLaunch(provider, executable, model, effort)
function readAIProviderDefaults(provider)
function writeAIProviderDefaults(provider, model, effort)
```

`loadCodexCatalog` must copy the proven mapping from
`prototypes/model-dial/Sources/ModelDial/CatalogLoader.swift`:

- Execute the resolved absolute Codex binary with `debug models`.
- Accept wrapped `{models:[...]}` and bare-array catalog formats.
- Keep only visible/listable models.
- Map `supported_reasoning_levels[].effort` and
  `default_reasoning_level`.
- Sort by provider priority, then label.
- Use a bounded timeout and a buffer/file strategy large enough for the current
  catalog; do not introduce a pipe deadlock.

`loadKimiCatalog` must port the line-preserving Kimi model-table extraction from
the prototype while improving it with quote-aware comment parsing. It must read
only the fields required for aliases, display names, capabilities,
`support_efforts`, `default_effort`, and `[thinking]`. Models without an effort
list expose a fixed-thinking state rather than invented levels.

Default writes must:

- Re-read the file immediately before mutation.
- Acquire a bounded provider-specific lock or fail clearly if another writer
  is active.
- Transform only the targeted top-level keys or `[thinking]` fields.
- Preserve unknown tables, comments, line endings, and unrelated values.
- Write a sibling timestamped backup with the source file's permissions.
- Write to a same-directory temporary file, `fsync`, rename atomically, and
  restore the original mode.
- Validate the selected model and effort against a freshly loaded catalog
  before writing.
- Never include file contents or credential-bearing lines in errors or JSON.

### Documentation references

- Catalog mapping: `prototypes/model-dial/Sources/ModelDial/CatalogLoader.swift`,
  `loadCodex()` and `loadKimi()`.
- Targeted config helpers:
  `prototypes/model-dial/Sources/ModelDial/ConfigurationStore.swift`.
- Foldview atomic config convention: `folder.mjs`, `writeConfig` and
  `updateConfig`.
- AI discovery validation: `folder.mjs`, `resolveExecutable`,
  `discoverAIClis`, `resolveCustomCli`.

### Tests to add

- `test/ai-catalog.test.mjs`:
  wrapped/bare Codex catalogs, visibility filtering, ordering, partial provider
  failure, Kimi aliases, fixed-thinking models, supported efforts, malformed
  output, timeout, and absence of secrets.
- `test/ai-defaults.test.mjs`:
  Codex and Kimi round trips, comments/quoted `#`, alternate line endings,
  missing sections, nil/fixed effort, unsupported selection, permission
  preservation, timestamped backup, atomic failure, lock contention, and
  unrelated-content preservation.
- Extend `test/ai-discovery.test.mjs` for native Kimi recognition and stable
  provider classification.

### Verification checklist

- Catalog calls are TTY-independent and deterministic for fixtures.
- A Codex failure still returns the Kimi provider result and vice versa.
- Config fixtures are identical outside targeted lines.
- Backups inherit restrictive permissions and are never emitted in payloads.
- No provider call occurs during `pm status`.

### Anti-pattern guards

- Do not regenerate a whole TOML document from a partial object.
- Do not use a regex that treats `#` inside quoted text as a comment.
- Do not overwrite one rolling backup on every save.
- Do not hard-code locally observed GPT/Kimi IDs into production logic.

## Phase 3 — Extend the CLI action and TUI launch flow

### What to implement

Add `ai` to the subcommand router and implement `cmdAI(rest)` for the Phase 1
catalog/default commands. All results are explicit JSON when `--json` is
requested; failures use nonzero exit status and safe stderr.

Extend `cmdAction` to parse optional provider/model/effort values. The provider
must match the resolved discovered executable. If any override is supplied,
load the corresponding catalog and validate the exact combination before
launch.

Change the launch owner to:

```js
function spawnAITerminals(project, cliEntry, count, launchSpec = null)
```

Build the command from independently quoted tokens:

```js
const invocation = buildAIProviderLaunch(
  launchSpec.provider,
  cliEntry.executable,
  launchSpec.model,
  launchSpec.effort
)
const command = `cd ${shq(project.path)} && ${invocation.env.map(quoteEnv).concat(invocation.argv.map(shq)).join(' ')}`
```

`buildAIProviderLaunch` is an allowlisted provider adapter:

- Codex argv: `--model <id>` and, when present,
  `--config model_reasoning_effort="<effort>"` as literal arguments.
- Kimi argv: `--model <alias>`; when supported and selected, include only the
  recognized `KIMI_MODEL_THINKING_EFFORT=<effort>` environment assignment.
- Other/custom CLIs receive no model-control fields and keep existing behavior.

The TUI AI state machine becomes:

```text
select-cli → loading-catalog → select-model → select-effort → select-count → launch
```

Fixed-thinking models skip `select-effort`. Unsupported/custom CLIs skip both
model phases. Escape moves back one phase before cancelling. The selected model
and effort must remain visible in the footer while choosing the window count.

### Documentation references

- Terminal owner: `folder.mjs`, `spawnAITerminals` and
  `buildAITerminalsScript`.
- Existing phases: `footerAi`, `openAiPrompt`, and the `state.ai` branch in
  `onKey`.
- Existing CLI dispatcher: `parseFlagValue`, `cmdAction`, `SUBCOMMANDS`,
  `dispatchSubcommand`.
- Existing safety tests: `test/spawn-ai.test.mjs`,
  `test/quoting.test.mjs`, `test/cli-surface.test.mjs`.

### Tests to add or extend

- Exact Codex/Kimi invocation tokens for no override, model only, and
  model+effort.
- Paths, model IDs, and effort strings containing spaces, quotes, apostrophes,
  dollar signs, command substitutions, and newlines never execute as shell.
- Provider/executable mismatch is rejected.
- Unsupported model/effort never opens Terminal.
- Existing `pm action ai` behavior remains unchanged without optional flags.
- The single AppleScript process still creates exactly the requested 1-9 new
  windows and never moves existing windows.
- Footer/state tests cover every phase, back step, fixed-thinking skip, loading,
  error, and narrow-terminal rendering.

### Verification checklist

- `pm --help` documents the additive commands and flags.
- The status fast path stays below 500 ms.
- Existing schema-v1 `aiClis` strict-shape test stays unchanged.
- All user-controlled values cross either literal argv or the existing proven
  two-layer quoting path.

### Anti-pattern guards

- Do not accept a generic array of launch arguments from UI or config.
- Do not infer Codex/Kimi behavior from an editable name alone.
- Do not launch first and report validation errors afterward.
- Do not change existing Terminal windows.

## Phase 4 — Integrate the native model panel

### What to implement

Port the reusable prototype domain/UI into the existing Foldview target. Do not
copy the prototype's `@main` application or direct launch implementation.

Add:

```text
mac/Sources/FoldviewMenuBar/Data/AIModelCatalog.swift
mac/Sources/FoldviewMenuBar/Views/ModelSlider.swift
mac/Sources/FoldviewMenuBar/Views/EffortSlider.swift
```

The Codable domain should include:

```swift
struct AIProviderCatalog: Codable, Identifiable, Hashable, Sendable
struct AIModelOption: Codable, Identifiable, Hashable, Sendable
struct AICatalogEnvelope: Codable, Sendable
```

Extend `FoldviewCLIProtocol` and `FoldviewCLI` with:

```swift
func aiCatalog(provider: String?) async throws -> AICatalogEnvelope
func aiDefaults(provider: String) async throws -> AIProviderDefaults
func setAIDefault(provider: String, model: String, effort: String?) async throws
```

Extend the typed action to:

```swift
case ai(
    project: String,
    cli: String,
    count: Int,
    provider: String?,
    model: String?,
    effort: String?
)
```

Every flag and value remains a separate element in `CLIAction.arguments`.

Extend `AppStore` with independent, cached provider states, generation-checked
loads, and off-main process work. A failure in one provider must not erase the
other provider. Add these actions:

```swift
func loadAIModels(for cli: AICLIPayload)
func launchAI(
    project: ProjectRowModel,
    cli: AICLIPayload,
    model: AIModelOption?,
    effort: String?,
    count: Int
)
func saveAIDefault(provider: AIProviderCatalog, model: AIModelOption, effort: String?)
```

Upgrade `AIQuickLaunch` in this order:

1. CLI picker.
2. On-demand loading/error/retry state.
3. Discrete model slider with exact model label and index.
4. Model-dependent effort slider or an explicit fixed-thinking message.
5. Window-count stepper.
6. Secondary `Save default` action.
7. Primary `Launch` action.

Use the quiet slider composition from
`prototypes/model-dial/Sources/ModelDial/ControlPanelView.swift`, adapted to
`FoldviewTheme`. The project path already comes from `ProjectRowModel`; do not
add a second working-directory picker.

Add a Models section to `SettingsView` that shows provider availability,
effective defaults, and the same explicit save action through the Node bridge.
Do not duplicate default-writing code in Swift.

### Process-safety correction

Before using `FoldviewCLI` for potentially larger model JSON, replace its
termination-only pipe reads with concurrent draining or a bounded temporary-file
capture copied from the prototype's process runner. A child must not block when
stdout exceeds a pipe buffer. Preserve cancellation and typed errors.

### Tests to add or extend

- Codable catalog/default fixtures, unknown-key compatibility, and malformed
  required fields.
- Exact literal argv for every new command and hostile values.
- Process adapter with model output larger than a pipe buffer.
- Independent provider success/failure and stale cache behavior.
- Model change selects the provider default effort, then `medium`, then the
  first supported value.
- Fixed-thinking models disable/replace the effort slider.
- Save and launch are distinct state changes.
- One provider failure does not blank projects or the other provider.
- Accessibility labels expose provider, model, effort, and slider position.

### Verification checklist

- Existing 36 Swift tests remain green.
- All new tests use `FakeFoldviewCLI` and real-process fixtures where
  appropriate.
- No synchronous provider process waits occur on `@MainActor`.
- The sheet fits the existing popover at default text size and remains usable
  with increased text size.

### Anti-pattern guards

- Do not add another `@main` type.
- Do not bump the deployment target to macOS 15 for prototype-only preview API.
- Do not import the executable-only Model Dial package.
- Do not let a slider movement write persistent config.
- Do not add direct Swift AppleScript for AI windows.

## Phase 5 — Complete the menu-bar lifecycle and settings bridge

### What to implement

Finish the existing 2026-07-11 menu-bar design rather than retaining its stub.

Add:

```text
mac/Packaging/Info.plist
mac/Packaging/package-app.sh
```

Copy the complete packaging pattern from
`prototypes/model-dial/Packaging/`, renamed for:

- Executable: `FoldviewMenuBar`.
- Display name: `Foldview`.
- Bundle ID: a stable Foldview identifier.
- `LSUIElement = true`.
- Terminal Automation usage description specific to Foldview.
- Install target: `~/Applications/Foldview.app`.

The packaging script must release-build, install into a temporary bundle,
validate `Info.plist`, ad-hoc sign for local use, verify the signature, then
atomically replace the installed app. It must not delete an arbitrary path or
follow an unresolved environment variable.

Replace `cmdMenubar` with a real local lifecycle:

- Default: package/install if needed, record the absolute `pm` path atomically,
  and launch the app.
- `--force-install`: rebuild and atomically replace the app.
- `--status`: report installed/running/version state without mutation.
- `--uninstall`: only after a separate explicit user request and with a
  recoverable Trash-based operation; it is not required by this build task.

Add the missing config bridge:

```text
pm config get --json
pm config set menubar.refreshSeconds <15-600>
pm config set menubar.showDiscoveredApps <true|false>
pm aiclis add --name <name> --executable <path>
pm aiclis remove --executable <path>
```

Wire `SettingsView` through `FoldviewCLI`/`AppStore` so the refresh interval
actually restarts the timer, discovered-app visibility affects Node status,
custom CLI management is no longer read-only, and `resolvedCLIPath` is assigned
after successful resolution.

### Documentation references

- Existing installer design:
  `docs/superpowers/specs/2026-07-11-menubar-localhost-cleanup-design.md`.
- Existing stub: `cmdMenubar` and its current test in
  `test/cli-surface.test.mjs`.
- Existing settings gaps: `mac/README.md` and `SettingsView.swift`.
- Packaging reference: `prototypes/model-dial/Packaging/`.

### Verification checklist

- `pm menubar --status` is read-only.
- `pm menubar` installs and launches a real local app.
- Repeated install is idempotent; force install replaces only the exact bundle.
- The installed app resolves the intended CLI path and displays projects.
- Refresh interval changes the live timer without restarting.
- `showDiscoveredApps` changes the payload while preserving project rows.
- Custom CLI add/remove round trips through Node config.
- Launch-at-login is manually verified from the installed bundle.

### Anti-pattern guards

- Do not keep a test that celebrates the installer stub.
- Do not mutate app config in Swift.
- Do not claim Developer-ID signing or notarization from an ad-hoc build.
- Do not use recursive deletion on `~`, `$HOME`, `/Applications`, or an
  unresolved bundle path.

## Phase 6 — Reconcile and complete the website without erasing approved work

### What to implement

Revise the current website plan before changing `site/index.html`. Preserve the
later user-approved state:

- Keep the corrected vanilla MacBook display/opening motion.
- Keep the added iPhone site showcase unless the user separately asks to remove
  it.
- Keep the founder/About section removed.
- Keep the static, zero-build HTML/CSS/JS delivery model.

Still apply the valid completion goals from the 2026-07-15 audit:

- Put the truthful product statement, install command, and one readable proof
  in the first viewport before any pinned scene.
- Correct the default-root documentation to `~/Documents` unless runtime is
  intentionally changed back.
- Correct GitHub identity to the actual FoldView remote or deliberately migrate
  the remote before changing copy.
- Replace “no network” absolutes with exact local-first language that discloses
  explicit GitHub actions and optional remote site assets.
- Show both Launch and AI Swarm in the product preview.
- Describe live all-listener port discovery rather than old guessed-port probes.
- Describe the menu-bar app only after the installer is real.
- Remove the remote LiquidGlass JavaScript import and any code path that cannot
  mount.
- Preserve dark/light, keyboard, reduced-motion, mobile, and no-JS usability.
- Extract CSS/JS only when it does not break the retained vanilla scenes.

Add or update:

```text
site/styles.css
site/app.js
test/site-content.test.mjs
docs/superpowers/plans/2026-07-15-foldview-website-redesign.md
```

The revised website plan must mark the MacBook-removal and founder-restoration
steps as superseded, then document the retained-scene acceptance gates.

### Verification checklist

- One `h1`; truthful install and product proof in the first viewport at
  1280×720 and 390×844.
- No remote JavaScript and no interaction-blocking loader.
- MacBook and iPhone sequences remain balanced and reduced-motion safe.
- No stale `lazyproj` URL unless it is the intentionally chosen canonical
  remote.
- README, CLI help, site, and actual root/network/port/menu-bar behavior agree.
- Correct MIME for extracted assets.
- Keyboard, 200% zoom, 320px reflow, clipboard failure, no-JS, light/dark,
  reduced-motion, and forced-colors checks pass.

### Anti-pattern guards

- Do not execute the old redesign plan mechanically.
- Do not reintroduce the removed About section.
- Do not advertise a native iPhone Foldview app; the phone scene demonstrates
  the website only.
- Do not convert this lineage to React or import the Rhea build output.
- Do not alter the retained scene merely to make a stale source-contract test
  pass; update the superseded contract explicitly.

## Phase 7 — Full verification, documentation, and preservation

### Automated gates

Run from the repository root:

```bash
node --check folder.mjs
npm test
node folder.mjs status --format menubar-json
node folder.mjs ai catalog --json
node folder.mjs menubar --status
```

Run from `mac/`:

```bash
swift build
swift test
./Packaging/package-app.sh
codesign --verify --deep --strict "$HOME/Applications/Foldview.app"
```

Required outcomes:

- All prior Node tests remain green, plus every new catalog/default/TUI/
  installer/site test.
- All prior 36 Swift tests remain green, plus all new model/store/process tests.
- Status remains below 500 ms on an ordinary warm root.
- Catalog output contains no credential material.
- Existing `pm --list`, `pm --json`, schema-v1 status, and no-override AI launch
  remain backward compatible.

### Manual macOS matrix

- Codex: every reported model; lowest, middle, highest supported efforts.
- Kimi K3: reported effort choices; K2.7 fixed-thinking behavior.
- One-session choices do not silently rewrite defaults.
- Saved defaults survive app and terminal restart.
- Projects/models containing spaces and apostrophes.
- One, two, three, four, and nine Terminal windows; existing windows untouched.
- Terminal Automation first prompt, denial, recovery, and retry.
- Popover open/close, stale catalog, provider missing, malformed config, and
  refresh during load.
- Keyboard and VoiceOver labels for CLI, model, effort, save, and launch.
- Light/dark, increased text size, launch at login, and app relaunch.
- Website viewport/accessibility matrix from Phase 6.

### Documentation and release alignment

Update only after behavior exists:

- `README.md` command surface and screenshots.
- `mac/README.md` architecture, build, install, and remaining release scope.
- `pm --help` and in-TUI key help.
- `site/index.html` product claims.
- The new model-control spec status to shipped.
- This plan status to implemented and verified.

Before calling the repository complete:

- Review the full dirty-tree attribution.
- Preserve all intended source, tests, assets, plans, and context bridges.
- Commit and push only after explicit user authorization.
- Do not include config backups, credentials, build caches, logs, or app bundles
  in source control.
- Update `/Users/yc/Documents/PROJECT-CONTEXT/foldview.md` and the Foldview KEMET
  domain with verified, non-sensitive facts.

## Final acceptance checklist

- [ ] Dynamic Codex and Kimi catalogs load independently.
- [ ] Model and effort controls appear in TUI and native quick launch.
- [ ] Only supported effort choices can be selected.
- [ ] Session launch and persistent-default save are separate actions.
- [ ] Node owns provider config and Terminal launch behavior.
- [ ] Existing CLI/status contracts remain compatible.
- [ ] A real Foldview app installs and launches from `pm menubar`.
- [ ] Menu-bar settings persist through the CLI and affect live behavior.
- [ ] Current website plan is reconciled with retained MacBook/iPhone decisions.
- [ ] Product claims match the implemented root, network, port, GitHub, and
      menu-bar behavior.
- [ ] All automated and manual gates pass.
- [ ] Valuable work is preserved and release scope is stated honestly.
