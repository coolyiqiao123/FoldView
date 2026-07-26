import Foundation
import Testing
@testable import FoldviewMenuBar

/// Decoding tests for the frozen `pm agents --json` schemaVersion-1 payload:
/// a full valid fixture, forward-compatible unknown keys/values, and a
/// minimal fixture with everything optional omitted.
struct AgentsPayloadTests {
    static let validJSON = """
    {
      "schemaVersion": 1,
      "ok": true,
      "generatedAt": "2026-07-20T12:00:00.000Z",
      "agents": [
        {
          "id": "session-abc",
          "cli": "claude",
          "roles": ["interactive", "subagent"],
          "project": "foldview",
          "pid": 4242,
          "status": "active",
          "currentAction": "editing NotchBridgeServer.swift",
          "startedAt": "2026-07-20T11:00:00.000Z",
          "lastActivityAt": "2026-07-20T11:59:00.000Z"
        },
        {
          "id": "session-def",
          "cli": "kimi",
          "roles": ["observer"],
          "project": null,
          "pid": null,
          "status": "idle",
          "currentAction": null,
          "startedAt": null,
          "lastActivityAt": "2026-07-20T11:30:00.000Z"
        }
      ]
    }
    """

    static let forwardCompatibleJSON = """
    {
      "schemaVersion": 1,
      "ok": true,
      "generatedAt": "2026-07-20T12:00:00.000Z",
      "experimental": {"future": true},
      "agents": [
        {
          "id": "session-ghi",
          "cli": "claude-flow",
          "roles": ["daemon", "new-future-role"],
          "status": "busy",
          "extraField": [1, 2, 3]
        }
      ]
    }
    """

    static let minimalJSON = """
    {
      "schemaVersion": 1
    }
    """

    static let missingSchemaVersionJSON = """
    {
      "ok": true,
      "agents": []
    }
    """

    @Test func decodesValidPayload() throws {
        let payload = try JSONDecoder().decode(AgentsPayload.self, from: Data(Self.validJSON.utf8))
        #expect(payload.schemaVersion == 1)
        #expect(payload.ok == true)
        #expect(payload.generatedAt == "2026-07-20T12:00:00.000Z")
        #expect(payload.agents.count == 2)

        let first = payload.agents[0]
        #expect(first.id == "session-abc")
        #expect(first.cli == .claude)
        #expect(first.roles == [.interactive, .subagent])
        #expect(first.project == "foldview")
        #expect(first.pid == 4242)
        #expect(first.status == .active)
        #expect(first.currentAction == "editing NotchBridgeServer.swift")
        #expect(first.startedAt == "2026-07-20T11:00:00.000Z")
        #expect(first.lastActivityAt == "2026-07-20T11:59:00.000Z")

        let second = payload.agents[1]
        #expect(second.cli == .kimi)
        #expect(second.roles == [.observer])
        #expect(second.project == nil)
        #expect(second.pid == nil)
        #expect(second.status == .idle)
        #expect(second.currentAction == nil)
    }

    @Test func ignoresUnknownKeysAndFallsBackOnUnknownEnums() throws {
        let payload = try JSONDecoder().decode(AgentsPayload.self, from: Data(Self.forwardCompatibleJSON.utf8))
        #expect(payload.agents.count == 1)
        let agent = payload.agents[0]
        #expect(agent.cli == .claudeFlow)
        #expect(agent.cli.stringValue == "claude-flow")
        #expect(agent.roles == [.daemon, .unknown("new-future-role")])
        #expect(agent.roles[1].stringValue == "new-future-role")
        #expect(agent.status == .unknown("busy"))
        #expect(agent.status.stringValue == "busy")
    }

    @Test func toleratesMissingOptionalSections() throws {
        let payload = try JSONDecoder().decode(AgentsPayload.self, from: Data(Self.minimalJSON.utf8))
        #expect(payload.schemaVersion == 1)
        #expect(payload.ok == nil)
        #expect(payload.generatedAt == nil)
        #expect(payload.agents.isEmpty)
    }

    @Test func rejectsPayloadWithoutSchemaVersion() {
        #expect(throws: (any Error).self) {
            try JSONDecoder().decode(AgentsPayload.self, from: Data(Self.missingSchemaVersionJSON.utf8))
        }
    }
}
