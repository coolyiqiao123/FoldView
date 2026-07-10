import Foundation
import Testing
@testable import FoldviewMenuBar

@MainActor
final class AppStoreStateTests {
    private func waitUntil(
        timeout: Duration = .seconds(2),
        interval: Duration = .milliseconds(10),
        sourceLocation: SourceLocation = #_sourceLocation,
        _ condition: () -> Bool
    ) async throws {
        let deadline = ContinuousClock.now.advanced(by: timeout)
        while !condition() {
            if ContinuousClock.now >= deadline {
                Issue.record("condition not met within timeout", sourceLocation: sourceLocation)
                return
            }
            try await Task.sleep(for: interval)
        }
    }

    @Test func loadingThenLoadedWithLiveProjectSortedIntoLiveSection() async throws {
        let fake = FakeFoldviewCLI()
        await fake.enqueueStatus(.success(PayloadFixtures.validPayload))
        let store = AppStore(cli: fake, startBackgroundTimer: false)

        #expect(store.loadState == .loading)
        store.refresh()
        try await waitUntil { store.loadState == .loaded }

        #expect(store.liveProjects.map(\.name) == ["my-app"])
        #expect(store.recentProjects == [])
    }

    @Test func emptyPayloadProducesEmptyState() async throws {
        let fake = FakeFoldviewCLI()
        await fake.enqueueStatus(.success(PayloadFixtures.emptyPayload))
        let store = AppStore(cli: fake, startBackgroundTimer: false)

        store.refresh()
        try await waitUntil { store.loadState == .empty }
    }

    @Test func errorWithNoPriorPayloadProducesErrorState() async throws {
        let fake = FakeFoldviewCLI()
        await fake.enqueueStatus(.failure(CLIError.executableNotFound))
        let store = AppStore(cli: fake, startBackgroundTimer: false)

        store.refresh()
        try await waitUntil {
            if case .error = store.loadState { return true }
            return false
        }
    }

    @Test func staleDataIsRetainedWhenARefreshFailsAfterAnEarlierSuccess() async throws {
        let fake = FakeFoldviewCLI()
        await fake.enqueueStatus(.success(PayloadFixtures.validPayload))
        await fake.enqueueStatus(.failure(CLIError.nonZeroExit(code: 1, message: "boom")))
        let store = AppStore(cli: fake, startBackgroundTimer: false)

        store.refresh()
        try await waitUntil { store.loadState == .loaded }
        #expect(!store.isStale)

        store.refresh()
        try await waitUntil { store.isStale }

        // The last good payload must still be visible, with a Retry path implied
        // by loadState staying .loaded rather than flipping to .error.
        #expect(store.loadState == .loaded)
        #expect(store.liveProjects.map(\.name) == ["my-app"])
    }

    @Test func concurrentRefreshesCoalesceAndDiscardTheStaleResult() async throws {
        let fake = FakeFoldviewCLI()
        // First call is slow and would resolve *after* the second if not for
        // generation-based coalescing.
        await fake.enqueueStatus(.success(PayloadFixtures.payloadNamed("stale-project")), delay: .milliseconds(250))
        await fake.enqueueStatus(.success(PayloadFixtures.payloadNamed("fresh-project")), delay: .milliseconds(5))
        let store = AppStore(cli: fake, startBackgroundTimer: false)

        store.refresh()
        store.refresh()

        try await waitUntil(timeout: .seconds(3)) { store.loadState == .loaded }
        // Let the slow, superseded first call finish resolving too, to prove its
        // late result is discarded rather than clobbering the fresh one.
        try await Task.sleep(for: .milliseconds(400))

        let visibleNames = (store.liveProjects + store.recentProjects).map(\.name)
        #expect(visibleNames == ["fresh-project"])
        #expect(!visibleNames.contains("stale-project"))

        let callCount = await fake.statusCallCount
        #expect(callCount == 2, "both calls should have been made even though only the latest is applied")
    }

    @Test func successfulActionRecordsResultAndTriggersARefresh() async throws {
        let fake = FakeFoldviewCLI()
        await fake.enqueueStatus(.success(PayloadFixtures.validPayload))
        let store = AppStore(cli: fake, startBackgroundTimer: false)
        let row = ProjectRowModel(payload: PayloadFixtures.project(name: "my-app", live: true))

        store.openProject(row)
        try await waitUntil { store.lastActionResult != nil }

        #expect(store.lastActionResult == .success("opened my-app"))
        let actions = await fake.performedActions
        #expect(actions == [.open(project: "/tmp/my-app")])

        try await waitUntil { store.loadState == .loaded }
        let callCount = await fake.statusCallCount
        #expect(callCount == 1, "a successful action should trigger exactly one refresh")
    }

    @Test func failedActionSurfacesFailureMessageWithoutTriggeringARefresh() async throws {
        let fake = FakeFoldviewCLI()
        await fake.setPerformResult(.failure(CLIError.nonZeroExit(code: 1, message: "could not open Terminal")))
        let store = AppStore(cli: fake, startBackgroundTimer: false)
        let row = ProjectRowModel(payload: PayloadFixtures.project(name: "my-app", live: true))

        store.openProject(row)
        try await waitUntil { store.lastActionResult != nil }

        #expect(store.lastActionResult == .failure("could not open Terminal"))
        try await Task.sleep(for: .milliseconds(50))
        let callCount = await fake.statusCallCount
        #expect(callCount == 0, "a failed action must not mask itself with a refresh")
    }

    @Test func aiQuickLaunchClampsWindowCountToOneThroughNine() async throws {
        let fake = FakeFoldviewCLI()
        await fake.enqueueStatus(.success(PayloadFixtures.validPayload))
        let store = AppStore(cli: fake, startBackgroundTimer: false)
        let row = ProjectRowModel(payload: PayloadFixtures.project(name: "my-app", live: true))
        let cli = AICLIPayload(name: "claude", executable: "/usr/local/bin/claude")

        store.launchAI(project: row, cli: cli, count: 42)
        try await waitUntil { store.lastActionResult != nil }

        let actions = await fake.performedActions
        #expect(actions == [.ai(project: "/tmp/my-app", cli: "/usr/local/bin/claude", count: 9)])
        #expect(store.lastActionResult == .success("opened 9 × claude"))
    }
}

private extension FakeFoldviewCLI {
    func setPerformResult(_ result: Result<Void, Error>) {
        performResult = result
    }
}
