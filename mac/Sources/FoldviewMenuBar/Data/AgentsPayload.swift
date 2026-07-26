import Foundation

/// Codable model for the FROZEN `pm agents --json` schemaVersion-1 payload.
/// Decoding is forward-compatible in the same style as `MenuBarPayload`:
/// unknown JSON keys are ignored, unrecognized enum raw values fall back to
/// `.unknown(rawValue)`, and optional fields tolerate being absent.
struct AgentsPayload: Decodable, Sendable, Equatable {
    let schemaVersion: Int
    let ok: Bool?
    let generatedAt: String?
    let agents: [AgentEntry]

    init(
        schemaVersion: Int,
        ok: Bool? = nil,
        generatedAt: String? = nil,
        agents: [AgentEntry]
    ) {
        self.schemaVersion = schemaVersion
        self.ok = ok
        self.generatedAt = generatedAt
        self.agents = agents
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion, ok, generatedAt, agents
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
        ok = try container.decodeIfPresent(Bool.self, forKey: .ok)
        generatedAt = try container.decodeIfPresent(String.self, forKey: .generatedAt)
        agents = try container.decodeIfPresent([AgentEntry].self, forKey: .agents) ?? []
    }
}

/// A single agent session entry from the agents payload.
struct AgentEntry: Decodable, Sendable, Equatable, Identifiable {
    let id: String
    let cli: AgentCLIKind
    let roles: [AgentRoleKind]
    let project: String?
    let pid: Int?
    let status: AgentStatusKind
    let currentAction: String?
    let startedAt: String?
    let lastActivityAt: String?

    init(
        id: String,
        cli: AgentCLIKind,
        roles: [AgentRoleKind] = [],
        project: String? = nil,
        pid: Int? = nil,
        status: AgentStatusKind,
        currentAction: String? = nil,
        startedAt: String? = nil,
        lastActivityAt: String? = nil
    ) {
        self.id = id
        self.cli = cli
        self.roles = roles
        self.project = project
        self.pid = pid
        self.status = status
        self.currentAction = currentAction
        self.startedAt = startedAt
        self.lastActivityAt = lastActivityAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, cli, roles, project, pid, status, currentAction, startedAt, lastActivityAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        cli = try container.decodeIfPresent(AgentCLIKind.self, forKey: .cli) ?? .unknown("")
        roles = try container.decodeIfPresent([AgentRoleKind].self, forKey: .roles) ?? []
        project = try container.decodeIfPresent(String.self, forKey: .project)
        pid = try container.decodeIfPresent(Int.self, forKey: .pid)
        status = try container.decodeIfPresent(AgentStatusKind.self, forKey: .status) ?? .unknown("")
        currentAction = try container.decodeIfPresent(String.self, forKey: .currentAction)
        startedAt = try container.decodeIfPresent(String.self, forKey: .startedAt)
        lastActivityAt = try container.decodeIfPresent(String.self, forKey: .lastActivityAt)
    }
}

/// The CLI an agent session belongs to. Unknown values from a newer `pm`
/// build fall through to `.unknown` instead of failing the whole decode.
enum AgentCLIKind: Decodable, Sendable, Equatable {
    case claude
    case kimi
    case codex
    case claudeFlow
    case unknown(String)

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let raw = try container.decode(String.self)
        switch raw {
        case "claude": self = .claude
        case "kimi": self = .kimi
        case "codex": self = .codex
        case "claude-flow": self = .claudeFlow
        default: self = .unknown(raw)
        }
    }

    var stringValue: String {
        switch self {
        case .claude: return "claude"
        case .kimi: return "kimi"
        case .codex: return "codex"
        case .claudeFlow: return "claude-flow"
        case .unknown(let value): return value
        }
    }
}

/// A role tag reported for an agent session; an agent may carry several.
enum AgentRoleKind: Decodable, Sendable, Equatable {
    case interactive
    case observer
    case daemon
    case subagent
    case unknown(String)

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let raw = try container.decode(String.self)
        switch raw {
        case "interactive": self = .interactive
        case "observer": self = .observer
        case "daemon": self = .daemon
        case "subagent": self = .subagent
        default: self = .unknown(raw)
        }
    }

    var stringValue: String {
        switch self {
        case .interactive: return "interactive"
        case .observer: return "observer"
        case .daemon: return "daemon"
        case .subagent: return "subagent"
        case .unknown(let value): return value
        }
    }
}

/// Whether an agent session is currently doing work.
enum AgentStatusKind: Decodable, Sendable, Equatable {
    case active
    case idle
    case unknown(String)

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let raw = try container.decode(String.self)
        switch raw {
        case "active": self = .active
        case "idle": self = .idle
        default: self = .unknown(raw)
        }
    }

    var stringValue: String {
        switch self {
        case .active: return "active"
        case .idle: return "idle"
        case .unknown(let value): return value
        }
    }
}
