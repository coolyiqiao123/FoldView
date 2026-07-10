import SwiftUI

/// CLI picker + window-count picker for a selected project. Reuses the same CLI
/// discovery and terminal-tiling action as the TUI by calling `pm action ai`
/// (via AppStore.launchAI) — no AppleScript or grid math lives here.
struct AIQuickLaunch: View {
    let project: ProjectRowModel
    let availableCLIs: [AICLIPayload]
    var onLaunch: (AICLIPayload, Int) -> Void
    var onCancel: () -> Void

    @State private var selectedCLI: AICLIPayload?
    @State private var count: Int = 1
    @AppStorage("FoldviewExplainedAutomationPrompt") private var explainedAutomationPrompt = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Open AI terminals for \(project.name)")
                .font(.headline)

            if !explainedAutomationPrompt {
                Text("The first launch asks macOS for permission to control Terminal. Approve it to open windows. If you deny it, Settings explains how to try again.")
                    .font(.caption)
                    .foregroundStyle(FoldviewTheme.coolGray)
            }

            if availableCLIs.isEmpty {
                Text("No AI CLI was detected. Add a custom one in Settings.")
                    .font(.callout)
                    .foregroundStyle(FoldviewTheme.coolGray)
            } else {
                Picker("CLI", selection: $selectedCLI) {
                    ForEach(availableCLIs) { cli in
                        Text(cli.name).tag(Optional(cli))
                    }
                }
                .pickerStyle(.radioGroup)
                .labelsHidden()
            }

            Stepper("Windows: \(count)", value: $count, in: 1...9)

            HStack {
                Button("Cancel", action: onCancel)
                    .keyboardShortcut(.cancelAction)
                Spacer()
                Button("Launch") {
                    explainedAutomationPrompt = true
                    if let selectedCLI {
                        onLaunch(selectedCLI, count)
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(selectedCLI == nil)
            }
        }
        .padding(16)
        .frame(width: 300)
        .onAppear {
            if selectedCLI == nil {
                selectedCLI = availableCLIs.first
            }
        }
    }
}
