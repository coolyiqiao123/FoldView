import Foundation

enum ToolKind: String, CaseIterable, Identifiable, Sendable {
    case codex = "Codex"
    case kimi = "Kimi Code"

    var id: String { rawValue }

    var shortName: String {
        switch self {
        case .codex: "Codex"
        case .kimi: "Kimi"
        }
    }

    var symbol: String {
        switch self {
        case .codex: "chevron.left.forwardslash.chevron.right"
        case .kimi: "moon.stars.fill"
        }
    }
}

struct ModelOption: Identifiable, Hashable, Sendable {
    let id: String
    let displayName: String
    let detail: String
    let efforts: [String]
    let defaultEffort: String?
    let priority: Int

    var hasAdjustableEffort: Bool { efforts.count > 1 }
}

struct ToolSnapshot: Sendable {
    let models: [ModelOption]
    let defaultModelID: String?
    let defaultEffort: String?
}

enum ModelDialError: LocalizedError {
    case commandFailed(String)
    case malformedCatalog
    case missingModels(String)
    case invalidSelection

    var errorDescription: String? {
        switch self {
        case .commandFailed(let message): message
        case .malformedCatalog: "The model catalog could not be read."
        case .missingModels(let tool): "No models were found for \(tool)."
        case .invalidSelection: "Choose a model before continuing."
        }
    }
}

enum NoticeTone: Sendable {
    case success
    case warning
    case error
}

struct AppNotice: Equatable, Sendable {
    let text: String
    let tone: NoticeTone
}
