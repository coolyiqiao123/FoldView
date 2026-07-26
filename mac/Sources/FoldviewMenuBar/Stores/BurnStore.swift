import Foundation

/// Burn tab state. Fetches `pm burn --json --days 30` when the tab opens and
/// every 60 seconds while visible, keeping the last good payload on failure
/// (`isStale`) exactly like AppStore's refresh pattern.
@MainActor
final class BurnStore: ObservableObject {
    @Published private(set) var payload: BurnPayload?
    @Published private(set) var isStale = false
    @Published private(set) var lastError: String?
    @Published private(set) var lastRefreshedAt: Date?
    @Published private(set) var isLoading = false

    private let cli: any FoldviewCLIProtocol
    private let days: Int
    private let pollingInterval: TimeInterval
    private var pollTask: Task<Void, Never>?
    private var refreshTask: Task<Void, Never>?
    private var refreshGeneration = 0

    init(
        cli: any FoldviewCLIProtocol,
        days: Int = 30,
        pollingInterval: TimeInterval = 60
    ) {
        self.cli = cli
        self.days = days
        self.pollingInterval = pollingInterval
    }

    deinit {
        pollTask?.cancel()
        refreshTask?.cancel()
    }

    // MARK: - Polling

    /// Starts polling (idempotent) and kicks an immediate refresh.
    func startPolling() {
        guard pollTask == nil else { return }
        refresh()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let interval = self?.pollingInterval else { return }
                try? await Task.sleep(for: .seconds(interval))
                if Task.isCancelled { return }
                self?.refresh()
            }
        }
    }

    func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
        refreshTask?.cancel()
    }

    /// One refresh cycle, generation-counted so concurrent calls coalesce and
    /// a slow superseded response can never clobber a newer one.
    func refresh() {
        refreshGeneration += 1
        let generation = refreshGeneration
        refreshTask?.cancel()
        isLoading = payload == nil
        refreshTask = Task { [weak self] in
            guard let self else { return }
            do {
                let payload = try await self.cli.burn(days: self.days)
                guard generation == self.refreshGeneration else { return }
                self.payload = payload
                self.isStale = false
                self.lastError = nil
                self.lastRefreshedAt = Date()
                self.isLoading = false
            } catch {
                if error is CancellationError { return }
                guard generation == self.refreshGeneration else { return }
                self.isStale = self.payload != nil
                self.lastError = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
                self.isLoading = false
            }
        }
    }
}
