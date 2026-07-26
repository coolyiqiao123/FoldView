import Foundation

/// One snapshot of fan telemetry as the app sees it: readings, where they
/// came from, and the daemon's diagnostic note.
struct FanTelemetry: Sendable, Equatable {
    let fans: [FanReading]
    let source: FanStateFile.Source
    let note: String?
    let updatedAt: Date

    init(fans: [FanReading], source: FanStateFile.Source, note: String?, updatedAt: Date) {
        self.fans = fans
        self.source = source
        self.note = note
        self.updatedAt = updatedAt
    }
}

/// What the fan UI needs from its backend. `SMCFanController` implements this
/// over the root daemon's file protocols; tests inject a fake.
protocol FanControlling: Sendable {
    /// Latest telemetry, or nil when no daemon is running / the state file is
    /// stale or missing.
    func readTelemetry() async -> FanTelemetry?
    /// Spawns the root fan daemon (one password prompt per app session) and
    /// waits for its first state file. Typed `FanWriteError.cancelled` when
    /// the user dismisses the prompt.
    func enableAccess(appPID: Int32) async throws
    /// Queues a manual target RPM; resolves when the daemon reports the
    /// command result.
    func setTarget(fan: Int, rpm: Int) async throws
    /// Returns a fan to automatic control; resolves on the daemon's result.
    func setAuto(fan: Int) async throws
}

/// App-side fan access. All fan data flows through the root daemon's file
/// protocols (see `Fans/FanDaemon.swift`): the controller reads
/// `fan-state-v1.json`, writes `fan-command-v1.json` and awaits the matching
/// `lastCommandResult`, and spawns the daemon once per session through the
/// osascript admin pattern. Direct SMC access stays inside the daemon — on
/// the verified target machine (M5, macOS 26) unprivileged value reads are
/// neutered, so reading SMC from the UI process would show nothing.
final class SMCFanController: FanControlling, @unchecked Sendable {
    private let stateURL: URL
    private let commandURL: URL
    private let stateMaxAge: TimeInterval
    private let enableTimeout: TimeInterval
    private let resultTimeout: TimeInterval
    private let pidAlive: @Sendable (Int32) -> Bool

    private let lock = NSLock()
    private var commandSeq = 0
    private var daemonProcess: Process?
    private var daemonEnabled = false

    init(
        stateDirectory: URL? = nil,
        stateMaxAge: TimeInterval = 5,
        enableTimeout: TimeInterval = 15,
        resultTimeout: TimeInterval = 10,
        pidAlive: @escaping @Sendable (Int32) -> Bool = FanStateFile.pidIsAlive
    ) {
        let directory = stateDirectory ?? FoldviewCLI.appSupportDirectoryURL
        stateURL = directory.appendingPathComponent("fan-state-v1.json")
        commandURL = directory.appendingPathComponent("fan-command-v1.json")
        self.stateMaxAge = stateMaxAge
        self.enableTimeout = enableTimeout
        self.resultTimeout = resultTimeout
        self.pidAlive = pidAlive
    }

    // MARK: - Telemetry

