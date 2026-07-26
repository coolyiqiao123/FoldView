import SwiftUI
import AppKit
import ServiceManagement

/// Settings: roots (read/write through the CLI), general preferences, and CLI
/// path/repair. Root mutations always go through `AppStore` → `FoldviewCLI` so
/// Swift never becomes a second writer of `~/.foldview.json`.
struct SettingsView: View {
    @EnvironmentObject private var store: AppStore

    @State private var launchAtLogin = false
    @State private var suppressLaunchAtLoginChange = true
    @State private var selectedModelsCLI: AICLIPayload?
    @State private var settingsModelID = ""
    @State private var settingsEffort: String?
    @State private var customCLIName = ""
    @State private var customCLIExecutable = ""

    var body: some View {
        VStack(spacing: 0) {
            if let message = store.settingsFailureMessage {
                settingsFailureBanner(message)
                Divider()
            }

            TabView {
                rootsTab.tabItem { Text("Roots") }
                generalTab.tabItem { Text("General") }
                modelsTab.tabItem { Text("Models") }
                cliTab.tabItem { Text("CLI") }
            }
        }
        .frame(width: 440, height: 420)
        .onAppear {
            synchronizeLaunchAtLogin()
            store.loadConfiguration()
            store.refreshRoots()
            if selectedModelsCLI == nil {
                selectedModelsCLI = store.aiClis.first
            } else {
                loadSelectedModelsCLI()
            }
        }
        .onChange(of: store.aiClis) { _, clis in
            if selectedModelsCLI == nil { selectedModelsCLI = clis.first }
        }
        .onChange(of: selectedModelsCLI) { _, _ in loadSelectedModelsCLI() }
        .onChange(of: store.aiProviderStates) { _, _ in syncSettingsDraft() }
        .onChange(of: settingsModelID) { oldValue, newValue in
            guard oldValue != newValue,
                  let model = settingsProvider?.models.first(where: { $0.id == newValue }) else { return }
            settingsEffort = AISelection.effortAfterModelChange(for: model, current: settingsEffort)
        }
    }

    private func settingsFailureBanner(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(FoldviewTheme.errorRed)
                .accessibilityHidden(true)
            Text(message)
                .font(.caption)
                .foregroundStyle(FoldviewTheme.errorRed)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            Button {
                store.dismissSettingsFailure()
            } label: {
                Image(systemName: "xmark")
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss settings error")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(FoldviewTheme.errorRed.opacity(0.1))
        .accessibilityLabel("Settings error: \(message)")
    }

    // MARK: - Roots

    private var rootsTab: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Project roots")
                .font(.headline)
            Text("Foldview scans these folders for local projects and never uploads project data.")
                .font(.caption)
                .foregroundStyle(FoldviewTheme.coolGray)

            List(store.roots, id: \.self) { root in
                HStack {
                    Text(root)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer()
                    Button {
                        store.removeRoot(root)
                    } label: {
                        Image(systemName: "minus.circle")
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Remove \(root)")
                }
            }
            .frame(minHeight: 120)

            Button("Add root…") { chooseRoot() }
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

    // MARK: - General

    private var generalTab: some View {
        Form {
            Stepper(
                "Refresh every \(store.refreshSeconds)s",
                value: Binding(get: { store.refreshSeconds }, set: store.setRefreshSeconds),
                in: 15...600,
                step: 15
            )
            Toggle(
                "Show discovered local apps",
                isOn: Binding(get: { store.showDiscoveredApps }, set: store.setShowDiscoveredApps)
            )
            Toggle("Launch Foldview at login", isOn: $launchAtLogin)
                .onChange(of: launchAtLogin) { _, newValue in
                    guard !suppressLaunchAtLoginChange else { return }
                    setLaunchAtLogin(newValue)
                }
            Text("These settings are saved through the Foldview CLI. Refresh interval changes restart the live timer immediately.")
                .font(.caption)
                .foregroundStyle(FoldviewTheme.coolGray)
        }
        .padding(16)
    }

    private func setLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            store.reportError(error)
            synchronizeLaunchAtLogin()
        }
    }

    private func synchronizeLaunchAtLogin() {
        suppressLaunchAtLoginChange = true
        launchAtLogin = SMAppService.mainApp.status == .enabled
        Task { @MainActor in
            await Task.yield()
            suppressLaunchAtLoginChange = false
        }
    }

    // MARK: - Models

    private var settingsProvider: AIProviderCatalog? {
        selectedModelsCLI.flatMap(store.providerCatalog(matching:))
    }

    private var settingsModel: AIModelOption? {
        settingsProvider?.models.first { $0.id == settingsModelID }
    }

    private var modelsTab: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Provider models")
                .font(.headline)
            Text("Catalogs and effective defaults come from Codex or Kimi through the Foldview CLI. Moving a slider does not save anything.")
                .font(.caption)
                .foregroundStyle(FoldviewTheme.coolGray)

            Picker("CLI", selection: $selectedModelsCLI) {
                ForEach(store.aiClis) { cli in Text(cli.name).tag(Optional(cli)) }
            }
            .disabled(store.aiClis.isEmpty)

