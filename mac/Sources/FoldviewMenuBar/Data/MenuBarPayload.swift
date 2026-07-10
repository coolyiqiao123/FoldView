import Foundation

/// Codable model for the FROZEN `pm status --format menubar-json` schemaVersion-1
/// payload emitted by `folder.mjs`. Decoding is
/// forward-compatible: unknown JSON keys are ignored by `JSONDecoder` because they
/// have no matching `CodingKeys` case, and every field that the spec marks optional
/// is modeled as `Optional` so a future payload may omit it without failing decode.
struct MenuBarPayload: Decodable, Sendable, Equatable {
    let schemaVersion: Int
    let generatedAt: String
    let summary: Summary
    let projects: [ProjectPayload]
    let aiClis: [AICLIPayload]

    struct Summary: Decodable, Sendable, Equatable {
        let projectCount: Int
        let liveCount: Int
    }
}

/// A single project entry from the status payload.
struct ProjectPayload: Decodable, Sendable, Equatable, Identifiable {
    let id: String
    let name: String
    let path: String
    let kind: ProjectKind
    let live: Bool
    let port: Int?
    let launchable: Bool
    let managed: Bool
    /// Milliseconds since the Unix epoch, matching the JSON example in the spec.
    let modifiedAt: Int64?
}

/// `kind` is forward-compatible on purpose: a payload from a newer `pm` build may
/// introduce a kind this build has never seen. Rather than fail the whole decode,
/// unknown values fall through to `.unknown(rawValue)` so callers can still show
/// the row (see ProjectRowModel) instead of dropping the project.
enum ProjectKind: Decodable, Sendable, Equatable {
    case project
    case app
    case unknown(String)

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let raw = try container.decode(String.self)
        switch raw {
        case "project": self = .project
        case "app": self = .app
        default: self = .unknown(raw)
        }
    }

    var stringValue: String {
        switch self {
        case .project: return "project"
        case .app: return "app"
        case .unknown(let value): return value
        }
    }
}

/// A detected or custom AI coding CLI, as reported by `pm status`.
struct AICLIPayload: Decodable, Sendable, Equatable, Hashable, Identifiable {
    let name: String
    let executable: String

    var id: String { executable }
}
