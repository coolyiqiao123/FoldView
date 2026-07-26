import Foundation

enum CatalogLoader {
    private static let home = FileManager.default.homeDirectoryForCurrentUser
    static let codexURL = firstExisting([
        home.appendingPathComponent(".local/bin/codex"),
        home.appendingPathComponent(".codex/bin/codex"),
        URL(fileURLWithPath: "/opt/homebrew/bin/codex"),
        URL(fileURLWithPath: "/usr/local/bin/codex")
    ]) ?? home.appendingPathComponent(".local/bin/codex")
    static let kimiURL = firstExisting([
        home.appendingPathComponent(".kimi-code/bin/kimi"),
        URL(fileURLWithPath: "/opt/homebrew/bin/kimi"),
        URL(fileURLWithPath: "/usr/local/bin/kimi")
    ]) ?? home.appendingPathComponent(".kimi-code/bin/kimi")
    static let codexConfigURL = home.appendingPathComponent(".codex/config.toml")
    static let kimiConfigURL = home.appendingPathComponent(".kimi-code/config.toml")

    static func loadCodex() throws -> ToolSnapshot {
        let result = try run(CatalogLoader.codexURL, arguments: ["debug", "models"])
        guard result.status == 0 else {
            throw ModelDialError.commandFailed(result.error.isEmpty ? "Codex could not list its models." : result.error)
        }
        let decoder = JSONDecoder()
        let entries: [CodexEntry]
        if let wrapped = try? decoder.decode(CodexCatalog.self, from: result.output) {
            entries = wrapped.models
        } else {
            entries = try decoder.decode([CodexEntry].self, from: result.output)
        }
        let models = entries
            .filter { $0.visibility == nil || $0.visibility == "list" }
            .map {
                ModelOption(
                    id: $0.slug,
                    displayName: $0.displayName,
                    detail: $0.description ?? "Codex model",
                    efforts: $0.supportedReasoningLevels?.map(\.effort) ?? [],
                    defaultEffort: $0.defaultReasoningLevel,
                    priority: $0.priority ?? 999
                )
            }
            .sorted {
                if $0.priority != $1.priority { return $0.priority < $1.priority }
                return $0.displayName.localizedStandardCompare($1.displayName) == .orderedAscending
            }
        guard !models.isEmpty else { throw ModelDialError.missingModels("Codex") }

        let config = try String(contentsOf: codexConfigURL, encoding: .utf8)
        return ToolSnapshot(
            models: models,
            defaultModelID: ConfigurationStore.parseTopLevelString("model", in: config),
            defaultEffort: ConfigurationStore.parseTopLevelString("model_reasoning_effort", in: config)
        )
    }

    static func loadKimi() throws -> ToolSnapshot {
        let source = try String(contentsOf: kimiConfigURL, encoding: .utf8)
        let parsed = ConfigurationStore.parseKimi(source)
        guard !parsed.models.isEmpty else { throw ModelDialError.missingModels("Kimi Code") }
        return ToolSnapshot(
            models: parsed.models,
            defaultModelID: parsed.defaultModel,
            defaultEffort: parsed.thinkingEnabled ? parsed.thinkingEffort : nil
        )
    }

    static func saveDefault(tool: ToolKind, modelID: String, effort: String?) throws {
        switch tool {
        case .codex:
            let source = try String(contentsOf: codexConfigURL, encoding: .utf8)
            var values = ["model": modelID]
            if let effort { values["model_reasoning_effort"] = effort }
            let updated = ConfigurationStore.updateTopLevelStrings(values, in: source)
            try ConfigurationStore.writePreservingPermissions(updated, to: codexConfigURL)
        case .kimi:
            let source = try String(contentsOf: kimiConfigURL, encoding: .utf8)
            var updated = ConfigurationStore.updateTopLevelStrings(["default_model": modelID], in: source)
            if let effort {
                updated = ConfigurationStore.updateTable(
                    "thinking",
                    stringValues: ["effort": effort],
                    boolValues: ["enabled": true],
                    in: updated
                )
            }
            try ConfigurationStore.writePreservingPermissions(updated, to: kimiConfigURL)
        }
    }

    static func launch(tool: ToolKind, modelID: String, effort: String?, directory: URL) throws {
        let executable = tool == .codex ? codexURL.path : kimiURL.path
        var pieces = ["cd", shellQuote(directory.path), "&&"]
        if tool == .kimi, let effort {
            pieces.append("KIMI_MODEL_THINKING_EFFORT=\(shellQuote(effort))")
        }
        pieces.append(shellQuote(executable))
        switch tool {
        case .codex:
            pieces += ["--model", shellQuote(modelID)]
            if let effort {
                pieces += ["--config", shellQuote("model_reasoning_effort=\"\(effort)\"")]
            }
        case .kimi:
            pieces += ["--model", shellQuote(modelID)]
        }

        let command = pieces.joined(separator: " ")
        let script = """
        tell application "Terminal"
            activate
            do script \(appleScriptLiteral(command))
        end tell
        """
        let result = try run(URL(fileURLWithPath: "/usr/bin/osascript"), arguments: ["-e", script])
        guard result.status == 0 else {
            throw ModelDialError.commandFailed(result.error.isEmpty ? "Terminal could not be opened." : result.error)
        }
    }

    private static func run(_ executable: URL, arguments: [String]) throws -> CommandResult {
        let manager = FileManager.default
        let runID = UUID().uuidString
        let outputURL = manager.temporaryDirectory.appendingPathComponent("model-dial-\(runID).out")
        let errorURL = manager.temporaryDirectory.appendingPathComponent("model-dial-\(runID).err")
        manager.createFile(atPath: outputURL.path, contents: nil)
        manager.createFile(atPath: errorURL.path, contents: nil)
        defer {
            try? manager.removeItem(at: outputURL)
            try? manager.removeItem(at: errorURL)
        }

        let process = Process()
        let output = try FileHandle(forWritingTo: outputURL)
        let error = try FileHandle(forWritingTo: errorURL)
        process.executableURL = executable
        process.arguments = arguments
        process.standardOutput = output
        process.standardError = error
        try process.run()
        process.waitUntilExit()
        try output.close()
        try error.close()
        return CommandResult(
            status: process.terminationStatus,
            output: try Data(contentsOf: outputURL),
            error: (try? String(contentsOf: errorURL, encoding: .utf8)) ?? ""
        )
    }

    private static func firstExisting(_ candidates: [URL]) -> URL? {
        candidates.first { FileManager.default.isExecutableFile(atPath: $0.path) }
    }

    private static func shellQuote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    private static func appleScriptLiteral(_ value: String) -> String {
        "\"" + value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n") + "\""
    }

    private struct CommandResult {
        let status: Int32
        let output: Data
        let error: String
    }

    private struct CodexEntry: Decodable {
        let slug: String
        let displayName: String
        let description: String?
        let defaultReasoningLevel: String?
        let supportedReasoningLevels: [ReasoningLevel]?
        let visibility: String?
        let priority: Int?

        enum CodingKeys: String, CodingKey {
            case slug
            case displayName = "display_name"
            case description
            case defaultReasoningLevel = "default_reasoning_level"
            case supportedReasoningLevels = "supported_reasoning_levels"
            case visibility
            case priority
        }
    }

    private struct CodexCatalog: Decodable {
        let models: [CodexEntry]
    }

    private struct ReasoningLevel: Decodable {
        let effort: String
    }
}