            if store.aiClis.isEmpty {
                Text("No AI provider CLI was detected.")
                    .foregroundStyle(FoldviewTheme.coolGray)
            } else if store.isAICatalogLoading && settingsProvider == nil {
                ProgressView("Reading model catalogs…")
            } else if let provider = settingsProvider {
                providerDefaultSummary(provider)
                if provider.available, !provider.models.isEmpty {
                    ModelSlider(providerName: provider.name, models: provider.models, selectedModelID: $settingsModelID)
                    if let model = settingsModel {
                        EffortSlider(providerName: provider.name, model: model, selectedEffort: $settingsEffort)
                    }
                }
                settingsProviderActions(provider)
            } else if let message = store.aiCatalogDiscoveryError,
                      !store.hasSuccessfulAICatalogDiscovery {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(FoldviewTheme.errorRed)
                Button("Retry") { loadSelectedModelsCLI() }
            } else if store.hasSuccessfulAICatalogDiscovery {
                Text("This custom CLI manages its own models and defaults.")
                    .font(.caption)
                    .foregroundStyle(FoldviewTheme.coolGray)
            }
            Spacer(minLength: 0)
        }
        .padding(16)
    }

    private func providerDefaultSummary(_ provider: AIProviderCatalog) -> some View {
        let modelLabel = provider.selectedDefaultModel?.label ?? provider.defaultModel ?? "Not set"
        let effortLabel = provider.defaultEffort.map { " · \($0)" } ?? ""
        return HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(provider.name)
                    .font(.subheadline.weight(.semibold))
                Text("Effective default: \(modelLabel)\(effortLabel)")
                    .font(.caption)
                    .foregroundStyle(FoldviewTheme.coolGray)
            }
            Spacer()
            Circle()
                .fill(provider.available ? FoldviewTheme.healthyGreen : FoldviewTheme.errorRed)
                .frame(width: 7, height: 7)
                .accessibilityLabel(provider.available ? "Available" : "Unavailable")
        }
    }

    @ViewBuilder
    private func settingsProviderActions(_ provider: AIProviderCatalog) -> some View {
        let state = store.aiProviderStates[provider.id]
        if case .stale(_, let message) = state {
            Text(message).font(.caption).foregroundStyle(FoldviewTheme.workingAmber)
        } else if case .error(_, let message) = state {
            Text(message).font(.caption).foregroundStyle(FoldviewTheme.errorRed)
        }
        HStack {
            Button("Refresh") {
                if let selectedModelsCLI { store.retryAIModels(for: selectedModelsCLI) }
            }
            Spacer()
            Button("Save default") {
                if let settingsModel {
                    store.saveAIDefault(provider: provider, model: settingsModel, effort: settingsEffort)
                }
            }
            .disabled(
                settingsModel == nil ||
                state?.blocksActions != false ||
                store.aiBusyProviders.contains(provider.id)
            )
        }
    }

    private func loadSelectedModelsCLI() {
        settingsModelID = ""
        settingsEffort = nil
        guard let selectedModelsCLI else { return }
        if let provider = store.providerCatalog(matching: selectedModelsCLI) {
            syncSettingsDraft(with: provider)
        }
        store.loadAIModels(for: selectedModelsCLI)
    }

    private func syncSettingsDraft() {
        guard let provider = settingsProvider else { return }
        syncSettingsDraft(with: provider)
    }

    private func syncSettingsDraft(with provider: AIProviderCatalog) {
        let retainedModel = provider.models.first(where: { $0.id == settingsModelID })
        let model = retainedModel ?? AISelection.initialModel(in: provider)
        settingsModelID = model?.id ?? ""
        if let model {
            settingsEffort = retainedModel == nil
                ? AISelection.initialEffort(for: model, providerDefault: provider.defaultEffort)
                : AISelection.effortAfterModelChange(for: model, current: settingsEffort)
        } else {
            settingsEffort = nil
        }
    }

    // MARK: - CLI

    private var cliTab: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Foldview CLI")
                .font(.headline)
            if let path = store.resolvedCLIPath {
                Text(path)
                    .font(.system(.body, design: .monospaced))
            } else {
                Text("No Foldview CLI found.")
                    .foregroundStyle(FoldviewTheme.errorRed)
            }
            Button("Repair / re-detect") { store.repairCLIPath() }

            Divider()

            Text("Detected AI CLIs")
                .font(.headline)
            if store.aiClis.isEmpty {
                Text("None detected yet.")
                    .font(.caption)
                    .foregroundStyle(FoldviewTheme.coolGray)
            } else {
                ForEach(store.aiClis) { cli in
                    Text("\(cli.name) — \(cli.executable)")
                        .font(.caption)
                }
            }

            Divider()
            Text("Custom AI CLI").font(.headline)
            TextField("Display name", text: $customCLIName)
            HStack {
                TextField("Absolute executable path", text: $customCLIExecutable)
                Button("Choose…") { chooseCustomCLIExecutable() }
            }
            Button("Add custom CLI") {
                store.addCustomAICLI(name: customCLIName, executable: customCLIExecutable)
                customCLIName = ""
                customCLIExecutable = ""
            }
            .disabled(customCLIName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || customCLIExecutable.isEmpty)
            ForEach(store.customAIClis) { cli in
                HStack {
                    Text("\(cli.name) — \(cli.executable)").font(.caption).lineLimit(1)
                    Spacer()
                    Button { store.removeCustomAICLI(cli) } label: { Image(systemName: "minus.circle") }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Remove \(cli.name)")
                }
            }
        }
        .padding(16)
    }

    private func chooseCustomCLIExecutable() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Choose Executable"
        if panel.runModal() == .OK, let url = panel.url { customCLIExecutable = url.path }
    }
}
