import SwiftUI
import AppKit

/// The Foldview baby-blue identity, shared with the TUI's theme tokens: baby blue
/// for selection/primary actions, cool gray for supporting text, green only for
/// healthy/live state, amber for work in progress, red only for errors/unavailable
/// actions. Every color here is dynamic (light + dark mode); nothing in the popover
/// relies on color alone — see ProjectRowModel's text/symbol status vocabulary.
enum FoldviewTheme {
    static let babyBlue = dynamicColor(
        light: NSColor(calibratedRed: 0.42, green: 0.69, blue: 0.94, alpha: 1),
        dark: NSColor(calibratedRed: 0.52, green: 0.75, blue: 0.98, alpha: 1)
    )

    static let coolGray = dynamicColor(
        light: NSColor(calibratedRed: 0.42, green: 0.45, blue: 0.49, alpha: 1),
        dark: NSColor(calibratedRed: 0.66, green: 0.69, blue: 0.73, alpha: 1)
    )

    static let healthyGreen = dynamicColor(
        light: NSColor(calibratedRed: 0.20, green: 0.60, blue: 0.35, alpha: 1),
        dark: NSColor(calibratedRed: 0.35, green: 0.78, blue: 0.49, alpha: 1)
    )

    static let workingAmber = dynamicColor(
        light: NSColor(calibratedRed: 0.80, green: 0.55, blue: 0.10, alpha: 1),
        dark: NSColor(calibratedRed: 0.95, green: 0.70, blue: 0.25, alpha: 1)
    )

    static let errorRed = dynamicColor(
        light: NSColor(calibratedRed: 0.75, green: 0.20, blue: 0.20, alpha: 1),
        dark: NSColor(calibratedRed: 0.92, green: 0.40, blue: 0.40, alpha: 1)
    )

    static let background = Color(nsColor: .windowBackgroundColor)
    static let secondaryBackground = Color(nsColor: .controlBackgroundColor)

    private static func dynamicColor(light: NSColor, dark: NSColor) -> Color {
        Color(nsColor: NSColor(name: nil, dynamicProvider: { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
        }))
    }
}
