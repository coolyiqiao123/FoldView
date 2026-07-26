# Verdict: REDESIGN

Foldview's website requires a redesign: at 9/30, its accurate product core and capable static implementation are obscured by a decoration-first information architecture, unclear naming, and claims that outrun the product.

Highest-leverage moves:

1. **Principles #2 and #10 — useful and minimal:** Replace the 200vh MacBook opener and 180vh sentence reveal with a first-viewport hero that shows the `h1`, an accurate one-sentence value proposition, the install command, a secondary GitHub link, and a readable terminal proof. Evidence: `01-evidence.md#structural-evidence`.
2. **Principles #4 and #6 — understandable and honest:** Establish one naming hierarchy—Foldview is the product, `folderpreview` is the npm package, and `foldview`/`pm` are commands—then replace every absolute or stale claim with tested, bounded language. Evidence: `01-evidence.md#copy-and-honesty-evidence`.
3. **Principles #5 and #9 — unobtrusive and efficient:** Remove the simulated loader, custom cursor/grid glow, pinned scroll scenes, unused garden/meadow code, and non-mounting WebGL dependency; keep at most one optional, reduced-motion-safe terminal animation. Evidence: `01-evidence.md#weight-and-friction-evidence`.
4. **Principles #3 and #8 — aesthetic and thorough:** Consolidate typography, spacing, radii, and semantic colors; repair light-theme contrast, heading order, skip navigation, copy announcements, offscreen focus, and all responsive states. Evidence: `01-evidence.md#visual-evidence` and `01-evidence.md#accessibility-evidence`.
5. **Principle #10 — minimal:** Collapse the 10-section page into a six-part story—nav, hero, proof/use cases, install, technical details, compact founder/final CTA—and remove repeated navigation and install affordances that do not serve a distinct decision point. Evidence: `01-evidence.md#structural-evidence`.

