# Foldview model control — additive CLI and UI contract

**Date:** 2026-07-19  
**Status:** frozen implementation contract  
**Scope:** Codex and Kimi Code model discovery, saved defaults, and new-session launch overrides

## Product boundary

Foldview is the local control surface; Codex and Kimi Code remain the sources of
truth for their own models and defaults. Foldview may read a provider catalog on
demand, validate an explicit selection, update that provider's existing config,
or launch a new session with allowlisted overrides. It must not maintain a second
model/default catalog in `~/.foldview.json`.

The words **model** and **effort** are wire terms. “Quality” may be used as UI copy,
but `quality` is never a command flag, JSON field, config key, or persisted value.

## Frozen commands

The following machine-facing commands are additive:

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
             [--json]
```

`catalog` and `defaults` require `--json` in schema version 1. Unknown flags,
duplicate scalar flags, missing values, positional arguments, and providers other
than the exact lowercase IDs `codex` and `kimi` are invalid arguments.

Every command invoked with `--json` writes exactly one complete JSON document plus
an optional trailing newline to stdout on success or failure. It writes no progress,
warnings, provider output, or second document to stdout. Expected machine errors
described by this contract leave stderr empty and communicate through the JSON
document and exit status only. Unexpected runtime faults may use safe stderr after
the one JSON response has been produced, but must never expose secrets or raw
provider/config content.

The existing three-required-argument `pm action ai` form remains valid and has
unchanged behavior. `--project` and `--cli` must resolve to an absolute directory
and absolute executable respectively; `--count` remains an integer from 1 through
9. Model-control flags do not relax any existing path, executable, quoting,
Terminal, or window-layout validation.

`pm action ai --json` is the machine-facing launch form and is always used by the
Swift companion. After Terminal has successfully created exactly the requested
number of sessions, it emits:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "launched": 3,
  "provider": "codex",
  "model": "codex-deep",
  "effort": "high"
}
```

`launched` is the validated integer `1` through `9`. `provider` is the canonical
classified provider, or `null` for a custom/unsupported CLI with no model controls.
`model` and `effort` are the applied launch overrides, independently `null` when
omitted; they are not provider defaults inferred for display. A failure emits the
top-level `{schemaVersion:1, ok:false, error:{...}}` envelope, leaves stderr empty
for expected errors, and exits nonzero. Every argument, provider, catalog, and
selection validation error occurs before AppleScript runs and therefore opens zero
windows. Terminal Automation is not transactional: a runtime `launch_failed` may
leave a partial set after AppleScript begins. Foldview does not close any window it
cannot prove was created by that invocation, and a failure response makes no
`launched` count claim unless the completed count is known. Exit-zero success alone
guarantees that the requested count completed. Omitting `--json` preserves the
legacy human output and behavior exactly.

## Provider configuration resolution

Configuration paths are deterministic and never relative to the project or current
working directory:

- Codex uses `<CODEX_HOME>/config.toml` only when `CODEX_HOME` is a non-empty
  absolute path. Otherwise it uses `<current-user-home>/.codex/config.toml`.
- Kimi always uses `<current-user-home>/.kimi-code/config.toml`; no environment
  override is accepted.

`current-user-home` comes from the operating-system account record for the effective
user, not an arbitrary project path. Relative/empty `CODEX_HOME` is ignored, never
resolved against cwd. An existing config that cannot be read, is not owned by the
effective user, lacks safe permissions, exceeds limits, or fails the accepted parser
makes that provider unavailable with a safe `config_read_failed` or
`malformed_catalog` error. An existing config must be a regular file owned by the
effective user, owner-readable (`mode & 0o400 != 0`), and private
(`mode & 0o077 == 0`). An unsafe or failed initial `lstat`/open/read is
`config_read_failed`. A missing config is not a parse/permission failure: its
defaults are `null`, and a defaults write may create a new mode-`0600` regular file
only after a catalog obtained independently of that missing file validates the
selection. Because Kimi's catalog is config-declared, a missing Kimi config has no
models and is unavailable until Kimi creates/configures it; Foldview does not invent
aliases to make it writable.

