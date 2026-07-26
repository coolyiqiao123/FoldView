import SwiftUI

/// The project-list body shared by the menu-bar popover and the notch panel's
/// Foldview tab: load-state handling, stale banner, and the Live now / Recent
/// projects sections. Extracted from `MenuBarContent` with the rendering
/// unchanged; both hosts keep their own header/footer/onboarding around it.
struct ProjectSectionsView: View {
    @EnvironmentObject private var store: AppStore
    /// Called when a row's AI action is tapped; the host presents the
    /// AIQuickLaunch sheet (sheets stay with the host's scene).
    let onPickAI: (ProjectRowModel) -> Void

    var body: some View {
        switch store.loadState {
        case .loading:
            loadingView
        case .error(let message):
            errorView(message)
        case .empty:
            emptyProjectsView
        case .loaded:
            if store.isStale {
                staleBanner
            }
            if !store.liveProjects.isEmpty {
                section(title: "Live now", rows: store.liveProjects)
            }
            if !store.recentProjects.isEmpty {
                section(title: "Recent projects", rows: store.recentProjects)
            }
            if store.liveProjects.isEmpty && store.recentProjects.isEmpty {
                emptyProjectsView
            }
        }
    }

    private func section(title: String, rows: [ProjectRowModel]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title.uppercased())
                .font(.caption2.weight(.semibold))
                .foregroundStyle(FoldviewTheme.coolGray)
                .padding(.horizontal, 12)
            ForEach(rows) { row in
                ProjectRow(
                    project: row,
                    onOpen: { store.openProject(row) },
                    onStart: { store.startProject(row) },
                    onStop: { store.stopProject(row) },
                    onEditor: { store.openInEditor(row) },
                    onAI: { onPickAI(row) },
                    onCopyPath: { store.copyPath(row) }
                )
            }
        }
    }

    private var loadingView: some View {
        HStack {
            ProgressView().controlSize(.small)
            Text("Loading projects…").foregroundStyle(FoldviewTheme.coolGray)
        }
        .padding(16)
    }

    private var emptyProjectsView: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("No projects found yet")
                .font(.callout)
            Text("Foldview scans your configured roots for local projects. Add another root in Settings if you expected to see one here.")
                .font(.caption)
                .foregroundStyle(FoldviewTheme.coolGray)
        }
        .padding(16)
    }

    private func errorView(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(message)
                .font(.callout)
                .foregroundStyle(FoldviewTheme.errorRed)
            Button("Retry") { store.refresh() }
        }
        .padding(16)
    }

    private var staleBanner: some View {
        HStack {
            Text(store.lastActionResult?.message ?? "Refresh failed — showing last known status.")
                .font(.caption)
                .foregroundStyle(FoldviewTheme.workingAmber)
            Spacer()
            Button("Retry") { store.refresh() }
                .font(.caption)
        }
        .padding(.horizontal, 12)
    }
}
