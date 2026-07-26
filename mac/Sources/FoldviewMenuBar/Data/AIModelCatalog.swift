import Foundation

/// A normalized model option returned by Foldview's on-demand provider bridge.
/// IDs and effort values are launch tokens; labels/details are presentation only.
struct AIModelOption: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let label: String
    let detail: String
    let efforts: [String]
    let defaultEffort: String?

    var hasAdjustableEffort: Bool { efforts.count > 1 }
    var isFixedThinking: Bool { efforts.isEmpty }
}

struct AIProviderErrorPayload: Codable, Hashable, Sendable {
    let code: String
    let message: String
    let provider: String?
    let model: String?
    let effort: String?
    let retryable: Bool
}

/// One provider entry. An unavailable provider remains in the envelope with an
/// empty model list, allowing Codex and Kimi failures to be represented independently.
struct AIProviderCatalog: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let executable: String?
    let available: Bool
    let error: AIProviderErrorPayload?
    let defaultModel: String?
    let defaultEffort: String?
    let models: [AIModelOption]

    var selectedDefaultModel: AIModelOption? {
        models.first { $0.id == defaultModel }
    }
}

struct AICatalogEnvelope: Codable, Equatable, Sendable {
    let schemaVersion: Int
    let generatedAt: String
    let providers: [AIProviderCatalog]
}

struct AIProviderDefaults: Codable, Equatable, Sendable {
    let schemaVersion: Int
    let provider: String
    let defaultModel: String?
    let defaultEffort: String?
    let saved: Bool?
}

struct AICommandErrorEnvelope: Codable, Sendable {
    let schemaVersion: Int
    let ok: Bool
    let error: AIProviderErrorPayload
}

/// Exact schema-v1 success document from `pm action ai --json`. Optional wire
/// values are still required keys; `null` is distinct from an omitted field.
struct AIActionSuccess: Decodable, Equatable, Sendable {
    let schemaVersion: Int
    let ok: Bool
    let launched: Int
    let provider: String?
    let model: String?
    let effort: String?

    private enum CodingKeys: String, CodingKey {
        case schemaVersion, ok, launched, provider, model, effort
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        for key in [CodingKeys.provider, .model, .effort] where !container.contains(key) {
            throw DecodingError.keyNotFound(
                key,
                .init(codingPath: container.codingPath, debugDescription: "Missing required AI action field.")
            )
        }
        schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
        ok = try container.decode(Bool.self, forKey: .ok)
        launched = try container.decode(Int.self, forKey: .launched)
        provider = try container.decodeIfPresent(String.self, forKey: .provider)
        model = try container.decodeIfPresent(String.self, forKey: .model)
        effort = try container.decodeIfPresent(String.self, forKey: .effort)
    }
}

/// A typed error preserves Node's stable code so the UI can derive stale state
/// after an authoritative launch/save rejects a formerly valid selection.
struct AIProviderCommandError: Error, LocalizedError, Equatable, Sendable {
    let code: String
    let message: String
    let provider: String?
    let model: String?
    let effort: String?
    let retryable: Bool

    init(_ payload: AIProviderErrorPayload) {
        code = payload.code
        message = payload.message
        provider = payload.provider
        model = payload.model
        effort = payload.effort
        retryable = payload.retryable
    }

    var errorDescription: String? { message }
    var invalidatesCatalog: Bool { code == "unsupported_model" || code == "unsupported_effort" }
}

/// Pure draft-selection rules shared by the popover and Settings UI.
enum AISelection {
    static func initialModel(in provider: AIProviderCatalog) -> AIModelOption? {
        provider.selectedDefaultModel ?? provider.models.first
    }

    static func initialEffort(for model: AIModelOption, providerDefault: String?) -> String? {
        guard !model.efforts.isEmpty else { return nil }
        for candidate in [providerDefault, model.defaultEffort] {
            if let candidate, model.efforts.contains(candidate) { return candidate }
        }
        return model.efforts.first
    }

    static func effortAfterModelChange(for model: AIModelOption, current: String?) -> String? {
        guard !model.efforts.isEmpty else { return nil }
        for candidate in [current, model.defaultEffort] {
            if let candidate, model.efforts.contains(candidate) { return candidate }
        }
        return model.efforts.first
    }
}
