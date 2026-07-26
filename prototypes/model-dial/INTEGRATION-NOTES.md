# Model Dial prototype source bundle

This directory is a complete, buildable snapshot of the standalone Model Dial
prototype created on 2026-07-19. Nothing from the prototype has been omitted:
the Swift package, application source, configuration adapters, tests, app bundle
metadata, and packaging script are all present.

The prototype is retained here as implementation reference. It is not imported
as a dependency by Foldview because both packages currently expose executable
targets, and it must not become a second owner of Foldview's Terminal-grid
behavior.

For the integrated product:

- Port the typed model/catalog structures and slider presentation into
  `mac/Sources/FoldviewMenuBar/`.
- Move catalog discovery, configuration mutation, validation, and launch-argument
  construction behind Foldview's Node CLI bridge.
- Keep `folder.mjs` as the only owner of Terminal AppleScript and window tiling.
- Keep Swift as presentation plus literal-argv process calls through
  `FoldviewCLI`.
- Do not copy `ModelDialApp.swift` into the Foldview target because Foldview
  already owns the `@main` application entry point.
- Do not copy the prototype's direct Terminal launcher into Foldview.

The binding implementation plan is:

`docs/superpowers/plans/2026-07-19-foldview-model-control-completion.md`.
