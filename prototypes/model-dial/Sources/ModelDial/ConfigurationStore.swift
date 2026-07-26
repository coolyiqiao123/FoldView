import Foundation

struct KimiParsedConfiguration: Sendable {
    let defaultModel: String?
    let thinkingEnabled: Bool
    let thinkingEffort: String?
    let models: [ModelOption]
}

enum ConfigurationStore {
    static func parseTopLevelString(_ key: String, in source: String) -> String? {
        let lines = source.components(separatedBy: "\n")
        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("[") { break }
            guard let parsed = parseAssignment(trimmed), parsed.key == key else { continue }
            return unquote(parsed.value)
        }
        return nil
    }

    static func updateTopLevelStrings(_ values: [String: String], in source: String) -> String {
        var lines = source.components(separatedBy: "\n")
        var pending = values
        var firstTableIndex = lines.count

        for index in lines.indices {
            let trimmed = lines[index].trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("[") {
                firstTableIndex = index
                break
            }
            guard let parsed = parseAssignment(trimmed), let value = pending[parsed.key] else { continue }
            lines[index] = "\(parsed.key) = \(quote(value))"
            pending.removeValue(forKey: parsed.key)
        }

        if !pending.isEmpty {
            let additions = pending.keys.sorted().map { "\($0) = \(quote(pending[$0]!))" }
            lines.insert(contentsOf: additions, at: firstTableIndex)
        }
        return lines.joined(separator: "\n")
    }

    static func updateTable(
        _ table: String,
        stringValues: [String: String] = [:],
        boolValues: [String: Bool] = [:],
        in source: String
    ) -> String {
        var lines = source.components(separatedBy: "\n")
        let header = "[\(table)]"
        guard let headerIndex = lines.firstIndex(where: { $0.trimmingCharacters(in: .whitespaces) == header }) else {
            if lines.last != "" { lines.append("") }
            lines.append(header)
            for key in stringValues.keys.sorted() { lines.append("\(key) = \(quote(stringValues[key]!))") }
            for key in boolValues.keys.sorted() { lines.append("\(key) = \(boolValues[key]! ? "true" : "false")") }
            return lines.joined(separator: "\n")
        }

        var pendingStrings = stringValues
        var pendingBools = boolValues
        var endIndex = lines.count
        var index = headerIndex + 1
        while index < lines.count {
            let trimmed = lines[index].trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("[") {
                endIndex = index
                break
            }
            if let parsed = parseAssignment(trimmed) {
                if let value = pendingStrings[parsed.key] {
                    lines[index] = "\(parsed.key) = \(quote(value))"
                    pendingStrings.removeValue(forKey: parsed.key)
                } else if let value = pendingBools[parsed.key] {
                    lines[index] = "\(parsed.key) = \(value ? "true" : "false")"
                    pendingBools.removeValue(forKey: parsed.key)
                }
            }
            index += 1
        }

        let additions = pendingStrings.keys.sorted().map { "\($0) = \(quote(pendingStrings[$0]!))" }
            + pendingBools.keys.sorted().map { "\($0) = \(pendingBools[$0]! ? "true" : "false")" }
        lines.insert(contentsOf: additions, at: endIndex)
        return lines.joined(separator: "\n")
    }

    static func parseKimi(_ source: String) -> KimiParsedConfiguration {
        let defaultModel = parseTopLevelString("default_model", in: source)
        var models: [String: PartialKimiModel] = [:]
        var currentModel: String?
        var inThinking = false
        var thinkingEnabled = true
        var thinkingEffort: String?

        for rawLine in source.components(separatedBy: "\n") {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("[models.\"") && line.hasSuffix("\"]") {
                currentModel = String(line.dropFirst(9).dropLast(2))
                inThinking = false
                if let currentModel { models[currentModel] = PartialKimiModel() }
                continue
            }
            if line == "[thinking]" {
                currentModel = nil
                inThinking = true
                continue
            }
            if line.hasPrefix("[") {
                currentModel = nil
                inThinking = false
                continue
            }
            guard let assignment = parseAssignment(line) else { continue }

            if let alias = currentModel {
                var model = models[alias] ?? PartialKimiModel()
                switch assignment.key {
                case "model": model.remoteID = unquote(assignment.value)
                case "display_name": model.displayName = unquote(assignment.value)
                case "support_efforts": model.efforts = parseStringArray(assignment.value)
                case "default_effort": model.defaultEffort = unquote(assignment.value)
                case "capabilities": model.capabilities = parseStringArray(assignment.value)
                default: break
                }
                models[alias] = model
            } else if inThinking {
                if assignment.key == "enabled" { thinkingEnabled = assignment.value == "true" }
                if assignment.key == "effort" { thinkingEffort = unquote(assignment.value) }
            }
        }

        let options = models.map { alias, partial in
            let isThinking = partial.capabilities.contains("thinking")
            let efforts = partial.efforts
            return ModelOption(
                id: alias,
                displayName: partial.displayName ?? partial.remoteID ?? alias,
                detail: isThinking && efforts.isEmpty ? "Thinking is always on" : "Kimi managed model",
                efforts: efforts,
                defaultEffort: partial.defaultEffort,
                priority: kimiPriority(alias)
            )
        }.sorted {
            if $0.priority != $1.priority { return $0.priority < $1.priority }
            return $0.displayName.localizedStandardCompare($1.displayName) == .orderedAscending
        }

        return KimiParsedConfiguration(
            defaultModel: defaultModel,
            thinkingEnabled: thinkingEnabled,
            thinkingEffort: thinkingEffort,
            models: options
        )
    }

    static func writePreservingPermissions(_ text: String, to url: URL) throws {
        let manager = FileManager.default
        let attributes = try? manager.attributesOfItem(atPath: url.path)
        let backup = url.appendingPathExtension("model-dial.backup")
        if manager.fileExists(atPath: url.path) {
            try? manager.removeItem(at: backup)
            try manager.copyItem(at: url, to: backup)
        }
        try Data(text.utf8).write(to: url, options: .atomic)
        if let permissions = attributes?[.posixPermissions] {
            try? manager.setAttributes([.posixPermissions: permissions], ofItemAtPath: url.path)
        }
    }

    private struct PartialKimiModel {
        var remoteID: String?
        var displayName: String?
        var efforts: [String] = []
        var defaultEffort: String?
        var capabilities: [String] = []
    }

    private static func parseAssignment(_ line: String) -> (key: String, value: String)? {
        guard !line.hasPrefix("#"), let equals = line.firstIndex(of: "=") else { return nil }
        let key = String(line[..<equals]).trimmingCharacters(in: .whitespaces)
        var value = String(line[line.index(after: equals)...]).trimmingCharacters(in: .whitespaces)
        if let comment = value.firstIndex(of: "#") { value = String(value[..<comment]).trimmingCharacters(in: .whitespaces) }
        guard !key.isEmpty else { return nil }
        return (key, value)
    }

    private static func quote(_ value: String) -> String {
        "\"" + value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }

    private static func unquote(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        guard trimmed.count >= 2, trimmed.first == "\"", trimmed.last == "\"" else { return trimmed }
        return String(trimmed.dropFirst().dropLast())
            .replacingOccurrences(of: "\\\"", with: "\"")
            .replacingOccurrences(of: "\\\\", with: "\\")
    }

    private static func parseStringArray(_ value: String) -> [String] {
        guard let start = value.firstIndex(of: "["), let end = value.lastIndex(of: "]"), start < end else { return [] }
        return value[value.index(after: start)..<end]
            .split(separator: ",")
            .map { unquote(String($0).trimmingCharacters(in: .whitespaces)) }
            .filter { !$0.isEmpty }
    }

    private static func kimiPriority(_ alias: String) -> Int {
        if alias.hasSuffix("/k3") { return 0 }
        if alias.contains("highspeed") { return 2 }
        return 1
    }
}
