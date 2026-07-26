import SwiftUI

/// Fans tab: one row per fan with live RPM, a target-RPM slider, Apply (via
/// the root daemon's command file) and Auto (clear forced mode). When no
/// daemon publishes fresh state the tab offers one-click escalation: a single
/// password prompt per app session. Degrades cleanly: source label shows
/// `via SMC` / `via powermetrics`, an explicit unavailable source shows its
/// note, and fanless Macs get a friendly empty state.
struct FansTab: View {
    @EnvironmentObject private var fanStore: FanStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                statusRow
                if fanStore.needsAccessEnablement {
                    enableRow
                }
                if fanStore.controlAvailable && fanStore.fans.isEmpty {
                    emptyState
                } else {
                    ForEach(fanStore.fans) { fan in
                        FanRow(
                            fan: fan,
                            controlAvailable: fanStore.controlAvailable,
                            isWriting: fanStore.isWriting,
                            onApply: { rpm in fanStore.apply(fan: fan.id, rpm: rpm) },
                            onAuto: { fanStore.setAuto(fan: fan.id) }
                        )
                    }
                }
                if let error = fanStore.writeError {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(FoldviewTheme.errorRed)
                }
            }
            .padding(12)
        }
        .onAppear { fanStore.startPolling() }
        .onDisappear { fanStore.stopPolling() }
    }

    private var statusRow: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(statusColor)
                .frame(width: 7, height: 7)
            Text(fanStore.controlState.statusText)
                .font(.caption2)
                .foregroundStyle(FoldviewTheme.coolGray)
            if let sourceLabel {
                Text(sourceLabel)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(FoldviewTheme.babyBlue)
            }
            Spacer()
        }
    }

    private var sourceLabel: String? {
        switch fanStore.source {
        case .smc: return "via SMC"
        case .powermetrics: return "via powermetrics"
        case .unavailable, nil: return nil
        }
    }

    private var statusColor: Color {
        switch fanStore.controlState {
        case .available: return FoldviewTheme.healthyGreen
        case .readOnly: return FoldviewTheme.workingAmber
        case .unavailable: return FoldviewTheme.errorRed
        }
    }

    private var enableRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                fanStore.enableAccess()
            } label: {
                HStack(spacing: 6) {
                    if fanStore.isEnabling {
                        ProgressView().controlSize(.small)
                    }
                    Text(fanStore.isEnabling ? "Waiting for helper…" : "Enable fan access")
                        .font(.system(size: 12, weight: .semibold))
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(FoldviewTheme.babyBlue.opacity(0.15))
                .foregroundStyle(FoldviewTheme.babyBlue)
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
            .buttonStyle(.plain)
            .disabled(fanStore.isEnabling)
            Text("asks for your Mac password once — live RPM and fan control run through a small root helper")
                .font(.caption2)
                .foregroundStyle(FoldviewTheme.coolGray)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(FoldviewTheme.secondaryBackground.opacity(0.35))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("This Mac has no fan")
                .font(.callout)
                .foregroundStyle(Color.white.opacity(0.9))
            Text("Fanless Macs (and Macs whose fans the SMC doesn't expose) have nothing to show here.")
                .font(.caption)
                .foregroundStyle(FoldviewTheme.coolGray)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One fan: name, big current RPM, min–max range, target slider, Apply/Auto.
private struct FanRow: View {
    let fan: FanReading
    let controlAvailable: Bool
    let isWriting: Bool
    let onApply: (Int) -> Void
    let onAuto: () -> Void

    @State private var target: Double
    @State private var targetInitialized = false

    init(fan: FanReading, controlAvailable: Bool, isWriting: Bool, onApply: @escaping (Int) -> Void, onAuto: @escaping () -> Void) {
        self.fan = fan
        self.controlAvailable = controlAvailable
        self.isWriting = isWriting
        self.onApply = onApply
        self.onAuto = onAuto
        _target = State(initialValue: fan.actualRPM)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(fan.name)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color.white)
                if fan.isForced {
                    Text("manual")
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(FoldviewTheme.workingAmber)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(FoldviewTheme.workingAmber.opacity(0.15))
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                }
                Spacer()
                Text("\(Int(fan.actualRPM.rounded()))")
                    .font(.system(size: 24, weight: .bold, design: .rounded))
                    .foregroundStyle(Color.white)
                Text("rpm")
                    .font(.caption)
                    .foregroundStyle(FoldviewTheme.coolGray)
            }
            HStack(spacing: 8) {
                Text("range \(Int(fan.minRPM.rounded()))–\(Int(fan.maxRPM.rounded())) rpm")
                    .font(.caption2)
                    .foregroundStyle(FoldviewTheme.coolGray)
                if let target = fan.targetRPM, fan.isForced {
                    Text("target \(Int(target.rounded()))")
                        .font(.caption2)
                        .foregroundStyle(FoldviewTheme.coolGray)
                }
            }
            HStack(spacing: 10) {
                Slider(value: $target, in: sliderRange, step: 50) {
                    Text("Target RPM")
                } onEditingChanged: { editing in
                    if !editing { targetInitialized = true }
                }
                .disabled(!controlAvailable || isWriting)
                Text("\(Int(target.rounded()))")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(FoldviewTheme.coolGray)
                    .frame(minWidth: 44, alignment: .trailing)
                Button("Apply") { onApply(Int(target.rounded())) }
                    .font(.system(size: 11, weight: .semibold))
                    .disabled(!controlAvailable || isWriting)
                Button("Auto") { onAuto() }
                    .font(.system(size: 11, weight: .semibold))
                    .disabled(!controlAvailable || isWriting || !fan.isForced)
            }
        }
        .padding(10)
        .background(FoldviewTheme.secondaryBackground.opacity(0.35))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .onAppear {
            if !targetInitialized {
                target = min(max(fan.actualRPM, sliderRange.lowerBound), sliderRange.upperBound)
            }
        }
    }

    /// The slider range: the fan's reported min–max, or a sane fallback when
    /// the data source (powermetrics) doesn't know the range.
    private var sliderRange: ClosedRange<Double> {
        if fan.maxRPM > fan.minRPM { return fan.minRPM...fan.maxRPM }
        return 0...6000
    }
}
