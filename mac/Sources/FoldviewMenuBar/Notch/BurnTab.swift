import SwiftUI
import Charts

/// Burn tab: today's Claude cost headline, per-CLI token/cost rows, Codex
/// quota, a 7-day token bar chart, coding time, and GitHub commits. Every
/// section degrades independently — a missing or errored section shows its
/// own note instead of blanking the whole tab.
struct BurnTab: View {
    @EnvironmentObject private var burnStore: BurnStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let error = burnStore.lastError, burnStore.payload == nil {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(FoldviewTheme.errorRed)
                    Button("Retry") { burnStore.refresh() }
                        .font(.caption)
                } else if burnStore.isLoading, burnStore.payload == nil {
                    HStack {
                        ProgressView().controlSize(.small)
                        Text("Loading burn…").foregroundStyle(FoldviewTheme.coolGray)
                            .font(.caption)
                    }
                } else if let payload = burnStore.payload {
                    if burnStore.isStale {
                        Text("Refresh failed — showing last known burn.")
                            .font(.caption2)
                            .foregroundStyle(FoldviewTheme.workingAmber)
                    }
                    headline(payload)
                    claudeRow(payload.claude)
                    kimiRow(payload.kimi)
                    codexRow(payload.codex)
                    chartSection(payload.claude)
                    codingTimeRow(payload.codingTime)
                    githubRow(payload.github)
                } else {
                    Text("No burn data yet.")
                        .font(.caption)
                        .foregroundStyle(FoldviewTheme.coolGray)
                }
            }
            .padding(12)
        }
        .onAppear { burnStore.startPolling() }
        .onDisappear { burnStore.stopPolling() }
    }

    // MARK: - Headline

    private func headline(_ payload: BurnPayload) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            if let today = payload.claude?.costUsd?.today {
                Text(String(format: "$%.2f", today))
                    .font(.system(size: 28, weight: .bold, design: .rounded))
                    .foregroundStyle(Color.white)
                Text("today")
                    .font(.callout)
                    .foregroundStyle(FoldviewTheme.coolGray)
            } else {
                Text("—")
                    .font(.system(size: 28, weight: .bold, design: .rounded))
                    .foregroundStyle(FoldviewTheme.coolGray)
                Text("no Claude cost data")
                    .font(.callout)
                    .foregroundStyle(FoldviewTheme.coolGray)
            }
            Spacer()
            if let week = payload.claude?.costUsd?.week {
                VStack(alignment: .trailing, spacing: 2) {
                    Text(String(format: "$%.2f", week))
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Color.white.opacity(0.85))
                    Text("this week")
                        .font(.caption2)
                        .foregroundStyle(FoldviewTheme.coolGray)
                }
            }
        }
    }

    // MARK: - Per-CLI rows

    private func claudeRow(_ claude: ClaudeBurn?) -> some View {
        sectionRow(title: "Claude", unavailable: claude == nil) {
            if let claude {
                HStack(spacing: 12) {
                    if let cost = claude.costUsd?.month {
                        labeled(String(format: "$%.2f", cost), "month cost")
                    }
                    if let tokens = claude.tokens?.today {
                        labeled(Self.compact(tokens), "tokens today")
                    }
                    if let hit = claude.cacheHitPct {
                        labeled(String(format: "%.0f%%", hit), "cache hit")
                    }
                    Spacer()
                    if let unpriced = claude.unpricedModels, !unpriced.isEmpty {
                        Text("unpriced: \(unpriced.joined(separator: ", "))")
                            .font(.caption2)
                            .foregroundStyle(FoldviewTheme.workingAmber)
                            .lineLimit(1)
                    }
                }
            }
        }
    }

    private func kimiRow(_ kimi: KimiBurn?) -> some View {
        sectionRow(title: "Kimi", unavailable: kimi == nil) {
            if let kimi {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 12) {
                        if let tokens = kimi.tokens?.today {
                            labeled(Self.compact(tokens), "tokens today")
                        }
                        if let week = kimi.tokens?.week {
                            labeled(Self.compact(week), "this week")
                        }
                        Spacer()
                    }
                    if let note = kimi.note {
                        Text(note)
                            .font(.caption2)
                            .foregroundStyle(FoldviewTheme.coolGray)
                    }
                }
            }
        }
    }

    private func codexRow(_ codex: CodexBurn?) -> some View {
        sectionRow(title: "Codex", unavailable: codex == nil) {
            if let codex {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 12) {
                        if let total = codex.tokens?.total?.total {
                            labeled(Self.compact(total), "total tokens")
                        }
                        if let cached = codex.tokens?.total?.cached {
                            labeled(Self.compact(cached), "cached")
                        }
                        if let plan = codex.quota?.planType {
                            labeled(plan, "plan")
                        }
                        Spacer()
                    }
                    if let used = codex.quota?.usedPercent {
                        HStack(spacing: 8) {
                            GeometryReader { geometry in
                                ZStack(alignment: .leading) {
                                    RoundedRectangle(cornerRadius: 3)
                                        .fill(Color.white.opacity(0.12))
                                    RoundedRectangle(cornerRadius: 3)
                                        .fill(used >= 90 ? FoldviewTheme.errorRed : used >= 70 ? FoldviewTheme.workingAmber : FoldviewTheme.healthyGreen)
                                        .frame(width: geometry.size.width * min(max(used, 0), 100) / 100)
                                }
                            }
                            .frame(height: 6)
                            Text(String(format: "%.0f%% of quota", used))
                                .font(.caption2)
                                .foregroundStyle(FoldviewTheme.coolGray)
                                .frame(minWidth: 80, alignment: .trailing)
                        }
                    }
                }
            }
        }
    }

    private func sectionRow<Content: View>(
        title: String,
        unavailable: Bool,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased())
                .font(.caption2.weight(.semibold))
                .foregroundStyle(FoldviewTheme.coolGray)
            if unavailable {
                Text("no data — section unavailable or failed on the CLI side")
                    .font(.caption2)
                    .foregroundStyle(FoldviewTheme.errorRed.opacity(0.8))
            } else {
                content()
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(FoldviewTheme.secondaryBackground.opacity(0.35))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func labeled(_ value: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(value)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color.white.opacity(0.9))
            Text(label)
                .font(.caption2)
                .foregroundStyle(FoldviewTheme.coolGray)
        }
    }

    // MARK: - 7-day chart

    private func chartSection(_ claude: ClaudeBurn?) -> some View {
        let days = Array((claude?.tokens?.byDay ?? []).suffix(7))
        return VStack(alignment: .leading, spacing: 6) {
            Text("TOKENS · LAST 7 DAYS")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(FoldviewTheme.coolGray)
            if days.isEmpty {
                Text("no daily token data")
                    .font(.caption2)
                    .foregroundStyle(FoldviewTheme.coolGray)
            } else {
                Chart(days) { day in
                    BarMark(
                        x: .value("Day", Self.shortDate(day.date)),
                        y: .value("Tokens", day.total)
                    )
                    .foregroundStyle(FoldviewTheme.babyBlue.gradient)
                    .cornerRadius(3)
                }
                .chartYAxis {
                    AxisMarks(position: .leading) { value in
                        AxisGridLine().foregroundStyle(Color.white.opacity(0.08))
                        AxisValueLabel {
                            if let tokens = value.as(Int.self) {
                                Text(Self.compact(tokens))
                                    .font(.system(size: 9))
                                    .foregroundStyle(FoldviewTheme.coolGray)
                            }
                        }
                    }
                }
                .chartXAxis {
                    AxisMarks { value in
                        AxisValueLabel {
                            if let label = value.as(String.self) {
                                Text(label)
                                    .font(.system(size: 9))
                                    .foregroundStyle(FoldviewTheme.coolGray)
                            }
                        }
                    }
                }
                .frame(height: 110)
            }
        }
        .padding(10)
        .background(FoldviewTheme.secondaryBackground.opacity(0.35))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    // MARK: - Coding time / GitHub

    private func codingTimeRow(_ codingTime: CodingTime?) -> some View {
        sectionRow(title: "Coding time", unavailable: codingTime == nil) {
            if let codingTime {
                HStack(spacing: 12) {
                    if let today = codingTime.todayMin {
                        labeled(Self.minutes(today), "today")
                    }
                    if let week = codingTime.weekMin {
                        labeled(Self.minutes(week), "this week")
                    }
                    if let total = codingTime.totalMin {
                        labeled(Self.minutes(total), "total")
                    }
                    Spacer()
                }
            }
        }
    }

    private func githubRow(_ github: GitHubSection?) -> some View {
        sectionRow(title: "GitHub", unavailable: github == nil) {
            if let github {
                if github.isError {
                    Text(github.error?.message ?? "GitHub section failed.")
                        .font(.caption2)
                        .foregroundStyle(FoldviewTheme.errorRed.opacity(0.8))
                } else {
                    HStack(spacing: 12) {
                        if let commits = github.commits30d {
                            labeled("\(commits)", "commits · 30d")
                        }
                        if let login = github.login {
                            labeled(login, "account")
                        }
                        Spacer()
                        if let repos = github.byRepo?.prefix(3), !repos.isEmpty {
                            Text(repos.map { "\($0.repo) (\($0.commits ?? 0))" }.joined(separator: " · "))
                                .font(.caption2)
                                .foregroundStyle(FoldviewTheme.coolGray)
                                .lineLimit(1)
                        }
                    }
                }
            }
        }
    }

    // MARK: - Formatting

    static func compact(_ value: Int) -> String {
        let abs = Double(Swift.abs(value))
        switch abs {
        case 1_000_000...: return String(format: "%.1fM", Double(value) / 1_000_000)
        case 1_000...: return String(format: "%.1fk", Double(value) / 1_000)
        default: return "\(value)"
        }
    }

    static func minutes(_ minutes: Int) -> String {
        if minutes >= 60 {
            return String(format: "%.1fh", Double(minutes) / 60)
        }
        return "\(minutes)m"
    }

    static func shortDate(_ isoDate: String) -> String {
        // `byDay[].date` arrives as YYYY-MM-DD; show M/d.
        let parts = isoDate.split(separator: "-")
        guard parts.count == 3,
              let month = Int(parts[1]),
              let day = Int(parts[2]) else { return isoDate }
        return "\(month)/\(day)"
    }
}
