# Foldview website redesign plan

Status: ready for phased implementation

Source audit: `DESIGN-IS-2026-07-15/`

## Outcome

Redesign the marketing website so a first-time developer can understand Foldview, trust its claims, and copy the install command in the first viewport. Preserve the brand and static delivery model; replace the decoration-first page structure.

Success at a glance:

- At 1280×720 and 390×844, the product `h1`, concise explanation, install command, and one product proof are visible without a scroll-driven prelude.
- The page has one clear naming model: Foldview is the product, `folderpreview` is the npm package, and `foldview`/`pm` are installed command aliases.
- The normal page flow contains no loader, pinned scene, custom cursor, faux progress, or remote JavaScript.
- Every product claim is bounded by the behavior established in source/tests.
- Keyboard, light/dark, reduced-motion, copy success/error, and mobile navigation work accessibly.

## Phase 0 — Documentation discovery and allowed APIs

Read before changing the site:

- Product identity and constraints: `package.json:1-22`, `README.md:1-16`, `README.md:38-143`, `LICENSE:1-20`.
- Scanner and launch truth: `folder.mjs:340-405`, `687-715`, `820-935`, `1606-1730`.
- Networked GitHub exception: `folder.mjs:1478-1596`.
- Current menu-bar status: `folder.mjs:2185-2190`, `mac/README.md:1-16`.
- Existing accessible patterns: `site/index.html:978-994`, `1035-1079`, `1438-1469`, `1878-1923`.
- Static server/MIME support: `folder.mjs:2192-2249`.
- Existing static-site tests: `test/static-site.test.mjs:15-104`, `test/helpers.mjs:10-22`.
- Prior website truth checks: `swarm/2026-07-02-ai-terminals/reports/team-3-site-brand.md:34-64`.

Allowed implementation surface:

- Plain HTML, CSS, and vanilla JavaScript. Node >=18 ESM remains the repository runtime.
- Existing browser APIs: `localStorage`, `matchMedia`, `navigator.clipboard.writeText`, DOM selectors/classes/attributes, and normal event listeners.
- `IntersectionObserver` and `requestAnimationFrame` are allowed only for optional progressive enhancement; all content must remain visible without them.
- Extracted `.css`, `.js`, images, and `.woff2` assets are supported by the existing static server (`folder.mjs:2195-2205`).
- Tests use `node:test`, `node:assert/strict`, `fs`, `path`, `http`, and `child_process` following `test/static-site.test.mjs`.

Disallowed assumptions:

- Do not introduce React, Vue, Vite, Tailwind, Sass, a bundler, hydration, or a new website dependency.
- Do not invent `npm run dev`, `build`, `lint`, or browser-test scripts; the repository currently exposes only `start`, `test`, and `postinstall` (`package.json:12-15`).
- Do not rename the npm package to `foldview`; `folderpreview` is the package and `foldview` is a bin alias (`package.json:2`, `6-10`).
- Do not depend on `document.execCommand('copy')` except as a legacy fallback.
- Do not retain or expand the LiquidGlass CDN integration; its own source comment records that it cannot mount (`site/index.html:1960-1999`).

Verification:

- Confirm every cited file/range still exists before implementation.
- Record any product-behavior drift discovered after this plan; source and executable tests override aspirational docs.

## Phase 1 — Freeze product truth and the new information architecture

### What to implement

Create a copy contract before restructuring markup. Copy the supported product facts from `package.json:1-22`, `README.md:38-143`, and the tested behaviors cited in Phase 0; do not paraphrase the current landing-page absolutes.

Use this naming hierarchy everywhere:

- Product: **Foldview**.
- npm package used in the install command: **`folderpreview`**.
- Preferred command shown after install: **`foldview`**.
- Short alias: **`pm`**, introduced once as an alias, not as a second product name.
- Legacy alias `project-manager`: leave to technical documentation/footer only if it remains necessary; do not feature it in conversion copy.

Use this hero copy as the starting contract:

```text
Your projects and AI coding tools, ready in one terminal.

Foldview scans a folder for local projects, shows detected development servers,
and opens supported sites or command-line AI tools without making you remember
every command.

Project scanning and settings stay on your machine. Online actions run only when
you explicitly choose them.
```

Replace the current 10-section order with this six-part information architecture:

