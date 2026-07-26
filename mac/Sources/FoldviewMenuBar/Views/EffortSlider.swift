import SwiftUI

/// A model-dependent discrete effort control. Zero stops means fixed thinking;
/// one stop is shown read-only; two or more stops are adjustable.
struct EffortSlider: View {
    let providerName: String
    let model: AIModelOption
    @Binding var selectedEffort: String?

    private var index: Int { model.efforts.firstIndex(of: selectedEffort ?? "") ?? 0 }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Reasoning effort")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(FoldviewTheme.coolGray)
                Spacer()
                Text(valueLabel)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(FoldviewTheme.babyBlue)
            }

            if model.efforts.count > 1 {
                Slider(
                    value: Binding(
                        get: { Double(index) },
                        set: { newValue in
                            selectedEffort = model.efforts[min(max(Int(newValue.rounded()), 0), model.efforts.count - 1)]
                        }
                    ),
                    in: 0...Double(model.efforts.count - 1),
                    step: 1
                )
                .tint(FoldviewTheme.babyBlue)
                .accessibilityLabel("\(providerName) reasoning effort for \(model.label)")
                .accessibilityValue("\(valueLabel), position \(index + 1) of \(model.efforts.count)")
            } else {
                HStack(spacing: 6) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(FoldviewTheme.healthyGreen)
                    Text(model.efforts.isEmpty ? "This model uses fixed thinking." : "This model has one available effort level.")
                        .font(.caption)
                        .foregroundStyle(FoldviewTheme.coolGray)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(providerName), \(model.label), \(model.efforts.isEmpty ? "fixed thinking" : valueLabel)")
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 8).fill(FoldviewTheme.secondaryBackground))
    }

    private var valueLabel: String {
        selectedEffort?.uppercased() ?? (model.efforts.isEmpty ? "FIXED" : "DEFAULT")
    }
}