## Catalog contract

`pm ai catalog --json` probes both providers. The filtered form probes and returns
only the requested provider. Catalog probing is explicit and on demand: it never
runs as part of `pm status`, `pm status --format menubar-json`, periodic project
refresh, or unrelated actions.

The success envelope is:

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

Rules for every field:

- `schemaVersion` is the integer `1`; consumers must reject unknown versions.
- `generatedAt` is a UTC ISO-8601 instant for this probe, not a cache-expiry time.
- Providers are ordered `codex`, then `kimi`; a provider-filtered result contains
  one entry.
- `id` is the stable provider ID and `name` is presentation text.
- `executable` is the resolved absolute executable when one is found, otherwise
  `null`.
- `available` is `true` only when the provider was found and its catalog was
  parsed into at least one model.
- `error` is `null` for an available provider. Otherwise it is the safe error
  object defined below.
- `defaultModel` and `defaultEffort` are normalized saved defaults when readable;
  either may be `null`. A value is not invented when the provider has none.
- `models` is an ordered array and is empty for an unavailable provider. A provider
  may expose at most 256 normalized models.
- A model's `id` is the exact provider launch ID or alias. `label` and `detail`
  are presentation strings derived from provider data.
- `efforts` is the exact ordered set reported for that model, after the duplicate
  normalization below, and contains at most 16 values. An empty array means no
  user-selectable effort. It must not be filled with guessed levels.
- `defaultEffort` is the provider-reported default for that model or `null`.

Every UI option has exactly one source: provider choices use `providers[].id`,
model slider stops use `models[].id` and `label`, descriptive copy uses `detail`,
effort slider stops use `efforts[]`, and initial selections use `defaultModel`,
provider `defaultEffort`, then model `defaultEffort` only as a presentation
fallback. The UI may not hard-code model IDs or effort levels.

### Catalog normalization and provider adapters

Normalization is deterministic and locale-independent:

- A model ID/alias must be a non-empty UTF-8 string of at most 256 bytes with no
  NUL, Unicode category `Cc` or `Cf`, DEL, or bidi formatting/control character.
  An effort must match
  `[A-Za-z0-9._-]{1,64}`. Invalid IDs, aliases, or effort values are omitted.
- Presentation `label` and `detail` replace Unicode categories `Cc` and `Cf`, DEL,
  and every bidi formatting/control character with one space, collapse whitespace,
  trim, and are capped at 160 and 512 Unicode scalar values respectively. This
  explicitly covers LRM/RLM, isolates, embeddings, overrides, and directional
  marks even when a runtime classifies them differently. An empty label falls back
  to the valid model ID; an empty detail falls back to `Codex model` or
  `Kimi managed model`.
- Duplicate model IDs keep the first valid occurrence in provider source order;
  later occurrences are ignored. Duplicate efforts keep their first occurrence
  and retain provider order. More than 256 valid unique models or more than 16
  valid unique efforts on one model makes that provider `malformed_catalog`; data
  is never silently truncated.
- A model `defaultEffort` that is absent or not in its normalized `efforts` becomes
  `null`. A provider `defaultModel` not present in normalized models becomes
  `null`. A provider `defaultEffort` that is invalid or unsupported by its valid
  default model becomes `null`; fixed-thinking models always report `null`.
- Text comparison is ascending by UTF-8 byte sequence, not process locale. Final
  sort ties are broken by model ID using the same comparison.
- Provider/config inputs larger than 8 MiB are rejected rather than partially
  parsed. Any individual target string longer than 4 KiB before normalization is
  invalid. Array and model limits are checked before a payload is published.

Codex is queried by executing the resolved binary with literal arguments
`debug models`. Both a wrapped object `{ "models": [...] }` and a bare model array
are accepted. Only entries with absent visibility or visibility `list` are
exposed. A finite integer `priority` sorts ascending; a missing, non-integer, or
non-finite priority normalizes to `999`. Entries are then sorted by normalized
label and ID using the bytewise rule above. The adapter maps `slug`,
`display_name`, `description`,
`supported_reasoning_levels[].effort`, and `default_reasoning_level`; unknown
fields are ignored. The root must have one of the two accepted shapes; every kept
entry must be an object with a valid string `slug`. Missing/non-string label or
description uses the documented fallback. Missing reasoning-level arrays mean no
selectable efforts; non-array reasoning-level fields and non-object level entries
are invalid and omitted. A non-string or unsupported default reasoning level
normalizes to `null`.