    /// Parses the state file when it is fresh (recent + daemon pid alive).
    /// Runs off the calling actor on a global queue.
    func readTelemetry() async -> FanTelemetry? {
        let stateURL = self.stateURL
        let stateMaxAge = self.stateMaxAge
        let pidAlive = self.pidAlive
        return await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .utility).async {
                guard let state = FanStateFile.read(from: stateURL),
                      let updatedAt = state.updatedDate,
                      state.isFresh(maxAge: stateMaxAge, pidAlive: pidAlive) else {
                    continuation.resume(returning: nil)
                    return
                }
                let fans = state.fans.map { fan in
                    FanReading(
                        id: fan.index,
                        name: "Fan \(fan.index)",
                        actualRPM: fan.rpm ?? 0,
                        minRPM: fan.minRpm ?? 0,
                        maxRPM: fan.maxRpm ?? 6000,
                        isForced: fan.forced ?? false,
                        targetRPM: fan.targetRpm
                    )
                }
                continuation.resume(returning: FanTelemetry(
                    fans: fans,
                    source: state.decodedSource,
                    note: state.note,
                    updatedAt: updatedAt
                ))
            }
        }
    }

    // MARK: - Daemon lifecycle

    /// Spawns `<binary> --fan-daemon <appPid>` with administrator privileges
    /// and waits (up to `enableTimeout`) for the first fresh state file.
    /// No-op when a live daemon already publishes fresh state — one password
    /// prompt per app session.
    func enableAccess(appPID: Int32 = ProcessInfo.processInfo.processIdentifier) async throws {
        if daemonIsPublishing() { return }

        guard let binary = Bundle.main.executableURL?.path ?? ProcessInfo.processInfo.arguments.first,
              !binary.isEmpty else {
            throw FanWriteError.launchFailed("Could not determine the app binary path.")
        }
        let command = ([binary, "--fan-daemon", String(appPID)])
            .map(FoldviewCLI.posixQuote)
            .joined(separator: " ")
        let script = "do shell script \(FoldviewCLI.appleScriptQuote(command)) with administrator privileges"

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", script]
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe
        process.terminationHandler = { [weak self] _ in
            self?.daemonDidExit()
        }
        do {
            try process.run()
        } catch {
            throw FanWriteError.launchFailed(String(describing: error))
        }
        setDaemonProcess(process)

        let deadline = Date().addingTimeInterval(enableTimeout)
        while Date() < deadline {
            if daemonIsPublishing() { return }
            if !process.isRunning {
                clearDaemonProcess()
                let stderr = stderrPipe.fileHandleForReading.readDataToEndOfFile()
                let stdout = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
                let output = String(data: stderr + stdout, encoding: .utf8) ?? ""
                if output.contains("User canceled") || output.contains("(-128)") {
                    throw FanWriteError.cancelled
                }
                let message = output.trimmingCharacters(in: .whitespacesAndNewlines)
                throw FanWriteError.helperFailed(message.isEmpty ? "the fan helper exited unexpectedly" : message)
            }
            try await Task.sleep(for: .milliseconds(250))
        }
        throw FanWriteError.helperFailed("timed out waiting for the fan helper to start")
    }

    private func daemonIsPublishing() -> Bool {
        lock.lock()
        let wasEnabled = daemonEnabled
        lock.unlock()
        guard let state = FanStateFile.read(from: stateURL),
              state.isFresh(maxAge: stateMaxAge, pidAlive: pidAlive) else { return false }
        if !wasEnabled {
            lock.lock()
            daemonEnabled = true
            lock.unlock()
        }
        return true
    }

    private func setDaemonProcess(_ process: Process) {
        lock.lock()
        daemonProcess = process
        lock.unlock()
    }

    /// Monotonic command sequence numbers. Synchronous so the lock never
    /// crosses an await boundary.
    private func nextSeq() -> Int {
        lock.lock()
        defer { lock.unlock() }
        commandSeq += 1
        return commandSeq
    }

    private func clearDaemonProcess() {
        lock.lock()
        daemonProcess = nil
        daemonEnabled = false
        lock.unlock()
    }

    private func daemonDidExit() {
        clearDaemonProcess()
    }

    // MARK: - Commands

    func setTarget(fan: Int, rpm: Int) async throws {
        try await sendCommand(action: FanCommand.setAction, fan: fan, rpm: rpm)
    }

    func setAuto(fan: Int) async throws {
        try await sendCommand(action: FanCommand.autoAction, fan: fan, rpm: nil)
    }

    /// Writes the command file atomically, then polls the state file for the
    /// daemon's `lastCommandResult` with a matching `seq` (up to
    /// `resultTimeout`). A non-ok result becomes `FanWriteError.helperFailed`.
    private func sendCommand(action: String, fan: Int, rpm: Int?) async throws {
        let seq = nextSeq()
        try FanCommand(seq: seq, action: action, fan: fan, rpm: rpm).write(to: commandURL)

        let deadline = Date().addingTimeInterval(resultTimeout)
        while Date() < deadline {
            if let state = FanStateFile.read(from: stateURL),
               let result = state.lastCommandResult,
               result.seq == seq {
                if result.ok { return }
                throw FanWriteError.helperFailed(result.message ?? "the fan command failed")
            }
            try await Task.sleep(for: .milliseconds(250))
        }
        throw FanWriteError.helperFailed("timed out waiting for the fan helper — is fan access enabled?")
    }
}
