import Foundation
import AppKit

/// Owns all popover state. `@MainActor` end to end: every `@Published` mutation
/// happens here, while the actual process spawn + JSON decode happens inside the
/// `FoldviewCLI` actor and only the decoded, `Sendable` result crosses back.
@MainActor
final class AppStore: ObservableObject {
    enum LoadState: Equatable {
        case loading
        case loaded
        case empty
        case error(String)
    }

    enum ActionResult: Equatable, Identifiable {
        case success(String)
        case failure(String)

        var id: String { message }
        var message: String {
            switch self {
            case .success(let message): return message
            case .failure(let message): return message
            }
        }
        var isFailure: Bool {
            if case .failure = self { return true }
            return false
        }
    }

    enum AIProviderState: Equatable {
        case idle
        case loading(AIProviderCatalog?)
        case ready(AIProviderCatalog)
        case stale(AIProviderCatalog, String)
        case error(AIProviderCatalog?, String)

        var catalog: AIProviderCatalog? {
            switch self {
            case .loading(let catalog): return catalog
            case .ready(let catalog): return catalog
            case .stale(let catalog, _): return catalog
            case .error(let catalog, _): return catalog
            case .idle: return nil
            }
        }

        var isLoading: Bool {
            if case .loading = self { return true }
            return false
        }

        var blocksActions: Bool {
            switch self {
            case .ready: return false
            default: return true
            }
        }
    }

    @Published private(set) var loadState: LoadState = .loading
    @Published private(set) var liveProjects: [ProjectRowModel] = []
    @Published private(set) var recentProjects: [ProjectRowModel] = []
    @Published private(set) var aiClis: [AICLIPayload] = []
    @Published private(set) var summary: MenuBarPayload.Summary?
    @Published private(set) var lastRefreshedAt: Date?
    /// True when the popover is showing a previously-good payload because the
    /// most recent refresh failed. The failure itself is surfaced via
    /// `lastActionResult` so the UI can offer Retry without losing the list.
    @Published private(set) var isStale: Bool = false
    @Published private(set) var roots: [String] = []
    @Published private(set) var rootsLoaded: Bool = false
    @Published private(set) var resolvedCLIPath: String?
    @Published private(set) var refreshSeconds = 60
    @Published private(set) var showDiscoveredApps = true
    @Published private(set) var customAIClis: [AICLIPayload] = []
    @Published private(set) var aiProviderStates: [String: AIProviderState] = [
        "codex": .idle,
        "kimi": .idle
    ]
    @Published private(set) var aiCatalogDiscoveryError: String?
    @Published private(set) var aiCatalogSuccessfulProviderIDs: Set<String> = []
    @Published private(set) var aiBusyProviders: Set<String> = []
    @Published var lastActionResult: ActionResult?

    /// Settings surfaces failures inline, but deliberately ignores successful
    /// action results so ordinary configuration changes do not create banners.
    var settingsFailureMessage: String? {
        guard case .failure(let message) = lastActionResult else { return nil }
        return message
    }

    private let cli: any FoldviewCLIProtocol
    private var refreshInterval: TimeInterval
    private let backgroundRefreshEnabled: Bool
    private var lastGoodPayload: MenuBarPayload?
    private var refreshGeneration = 0
    private var refreshTask: Task<Void, Never>?
    private var backgroundTimerTask: Task<Void, Never>?
    private var aiCatalogTasks: [String: Task<Void, Never>] = [:]
    private var aiCatalogGenerations: [String: Int] = ["codex": 0, "kimi": 0]

    init(
        cli: any FoldviewCLIProtocol = FoldviewCLI(),
        refreshInterval: TimeInterval = 60,
        startBackgroundTimer: Bool = true
    ) {
        self.cli = cli
        self.refreshInterval = refreshInterval
        self.refreshSeconds = Int(refreshInterval)
        self.backgroundRefreshEnabled = startBackgroundTimer
        if startBackgroundTimer {
            startBackgroundRefresh()
        }
    }

    deinit {
        refreshTask?.cancel()
        backgroundTimerTask?.cancel()
        for task in aiCatalogTasks.values { task.cancel() }
    }

    // MARK: - Refresh

    /// Call on popover open, after every action, and from the background timer.
    /// Concurrent calls are coalesced: each call bumps `refreshGeneration` and
    /// cancels the in-flight task, and results are only applied if they still
    /// match the current generation — so a slow, stale response can never
    /// clobber a newer one even if it finishes last.
    func refresh() {
        refreshGeneration += 1
        let generation = refreshGeneration
        refreshTask?.cancel()
        if lastGoodPayload == nil {
            loadState = .loading
        }
        refreshTask = Task { [weak self] in
            guard let self else { return }
            do {
                let payload = try await self.cli.status()
                self.applyPayload(payload, generation: generation)
            } catch {
                self.applyError(error, generation: generation)
            }
        }
    }

