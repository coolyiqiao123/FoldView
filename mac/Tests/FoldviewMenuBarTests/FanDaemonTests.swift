import Foundation
import Testing
@testable import FoldviewMenuBar

/// Tests for the daemon-side pure pieces: the lenient powermetrics fan-line
/// parser and the helper-mode argument parser.
struct FanDaemonTests {
    // MARK: - Powermetrics fan-line parser

    @Test(arguments: [
        ("Fan 0: 2160 rpm", 0, 2160),
        ("fan 1: 3500 RPM", 1, 3500),
        ("Fan: 2160 rpm", 0, 2160),
        ("CPU fan 0 speed 2160 rpm", 0, 2160),
        ("  Fan 1   4200  rpm  ", 1, 4200)
    ])
    func parsesFanLines(line: String, expectedIndex: Int, expectedRPM: Int) {
        let parsed = PowermetricsFanParser.parseFanLine(line)
        #expect(parsed?.index == expectedIndex)
        #expect(parsed?.rpm == expectedRPM)
    }

    @Test(arguments: [
        "GPUdie: 12%",
        "CPU power: 4523 mW",
        "some random line",
        "rpm only 2160",
        "fan with no number rpm"
    ])
    func ignoresNonFanLines(line: String) {
        #expect(PowermetricsFanParser.parseFanLine(line) == nil)
    }

    // MARK: - Helper-mode argument parsing

    @Test func parsesDaemonInvocation() {
        #expect(FanWriteHelper.mode(for: ["/path/FoldviewMenuBar", "--fan-daemon", "1234"]) == .fanDaemon(appPID: 1234))
    }

    @Test func parsesLegacyOneShotInvocations() {
        #expect(FanWriteHelper.mode(for: ["/path/app", "--fan-write", "0", "2400"]) == .fanWrite(fan: 0, rpm: 2400))
        #expect(FanWriteHelper.mode(for: ["/path/app", "--fan-auto", "1"]) == .fanAuto(fan: 1))
    }

    @Test(arguments: [
        ["/path/app"],
        ["/path/app", "--fan-daemon"],
        ["/path/app", "--fan-daemon", "not-a-pid"],
        ["/path/app", "--fan-write", "0"],
        ["/path/app", "--fan-write", "x", "2400"],
        ["/path/app", "--fan-auto"],
        ["/path/app", "--other-flag"]
    ])
    func rejectsNormalAndMalformedInvocations(arguments: [String]) {
        #expect(FanWriteHelper.mode(for: arguments) == nil)
    }
}

/// A scripted `FanControlling` fake for FanStore mapping tests.
actor FakeFanController: FanControlling {
    var telemetry: FanTelemetry?
    var enableResult: Result<Void, Error> = .success(())
    private(set) var enableCalls = 0
    private(set) var setTargetCalls: [(fan: Int, rpm: Int)] = []
    private(set) var setAutoCalls: [Int] = []
    var writeResult: Result<Void, Error> = .success(())

    func readTelemetry() async -> FanTelemetry? { telemetry }
    func enableAccess(appPID: Int32) async throws {
        enableCalls += 1
        try enableResult.get()
    }
    func setTarget(fan: Int, rpm: Int) async throws {
        setTargetCalls.append((fan, rpm))
        try writeResult.get()
    }
    func setAuto(fan: Int) async throws {
        setAutoCalls.append(fan)
        try writeResult.get()
    }
}

/// FanStore control-state mapping tests (daemon telemetry → published state).
@MainActor
struct FanStoreStateTests {
    private func waitUntil(
        timeout: TimeInterval = 5,
        _ condition: @MainActor () async -> Bool
    ) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await condition() { return true }
            try? await Task.sleep(for: .milliseconds(20))
        }
        return await condition()
    }

    private func telemetry(
        source: FanStateFile.Source,
        note: String? = nil,
        fans: [FanReading] = []
    ) -> FanTelemetry {
        FanTelemetry(fans: fans, source: source, note: note, updatedAt: Date())
    }

    @Test func noDaemonMapsToUnavailableWithEnablePrompt() async {
        let controller = FakeFanController()
        let store = FanStore(controller: controller)
        store.refresh()
        let settled = await waitUntil { store.source == nil && !store.controlAvailable }
        #expect(settled)
        #expect(store.source == nil)
        #expect(store.fans.isEmpty)
        #expect(!store.controlAvailable)
        #expect(store.needsAccessEnablement)
        guard case .unavailable(let reason) = store.controlState else {
            Issue.record("expected unavailable, got \(store.controlState)")
            return
        }
        #expect(reason.contains("not running"))
    }

    @Test func freshSMCTelemetryMapsToAvailable() async {
        let controller = FakeFanController()
        await controller.setTelemetry(telemetry(
            source: .smc,
            fans: [FanReading(id: 0, name: "Fan 0", actualRPM: 2160, minRPM: 1200, maxRPM: 6168, isForced: false)]
        ))
        let store = FanStore(controller: controller)
        store.refresh()
        let settled = await waitUntil { store.controlAvailable }
        #expect(settled)
        #expect(store.source == .smc)
        #expect(store.fans.count == 1)
        #expect(!store.needsAccessEnablement)
    }

    @Test func unavailableSourceMapsToUnavailableWithNote() async {
        let controller = FakeFanController()
        await controller.setTelemetry(telemetry(
            source: .unavailable,
            note: "no fan data source (SMC reads returned nothing, powermetrics silent)"
        ))
        let store = FanStore(controller: controller)
        store.refresh()
        let settled = await waitUntil {
            if case .unavailable = store.controlState { return store.source == .unavailable }
            return false
        }
        #expect(settled)
        guard case .unavailable(let reason) = store.controlState else { return }
        #expect(reason.contains("no fan data source"))
    }

    @Test func writesRouteToControllerAndSurfaceFailures() async {
        let controller = FakeFanController()
        await controller.setTelemetry(telemetry(source: .smc))
        let store = FanStore(controller: controller)
        store.refresh()
        #expect(await waitUntil { store.controlAvailable })

        store.apply(fan: 0, rpm: 3000)
        #expect(await waitUntil { await controller.targetCallCount == 1 })
        let lastTarget = await controller.lastTarget
        #expect(lastTarget?.fan == 0)
        #expect(lastTarget?.rpm == 3000)

        await controller.failWrites(FanWriteError.helperFailed("SMC write rejected"))
        store.setAuto(fan: 0)
        #expect(await waitUntil { store.writeError != nil })
        #expect(store.writeError == "SMC write rejected")
        #expect(await waitUntil { await controller.autoCallCount == 1 })
    }

    @Test func enableAccessPromptsOnceAndRefreshes() async {
        let controller = FakeFanController()
        let store = FanStore(controller: controller)
        store.enableAccess()
        #expect(await waitUntil { await controller.enableCallCount == 1 })
        await controller.setTelemetry(telemetry(source: .powermetrics))
        store.refresh()
        #expect(await waitUntil { store.source == .powermetrics })
        #expect(store.controlAvailable)
    }
}

// Convenience accessors (actor-isolated state, read via async helpers so the
// tests read them without knowing the fake's internals).
extension FakeFanController {
    func setTelemetry(_ value: FanTelemetry?) { telemetry = value }
    func failWrites(_ error: Error) { writeResult = .failure(error) }
    var enableCallCount: Int { enableCalls }
    var targetCallCount: Int { setTargetCalls.count }
    var autoCallCount: Int { setAutoCalls.count }
    var lastTarget: (fan: Int, rpm: Int)? { setTargetCalls.last }
}
