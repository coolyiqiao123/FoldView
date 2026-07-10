import SwiftUI

/// One project row: status symbol + text (never color alone), name, shortened
/// parent path, and explicit actions rather than an ambiguous row tap.
struct ProjectRow: View {
    let project: ProjectRowModel
    var onOpen: () -> Void
    var onStart: () -> Void
    var onStop: () -> Void
    var onEditor: () -> Void
    var onAI: () -> Void
    var onCopyPath: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Text(project.statusSymbol)
                .foregroundStyle(statusColor)
                .frame(width: 14, alignment: .center)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 1) {
                Text(project.name)
                    .font(.system(size: 13))
                    .lineLimit(1)
                Text("\(project.statusText) · \(project.parentPathDisplay)")
                    .font(.system(size: 11))
                    .foregroundStyle(FoldviewTheme.coolGray)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            Spacer(minLength: 8)

            if project.canOpen {
                Button("Open", action: onOpen)
                    .buttonStyle(.borderless)
                    .font(.system(size: 12))
            } else if project.canStart {
                Button("Start", action: onStart)
                    .buttonStyle(.borderless)
                    .font(.system(size: 12))
            }

            Button("AI", action: onAI)
                .buttonStyle(.borderless)
                .font(.system(size: 12))

            Menu {
                Button("Open in editor", action: onEditor)
                Button("Copy path", action: onCopyPath)
                if project.canStop {
                    Divider()
                    Button("Stop", role: .destructive, action: onStop)
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .frame(width: 20)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(project.name), \(project.statusText), \(project.parentPathDisplay)")
    }

    private var statusColor: Color {
        if project.live { return FoldviewTheme.healthyGreen }
        return FoldviewTheme.coolGray
    }
}
