import Foundation
import Testing
@testable import FoldviewMenuBar

/// Tests for the fan daemon's file protocols: state-file decode + freshness,
/// atomic command write/read, and the controller's command→result matching
/// against a fake daemon driving a temp-directory state file.
struct FanStateFileTests {
    private func makeTempDirectory() -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("foldview-fan-test-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    static let validStateJSON = """
    {
      "schemaVersion": 1,
      "pid": 4242,
      "source": "smc",
      "updatedAt": "2026-07-20T12:00:00Z",
      "fans": [
        {"index": 0, "rpm": 2160.5, "minRpm": 1200, "maxRpm": 6168, "targetRpm": 2400, "forced": true}
      ],
      "note": "TB0T 45.2°C",
      "lastCommandResult": {"seq": 7, "ok": true, "message": "fan 0 target 2400 rpm"}
    }
    """

    // MARK: - Decode

    @Test func decodesValidState() throws {
        let state = try JSONDecoder().decode(FanStateFile.self, from: Data(Self.validStateJSON.utf8))
        #expect(state.schemaVersion == 1)
        #expect(state.pid == 4242)
        #expect(state.decodedSource == .smc)
        #expect(state.fans.count == 1)
        let fan = state.fans[0]
        #expect(fan.index == 0)
        #expect(fan.rpm == 2160.5)
        #expect(fan.minRpm == 1200)
        #expect(fan.maxRpm == 6168)
        #expect(fan.targetRpm == 2400)
        #expect(fan.forced == true)
        #expect(state.note == "TB0T 45.2°C")
        #expect(state.lastCommandResult?.seq == 7)
        #expect(state.lastCommandResult?.ok == true)
    }

    @Test func toleratesUnknownKeysMissingOptionalsAndUnknownSource() throws {
        let json = """
        {
          "schemaVersion": 1,
          "pid": 1,
          "source": "future-source",
          "updatedAt": "2026-07-20T12:00:00Z",
          "fans": [{"index": 2, "rpm": 3000, "unknownField": true}],
          "futureTopLevel": {"x": 1}
        }
        """
        let state = try JSONDecoder().decode(FanStateFile.self, from: Data(json.utf8))
        #expect(state.decodedSource == .unavailable)
        #expect(state.note == nil)
        #expect(state.lastCommandResult == nil)
        let fan = try #require(state.fans.first)
        #expect(fan.minRpm == nil)
        #expect(fan.maxRpm == nil)
        #expect(fan.targetRpm == nil)
        #expect(fan.forced == nil)
    }

    // MARK: - Freshness

    @Test func freshnessRequiresRecentUpdateAndLivePid() {
        let now = Date()
        let fresh = FanStateFile(
            pid: 100, source: .smc,
            updatedAt: FanStateFile.formatISO8601(now.addingTimeInterval(-2)),
            fans: []
        )
        #expect(fresh.isFresh(now: now, maxAge: 5, pidAlive: { _ in true }))
        #expect(!fresh.isFresh(now: now, maxAge: 5, pidAlive: { _ in false }))

        let stale = FanStateFile(
            pid: 100, source: .smc,
            updatedAt: FanStateFile.formatISO8601(now.addingTimeInterval(-30)),
            fans: []
        )
        #expect(!stale.isFresh(now: now, maxAge: 5, pidAlive: { _ in true }))
    }

    @Test func updatedDateParsesPlainAndFractionalISO8601() {
        #expect(FanStateFile.parseISO8601("2026-07-20T12:00:00Z") != nil)
        #expect(FanStateFile.parseISO8601("2026-07-20T12:00:00.123Z") != nil)
        #expect(FanStateFile.parseISO8601("not a date") == nil)
    }

    // MARK: - Atomic IO

    @Test func stateWriteRoundTripsWith0644Permissions() throws {
        let directory = makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("fan-state-v1.json")

        let written = FanStateFile(
            pid: 9, source: .powermetrics,
            updatedAt: FanStateFile.formatISO8601(Date()),
            fans: [FanStateFile.Fan(index: 0, rpm: 2160)],
            note: "via powermetrics",
            lastCommandResult: FanStateFile.CommandResult(seq: 3, ok: false, message: "nope")
        )
        written.write(to: url)

        let read = FanStateFile.read(from: url)
        #expect(read == written)
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        #expect(attributes[.posixPermissions] as? Int == 0o644)
    }

    @Test func commandWriteReadRoundTrip() throws {
        let directory = makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("fan-command-v1.json")

        let set = FanCommand(seq: 11, action: FanCommand.setAction, fan: 0, rpm: 3200)
        try set.write(to: url)
        #expect(FanCommand.read(from: url) == set)

        let auto = FanCommand(seq: 12, action: FanCommand.autoAction, fan: 1)
        try auto.write(to: url)
        let read = FanCommand.read(from: url)
        #expect(read == auto)
        #expect(read?.rpm == nil)
    }

    // MARK: - Command → result matching (controller against a fake daemon)

    @MainActor
    @Test func controllerResolvesOnMatchingCommandResult() async throws {
        let directory = makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let controller = SMCFanController(stateDirectory: directory, resultTimeout: 5)
        let commandURL = directory.appendingPathComponent("fan-command-v1.json")
        let stateURL = directory.appendingPathComponent("fan-state-v1.json")

        async let write: Void = controller.setTarget(fan: 0, rpm: 3000)

        // Fake daemon: wait for the command file, then publish the result.
        let sawCommand = await waitForFile(commandURL)
        #expect(sawCommand)
        let command = FanCommand.read(from: commandURL)
        #expect(command?.action == FanCommand.setAction)
        #expect(command?.fan == 0)
        #expect(command?.rpm == 3000)
        let seq = try #require(command?.seq)

        FanStateFile(
            pid: 1, source: .smc,
            updatedAt: FanStateFile.formatISO8601(Date()),
            fans: [],
            lastCommandResult: FanStateFile.CommandResult(seq: seq, ok: true, message: "fan 0 target 3000 rpm")
        ).write(to: stateURL)

        try await write
    }

    @MainActor
    @Test func controllerSurfacesFailedCommandResult() async throws {
        let directory = makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let controller = SMCFanController(stateDirectory: directory, resultTimeout: 5)
        let commandURL = directory.appendingPathComponent("fan-command-v1.json")
        let stateURL = directory.appendingPathComponent("fan-state-v1.json")

        async let write: Void = controller.setAuto(fan: 1)
        #expect(await waitForFile(commandURL))
        let seq = try #require(FanCommand.read(from: commandURL)?.seq)
        #expect(FanCommand.read(from: commandURL)?.action == FanCommand.autoAction)

        FanStateFile(
            pid: 1, source: .smc,
            updatedAt: FanStateFile.formatISO8601(Date()),
            fans: [],
            lastCommandResult: FanStateFile.CommandResult(seq: seq, ok: false, message: "SMC write rejected")
        ).write(to: stateURL)

        do {
            try await write
            Issue.record("expected setAuto to throw")
        } catch let error as FanWriteError {
            guard case .helperFailed(let message) = error else {
                Issue.record("expected helperFailed, got \(error)")
                return
            }
            #expect(message == "SMC write rejected")
        }
    }

    @MainActor
    @Test func controllerTimesOutWithoutDaemon() async throws {
        let directory = makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let controller = SMCFanController(stateDirectory: directory, resultTimeout: 0.6)

        do {
            try await controller.setTarget(fan: 0, rpm: 2000)
            Issue.record("expected a timeout")
        } catch let error as FanWriteError {
            guard case .helperFailed(let message) = error else {
                Issue.record("expected helperFailed, got \(error)")
                return
            }
            #expect(message.contains("timed out"))
        }
    }

    @MainActor
    @Test func telemetryIsNilWithoutFreshStateAndMapsFreshState() async throws {
        let directory = makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let pid = ProcessInfo.processInfo.processIdentifier
        let controller = SMCFanController(stateDirectory: directory)
        let stateURL = directory.appendingPathComponent("fan-state-v1.json")

        // No file at all.
        #expect(await controller.readTelemetry() == nil)

        // Fresh file owned by this (alive) pid.
        FanStateFile(
            pid: Int(pid), source: .smc,
            updatedAt: FanStateFile.formatISO8601(Date()),
            fans: [FanStateFile.Fan(index: 0, rpm: 2160, minRpm: 1200, maxRpm: 6168, targetRpm: 2400, forced: true)],
            note: "TB0T 45.2°C"
        ).write(to: stateURL)
        let telemetry = await controller.readTelemetry()
        #expect(telemetry?.source == .smc)
        #expect(telemetry?.note == "TB0T 45.2°C")
        let fan = try #require(telemetry?.fans.first)
        #expect(fan.name == "Fan 0")
        #expect(fan.actualRPM == 2160)
        #expect(fan.minRPM == 1200)
        #expect(fan.maxRPM == 6168)
        #expect(fan.isForced == true)
        #expect(fan.targetRPM == 2400)

        // Stale timestamp → nil again.
        FanStateFile(
            pid: Int(pid), source: .smc,
            updatedAt: FanStateFile.formatISO8601(Date().addingTimeInterval(-60)),
            fans: []
        ).write(to: stateURL)
        #expect(await controller.readTelemetry() == nil)
    }

    private func waitForFile(_ url: URL, timeout: TimeInterval = 5) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if FileManager.default.fileExists(atPath: url.path) { return true }
            try? await Task.sleep(for: .milliseconds(50))
        }
        return FileManager.default.fileExists(atPath: url.path)
    }
}
