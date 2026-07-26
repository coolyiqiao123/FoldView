# Foldview website — Asme-language rebrand (design spec)

**Date:** 2026-07-20 · **Status:** approved for implementation (user directive: "completely rebrand foldview to follow [the] app's design, add more to it, high quality")
**Reference design:** `~/Documents/app` — "Asme" (Vite/React/Tailwind, built 2026-07-20). Pure-black canvas, cinematic background media, Instrument Serif display type, liquid-glass pill components, white-on-black opacity hierarchy, micro-interactions.
**Target:** `~/Documents/foldview/site/` — the hand-authored, zero-build static site (index.html + styles.css + app.js). This copy stays vanilla; all effects are ported as plain CSS/JS per the standing decision.

## Decision record

Approaches considered:

1. **Adopt the React scaffold** from `~/Documents/app` as the new site. Rejected: contradicts the user's 2026-07-17 explicit choice of the plain-HTML site over React/shadcn, and the routing law (React landing work belongs to `Rhea/foldview-cli`).
2. **Hotlink the Asme background video** (20 MB cloudfront mp4: figure at a laptop with a galaxy spiraling around them). Rejected: external asset that can rot; crops poorly at phone widths; belongs to another product's pipeline.
3. **Vanilla port of the Asme design language with a bespoke canvas "project galaxy" backdrop.** Chosen. Same language (black void + luminous spiral + glass + serif), zero dependencies, offline-safe, responsive, and the metaphor is foldview's own: your projects in orbit around one terminal.

Other decisions:
- **Single dark theme.** Asme has no light mode; the toggle, `[data-theme=light]` tokens, and theme JS are removed. (`fv-theme` localStorage simply becomes unused.)
- **MacBook scroll scene is preserved** (markup + motion mechanics + contract), restyled onto the black void. The user chose this scene explicitly on 2026-07-17; the failing contract test is repointed at the split files rather than deleted.
- **The old hero terminal panel is folded into the MacBook screen** (one strong showcase instead of two similar ones — Asme minimalism).
- **About/founder stays removed** (user's 2026-07-17 trim). A product **Manifesto modal** (Asme's signature element) carries the local-first philosophy instead.

## Design system

- **Canvas:** pure `#000`. A fixed, full-viewport `<canvas id="galaxy">` renders a slowly orbiting elliptical particle galaxy (2 arms, Kepler-ish speeds, white/blue-white dots, ~12% faint spectral hues, occasional soft-glow stars, `lighter` compositing, subtle center glow). Scroll dims it to ~35% past the hero; DPR ≤ 2; pauses when the tab is hidden; `prefers-reduced-motion` renders one static frame.
- **Type:** display = `"Instrument Serif", Georgia, serif` (Google Fonts, `display=swap`, preconnect), one *italic* accent word per headline; UI/body = system sans; code = system mono. Kickers: uppercase, `letter-spacing .2em`, white/50, small.
- **Text hierarchy:** white at 1 / .78 / .6 / .45 / .35 opacities — no colored accents at page level. The only chroma: `#62c79c` live-dots inside terminal mockups (product semantics) and faint spectral glints in the galaxy.
- **Liquid glass (exact Asme recipe, ported):** `rgba(255,255,255,.01)` bg, `backdrop-filter: blur(4px)`, `inset 0 1px 1px rgba(255,255,255,.1)`, masked gradient border (bright top/bottom edges, `padding:1.4px`, `mask-composite:exclude`), cursor-tracking radial sheen driven by `--mx/--my`, hover `bg white/5`. Pills are `border-radius:999px`; cards/modals `1.5rem`. A `.glass-panel` variant (blur 8px, bg .02) for large readable surfaces.
- **Micro-interactions:** `shake` (bad copy fallback), `modal-in` `cubic-bezier(.22,1,.36,1)`, `fade-in`, `pulse-hint` scroll cue, white circular buttons scale 1.05/0.95, hero pointer parallax (±12/±8 px, fine pointers only), IntersectionObserver fade-up reveals.
- **A11y/perf gates:** skip-link, `:focus-visible` white outline, aria-live copy status, modal focus handling + Esc, `noscript` note, forced-colors block, transform/opacity-only animation, no horizontal overflow at 390/820/1440.

## Page map (top → bottom)