1. **Header/nav** — Foldview logo, Overview, How it works, Shortcuts, GitHub, theme toggle. No auto-hide on scroll.
2. **Hero + proof strip** — `h1`, bounded explanation, primary copy-install control, secondary “View on GitHub,” readable terminal-dashboard proof, and three verified facts: zero npm runtime dependencies, Node 18+, MIT.
3. **Three core jobs** — See projects and detected servers; open/start a supported site; launch an installed/custom AI coding CLI. Use one card per job.
4. **Install and first run** — two commands and three compact steps. Explain package versus command directly beside the install control.
5. **Technical details** — core shortcuts plus text/JSON scripting. Use progressive disclosure through clear subsections, not another animation scene.
6. **Compact founder/final CTA + footer** — one short founder paragraph, one final install action, accurate project links.

Delete from the intended IA:

- The opening MacBook scroll scene.
- The looping “Just type foldview” demo as a separate section.
- The 180vh sentence reveal.
- The eight-card feature inventory as eight equal priorities; consolidate details under the three core jobs.
- Repeated section-link groups and repeated install actions that do not serve a distinct beginning/end decision point.

### Target files

- `site/index.html` — semantic content and new section order.
- `test/site-content.test.mjs` — new source-contract tests for names, claims, hierarchy, links, and removed anti-patterns.

### Verification checklist

- Exactly one `h1`, and it precedes all `h2` elements.
- At most two install-command controls: primary hero and final CTA.
- No user-facing strings matching: “every project,” “everything running,” “any project,” “100% local,” “no waiting,” “instantly,” “10 seconds,” “real lines of code,” or “on every Mac.”
- “View on GitHub” points to `https://github.com/coolyiqiao123/lazyproj`; no “Star on GitHub” label.
- Menu-bar copy says source/in-development unless `pm menubar` is actually shipped by implementation time.
- `npm i -g folderpreview` remains exact; `foldview` and `pm` are explained as commands/aliases.

### Anti-pattern guards

- Do not keep the old section order and merely rename headings.
- Do not let founder narrative precede proof of usefulness.
- Do not call a partial shortcut list “all shortcuts.” Label it “Core shortcuts.”
- Do not change product/runtime code to make marketing copy true; bound the copy to what is already true.

## Phase 2 — Build semantic, first-viewport HTML

### What to implement

Rewrite `site/index.html` around the Phase 1 IA. Copy the existing semantic header/nav/theme/menu patterns from `site/index.html:1035-1079`, but simplify the destinations and keep the header visible.

Hero structure:

- Left column: proof eyebrow, `h1`, two short paragraphs, install control, “View on GitHub.”
- Right column: a static/readable terminal-dashboard panel copied from the truthful preview content at `site/index.html:1093-1115` and the actual product vocabulary in `README.md:59-78`.
- On mobile: copy and install control first, terminal proof second. Do not scale a two-pane desktop terminal until its text is illegible; switch the proof to a single selected-project summary at <=700px.
- The hero must fit its core decision content inside 720px height at 1280px width and inside the first 844px at 390px width.

Accessibility structure:

- Add a first-focus skip link targeting `main`.
- Use native `<button type="button">` for copy controls; keep exact accessible names.
- Use one labeled primary nav; the mobile presentation may reuse the same link list or must ensure only one nav copy is focusable at a time.
- Keep all product-demo rows static unless they are fully interactive. If interactive, remove the parent `role="img"`, use real buttons, and support focus/keyboard/pause.
- Use sequential heading levels. Footer column labels must not introduce orphan `h4` elements.
- External-link text or accessible descriptions must make the destination clear; do not fake a star action.

### Documentation references

- Semantic/action patterns to copy: `site/index.html:1035-1079`, `1058-1069`, `1905-1923`.
- Keyboard copy pattern to replace with native buttons: handler behavior at `site/index.html:1438-1469`.
- Terminal proof vocabulary: `site/index.html:1093-1115`, `README.md:59-78`.
- Explicit error-not-color pattern: `test/spawn-ai.test.mjs:32-78`, `test/menubar-status.test.mjs:23-36`.

### Verification checklist

- Keyboard order begins: skip link, logo/home, nav, theme, GitHub, hero install.
- No hidden/offscreen control can receive focus.
- DOM contains one banner, one labeled primary nav, one main, and one contentinfo landmark in default desktop state.
- Copy success and failure are announced through an `aria-live="polite"` status node.
- Without JavaScript, all content and links remain visible and the install command remains selectable.
- At 200% zoom and 320 CSS px reflow, there is no page-level horizontal scrolling.

### Anti-pattern guards

- Do not use `div role="button"` where a native button works.
- Do not put interactive descendants inside `role="img"`.
- Do not hide the nav with transforms while leaving it keyboard-focusable.
- Do not make the terminal demo mouse-only or auto-changing by default.

