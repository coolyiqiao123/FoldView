import SwiftUI
import AppKit
import ServiceManagement

/// Settings: roots (read/write through the CLI), general preferences, and CLI
/// path/repair. Root mutations always go through `AppStore` → `FoldviewCLI` so
/// Swift never becomes a second writer of `~/.foldview.json`.
struct SettingsView: View {
    @EnvironmentObject private var store: AppStore

    @AppStorage("FoldviewShowDiscoveredApps") private var showDiscoveredApps = true
    @AppStorage("FoldviewRefreshSeconds") private var refreshSecondsSetting = 60
    @AppStorage("FoldviewLaunchAtLogin") private var launchAtLogin = false

    var body: some View {
        TabView {
            rootsTab.tabItem { Text("Roots") }
            generalTab.tabItem { Text("General") }
            cliTab.tabItem { Text("CLI") }
        }
        .frame(width: 420, height: 340)
        .onAppear { store.refreshRoots() }
    }

    // MARK: - Roots

    private var rootsTab: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Project roots")
                .font(.headline)
            Text("Foldview scans these folders for local projects and never uploads project data.")
                .font(.caption)
                .foregroundStyle(FoldviewTheme.coolGray)

            List(store.roots, id: \.self) { root in
                HStack {
                    Text(root)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer()
                    Button {
                        store.removeRoot(root)
                    } label: {
                        Image(systemName: "minus.circle")
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Remove \(root)")
                }
            }
            .frame(minHeight: 120)

            Button("Add root…") { chooseRoot() }
        }
        .padding(16)
    }

    private func chooseRoot() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Add Root"
        if panel.runModal() == .OK, let url = panel.url {
            store.addRoot(url.path)
        }
    }

    // MARK: - General

    private var generalTab: some View {
        Form {
            Stepper("Refresh every \(refreshSecondsSetting)s", value: $refreshSecondsSetting, in: 15...600, step: 15)
            Toggle("Show discovered local apps", isOn: $showDiscoveredApps)
            Toggle("Launch Foldview at login", isOn: $launchAtLogin)
                .onChange(of: launchAtLogin) { _, newValue in setLaunchAtLogin(newValue) }
            Text("Refresh interval and discovered-app visibility take effect after restarting Foldview and are currently stored by this app only — the frozen CLI bridge does not yet expose a way to read/write those two `menubar` config fields, only roots. See mac/README.md.")
                .font(.caption)
                .foregroundStyle(FoldviewTheme.coolGray)
        }
        .padding(16)
    }

    private func setLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            // Revert the toggle; SMAppService registration only fully works
            // from an installed .app bundle, not a bare `swift run` binary.
            launchAtLogin = !enabled
        }
    }

    // MARK: - CLI

    private var cliTab: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Foldview CLI")
                .font(.headline)
            if let path = store.resolvedCLIPath {
                Text(path)
                    .font(.system(.body, design: .monospaced))
            } else {
                Text("No Foldview CLI found.")
                    .foregroundStyle(FoldviewTheme.errorRed)
            }
            Button("Repair / re-detect") { store.repairCLIPath() }

            Divider()

            Text("Detected AI CLIs")
                .font(.headline)
            if store.aiClis.isEmpty {
                Text("None detected yet.")
                    .font(.caption)
                    .foregroundStyle(FoldviewTheme.coolGray)
            } else {
                ForEach(store.aiClis) { cli in
                    Text("\(cli.name) — \(cli.executable)")
                        .font(.caption)
                }
            }
            Text("Custom CLI executables are added through the Foldview CLI configuration (~/.foldview.json aiClis). Adding or removing entries from this window requires a CLI subcommand that is not yet part of the frozen bridge contract — see mac/README.md.")
                .font(.caption)
                .foregroundStyle(FoldviewTheme.coolGray)
        }
        .padding(16)
    }
}
