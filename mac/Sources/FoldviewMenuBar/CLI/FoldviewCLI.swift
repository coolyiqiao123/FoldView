import Darwin
import Foundation
import Darwin

private final class SingleResumeContinuation<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Value, Error>?

    init(_ continuation: CheckedContinuation<Value, Error>) {
        self.continuation = continuation
    }

    func resume(returning value: Value) {
        take()?.resume(returning: value)
    }

    func resume(throwing error: Error) {
        take()?.resume(throwing: error)
    }

    private func take() -> CheckedContinuation<Value, Error>? {
        lock.lock(); defer { lock.unlock() }
        let value = continuation
        continuation = nil
        return value
    }
}

enum CapturedOutputStream: Sendable { case stdout, stderr }

/// The only retained process-output storage. Calls from both drain queues are
/// serialized under one lock, so stdout + stderr can never exceed `byteLimit`.
final class BoundedOutputAccumulator: @unchecked Sendable {
    private let lock = NSLock()
    private let byteLimit: Int
    private var stdout = Data()
    private var stderr = Data()
    private var overflow = false
    private var readFailed = false

    init(byteLimit: Int) { self.byteLimit = max(byteLimit, 0) }

    /// Returns true exactly once, when the combined stream first exceeds the cap.
    func append(_ chunk: Data, to stream: CapturedOutputStream) -> Bool {
        lock.lock(); defer { lock.unlock() }
        let retained = stdout.count + stderr.count
        let remaining = max(byteLimit - retained, 0)
        if remaining > 0 {
            let prefix = chunk.prefix(remaining)
            switch stream {
            case .stdout: stdout.append(contentsOf: prefix)
            case .stderr: stderr.append(contentsOf: prefix)
            }
        }
        guard chunk.count > remaining, !overflow else { return false }
        overflow = true
        return true
    }

    func markReadFailure() {
        lock.lock(); readFailed = true; lock.unlock()
    }

    var retainedByteCount: Int {
        lock.lock(); defer { lock.unlock() }
        return stdout.count + stderr.count
    }

    var didOverflow: Bool {
        lock.lock(); defer { lock.unlock() }
        return overflow
    }

    func snapshot() throws -> (stdout: Data, stderr: Data) {
        lock.lock(); defer { lock.unlock() }
        if readFailed { throw CLIError.captureReadFailed }
        return (stdout, stderr)
    }
}

enum ProcessGroupVerifier {
    static func verifiedChildOwnedGroup(for pid: pid_t) -> pid_t? {
        if getpgid(pid) == pid { return pid }
        _ = setpgid(pid, pid)
        return getpgid(pid) == pid ? pid : nil
    }
}

private final class ProcessStopController: @unchecked Sendable {
    enum Reason {
        case cancelled, timedOut, postExitDrainTimeout
        case outputLimit, captureReadFailure, supervisionFailed
    }

    private let lock = NSLock()
    private let process: Process
    private let timeout: TimeInterval
    private var groupPID: pid_t?
    private var reason: Reason?
    private var leaderExited = false
    private var drainsReachedEOF = false

    init(process: Process, timeout: TimeInterval) {
        self.process = process
        self.timeout = timeout
    }

    var stopReason: Reason? {
        lock.lock(); defer { lock.unlock() }
        return reason
    }

    /// Verifies Foundation's child-owned process group, or establishes and
    /// re-verifies it. A pending cancellation/overflow is replayed atomically.
    func started() {
        let pid = process.processIdentifier
        let verifiedGroup = ProcessGroupVerifier.verifiedChildOwnedGroup(for: pid)

        lock.lock()
        if let verifiedGroup {
            groupPID = verifiedGroup
            let pending = reason
            lock.unlock()
            if pending != nil { terminate(group: verifiedGroup) }
            else { scheduleTimeout() }
        } else {
            if reason == nil { reason = .supervisionFailed }
            lock.unlock()
            _ = Darwin.kill(pid, SIGKILL)
        }
    }