The Codex probe has a hard five-second wall-clock timeout and an 8 MiB combined
stdout-plus-stderr limit. Output is captured through mode-`0600` temporary files so
the child cannot deadlock on a full pipe. On timeout or limit breach Foldview sends
SIGTERM to the child process group, waits at most 250 ms, sends SIGKILL if it is
still alive, reaps it, and removes capture files. Timeout maps to `catalog_timeout`;
limit breach or invalid JSON maps to `malformed_catalog`. Neither response includes
captured bytes.

Kimi's catalog is read from its existing config. Foldview reads only model aliases,
remote model/display names, capabilities, `support_efforts`, `default_effort`,
`default_model`, and `[thinking]`. Comment parsing is quote-aware: a `#` inside a
quoted string is data, while an unquoted `#` begins a comment. A thinking-capable
model with no `support_efforts` is fixed-thinking and exposes `efforts: []` rather
than fabricated choices. Kimi models preserve valid declared model-table source
order after deterministic first-occurrence effort deduplication. There is no alias,
family, version, speed, label, or ID ranking rule; Foldview never moves a Kimi model
because of its name.

### Accepted line-preserving TOML subset

Foldview is not a general TOML parser. For the fields it reads or writes it accepts
UTF-8 (without a BOM), LF or CRLF line endings, blank/comment lines, and these
single-line forms:

- for Codex, top-level `model = "..."` and
  `model_reasoning_effort = "..."` assignments before the first table;
- a top-level `default_model = "..."` assignment before the first table;
- `[models."<alias>"]` tables containing optional `model`, `display_name`,
  `capabilities`, `support_efforts`, and `default_effort` assignments;
- one optional `[thinking]` table containing `enabled = true|false` and
  `effort = "..."`;
- double-quoted basic strings whose only escapes are `\\`, `\"`, `\n`, `\r`, and
  `\t`, and single-line arrays of those strings with commas and an optional trailing
  comma.

Spaces around keys, `=`, values, and comments are accepted. An unquoted `#` begins
a comment; quoted `#` remains data. Unknown keys and unknown tables are opaque and
preserved byte-for-byte only when every physical line is an independently complete
single-line comment, assignment, or table header. A global pre-scan rejects triple-
quoted strings, a quoted/basic string continued onto another physical line,
arrays or inline tables whose opening and closing delimiters are on different
physical lines, backslash continuation, and any assignment/value or table header
that is not complete on its own line—even inside unknown tables. A malformed target
assignment/table, invalid UTF-8, unclosed quote/array/inline table, unsupported
escape, duplicate target key, duplicate model alias table, duplicate `[thinking]`,
target dotted key, or `[[models]]` form also fails. An initial catalog read reports
the affected provider as `malformed_catalog`; an initial defaults read/mutation
reports `config_read_failed`. If a previously verified initial snapshot becomes
malformed or otherwise differs after the lock is acquired, the change is
`config_changed`. The same result applies to duplicate/malformed Codex target keys.
Foldview does not guess through ambiguous syntax or regenerate the document.

For writes, only the value token on an existing target line is replaced; its
indentation, key spacing, comment, and line ending stay unchanged. A missing
top-level key is inserted immediately before the first table. A missing
`[thinking].effort` is inserted at the end of the existing `[thinking]` table, or a
new `[thinking]` table is appended using the file's existing line ending. Clearing
an effort removes only that target assignment line; for Codex that line is
`model_reasoning_effort`, and for Kimi it is `[thinking].effort`. No opaque line is
normalized.

### Partial failure

