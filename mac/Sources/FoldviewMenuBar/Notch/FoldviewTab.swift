import SwiftUI

/// Foldview tab: the same project-list body the menu-bar popover shows,
/// embedded via `ProjectSectionsView`. The AI quick-launch sheet is presented
/// here, exactly like the popover does, so row actions behave identically.
struct FoldviewTab: View {
    @EnvironmentObject private var store: AppStore
    @State private var aiPickerProject: ProjectRowModel?

    var body: some View {
        Group {
            if !store.rootsLoaded {
                HStack {
                    ProgressView().controlSize(.small)
                    Text("Loading projects…").foregroundStyle(FoldviewTheme.coolGray)
                }
                .padding(16)
            } else if store.roots.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("No project roots configured")
                        .font(.callout)
                    Text("Add a root in Settings and your local projects show up here.")
                        .font(.caption)
                        .foregroundStyle(FoldviewTheme.coolGray)
                }
                .padding(16)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        ProjectSectionsView(onPickAI: { aiPickerProject = $0 })
                    }
                    .padding(.vertical, 8)
                }
            }
        }
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
}