    private func applyPayload(_ payload: MenuBarPayload, generation: Int) {
        guard generation == refreshGeneration else { return }
        lastGoodPayload = payload
        isStale = false
        let rows = payload.projects.map(ProjectRowModel.init)
        liveProjects = rows
            .filter(\.live)
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        let liveIDs = Set(liveProjects.map(\.id))
        recentProjects = Array(
            rows
                .filter { !liveIDs.contains($0.id) }
                .sorted { ($0.modifiedAt ?? .distantPast) > ($1.modifiedAt ?? .distantPast) }
                .prefix(8)
        )
        aiClis = payload.aiClis
        summary = payload.summary
        lastRefreshedAt = Date()
        loadState = rows.isEmpty ? .empty : .loaded
    }

    private func applyError(_ error: Error, generation: Int) {
        guard generation == refreshGeneration else { return }
        let message = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
        if lastGoodPayload != nil {
            isStale = true
            loadState = .loaded
            lastActionResult = .failure(message)
        } else {
            loadState = .error(message)
        }
    }

    private func startBackgroundRefresh() {
        backgroundTimerTask?.cancel()
        backgroundTimerTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let interval = self?.refreshInterval else { return }
                try? await Task.sleep(for: .seconds(interval))
                if Task.isCancelled { return }
                self?.refresh()
            }
        }
    }

    // MARK: - Configuration

    func loadConfiguration() {
        Task { [weak self] in
            guard let self else { return }
            if let resolved = await self.cli.resolvedExecutablePath() {
                self.resolvedCLIPath = resolved
            }
            do {
                let config = try await self.cli.configuration()
                self.applyConfiguration(config)
            } catch {
                self.lastActionResult = .failure(Self.message(for: error))
            }
        }
    }

    func setRefreshSeconds(_ seconds: Int) {
        let value = min(max(seconds, 15), 600)
        Task { [weak self] in
            guard let self else { return }
            do {
                try await self.cli.setRefreshSeconds(value)
                self.refreshSeconds = value
                self.refreshInterval = TimeInterval(value)
                if self.backgroundRefreshEnabled { self.startBackgroundRefresh() }
                self.lastActionResult = .success("refresh interval updated")
            } catch { self.lastActionResult = .failure(Self.message(for: error)) }
        }
    }

    func setShowDiscoveredApps(_ show: Bool) {
        Task { [weak self] in
            guard let self else { return }
            do {
                try await self.cli.setShowDiscoveredApps(show)
                self.showDiscoveredApps = show
                self.lastActionResult = .success("discovered-app visibility updated")
                self.refresh()
            } catch { self.lastActionResult = .failure(Self.message(for: error)) }
        }
    }

    func addCustomAICLI(name: String, executable: String) {
        Task { [weak self] in
            guard let self else { return }
            do {
                try await self.cli.addCustomAICLI(name: name, executable: executable)
                self.lastActionResult = .success("added \(name)")
                self.loadConfiguration()
                self.refresh()
            } catch { self.lastActionResult = .failure(Self.message(for: error)) }
        }
    }

    func removeCustomAICLI(_ cli: AICLIPayload) {
        Task { [weak self] in
            guard let self else { return }
            do {
                try await self.cli.removeCustomAICLI(executable: cli.executable)
                self.lastActionResult = .success("removed \(cli.name)")
                self.loadConfiguration()
                self.refresh()
            } catch { self.lastActionResult = .failure(Self.message(for: error)) }
        }
    }

    private func applyConfiguration(_ config: FoldviewConfiguration) {
        guard config.schemaVersion == 1 else {
            lastActionResult = .failure("Unsupported Foldview configuration schema.")
            return
        }
        let intervalChanged = refreshSeconds != config.menubar.refreshSeconds
        refreshSeconds = config.menubar.refreshSeconds
        refreshInterval = TimeInterval(config.menubar.refreshSeconds)
        showDiscoveredApps = config.menubar.showDiscoveredApps
        customAIClis = config.aiClis
        if intervalChanged, backgroundRefreshEnabled { startBackgroundRefresh() }
    }

    // MARK: - Project actions

    func openProject(_ project: ProjectRowModel) {
        performAction(.open(project: project.path), successMessage: "opened \(project.name)")
    }

    func startProject(_ project: ProjectRowModel) {
        performAction(.start(project: project.path, open: true), successMessage: "started \(project.name)")
    }

    func stopProject(_ project: ProjectRowModel) {
        performAction(.stop(project: project.path), successMessage: "stopped \(project.name)")
    }

    func openInEditor(_ project: ProjectRowModel) {
        performAction(.editor(project: project.path), successMessage: "opened \(project.name) in editor")
    }

    func launchAI(
        project: ProjectRowModel,
        cli aiCli: AICLIPayload,
        model: AIModelOption?,
        effort: String?,
        count: Int
    ) {
        let clamped = min(max(count, 1), 9)
        let provider = providerCatalog(matching: aiCli)
        if (model != nil || effort != nil), provider == nil {
            lastActionResult = .failure("Refresh this model catalog before launching.")
            return
        }
        if provider == nil, !hasSuccessfulAICatalogDiscovery {
            lastActionResult = .failure("Load AI model catalogs before launching this CLI.")
            return
        }
        if let provider {
            guard case .ready(let readyProvider) = aiProviderStates[provider.id],
                  readyProvider.executable == aiCli.executable else {
                lastActionResult = .failure("Refresh \(provider.name) models before launching.")
                return
            }
        }
        let providerID = provider?.id
        if let providerID { aiBusyProviders.insert(providerID) }
        let action = CLIAction.ai(
            project: project.path,
            cli: aiCli.executable,
            count: clamped,
            provider: providerID,
            model: model?.id,
            effort: effort
        )
        Task { [weak self] in
            guard let self else { return }
            defer { if let providerID { self.aiBusyProviders.remove(providerID) } }
            do {
                try await self.cli.perform(action)
                self.lastActionResult = .success("opened \(clamped) × \(aiCli.name)")
                self.refresh()
            } catch {
                self.handleAIActionError(error, providerID: providerID)
            }
        }
    }

    /// Compatibility path for custom CLIs and callers that do not request model
    /// overrides. It intentionally sends the JSON machine form with no provider.
    func launchAI(project: ProjectRowModel, cli aiCli: AICLIPayload, count: Int) {
        launchAI(project: project, cli: aiCli, model: nil, effort: nil, count: count)
    }

    func copyPath(_ project: ProjectRowModel) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(project.path, forType: .string)
        lastActionResult = .success("copied path")
    }

    private func performAction(_ action: CLIAction, successMessage: String) {
        Task { [weak self] in
            guard let self else { return }
            do {
                try await self.cli.perform(action)
                self.lastActionResult = .success(successMessage)
                self.refresh()
            } catch {
                let message = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
                self.lastActionResult = .failure(message)
            }
        }
    }

    // MARK: - AI catalogs and defaults

    var isAICatalogLoading: Bool {
        aiProviderStates.values.contains(where: \ .isLoading)
    }

    var hasSuccessfulAICatalogDiscovery: Bool {
        aiCatalogSuccessfulProviderIDs.isSuperset(of: ["codex", "kimi"])
    }

    func providerCatalog(matching aiCli: AICLIPayload) -> AIProviderCatalog? {
        aiProviderStates.values
            .compactMap(\.catalog)
            .first { $0.executable == aiCli.executable }
    }

    func providerState(matching aiCli: AICLIPayload) -> AIProviderState? {
        guard let id = providerCatalog(matching: aiCli)?.id else { return nil }
        return aiProviderStates[id]
    }

    /// Catalog probing is explicit and independent from periodic project status.
    /// A known provider refreshes only itself; an unknown executable performs one
    /// unfiltered discovery so canonical executable identity can classify it.
    func loadAIModels(for aiCli: AICLIPayload) {
        let providerID = providerCatalog(matching: aiCli)?.id
        loadAICatalog(providerID: providerID)
    }

    func retryAIModels(for aiCli: AICLIPayload) {
        loadAIModels(for: aiCli)
    }

    func saveAIDefault(
        provider: AIProviderCatalog,
        model: AIModelOption,
        effort: String?
    ) {
        guard aiProviderStates[provider.id]?.blocksActions == false else {
            lastActionResult = .failure("Refresh \(provider.name) models before saving.")
            return
        }
        aiBusyProviders.insert(provider.id)
        Task { [weak self] in
            guard let self else { return }
            defer { self.aiBusyProviders.remove(provider.id) }
            do {
                try await self.cli.setAIDefault(provider: provider.id, model: model.id, effort: effort)
                self.lastActionResult = .success("saved \(model.label) as the \(provider.name) default")
                self.loadAICatalog(providerID: provider.id)
            } catch {
                self.handleAIActionError(error, providerID: provider.id)
            }
        }
    }

    private func loadAICatalog(providerID: String?) {
        let targetIDs = providerID.map { [$0] } ?? ["codex", "kimi"]
        aiCatalogDiscoveryError = nil
        for id in targetIDs { loadSingleAIProvider(id) }
    }

    /// Provider tasks are deliberately independent. Refreshing Codex cannot
    /// cancel an in-flight Kimi probe (and vice versa), while a newer request
    /// for the same provider cancels and supersedes its prior generation.
    private func loadSingleAIProvider(_ id: String) {
        let generation = (aiCatalogGenerations[id] ?? 0) + 1
        aiCatalogGenerations[id] = generation
        aiCatalogSuccessfulProviderIDs.remove(id)
        aiProviderStates[id] = .loading(aiProviderStates[id]?.catalog)
        aiCatalogTasks[id]?.cancel()
        aiCatalogTasks[id] = Task { [weak self] in
            guard let self else { return }
            do {
                let envelope = try await self.cli.aiCatalog(provider: id)
                self.applyAICatalog(envelope, targetIDs: [id], generations: [id: generation])
            } catch {
                if error is CancellationError { return }
                self.applyAICatalogError(error, targetIDs: [id], generations: [id: generation])
            }
            if self.aiCatalogGenerations[id] == generation { self.aiCatalogTasks[id] = nil }
        }
    }

    private func applyAICatalog(
        _ envelope: AICatalogEnvelope,
        targetIDs: [String],
        generations: [String: Int]
    ) {
        for id in targetIDs where aiCatalogGenerations[id] == generations[id] {
            guard let provider = envelope.providers.first(where: { $0.id == id }) else {
                applyAICatalogFailure("The \(id) catalog response was incomplete.", id: id)
                continue
            }
            aiCatalogSuccessfulProviderIDs.insert(id)
            if provider.available, !provider.models.isEmpty {
                aiProviderStates[id] = .ready(provider)
            } else {
                applyAICatalogFailure(
                    provider.error?.message ?? "\(provider.name) is unavailable.",
                    id: id,
                    failedCatalog: provider
                )
            }
        }
    }

    private func applyAICatalogError(
        _ error: Error,
        targetIDs: [String],
        generations: [String: Int]
    ) {
        let message = Self.message(for: error)
        aiCatalogDiscoveryError = message
        for id in targetIDs where aiCatalogGenerations[id] == generations[id] {
            applyAICatalogFailure(message, id: id)
        }
    }

    private func applyAICatalogFailure(
        _ message: String,
        id: String,
        failedCatalog: AIProviderCatalog? = nil
    ) {
        if let previous = aiProviderStates[id]?.catalog {
            aiProviderStates[id] = .stale(previous, message)
        } else {
            aiProviderStates[id] = .error(failedCatalog, message)
        }
    }

    private func handleAIActionError(_ error: Error, providerID: String?) {
        let message = Self.message(for: error)
        lastActionResult = .failure(message)
        if let typed = error as? AIProviderCommandError,
           typed.invalidatesCatalog,
           let id = providerID,
           let catalog = aiProviderStates[id]?.catalog {
            aiProviderStates[id] = .stale(catalog, message)
        }
    }

    private static func message(for error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? String(describing: error)
    }

    // MARK: - Roots

    func refreshRoots() {
        Task { [weak self] in
            guard let self else { return }
            do {
                self.roots = try await self.cli.rootsList()
            } catch {
                self.lastActionResult = .failure(Self.message(for: error))
            }
            self.rootsLoaded = true
        }
    }

    func reportError(_ error: Error) {
        lastActionResult = .failure(Self.message(for: error))
    }

    func dismissSettingsFailure() {
        guard case .failure = lastActionResult else { return }
        lastActionResult = nil
    }

    func addRoot(_ path: String) {
        Task { [weak self] in
            guard let self else { return }
            do {
                try await self.cli.rootsAdd(path)
                self.refreshRoots()
                self.refresh()
            } catch {
                let message = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
                self.lastActionResult = .failure(message)
            }
        }
    }

    func removeRoot(_ path: String) {
        Task { [weak self] in
            guard let self else { return }
            do {
                try await self.cli.rootsRemove(path)
                self.refreshRoots()
                self.refresh()
            } catch {
                let message = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
                self.lastActionResult = .failure(message)
            }
        }
    }

    // MARK: - CLI path / Open Foldview

    func repairCLIPath() {
        Task { [weak self] in
            guard let self else { return }
            if let resolved = await self.cli.resolvedExecutablePath() {
                self.resolvedCLIPath = resolved
                self.loadConfiguration()
                self.refresh()
            } else {
                self.resolvedCLIPath = nil
                self.lastActionResult = .failure("Could not find the Foldview CLI.")
            }
        }
    }

    /// `Open Foldview` launches Terminal.app in the configured root running the
    /// resolved `pm` executable. If no root is configured, the popover is
    /// already showing onboarding (see MenuBarContent), so this is a no-op.
    func openFoldviewRoot() {
        guard let root = roots.first else { return }
        Task { [weak self] in
            guard let self else { return }
            do {
                try await self.cli.openFoldviewInTerminal(root: root)
                self.lastActionResult = .success("opened Foldview")
            } catch {
                let message = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
                self.lastActionResult = .failure(message)
            }
        }
    }
}