## Phase 3 — Consolidate the visual system and responsive design

### What to implement

Preserve the blue night identity and terminal/dark-island direction from `site/index.html:28-80`, but consolidate the system before styling components.

Token targets:

- Spacing: `4, 8, 12, 16, 24, 32, 48, 64, 96px` only, except 1px borders.
- Type: `12, 14, 16, 18, 24, 32, 48, 64px` with `clamp()` for `h1`/`h2`; no sub-10px visible text.
- Radii: `8, 12, 16px`.
- Semantic colors: cap each theme at 18 named tokens, including surfaces/borders/statuses.
- Shadows: one elevation shadow plus focus outline; remove bespoke glow families.
- Content width: reuse `.wrap` behavior from `site/index.html:276-278`, with 24px desktop and 18px mobile inline padding.

Visual direction:

- Keep one quiet aurora/photo treatment only in the hero, with a solid/opaque contrast layer. The rest of the page uses flat dark surfaces with restrained borders.
- Keep terminal mono typography; use system sans/display stacks or self-hosted local assets. Remove Google Fonts requests if comparable brand hierarchy can be achieved without them.
- Use a two-column hero at desktop and a single-column order at <=820px.
- Use three equal core-job cards at desktop, one column at <=820px.
- Give the install section a distinct high-contrast surface, not another glass variation.
- Keep light and dark themes, but retune light `--faint`, `--brand-2`, `--green`, `--cyan`, and `--red` until all normal text reaches 4.5:1. Dark-island faint text must also reach 4.5:1.

Remove:

- Loader and faux percentage UI.
- `.mac-*`, `.reveal-*`, `.meadow-*`, `.bfly-*`, garden-child, custom-cursor, grid-glow, and LiquidGlass/WebGL styling.
- Idle mesh/aurora movement and continuous terminal loops.
- Per-card pointer sheen, lift/scale, and gradient-edge effects. Use one restrained border/background hover state on actual interactive elements only.

### Target files

- Prefer `site/styles.css` for the redesigned CSS and link it from `site/index.html`.
- Keep `site/assets/aurora-sky.jpg` only if the simplified hero uses it; otherwise remove the reference and leave the user-owned asset untouched until cleanup is explicitly approved.
- `test/static-site.test.mjs` — extend the existing HTTP harness to verify extracted CSS asset status and MIME type.

### Documentation references

- Tokens/themes to copy and simplify: `site/index.html:28-80`.
- Typography/layout patterns: `site/index.html:276-293`, `413-418`, `627-628`.
- Responsive grid examples: `site/index.html:529-615`.
- Focus and reduced-motion baseline: `site/index.html:978-994`.
- Static asset MIME support: `folder.mjs:2195-2205`; HTTP test harness: `test/static-site.test.mjs:55-103`.

### Verification checklist

- Automated token audit finds no spacing, type, radius, or color literals outside the approved scale, except documented SVG illustration colors.
- All normal text meets WCAG AA in dark/light themes; focus indicators meet 3:1 against adjacent colors.
- Screenshot checks at 1440×900, 1280×720, 820×1180, 390×844, 375×812, and 320×568.
- Hero decision content is visible without scroll at 1280×720 and 390×844.
- No horizontal overflow at any target width.
- `prefers-color-scheme`, saved theme selection, and dark terminal islands still behave as documented at `site/index.html:9-18`, `53-80`, `1878-1903`.

### Anti-pattern guards

- Do not replace liquid glass with a different trend effect.
- Do not add new breakpoints beyond consolidating the existing 820/700/560 family without evidence.
- Do not use faint text for essential metadata.
- Do not make mobile terminal text microscopic to preserve the desktop composition.

## Phase 4 — Rebuild only necessary interaction and state logic

### What to implement

Create a small `site/app.js` containing only:

1. Pre-paint/saved theme handling and theme-button label synchronization, copied from `site/index.html:9-18`, `1878-1903`.
2. Mobile menu expanded state, Escape/outside/link close, copied from `site/index.html:1905-1923`.
3. Native copy-button behavior using `navigator.clipboard.writeText` as primary API, plus a guarded fallback. Update visible state and a shared `aria-live="polite"` message for both success and failure.

Do not recreate:

- Loader timers.
- Scroll-pinned transforms or word reveal.
- Custom cursor or pointer flashlight.
- Auto-hidden nav.
- Auto-cycling/typing terminal demos.
- Glass DOM injection or remote ES-module import.

State matrix:

