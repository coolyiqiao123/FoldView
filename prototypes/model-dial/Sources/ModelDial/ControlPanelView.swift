import SwiftUI

struct ControlPanelView: View {
    @ObservedObject var model: AppModel
    @Environment(\.colorScheme) private var colorScheme

    private var palette: Palette { Palette(colorScheme: colorScheme) }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(palette.border)
            content
        }
        .frame(width: 356)
        .background(palette.canvas)
        .task { model.load() }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 10) {
            ZStack {
                RoundedRectangle(cornerRadius: 7)
                    .fill(palette.accentSurface)
                Image(systemName: "dial.medium.fill")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(palette.accent)
            }
            .frame(width: 30, height: 30)

            VStack(alignment: .leading, spacing: 1) {
                Text("MODEL DIAL")
                    .font(.system(size: 11, weight: .bold, design: .rounded))
                    .tracking(1.2)
                    .foregroundStyle(palette.primary)
                Text(model.defaultSummary)
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(palette.secondary)
                    .lineLimit(1)
            }

            Spacer()

            Button {
                model.load()
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 12, weight: .semibold))
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(QuietIconButtonStyle(palette: palette))
            .help("Refresh model catalogs")

            Button {
                NSApplication.shared.terminate(nil)
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .bold))
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(QuietIconButtonStyle(palette: palette))
            .help("Quit Model Dial")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 13)
    }

    private var content: some View {
        VStack(spacing: 14) {
            toolPicker

            if model.isLoading && model.models.isEmpty {
                loadingState
            } else {
                modelCard
                effortCard
                directoryRow
                if let notice = model.notice { noticeRow(notice) }
                actionRow
            }
        }
        .padding(16)
    }

    private var toolPicker: some View {
        HStack(spacing: 4) {
            ForEach(ToolKind.allCases) { tool in
                Button {
                    withAnimation(.easeOut(duration: 0.16)) { model.switchTool(to: tool) }
                } label: {
                    HStack(spacing: 7) {
                        Image(systemName: tool.symbol)
                            .font(.system(size: 11, weight: .semibold))
                        Text(tool.rawValue)
                            .font(.system(size: 12, weight: .semibold))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .foregroundStyle(model.selectedTool == tool ? palette.primary : palette.secondary)
                    .background(
                        RoundedRectangle(cornerRadius: 6)
                            .fill(model.selectedTool == tool ? palette.selected : Color.clear)
                    )
                }
                .buttonStyle(.plain)
            }
        }
        .padding(3)
        .background(RoundedRectangle(cornerRadius: 8).fill(palette.control))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
    }

    private var loadingState: some View {
        HStack(spacing: 10) {
            ProgressView().controlSize(.small)
            Text("Reading local model catalogs…")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(palette.secondary)
            Spacer()
        }
        .frame(height: 170)
    }

    private var modelCard: some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("MODEL")
                        .sectionLabel(palette.secondary)
                    Text(model.selectedModel?.displayName ?? "Unavailable")
                        .font(.system(size: 20, weight: .semibold, design: .rounded))
                        .tracking(-0.4)
                        .foregroundStyle(palette.primary)
                }
                Spacer()
                Text(model.models.isEmpty ? "0 / 0" : "\(Int(model.modelIndex) + 1) / \(model.models.count)")
                    .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                    .foregroundStyle(palette.secondary)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 4)
                    .background(RoundedRectangle(cornerRadius: 5).fill(palette.control))
            }

            Slider(
                value: Binding(
                    get: { model.modelIndex },
                    set: { model.selectModel(at: Int($0.rounded())) }
                ),
                in: 0...Double(max(model.models.count - 1, 1)),
                step: 1
            )
            .tint(palette.accent)
            .disabled(model.models.count < 2)

            Text(model.selectedModel?.detail ?? "Refresh to load the available models.")
                .font(.system(size: 11, weight: .regular))
                .foregroundStyle(palette.secondary)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .cardStyle(palette)
    }

    private var effortCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("REASONING EFFORT")
                    .sectionLabel(palette.secondary)
                Spacer()
                Text(effortLabel)
                    .font(.system(size: 11, weight: .bold, design: .rounded))
                    .foregroundStyle(palette.accent)
            }

            if model.efforts.count > 1 {
                Slider(
                    value: Binding(
                        get: { model.effortIndex },
                        set: { model.selectEffort(at: Int($0.rounded())) }
                    ),
                    in: 0...Double(model.efforts.count - 1),
                    step: 1
                )
                .tint(palette.accent)

                HStack {
                    Text(model.efforts.first?.capitalized ?? "")
                    Spacer()
                    Text(model.efforts.last?.capitalized ?? "")
                }
                .font(.system(size: 9.5, weight: .medium))
                .foregroundStyle(palette.secondary)
            } else {
                HStack(spacing: 8) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(palette.success)
                    Text(model.selectedTool == .kimi ? "This model uses fixed thinking." : "This model has one available level.")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(palette.secondary)
                    Spacer()
                }
                .padding(.vertical, 2)
            }
        }
        .cardStyle(palette)
    }

    private var directoryRow: some View {
        HStack(spacing: 9) {
            Image(systemName: "folder.fill")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(palette.secondary)
            VStack(alignment: .leading, spacing: 1) {
                Text("WORKING FOLDER")
                    .font(.system(size: 8.5, weight: .bold))
                    .tracking(0.8)
                    .foregroundStyle(palette.secondary)
                Text(model.workingDirectory.path.replacingOccurrences(of: FileManager.default.homeDirectoryForCurrentUser.path, with: "~"))
                    .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                    .foregroundStyle(palette.primary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer()
            Button("Choose") { model.chooseWorkingDirectory() }
                .font(.system(size: 10.5, weight: .semibold))
                .buttonStyle(.plain)
                .foregroundStyle(palette.accent)
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 9)
        .background(RoundedRectangle(cornerRadius: 7).fill(palette.control))
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(palette.border, lineWidth: 1))
    }

    private func noticeRow(_ notice: AppNotice) -> some View {
        HStack(spacing: 8) {
            Image(systemName: notice.tone == .error ? "exclamationmark.circle.fill" : "checkmark.circle.fill")
            Text(notice.text)
                .lineLimit(2)
            Spacer()
        }
        .font(.system(size: 10.5, weight: .medium))
        .foregroundStyle(notice.tone == .error ? palette.error : palette.success)
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 7)
                .fill(notice.tone == .error ? palette.errorSurface : palette.successSurface)
        )
    }

    private var actionRow: some View {
        HStack(spacing: 8) {
            Button {
                model.saveDefault()
            } label: {
                Text("Save default")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 9)
            }
            .buttonStyle(SecondaryButtonStyle(palette: palette))
            .disabled(model.models.isEmpty)

            Button {
                model.launch()
            } label: {
                HStack(spacing: 7) {
                    Text("Launch")
                    Image(systemName: "arrow.up.right")
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 9)
            }
            .buttonStyle(PrimaryButtonStyle(palette: palette))
            .disabled(model.models.isEmpty)
        }
    }

    private var effortLabel: String {
        if let selected = model.selectedEffort { return selected.uppercased() }
        return model.selectedTool == .kimi ? "ALWAYS ON" : "DEFAULT"
    }
}

