import Foundation

/// Lenient parser for `powermetrics --samplers smc -f text` output. The exact
/// format varies by hardware, so any line containing "fan" and an integer
/// immediately before "rpm" counts: `/fan.*?(\d+)\s*rpm/i`. The fan index is
/// the integer right after "fan" when present, else 0.
enum PowermetricsFanParser {
    /// Parses one line. Returns (index, rpm) or nil when the line is not a
    /// fan-RPM line.
    static func parseFanLine(_ line: String) -> (index: Int, rpm: Int)? {
        let lowered = line.lowercased()
        guard let fanRange = lowered.range(of: "fan"),
              let rpmRange = lowered.range(of: "rpm"),
              fanRange.upperBound < rpmRange.lowerBound else { return nil }

        // RPM: the integer run immediately before "rpm" (whitespace/colon ok).
        var position = rpmRange.lowerBound
        while position > lowered.startIndex {
            let before = lowered.index(before: position)
            let character = lowered[before]
            guard character == " " || character == ":" else { break }
            position = before
        }
        guard position > lowered.startIndex else { return nil }
        // Walk back over the digits to find the run's start.
        var digitsStart = position
        var digits = ""
        while digitsStart > lowered.startIndex {
            let before = lowered.index(before: digitsStart)
            guard lowered[before].isNumber else { break }
            digits.insert(lowered[before], at: digits.startIndex)
            digitsStart = before
        }
        guard let rpm = Int(digits) else { return nil }

        // Optional index: the first integer run between "fan" and the RPM
        // digits. Restricting the scan to that region keeps "Fan: 2160 rpm"
        // from mistaking the RPM itself for an index.
        var index = 0
        var indexDigits = ""
        var cursor = fanRange.upperBound
        while cursor < digitsStart {
            let character = lowered[cursor]
            if character.isNumber {
                indexDigits.append(character)
            } else if !indexDigits.isEmpty {
                break
            }
            cursor = lowered.index(after: cursor)
        }
        if let parsed = Int(indexDigits) { index = parsed }
        return (index, rpm)
    }
}

/// Streams `/usr/bin/powermetrics --samplers smc -i 2000 -f text` as a child
/// process and keeps the most recent fan-RPM readings. Used by the daemon
/// only when root SMC value reads still return nothing.
final class PowermetricsSampler: @unchecked Sendable {
    private var process: Process?
    private let lock = NSLock()
    private var lineBuffer = ""
    private var latestByIndex: [Int: (rpm: Int, at: Date)] = [:]

    deinit { stop() }

    func start() {
        guard process == nil else { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/powermetrics")
        process.arguments = ["--samplers", "smc", "-i", "2000", "-f", "text"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            self?.ingest(text)
        }
        do {
            try process.run()
            self.process = process
        } catch {
            pipe.fileHandleForReading.readabilityHandler = nil
        }
    }

    private func ingest(_ text: String) {
        lock.lock()
        lineBuffer += text
        var lines: [String] = []
        while let newline = lineBuffer.firstIndex(of: "\n") {
            lines.append(String(lineBuffer[lineBuffer.startIndex..<newline]))
            lineBuffer.removeSubrange(lineBuffer.startIndex...newline)
        }
        for line in lines {
            if let reading = PowermetricsFanParser.parseFanLine(line) {
                latestByIndex[reading.index] = (reading.rpm, Date())
            }
        }
        lock.unlock()
    }

    /// Most recent RPM per fan index, limited to readings seen within
    /// `maxAge`. Empty when powermetrics has produced nothing usable.
    func latestFans(maxAge: TimeInterval = 6) -> [Int: Int] {
        lock.lock()
        defer { lock.unlock() }
        let now = Date()
        var result: [Int: Int] = [:]
        for (index, reading) in latestByIndex where now.timeIntervalSince(reading.at) <= maxAge {
            result[index] = reading.rpm
        }
        return result
    }

    func stop() {
        lock.lock()
        latestByIndex.removeAll()
        lock.unlock()
        guard let process else { return }
        self.process = nil
        if process.isRunning { process.terminate() }
    }
}

/// The root fan daemon (`--fan-daemon <appPid>`). A long-lived root copy of
/// the app binary, spawned once per app session via the osascript admin
/// pattern. Every 2 seconds it probes fan state — root SMC value reads first,
/// powermetrics as fallback — and atomically rewrites `fan-state-v1.json`
/// (0644). It executes commands from `fan-command-v1.json` via SMC writes,
/// records `lastCommandResult`, and self-terminates when the parent app pid
/// is gone or after 24h, removing the state file it owns on exit.
final class FanDaemon {
    /// RPM sanity window used to pick the `flt ` decode endianness and to
    /// reject nonsense readings.
    static let rpmSanityRange: ClosedRange<Double> = 200...10_000

