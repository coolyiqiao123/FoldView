import Foundation

/// Every mutation `pm status --format menubar-json`, `pm roots …`, and
/// `pm action …` support, expressed as one literal argv array per case. Building
/// this as an enum (rather than assembling strings ad hoc at call sites) is what
/// guarantees a project path or CLI path can never be concatenated into shell
/// source: `arguments` is a pure, unit-testable function from case to `[String]`.
enum CLIAction: Equatable, Sendable {
    case open(project: String)
    case start(project: String, open: Bool)
    case stop(project: String)
    case editor(project: String)
    case ai(project: String, cli: String, count: Int)

    var arguments: [String] {
        switch self {
        case .open(let project):
            return ["action", "open", "--project", project]
        case .start(let project, let open):
            var args = ["action", "start", "--project", project]
            if open { args.append("--open") }
            return args
        case .stop(let project):
            return ["action", "stop", "--project", project]
        case .editor(let project):
            return ["action", "editor", "--project", project]
        case .ai(let project, let cli, let count):
            return ["action", "ai", "--project", project, "--cli", cli, "--count", String(count)]
        }
    }
}

/// Typed errors surfaced by the CLI process adapter. A non-zero exit or stderr
/// output always becomes one of these instead of a decoded payload.
enum CLIError: Error, LocalizedError, Equatable, Sendable {
    case executableNotFound
    case processLaunchFailed(String)
    case nonZeroExit(code: Int32, message: String)
    case decodingFailed(String)
    case emptyOutput

    var errorDescription: String? {
        switch self {
        case .executableNotFound:
            return "Could not find the Foldview CLI. Open Settings to repair the CLI path."
        case .processLaunchFailed(let message):
            return "Could not launch the Foldview CLI: \(message)"
        case .nonZeroExit(let code, let message):
            return message.isEmpty ? "Foldview CLI exited with status \(code)." : message
        case .decodingFailed(let message):
            return "Could not read the Foldview CLI response: \(message)"
        case .emptyOutput:
            return "The Foldview CLI returned no output."
        }
    }
}

/// The subset of `FoldviewCLI` that the rest of the app depends on, so tests can
/// inject a fake instead of spawning a real process. `Sendable` because calls
/// cross from the actor-isolated adapter to the `@MainActor` store.
protocol FoldviewCLIProtocol: Sendable {
    func status() async throws -> MenuBarPayload
    func rootsList() async throws -> [String]
    func rootsAdd(_ path: String) async throws
    func rootsRemove(_ path: String) async throws
    func perform(_ action: CLIAction) async throws
    /// Native-only convenience (not part of the frozen CLI bridge): opens a single
    /// Terminal.app window in `root` running the resolved `pm` executable, for the
    /// popover footer's "Open Foldview" action. See mac/README.md for why this is
    /// the one place the companion talks to Terminal directly instead of going
    /// through `pm action ai` (which owns the multi-window tiling grid).
    func openFoldviewInTerminal(root: String) async throws
}