private struct Palette {
    let canvas: Color
    let control: Color
    let selected: Color
    let border: Color
    let primary: Color
    let secondary: Color
    let accent: Color
    let accentSurface: Color
    let success: Color
    let successSurface: Color
    let error: Color
    let errorSurface: Color

    init(colorScheme: ColorScheme) {
        if colorScheme == .dark {
            canvas = Color(red: 0.105, green: 0.102, blue: 0.095)
            control = Color.white.opacity(0.055)
            selected = Color.white.opacity(0.095)
            border = Color.white.opacity(0.09)
            primary = Color(red: 0.94, green: 0.93, blue: 0.90)
            secondary = Color(red: 0.60, green: 0.59, blue: 0.56)
            accent = Color(red: 0.48, green: 0.67, blue: 0.90)
            accentSurface = Color(red: 0.12, green: 0.20, blue: 0.28)
            success = Color(red: 0.50, green: 0.74, blue: 0.52)
            successSurface = Color(red: 0.12, green: 0.20, blue: 0.13)
            error = Color(red: 0.91, green: 0.48, blue: 0.46)
            errorSurface = Color(red: 0.24, green: 0.12, blue: 0.12)
        } else {
            canvas = Color(red: 0.984, green: 0.980, blue: 0.965)
            control = Color(red: 0.956, green: 0.948, blue: 0.925)
            selected = Color.white
            border = Color.black.opacity(0.07)
            primary = Color(red: 0.10, green: 0.10, blue: 0.095)
            secondary = Color(red: 0.43, green: 0.42, blue: 0.39)
            accent = Color(red: 0.20, green: 0.42, blue: 0.65)
            accentSurface = Color(red: 0.88, green: 0.93, blue: 0.97)
            success = Color(red: 0.20, green: 0.40, blue: 0.22)
            successSurface = Color(red: 0.93, green: 0.96, blue: 0.92)
            error = Color(red: 0.60, green: 0.18, blue: 0.17)
            errorSurface = Color(red: 0.98, green: 0.92, blue: 0.92)
        }
    }
}

private extension View {
    func cardStyle(_ palette: Palette) -> some View {
        padding(13)
            .background(RoundedRectangle(cornerRadius: 10).fill(palette.selected))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))
    }

    func sectionLabel(_ color: Color) -> some View {
        font(.system(size: 9, weight: .bold))
            .tracking(1.0)
            .foregroundStyle(color)
    }
}

private struct QuietIconButtonStyle: ButtonStyle {
    let palette: Palette
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(palette.secondary)
            .background(RoundedRectangle(cornerRadius: 6).fill(configuration.isPressed ? palette.control : Color.clear))
    }
}

private struct SecondaryButtonStyle: ButtonStyle {
    let palette: Palette
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(palette.primary)
            .background(RoundedRectangle(cornerRadius: 6).fill(configuration.isPressed ? palette.control : palette.selected))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(palette.border, lineWidth: 1))
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
    }
}

private struct PrimaryButtonStyle: ButtonStyle {
    let palette: Palette
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(Color.white)
            .background(RoundedRectangle(cornerRadius: 6).fill(configuration.isPressed ? palette.primary.opacity(0.82) : palette.primary))
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
    }
}
