import Foundation
import Combine

/// A row in the Agents tab: one polled agent session, optionally matched to a
/// bridge pending approval (matched by `session_id` → agent `id`). Unmatched
/// approvals become synthetic `waiting-approval` rows so a permission prompt
/// is visible even when `pm agents` hasn't reported the session yet.
struct AgentRow: Sendable, Equatable, Identifiable {
    let id: String
    let cli: AgentCLIKind
    let roles: [AgentRoleKind]
    let project: String?
    let pid: Int?
    let status: AgentStatusKind
    let currentAction: String?
    let lastActivityAt: String?
    /// True for synthetic rows created from an unmatched pending approval —
    /// there is no polled agent behind them yet.
    let isSynthetic: Bool
    /// The pending approval attached to this row, if any.
    let pendingApproval: PendingApproval?

    var isWaitingApproval: Bool { pendingApproval != nil }

    init(entry: AgentEntry, pendingApproval: PendingApproval? = nil) {
        id = entry.id
        cli = entry.cli
        roles = entry.roles
        project = entry.project
        pid = entry.pid
        status = entry.status
        currentAction = entry.currentAction
        lastActivityAt = entry.lastActivityAt
        isSynthetic = false
        self.pendingApproval = pendingApproval
    }

    init(approval: PendingApproval) {
        id = "waiting-approval-\(approval.id.uuidString)"
        switch approval.cli {
        case "claude": cli = .claude
        case "kimi": cli = .kimi
        case "codex": cli = .codex
        case "claude-flow": cli = .claudeFlow
        default: cli = .unknown(approval.cli)
        }
        roles = [.interactive]
        project = approval.project
        pid = nil
        status = .idle
        currentAction = "waiting for approval"
        lastActivityAt = nil
        isSynthetic = true
        pendingApproval = approval
    }
}

/// Agents tab state. Polls `pm agents --json` every few seconds while the
/// notch panel is open (generation-counted like AppStore, so a slow response
/// can never clobber a newer one) and merges the result with the bridge's
/// pending approvals. Approve/Deny resolve the bridge continuations through
/// the activity store.
@MainActor
final class AgentsStore: ObservableObject {
    @Published private(set) var agents: [AgentRow] = []
    @Published private(set) var lastError: String?
    @Published private(set) var lastPolledAt: Date?

    /// Pending approvals are owned by the activity store; this projection is
    /// kept in sync on every merge so the tab has a single place to read.
    @Published private(set) var pending: [PendingApproval] = []

    private let cli: any FoldviewCLIProtocol
    private let activityStore: AgentActivityStore
    private let pollingInterval: TimeInterval
    private var pollTask: Task<Void, Never>?
    private var refreshTask: Task<Void, Never>?
    private var refreshGeneration = 0
    private var lastGoodAgents: [AgentEntry] = []
    private var cancellables: Set<AnyCancellable> = []

    init(
        cli: any FoldviewCLIProtocol,
        activityStore: AgentActivityStore,
        pollingInterval: TimeInterval = 4
    ) {
        self.cli = cli
        self.activityStore = activityStore
        self.pollingInterval = pollingInterval
        // Re-merge whenever the bridge's pending set changes so approval
        // cards appear/vanish without waiting for the next CLI poll.
        activityStore.$pendingApprovals
            .sink { [weak self] _ in self?.merge() }
            .store(in: &cancellables)
    }

    deinit {
        pollTask?.cancel()
        refreshTask?.cancel()
    }

    /// Active (non-synthetic, status active) agent count for the closed pill.
    var activeCount: Int {
        agents.filter { !$0.isSynthetic && $0.status == .active }.count
    }

    // MARK: - Polling

    /// Starts the polling loop (idempotent). Called when the panel expands.
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

    /// Stops polling. Called when the panel collapses.
    func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
        refreshTask?.cancel()
    }

    /// One poll cycle. Concurrent calls coalesce: each bumps the generation
    /// and cancels the in-flight task; stale responses are discarded.
    func refresh() {
        refreshGeneration += 1
        let generation = refreshGeneration
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            guard let self else { return }
            do {
                let payload = try await self.cli.agents()
                guard generation == self.refreshGeneration else { return }
                self.lastGoodAgents = payload.agents
                self.lastError = nil
                self.lastPolledAt = Date()
                self.merge()
            } catch {
                if error is CancellationError { return }
                guard generation == self.refreshGeneration else { return }
                self.lastError = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
            }
        }
    }

    // MARK: - Merge

    /// Rebuilds `agents` from the last good poll plus the bridge's pending
    /// approvals: approvals whose `sessionID` matches a polled agent id are
    /// attached to that row; unmatched approvals become synthetic rows.
    private func merge() {
        let pendingApprovals = activityStore.pendingApprovals
        pending = pendingApprovals
        var matchedApprovalIDs: Set<UUID> = []
        var rows = lastGoodAgents.map { entry -> AgentRow in
            let approval = pendingApprovals.first { $0.sessionID == entry.id }
            if let approval { matchedApprovalIDs.insert(approval.id) }
            return AgentRow(entry: entry, pendingApproval: approval)
        }
        let synthetic = pendingApprovals
            .filter { !matchedApprovalIDs.contains($0.id) }
            .map(AgentRow.init(approval:))
        rows.append(contentsOf: synthetic)
        agents = rows
    }

    // MARK: - Approval actions

    func approve(id: UUID) {
        activityStore.resolve(id: id, decision: .allow)
    }

    func deny(id: UUID, reason: String? = nil) {
        activityStore.resolve(id: id, decision: .deny(reason: reason))
    }
}