    func leaderDidExit() {
        lock.lock()
        leaderExited = true
        let shouldScheduleGrace = reason == nil && !drainsReachedEOF
        lock.unlock()
        if shouldScheduleGrace {
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + .milliseconds(500)) { [weak self] in
                guard let self else { return }
                self.lock.lock()
                let shouldStop = self.reason == nil && self.leaderExited && !self.drainsReachedEOF
                self.lock.unlock()
                if shouldStop { self.stop(.postExitDrainTimeout) }
            }
        }
    }

    /// Supervision ends only after the leader has exited and both pipes reached
    /// EOF. Until then cancellation, the command deadline, and post-exit grace
    /// remain capable of terminating the verified group.
    func drainsDidReachEOF() {
        lock.lock(); drainsReachedEOF = true; lock.unlock()
    }

    /// May run before `Process.run()`. The reason is retained and replayed by
    /// `started()` once a verified process group exists.
    func stop(_ requestedReason: Reason) {
        lock.lock()
        guard reason == nil else { lock.unlock(); return }
        reason = requestedReason
        let group = groupPID
        lock.unlock()
        if let group { terminate(group: group) }
    }

    private func scheduleTimeout() {
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout) { [weak self] in
            guard let self else { return }
            self.lock.lock()
            let shouldStop = self.reason == nil && !self.drainsReachedEOF
            self.lock.unlock()
            if shouldStop { self.stop(.timedOut) }
        }
    }

    private func terminate(group: pid_t) {
        _ = Darwin.kill(-group, SIGTERM)
        // Always target the verified group after the grace period. The leader
        // may already be gone while a TERM-ignoring descendant is still alive.
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + .milliseconds(250)) {
            _ = Darwin.kill(-group, SIGKILL)
        }
    }
}

private final class PipeDrainCoordinator: @unchecked Sendable {
    private let group = DispatchGroup()
    private let accumulator: BoundedOutputAccumulator
    private let controller: ProcessStopController

    init(accumulator: BoundedOutputAccumulator, controller: ProcessStopController) {
        self.accumulator = accumulator
        self.controller = controller
    }

    func start(stdout: FileHandle, stderr: FileHandle) {
        drain(stdout, stream: .stdout)
        drain(stderr, stream: .stderr)
    }

    func waitForEOF() async {
        await withCheckedContinuation { continuation in
            group.notify(queue: .global(qos: .utility)) { continuation.resume() }
        }
    }

    private func drain(_ handle: FileHandle, stream: CapturedOutputStream) {
        group.enter()
        DispatchQueue.global(qos: .utility).async { [accumulator, controller, group] in
            defer {
                try? handle.close()
                group.leave()
            }
            do {
                while let chunk = try handle.read(upToCount: 64 * 1024), !chunk.isEmpty {
                    if accumulator.append(chunk, to: stream) {
                        controller.stop(.outputLimit)
                    }
                    // After overflow, append discards every later byte while this
                    // loop continues draining to EOF so the child cannot block.
                }
            } catch {
                accumulator.markReadFailure()
                controller.stop(.captureReadFailure)
            }
        }
    }
}

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
    case ai(
        project: String,
        cli: String,
        count: Int,
        provider: String?,
        model: String?,
        effort: String?
    )

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
        case .ai(let project, let cli, let count, let provider, let model, let effort):
            var args = ["action", "ai", "--project", project, "--cli", cli, "--count", String(count)]
            if let provider { args += ["--provider", provider] }
            if let model { args += ["--model", model] }
            if let effort { args += ["--effort", effort] }
            args.append("--json")
            return args
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
    case processTimedOut
    case outputLimitExceeded
    case captureReadFailed

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
        case .processTimedOut:
            return "The Foldview CLI operation timed out. Try again."
        case .outputLimitExceeded:
            return "The Foldview CLI returned too much output."
        case .captureReadFailed:
            return "The Foldview CLI response could not be read safely."
        }
    }
}