/// Process-launch adapter for the Foldview CLI bridge. Every call spawns the
/// recorded absolute `pm` executable with `Process` and a literal argument array
/// — never `/bin/sh -c` — and decodes stdout with `Codable`. Process spawn and
/// JSON decoding happen on this actor, off the `@MainActor` that owns UI state.
actor FoldviewCLI: FoldviewCLIProtocol {
    struct ExecutionResult: Sendable {
        let stdout: Data
        let stderr: Data
        let exitCode: Int32
    }

    /// Resolves the absolute `pm` executable path. Injectable so tests never
    /// touch the real filesystem or `~/Library/Application Support`.
    private let executableResolver: @Sendable () -> String?

    init(executableResolver: @escaping @Sendable () -> String? = { FoldviewCLI.defaultResolver() }) {
        self.executableResolver = executableResolver
    }

    // MARK: - Bridge calls

    func status() async throws -> MenuBarPayload {
        let result = try await run(arguments: ["status", "--format", "menubar-json"])
        try Self.checkExit(result)
        guard !result.stdout.isEmpty else { throw CLIError.emptyOutput }
        do {
            return try JSONDecoder().decode(MenuBarPayload.self, from: result.stdout)
        } catch {
            throw CLIError.decodingFailed(String(describing: error))
        }
    }

    func rootsList() async throws -> [String] {
        let result = try await run(arguments: ["roots", "list", "--json"])
        try Self.checkExit(result)
        guard !result.stdout.isEmpty else { return [] }
        do {
            return try JSONDecoder().decode([String].self, from: result.stdout)
        } catch {
            throw CLIError.decodingFailed(String(describing: error))
        }
    }

    func rootsAdd(_ path: String) async throws {
        let result = try await run(arguments: ["roots", "add", path])
        try Self.checkExit(result)
    }

    func rootsRemove(_ path: String) async throws {
        let result = try await run(arguments: ["roots", "remove", path])
        try Self.checkExit(result)
    }

    func perform(_ action: CLIAction) async throws {
        let result = try await run(arguments: action.arguments)
        try Self.checkExit(result)
    }

    // MARK: - Open Foldview (native Terminal launch, see protocol doc comment)

    func openFoldviewInTerminal(root: String) async throws {
        guard let executable = executableResolver() else { throw CLIError.executableNotFound }
        let command = "cd \(Self.posixQuote(root)) && \(Self.posixQuote(executable))"
        let script = "tell application \"Terminal\"\nactivate\ndo script \(Self.appleScriptQuote(command))\nend tell"
        let result = try await run(executable: "/usr/bin/osascript", arguments: ["-e", script])
        try Self.checkExit(result)
    }

    /// POSIX single-quote an argument for use inside a shell command string.
    /// `'` becomes `'\''` (close quote, escaped literal quote, reopen quote).
    static func posixQuote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    /// Escape a string for embedding as an AppleScript string literal, then wrap
    /// it in double quotes.
    static func appleScriptQuote(_ value: String) -> String {
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        return "\"\(escaped)\""
    }

    // MARK: - Process execution

    private func run(arguments: [String]) async throws -> ExecutionResult {
        guard let executable = executableResolver() else {
            throw CLIError.executableNotFound
        }
        return try await run(executable: executable, arguments: arguments)
    }

    /// Spawns `executable` with the literal `arguments` array via `Process`.
    /// `arguments` is never joined into a string and never passed to a shell —
    /// this is the single choke point every CLI call and the Terminal launcher
    /// go through, which is what the adapter tests assert against.
    private func run(executable: String, arguments: [String]) async throws -> ExecutionResult {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<ExecutionResult, Error>) in
                process.terminationHandler = { finished in
                    let stdoutData = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
                    let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
                    continuation.resume(returning: ExecutionResult(
                        stdout: stdoutData,
                        stderr: stderrData,
                        exitCode: finished.terminationStatus
                    ))
                }
                do {
                    try process.run()
                } catch {
                    continuation.resume(throwing: CLIError.processLaunchFailed(String(describing: error)))
                }
            }
        } onCancel: {
            if process.isRunning {
                process.terminate()
            }
        }
    }

    private static func checkExit(_ result: ExecutionResult) throws {
        guard result.exitCode == 0 else {
            let message = String(data: result.stderr, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            throw CLIError.nonZeroExit(code: result.exitCode, message: message)
        }
    }

    // MARK: - Executable resolution

    /// Default resolver: an explicit dev override, then the recorded path file,
    /// then a small fixed list of expected npm/Homebrew locations. Never shells
    /// out to `command -v` or `npm bin` here — that would reintroduce the same
    /// chicken-and-egg problem the recorded path file exists to avoid.
    static func defaultResolver() -> String? {
        if let override = ProcessInfo.processInfo.environment["FOLDVIEW_CLI_PATH"],
           !override.isEmpty,
           FileManager.default.isExecutableFile(atPath: override) {
            return override
        }
        if let recorded = try? String(contentsOf: cliPathRecordURL, encoding: .utf8) {
            let trimmed = recorded.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty, FileManager.default.isExecutableFile(atPath: trimmed) {
                return trimmed
            }
        }
        for candidate in fallbackCandidates where FileManager.default.isExecutableFile(atPath: candidate) {
            persistExecutablePath(candidate)
            return candidate
        }
        return nil
    }

    static var appSupportDirectoryURL: URL {
        FileManager.default
            .homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Foldview", isDirectory: true)
    }

    static var cliPathRecordURL: URL {
        appSupportDirectoryURL.appendingPathComponent("cli-path-v1")
    }

    static var fallbackCandidates: [String] {
        let home = NSHomeDirectory()
        return [
            "/opt/homebrew/bin/pm",
            "/usr/local/bin/pm",
            home + "/.npm-global/bin/pm",
            home + "/.volta/bin/pm",
            home + "/Library/pnpm/pm"
        ]
    }

    /// Atomic tmp-file + rename write, matching the convention used for
    /// `~/.foldview.json` and the runtime registry.
    static func persistExecutablePath(_ path: String) {
        let directory = appSupportDirectoryURL
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let destination = cliPathRecordURL
        let temp = directory.appendingPathComponent(".cli-path-v1.\(UUID().uuidString).tmp")
        do {
            try path.write(to: temp, atomically: false, encoding: .utf8)
            _ = try FileManager.default.replaceItemAt(destination, withItemAt: temp)
        } catch {
            try? FileManager.default.removeItem(at: temp)
        }
    }
}
