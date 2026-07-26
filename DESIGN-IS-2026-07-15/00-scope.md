# Foldview website audit scope

- Audited artifact: the live static website served from `site/` at `http://127.0.0.1:4173/`, plus `site/index.html`, product documentation, package metadata, implementation code, and tests.
- Primary user: a developer with multiple local projects and one or more AI coding CLIs who is deciding whether Foldview is useful and how to install it.
- Primary task: understand Foldview, trust its claims, and copy the install command without searching through the page.
- Constraints: preserve the Foldview name/logo, local-first positioning, Node 18+ and MIT facts, zero-runtime-dependency product story, static-site delivery, keyboard access, light/dark themes, and reduced-motion support.
- References supplied: none. Existing internal references are the product brief in `docs/superpowers/specs/2026-07-02-ai-terminals-design.md`, the README, package metadata, and current tests.
- In scope: information architecture, visual hierarchy, copy, interaction behavior, responsive layout, accessibility, performance, and trust on the marketing website.
- Out of scope: redesigning the terminal UI, macOS companion, CLI behavior, package naming, repository naming, or implementing website changes in this audit.
- Live inspection: default desktop viewport 1280×720; independent responsive render at 500×757. Exact 390px real-device behavior remains a verification requirement.

