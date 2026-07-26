import SwiftUI

/// A discrete catalog-backed model control. Every stop comes from Node's
/// normalized provider response; the native app never hard-codes model IDs.
struct ModelSlider: View {
    let providerName: String
    let models: [AIModelOption]
    @Binding var selectedModelID: String

    private var index: Int { models.firstIndex { $0.id == selectedModelID } ?? 0 }
    private var selectedModel: AIModelOption? {
        models.indices.contains(index) ? models[index] : nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text("Model")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(FoldviewTheme.coolGray)
                Spacer()
                Text(models.isEmpty ? "0 / 0" : "\(index + 1) / \(models.count)")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(FoldviewTheme.coolGray)
            }
            Text(selectedModel?.label ?? "Unavailable")
                .font(.system(size: 15, weight: .semibold, design: .rounded))
                .lineLimit(1)
            Slider(
                value: Binding(
                    get: { Double(index) },
                    set: { newValue in
                        guard !models.isEmpty else { return }
                        selectedModelID = models[min(max(Int(newValue.rounded()), 0), models.count - 1)].id
                    }
                ),
                in: 0...Double(max(models.count - 1, 1)),
                step: 1
            )
            .tint(FoldviewTheme.babyBlue)
            .disabled(models.count < 2)
            .accessibilityLabel("\(providerName) model")
            .accessibilityValue("\(selectedModel?.label ?? "Unavailable"), position \(models.isEmpty ? 0 : index + 1) of \(models.count)")

            Text(selectedModel?.detail ?? "No model details are available.")
                .font(.caption2)
                .foregroundStyle(FoldviewTheme.coolGray)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 8).fill(FoldviewTheme.secondaryBackground))
    }
}
