import Foundation

/// Codable models and atomic file I/O for the fan daemon's two file
/// protocols, both in `~/Library/Application Support/Foldview/`:
///
/// - `fan-state-v1.json` (daemon → app, 0644): the daemon's latest probe —
///   source, fan readings, note, and the most recent command result.
/// - `fan-command-v1.json` (app → daemon): one pending fan command, matched
///   to its result by `seq`.
///
/// Decoding is tolerant (unknown keys ignored, optionals absent) so app and
/// daemon can roll independently.
struct FanStateFile: Codable, Sendable, Equatable {
    let schemaVersion: Int
    let pid: Int
    let source: String
    let updatedAt: String
    let fans: [Fan]
    let note: String?
    let lastCommandResult: CommandResult?

    init(
        schemaVersion: Int = 1,
        pid: Int,
        source: Source,
        updatedAt: String,
        fans: [Fan],
        note: String? = nil,
        lastCommandResult: CommandResult? = nil
    ) {
        self.schemaVersion = schemaVersion
        self.pid = pid
        self.source = source.rawValue
        self.updatedAt = updatedAt
        self.fans = fans
        self.note = note
        self.lastCommandResult = lastCommandResult
    }

    /// Where the daemon got its data. Unknown strings decode as `.unavailable`
    /// so a newer daemon never crashes an older app.
    enum Source: String, Codable, Sendable, Equatable {
        case smc
        case powermetrics
        case unavailable

        init(raw: String) {
            self = Source(rawValue: raw) ?? .unavailable
        }
    }

    /// One fan in the state file. Range/target fields are optional because
    /// the powermetrics fallback only knows the current RPM.
    struct Fan: Codable, Sendable, Equatable {
        let index: Int
        let rpm: Double?
        let minRpm: Double?
        let maxRpm: Double?
        let targetRpm: Double?
        let forced: Bool?

        init(index: Int, rpm: Double? = nil, minRpm: Double? = nil, maxRpm: Double? = nil, targetRpm: Double? = nil, forced: Bool? = nil) {
            self.index = index
            self.rpm = rpm
            self.minRpm = minRpm
            self.maxRpm = maxRpm
            self.targetRpm = targetRpm
            self.forced = forced
        }
    }

    /// The daemon's record of the most recent command it executed.
    struct CommandResult: Codable, Sendable, Equatable {
        let seq: Int
        let ok: Bool
        let message: String?

        init(seq: Int, ok: Bool, message: String? = nil) {
            self.seq = seq
            self.ok = ok
            self.message = message
        }
    }

    /// The decoded source enum (tolerant: unknown raw → `.unavailable`).
    var decodedSource: Source { Source(raw: source) }

    // MARK: - Reading / freshness

    /// Reads and decodes a state file. Any failure (missing, malformed,
    /// wrong schema) returns nil — callers treat it as "no daemon data".
    static func read(from url: URL) -> FanStateFile? {
        guard let data = try? Data(contentsOf: url),
              let state = try? JSONDecoder().decode(FanStateFile.self, from: data),
              state.schemaVersion == 1 else { return nil }
        return state
    }

    /// The parsed `updatedAt` timestamp, tolerating both plain and
    /// fractional-second ISO8601.
    var updatedDate: Date? {
        Self.parseISO8601(updatedAt)
    }

    /// Fresh means: recently updated AND the daemon pid still exists.
    /// `pidAlive` is injectable so tests never signal real processes.
    func isFresh(now: Date = Date(), maxAge: TimeInterval = 5, pidAlive: (Int32) -> Bool = FanStateFile.pidIsAlive) -> Bool {
        guard let updated = updatedDate, now.timeIntervalSince(updated) < maxAge else { return false }
        return pidAlive(Int32(pid))
    }

    /// Existence check that treats EPERM as alive (the daemon runs as root,
    /// so the unprivileged app gets EPERM, not ESRCH, for a live daemon).
    @Sendable
    static func pidIsAlive(_ pid: Int32) -> Bool {
        if kill(pid, 0) == 0 { return true }
        return errno == EPERM
    }

    static func formatISO8601(_ date: Date) -> String {
        Self.isoFormatter.string(from: date)
    }

    static func parseISO8601(_ string: String) -> Date? {
        if let date = isoFormatter.date(from: string) { return date }
        return isoFormatterFractional.date(from: string)
    }

    private static let isoFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private static let isoFormatterFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    // MARK: - Atomic writing

    /// Atomic tmp-file + rename write, matching the convention used for the
    /// CLI path record and the bridge state file.
    static func writeAtomically(_ data: Data, to destination: URL, permissions: Int = 0o644) {
        let directory = destination.deletingLastPathComponent()
        let temp = directory.appendingPathComponent(".\(destination.lastPathComponent).\(UUID().uuidString).tmp")
        do {
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            guard FileManager.default.createFile(
                atPath: temp.path,
                contents: nil,
                attributes: [.posixPermissions: NSNumber(value: permissions)]
            ) else { return }
            let handle = try FileHandle(forWritingTo: temp)
            do {
                try handle.write(contentsOf: data)
                try handle.synchronize()
                try handle.close()
            } catch {
                try? handle.close()
                throw error
            }
            guard Darwin.rename(temp.path, destination.path) == 0 else {
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
        } catch {
            try? FileManager.default.removeItem(at: temp)
        }
    }

    /// Encodes and atomically writes this state file (0644 — the app reads
    /// it unprivileged).
    func write(to url: URL) {
        guard let data = try? JSONEncoder().encode(self) else { return }
        Self.writeAtomically(data, to: url, permissions: 0o644)
    }
}

/// One fan command, written by the app and executed by the daemon. `rpm` is
/// present only for `action == "set"`.
struct FanCommand: Codable, Sendable, Equatable {
    let schemaVersion: Int
    let seq: Int
    let action: String
    let fan: Int
    let rpm: Int?

    static let setAction = "set"
    static let autoAction = "auto"

    init(schemaVersion: Int = 1, seq: Int, action: String, fan: Int, rpm: Int? = nil) {
        self.schemaVersion = schemaVersion
        self.seq = seq
        self.action = action
        self.fan = fan
        self.rpm = rpm
    }

    /// Writes the command atomically (tmp + rename) so the daemon never sees
    /// a half-written file.
    func write(to url: URL) throws {
        do {
            let data = try JSONEncoder().encode(self)
            FanStateFile.writeAtomically(data, to: url, permissions: 0o644)
        } catch {
            throw FanWriteError.helperFailed("could not write the fan command file")
        }
    }

    /// Reads and decodes a pending command; nil when absent or malformed.
    static func read(from url: URL) -> FanCommand? {
        guard let data = try? Data(contentsOf: url),
              let command = try? JSONDecoder().decode(FanCommand.self, from: data),
              command.schemaVersion == 1 else { return nil }
        return command
    }
}
