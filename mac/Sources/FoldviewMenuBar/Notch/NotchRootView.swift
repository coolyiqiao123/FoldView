import SwiftUI

/// Root content of the notch panel. Collapsed: the slim black pill under the
/// notch (`◆ N agents · $X.XX today`, or a dim `◆` when no data has loaded
/// yet); a click toggles the expanded four-tab panel. Expanded: tab bar +
/// the selected tab on a rounded black surface.
struct NotchRootView: View {
    enum Tab: String, CaseIterable, Identifiable {
        case agents = "Agents"
        case foldview = "Foldview"
        case burn = "Burn"
        case fans = "Fans"

        var id: String { rawValue }
    }

    @ObservedObject var panelState: NotchPanelState
    let onToggle: () -> Void

    @EnvironmentObject private var appStore: AppStore
    @EnvironmentObject private var agentsStore: AgentsStore
    @EnvironmentObject private var burnStore: BurnStore
    @EnvironmentObject private var fanStore: FanStore
    @EnvironmentObject private var activityStore: AgentActivityStore

    @State private var selectedTab: Tab = .agents

    var body: some View {
        Group {
            if panelState.isExpanded {
                expandedPanel
                    .transition(.opacity)
            } else {
                pill
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Collapsed pill

    private var pill: some View {
        HStack(spacing: 6) {
            Text("◆")
                .font(.system(size: 9))
                .foregroundStyle(hasPillData ? FoldviewTheme.healthyGreen : FoldviewTheme.coolGray.opacity(0.5))
            if let label = pillLabel {
                Text(label)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Color.white.opacity(0.85))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .onTapGesture { onToggle() }
    }

    private var hasPillData: Bool {
        agentsStore.lastPolledAt != nil || burnStore.payload != nil
    }

    private var pillLabel: String? {
        var parts: [String] = []
        if agentsStore.lastPolledAt != nil {
            parts.append("\(agentsStore.activeCount) agents")
        }
        if let today = burnStore.payload?.claude?.costUsd?.today {
            parts.append(String(format: "$%.2f today", today))
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    // MARK: - Expanded panel

    private var expandedPanel: some View {
        VStack(spacing: 0) {
            tabBar
            Divider().overlay(Color.white.opacity(0.12))
            tabContent
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Color(white: 0.07))
        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .strokeBorder(Color.white.opacity(0.10), lineWidth: 1)
        )
    }

    private var tabBar: some View {
        HStack(spacing: 4) {
            ForEach(Tab.allCases) { tab in
                Button {
                    selectedTab = tab
                } label: {
                    Text(tab.rawValue)
                        .font(.system(size: 12, weight: selectedTab == tab ? .semibold : .regular))
                        .foregroundStyle(selectedTab == tab ? FoldviewTheme.babyBlue : FoldviewTheme.coolGray)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(
                            Capsule().fill(selectedTab == tab ? FoldviewTheme.babyBlue.opacity(0.15) : Color.clear)
                        )
                }
                .buttonStyle(.plain)
            }
            Spacer()
            if !activityStore.pendingApprovals.isEmpty {
                Text("\(activityStore.pendingApprovals.count) waiting")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(FoldviewTheme.workingAmber)
                    .padding(.trailing, 4)
            }
            Button {
                onToggle()
            } label: {
                Image(systemName: "chevron.up")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(FoldviewTheme.coolGray)
            }
            .buttonStyle(.plain)
            .help("Collapse")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    @ViewBuilder
    private var tabContent: some View {
        switch selectedTab {
        case .agents:
            AgentsTab()
        case .foldview:
            FoldviewTab()
        case .burn:
            BurnTab()
        case .fans:
            FansTab()
        }
    }
}
