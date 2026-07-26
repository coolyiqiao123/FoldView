import SwiftUI

/// Agents tab: bridge pending approvals pinned on top (approve/deny), then
/// the polled `pm agents` session list. Approvals matched to a polled agent
/// show on that agent's card; unmatched ones become synthetic
/// waiting-approval rows so nothing actionable is ever hidden.
struct AgentsTab: View {
    @EnvironmentObject private var agentsStore: AgentsStore
    @EnvironmentObject private var activityStore: AgentActivityStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if !activityStore.pendingApprovals.isEmpty {
                    pendingSection
                }
                agentsSection
                activitySection
            }
            .padding(12)
        }
    }

    // MARK: - Pending approvals

    private var pendingSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("WAITING FOR APPROVAL")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(FoldviewTheme.workingAmber)
            ForEach(activityStore.pendingApprovals) { approval in
                ApprovalCard(
                    approval: approval,
                    onApprove: { agentsStore.approve(id: approval.id) },
                    onDeny: { reason in agentsStore.deny(id: approval.id, reason: reason) }
                )
            }
        }
    }

    // MARK: - Agent list

    private var agentsSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("AGENTS")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(FoldviewTheme.coolGray)
            if agentsStore.agents.isEmpty {
                if let error = agentsStore.lastError {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(FoldviewTheme.errorRed)
                } else {
                    Text("No agents running. Start a Claude, Kimi, or Codex session and it shows up here.")
                        .font(.caption)
                        .foregroundStyle(FoldviewTheme.coolGray)
                }
            } else {
                ForEach(agentsStore.agents) { agent in
                    AgentCard(agent: agent)
                }
            }
        }
    }

    // MARK: - Activity feed

    private var activitySection: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !activityStore.events.isEmpty {
                Text("ACTIVITY")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(FoldviewTheme.coolGray)
                ForEach(activityStore.events.suffix(10).reversed()) { event in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(event.time, style: .time)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(FoldviewTheme.coolGray)
                        Text(event.cli)
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(FoldviewTheme.babyBlue)
                        Text(event.summary)
                            .font(.system(size: 10))
                            .foregroundStyle(Color.white.opacity(0.8))
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer(minLength: 0)
                    }
                }
            }
        }
    }
}

/// One pending-approval card: tool, project, monospaced summary, elapsed
/// time, and Approve/Deny actions. Deny opens an inline reason field; an
/// empty reason is fine.
private struct ApprovalCard: View {
    let approval: PendingApproval
    let onApprove: () -> Void
    let onDeny: (String?) -> Void

    @State private var showReasonField = false
    @State private var reason = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(approval.toolName)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color.white)
                if let project = approval.project {
                    Text(project)
                        .font(.caption)
                        .foregroundStyle(FoldviewTheme.coolGray)
                }
                Spacer()
                Text(approval.receivedAt, style: .relative)
                    .font(.caption2)
                    .foregroundStyle(FoldviewTheme.workingAmber)
            }
            Text(approval.summary)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(Color.white.opacity(0.85))
                .lineLimit(3)
                .truncationMode(.middle)
                .textSelection(.enabled)
            HStack(spacing: 8) {
                Button(action: onApprove) {
                    Text("Approve")
                        .font(.system(size: 11, weight: .semibold))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 4)
                        .background(FoldviewTheme.healthyGreen.opacity(0.2))
                        .foregroundStyle(FoldviewTheme.healthyGreen)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                }
                .buttonStyle(.plain)
                Button {
                    if showReasonField {
                        onDeny(reason.isEmpty ? nil : reason)
                    } else {
                        showReasonField = true
                    }
                } label: {
                    Text(showReasonField ? "Confirm deny" : "Deny")
                        .font(.system(size: 11, weight: .semibold))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 4)
                        .background(FoldviewTheme.errorRed.opacity(0.2))
                        .foregroundStyle(FoldviewTheme.errorRed)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                }
                .buttonStyle(.plain)
                if showReasonField {
                    TextField("reason (optional)", text: $reason)
                        .textFieldStyle(.plain)
                        .font(.system(size: 11))
                        .foregroundStyle(Color.white)
                        .onSubmit { onDeny(reason.isEmpty ? nil : reason) }
                }
            }
        }
        .padding(10)
        .background(FoldviewTheme.secondaryBackground.opacity(0.35))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(FoldviewTheme.workingAmber.opacity(0.4), lineWidth: 1)
        )
    }
}

/// One polled agent session: CLI name, one pill per role, current action, and
/// relative last-activity time.
private struct AgentCard: View {
    let agent: AgentRow

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Circle()
                .fill(agent.status == .active ? FoldviewTheme.healthyGreen : FoldviewTheme.coolGray.opacity(0.5))
                .frame(width: 7, height: 7)
                .padding(.top, 5)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(agent.cli.stringValue)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Color.white)
                    ForEach(agent.roles, id: \.stringValue) { role in
                        Text(role.stringValue)
                            .font(.system(size: 9, weight: .medium))
                            .foregroundStyle(FoldviewTheme.babyBlue)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(FoldviewTheme.babyBlue.opacity(0.15))
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                    if agent.isWaitingApproval {
                        Text("waiting-approval")
                            .font(.system(size: 9, weight: .medium))
                            .foregroundStyle(FoldviewTheme.workingAmber)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(FoldviewTheme.workingAmber.opacity(0.15))
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                    Spacer()
                    if let project = agent.project {
                        Text(project)
                            .font(.caption2)
                            .foregroundStyle(FoldviewTheme.coolGray)
                            .lineLimit(1)
                    }
                }
                HStack(spacing: 8) {
                    if let action = agent.currentAction, !action.isEmpty {
                        Text(action)
                            .font(.system(size: 10))
                            .foregroundStyle(Color.white.opacity(0.75))
                            .lineLimit(1)
                    }
                    Spacer()
                    if let lastActivity = Self.relativeDate(agent.lastActivityAt) {
                        Text(lastActivity)
                            .font(.caption2)
                            .foregroundStyle(FoldviewTheme.coolGray)
                    }
                }
            }
        }
        .padding(10)
        .background(FoldviewTheme.secondaryBackground.opacity(0.35))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private static let isoFormatter = ISO8601DateFormatter()
    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter
    }()

    private static func relativeDate(_ isoString: String?) -> String? {
        guard let isoString,
              let date = isoFormatter.date(from: isoString) else { return nil }
        return relativeFormatter.localizedString(for: date, relativeTo: Date())
    }
}
