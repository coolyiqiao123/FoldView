import Foundation

/// Presentation model derived from `ProjectPayload`. This is the only place that
/// turns raw payload booleans into the row's status symbol/text, so ProjectRow and
/// AppStore never duplicate that logic.
///
/// Status is never communicated by color alone: `statusSymbol` and `statusText`
/// always carry the meaning; color is a secondary reinforcement (see
/// Theme/FoldviewTheme.swift and Views/ProjectRow.swift).
struct ProjectRowModel: Identifiable, Equatable, Sendable {
    let id: String
    let name: String
    let path: String
    let kind: ProjectKind
    let live: Bool
    let port: Int?
    let launchable: Bool
    let managed: Bool
    let modifiedAt: Date?

    init(payload: ProjectPayload) {
        id = payload.id
        name = payload.name
        path = payload.path
        kind = payload.kind
        live = payload.live
        port = payload.port
        launchable = payload.launchable
        managed = payload.managed
        modifiedAt = payload.modifiedAt.map { Date(timeIntervalSince1970: Double($0) / 1000) }
    }

    /// `●` live, `○` ready to start, `—` no dev server — matches the TUI's
    /// existing non-color-reliant vocabulary from the design spec.
    var statusSymbol: String {
        if live { return "●" }
        if launchable { return "○" }
        return "—"
    }

    var statusText: String {
        if live {
            if let port { return "live :\(port)" }
            return "live"
        }
        if launchable { return "ready" }
        return "no dev server"
    }

    /// `Open` is offered for a live website.
    var canOpen: Bool { live }
    /// `Start` is offered for a stopped, launchable project.
    var canStart: Bool { launchable && !live }
    /// `Stop` is offered only when Foldview holds a validated ownership record
    /// (the Node side already performed PID/command/cwd/port validation before
    /// setting `managed: true`; Swift never re-derives this itself).
    var canStop: Bool { managed && live }

    var parentPathDisplay: String { Self.shortenedParent(of: path) }

    /// Shortens a project's parent directory for display, substituting `~` for
    /// the home directory the same way the TUI does.
    static func shortenedParent(of path: String) -> String {
        let url = URL(fileURLWithPath: path)
        let parent = url.deletingLastPathComponent().path
        let home = NSHomeDirectory()
        if parent == home { return "~" }
        if parent.hasPrefix(home + "/") {
            return "~" + parent.dropFirst(home.count)
        }
        return parent
    }
}
