import SwiftUI

/// Draft-only model controls for one project. Slider movement changes local view
/// state only; Save default and Launch remain two explicit bridge actions.
struct AIQuickLaunch: View {
    @EnvironmentObject private var store: AppStore

    let project: ProjectRowModel
    let availableCLIs: [AICLIPayload]
    var onLaunch: (AICLIPayload, AIModelOption?, String?, Int) -> Void
    var onSaveDefault: (AIProviderCatalog, AIModelOption, String?) -> Void
    var onCancel: () -> Void

    @State private var selectedCLI: AICLIPayload?
    @State private var selectedModelID = ""
    @State private var selectedEffort: String?
    @State private var count = 1
    @AppStorage("FoldviewExplainedAutomationPrompt") private var explainedAutomationPrompt = false

    private var provider: AIProviderCatalog? {
        selectedCLI.flatMap(store.providerCatalog(matching:))
    }

    private var providerState: AppStore.AIProviderState? {
        selectedCLI.flatMap(store.providerState(matching:))
    }

    private var selectedModel: AIModelOption? {
        provider?.models.first { $0.id == selectedModelID }
    }

    private var actionsDisabled: Bool {
        guard let provider else {
            return store.isAICatalogLoading || !store.hasSuccessfulAICatalogDiscovery
        }
        return providerState?.blocksActions != false || selectedModel == nil || store.aiBusyProviders.contains(provider.id)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Open AI terminals for \(project.name)")
                .font(.headline)
                .lineLimit(1)

            if !explainedAutomationPrompt {
                Text("The first launch asks macOS for permission to control Terminal.")
                    .font(.caption2)
                    .foregroundStyle(FoldviewTheme.coolGray)
            }

            cliPicker
            catalogContent
            Stepper("Windows: \(count)", value: $count, in: 1...9)
                .accessibilityLabel("Terminal window count")
                .accessibilityValue("\(count) of 9")

            HStack(spacing: 8) {
                Button("Cancel", action: onCancel)
                    .keyboardShortcut(.cancelAction)
                Spacer()
                if let provider, let selectedModel {
                    Button("Save default") {
                        onSaveDefault(provider, selectedModel, selectedEffort)
                    }
                    .disabled(actionsDisabled)
                }
                Button("Launch") {
                    explainedAutomationPrompt = true
                    if let selectedCLI {
                        onLaunch(selectedCLI, provider == nil ? nil : selectedModel, provider == nil ? nil : selectedEffort, count)
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(selectedCLI == nil || actionsDisabled)
            }
        }
        .padding(14)
        .frame(width: 340)
        .onAppear {
            if selectedCLI == nil {
                selectedCLI = availableCLIs.first
            } else {
                selectCLI(selectedCLI, assign: false)
            }
        }
        .onChange(of: selectedCLI) { _, newValue in selectCLI(newValue, assign: false) }
        .onChange(of: store.aiProviderStates) { _, _ in syncDraftWithCatalog() }
        .onChange(of: selectedModelID) { oldValue, newValue in
            guard oldValue != newValue, let model = selectedModel else { return }
            selectedEffort = AISelection.effortAfterModelChange(for: model, current: selectedEffort)
        }
    }

    private var cliPicker: some View {
        Picker("CLI", selection: $selectedCLI) {
            ForEach(availableCLIs) { cli in
                Text(cli.name).tag(Optional(cli))
            }
        }
        .accessibilityLabel("AI provider CLI")
        .disabled(availableCLIs.isEmpty)
    }

    @ViewBuilder
    private var catalogContent: some View {
        if availableCLIs.isEmpty {
            Text("No AI CLI was detected. Add a custom one in Settings.")
                .font(.caption)
                .foregroundStyle(FoldviewTheme.coolGray)
        } else if store.isAICatalogLoading && provider == nil {
            stateRow(icon: nil, text: "Reading local model catalogs…", color: FoldviewTheme.coolGray, retry: false)
        } else if let provider, let state = providerState {
            switch state {
            case .ready:
                modelControls(provider)
            case .loading:
                modelControls(provider)
                stateRow(icon: nil, text: "Refreshing \(provider.name) models…", color: FoldviewTheme.coolGray, retry: false)
            case .stale(_, let message):
                modelControls(provider)
                stateRow(icon: "exclamationmark.triangle.fill", text: message, color: FoldviewTheme.workingAmber, retry: true)
            case .error(_, let message):
                stateRow(icon: "exclamationmark.circle.fill", text: message, color: FoldviewTheme.errorRed, retry: true)
            case .idle:
                stateRow(icon: nil, text: "Waiting to load models…", color: FoldviewTheme.coolGray, retry: true)
            }
        } else if let message = store.aiCatalogDiscoveryError,
                  !store.hasSuccessfulAICatalogDiscovery {
            stateRow(icon: "exclamationmark.circle.fill", text: message, color: FoldviewTheme.errorRed, retry: true)
        } else if store.hasSuccessfulAICatalogDiscovery {
            Text("This custom CLI will launch with its own configured defaults.")
                .font(.caption)
                .foregroundStyle(FoldviewTheme.coolGray)
                .padding(.vertical, 8)
        }
    }

    private func modelControls(_ provider: AIProviderCatalog) -> some View {
        VStack(spacing: 8) {
            ModelSlider(providerName: provider.name, models: provider.models, selectedModelID: $selectedModelID)
            if let selectedModel {
                EffortSlider(providerName: provider.name, model: selectedModel, selectedEffort: $selectedEffort)
            }
        }
    }

    private func stateRow(icon: String?, text: String, color: Color, retry: Bool) -> some View {
        HStack(spacing: 7) {
            if let icon {
                Image(systemName: icon)
            } else {
                ProgressView().controlSize(.small)
            }
            Text(text)
                .font(.caption)
                .lineLimit(2)
            Spacer()
            if retry, let selectedCLI {
                Button("Retry") { store.retryAIModels(for: selectedCLI) }
                    .font(.caption)
            }
        }
        .foregroundStyle(color)
    }

    private func selectCLI(_ cli: AICLIPayload?, assign: Bool = true) {
        if assign { selectedCLI = cli }
        selectedModelID = ""
        selectedEffort = nil
        guard let cli else { return }
        if let cached = store.providerCatalog(matching: cli) {
            syncDraft(with: cached)
        }
        store.loadAIModels(for: cli)
    }

    private func syncDraftWithCatalog() {
        guard let provider else { return }
        syncDraft(with: provider)
    }

    private func syncDraft(with provider: AIProviderCatalog) {
        let retainedModel = provider.models.first(where: { $0.id == selectedModelID })
        let model = retainedModel ?? AISelection.initialModel(in: provider)
        selectedModelID = model?.id ?? ""
        if let model {
            selectedEffort = retainedModel == nil
                ? AISelection.initialEffort(for: model, providerDefault: provider.defaultEffort)
                : AISelection.effortAfterModelChange(for: model, current: selectedEffort)
        } else {
            selectedEffort = nil
        }
    }
}
