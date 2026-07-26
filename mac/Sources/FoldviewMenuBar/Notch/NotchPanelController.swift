import AppKit
import SwiftUI
import Combine

/// Shared expanded/collapsed state for the notch panel, observed by the root
/// view to swap between the slim pill and the full panel.
@MainActor
final class NotchPanelState: ObservableObject {
    @Published var isExpanded = false
}

/// Borderless panel subclass. `canBecomeKey` lets the expanded panel receive
/// keyboard input (the Deny reason field) without ever activating the app;
/// it never becomes main.
private final class NotchPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

/// Owns the click-to-open notch panel: a borderless, non-activating NSPanel
/// pinned directly under the camera notch. Collapsed it is a slim black pill
/// (`◆ N agents · $X.XX today`); clicking it springs open the four-tab panel.
/// Esc or any click outside collapses it. Display reconfiguration re-lays the
/// panel out against the new notch geometry.
@MainActor
final class NotchPanelController {
    let panelState = NotchPanelState()

    private let appStore: AppStore
    private let agentsStore: AgentsStore
    private let burnStore: BurnStore
    private let fanStore: FanStore
    private let activityStore: AgentActivityStore

    private var panel: NotchPanel?
    /// Event monitors are only installed/removed while the panel is expanded,
    /// always from the main thread — marked `nonisolated(unsafe)` so `deinit`
    /// can drop them without an actor hop.
    nonisolated(unsafe) private var globalClickMonitor: Any?
    nonisolated(unsafe) private var localEventMonitor: Any?
    private var cancellables: Set<AnyCancellable> = []

    init(
        appStore: AppStore,
        agentsStore: AgentsStore,
        burnStore: BurnStore,
        fanStore: FanStore,
        activityStore: AgentActivityStore
    ) {
        self.appStore = appStore
        self.agentsStore = agentsStore
        self.burnStore = burnStore
        self.fanStore = fanStore
        self.activityStore = activityStore

        panelState.$isExpanded
            .sink { [weak self] expanded in
                guard let self else { return }
                if expanded {
                    self.agentsStore.startPolling()
                } else {
                    self.agentsStore.stopPolling()
                    self.removeMonitors()
                }
            }
            .store(in: &cancellables)

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(screenParametersDidChange),
            name: NSApplication.didChangeScreenParametersNotification,
            object: nil
        )
    }

    deinit {
        removeMonitors()
        NotificationCenter.default.removeObserver(self)
    }

    // MARK: - Lifecycle

    /// Creates the panel and shows it collapsed under the notch.
    func show() {
        guard panel == nil else { return }
        let rootView = NotchRootView(panelState: panelState, onToggle: { [weak self] in
            self?.toggle()
        })
        .environmentObject(appStore)
        .environmentObject(agentsStore)
        .environmentObject(burnStore)
        .environmentObject(fanStore)
        .environmentObject(activityStore)

        let hosting = NSHostingView(rootView: rootView)
        let panel = NotchPanel(
            contentRect: Self.layout().collapsed,
            styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isMovable = false
        panel.ignoresMouseEvents = false
        panel.contentView = hosting
        panel.orderFrontRegardless()
        self.panel = panel
    }

    // MARK: - Expand / collapse

    func toggle() {
        panelState.isExpanded ? collapse() : expand()
    }

    func expand() {
        guard let panel, !panelState.isExpanded else { return }
        panelState.isExpanded = true
        animate(to: Self.layout().expanded)
        panel.makeKey()
        installMonitors()
    }

    func collapse() {
        guard panelState.isExpanded else { return }
        panelState.isExpanded = false
        animate(to: Self.layout().collapsed)
    }

    private func animate(to frame: NSRect) {
        guard let panel else { return }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.35
            // Spring-ish ease with a slight overshoot on the way out.
            context.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.25, 1.1)
            context.allowsImplicitAnimation = false
            panel.animator().setFrame(frame, display: true)
        }
    }

    // MARK: - Geometry

    /// The notch rectangle in screen coordinates, or nil when this display
    /// has no notch. Derived from the auxiliary areas macOS reports around
    /// the camera housing.
    static func notchRect(on screen: NSScreen) -> NSRect? {
        guard screen.safeAreaInsets.top > 0,
              let left = screen.auxiliaryTopLeftArea,
              let right = screen.auxiliaryTopRightArea else { return nil }
        let height = screen.safeAreaInsets.top
        let width = screen.frame.width - left.width - right.width
        guard width > 0 else { return nil }
        return NSRect(
            x: screen.frame.origin.x + left.width,
            y: screen.frame.origin.y + screen.frame.height - height,
            width: width,
            height: height
        )
    }

    /// Collapsed and expanded frames on the best available screen. Without a
    /// notch the pill falls back to the top-center of the primary screen at a
    /// fixed 240pt width.
    static func layout(on screen: NSScreen? = NSScreen.main) -> (collapsed: NSRect, expanded: NSRect) {
        guard let screen else {
            return (.zero, .zero)
        }
        let screenFrame = screen.frame
        let notch = notchRect(on: screen)
        let centerX = notch?.midX ?? screenFrame.midX

        let collapsedSize = NSSize(
            width: notch.map { $0.width + 90 } ?? 240,
            height: max((notch?.height ?? 26) - 2, 18)
        )
        let collapsed = NSRect(
            x: centerX - collapsedSize.width / 2,
            y: screenFrame.maxY - collapsedSize.height,
            width: collapsedSize.width,
            height: collapsedSize.height
        )

        let expandedSize = NSSize(width: 580, height: 440)
        let expandedX = min(
            max(centerX - expandedSize.width / 2, screenFrame.minX + 8),
            screenFrame.maxX - expandedSize.width - 8
        )
        let expanded = NSRect(
            x: expandedX,
            y: screenFrame.maxY - expandedSize.height - 4,
            width: expandedSize.width,
            height: expandedSize.height
        )
        return (collapsed, expanded)
    }

    /// Re-anchors the panel after a display change, preserving expand state.
    @objc private nonisolated func screenParametersDidChange() {
        Task { @MainActor in
            guard let panel = self.panel else { return }
            let layout = Self.layout()
            panel.setFrame(self.panelState.isExpanded ? layout.expanded : layout.collapsed, display: true)
        }
    }

    // MARK: - Outside-click / Esc monitors

    private func installMonitors() {
        removeMonitors()
        // Clicks delivered to other apps collapse the panel outright.
        globalClickMonitor = NSEvent.addGlobalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown]
        ) { [weak self] _ in
            Task { @MainActor in self?.collapse() }
        }
        // Events inside our own app: clicks in other windows collapse; Esc
        // collapses and is consumed.
        localEventMonitor = NSEvent.addLocalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown, .keyDown]
        ) { [weak self] event in
            guard let self else { return event }
            if event.type == .keyDown, event.keyCode == 53 {
                Task { @MainActor in self.collapse() }
                return nil
            }
            if (event.type == .leftMouseDown || event.type == .rightMouseDown),
               event.window !== self.panel {
                Task { @MainActor in self.collapse() }
            }
            return event
        }
    }

    private nonisolated func removeMonitors() {
        if let globalClickMonitor {
            NSEvent.removeMonitor(globalClickMonitor)
            self.globalClickMonitor = nil
        }
        if let localEventMonitor {
            NSEvent.removeMonitor(localEventMonitor)
            self.localEventMonitor = nil
        }
    }
}