Providers are independent. Failure, absence, malformed output, or timeout from one
provider does not suppress a valid result from another. An unfiltered request
always emits exactly one catalog envelope containing both provider entries; it
exits zero if and only if at least one provider is available, otherwise nonzero. A
filtered request always emits exactly one catalog envelope containing the requested
provider entry; it exits zero when that provider is available and nonzero when it
is unavailable. Failed entries use `available: false`, `models: []`, and a safe
`error`. Catalog failures never switch to the top-level error envelope merely
because all requested providers are unavailable.

## Defaults contracts

Successful `defaults get` output is:

```json
{
  "schemaVersion": 1,
  "provider": "codex",
  "defaultModel": "codex-deep",
  "defaultEffort": "high"
}
```

`defaultModel` or `defaultEffort` may be `null`. The response contains normalized
values only, never raw config text.

Successful `defaults set` output is:

```json
{
  "schemaVersion": 1,
  "provider": "codex",
  "defaultModel": "codex-deep",
  "defaultEffort": "high",
  "saved": true
}
```

The returned defaults are re-read after the atomic write. `saved: true` means the
new provider configuration was durably renamed into place. The response never
contains a config path, temporary path, lock path, or backup path.

`defaults set` always obtains a fresh authoritative provider catalog during the
locked write protocol below: Codex uses its bounded external probe, while Kimi
parses the exact post-lock config snapshot. The model must exist in that catalog.
When `--effort` is supplied, it must
be present in that model's `efforts`; an effort is invalid for a fixed-thinking
model. When `--effort` is omitted, Foldview preserves the existing configured
effort only if the new model reports support for it. Otherwise it writes the new
model's valid reported `defaultEffort`; if there is none, it removes the provider's
effort assignment. The success response is the exact normalized model and effort
re-read after that operation, including `defaultEffort: null` when cleared. No
write occurs until the model and any explicit effort are valid.

Provider configuration mutations are exhaustively allowlisted:

- Codex changes only top-level `model` and `model_reasoning_effort`. Model-only
  fallback/clear applies to `model_reasoning_effort`.
- Kimi changes only top-level `default_model`, `[thinking].effort`, and the
  specifically required `[thinking].enabled` transition below. An explicit
  `--effort` writes the effort and sets `[thinking].enabled = true` in the same
  atomic mutation, inserting the key/table if absent. A model-only save may
  preserve/fallback/clear `[thinking].effort` but never toggles or inserts
  `[thinking].enabled`.

`defaults get`, catalog `defaultEffort`, and defaults-set success report effective
defaults. For Kimi, `defaultEffort` is the valid `[thinking].effort` only when
`[thinking].enabled = true` and the selected model supports it; otherwise it is
`null`. A model-only save with thinking disabled leaves it disabled, even if it
repairs the dormant configured effort, and therefore returns `defaultEffort: null`.
An explicit effort save enables thinking and returns that validated effort.

## Session versus saved-default semantics

The UI owns a draft selection while a panel or prompt is open. Moving a model or
effort slider changes only that draft. It performs no config write and launches
nothing.

When the model slider changes, the draft effort is reset deterministically: keep
the current draft effort if the new model supports it; otherwise use the new model's
valid `defaultEffort`; otherwise use the first value in its declared `efforts`.
Zero efforts skips/hides the effort step. Exactly one effort auto-selects that value
and renders it read-only rather than as an interactive slider.

- **Launch:** `pm action ai` overrides apply only to the newly created Terminal
  sessions. They do not mutate provider configuration or Foldview configuration.
- **Save default:** `pm ai defaults set` mutates only the chosen provider's
  established config. It affects sessions started after the save, including the
  legacy action form with no override.
- **Already running sessions:** neither operation changes a running Codex or Kimi
  process. Foldview must never claim live switching.
- **No override:** the legacy `--project`, `--cli`, `--count` form invokes the CLI
  exactly as before and lets the provider use its existing defaults.
- **Provider only:** validates that the provider matches the executable, then uses
  the unchanged invocation.
- **Model only:** adds only the allowlisted provider model argument. The provider
  decides the effort because no effort override was requested.
- **Effort only:** validates against the fresh catalog entry for the provider's
  current default model and adds only the allowlisted effort override.
- **Model and effort:** validates the exact pair and applies both overrides.