    private let appPid: Int32
    private let stateURL: URL
    private let commandURL: URL
    private let interval: TimeInterval
    private let maxLifetime: TimeInterval
    private let smc: SMC?
    private var preferBigEndianFloat = false
    private var endiannessLocked = false
    private var source: FanStateFile.Source = .unavailable
    private var lastFans: [FanStateFile.Fan] = []
    private var hasEverHadData = false
    private var note: String?
    private var lastCommandResult: FanStateFile.CommandResult?

    init(
        appPid: Int32,
        stateURL: URL = FanDaemon.defaultStateURL,
        commandURL: URL = FanDaemon.defaultCommandURL,
        interval: TimeInterval = 2,
        maxLifetime: TimeInterval = 24 * 3600
    ) {
        self.appPid = appPid
        self.stateURL = stateURL
        self.commandURL = commandURL
        self.interval = interval
        self.maxLifetime = maxLifetime
        smc = try? SMC()
    }

    static var defaultStateURL: URL {
        FoldviewCLI.appSupportDirectoryURL.appendingPathComponent("fan-state-v1.json")
    }

    static var defaultCommandURL: URL {
        FoldviewCLI.appSupportDirectoryURL.appendingPathComponent("fan-command-v1.json")
    }

    /// Runs the daemon loop; never returns (terminates via `exit`).
    func run() -> Never {
        let sampler = PowermetricsSampler()
        let startDeadline = Date().addingTimeInterval(6)
        let lifetimeDeadline = Date().addingTimeInterval(maxLifetime)

        while Date() < lifetimeDeadline {
            guard FanStateFile.pidIsAlive(appPid) else { break }

            handleCommandFile()
            probeCycle(smcFallback: sampler)

            if !hasEverHadData, Date() > startDeadline, sampler.latestFans().isEmpty {
                source = .unavailable
                note = "no fan data source (SMC reads returned nothing, powermetrics silent)"
            }
            // The first cycle already rewrote any stale state file — the app
            // never shows data from a previous (dead) daemon.
            writeState()
            Thread.sleep(forTimeInterval: interval)
        }

        sampler.stop()
        try? FileManager.default.removeItem(at: stateURL)
        exit(0)
    }

    // MARK: - Probe

    private func probeCycle(smcFallback sampler: PowermetricsSampler) {
        if let smc, let readings = smcFans(smc) {
            source = .smc
            hasEverHadData = true
            lastFans = readings.map { reading in
                FanStateFile.Fan(
                    index: reading.id,
                    rpm: reading.actualRPM,
                    minRpm: reading.minRPM,
                    maxRpm: reading.maxRPM,
                    targetRpm: reading.targetRPM,
                    forced: reading.isForced
                )
            }
            note = smcTempsNote(smc)
            return
        }

        // SMC yielded nothing even as root — stream powermetrics instead.
        sampler.start()
        let pmFans = sampler.latestFans()
        if !pmFans.isEmpty {
            source = .powermetrics
            hasEverHadData = true
            lastFans = pmFans.keys.sorted().map { index in
                FanStateFile.Fan(index: index, rpm: pmFans[index].map(Double.init))
            }
            note = "fan RPM via powermetrics — min/max range unknown"
        }
    }