/// The subset of `FoldviewCLI` that the rest of the app depends on, so tests can
/// inject a fake instead of spawning a real process. `Sendable` because calls
/// cross from the actor-isolated adapter to the `@MainActor` store.
protocol FoldviewCLIProtocol: Sendable {
    func resolvedExecutablePath() async -> String?
    func status() async throws -> MenuBarPayload
    func rootsList() async throws -> [String]
    func rootsAdd(_ path: String) async throws
    func rootsRemove(_ path: String) async throws
    func perform(_ action: CLIAction) async throws
    func aiCatalog(provider: String?) async throws -> AICatalogEnvelope
    func aiDefaults(provider: String) async throws -> AIProviderDefaults
    func setAIDefault(provider: String, model: String, effort: String?) async throws
    func configuration() async throws -> FoldviewConfiguration
    func agents() async throws -> AgentsPayload
    func burn(days: Int) async throws -> BurnPayload
    func setRefreshSeconds(_ seconds: Int) async throws
    func setShowDiscoveredApps(_ show: Bool) async throws
    func addCustomAICLI(name: String, executable: String) async throws
    func removeCustomAICLI(executable: String) async throws
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
    private let captureLimitBytes: Int
    private let timeoutResolver: @Sendable ([String]) -> TimeInterval
    private let beforeRun: @Sendable () -> Void

    init(
        executableResolver: @escaping @Sendable () -> String? = { FoldviewCLI.defaultResolver() },
        captureLimitBytes: Int = 8 * 1024 * 1024,
        timeoutResolver: @escaping @Sendable ([String]) -> TimeInterval = { FoldviewCLI.defaultTimeout(for: $0) },
        beforeRun: @escaping @Sendable () -> Void = {}
    ) {
        self.executableResolver = executableResolver
        self.captureLimitBytes = captureLimitBytes
        self.timeoutResolver = timeoutResolver
        self.beforeRun = beforeRun
    }

    // MARK: - Bridge calls