The launch adapters are closed allowlists. With a model override, Codex adds the
literal argv pair `--model`, `<id>`. With an effort override it adds the literal
argv pair `--config`, `model_reasoning_effort="<effort>"`; those are the only Codex
model-control tokens. Kimi adds the literal argv pair `--model`, `<alias>` for a
model override and the single allowlisted environment assignment
`KIMI_MODEL_THINKING_EFFORT=<effort>` for an effort override; those are the only
Kimi model-control tokens. No other argv, config expression, or environment name
is accepted from a UI or config file.

If `--provider` is omitted but a model-control override is present, Foldview
classifies the resolved executable only by matching it to the canonical absolute
executable and stable provider ID in Foldview's known discovery record. Matching
uses the resolved canonical path (and file identity where available), not basename,
editable display name, model name, or a custom entry's label. No match or multiple
provider records for one executable is an error. If `--provider` is supplied, it
must match that canonical discovery record.

## State, freshness, and error contract

Catalog UI state is one of `idle`, `loading`, `ready`, `stale`, or `error` per
provider. `stale` is UI-derived state: the UI had a prior `ready` catalog, submitted
a selection, and a later stateless Node validation returned `unsupported_model` or
`unsupported_effort`, or a refresh failed while the prior catalog remained visible.
Node has no `stale_catalog` error and keeps no client catalog history. The UI may
retain the prior catalog visibly, but marks it stale and disables Save/Launch until
a successful refresh and new valid selection. Opening the panel and retrying
explicitly request a new catalog; periodic status refresh does not.

On a disappeared selection, Node returns `unsupported_model` or
`unsupported_effort`, leaves config and Terminal untouched, and the UI derives the
stale transition from its own prior-ready state. `generatedAt` alone never proves
freshness; the Node operation's immediate provider probe is authoritative.

Top-level command failures use this shape on stdout when `--json` was requested:

```json
{
  "schemaVersion": 1,
  "ok": false,
  "error": {
    "code": "unsupported_effort",
    "message": "Effort extreme is not supported by codex-deep.",
    "provider": "codex",
    "model": "codex-deep",
    "effort": "extreme",
    "retryable": false
  }
}
```

Provider entries in a partial catalog use the same error object, omitting fields
that are not applicable. Error `message` is concise, actionable, safe to show, and
sanitized by replacing Unicode categories `Cc`/`Cf`, DEL, and bidi controls before
whitespace collapsing and truncation. IDs copied into error fields must already
pass the strict ID rule; invalid raw values are omitted rather than reflected. Defaults and
other top-level command failures set a nonzero exit status. Stable Node error codes
are:

| Code | Meaning | Retryable |
| --- | --- | --- |
| `invalid_arguments` | Missing, duplicate, unknown, or malformed CLI input | no |
| `unsupported_provider` | Provider ID is not supported | no |
| `provider_unavailable` | Executable or required config is not available | yes |
| `provider_mismatch` | Provider does not match the resolved executable | no |
| `catalog_timeout` | Provider catalog probe exceeded its bound | yes |
| `malformed_catalog` | Provider output/config cannot produce a safe catalog | yes |
| `unsupported_model` | Fresh catalog does not contain the requested model | no |
| `unsupported_effort` | Model does not report the requested effort | no |
| `config_read_failed` | Provider defaults could not be read safely | yes |
| `config_locked` | Another bounded provider config writer owns the lock | yes |
| `config_changed` | Config identity or content changed during the locked write | yes |
| `config_write_failed` | Backup, fsync, rename, mode restore, or re-read failed | yes |
| `launch_failed` | Terminal Automation did not complete every requested session; partial creation is possible | yes |

Errors must not include stack traces, environment dumps, command output containing
secrets, full config lines, or provider response bodies.

## Safe configuration writes and backups

Foldview never sends catalog or configuration data over the network itself. It
executes only resolved provider binaries, reads only established provider config
files, and passes launch values through literal argv plus the existing audited
Terminal quoting boundary. There is no generic extra-arguments or environment
editor.

