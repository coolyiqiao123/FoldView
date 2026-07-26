import Foundation

/// Fan tab state. Polls the daemon's telemetry every 2 seconds while the tab
/// is visible; writes go through the daemon's command file and resolve on its
/// recorded result. When no daemon publishes fresh state the tab offers a
/// one-click "enable fan access" escalation (one password prompt per app
/// session).
@MainActor
final class FanStore: ObservableObject {
    /// Whether fan control can be attempted from this Mac.
    enum ControlState: Equatable {
        case available
        case readOnly(reason: String)
        case unavailable(reason: String)

        var statusText: String {
            switch self {
            case .available:
                return "control available"
            case .readOnly(let reason):
                return "read-only (needs your Mac password to change) — \(reason)"
            case .unavailable(let reason):
                return "unavailable on this Mac — \(reason)"
            }
        }

        var controlAvailable: Bool {
            if case .available = self { return true }
            return false
        }
    }

    @Published private(set) var fans: [FanReading] = []
    @Published private(set) var writeError: String?
    @Published private(set) var controlState: ControlState = .unavailable(reason: "fan helper is not running")
    /// Where the current readings come from (`via SMC` / `via powermetrics`),
    /// nil when no daemon is publishing.
    @Published private(set) var source: FanStateFile.Source?
    @Published private(set) var isWriting = false
    @Published private(set) var isEnabling = false

    private let controller: any FanControlling
    private let pollingInterval: TimeInterval
    private var pollTask: Task<Void, Never>?

    init(controller: any FanControlling = SMCFanController(), pollingInterval: TimeInterval = 2) {
        self.controller = controller
        self.pollingInterval = pollingInterval
    }

    deinit {
        pollTask?.cancel()
    }

    /// True when Apply/Auto buttons should be enabled.
    var controlAvailable: Bool { controlState.controlAvailable }

    /// True when the "enable fan access" button should be offered: no fresh
    /// daemon state is visible (either not spawned yet or it died).
    var needsAccessEnablement: Bool { !controlAvailable }

    // MARK: - Polling

    /// Starts the polling loop (idempotent) with an immediate read.
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
    }

    func refresh() {
        Task { [weak self] in
            guard let self else { return }
            let telemetry = await self.controller.readTelemetry()
            self.apply(telemetry)
        }
    }

    /// Maps daemon telemetry onto control state: fresh data with a working
    /// source → available; an explicit unavailable source or no data at all →
    /// unavailable with the daemon's note text.
    private func apply(_ telemetry: FanTelemetry?) {
        guard let telemetry else {
            fans = []
            source = nil
            controlState = .unavailable(reason: "fan helper is not running — enable fan access below")
            return
        }
        source = telemetry.source
        switch telemetry.source {
        case .unavailable:
            fans = telemetry.fans
            controlState = .unavailable(reason: telemetry.note ?? "no fan data source on this Mac")
        case .smc, .powermetrics:
            fans = telemetry.fans
            controlState = .available
        }
    }

    // MARK: - Escalation

    /// Spawns the root fan daemon (one password prompt). A dismissed prompt
    /// surfaces as a transient message, not a state change.
    func enableAccess() {
        guard !isEnabling else { return }
        isEnabling = true
        writeError = nil
        Task { [weak self] in
            guard let self else { return }
            do {
                try await self.controller.enableAccess(appPID: ProcessInfo.processInfo.processIdentifier)
                self.isEnabling = false
                self.refresh()
            } catch {
                self.isEnabling = false
                let message = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
                self.writeError = message
            }
        }
    }

    // MARK: - Writes

    /// Queues a manual target RPM through the daemon's command file.
    func apply(fan: Int, rpm: Int) {
        performWrite { try await self.controller.setTarget(fan: fan, rpm: rpm) }
    }

    /// Returns a fan to automatic control through the daemon.
    func setAuto(fan: Int) {
        performWrite { try await self.controller.setAuto(fan: fan) }
    }

    private func performWrite(_ write: @escaping () async throws -> Void) {
        guard !isWriting else { return }
        isWriting = true
        writeError = nil
        Task { [weak self] in
            guard let self else { return }
            do {
                try await write()
                self.isWriting = false
                self.refresh()
            } catch {
                self.isWriting = false
                let message = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
                self.writeError = message
            }
        }
    }
}