    func resolvedExecutablePath() async -> String? { executableResolver() }

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
        if case .ai(_, _, let count, let provider, let model, let effort) = action {
            try Self.validateAIActionSuccess(
                result.stdout,
                count: count,
                provider: provider,
                model: model,
                effort: effort
            )
        }
    }

    func aiCatalog(provider: String?) async throws -> AICatalogEnvelope {
        var arguments = ["ai", "catalog"]
        if let provider { arguments += ["--provider", provider] }
        arguments.append("--json")
        let result = try await run(arguments: arguments)
        // Catalog is intentionally decoded even for a non-zero exit: a filtered
        // unavailable provider and an unfiltered all-failed probe still return
        // the complete catalog envelope by contract.
        guard !result.stdout.isEmpty else { try Self.checkExit(result); throw CLIError.emptyOutput }
        do {
            let envelope = try JSONDecoder().decode(AICatalogEnvelope.self, from: result.stdout)
            guard envelope.schemaVersion == 1 else {
                throw CLIError.decodingFailed("Unsupported AI catalog schema version \(envelope.schemaVersion).")
            }
            return envelope
        } catch let error as CLIError {
            throw error
        } catch {
            try Self.checkExit(result)
            throw CLIError.decodingFailed(String(describing: error))
        }
    }

    func aiDefaults(provider: String) async throws -> AIProviderDefaults {
        let result = try await run(arguments: ["ai", "defaults", "get", "--provider", provider, "--json"])
        try Self.checkExit(result)
        return try Self.decodeDefaults(result.stdout)
    }

    func setAIDefault(provider: String, model: String, effort: String?) async throws {
        var arguments = ["ai", "defaults", "set", "--provider", provider, "--model", model]
        if let effort { arguments += ["--effort", effort] }
        arguments.append("--json")
        let result = try await run(arguments: arguments)
        try Self.checkExit(result)
        let defaults = try Self.decodeDefaults(result.stdout)
        guard defaults.saved == true else {
            throw CLIError.decodingFailed("The CLI did not confirm that the default was saved.")
        }
    }

    func configuration() async throws -> FoldviewConfiguration {
        let result = try await run(arguments: ["config", "get", "--json"])
        try Self.checkExit(result)
        guard !result.stdout.isEmpty else { throw CLIError.emptyOutput }
        do { return try JSONDecoder().decode(FoldviewConfiguration.self, from: result.stdout) }
        catch { throw CLIError.decodingFailed(String(describing: error)) }
    }

    func agents() async throws -> AgentsPayload {
        let result = try await run(arguments: ["agents", "--json"])
        try Self.checkExit(result)
        guard !result.stdout.isEmpty else { throw CLIError.emptyOutput }
        do {
            return try JSONDecoder().decode(AgentsPayload.self, from: result.stdout)
        } catch {
            throw CLIError.decodingFailed(String(describing: error))
        }
    }

    func burn(days: Int) async throws -> BurnPayload {
        let result = try await run(arguments: ["burn", "--json", "--days", String(days)])
        try Self.checkExit(result)
        guard !result.stdout.isEmpty else { throw CLIError.emptyOutput }
        do {
            return try JSONDecoder().decode(BurnPayload.self, from: result.stdout)
        } catch {
            throw CLIError.decodingFailed(String(describing: error))
        }
    }

    func setRefreshSeconds(_ seconds: Int) async throws {
        let result = try await run(arguments: ["config", "set", "menubar.refreshSeconds", String(seconds)])
        try Self.checkExit(result)
    }

    func setShowDiscoveredApps(_ show: Bool) async throws {
        let result = try await run(arguments: ["config", "set", "menubar.showDiscoveredApps", String(show)])
        try Self.checkExit(result)
    }

    func addCustomAICLI(name: String, executable: String) async throws {
        let result = try await run(arguments: ["aiclis", "add", "--name", name, "--executable", executable])
        try Self.checkExit(result)
    }

    func removeCustomAICLI(executable: String) async throws {
        let result = try await run(arguments: ["aiclis", "remove", "--executable", executable])
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
        try Task.checkCancellation()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe.fileHandleForWriting
        process.standardError = stderrPipe.fileHandleForWriting
        let accumulator = BoundedOutputAccumulator(byteLimit: captureLimitBytes)
        let controller = ProcessStopController(process: process, timeout: timeoutResolver(arguments))
        let drains = PipeDrainCoordinator(accumulator: accumulator, controller: controller)

        let exitCode: Int32 = try await withTaskCancellationHandler {
            try Task.checkCancellation()
            let status: Int32 = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Int32, Error>) in
                let gate = SingleResumeContinuation(continuation)
                process.terminationHandler = { finished in
                    controller.leaderDidExit()
                    gate.resume(returning: finished.terminationStatus)
                }
                do {
                    // Test-only synchronization can cancel the task after the
                    // check above but before spawn, exercising pending replay.
                    beforeRun()
                    try process.run()
                    controller.started()
                    try? stdoutPipe.fileHandleForWriting.close()
                    try? stderrPipe.fileHandleForWriting.close()
                    drains.start(
                        stdout: stdoutPipe.fileHandleForReading,
                        stderr: stderrPipe.fileHandleForReading
                    )
                } catch {
                    process.terminationHandler = nil
                    try? stdoutPipe.fileHandleForWriting.close()
                    try? stderrPipe.fileHandleForWriting.close()
                    try? stdoutPipe.fileHandleForReading.close()
                    try? stderrPipe.fileHandleForReading.close()
                    gate.resume(throwing: CLIError.processLaunchFailed(String(describing: error)))
                }
            }
            await drains.waitForEOF()
            controller.drainsDidReachEOF()
            return status
        } onCancel: {
            controller.stop(.cancelled)
        }
        switch controller.stopReason {
        case .cancelled: throw CancellationError()
        case .timedOut, .postExitDrainTimeout: throw CLIError.processTimedOut
        case .outputLimit: throw CLIError.outputLimitExceeded
        case .captureReadFailure: throw CLIError.captureReadFailed
        case .supervisionFailed:
            throw CLIError.processLaunchFailed("Could not establish a safe process group.")
        case nil: break
        }
        if accumulator.didOverflow { throw CLIError.outputLimitExceeded }
        let captured = try accumulator.snapshot()
        return ExecutionResult(stdout: captured.stdout, stderr: captured.stderr, exitCode: exitCode)
    }

    private static func checkExit(_ result: ExecutionResult) throws {
        guard result.exitCode == 0 else {
            if let envelope = try? JSONDecoder().decode(AICommandErrorEnvelope.self, from: result.stdout),
               envelope.schemaVersion == 1,
               envelope.ok == false {
                throw AIProviderCommandError(envelope.error)
            }
            let message = String(data: result.stderr, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            throw CLIError.nonZeroExit(code: result.exitCode, message: message)
        }
    }

    private static func decodeDefaults(_ data: Data) throws -> AIProviderDefaults {
        guard !data.isEmpty else { throw CLIError.emptyOutput }
        do {
            let defaults = try JSONDecoder().decode(AIProviderDefaults.self, from: data)
            guard defaults.schemaVersion == 1 else {
                throw CLIError.decodingFailed("Unsupported AI defaults schema version \(defaults.schemaVersion).")
            }
            return defaults
        } catch let error as CLIError {
            throw error
        } catch {
            throw CLIError.decodingFailed(String(describing: error))
        }
    }

    private static func validateAIActionSuccess(
        _ data: Data,
        count: Int,
        provider: String?,
        model: String?,
        effort: String?
    ) throws {
        guard !data.isEmpty else { throw CLIError.emptyOutput }
        let response: AIActionSuccess
        do {
            response = try JSONDecoder().decode(AIActionSuccess.self, from: data)
        } catch {
            throw CLIError.decodingFailed("The AI launch response was malformed.")
        }
        guard response.schemaVersion == 1,
              response.ok,
              response.launched == count,
              response.provider == provider,
              response.model == model,
              response.effort == effort else {
            throw CLIError.decodingFailed("The AI launch response did not match the requested session.")
        }
    }

    static func defaultTimeout(for arguments: [String]) -> TimeInterval {
        if arguments.starts(with: ["status"]) { return 8 }
        if arguments.starts(with: ["agents"]) { return 8 }
        if arguments.starts(with: ["burn"]) { return 20 }
        if arguments.starts(with: ["ai", "catalog"]) { return 8 }
        if arguments.starts(with: ["action", "ai"]) { return 45 }
        if arguments.starts(with: ["ai", "defaults"]) { return 15 }
        return 15
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
    @discardableResult
    static func persistExecutablePath(_ path: String, destination explicitDestination: URL? = nil) -> Bool {
        let destination = explicitDestination ?? cliPathRecordURL
        let directory = destination.deletingLastPathComponent()
        let temp = directory.appendingPathComponent(".cli-path-v1.\(UUID().uuidString).tmp")
        do {
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            var existing = stat()
            if lstat(destination.path, &existing) == 0 {
                guard (existing.st_mode & S_IFMT) == S_IFREG, existing.st_uid == geteuid() else { return false }
            } else if errno != ENOENT {
                return false
            }
            guard FileManager.default.createFile(
                atPath: temp.path,
                contents: nil,
                attributes: [.posixPermissions: 0o600]
            ) else { return false }
            let handle = try FileHandle(forWritingTo: temp)
            do {
                try handle.write(contentsOf: Data((path + "\n").utf8))
                try handle.synchronize()
                try handle.close()
            } catch {
                try? handle.close()
                throw error
            }
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temp.path)
            guard Darwin.rename(temp.path, destination.path) == 0 else {
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
            return true
        } catch {
            try? FileManager.default.removeItem(at: temp)
            return false
        }
    }
}