A provider config must first pass `lstat`, then an opened-descriptor `fstat`
identity check. It must be a regular file with link count one, owned by the effective
user (`st_uid === geteuid()`), owner-readable (`mode & 0o400 != 0`), and private
(`mode & 0o077 == 0`). Symlinks, unsafe modes, non-regular files, initial ownership
failure, and initial path-to-descriptor races are `config_read_failed`; Foldview
never follows a config symlink. Once the provider lock is acquired, any observed
path, identity, owner, mode, size, mtime, content, open, or read deviation from the
locked snapshot is `config_changed`, including a file appearing or disappearing.

A defaults write must, in order:

1. perform the initial safe config read/parse for provider availability and reload
   the external Codex catalog when applicable; authoritative Kimi selection
   validation is deferred until the exact locked config snapshot exists;
2. acquire the concrete bounded provider-specific lock below or fail with
   `config_locked`;
3. re-open without following links and re-read the exact source after acquiring the
   lock; record its device, inode, owner, mode, size, nanosecond-resolution mtime
   where available, and SHA-256 content hash (or record a missing-file sentinel);
4. for Kimi, parse the catalog and defaults from that exact locked snapshot and
   validate the selection against it; for Codex, combine the fresh external catalog
   with defaults parsed from this exact snapshot;
5. transform only the targeted top-level key(s) or Kimi `[thinking]` fields;
6. preserve unknown keys/tables, comments, quoted `#`, line endings, and unrelated
   content byte-for-byte;
7. create a sibling timestamped backup exclusively before writing any bytes;
8. create a same-directory temporary file exclusively before writing any bytes,
   write transformed bytes, flush, and `fsync` it;
9. immediately before rename, `lstat`, open/re-read without following links, and
   recompute the complete identity tuple and SHA-256 hash; if any field/content
   differs, or a missing file appeared/disappeared, abort with `config_changed`,
   remove the temporary file, and skip this rename;
10. atomically rename the verified temporary file, verify/restore the original
    mode and effective-user ownership, and `fsync` the directory where supported;
11. re-read the normalized effective defaults and release the lock.

The lock is a provider-config sibling named by appending `.foldview.lock`. It is
created with `O_CREAT|O_EXCL|O_WRONLY` and mode `0600`, contains only the writer PID
and UTC creation instant, and is flushed before mutation. On collision Foldview
retries at intervals no greater than 50 ms for a total wall-clock bound of two
seconds. A colliding lock may be removed only when it is a regular file owned by the
current user, no larger than 1 KiB, parses correctly, is at least ten minutes old,
and `kill(pid, 0)` proves `ESRCH`. `EPERM`, a live PID, malformed content, a symlink,
or an unverifiable age is treated as active and never broken. Lock removal and
re-acquisition are exclusive; after two seconds the command returns
`config_locked`. The owner removes only the same inode it created, in `finally`.

Temporary and backup files are siblings created with `O_CREAT|O_EXCL|O_NOFOLLOW`
where available and initial mode `sourceMode & 0o700`: group/other bits remain zero
and the existing config's owner permission bits are preserved exactly. This mode is
established before any bytes are written. Backup names use a UTC millisecond timestamp; a
collision appends `-1`, `-2`, and so on, each attempted exclusively, with a maximum
of 1,000 candidates before `config_write_failed`. Temporary names use an
unpredictable per-process nonce and also fail rather than reuse an existing path.
The backup is copied from the already verified source descriptor, flushed, and
closed before the temporary file is renamed.

For a missing source file there is no backup. The missing sentinel must still match
immediately before rename; the new file is created through the exclusive temporary
path with mode `0600`, LF line endings, owned by the effective user, and atomically
installed. Before any write, the immediate parent must be an existing non-symlink
directory owned by the effective user, owner-writable/searchable
(`mode & 0o300 == 0o300`), and not group/other-writable (`mode & 0o022 == 0`). Parent
directories are never selected from cwd and are not recursively created from
untrusted input.

The `.foldview.lock` serializes Foldview writers. The final identity/hash check
catches changes by external non-locking writers that are observable before that
check, but this is a best-effort defense: POSIX does not provide an atomic
compare-and-rename, so it cannot eliminate the final check-to-rename race. Foldview
does not claim that every external write is prevented or that an undetected write
in that narrow interval can never be overwritten.

