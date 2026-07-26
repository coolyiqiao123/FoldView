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
    @StateObject private var store: AppStore

    init() {
        // Helper mode first: when re-executed as root for a fan write this
        // runs the SMC write and exits before any scene exists. See
        // Fans/FanWriteHelper.swift.
        FanWriteHelper.exitIfHelperInvocation(CommandLine.arguments)
        let appStore = AppStore()
        _store = StateObject(wrappedValue: appStore)
        _appDelegate.wrappedValue.appStore = appStore
    }

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
    /// Handed over from `FoldviewApp.init` so the notch panel shares the same
    /// AppStore instance as the menu-bar popover.
    var appStore: AppStore?

    private var bridgeServer: NotchBridgeServer?
    private var notchController: NotchPanelController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        Task { @MainActor [weak self] in
            guard let self, let appStore = self.appStore else { return }

            // Notch stores. The agents/burn stores get their own lightweight
            // CLI adapter instance; resolution of the `pm` executable is
            // stateless and shared via the same resolver chain.
            let cli = FoldviewCLI()
            let activityStore = AgentActivityStore()
            let agentsStore = AgentsStore(cli: cli, activityStore: activityStore)
            let burnStore = BurnStore(cli: cli)
            let fanStore = FanStore()

            // Localhost approval bridge (127.0.0.1 only, ephemeral port,
            // per-launch token; state file written once the port is known).
            let bridge = NotchBridgeServer(store: activityStore)
            do {
                try await bridge.start()
                self.bridgeServer = bridge
            } catch {
                appStore.reportError(error)
            }

            // Click-to-open notch panel, collapsed pill under the notch.
            let controller = NotchPanelController(
                appStore: appStore,
                agentsStore: agentsStore,
                burnStore: burnStore,
                fanStore: fanStore,
                activityStore: activityStore
            )
            controller.show()
            self.notchController = controller
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Stops the listener and removes the bridge state file so stale shims
        // never talk to a dead port.
        bridgeServer?.stop()
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
