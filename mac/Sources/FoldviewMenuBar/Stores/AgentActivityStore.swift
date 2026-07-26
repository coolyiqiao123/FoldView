import Foundation
import Combine

/// One entry in the live activity feed, fed by `POST /event` on the bridge.
struct ActivityEvent: Sendable, Equatable, Identifiable {
    let id: UUID
    let time: Date
    let cli: String
    let event: String
    let summary: String

    init(id: UUID = UUID(), time: Date = Date(), cli: String, event: String, summary: String) {
        self.id = id
        self.time = time
        self.cli = cli
        self.event = event
        self.summary = summary
    }
}

/// An approval request surfaced by the bridge: a Claude `PreToolUse` hook
/// whose HTTP response is being held open (`hasResponder == true`), or a Kimi
/// `PermissionRequest` event that is display-only (`hasResponder == false`).
struct PendingApproval: Sendable, Equatable, Identifiable {
    let id: UUID
    let cli: String
    let toolName: String
    let summary: String
    let project: String?
    let sessionID: String?
    let receivedAt: Date
    /// True when the bridge is holding an HTTP response open for this
    /// approval (Claude `/approve`); false for event-fed displays (Kimi).
    let hasResponder: Bool

    init(
        id: UUID = UUID(),
        cli: String,
        toolName: String,
        summary: String,
        project: String?,
        sessionID: String?,
        receivedAt: Date = Date(),
        hasResponder: Bool
    ) {
        self.id = id
        self.cli = cli
        self.toolName = toolName
        self.summary = summary
        self.project = project
        self.sessionID = sessionID
        self.receivedAt = receivedAt
        self.hasResponder = hasResponder
    }
}

/// The user's answer to a pending approval. `dismissed` covers both the
/// 240-second bridge timeout and an explicit dismiss — the shim fails open
/// (the CLI shows its normal prompt) in either case.
enum ApprovalDecision: Sendable, Equatable {
    case allow
    case deny(reason: String?)
    case dismissed
}

/// Bridge event sink. Owns the live activity feed (a bounded ring buffer) and
/// the pending-approval registry, including the suspended continuations the
/// bridge waits on. `@MainActor` end to end, AppStore-style: the bridge's
/// network callbacks hop onto the main actor to mutate, and continuations are
/// resumed here — resume is safe from any actor, so the network side never
/// blocks on UI work.
@MainActor
final class AgentActivityStore: ObservableObject {
    @Published private(set) var events: [ActivityEvent] = []
    @Published private(set) var pendingApprovals: [PendingApproval] = []

    private let capacity: Int
    private var continuations: [UUID: CheckedContinuation<ApprovalDecision, Never>] = [:]

    init(capacity: Int = 50) {
        self.capacity = capacity
    }

    // MARK: - Activity feed

    /// Appends an event, keeping only the most recent `capacity` entries.
    func recordEvent(cli: String, event: String, summary: String) {
        events.append(ActivityEvent(cli: cli, event: event, summary: summary))
        if events.count > capacity {
            events.removeFirst(events.count - capacity)
        }
    }

    // MARK: - Pending approvals

    /// Registers a new pending approval and returns it. For a Claude
    /// `/approve` call the bridge then awaits `awaitDecision(id:)`; for a Kimi
    /// `PermissionRequest` event the entry is display-only and is removed when
    /// the matching `PermissionResult` arrives.
    @discardableResult
    func registerPendingApproval(
        cli: String,
        toolName: String,
        summary: String,
        project: String?,
        sessionID: String?,
        hasResponder: Bool
    ) -> PendingApproval {
        let approval = PendingApproval(
            cli: cli,
            toolName: toolName,
            summary: summary,
            project: project,
            sessionID: sessionID,
            hasResponder: hasResponder
        )
        pendingApprovals.append(approval)
        return approval
    }

    /// Suspends until `resolve(id:decision:)` fires for this approval. The
    /// bridge calls this from its connection tasks; resolution happens on the
    /// main actor via the Approve/Deny buttons or the timeout path.
    func awaitDecision(id: UUID) async -> ApprovalDecision {
        await withCheckedContinuation { continuation in
            continuations[id] = continuation
        }
    }

    /// Resolves a pending approval: removes it from the published list and
    /// resumes the waiting bridge continuation, if any. Resolving an
    /// already-resolved (or unknown) id is a safe no-op.
    func resolve(id: UUID, decision: ApprovalDecision) {
        pendingApprovals.removeAll { $0.id == id }
        if let continuation = continuations.removeValue(forKey: id) {
            continuation.resume(returning: decision)
        }
    }

    /// Removes the newest display-only pending approval for a Kimi session —
    /// called when the bridge sees the matching `PermissionResult` event.
    func resolveDisplayApproval(cli: String, sessionID: String?) {
        guard let index = pendingApprovals.lastIndex(where: {
            !$0.hasResponder && $0.cli == cli && $0.sessionID == sessionID
        }) else { return }
        let approval = pendingApprovals[index]
        resolve(id: approval.id, decision: .dismissed)
    }

    /// Drops every pending approval, resuming any waiting continuations as
    /// dismissed. Used on shutdown so held `/approve` responses fail open.
    func dismissAllPending() {
        for approval in pendingApprovals {
            if let continuation = continuations.removeValue(forKey: approval.id) {
                continuation.resume(returning: .dismissed)
            }
        }
        pendingApprovals.removeAll()
    }
}
