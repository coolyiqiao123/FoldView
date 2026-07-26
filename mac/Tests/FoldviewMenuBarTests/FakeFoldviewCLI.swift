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
    var resolvedPath: String? = "/tmp/pm"
    var configurationResult = FoldviewConfiguration(
        schemaVersion: 1,
        menubar: .init(refreshSeconds: 60, showDiscoveredApps: true),
        aiClis: []
    )
    private(set) var refreshSecondsCalls: [Int] = []
    private(set) var showDiscoveredAppsCalls: [Bool] = []
    private(set) var addCustomAICLICalls: [(name: String, executable: String)] = []
    private(set) var removeCustomAICLICalls: [String] = []

    private(set) var performedActions: [CLIAction] = []
    var performResult: Result<Void, Error> = .success(())

    private(set) var rootsAddCalls: [String] = []
    private(set) var rootsRemoveCalls: [String] = []
    var rootsListResult: Result<[String], Error> = .success([])

    private(set) var openFoldviewCalls: [String] = []
    var openFoldviewResult: Result<Void, Error> = .success(())

    private var agentsResponses: [Result<AgentsPayload, Error>] = []
    private(set) var agentsCallCount = 0
    private var burnResponses: [Result<BurnPayload, Error>] = []
    private(set) var burnCalls: [Int] = []

    func enqueueAgents(_ result: Result<AgentsPayload, Error>) {
        agentsResponses.append(result)
    }

    func agents() async throws -> AgentsPayload {
        let index = agentsCallCount
        agentsCallCount += 1
        guard index < agentsResponses.count else { throw CLIError.emptyOutput }
        return try agentsResponses[index].get()
    }

    func enqueueBurn(_ result: Result<BurnPayload, Error>) {
        burnResponses.append(result)
    }

    func burn(days: Int) async throws -> BurnPayload {
        burnCalls.append(days)
        let index = burnCalls.count - 1
        guard index < burnResponses.count else { throw CLIError.emptyOutput }
        return try burnResponses[index].get()
    }

    private var catalogResponses: [Result<AICatalogEnvelope, Error>] = []
    private var catalogDelays: [Duration] = []
    private var keyedCatalogResponses: [String: [Result<AICatalogEnvelope, Error>]] = [:]
    private var keyedCatalogDelays: [String: [Duration]] = [:]
    private var unkeyedCatalogIndex = 0
    private(set) var catalogCalls: [String?] = []
    var defaultsResult = AIProviderDefaults(
        schemaVersion: 1,
        provider: "codex",
        defaultModel: nil,
        defaultEffort: nil,
        saved: nil
    )
    private(set) var defaultsCalls: [String] = []
    private(set) var setDefaultCalls: [(provider: String, model: String, effort: String?)] = []
    var setDefaultResult: Result<Void, Error> = .success(())

    func enqueueStatus(_ behavior: Behavior, delay: Duration = .zero) {
        statusResponses.append(behavior)
        statusDelays.append(delay)
    }

    func setConfigurationResult(_ value: FoldviewConfiguration) { configurationResult = value }
    func setRootsListResult(_ value: Result<[String], Error>) { rootsListResult = value }

    func resolvedExecutablePath() async -> String? { resolvedPath }

    func configuration() async throws -> FoldviewConfiguration { configurationResult }

    func setRefreshSeconds(_ seconds: Int) async throws { refreshSecondsCalls.append(seconds) }

    func setShowDiscoveredApps(_ show: Bool) async throws { showDiscoveredAppsCalls.append(show) }

    func addCustomAICLI(name: String, executable: String) async throws {
        addCustomAICLICalls.append((name, executable))
    }

    func removeCustomAICLI(executable: String) async throws { removeCustomAICLICalls.append(executable) }

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

    func rootsList() async throws -> [String] { try rootsListResult.get() }

    func rootsAdd(_ path: String) async throws { rootsAddCalls.append(path) }

    func rootsRemove(_ path: String) async throws { rootsRemoveCalls.append(path) }

    func perform(_ action: CLIAction) async throws {
        performedActions.append(action)
        if case .failure(let error) = performResult { throw error }
    }

    func enqueueCatalog(
        _ result: Result<AICatalogEnvelope, Error>,
        provider: String? = nil,
        delay: Duration = .zero
    ) {
        if let provider {
            keyedCatalogResponses[provider, default: []].append(result)
            keyedCatalogDelays[provider, default: []].append(delay)
        } else {
            catalogResponses.append(result)
            catalogDelays.append(delay)
        }
    }

    func aiCatalog(provider: String?) async throws -> AICatalogEnvelope {
        catalogCalls.append(provider)
        if let provider, var results = keyedCatalogResponses[provider], !results.isEmpty {
            let result = results.removeFirst()
            keyedCatalogResponses[provider] = results
            var delays = keyedCatalogDelays[provider] ?? []
            let delay = delays.isEmpty ? .zero : delays.removeFirst()
            keyedCatalogDelays[provider] = delays
            if delay > .zero { try await Task.sleep(for: delay) }
            return try result.get()
        }
        let index = unkeyedCatalogIndex
        unkeyedCatalogIndex += 1
        if index < catalogDelays.count, catalogDelays[index] > .zero {
            try await Task.sleep(for: catalogDelays[index])
        }
        guard index < catalogResponses.count else { throw CLIError.emptyOutput }
        return try catalogResponses[index].get()
    }

    func aiDefaults(provider: String) async throws -> AIProviderDefaults {
        defaultsCalls.append(provider)
        return defaultsResult
    }

    func setAIDefault(provider: String, model: String, effort: String?) async throws {
        setDefaultCalls.append((provider, model, effort))
        return try setDefaultResult.get()
    }

    func openFoldviewInTerminal(root: String) async throws {
        openFoldviewCalls.append(root)
        if case .failure(let error) = openFoldviewResult { throw error }
    }
}
