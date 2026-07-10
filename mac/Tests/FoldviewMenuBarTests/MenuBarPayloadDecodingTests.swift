import Foundation
import Testing
@testable import FoldviewMenuBar

struct MenuBarPayloadDecodingTests {
    @Test func decodesValidSchemaVersion1Payload() throws {
        let payload = try JSONDecoder().decode(MenuBarPayload.self, from: Data(PayloadFixtures.validJSON.utf8))
        #expect(payload.schemaVersion == 1)
        #expect(payload.summary.projectCount == 1)
        #expect(payload.summary.liveCount == 1)
        #expect(payload.projects.count == 1)
        let project = payload.projects[0]
        #expect(project.id == "/Users/example/Projects/my-app")
        #expect(project.kind == .project)
        #expect(project.live)
        #expect(project.port == 5173)
        #expect(project.launchable)
        #expect(project.managed)
        #expect(project.modifiedAt == 1782993600000)
        #expect(payload.aiClis == [AICLIPayload(name: "claude", executable: "/absolute/path/to/claude")])
    }

    @Test func decodesForwardCompatiblePayloadIgnoringUnknownFieldsAndKinds() throws {
        let payload = try JSONDecoder().decode(MenuBarPayload.self, from: Data(PayloadFixtures.forwardCompatibleJSON.utf8))
        #expect(payload.projects.count == 2)

        let first = payload.projects[0]
        // Unknown "kind" values fall back to .unknown rather than failing decode.
        #expect(first.kind == .unknown("workspace"))
        #expect(first.kind.stringValue == "workspace")

        let second = payload.projects[1]
        // Missing optional fields (port, modifiedAt) decode to nil, not an error.
        #expect(second.port == nil)
        #expect(second.modifiedAt == nil)
        #expect(second.kind == .project)
    }

    @Test func decodesEmptyProjectListAsValidPayload() throws {
        let payload = try JSONDecoder().decode(MenuBarPayload.self, from: Data(PayloadFixtures.emptyJSON.utf8))
        #expect(payload.projects == [])
        #expect(payload.aiClis == [])
        #expect(payload.summary.projectCount == 0)
    }

    @Test func missingRequiredFieldFailsToDecode() {
        #expect(throws: (any Error).self) {
            try JSONDecoder().decode(MenuBarPayload.self, from: Data(PayloadFixtures.invalidJSON.utf8))
        }
    }

    @Test func knownKindValuesRoundTripThroughStringValue() {
        #expect(ProjectKind.project.stringValue == "project")
        #expect(ProjectKind.app.stringValue == "app")
        #expect(ProjectKind.unknown("future-kind").stringValue == "future-kind")
    }
}
