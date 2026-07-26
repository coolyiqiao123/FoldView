# Make-plan handoff

```text
/make-plan Redesign the Foldview marketing website. Current design failed audit at 9/30 with critical gaps in principles #2 useful, #4 understandable, #5 unobtrusive, #6 honest, and #10 as little design as possible.

Verdict paragraph (quoted from 03-verdict.md):
> Foldview's website requires a redesign: at 9/30, its accurate product core and capable static implementation are obscured by a decoration-first information architecture, unclear naming, and claims that outrun the product.

Why redesign and not refine: The total is below the 20/30 refine threshold, and decoration dominates the primary explain-and-install task.

Preserve from current design:
- Foldview logo, blue night palette, terminal typography direction, and dark/light token foundation (`site/index.html:28-80`, `1038-1048`).
- The truthful terminal-dashboard content model and functional keyboard-accessible copy behavior (`site/index.html:1093-1115`, `1142-1152`, `1438-1469`).
- Reduced-motion and OS-theme support (`site/index.html:9-18`, `978-994`, `1878-1903`).

Discard:
- The 200vh pinned MacBook opener and 180vh word-reveal sequence. Evidence: `site/index.html:703-726`, `791-805`, `1085-1180`. Caused failure on principles #2, #5, and #10.
- The simulated loader, custom cursor/grid glow, dead garden/meadow families, and non-mounting WebGL import. Evidence: `site/index.html:157-274`, `748-786`, `997-1023`, `1528-1565`, `1728-1751`, `1960-1999`. Caused failure on principles #5, #9, and #10.

Top moves from the audit (verbatim):
1. Principles #2 and #10 — useful and minimal: Replace the 200vh MacBook opener and 180vh sentence reveal with a first-viewport hero that shows the `h1`, an accurate one-sentence value proposition, the install command, a secondary GitHub link, and a readable terminal proof. Evidence: `01-evidence.md#structural-evidence`.
2. Principles #4 and #6 — understandable and honest: Establish one naming hierarchy—Foldview is the product, `folderpreview` is the npm package, and `foldview`/`pm` are commands—then replace every absolute or stale claim with tested, bounded language. Evidence: `01-evidence.md#copy-and-honesty-evidence`.
3. Principles #5 and #9 — unobtrusive and efficient: Remove the simulated loader, custom cursor/grid glow, pinned scroll scenes, unused garden/meadow code, and non-mounting WebGL dependency; keep at most one optional, reduced-motion-safe terminal animation. Evidence: `01-evidence.md#weight-and-friction-evidence`.
4. Principles #3 and #8 — aesthetic and thorough: Consolidate typography, spacing, radii, and semantic colors; repair light-theme contrast, heading order, skip navigation, copy announcements, offscreen focus, and all responsive states. Evidence: `01-evidence.md#visual-evidence` and `01-evidence.md#accessibility-evidence`.
5. Principle #10 — minimal: Collapse the 10-section page into a six-part story—nav, hero, proof/use cases, install, technical details, compact founder/final CTA—and remove repeated navigation and install affordances that do not serve a distinct decision point. Evidence: `01-evidence.md#structural-evidence`.

Redesign principles in priority order:
1. Principle #2 — useful: a first-time visitor understands and can install Foldview in the first viewport.
2. Principle #4 — understandable: product, package, and command names are explicit, and every action label maps to behavior.
3. Principle #10 — as little design as possible: each section answers a distinct purchase/adoption question with no duplicate spectacle.

Deliverables for the plan:
- New information architecture, not derived mechanically from the old section order.
- New first-viewport primary flow, compared to the current 200vh opener.
- Exact target files and supported Web APIs for every phase.
- States checklist: default, loading only when real, copy success/error, focus, disabled where applicable, mobile-menu open/closed, light/dark, reduced motion, forced colors.
- Migration path for visitors and preservation checks for brand/product truth.
- Cutover criteria for retiring the old pinned sequences and remote visual dependency.

Anti-patterns to guard against:
- Porting the old structure under new styling.
- Keeping both designs behind a flag indefinitely.
- Redesigning to follow another visual trend.
- Treating the preserve list as optional.
```

