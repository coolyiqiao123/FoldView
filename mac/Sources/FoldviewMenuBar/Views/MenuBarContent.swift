import SwiftUI
import AppKit

/// The popover body: header, Live now / Recent projects sections, and footer.
/// Roughly 360-420pt wide per spec; ~380pt here. First-run onboarding (no roots
/// configured yet) is shown in place of the project list — it lives here rather
/// than as a separate file because it is a small state of this same view, not a
/// distinct screen in the native project layout.
struct MenuBarContent: View {
    @EnvironmentObject private var store: AppStore
    @State private var aiPickerProject: ProjectRowModel?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()

            Group {
                if !store.rootsLoaded {
                    loadingView
                } else if store.roots.isEmpty {
                    onboardingView
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            ProjectSectionsView(onPickAI: { aiPickerProject = $0 })
                        }
                        .padding(.vertical, 8)
                    }
                    .frame(maxHeight: 360)
                }
            }

            Divider()
            footer
        }
        .frame(width: 380)
        .onAppear {
            store.loadConfiguration()
            store.refreshRoots()
            store.refresh()
        }
        .sheet(item: $aiPickerProject) { project in
            AIQuickLaunch(
                project: project,
                availableCLIs: store.aiClis,
                onLaunch: { cli, model, effort, count in
                    store.launchAI(project: project, cli: cli, model: model, effort: effort, count: count)
                    aiPickerProject = nil
                },
                onSaveDefault: { provider, model, effort in
                    store.saveAIDefault(provider: provider, model: model, effort: effort)
                },
                onCancel: { aiPickerProject = nil }
            )
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack {
            Text("foldview")
                .font(.system(size: 14, weight: .semibold, design: .rounded))
                .foregroundStyle(FoldviewTheme.babyBlue)
            if let summary = store.summary {
                Text("· \(summary.liveCount) live")
                    .font(.caption)
                    .foregroundStyle(FoldviewTheme.coolGray)
            }
            Spacer()
            Text(lastRefreshLabel)
                .font(.caption2)
                .foregroundStyle(FoldviewTheme.coolGray)
        }
        .padding(12)
    }

    private var lastRefreshLabel: String {
        guard let date = store.lastRefreshedAt else { return "not refreshed yet" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    // MARK: - Content states
    //
    // The load-state body and row sections live in `ProjectSectionsView`,
    // shared with the notch panel's Foldview tab.

    private var loadingView: some View {
        HStack {
            ProgressView().controlSize(.small)
            Text("Loading projects…").foregroundStyle(FoldviewTheme.coolGray)
        }
        .padding(16)
    }

    // MARK: - Onboarding

    private var onboardingView: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Welcome to Foldview")
                .font(.headline)
            Text("Foldview scans local project folders you choose and does not upload project data.")
                .font(.callout)
                .foregroundStyle(FoldviewTheme.coolGray)
            Button("Choose project folder…") { chooseRoot() }
                .buttonStyle(.borderedProminent)
            if let result = store.lastActionResult, result.isFailure {
                Text(result.message)
                    .font(.caption)
                    .foregroundStyle(FoldviewTheme.errorRed)
            }
        }
        .padding(16)
    }

    private func chooseRoot() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Add Root"
        if panel.runModal() == .OK, let url = panel.url {
            store.addRoot(url.path)
        }
    }

    // MARK: - Footer

    private var footer: some View {
        HStack(spacing: 12) {
            Button("Open Foldview") { store.openFoldviewRoot() }
                .disabled(store.roots.isEmpty)
            Spacer()
            Button("Refresh") { store.refresh() }
            SettingsLink { Text("Settings") }
            Button("Quit") { NSApp.terminate(nil) }
        }
        .buttonStyle(.plain)
        .font(.system(size: 12))
        .foregroundStyle(FoldviewTheme.babyBlue)
        .padding(10)
    }
}
