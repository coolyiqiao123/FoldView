import Foundation
@testable import FoldviewMenuBar

/// Test double for `FoldviewCLIProtocol`. Lets AppStore tests drive loading,
/// error, stale-data, and coalescing scenarios deterministically without
/// spawning a real process.
actor FakeFoldviewCLI: FoldviewCLIProtocol {
    enum Behavior {
        case success(MenuBarPayload)
        case failure(Error)
    }

    private var statusResponses: [Behavior] = []
    private var statusDelays: [Duration] = []
    private(set) var statusCallCount = 0

    private(set) var performedActions: [CLIAction] = []
    var performResult: Result<Void, Error> = .success(())

    private(set) var rootsAddCalls: [String] = []
    private(set) var rootsRemoveCalls: [String] = []
    var rootsListResult: [String] = []

    private(set) var openFoldviewCalls: [String] = []
    var openFoldviewResult: Result<Void, Error> = .success(())

    func enqueueStatus(_ behavior: Behavior, delay: Duration = .zero) {
        statusResponses.append(behavior)
        statusDelays.append(delay)
    }

    func status() async throws -> MenuBarPayload {
        let index = statusCallCount
        statusCallCount += 1
        if index < statusDelays.count, statusDelays[index] > .zero {
            try? await Task.sleep(for: statusDelays[index])
        }
        guard index < statusResponses.count else {
            throw CLIError.emptyOutput
        }
        switch statusResponses[index] {
        case .success(let payload): return payload
        case .failure(let error): throw error
        }
    }

    func rootsList() async throws -> [String] { rootsListResult }

    func rootsAdd(_ path: String) async throws { rootsAddCalls.append(path) }

    func rootsRemove(_ path: String) async throws { rootsRemoveCalls.append(path) }

    func perform(_ action: CLIAction) async throws {
        performedActions.append(action)
        if case .failure(let error) = performResult { throw error }
    }

    func openFoldviewInTerminal(root: String) async throws {
        openFoldviewCalls.append(root)
        if case .failure(let error) = openFoldviewResult { throw error }
    }
}
