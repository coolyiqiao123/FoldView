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
    @Published var lastActionResult: ActionResult?

    private let cli: any FoldviewCLIProtocol
    private let refreshInterval: TimeInterval
    private var lastGoodPayload: MenuBarPayload?
    private var refreshGeneration = 0
    private var refreshTask: Task<Void, Never>?
    private var backgroundTimerTask: Task<Void, Never>?

    init(
        cli: any FoldviewCLIProtocol = FoldviewCLI(),
        refreshInterval: TimeInterval = 60,
        startBackgroundTimer: Bool = true
    ) {
        self.cli = cli
        self.refreshInterval = refreshInterval
        if startBackgroundTimer {
            startBackgroundRefresh()
        }
    }

    deinit {
        refreshTask?.cancel()
        backgroundTimerTask?.cancel()
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
            guard let self else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(self.refreshInterval))
                if Task.isCancelled { return }
                self.refresh()
            }
        }
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

    func launchAI(project: ProjectRowModel, cli aiCli: AICLIPayload, count: Int) {
        let clamped = min(max(count, 1), 9)
        performAction(
            .ai(project: project.path, cli: aiCli.executable, count: clamped),
            successMessage: "opened \(clamped) × \(aiCli.name)"
        )
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

    // MARK: - Roots

    func refreshRoots() {
        Task { [weak self] in
            guard let self else { return }
            do {
                self.roots = try await self.cli.rootsList()
            } catch {
                // Leave the previous roots list visible; onboarding/settings
                // still show a repair path via resolvedCLIPath.
            }
            self.rootsLoaded = true
        }
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
            // Re-running status is the simplest way to force re-resolution
            // through the same code path every other call uses.
            self.refresh()
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