    /// Root SMC fan read with `flt ` endianness auto-detection: decodes
    /// little-endian first, sanity-checks RPMs against 200…10000, and retries
    /// big-endian when everything looks like nonsense. The working choice is
    /// remembered for the daemon's lifetime.
    private func smcFans(_ smc: SMC) -> [FanReading]? {
        if let readings = smc.readFansBestEffort(preferBigEndianFloat: preferBigEndianFloat),
           endiannessLocked || readingsAreSane(readings) {
            endiannessLocked = true
            return readings
        }
        guard !endiannessLocked, !preferBigEndianFloat else { return nil }
        // Little-endian decode looked insane — try big-endian once.
        if let readings = smc.readFansBestEffort(preferBigEndianFloat: true),
           readingsAreSane(readings) {
            preferBigEndianFloat = true
            endiannessLocked = true
            return readings
        }
        return nil
    }

    private func readingsAreSane(_ readings: [FanReading]) -> Bool {
        readings.contains { Self.rpmSanityRange.contains($0.actualRPM) }
    }

    /// Best-effort temperature line for the state-file note (diagnostics
    /// only; failures are ignored).
    private func smcTempsNote(_ smc: SMC) -> String? {
        var parts: [String] = []
        for key in ["TB0T", "TCMb"] {
            if let value = try? smc.readNumeric(key, preferBigEndianFloat: preferBigEndianFloat) {
                parts.append(String(format: "%@ %.1f°C", key, value))
            }
        }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }

    // MARK: - Commands

    /// Executes one pending command file, records the result, and deletes the
    /// file. Write failures never crash the daemon — they are reported back
    /// through `lastCommandResult`.
    private func handleCommandFile() {
        guard let command = FanCommand.read(from: commandURL) else { return }
        defer { try? FileManager.default.removeItem(at: commandURL) }

        guard let smc else {
            lastCommandResult = FanStateFile.CommandResult(
                seq: command.seq, ok: false, message: "the SMC is not available in the fan helper"
            )
            return
        }
        do {
            switch command.action {
            case FanCommand.setAction:
                guard let rpm = command.rpm else {
                    throw SMCError.invalidKey("set command without rpm")
                }
                let clamped = clamp(rpm: rpm, fan: command.fan)
                try smc.setFanTarget(fan: command.fan, rpm: clamped)
                lastCommandResult = FanStateFile.CommandResult(
                    seq: command.seq, ok: true, message: "fan \(command.fan) target \(clamped) rpm"
                )
            case FanCommand.autoAction:
                try smc.setFanAuto(fan: command.fan)
                lastCommandResult = FanStateFile.CommandResult(
                    seq: command.seq, ok: true, message: "fan \(command.fan) automatic"
                )
            default:
                throw SMCError.invalidKey("unknown fan command \(command.action)")
            }
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
            lastCommandResult = FanStateFile.CommandResult(seq: command.seq, ok: false, message: message)
        }
    }

    /// Clamps a requested RPM to the fan's known range (when the last SMC
    /// probe reported one).
    private func clamp(rpm: Int, fan: Int) -> Int {
        guard let state = lastFans.first(where: { $0.index == fan }),
              let minRpm = state.minRpm, let maxRpm = state.maxRpm, maxRpm > minRpm else {
            return rpm
        }
        return min(max(rpm, Int(minRpm.rounded())), Int(maxRpm.rounded()))
    }

    // MARK: - State file

    private func writeState() {
        FanStateFile(
            pid: Int(ProcessInfo.processInfo.processIdentifier),
            source: source,
            updatedAt: FanStateFile.formatISO8601(Date()),
            fans: lastFans,
            note: note,
            lastCommandResult: lastCommandResult
        ).write(to: stateURL)
    }
}
