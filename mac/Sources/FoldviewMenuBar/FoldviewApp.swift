import SwiftUI
import AppKit

/// Menu-bar entry point. Uses `MenuBarExtra` with `.window` style so the popover
/// can host arbitrary SwiftUI (list, buttons, sheets) rather than a plain menu.
///
/// Dock/accessory lifecycle: when bundled as `FoldviewMenuBar.app` for
/// distribution, set `LSUIElement = true` in Info.plist so the app never gets a
/// Dock icon or app-switcher entry. During `swift run` development there is no
/// Info.plist, so `AppDelegate` calls `NSApp.setActivationPolicy(.accessory)`
/// directly on launch to get the same effect. See mac/README.md.
@main
struct FoldviewApp: App {
    @NSApplicationDelegateAdaptor(FoldviewAppDelegate.self) private var appDelegate
    @StateObject private var store = AppStore()

    var body: some Scene {
        MenuBarExtra {
            MenuBarContent()
                .environmentObject(store)
        } label: {
            MenuBarLabel(liveCount: store.summary?.liveCount ?? 0)
        }
        .menuBarExtraStyle(.window)

        Settings {
            SettingsView()
                .environmentObject(store)
        }
    }
}

final class FoldviewAppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
    }
}

/// Menu-bar item: a monochrome template-image folder symbol, with an optional
/// live-count badge. No token cost, notifications, or animated status here per
/// spec — that belongs in the popover, not the menu-bar item itself.
struct MenuBarLabel: View {
    let liveCount: Int

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "folder")
                .renderingMode(.template)
            if liveCount > 0 {
                Text("\(liveCount)")
                    .font(.system(size: 11, weight: .semibold))
            }
        }
    }
}
