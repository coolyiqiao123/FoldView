import Foundation
@testable import FoldviewMenuBar

/// Shared fixtures for decoding and store tests. JSON strings mirror the frozen
/// schemaVersion-1 payload emitted by `pm status --format menubar-json`;
/// the programmatic builders below are for tests that don't need to exercise
/// JSONDecoder itself.
enum PayloadFixtures {
    static let validJSON = """
    {
      "schemaVersion": 1,
      "generatedAt": "2026-07-02T12:00:00.000Z",
      "summary": { "projectCount": 1, "liveCount": 1 },
      "projects": [
        {
          "id": "/Users/example/Projects/my-app",
          "name": "my-app",
          "path": "/Users/example/Projects/my-app",
          "kind": "project",
          "live": true,
          "port": 5173,
          "launchable": true,
          "managed": true,
          "modifiedAt": 1782993600000
        }
      ],
      "aiClis": [
        { "name": "claude", "executable": "/absolute/path/to/claude" }
      ]
    }
    """

    /// Adds an unknown top-level field, an unknown field inside a project, an
    /// unrecognized `kind` value, and a second project that omits both optional
    /// fields (`port`, `modifiedAt`) entirely.
    static let forwardCompatibleJSON = """
    {
      "schemaVersion": 1,
      "generatedAt": "2026-07-02T12:00:00.000Z",
      "experimentalFeatureFlags": { "foo": true },
      "summary": { "projectCount": 2, "liveCount": 1 },
      "projects": [
        {
          "id": "/Users/example/Projects/my-app",
          "name": "my-app",
          "path": "/Users/example/Projects/my-app",
          "kind": "workspace",
          "tags": ["x", "y"],
          "live": true,
          "port": 5173,
          "launchable": true,
          "managed": true,
          "modifiedAt": 1782993600000
        },
        {
          "id": "/Users/example/Projects/quiet-app",
          "name": "quiet-app",
          "path": "/Users/example/Projects/quiet-app",
          "kind": "project",
          "live": false,
          "launchable": false,
          "managed": false
        }
      ],
      "aiClis": []
    }
    """

    static let emptyJSON = """
    {
      "schemaVersion": 1,
      "generatedAt": "2026-07-02T12:00:00.000Z",
      "summary": { "projectCount": 0, "liveCount": 0 },
      "projects": [],
      "aiClis": []
    }
    """

    /// Missing the required `schemaVersion` field — must fail to decode.
    static let invalidJSON = """
    {
      "generatedAt": "2026-07-02T12:00:00.000Z",
      "summary": { "projectCount": 0, "liveCount": 0 },
      "projects": [],
      "aiClis": []
    }
    """

    static func project(
        name: String,
        live: Bool = false,
        port: Int? = nil,
        launchable: Bool = true,
        managed: Bool = false,
        modifiedAt: Int64? = nil
    ) -> ProjectPayload {
        ProjectPayload(
            id: "/tmp/\(name)",
            name: name,
            path: "/tmp/\(name)",
            kind: .project,
            live: live,
            port: port,
            launchable: launchable,
            managed: managed,
            modifiedAt: modifiedAt
        )
    }

    static let validPayload = MenuBarPayload(
        schemaVersion: 1,
        generatedAt: "2026-07-02T12:00:00.000Z",
        summary: .init(projectCount: 1, liveCount: 1),
        projects: [project(name: "my-app", live: true, port: 5173, managed: true)],
        aiClis: [AICLIPayload(name: "claude", executable: "/usr/local/bin/claude")]
    )

    static let emptyPayload = MenuBarPayload(
        schemaVersion: 1,
        generatedAt: "2026-07-02T12:00:00.000Z",
        summary: .init(projectCount: 0, liveCount: 0),
        projects: [],
        aiClis: []
    )

    static func payloadNamed(_ name: String) -> MenuBarPayload {
        MenuBarPayload(
            schemaVersion: 1,
            generatedAt: "2026-07-02T12:00:00.000Z",
            summary: .init(projectCount: 1, liveCount: 1),
            projects: [project(name: name, live: true, port: 4000)],
            aiClis: []
        )
    }
}