Failures before rename leave the original intact. Failures after backup leave that
unique backup recoverable; no rolling backup is overwritten. Backups are local and
their paths are never returned in JSON. API keys, tokens, provider credentials,
raw config, and credential-bearing lines are never logged or copied into errors,
Foldview config, status payloads, or fixtures.

## Compatibility guarantees

- Existing commands and the three-required-argument `pm action ai` remain valid.
- Schema-v1 menu-bar status is unchanged. In particular every `aiClis` item remains
  exactly `{ "name": string, "executable": absolute-string }`; provider, model,
  and effort fields are not added there.
- Model catalogs are a separate on-demand contract and never appear in periodic
  status payloads.
- Custom and unsupported CLIs continue to launch through the existing path and are
  never given model-control fields.
- The Node CLI owns discovery, validation, provider config writes, and Terminal
  launch. Swift presents decoded data and invokes literal CLI argv; it never writes
  `~/.foldview.json`, Codex config, or Kimi config directly.
- Swift always invokes `pm action ai --json` and decodes its one-document response;
  scripts/users omitting `--json` retain the legacy action surface.
- No React, Vite, Tailwind, TOML dependency, or background daemon is introduced by
  this contract. The Node runtime remains zero-dependency.
- Readers reject unknown schema versions instead of guessing. Additive fields may
  be ignored only within schema version 1; required fields and their types remain
  stable.

## Acceptance gates

The contract is ready for product integration only when all of these pass:

1. Wrapped and bare Codex fixtures parse, invisible models are excluded, and
   priority/label order is deterministic.
2. Kimi aliases preserve declared table order; quoted `#`, selectable efforts,
   effective defaults, and fixed-thinking models parse without regenerating TOML.
3. One provider's absence, malformed output, or timeout preserves the other
   provider in a partial catalog response.
4. Unsupported provider/model/effort, provider mismatch, UI-derived stale state,
   lock contention, malformed config, timeout, and write failure return stable safe
   outcomes and perform no launch or unintended mutation; Node never emits a
   `stale_catalog` code.
5. Defaults round trips preserve permissions, comments, line endings, unknown
   content, and unrelated provider settings; each successful mutation creates a
   unique exclusively-created timestamped sibling backup, and symlink/non-regular
   configs are rejected.
6. The JSON payloads contain no API keys, tokens, raw config, config/backup/temp/lock
   paths, provider stderr, or environment values.
7. Moving either slider performs zero writes. Launch overrides affect only new
   sessions; Save Default affects only later sessions; running sessions are never
   described as switched.
8. Codex and Kimi invocation tokens match the allowlist exactly, all selections are
   freshly validated, and adversarial values cannot create shell syntax.
9. Existing AI-terminal tests and strict schema-v1 `aiClis` shape tests pass without
   fixture changes; catalog probing never occurs during status.
10. Node tests, Swift tests, Swift release build, menu-bar latency, malformed/stale
    UI states, and a real local Codex/Kimi smoke test pass before release claims.
11. Every `--json` path emits exactly one JSON document, expected errors leave
    stderr empty, and filtered/unfiltered catalog exit codes follow the frozen
    partial-failure matrix.
12. Five-second/8-MiB Codex probe cleanup, two-second exclusive locking, restrictive
    pre-write modes, collision-safe backups, normalization limits, and malformed
    TOML cases have deterministic tests.
13. AI action JSON success/failure has the exact frozen shape, Swift always requests
    it, and legacy action output is unchanged when `--json` is omitted.
14. Config resolution never depends on cwd; exact private mode/current-user
    ownership and locked Kimi snapshot validation are enforced; an observable
    post-lock identity/mtime/hash change returns `config_changed` before rename;
    the documented final POSIX race remains; missing-file creation is `0600` + LF.
15. Global multiline-TOML rejection, Unicode `Cf`/bidi sanitization, all-unavailable
    catalog behavior, source-order Kimi models, and deterministic effort reset have
    representative fixtures and tests.