| State | Required behavior |
|---|---|
| Default | All core content visible without JS or motion |
| Copy success | “Install command copied” visible and announced; resets without losing focus |
| Copy error | “Could not copy—select the command manually” visible and announced |
| Focus | 2px+ visible outline, never clipped by sticky header |
| Mobile menu closed/open | Correct `aria-expanded`; only visible links are tabbable |
| Light/dark | Correct tokens and updated button accessible name |
| Reduced motion | No nonessential animation or smooth scroll |
| Forced colors | Controls, links, focus, borders, and status remain perceivable |
| Disabled | Use only if a real unavailable action is introduced; native disabled semantics and explanatory text required |
| Loading/empty | Not applicable to the static marketing content; do not invent decorative states |

### Target files

- `site/app.js`.
- `site/index.html` for script link, buttons, status node, and state hooks.
- `site/styles.css` for focus, status, menu, reduced-motion, and forced-colors rules.
- `test/site-content.test.mjs` for source contracts.
- `test/static-site.test.mjs` for JS MIME/serving coverage.

### Documentation references

- Clipboard behavior: `site/index.html:1451-1469`.
- Theme behavior: `site/index.html:9-18`, `1878-1903`.
- Menu behavior: `site/index.html:1905-1923`.
- Reduced-motion behavior: `site/index.html:980-994`, `1441`.

### Verification checklist

- Copy succeeds via mouse, Enter, and Space on the native button and is announced.
- Simulated Clipboard API rejection exposes the error message and preserves selectable command text.
- Menu closes by button, Escape, outside click, and destination selection; focus returns predictably.
- Theme persists after reload and follows OS only until the user chooses a theme.
- With JavaScript disabled, no content disappears and no blank hero remains.
- Console has no errors or warnings on first load.

### Anti-pattern guards

- Do not use continuous timers, autoplay, or scroll listeners.
- Do not use ARIA to imitate semantics available from native HTML.
- Do not swallow clipboard errors without user feedback.
- Do not reintroduce remote JavaScript.

## Phase 5 — Add regression contracts and complete cutover verification

### What to implement

Add `test/site-content.test.mjs` with Node-only source-contract checks. Copy the isolated filesystem and assertion style from `test/static-site.test.mjs:15-53` and `test/helpers.mjs:10-22`.

Required automated assertions:

- `site/index.html`, `site/styles.css`, and `site/app.js` exist and are served with correct MIME types.
- One `h1` appears before the first `h2` in source order.
- A skip link targets `main`.
- Install command is exact and appears no more than twice.
- GitHub labels and hrefs match behavior.
- Banned absolute/stale phrases are absent.
- `liquidglass`, jsDelivr, loader, custom cursor, `mac-scroll`, `reveal-scroll`, and auto-cycle identifiers are absent.
- No remote `<script>` exists.
- Theme, menu, reduced-motion, forced-colors, copy live status, and focus-visible hooks exist.

Run:

```bash
npm test
node folder.mjs serve site 4173
```

Manual browser matrix:

- Desktop: dark/light at 1440×900 and 1280×720.
- Tablet: 820×1180.
- Mobile: 390×844, 375×812, and 320×568 on real Safari/Chrome where available.
- Keyboard-only: skip link, header, install, GitHub, menu, theme, final CTA, footer.
- Preferences: reduced motion, forced colors/high contrast, 200% zoom.
- Clipboard success and forced failure.
- JavaScript disabled.

Performance cutover gates:

- Zero remote JavaScript requests.
- No interaction-blocking loader; usable controls as soon as DOM is interactive.
- No default idle animation.
- Decoded JavaScript under 50KB, with a target under 10KB for `site/app.js`.
- Total first-load transfer no larger than the current measured 395KB, with a target under 300KB.
- No knowingly unused asset or stylesheet family referenced by the page.

Final cutover criteria:

- All automated tests pass.
- All manual viewport/accessibility checks pass or have a documented, user-approved exception.
- Every claim maps to a cited source/test.
- Old loader, pinned sequences, custom cursor, WebGL import, and repeated old IA are fully removed—not hidden behind a flag.
- The redesign preserves logo, Foldview name, accurate install command, terminal visual language, theme support, and reduced-motion support.

## Execution order

Implement phases consecutively. Phase 1 freezes truth and IA; Phase 2 establishes semantic structure; Phase 3 adds the visual system; Phase 4 adds minimal behavior; Phase 5 proves the cutover. Do not start visual styling before the Phase 1 copy/IA contract is accepted in code and tests.

