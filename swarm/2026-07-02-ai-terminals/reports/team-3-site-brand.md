# Team 3 — site-brand — report

Scope: `site/index.html` only (single-page landing site). One pass, no CSS restructuring, no analytics/tracking added.

## What changed

### Brand contract compliance
- `<title>`, `<meta name="description">`, `og:title`, `og:description` rewritten to lead with the frozen tagline
  (`Your projects and AI coding tools, ready in one terminal.`) and short description
  (`A friendly terminal home for projects, local apps, and AI coding agents.`).
- Hero H1 is now the frozen tagline verbatim (gradient-styled, no inline `<span>` splitting the string, so it's
  intact as one text run). Hero sub-paragraph opens with the frozen short description verbatim as its own sentence,
  followed by one direct outcome ("Open it and see what you're working on, what's already running, and how to start
  your next AI coding session") and a local-first trust statement in the same paragraph ("project discovery, CLI
  detection, and configuration stay on your machine — no cloud sync, no accounts").
- Category language updated to "terminal home for your projects and AI tools" (features heading); avoided
  "project manager" / "folder viewer" / "AI agent" as the product's self-description throughout.

### AI terminals made the flagship feature
- Bento grid: the first (largest, col-3) card is now "AI terminals for the CLI you already have" — describes
  select project → `a` → detected-or-custom CLI → 1–9 tiled windows, using the spec's exact status-message example
  `opened 3 × claude`, states macOS-only truthfully, and mentions the optional macOS 14+ menu-bar companion as
  "on the way" (not claimed as shipped, since Team 4's `mac/**` work is concurrent/unverified from here).
- Added a new truthful card "Local apps, not just projects" describing detected/discovered/pinned local apps and
  `~/.foldview.json`, which folder.mjs already implements but the old site never mentioned.
- Kept all other existing truthful cards (launch-any-project, sorts-to-top, LOC, live-port detection, git status,
  language breakdown); folded the old standalone "Size" card into the LOC card's copy to keep the grid at exactly
  8 cards (2 wide + 6 narrow) so no CSS/grid math changed.
- Added the `a` key to the `#keys` reference table (it was missing entirely) and to both terminal-mockup footer
  hint strings (hero mock + the "just type billa" animated demo).
- "How it works" step 3 now mentions `a` alongside `↵` for a faster path to the flagship workflow.
- Final CTA and footer brand paragraph reworded to the new category/voice.

### Stale-identity / accuracy fixes found during audit
- The animated TUI mockup's header literally rendered the **old** brand string `project manager 📁` — fixed to
  `foldview 📁`, matching the spec's "compact foldview wordmark in the TUI header, folder emoji as a small accent."
- **Real bug, not just copy**: every install command on the page said `npm i -g foldview`, but `package.json`'s
  actual `name` field is `folderpreview` (bins: `pm`, `folderpreview`, `project-manager`, `billa` — there is no
  `foldview` executable/package). Fixed all 9 occurrences (hero, step 1, finale CTA, their `data-copy`/aria-label
  duplicates, and the OG description) to `npm i -g folderpreview`. Same fix applied to the footer "aliases" line
  and the step-1 sentence, replacing the fictitious `foldview` bin mention with the real `folderpreview` one.
- **Real bug**: every GitHub link pointed to `github.com/coolyiqiao123/foldview`, which does not match this repo's
  actual git remote (`git remote -v` → `https://github.com/coolyiqiao123/lazyproj.git`). `lazyproj` is itself the
  old pre-rebrand project name (per the user's own memory notes and the spec's "stale identity" language), but
  `GLOBAL-CONTEXT.md` explicitly forbids renaming the repository as part of this task, and pointing the site at a
  repo that doesn't exist is strictly worse than pointing it at the real (if awkwardly-named) one. Repointed all 5
  GitHub links + the npm package link (`npmjs.com/package/folderpreview`) to the real remote/package name.
  **Flagging this for the team lead / docs-brand team**: if README.md or package.json link to GitHub anywhere,
  they likely have the same `coolyiqiao123/foldview` bug — worth a cross-check, since I can't edit those files.

## Verification
- `python3` `html.parser`-based tag-balance check over the full file: 0 errors, empty open-tag stack (well-formed,
  no stray/mismatched/unclosed tags).
- `grep -inE "project manager|folder viewer|lazyproj|AI agent"` → only the 5 intentional, now-correct
  `coolyiqiao123/lazyproj` GitHub links remain; no stale "project manager"/"folder viewer" positioning language,
  no "AI agent" self-description.
- `grep -n "foldview"` remaining occurrences (all legitimate): the nav/footer lowercase wordmark logotype (design
  treatment, same convention the spec explicitly allows for the TUI header), a CSS comment, the `~/.foldview.json`
  config filename (must stay unchanged per contract), aria-labels/terminal-title strings describing the product by
  name, the fixed TUI-mockup header, and the new "Local apps" card's prose.
- `grep -n "npm i -g"` → all 6 remaining occurrences say `folderpreview`; 0 occurrences of
  `coolyiqiao123/foldview` remain.
- No new external network calls, analytics, or tracking added; existing Google Fonts preconnect + liquidglass CDN
  module (both pre-existing) left untouched.

## Not done / out of my file scope
- Did not touch `folder.mjs`'s actual TUI header text (still literally says `project manager 📁` there as of this
  read) — that's Team 1's file; the site now depicts the *target* wordmark per spec, which will be true once
  Team 1 finishes.
- Did not verify whether `folderpreview` is actually published on the npm registry (no network access here) —
  used the name declared in this repo's own `package.json`, which is the most authoritative source available.
