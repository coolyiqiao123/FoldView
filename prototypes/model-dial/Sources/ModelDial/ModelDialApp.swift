import SwiftUI

@main
struct ModelDialApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        MenuBarExtra("Model Dial", systemImage: "dial.medium.fill") {
            ControlPanelView(model: model)
        }
        .menuBarExtraStyle(.window)

        WindowGroup("Model Dial Preview", id: "preview") {
            ControlPanelView(model: model)
        }
        .windowResizability(.contentSize)
        .defaultLaunchBehavior(CommandLine.arguments.contains("--preview-window") ? .presented : .suppressed)
    }
}