1. **Nav** (fixed, transparent → glass pill on scroll): white lotus mark + `foldview` + `/pm` mono; links Overview · AI · Menu bar · Install · GitHub↗; glass "Manifesto" pill; mobile glass dropdown (Esc/outside/link close).
2. **Hero** (100svh, centered over galaxy): kicker `LOCAL PROJECT CONTROL FOR MACOS`; serif h1 **"Every project in *orbit*."**; lede (scan ~/Documents, see live servers, launch dev or AI terminals); glass **install pill** — `$ npm i -g folderpreview` + white circular copy button (Asme's email-capture anatomy, repurposed); alias + privacy microcopy; pulse scroll cue.
3. **MacBook scene** `#overview` (contract kept): kicker `THE DASHBOARD`, h2 "Open the lid. See what's *running*." Space-black MacBook, lid opens `rotateX(-28°→0)` while the display travels down (120/56 px), monochrome terminal screen: Launch/AI tabs, project list with live ports, detail pane (git, files, Model · Codex, Effort · high).
4. **Three jobs** `#jobs`: kicker `THREE JOBS, ONE SURFACE`, h2 "Less hunting. More *building*." — three glass cards (01 see everything running — real listener sweep; 02 launch the right thing; 03 send in the AI).
5. **AI swarm** `#ai` (new): kicker `AI SWARM`, h2 "Choose the brain. *Tile* the windows." CLI roster chips with real hotkeys (c Claude · x Codex · k Kimi Code · g Gemini · o OpenCode · i Aider · + custom); Codex/Kimi live model catalogs + effort note; animated glass tiling demo cycling 1 → 2 halves → 3 columns → 2×2 (true `computeGrid` behavior, up to 9 = 3×3).
6. **Menu bar** `#menubar` (new): kicker `ALWAYS ON`, h2 "A quiet spot in the *menu bar*." Glass macOS-menubar mockup + dropdown panel; copy: optional native companion, `pm menubar` installs a locally-signed app, read-only status through the same Node engine, nothing phones home.
7. **iPhone showcase** `#on-phone` (kept, restyled): the site itself at phone width inside the frame — honest caption that Foldview runs on macOS.
8. **Install** `#install`: kicker `INSTALL`, h2 "From npm to *orbit* in a minute." Glass steps 01 `npm i -g folderpreview` · 02 `foldview` (defaults to ~/Documents) · 03 `pm ~/Projects`; proof row: zero runtime dependencies · Node 18+ · MIT.
9. **Shortcuts + CLI bridge** `#shortcuts`: kicker `KEYBOARD FIRST`, h2 "Muscle memory, not *menus*." Glass kbd rows (↵ l ⇥ a r ?); right glass panel: `pm --list`, `pm --json`, `pm ai catalog --json`, `pm status --format menubar-json`, `pm menubar --status`.
10. **Final CTA**: serif line "Put Foldview between you and command *sprawl*." + install pill + GitHub link.
11. **Footer**: three glass circular icon buttons (GitHub · npm · Issues) + mono meta line.
12. **Manifesto modal**: overlay `black/60` + blur; glass card; kicker `MANIFESTO`; serif italic "Your machine is enough."; three short local-first paragraphs; Esc/overlay/X close.

## Contracts & tests

- `test/macbook-scroll.test.mjs` — **repointed**: markup assertions (+ div balance) against `index.html`; `transform-origin: 50% 0` against `styles.css`; the exact `lerp`/`translateY`/`rotateX` source lines against `app.js` (lines preserved verbatim in the rewrite).
- `test/site-content.test.mjs` — **new**: brand landmarks (Instrument Serif, `.liquid-glass`, galaxy canvas, install command, section ids, no light-theme remnants, balanced divs, skip-link + noscript).
- `pm serve`/static detection tests are unaffected (they never read this site's content).

## Plan

1. Spec (this file) → 2. `index.html` → 3. `styles.css` → 4. `app.js` → 5. tests updated/added → 6. full `node --test` green → 7. headless Chrome QA at 1440/820/390 (console clean, no overflow, scenes scrub, modal + copy work) with fixes → 8. context/BRAIN wrap-up.

Backup of the pre-rebrand site: `.site-pre-asme-backup-2026-07-20/` (repo root, untracked) + scratchpad copy.
